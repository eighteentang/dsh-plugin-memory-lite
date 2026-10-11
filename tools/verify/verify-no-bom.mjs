// 校验：随插件发布的文本文件**不能带 UTF-8 BOM**。
//
// 为什么要有这条（一次真实事故，2026-10-12）：
//   我用 PowerShell 的 `Get-Content -Raw -Encoding UTF8` + `Set-Content -Encoding UTF8`
//   改了几处源码（E49 早就记过这个坑：PS 5.1 的 -Encoding UTF8 **会加 BOM**）。
//   结果 `package.json` 带上了 BOM → 宿主加载插件时解析失败 →
//   **整个插件没加载**（HTTP 路由全 404、设置页里「记忆控制」消失、插件卡片显示异常），
//   而离线的 Node 校验全绿 —— 因为 Node 能容忍 JS 里的 BOM，容不了 JSON 里的。
//   判据：**改源码一律用编辑工具（write / edit），不要用 Set-Content。**
//
// 用法：node verify-no-bom.mjs [插件目录]   （默认当前仓库根）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2] ?? join(process.cwd());
const EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.css', '.html', '.txt']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'backup', 'archive']);

const offenders = [];
let scanned = 0;

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name));
      continue;
    }
    const file = join(dir, entry.name);
    const dot = entry.name.lastIndexOf('.');
    if (dot < 0 || !EXT.has(entry.name.slice(dot).toLowerCase())) continue;
    scanned += 1;
    const head = readFileSync(file).subarray(0, 3);
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) offenders.push(relative(root, file));
  }
}

try {
  walk(root);
} catch (error) {
  console.error(`❌ 扫描失败：${String(error?.message ?? error)}`);
  process.exit(1);
}

console.log(`=== verify-no-bom（${root}）===`);
console.log(`扫了 ${scanned} 个文本文件`);
if (offenders.length) {
  for (const f of offenders) console.error(`❌ 带 BOM：${f}`);
  console.error(`\n❌ ${offenders.length} 个文件带 UTF-8 BOM。package.json 带 BOM 会让宿主**加载不了整个插件**。`);
  console.error('修法：用编辑工具（write/edit）重写这些文件，或用 node 脚本剥掉前 3 字节再写回。');
  process.exit(1);
}
console.log('✅ 没有 BOM');
void statSync;
