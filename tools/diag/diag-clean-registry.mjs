// 清理注册表里指向"已不存在目录"的死记录（dry-run 默认，--apply 才写）
//
// 为什么会有死记录：校验器跑 apply() 时会往真实注册表登记临时工作区库，
// 临时目录删了就留下一条死路径（已在 verify-v1 里隔离 DSH_HOME 修掉，
// 但历史记录还在）。读取侧 listAllStores() 会用 existsSync 过滤，
// 所以死记录不影响面板，只是文件里不好看。
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const APPLY = process.argv.includes('--apply');
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const FILE = join(DSH_HOME, 'memory-lite', 'workspaces.json');

if (!existsSync(FILE)) {
  console.log(`注册表不存在：${FILE}`);
  process.exit(0);
}

// 容忍 BOM（PowerShell 写的 JSON 会带 BOM，JSON.parse 遇 BOM 直接抛）
const raw = readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '');
const data = JSON.parse(raw);
const stores = Array.isArray(data.stores) ? data.stores : [];

const alive = [];
const dead = [];
for (const s of stores) {
  const dir = typeof s?.dir === 'string' ? s.dir : '';
  const okDir = dir && existsSync(dir) && existsSync(join(dir, 'memory.db'));
  (okDir ? alive : dead).push(s);
}

console.log(`注册表: ${FILE}`);
console.log(`共 ${stores.length} 条 · 有效 ${alive.length} · 死记录 ${dead.length}`);
for (const s of alive) console.log(`  ✅ ${s.dir}  (workspace=${s.workspace ?? '-'})`);
for (const s of dead) console.log(`  ❌ ${s.dir}  (workspace=${s.workspace ?? '-'}) —— 目录或 memory.db 已不存在`);

if (!dead.length) {
  console.log('\n没有需要清理的。');
  process.exit(0);
}

if (!APPLY) {
  console.log('\n演练结束（未写文件）。加 --apply 才会真的写。');
  process.exit(0);
}

copyFileSync(FILE, `${FILE}.bak`);
writeFileSync(FILE, JSON.stringify({ ...data, stores: alive }, null, 1) + '\n', 'utf8');
console.log(`\n已写入（原文件备份到 ${FILE}.bak）：删除 ${dead.length} 条死记录，保留 ${alive.length} 条。`);
