#!/usr/bin/env node
/**
 * diag-client-routes.mjs —— 宿主到底暴露了哪些插件客户端 bundle？
 *
 * 背景：客户端插件由宿主按清单声明转成 HTTP 资源，浏览器再加载。
 * "设置页里没有我那一项" 的第一嫌疑是**我的 bundle 没被宿主暴露**。
 * 这个脚本从运行中的 GUI 里把候选路径逐个探一遍，给出事实而不是猜测。
 *
 * 用法: node diag-client-routes.mjs [端口] [插件id]
 */
const PORT = Number(process.argv[2] ?? 19387);
const ID = process.argv[3] ?? 'dsh-plugin-memory-lite';
const BASE = `http://127.0.0.1:${PORT}`;

async function head(url) {
  try {
    const res = await fetch(url, { method: 'GET' });
    const text = await res.text();
    return { status: res.status, type: res.headers.get('content-type') ?? '', len: text.length, sample: text.slice(0, 160) };
  } catch (error) {
    return { status: 'ERR', err: String(error?.message ?? error) };
  }
}

console.log(`探测 ${BASE}\n`);

// 1) 主页：看有没有插件清单
const home = await head(`${BASE}/`);
console.log(`GET /  → ${home.status} (${home.len} 字节, ${home.type})`);

// 2) 从主页里抠出与客户端 bundle 有关的路径线索
const patterns = [/["'](\/[^"']*client[^"']*)["']/gi, /["'](\/plugins?\/[^"']*)["']/gi, /["']([^"']*\.js)["']/gi];
const found = new Set();
for (const p of patterns) {
  for (const m of (home.sample ?? '').matchAll(p)) found.add(m[1]);
}
console.log(`主页里抠到的路径线索：${found.size ? [...found].slice(0, 15).join('  ') : '(无)'}`);

// 3) 逐个探测候选路径
const candidates = [
  `/plugins/${ID}/client.js`,
  `/plugin/${ID}/client.js`,
  `/api/plugins/${ID}/client`,
  `/client/${ID}.js`,
  `/plugin-client/${ID}.js`,
  `/plugins/${ID}`,
  // 对照组：known-good 插件的 bundle
  `/plugins/dsh-context/client.js`,
  `/plugins/meow-memory/client.js`,
];
console.log('\n候选路径探测：');
for (const path of candidates) {
  const r = await head(`${BASE}${path}`);
  const tag = r.status === 200 && r.len > 50 ? '✅' : r.status === 404 ? '· 404' : `? ${r.status}`;
  console.log(`  ${tag.padEnd(6)} ${path.padEnd(42)} ${r.status} ${r.len} 字节 ${r.type}`);
  if (tag === '✅') console.log(`         ${String(r.sample).replace(/\s+/g, ' ').slice(0, 120)}`);
}

// 4) 我们的宿主 API 路由（验证宿主插件确实在跑）
console.log('\n宿主 API 路由探测（我们的记忆库）：');
for (const path of [`/dsh-memory-lite/api/snapshot`]) {
  const r = await head(`${BASE}${path}`);
  console.log(`  ${path}  → ${r.status} ${r.len} 字节`);
  console.log(`  ${String(r.sample).replace(/\s+/g, ' ').slice(0, 300)}`);
}
