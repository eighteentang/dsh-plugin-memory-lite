// 把 AGENTS.md 里的「零、人设与准则」那一节搬进插件自己的文件，并从 AGENTS.md 删掉它。
//
// 为什么要删：V1.6 起人设/规范由插件注入到 system prompt（紧跟框架的人设段）。
// 如果 AGENTS.md 里那一节还留着，同一份内容会在提示词里出现两遍。
//
// 顺序（不能反）：**先写插件文件，再改 AGENTS.md** —— 万一中途失败，内容只会多不会少。
// 默认 dry-run；--apply 才写。改 AGENTS.md 前会备份。
//
// 用法：
//   node move-persona-to-plugin.mjs              # 演练
//   node move-persona-to-plugin.mjs --apply
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const APPLY = process.argv.includes('--apply');
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const AGENTS = join(DSH_HOME, 'AGENTS.md');
const PDIR = join(DSH_HOME, 'memory-lite', 'persona');

if (!existsSync(AGENTS)) {
  console.error('找不到：', AGENTS);
  process.exit(1);
}
const md = readFileSync(AGENTS, 'utf8');

// ── 定位「## 零、…」这一节 ──────────────────────────────────────────────
const start = md.search(/\n##\s*零[、.]/);
if (start < 0) {
  console.log('AGENTS.md 里没有「## 零、…」这一节 —— 不用迁移。');
  process.exit(0);
}
const sep = md.indexOf('\n---\n', start);
if (sep < 0) {
  console.error('定位到「## 零、…」但找不到它后面的 --- 分隔线；为安全起见中止，请手工处理。');
  process.exit(1);
}
// 待搬走的正文（从标题行到分隔线之前，去掉尾部空行）
const blockRaw = md.slice(start + 1, sep).replace(/\s+$/, '');
// 删掉这一节 + 它的分隔线；保留前后的空行结构
let after = sep + '\n---\n'.length;
if (md[after] === '\n') after += 1;
const out = `${md.slice(0, start).replace(/\s+$/, '')}\n\n${md.slice(after)}`;

// ── 按小节拆分：人设 = 身份/性格/信任；规范 = 核心原则/长期协作 ──────────
function splitByHeadings(text) {
  const map = new Map();
  const re = /^###[ \t]+\S.*$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) marks.push({ start: m.index, heading: m[0].trim() });
  if (!marks.length) return map;
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    map.set(marks[i].heading, text.slice(marks[i].start, end).replace(/\s+$/, ''));
  }
  return map;
}
const secs = splitByHeadings(blockRaw);
const PERSONA_HEADS = ['### 身份', '### 性格', '### 信任'];
const RULES_HEADS = ['### 核心原则', '### 长期协作'];
const pick = (heads) => heads.map((h) => secs.get(h)).filter(Boolean).join('\n\n');
const personaText = pick(PERSONA_HEADS) || blockRaw; // 兜底：一个标题都没有时整段给人设
const rulesText = pick(RULES_HEADS);

console.log(`AGENTS.md: ${AGENTS}（${Buffer.byteLength(md, 'utf8')} 字节）`);
console.log(`搬走的小节：${[...secs.keys()].join(' / ') || '(没有 ### 标题，整段当人设)'}`);
console.log(`  人设设定 → ${personaText.length} 字`);
console.log(`  工作规范 → ${rulesText.length} 字`);
console.log(`  AGENTS.md 删除后 → ${Buffer.byteLength(out, 'utf8')} 字节（-${Buffer.byteLength(md, 'utf8') - Buffer.byteLength(out, 'utf8')}）`);
console.log('\n删除后文件开头：');
console.log(out.split('\n').slice(0, 8).map((l) => `  | ${l}`).join('\n'));
console.log('删除后第一个 ## 标题：', (out.match(/^## .*$/m) ?? ['(无)'])[0]);

if (!APPLY) {
  console.log('\n演练结束（什么都没写）。加 --apply 才真的执行。');
  process.exit(0);
}

// ① 先写插件文件（内容只会多不会少）
mkdirSync(PDIR, { recursive: true });
writeFileSync(join(PDIR, 'persona.md'), personaText, 'utf8');
writeFileSync(join(PDIR, 'rules.md'), rulesText, 'utf8');
console.log(`\n已写入：${PDIR}\\persona.md（${personaText.length} 字）、rules.md（${rulesText.length} 字）`);

// ② 备份后再改 AGENTS.md
const backup = `${AGENTS}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
copyFileSync(AGENTS, backup);
writeFileSync(AGENTS, out, 'utf8');
console.log(`已删除 AGENTS.md 的「零、」节；原文件备份在 ${backup}`);
void dirname;
