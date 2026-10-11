// 把"送去蒸馏的那 1500 字"按日志逐条打出来 —— 用来做配图：肉眼可见几条是一样的。
//
// 这不是演示脚本，跑的是真库（默认取最新那份清理前备份，因为清理后数据已经变了）。
// 用法：node diag-show-distill-heads.mjs [库路径]
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_DIR = 'D:\\EasyDSH\\.dsh-memory';
const BACKUP_DIR = join(DEFAULT_DIR, 'backup');

function latestBackup() {
  if (!existsSync(BACKUP_DIR)) return null;
  const files = readdirSync(BACKUP_DIR).filter((f) => f.startsWith('memory.db.')).sort();
  return files.length ? join(BACKUP_DIR, files[files.length - 1]) : null;
}

// 参数：位置参数是库路径（可选），--out <文件> 写一份同样的文本（给配图脚本读）
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
const positional = args.filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
const dbPath = positional[0] ?? latestBackup() ?? join(DEFAULT_DIR, 'memory.db');
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare('SELECT id, turn, text FROM log_entries ORDER BY id ASC').all();
const CAP = 1500; // = DISTILL_MAX_CHARS_PER_LOG
const SHOW = 44; // 只够图片宽度；不追求打印全文

const text = [];
text.push(`库: ${dbPath}`);
text.push(`日志 ${rows.length} 条 · 单条蒸馏上限 ${CAP} 字 · 下面每行 = 模型实际读到的开头`);
text.push('');

const heads = new Map();
const lines = [];
for (const r of rows) {
  const head = String(r.text ?? '').slice(0, CAP);
  const shown = head.slice(0, SHOW).replace(/\s+/g, ' ');
  heads.set(head, (heads.get(head) ?? 0) + 1);
  lines.push({ id: r.id, turn: r.turn, shown });
}

const dupGroups = [...heads.values()].filter((n) => n > 1);
const dupCount = dupGroups.reduce((a, n) => a + n, 0);

for (const l of lines) {
  text.push(`  #${String(l.id).padEnd(3)} turn=${String(l.turn).padEnd(3)} ${l.shown}`);
}
text.push('');
text.push(`${dupCount} / ${rows.length} 条送去模型的内容逐字相同`);
text.push(`（重复的组数：${dupGroups.length}）`);

const body = text.join('\n');
console.log(body);
if (outFile) {
  writeFileSync(outFile, body + '\n', 'utf8');
  console.log(`\n[已写入 ${outFile}]`);
}
db.close();
