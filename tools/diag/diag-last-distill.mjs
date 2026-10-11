// 看最近一次蒸馏到底提出了哪些条目（验收蒸馏质量用）
import { DatabaseSync } from 'node:sqlite';

const DB = process.argv[2] ?? 'D:\\EasyDSH\\.dsh-memory\\memory.db';
const db = new DatabaseSync(DB, { readOnly: true });

console.log(`库: ${DB}\n`);

console.log('=== 最近 5 次蒸馏 ===');
for (const r of db.prepare('SELECT id,outcome,logs_in,created,updated,note,started_at FROM distill_runs ORDER BY id DESC LIMIT 5').all()) {
  console.log(`run ${r.id} | ${r.outcome} | logs_in=${r.logs_in} created=${r.created} updated=${r.updated}`);
  console.log(`   ${String(r.note ?? '').slice(0, 140)}`);
}

const last = db.prepare("SELECT MAX(id) AS id FROM distill_runs WHERE outcome = 'ok'").get()?.id;
console.log(`\n=== 最近一次成功蒸馏（run ${last}）提出的条目 ===`);
for (const e of db.prepare("SELECT id, level, importance, project, keywords, content, source_ref FROM entries WHERE source_ref = ? ORDER BY created_at").all(`distill:${last}`)) {
  console.log(`--- [${e.level}] importance=${e.importance} project=${e.project}`);
  console.log(`    keywords: ${e.keywords}`);
  console.log(`    content : ${String(e.content).slice(0, 220)}`);
}

console.log('\n=== 各层分布（active）===');
console.log(JSON.stringify(db.prepare("SELECT level, COUNT(*) AS n FROM entries WHERE status = 'active' GROUP BY level").all()));

console.log('\n=== 注入流水（最近 5 条）===');
for (const r of db.prepare('SELECT * FROM injections ORDER BY id DESC LIMIT 5').all()) {
  console.log(`${new Date(r.created_at).toISOString()} form=${r.form} chars=${r.chars} ids=${JSON.parse(r.entry_ids).length} 条`);
}

db.close();
