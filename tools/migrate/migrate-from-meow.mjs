#!/usr/bin/env node
/**
 * migrate-from-meow.mjs —— 把 meow-memory 的记忆迁进 memory-lite
 *
 * 为什么需要迁移而不是并存：两个记忆插件同时活跃会**双份注入**（同一事实被说两遍、
 * 关键词各命中一次），这比"存两套"严重 —— 存储重复只占空间，双份注入实际降低回答质量。
 *
 * 做法：
 *   ① 只读打开 meow 的库（不写、不改）
 *   ② 逐层读条目 → 映射到我们的 entries 表（level/project/subcategory/keywords/importance/status 全保留）
 *   ③ 迁移前先 dry-run 打印计划；`--apply` 才真写
 *   ④ 迁移后回读比对条数与要点，输出核对结果
 *
 * 用法：
 *   node migrate-from-meow.mjs                 # dry-run（默认，不写任何东西）
 *   node migrate-from-meow.mjs --apply         # 真写进 memory-lite
 *   node migrate-from-meow.mjs --apply --target <目录>
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { openMemory } from '../../lib/storage.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const targetArg = args.indexOf('--target');
const MEOW_DB = process.env.MEOW_DB ?? 'D:\\EasyDSH\\.dsh-meow\\memory.db';
const TARGET_DIR = targetArg >= 0 ? resolve(args[targetArg + 1]) : join('D:\\EasyDSH', '.dsh-memory');

const LEVELS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules'];

console.log(`meow 源库 : ${MEOW_DB}`);
console.log(`目标目录  : ${TARGET_DIR}`);
console.log(`模式      : ${APPLY ? '★ APPLY（会写入）' : 'dry-run（不写入）'}`);
console.log('');

if (!existsSync(MEOW_DB)) {
  console.error(`源库不存在：${MEOW_DB}\n（如果 meow 的记忆库在别的工作区，用 --meow 或设 MEOW_DB 环境变量指过去）`);
  process.exit(2);
}

/** 只读打开 meow 的库 */
const src = new DatabaseSync(MEOW_DB, { readOnly: true });
const tables = src.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);

const planned = [];
for (const level of LEVELS) {
  if (!tables.includes(level)) continue;
  let rows = [];
  try {
    rows = src.prepare(`SELECT * FROM "${level}"`).all();
  } catch (error) {
    console.warn(`  读取 ${level} 失败：${error.message}`);
    continue;
  }
  for (const row of rows) {
    let keywords = [];
    try {
      keywords = JSON.parse(row.keywords ?? '[]');
    } catch {
      keywords = [];
    }
    planned.push({
      level,
      content: String(row.content ?? '').trim(),
      title: row.title ?? '',
      keywords: Array.isArray(keywords) ? keywords : [],
      importance: Number(row.importance ?? 1),
      // meow 的 status 语义与我们一致（active/stale/archived），直接沿用
      status: ['active', 'stale', 'archived'].includes(row.status) ? row.status : 'active',
      project: row.project ?? (level === 'project' ? null : '全局'),
      subcategory: row.subcategory ?? null,
      goal: row.goal ?? null,
      corrected: Boolean(row.corrected),
      sourceId: row.id,
      sourceSession: row.source_session ?? null,
      createdAt: row.created_at ?? null,
    });
  }
}

const byLevel = planned.reduce((acc, e) => ((acc[e.level] = (acc[e.level] ?? 0) + 1), acc), {});
console.log(`读到 ${planned.length} 条：${Object.entries(byLevel).map(([k, v]) => `${k}=${v}`).join(' · ') || '(空)'}`);
for (const e of planned.slice(0, 12)) {
  console.log(`  [${e.level}] ${String(e.content).replace(/\s+/g, ' ').slice(0, 64)}…`);
}
if (planned.length > 12) console.log(`  …另外 ${planned.length - 12} 条`);

if (!planned.length) {
  console.log('\n没有可迁移的条目。');
  src.close();
  process.exit(0);
}

if (!APPLY) {
  console.log('\n（dry-run，未写入。确认无误后加 --apply 重跑）');
  src.close();
  process.exit(0);
}

// ── 真写 ──────────────────────────────────────────────────────────────────
mkdirSync(TARGET_DIR, { recursive: true, mode: 0o700 });
const dst = openMemory({ dir: TARGET_DIR, workspace: 'D:\\EasyDSH', archiveDir: join(TARGET_DIR, 'archive') });

let created = 0;
let skipped = 0;
for (const item of planned) {
  try {
    // 用源 id 做幂等键：重复跑迁移不会重复插入
    const existing = dst.get(`meow-${item.sourceId}`);
    if (existing) {
      skipped += 1;
      continue;
    }
    dst.put({
      id: `meow-${item.sourceId}`,
      level: item.level,
      title: item.title,
      content: item.content,
      keywords: item.keywords,
      importance: item.importance,
      status: item.status,
      project: item.project,
      subcategory: item.subcategory,
      goal: item.goal,
      corrected: item.corrected,
      sourceSession: item.sourceSession,
      sourceRef: 'migrated-from-meow',
    });
    created += 1;
  } catch (error) {
    console.warn(`  写入失败（${item.level} ${item.sourceId}）：${error.message}`);
  }
}

// ── 回读比对（E16：不能只测两端，要覆盖面）────────────────────────────────
const all = dst.list({ status: null, limit: 2000 });
const migrated = all.filter((e) => String(e.id).startsWith('meow-'));
const byLevelAfter = migrated.reduce((acc, e) => ((acc[e.level] = (acc[e.level] ?? 0) + 1), acc), {});
console.log(`\n迁移结果：新建 ${created} 条，跳过（已存在）${skipped} 条`);
console.log(`回读核对：目标库共 ${all.length} 条，其中来自 meow 的 ${migrated.length} 条`);
console.log(`         分层：${Object.entries(byLevelAfter).map(([k, v]) => `${k}=${v}`).join(' · ')}`);

const expect = planned.length;
const sameCount = migrated.length === expect;
console.log(sameCount ? `✅ 条数一致（${expect}）` : `❌ 条数不一致：期望 ${expect}，实际 ${migrated.length}`);

// 抽一条逐字段比对
const sampleSrc = planned.find((p) => p.level === 'lesson') ?? planned[0];
const sampleDst = migrated.find((e) => e.id === `meow-${sampleSrc.sourceId}`);
if (sampleDst) {
  const checks = [
    ['level', sampleSrc.level, sampleDst.level],
    ['content', sampleSrc.content, sampleDst.content],
    ['status', sampleSrc.status, sampleDst.status],
    ['project', sampleSrc.project ?? null, sampleDst.project ?? null],
    ['keywords', JSON.stringify(sampleSrc.keywords), JSON.stringify(sampleDst.keywords)],
  ];
  const bad = checks.filter(([, a, b]) => a !== b);
  console.log(bad.length ? `❌ 抽样字段不一致：${bad.map(([k]) => k).join(',')}` : `✅ 抽样字段逐项一致（${checks.map(([k]) => k).join(',')}）`);
} else {
  console.log('⚠ 抽样条目没找到，无法逐字段比对');
}

dst.close();
src.close();
console.log(`\n目标库：${join(TARGET_DIR, 'memory.db')}`);
console.log('下一步：在插件页把 meow-memory 停用（不要卸载，保留可回滚）。');
