// 召回质量体检（V3-3）：把 recall_runs 里记下的每一条 query **重放**一遍，
// 回答两个以前回答不了的问题：
//   ① 召回到底命中多少轮？（零命中率 = "换个说法就搜不到"的直接证据）
//   ② 改了检索之后，结果和历史相比变了多少？（回归检测）
//
// ⚠ 必须在**库副本**上跑：search() 会写 hit_count / last_accessed_at，
//   直接在真库上重放会把面板的"用过 N 次"灌水。
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openMemory } from '../../lib/storage.js';

const SRC = process.argv[2] ?? 'D:\\EasyDSH\\.dsh-memory\\memory.db';
const LIMIT = Number(process.argv[3] ?? 200);
const TMP = join(tmpdir(), 'memory-lite-recall-replay');

if (!existsSync(SRC)) {
  console.error(`找不到库：${SRC}`);
  process.exit(1);
}
const srcDir = SRC.replace(/[\\/]memory\.db$/, '');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  const from = join(srcDir, `memory.db${suffix}`);
  if (existsSync(from)) copyFileSync(from, join(TMP, `memory.db${suffix}`));
}

const memory = openMemory({ dir: TMP, workspace: null });
const runs = memory.recentRecallRuns(LIMIT).slice().reverse(); // 按时间正序

console.log(`库副本: ${TMP}`);
console.log(`召回尝试: ${runs.length} 轮\n`);
if (!runs.length) {
  console.log('还没有数据 —— 这张表是 V3 新加的，从这一版起才会开始记。');
  memory.close();
  process.exit(0);
}

const fmt = (ts) => new Date(ts).toISOString().slice(0, 19).replace('T', ' ');

let zeroRecorded = 0, zeroNow = 0, changed = 0, wouldInjectNow = 0;
const zeroSamples = [];
const driftSamples = [];

for (const r of runs) {
  const got = memory.search(r.query, { status: 'active', limit: 12 });
  const usable = got.filter((e) => !e.sensitive);
  if (r.hits === 0) zeroRecorded += 1;
  if (usable.length === 0) {
    zeroNow += 1;
    if (zeroSamples.length < 10) zeroSamples.push(`${fmt(r.createdAt)} turn=${r.turn} ${String(r.query).replace(/\s+/g, ' ').slice(0, 60)}`);
  }
  if (usable.length > 0) wouldInjectNow += 1;
  if (usable.length !== r.hits) {
    changed += 1;
    if (driftSamples.length < 6) driftSamples.push(`turn=${r.turn} 记录 hits=${r.hits} → 现在 ${usable.length}`);
  }
}

const pct = (a, b) => `${((a / b) * 100).toFixed(1)}%`;
console.log(`零命中（当时记录）: ${zeroRecorded}/${runs.length} = ${pct(zeroRecorded, runs.length)}`);
console.log(`零命中（现在重放）: ${zeroNow}/${runs.length} = ${pct(zeroNow, runs.length)}`);
console.log(`会注入 ≥1 条（忽略"已注入过"的去重）: ${wouldInjectNow}/${runs.length} = ${pct(wouldInjectNow, runs.length)}`);
console.log(`与历史记录不一致的轮次: ${changed}（不一致不一定是坏事 —— 条目被改状态/删掉也会造成差异）`);

const lens = runs.map((r) => r.queryChars ?? 0).sort((a, b) => a - b);
console.log(`query 长度: 中位 ${lens[Math.floor(lens.length / 2)]} 字 · 最长 ${lens[lens.length - 1]} 字`);

if (zeroSamples.length) {
  console.log('\n零命中样例（这些说法搜不到任何记忆）:');
  for (const s of zeroSamples) console.log(`  · ${s}`);
}
if (driftSamples.length) {
  console.log('\n与历史不一致的样例:');
  for (const s of driftSamples) console.log(`  · ${s}`);
}

const stats = memory.stats();
console.log(`\n库内 active 条目: ${Object.entries(stats.activeByLevel ?? {}).map(([k, v]) => `${k}=${v}`).join(' ')}`);

memory.close();
