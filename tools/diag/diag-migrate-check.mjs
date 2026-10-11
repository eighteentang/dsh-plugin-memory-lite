// 用新代码打开真实老库，验证 ALTER TABLE 迁移真的会执行（不是"应该会"）
import { DatabaseSync } from 'node:sqlite';
import { openMemory } from '../../lib/storage.js';

const DIR = 'D:\\EasyDSH\\.dsh-memory';
console.log('迁移前列:', new DatabaseSync(`${DIR}\\memory.db`, { readOnly: true }).prepare('PRAGMA table_info(distill_runs)').all().map((c) => c.name).join(','));

// 用插件的 openMemory 打开（会执行轻量迁移）
const memory = openMemory({ dir: DIR, archiveDir: `${DIR}\\archive` });
console.log('打开成功，条目数 =', memory.list({ status: null, limit: 9999 }).length);
memory.close();

const after = new DatabaseSync(`${DIR}\\memory.db`, { readOnly: true });
console.log('迁移后列:', after.prepare('PRAGMA table_info(distill_runs)').all().map((c) => c.name).join(','));
console.log('旧记录还在吗:', after.prepare('SELECT COUNT(*) n FROM distill_runs').get().n, '条');
after.close();
