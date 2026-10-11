// 为什么插件在宿主里起不来？—— 用最接近真机的假 ctx 走一遍 import + apply，把错误原样打印。
// 只读，不写任何数据（临时库落在 %TEMP%）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'ml-load-probe-'));
process.env.DSH_HOME = join(root, 'dsh-home'); // 隔离，别碰真库

console.log('=== ① 模块能不能 import ===');
let mod;
try {
  mod = await import('file:///D:/DSH-dev/memory-lite/index.js');
  console.log('✅ import 成功；导出：', Object.keys(mod).join(', '));
  console.log('   name =', mod.name, '| inject =', JSON.stringify(mod.inject));
} catch (error) {
  console.error('❌ import 失败：');
  console.error(error);
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
}

console.log('\n=== ② apply 能不能跑完 ===');
const registered = { tools: [], sections: [], events: [], routes: [], disposers: 0 };
const logs = [];
const ctx = {
  logger: { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]), error: (...a) => logs.push(['error', ...a]) },
  tools: {
    register(tool) {
      registered.tools.push(tool.name);
      return () => { registered.disposers += 1; };
    },
  },
  systemPrompt: {
    getSectionOrder: (key) => ({ HARNESS_IDENTITY: -1000, DEPLOYMENT_PERSONA_PREFIX: 0, TOOLS_SDK: 5000 }[key] ?? 4000),
    section(def) {
      registered.sections.push(`${def.name}@${def.order}`);
      return () => { registered.disposers += 1; };
    },
  },
  on(event) {
    registered.events.push(event);
    return () => { registered.disposers += 1; };
  },
  get: () => undefined,
  inject(names, cb) {
    const services = {
      webServer: {
        register(def) {
          registered.routes.push(def.path);
          return () => { registered.disposers += 1; };
        },
      },
    };
    return cb ? cb({ get: (n) => (names.includes(n) ? services[n] : undefined) }) : undefined;
  },
};

try {
  mod.apply(ctx, { dirName: '.dsh-memory' });
  console.log('✅ apply 跑完了（没抛错）');
} catch (error) {
  console.error('❌ apply 抛错：');
  console.error(error);
}
console.log('   注册的工具:', registered.tools.join(', ') || '(无)');
console.log('   注册的段落:', registered.sections.join(', ') || '(无)');
console.log('   注册的事件:', registered.events.join(', ') || '(无)');
console.log('   注册的路由:', registered.routes.join(', ') || '(无)');
console.log('   释放函数:', registered.disposers);

console.log('\n=== ③ 插件自己 trace 出来的东西 ===');
for (const line of logs) console.log('  ', JSON.stringify(line));

rmSync(root, { recursive: true, force: true });
