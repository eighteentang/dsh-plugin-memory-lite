// 快速核对：日志层的 role 取值、injections 的 entry_ids 形状
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('D:\\EasyDSH\\.dsh-memory\\memory.db', { readOnly: true });

console.log('=== log_entries 的 role 分布 ===');
for (const r of db.prepare('SELECT role, COUNT(*) AS n, MIN(chars) AS minc, MAX(chars) AS maxc FROM log_entries GROUP BY role').all()) {
  console.log(`  role=${JSON.stringify(r.role)} n=${r.n} chars ${r.minc}~${r.maxc}`);
}
console.log('=== log_entries 前 3 行 ===');
for (const r of db.prepare('SELECT id, session_id, turn, role, chars, created_at, distilled, substr(text,1,50) AS head FROM log_entries ORDER BY id ASC LIMIT 3').all()) {
  console.log(`  #${r.id} turn=${r.turn} role=${JSON.stringify(r.role)} chars=${r.chars} distilled=${r.distilled} ${String(r.head).replace(/\s+/g, ' ')}`);
}
console.log('=== entries 的 title 形状 ===');
for (const r of db.prepare("SELECT typeof(title) AS t, COUNT(*) AS n FROM entries GROUP BY t").all()) {
  console.log(`  typeof(title)=${r.t} → ${r.n} 条`);
}
for (const r of db.prepare("SELECT SUM(CASE WHEN substr(content,1,48)=title THEN 1 ELSE 0 END) AS same FROM entries").all()) {
  console.log(`  与正文前 48 字相同的 title 数量: ${r.same}`);
}
console.log('=== 每条日志：蒸馏只取前 1500 字，被切掉的是什么 ===');
for (const r of db.prepare('SELECT id, turn, chars, text FROM log_entries ORDER BY id ASC').all()) {
  const t = String(r.text ?? '').replace(/\s+/g, ' ');
  const cut = Math.round((1500 / t.length) * 1000) / 10;
  console.log(`  #${r.id} turn=${r.turn} ${r.chars}字 —— 蒸馏能看到 ${cut}%`);
  console.log(`     第 1500 字处截断: …${t.slice(1420, 1520)}`);
  console.log(`     被切掉的结尾: …${t.slice(-160)}`);
}
console.log('=== injections 原始行 ===');
for (const r of db.prepare('SELECT id, form, chars, entry_ids FROM injections ORDER BY id ASC').all()) {
  console.log(`  #${r.id} ${r.form} ${r.chars}字 entry_ids=${JSON.stringify(r.entry_ids).slice(0, 120)}`);
}
db.close();
