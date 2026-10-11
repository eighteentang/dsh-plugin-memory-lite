#!/usr/bin/env node
/**
 * verify-client.mjs —— 客户端 bundle 的离线自测
 *
 * 为什么需要它：我没有浏览器控制权，看不到"设置页有没有那一项"。
 * 但"注册代码是否写对、是否抛错"是**可以离线验的** —— 用一个假的
 * `window.__ModuleLoader__` + 假 React，把 client.js 真跑一遍：
 *
 *   ① 模块是否成功注册到 __ModuleLoader__（客户端插件不是 ESM，必须走这个入口）
 *   ② `require('react')` 是否被调用（真机由宿主注入 require）
 *   ③ apply(ctx) 是否注册了 settings.section，参数（id/order/label）是否合法
 *   ④ 组件是否能被"渲染"而不抛错（用假 createElement 递归调用）
 *
 * ⚠ 它验不到的：样式对不对、槽位条目是否真的出现在设置页（那需要浏览器）。
 *
 * 用法: node verify-client.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..', '..', 'client', 'client.js');

const results = [];
const ok = (n, d = '') => results.push({ pass: true, n, d });
const bad = (n, d = '') => results.push({ pass: false, n, d });

console.log(`=== verify-client @ ${CLIENT} ===\n`);

const source = readFileSync(CLIENT, 'utf8');

// 静态检查：不能 import 任何 DSH 客户端 UI 包（全局指令明令禁止）
const forbidden = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
const uiImports = forbidden.filter((p) => p.startsWith('@deepseek-ai/'));
uiImports.length === 0
  ? ok('没有 require 任何 @deepseek-ai/* 客户端包（避免槽位崩溃）', forbidden.join(',') || '(无 require)')
  : bad('没有 require 任何 @deepseek-ai/* 客户端包', uiImports.join(','));

/__ModuleLoader__\.load\(/.test(source) ? ok('用 __ModuleLoader__.load 注册（客户端非 ESM）') : bad('用 __ModuleLoader__.load 注册');

// ── 造一个假运行环境 ─────────────────────────────────────────────────────
const calls = { require: [], inject: [], register: [], elements: [] };

const ReactStub = {
  createElement(type, props, ...children) {
    calls.elements.push(typeof type === 'string' ? type : (type?.name || 'Component'));
    return { __el: true, type, props, children };
  },
  Component: class {
    constructor(p) {
      this.props = p ?? {};
      this.state = {};
    }
  },
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial;
    return [value, () => {}];
  },
  useEffect() {},
  useCallback(fn) {
    return fn;
  },
  useMemo(fn) {
    return fn();
  },
  useRef(v) {
    return { current: v };
  },
};

const registeredSlots = [];

/**
 * 假客户端 ctx —— 关键：**模拟「未 inject 就取属性会抛」的代理行为**。
 *
 * 为什么必须模拟：真实客户端 ctx 是按声明才给服务的代理，未声明取属性会抛
 *   `cannot get property "slots" without inject`
 * （真机报错原文，2026-10-11）。我第一版的假 ctx 把服务直接挂在对象上，
 * 于是这类错误**在离线校验里永远不会出现** —— 校验器全绿，用户那边直接没显示。
 * 教训：假环境比真环境宽松时，校验器验的是"我以为的契约"，而不是真契约。
 */
function makeFakeClientCtx(services) {
  const declared = new Set();
  const makeScope = () => {
    const scope = {};
    for (const name of Object.keys(services)) {
      Object.defineProperty(scope, name, {
        enumerable: true,
        get() {
          if (!declared.has(name)) throw new Error(`cannot get property "${name}" without inject`);
          return services[name];
        },
      });
    }
    scope.inject = (names, cb) => {
      for (const n of names) declared.add(n);
      return cb(scope);
    };
    return scope;
  };
  return makeScope();
}

const fakeCtx = makeFakeClientCtx({
  slots: {
    inject(name, cb) {
      calls.inject.push(name);
      return cb();
    },
    register(def, component) {
      calls.register.push({ def, component });
      registeredSlots.push(def);
      return () => {};
    },
  },
});

let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, factory };
    },
  },
};
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, entries: [], stats: {}, dbPath: '/tmp/x.db' }) });
globalThis.console = console;

// ── 执行 client.js ───────────────────────────────────────────────────────
try {
  // 客户端 bundle 是浏览器脚本，不在模块作用域里 —— 用函数包一层执行
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', 'console', source)(globalThis.window, undefined, console);
  ok('client.js 可执行（顶层无语法/引用错误）');
} catch (error) {
  bad('client.js 可执行', String(error?.message ?? error));
}

loaded ? ok('已调用 __ModuleLoader__.load', `id=${loaded.id}`) : bad('已调用 __ModuleLoader__.load');
if (loaded) {
  loaded.id === 'dsh-plugin-memory-lite' ? ok('注册 id 与包名一致') : bad('注册 id 与包名一致', loaded.id);
  typeof loaded.factory === 'function' ? ok('factory 是函数') : bad('factory 是函数');

  // 假 require：记录请求并返回 React
  const fakeRequire = (name) => {
    calls.require.push(name);
    if (name === 'react') return ReactStub;
    throw new Error(`未预期的 require: ${name}`);
  };

  let mod = null;
  try {
    mod = loaded.factory(fakeRequire);
    ok('factory(require) 返回模块对象');
  } catch (error) {
    bad('factory(require) 返回模块对象', String(error?.message ?? error));
  }

  calls.require.includes('react') ? ok('只 require 了 react', calls.require.join(',')) : bad('只 require 了 react', calls.require.join(',') || '(无)');

  if (mod) {
    typeof mod.apply === 'function' ? ok('模块导出 apply') : bad('模块导出 apply');
    try {
      mod.apply(fakeCtx);
      ok('apply(ctx) 未抛错');
    } catch (error) {
      bad('apply(ctx) 未抛错', String(error?.message ?? error));
    }
    calls.inject.includes('settings.section')
      ? ok('注入到 settings.section 槽位')
      : bad('注入到 settings.section 槽位', calls.inject.join(',') || '(未调用 inject)');
    const def = registeredSlots[0];
    if (def) {
      def.name === 'settings.section' ? ok('注册 name=settings.section') : bad('注册 name=settings.section', def.name);
      typeof def.id === 'string' && def.id ? ok('注册 id 非空', def.id) : bad('注册 id 非空');
      Number.isFinite(def.order) ? ok('注册 order 是数字', String(def.order)) : bad('注册 order 是数字', String(def.order));
      typeof def.label === 'function' ? ok('label 是函数（槽位契约要求）') : bad('label 是函数', typeof def.label);
      try {
        const text = def.label();
        typeof text === 'string' && text ? ok('label() 返回非空文本', text) : bad('label() 返回非空文本', String(text));
      } catch (error) {
        bad('label() 可调用', String(error?.message ?? error));
      }
    } else {
      bad('注册了槽位条目');
    }

    // ④ 试渲染组件（用假 createElement，递归跑一遍函数组件）
    const component = calls.register[0]?.component;
    if (typeof component === 'function') {
      try {
        calls.elements.length = 0;
        const tree = component({});

        /**
         * 递归展开组件树。
         * ⚠ 关键：**class 组件必须用 new 实例化**，不能当函数调 ——
         * 直接调用会抛 "Class constructor X cannot be invoked without 'new'"。
         * 我第一版就是这么写的，于是"渲染路径"从未真正被验到（假绿），
         * 而真实 React 里 createElement(ClassComp) 是合法的。
         */
        const walk = (node, depth) => {
          if (!node || depth > 6) return;
          if (Array.isArray(node)) {
            node.forEach((n) => walk(n, depth + 1));
            return;
          }
          const type = node.type;
          if (typeof type === 'function') {
            if (type.prototype && typeof type.prototype.render === 'function') {
              // class 组件
              const instance = new type(node.props ?? {});
              const state = typeof type.getDerivedStateFromError === 'function' ? instance.state : instance.state;
              instance.state = state ?? {};
              walk(instance.render(), depth + 1);
            } else {
              // 函数组件
              walk(type(node.props ?? {}), depth + 1);
            }
          }
        };
        walk(tree, 0);
        ok('组件首次渲染未抛错', `产出 ${calls.elements.length} 个元素节点（含 class 组件的 new 实例化）`);

        // 再单独验一次"错误边界本身能兜底"：故意扔一个会抛错的子组件进去
        const BoundaryClass = tree?.type;
        if (BoundaryClass && BoundaryClass.prototype && typeof BoundaryClass.getDerivedStateFromError === 'function') {
          const instance = new BoundaryClass({ children: null });
          const fallback = BoundaryClass.getDerivedStateFromError(new Error('测试用的假错误'));
          instance.state = { ...instance.state, ...fallback };
          const rendered = instance.render();
          JSON.stringify(rendered ?? '').includes('记忆控制加载失败')
            ? ok('错误边界能兜底（抛错时显示文案而不是整块空白）')
            : bad('错误边界能兜底', JSON.stringify(rendered)?.slice(0, 120));
        }
      } catch (error) {
        bad('组件首次渲染未抛错', String(error?.message ?? error));
      }
    } else {
      bad('注册的组件可调用', typeof component);
    }
  }
}

console.log('');
let pass = 0;
for (const r of results) {
  console.log(`${r.pass ? '✅' : '❌'} ${r.n}${r.d ? `  —— ${r.d}` : ''}`);
  if (r.pass) pass++;
}
console.log(`\n通过 ${pass}/${results.length}`);
console.log('\n⚠ 离线验不到的：');
console.log('   · 设置页里是否真的出现「记忆控制」这一项（需要浏览器）');
console.log('   · 样式与主题是否一致');
console.log('   · 同源 fetch 宿主路由是否真的通（需要运行中的宿主）');
process.exit(results.every((r) => r.pass) ? 0 : 1);
