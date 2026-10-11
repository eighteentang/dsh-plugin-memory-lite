// 蒸馏输入体检：清洗前后对比，并回答"送去模型的那 1500 字有多少条是重复的"
// 只读真库（不调 search()，所以不会写 hit_count）
import { DatabaseSync } from 'node:sqlite';
import { pickLogExcerpt, cleanLogText, DISTILL_MAX_CHARS_PER_LOG } from '../../lib/distill.js';

const db = new DatabaseSync(process.argv[2] ?? 'D:\\EasyDSH\\.dsh-memory\\memory.db', { readOnly: true });
const logs = db.prepare('SELECT id, turn, chars, text, distilled FROM log_entries ORDER BY id ASC').all();

console.log(`日志 ${logs.length} 条 · 单条蒸馏上限 ${DISTILL_MAX_CHARS_PER_LOG} 字\n`);

const rows = [];
for (const l of logs) {
  const clean = cleanLogText(l.text);
  const piece = pickLogExcerpt(l.text);
  rows.push({
    id: l.id,
    turn: l.turn,
    raw: l.chars,
    clean: clean.length,
    keep: piece.length,
    head1500: String(l.text).slice(0, DISTILL_MAX_CHARS_PER_LOG),
    cleanHead: piece.slice(0, 200).replace(/\s+/g, ' '),
  });
}

// "相同的头" = 旧行为的病根：多条日志送去模型的内容逐字相同
const group = new Map();
for (const r of rows) group.set(r.head1500, (group.get(r.head1500) ?? 0) + 1);
const dupHeads = [...group.values()].filter((n) => n > 1).reduce((a, n) => a + n, 0);
const cleanGroup = new Map();
for (const r of rows) cleanGroup.set(r.cleanHead, (cleanGroup.get(r.cleanHead) ?? 0) + 1);
const dupClean = [...cleanGroup.values()].filter((n) => n > 1).reduce((a, n) => a + n, 0);

console.log('id  turn    原长     清洗后   送入模型   清洗后占比');
for (const r of rows) {
  const pctv = `${((r.clean / r.raw) * 100).toFixed(1)}%`;
  console.log(
    `#${String(r.id).padEnd(3)} ${String(r.turn).padEnd(6)} ${String(r.raw).padStart(7)} ${String(r.clean).padStart(8)} ${String(r.keep).padStart(9)}   ${pctv.padStart(8)}`,
  );
}

console.log(`\n旧行为（直接 slice 前 1500 字）：${dupHeads}/${rows.length} 条送去的内容在组内重复`);
console.log(`新行为（剔样板后取头尾）：    ${dupClean}/${rows.length} 条送去的内容在组内重复（按前 200 字判定）`);
console.log(`总字符：${rows.reduce((a, r) => a + r.raw, 0)} → 清洗后 ${rows.reduce((a, r) => a + r.clean, 0)}（降到 ${((rows.reduce((a, r) => a + r.clean, 0) / rows.reduce((a, r) => a + r.raw, 0)) * 100).toFixed(1)}%）`);

console.log('\n每组重复的头长什么样（举例）:');
const shown = new Set();
for (const r of rows) {
  const n = group.get(r.head1500);
  if (n > 1 && !shown.has(r.head1500)) {
    shown.add(r.head1500);
    console.log(`  ×${n} 条完全相同 → ${r.head1500.replace(/\s+/g, ' ').slice(0, 110)}…`);
  }
}

console.log('\n是否为"累积式"落库（后一条是否把前一条整段包含进去）:');
for (let i = 1; i < logs.length; i++) {
  const prev = String(logs[i - 1].text ?? '');
  const cur = String(logs[i].text ?? '');
  const probe = prev.slice(0, Math.min(2000, prev.length));
  const contains = probe && cur.includes(probe);
  const delta = cur.length - prev.length;
  console.log(`  #${logs[i - 1].id} → #${logs[i].id}: 前一条被完整包含=${contains ? '是' : '否'} · 长度差 ${delta >= 0 ? '+' : ''}${delta}`);
}

console.log('\n清洗后每条的头部（前 200 字，看是不是"这一轮真正的内容"）:');
for (const r of rows) console.log(`  #${r.id} turn=${r.turn}: ${r.cleanHead}`);

db.close();
