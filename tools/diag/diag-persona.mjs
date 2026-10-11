// 看「人设 / 工作规范」到底存了什么、以及**注入到提示词里的样子**
// 用法：node diag-persona.mjs [目录]   默认 $DSH_HOME/memory-lite/persona
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readPersona, renderPersonaSection, SLOT_FILE } from '../../lib/persona.js';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const dir = process.argv[2] ?? join(DSH_HOME, 'memory-lite', 'persona');

console.log(`目录: ${dir}`);
console.log(`存在: ${existsSync(dir)}\n`);

for (const [slot, file] of Object.entries(SLOT_FILE)) {
  const f = join(dir, file);
  if (!existsSync(f)) {
    console.log(`· ${slot} → ${file}（还没有这个文件）`);
    continue;
  }
  const text = readFileSync(f, 'utf8');
  console.log(`· ${slot} → ${file}  ${text.length} 字 / ${statSync(f).size} 字节`);
  console.log(`  首行: ${JSON.stringify(text.split('\n')[0].slice(0, 60))}`);
  console.log(`  含 markdown 标题: ${/^#{1,6} /m.test(text)}`);
}

const data = readPersona(dir);
const section = renderPersonaSection(data);
console.log(`\n===== 注入 system prompt 的段落（${section.length} 字）=====`);
console.log(section || '（两份都空 → 不注入）');

const backupsDir = join(dir, 'backup');
if (existsSync(backupsDir)) {
  const list = readdirSync(backupsDir);
  console.log(`\n备份 ${list.length} 份，最近 3 份：`);
  for (const f of list.slice(-3)) console.log(`  ${f}`);
}
