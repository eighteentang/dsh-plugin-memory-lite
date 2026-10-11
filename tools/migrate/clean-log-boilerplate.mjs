// 存量日志清洗：把已经写进库的日志按**现在的规则**重算一遍
//   · 剔系统样板（cleanLogText）
//   · 去掉与前文重复的前缀（diffAgainstPrevious，逐会话累积比对）
//
// 为什么要清洗存量：`lib/capture.js` 的清洗与去重是 2026-10-11 才加的，
// 在那之前写进去的行里 90% 是宿主注入的样板；更早的实测里 10 条日志占 804 KB，
// 相邻两条有 6/9 对是"后一条完整包含前一条"。
//
// 用法：
//   node clean-log-boilerplate.mjs                       # 演练（默认，不写）
//   node clean-log-boilerplate.mjs --apply               # 真的写（先 VACUUM INTO 备份）
//   node clean-log-boilerplate.mjs --db D:\x\memory.db --apply
//
// ⚠ 这是**破坏性**操作（会重写 log_entries.text）。所以 --apply 时必须先成功备份，
//   备份失败就中止 —— 不静默地"先改后备份"。
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cleanLogText, diffAgainstPrevious } from '../../lib/text.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const dbArgIdx = argv.indexOf('--db');
const DB = dbArgIdx >= 0 ? argv[dbArgIdx + 1] : 'D:\\EasyDSH\\.dsh-memory\\memory.db';

if (!existsSync(DB)) {
  console.error(`找不到库：${DB}`);
  process.exit(1);
}

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout=5000');

const rows = db.prepare('SELECT id, session_id, turn, text, chars FROM log_entries ORDER BY session_id, id ASC').all();

/** 逐会话重算。
 *
 * ⚠ 顺序是"**先在原文上比对，再清洗**"，不能反过来 —— 存量清洗时踩到过：
 *   先各自清洗再比对时，跨越边界的框架块会让两边不一致，包含关系就不成立了
 *   （实测原文上"整条被包含"在 6/9 对里成立，清洗后再比对则 0 对成立）。
 *   比对用的 prev 取**上一行的原文**（不是重算后的），因为包含关系是在原文上测出来的。
 */
const plan = [];
const perSession = new Map();
const prevRaw = new Map();

for (const row of rows) {
  const sid = row.session_id;
  const prev = prevRaw.get(sid) ?? '';
  prevRaw.set(sid, row.text);

  const step = diffAgainstPrevious(row.text, prev); // 原文上比对
  const next = cleanLogText(step.text); // 再清洗

  const s = perSession.get(sid) ?? { rows: 0, before: 0, after: 0, changed: 0, deduped: 0, stripped: 0 };
  s.rows += 1;
  s.before += row.chars ?? 0;
  s.after += next.length;
  if (next !== row.text) {
    s.changed += 1;
    plan.push({ id: row.id, text: next, before: row.chars ?? 0, after: next.length });
  }
  if (step.reason === 'contains-prev' || step.reason === 'identical') s.deduped += 1;
  if (next.length < (row.chars ?? 0)) s.stripped += 1;
  perSession.set(sid, s);
}

console.log(`库: ${DB}`);
console.log(`日志 ${rows.length} 行 / ${perSession.size} 个会话\n`);
console.log('会话                                              行数   原字符     清洗后     会改');
for (const [sid, s] of perSession) {
  console.log(`${String(sid).padEnd(48)} ${String(s.rows).padStart(4)} ${String(s.before).padStart(9)} ${String(s.after).padStart(10)} ${String(s.changed).padStart(6)}`);
}
const totalBefore = [...perSession.values()].reduce((a, s) => a + s.before, 0);
const totalAfter = [...perSession.values()].reduce((a, s) => a + s.after, 0);
const totalDedup = [...perSession.values()].reduce((a, s) => a + s.deduped, 0);
console.log(`\n合计：${totalBefore} → ${totalAfter} 字（保留 ${((totalAfter / (totalBefore || 1)) * 100).toFixed(1)}%）`);
console.log(`其中被判为"与前文重复"的行：${totalDedup}`);
console.log(`需要更新的行：${plan.length}`);

if (!plan.length) {
  console.log('\n没有需要更新的行。');
  db.close();
  process.exit(0);
}

if (!APPLY) {
  console.log('\n演练结束（未写任何东西）。加 --apply 才会真的写。');
  console.log('示例（前 3 行会变成什么）:');
  for (const p of plan.slice(0, 3)) {
    console.log(`  #${p.id}: ${p.before} 字 → ${p.after} 字`);
  }
  db.close();
  process.exit(0);
}

// ── 备份：用 VACUUM INTO 生成一份一致的副本（含 WAL 里未落盘的部分）────────
const backupDir = join(dirname(DB), 'backup');
try {
  mkdirSync(backupDir, { recursive: true });
} catch {
  /* 已存在 */
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = join(backupDir, `memory.db.pre-log-clean-${stamp}`);
try {
  db.exec(`VACUUM INTO '${backup.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  console.log(`\n备份完成：${backup}`);
} catch (e) {
  console.error(`\n备份失败，已中止（一个字都没改）：${String(e?.message ?? e)}`);
  db.close();
  process.exit(1);
}

const upd = db.prepare('UPDATE log_entries SET text = ?, chars = ? WHERE id = ?');
let done = 0;
for (const p of plan) {
  upd.run(p.text, p.after, p.id);
  done += 1;
}
console.log(`已更新 ${done} 行。`);
const size = db.prepare('SELECT SUM(chars) AS c FROM log_entries').get();
console.log(`库内日志字符总量现在：${size?.c ?? 0}`);

// UPDATE 只会在页内腾出空洞，文件大小不会自己变小 —— 再 VACUUM 一次把空洞回收。
// 客户端开着的时候可能拿不到独占锁（会超时失败），失败就如实说，不算清洗失败。
const sizeOf = (p) => {
  try {
    return `${(statSync(p).size / 1024).toFixed(1)} KB`;
  } catch {
    return '?';
  }
};
const beforeVacuum = sizeOf(DB);
try {
  db.exec('VACUUM');
  console.log(`VACUUM 完成：${beforeVacuum} → ${sizeOf(DB)}`);
} catch (e) {
  console.log(`VACUUM 没成功（${String(e?.message ?? e)}）—— 内容已经改好了，体积回收可以等客户端关掉再跑一次。`);
}
db.close();
