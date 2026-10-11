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

// ── 两端契约：客户端 `api('…')` 调的每个路径，服务端都必须注册了 ──────────
// 为什么单独一条：路径字符串在两端各写一份，改了服务端忘了客户端（或反过来）
// 就是"所有端点 404 而校验全绿"——这类事故在本项目已经发生过。
{
  const server = readFileSync(join(HERE, '..', '..', 'index.js'), 'utf8');
  const called = [...new Set([...source.matchAll(/\bapi\(\s*'([^']+)'/g)].map((m) => m[1]))];
  const registered = [...new Set([...server.matchAll(/API_PREFIX\}(\/[a-z][a-z-]*)/g)].map((m) => m[1]))];
  const missing = called.filter((p) => !registered.includes(p));
  missing.length === 0
    ? ok('两端契约：客户端调的每个路径都有对应路由', `客户端 ${called.join(', ')} · 服务端 ${registered.join(', ')}`)
    : bad('两端契约：有客户端调用却没有路由', missing.join(', '));
  called.includes('/persona')
    ? ok('客户端已接上 /persona（人设 / 工作规范两个文本框）', called.join(', '))
    : bad('客户端已接上 /persona', called.join(', '));
  // V1.5 起面板不再提供"新增/编辑单条记忆"（改成两个大文本框管设定）。
  // 断言"不再调用"是为了防"前端已删、后端还留着入口"这种误会 —— 路由本身保留且有断言。
  !called.includes('/save')
    ? ok('客户端不再调用 /save（面板写入已移除；路由保留但前端不暴露）')
    : bad('客户端仍在调用 /save', called.join(', '));
}

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

    // ── 列表布局不变量（2026-10-12 加）───────────────────────────────────
    // 起因：用户报「设置页的 list 有点难看，有些标签占了 2 行」。
    // 根因是 flex 行里长文本挤别人换行（45 条里 40 条没标题 → 回落正文前 24 字，长度不可控），
    // 而标签自己没有 nowrap。**这类回归只能靠断言挡住** —— 样式本身只能人眼看，
    // 但"会不会换行"是由几个具体属性决定的，那几个属性机器能验。
    {
      const T = mod.__test;
      if (!T || typeof T.renderRow !== 'function') {
        bad('列表行渲染可离线断言', '__test.renderRow 不存在');
      } else {
        ok('列表行渲染可离线断言', `__test 暴露了 renderRow/LIST_COLS/ROW_HEIGHT/css`);

        // 用**极端数据**渲染：没有标题（回落长文本）+ 超长项目名 + 敏感 + 各种计数
        const longContent = '很长的正文回落文本'.repeat(12);
        const cases = [
          ['无标题+超长项目', { id: 'a', level: 'lesson', project: 'meow-memory-and-more', title: '', content: longContent, status: 'active', sensitive: 0, injectCount: 0 }],
          ['有标题+无项目', { id: 'b', level: 'project', project: null, title: '短标题', content: 'x', status: 'stale', sensitive: 1, injectCount: 7 }],
          ['计数为 0', { id: 'c', level: 'fact', project: '全局', title: '', content: 'y', status: 'archived', sensitive: 0, injectCount: 0 }],
        ];
        // ⚠ 假 React 的 createElement 把 children 存成 **rest 数组** ——
        //   `h('div', p, [6 个格子])` → children = [[6 个格子]]。
        //   第一版我直接读 children[2]，取到的是那个数组本身 → 五条断言全假红。
        const cellsOf = (row) => (row?.children ?? []).flat(Infinity).filter((c) => c && c.__el);
        const rows = cases.map(([name, e], i) => [name, T.renderRow(e, i, { onStatus: () => {}, disabled: false })]);
        const styles = rows.map(([, r]) => r?.props?.style ?? {});

        styles.every((s) => s.display === 'grid') ? ok('每行都是 grid（列宽由整表统一决定，行不会互相挤）') : bad('每行都是 grid', JSON.stringify(styles.map((s) => s.display)));
        styles.every((s) => s.gridTemplateColumns === T.LIST_COLS) ? ok('每行用同一个列模板', T.LIST_COLS) : bad('每行用同一个列模板', JSON.stringify(styles.map((s) => s.gridTemplateColumns)));
        styles.every((s) => s.height === T.ROW_HEIGHT && Number.isFinite(s.height)) ? ok('每行高度固定（不许被内容撑高）', `height=${T.ROW_HEIGHT}`) : bad('每行高度固定', JSON.stringify(styles.map((s) => s.height)));
        styles.every((s) => s.boxSizing === 'border-box') ? ok('行是 border-box（padding+border 不撑高）') : bad('行是 border-box');
        styles.every((s) => s.overflow === 'hidden' || s.overflowX === 'hidden') ? ok('行裁剪溢出（越界内容不会换行）') : bad('行裁剪溢出');

        // 每一行的格子数必须一致 —— 少一个格子，后面所有列都会错位
        const cellCounts = rows.map(([, r]) => cellsOf(r).length);
        new Set(cellCounts).size === 1 ? ok('每行格子数一致（列不会错位）', `${cellCounts[0]} 格`) : bad('每行格子数一致', JSON.stringify(cellCounts));
        rows.every(([, r]) => cellsOf(r).every((c) => c.__el === true)) ? ok('没有 null 格子（用空 span 占位而不是省略）') : bad('有 null 格子（会错位）');

        // 标题列：省略号要生效必须同时满足 minWidth:0 + overflow:hidden
        const titleCell = cellsOf(rows[0][1])[2];
        const ts = titleCell?.props?.style ?? {};
        ts.minWidth === 0 && ts.overflow === 'hidden' && ts.textOverflow === 'ellipsis' && ts.whiteSpace === 'nowrap'
          ? ok('标题列：minWidth:0 + 省略号 + 不换行（长标题不会撑破行）')
          : bad('标题列省略号四件套', JSON.stringify(ts));

        // 无标题时回落到正文，且**必须仍然只占一个格子**（不能多插一行文字）
        const fallbackText = String(titleCell?.children ?? '');
        fallbackText.length <= 26 && !fallbackText.includes('\n')
          ? ok('无标题时回落到正文前 24 字以内且不含换行', `${fallbackText.length} 字`)
          : bad('无标题回落', `len=${fallbackText.length}`);

        // 标签：必须 nowrap（否则药丸里的文字自己断成两行 —— 用户看到的正是这个）
        T.css?.tag?.whiteSpace === 'nowrap'
          ? ok('标签样式含 whiteSpace:nowrap（药丸不会自我断行）')
          : bad('标签样式 whiteSpace', String(T.css?.tag?.whiteSpace));
        T.css?.tag?.flex === '0 0 auto'
          ? ok('标签不参与伸缩（宽度不会被标题挤扁）')
          : bad('标签 flex', String(T.css?.tag?.flex));

        // 项目列的省略号：超长项目名必须截断而不是换行
        const projStyle = cellsOf(rows[0][1])[1]?.props?.style ?? {};
        projStyle.maxWidth && projStyle.overflow === 'hidden' && projStyle.textOverflow === 'ellipsis'
          ? ok('项目列：超长项目名截断（不换行）', `maxWidth=${projStyle.maxWidth}`)
          : bad('项目列截断', JSON.stringify(projStyle));

        // 敏感列：没有敏感内容时也要渲染成一个空格子（占位，保持列对齐）
        cellsOf(rows[0][1])[3]?.__el === true && cellsOf(rows[2][1])[3]?.__el === true
          ? ok('敏感列始终占位（没有敏感内容也渲染空 span）')
          : bad('敏感列占位');

        // 状态下拉：三态齐全
        const opts = (cellsOf(rows[0][1])[5]?.children ?? []).flat(Infinity).map((o) => o?.props?.value);
        JSON.stringify(opts) === JSON.stringify(['active', 'stale', 'archived'])
          ? ok('状态下拉三态齐全', opts.join('/'))
          : bad('状态下拉三态', JSON.stringify(opts));
      }
    }


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
