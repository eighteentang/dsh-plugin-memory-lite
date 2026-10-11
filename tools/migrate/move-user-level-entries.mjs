// 把工作区库里的「用户级」条目搬进用户级库（$DSH_HOME/memory-lite/global）。
//
// 为什么需要脚本：V1.7 之前没有用户级库，这类条目只能写进某个工作区；
// 有了用户级库之后要把它们挪过去，否则"换个项目还需要的事实"依然只在原项目里召回。
//
// 做法（顺序不能反）：**先复制进用户级库 → 再把工作区里那条标为 archived**。
// 反了的话，中途失败就是"两边都没有"。归档而不是删除：面板上还看得到、可随时恢复。
//
// ⚠ 用插件自己的 openMemory() 而不是手写 SQL：`entries_fts` 是 FTS5 的
//   **外部内容表**（没有 id 列，靠 rowid 关联 entries），手写 INSERT 会报
//   `table entries_fts has no column named id`；而且绕过 API 就会漏掉它内部的
//   FTS 同步与字段规范化。**能调 API 就不要手写 SQL。**
//
// 用法：
//   node move-user-level-entries.mjs            # 演练（只读）
//   node move-user-level-entries.mjs --apply
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { openMemory } from '../../lib/storage.js';

const APPLY = process.argv.includes('--apply');
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const WORKSPACE_DB = process.argv.find((a) => a.endsWith('.db')) ?? 'D:\\EasyDSH\\.dsh-memory\\memory.db';
const GLOBAL_DIR = join(DSH_HOME, 'memory-lite', 'global');

// 要搬的条目（按 id 明确列出 —— 不靠"最近写的"这种会变的条件）
const IDS = [
  '0mv42l6nb-1dnwiceq5lx711fts1g31h1zi8', // 用户画像
  '0mv42l6nh-1on25jxl7puwx10807bemjxf28', // 兴趣与长期项目
  '0mv42lbut-1ew90xm1k3zfm8149yzgcppcgl', // Issue 工作流 · 标签体系
  '0mv42lbuz-nrrk3k48agqh1x9bf4t13mi3o9', // Issue 工作流 · 流程与裁决通道
  '0mv42lflh-riklgm1240o1vj6plwumqrlbz', // MEMORY.md 已分流
];

if (!existsSync(WORKSPACE_DB)) {
  console.error('找不到工作区库：', WORKSPACE_DB);
  process.exit(1);
}

const wsDir = dirname(WORKSPACE_DB);
const src = openMemory({ dir: wsDir, workspace: fsWorkspace(wsDir), archiveDir: join(wsDir, 'archive') });
const gst = openMemory({ dir: GLOBAL_DIR, workspace: null, archiveDir: join(GLOBAL_DIR, 'archive') });

function fsWorkspace(dir) {
  // 库内 meta 记着 workspace；读不到就用目录推断（只影响 display 字段）
  try {
    return src?.getMeta?.('workspace') ?? dir.replace(/[\\/]\.dsh-memory$/i, '');
  } catch {
    return dir;
  }
}

const rows = [];
for (const id of IDS) {
  const r = src.get(id);
  if (!r) {
    console.error(`❌ 找不到 id=${id} —— 中止（宁可不搬，也不要搬一半）`);
    process.exit(1);
  }
  rows.push(r);
}
console.log(`准备搬 ${rows.length} 条：`);
for (const r of rows) console.log(`  [${r.level}/${r.status}] ${r.title ?? '(无标题)'}  ${String(r.content).length} 字`);

const existing = new Set(gst.list({ status: null, limit: 2000 }).map((e) => String(e.content)));
const dup = rows.filter((r) => existing.has(String(r.content)));
console.log(`\n用户级库里已有 ${existing.size} 条；其中与待搬内容重复的：${dup.length} 条`);

if (!APPLY) {
  console.log('\n演练结束（什么都没写）。加 --apply 才真的执行。');
  src.close();
  gst.close();
  process.exit(0);
}

// ── ① 复制进用户级库（先保证内容不会丢）─────────────────────────────────
let copied = 0;
for (const r of rows) {
  if (existing.has(String(r.content))) continue;
  gst.put({
    id: `${r.id}-u`, // 保留可追溯：后缀 -u 表示"用户级那份"
    level: r.level,
    title: r.title ?? '',
    content: r.content,
    keywords: r.keywords ?? [],
    importance: r.importance ?? 1,
    status: 'active',
    project: r.project ?? null,
    subcategory: r.subcategory ?? null,
    goal: r.goal ?? null,
    corrected: r.corrected,
  });
  copied += 1;
}
console.log(`\n① 已复制 ${copied} 条进用户级库：${GLOBAL_DIR}`);

// ── ② 工作区里那几条标为 archived（不删，可恢复）───────────────────────
let archived = 0;
for (const r of rows) {
  src.update(r.id, { status: 'archived' });
  archived += 1;
}
console.log(`② 已把工作区库里那 ${archived} 条标为 archived`);

const after = gst.list({ status: null, limit: 2000 });
console.log(`\n用户级库现有 ${after.length} 条（active ${after.filter((e) => e.status === 'active').length}）`);
console.log(`工作区库：active ${src.list({ status: 'active', limit: 2000 }).length} 条`);
src.close();
gst.close();
