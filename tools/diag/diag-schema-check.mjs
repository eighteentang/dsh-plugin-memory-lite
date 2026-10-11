// 核对真实库的 entries 表列与全部表（确认 V2 迁移在真机上生效）
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('D:\\EasyDSH\\.dsh-memory\\memory.db', { readOnly: true });
console.log('表:', db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name).join(', '));
console.log('entries 列:', db.prepare('PRAGMA table_info(entries)').all().map((c) => c.name).join(', '));
const hasInject = db.prepare('PRAGMA table_info(entries)').all().some((c) => c.name === 'inject_count');
console.log(hasInject ? '✅ inject_count 已存在' : '❌ inject_count 缺失（需要插件启动时迁移）');
const n = db.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
const inj = db.prepare('SELECT COUNT(*) AS n FROM injections').get().n;
console.log(`条目 ${n} 条；注入流水 ${inj} 条`);
db.close();
