// 查注入流水：每一轮召回了哪些条目、形态是 recall 还是 recovery
// 用途：验证「压缩后补回」（compaction recovery）是否在真机触发过
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const candidates = [
  process.argv[2],
  'D:\\EasyDSH\\.dsh-memory\\memory.db',
  join(process.env.DSH_HOME ?? 'C:\\Users\\10454\\.dsh', 'memory-lite', 'global', 'memory.db'),
].filter(Boolean);

const fmt = (ts) => new Date(ts).toISOString().slice(0, 19).replace('T', ' ');

for (const db of candidates) {
  console.log(`\n===== ${db} =====`);
  if (!existsSync(db)) {
    console.log('  (不存在)');
    continue;
  }
  const conn = new DatabaseSync(db, { readOnly: true });
  const cols = conn.prepare('PRAGMA table_info(injections)').all().map((c) => c.name);
  console.log(`  injections 列: ${cols.join(', ')}`);

  const total = conn.prepare('SELECT COUNT(*) AS n FROM injections').get().n;
  const byForm = conn.prepare('SELECT form, COUNT(*) AS n, MAX(created_at) AS last FROM injections GROUP BY form').all();
  console.log(`  注入总轮次: ${total}`);
  for (const f of byForm) console.log(`    form=${f.form}: ${f.n} 轮，最近 ${fmt(f.last)}`);

  const rows = conn.prepare('SELECT * FROM injections ORDER BY id DESC LIMIT 8').all();
  console.log('  最近 8 轮:');
  for (const r of rows) {
    let ids = [];
    try {
      ids = JSON.parse(r.entry_ids ?? '[]');
    } catch {
      ids = String(r.entry_ids ?? '').split(',');
    }
    console.log(`    #${r.id} ${fmt(r.created_at)} form=${r.form} chars=${r.chars} 条目=${ids.length} session=${r.session_id}`);
    if (ids.length) {
      const q = ids.map(() => '?').join(',');
      const titles = conn.prepare(`SELECT id, level, title FROM entries WHERE id IN (${q})`).all(...ids);
      for (const t of titles) console.log(`        · [${t.level}] ${t.title}`);
    }
  }

  const seen = conn.prepare('SELECT id, title, inject_count, last_injected_at FROM entries WHERE inject_count > 0 ORDER BY last_injected_at DESC LIMIT 10').all();
  console.log('  被注入过的条目（Top 10）:');
  for (const s of seen) console.log(`    · ${s.inject_count} 次 · ${fmt(s.last_injected_at)} · ${s.title}`);
  conn.close();
}
