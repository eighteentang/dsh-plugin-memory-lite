// 查 memory-lite 自己的库（不是 meow 的）：日志层有没有在写、条目有多少
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const candidates = [
  'D:\\EasyDSH\\.dsh-memory\\memory.db',
  join(process.env.DSH_HOME ?? 'C:\\Users\\10454\\.dsh', 'memory-lite', 'global', 'memory.db'),
];

for (const db of candidates) {
  console.log(`\n===== ${db} =====`);
  if (!existsSync(db)) {
    console.log('  (不存在)');
    continue;
  }
  const conn = new DatabaseSync(db, { readOnly: true });
  const meta = conn.prepare('SELECT key, value FROM meta').all();
  console.log('  meta:', meta.map((m) => `${m.key}=${m.value}`).join(' · '));
  const n = conn.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
  const active = conn.prepare("SELECT COUNT(*) AS n FROM entries WHERE status='active'").get().n;
  console.log(`  条目: ${n} 条（active ${active}）`);
  const logs = conn.prepare('SELECT session_id, COUNT(*) AS n, MAX(created_at) AS last FROM log_entries GROUP BY session_id').all();
  console.log(`  日志层: ${logs.length} 个会话`);
  for (const l of logs) {
    console.log(`    ${l.session_id}: ${l.n} 条，最后写入 ${new Date(l.last).toISOString().slice(0, 19).replace('T', ' ')}`);
  }
  const sample = conn.prepare('SELECT turn, role, chars, substr(text,1,80) AS head, created_at FROM log_entries ORDER BY id DESC LIMIT 3').all();
  for (const s of sample) {
    console.log(`    · turn=${s.turn} role=${s.role} ${s.chars} 字: ${String(s.head).replace(/\s+/g, ' ')}`);
  }
  const runs = conn.prepare('SELECT * FROM distill_runs ORDER BY id DESC LIMIT 3').all();
  console.log(`  蒸馏记录: ${runs.length} 次`, runs.map((r) => r.outcome).join(','));
  conn.close();
}
