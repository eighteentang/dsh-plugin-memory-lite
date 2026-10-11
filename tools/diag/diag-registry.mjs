// 离线验证「注册表 → 发现工作区库」这条链路
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openMemory } from '../../lib/storage.js';

const DSH_HOME = process.env.DSH_HOME ?? 'C:\\Users\\10454\\.dsh';
const regFile = join(DSH_HOME, 'memory-lite', 'workspaces.json');

console.log(`注册表: ${regFile}`);
console.log(`存在: ${existsSync(regFile)}`);

let reg = { stores: [] };
try {
  reg = JSON.parse(readFileSync(regFile, 'utf8'));
} catch (error) {
  console.log(`读取失败: ${error.message}`);
}

for (const entry of reg.stores ?? []) {
  const db = join(entry.dir, 'memory.db');
  const ok = existsSync(db);
  let count = null;
  let workspaceInDb = null;
  if (ok) {
    try {
      const memory = openMemory({ dir: entry.dir, archiveDir: join(entry.dir, 'archive') });
      count = memory.list({ status: null, limit: 10000 }).length;
      workspaceInDb = memory.getMeta('workspace');
      memory.close();
    } catch (error) {
      count = `读取失败: ${error.message}`;
    }
  }
  console.log(`\ndir       = ${entry.dir}`);
  console.log(`  workspace(注册表) = ${entry.workspace}`);
  console.log(`  workspace(库内)   = ${workspaceInDb}`);
  console.log(`  memory.db 存在    = ${ok}`);
  console.log(`  条目数            = ${count}`);
}
