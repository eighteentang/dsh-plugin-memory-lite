/**
 * storage.js —— 记忆库（SQLite）
 *
 * 为什么用 node:sqlite：Node 22.5+ 内置，**零原生编译**，十家里五家用它，
 * 本机 Node v24.21.0 已实测可用（探针验证过）。
 *
 * 表设计（一处关键取舍）：
 *   顶层用**统一的 entries 表** + `level` 列，而不是七张平行表。
 *   理由：① FTS5 索引只能建在一个"内容表"上，统一表让全文检索只写一套；
 *        ② 跨层检索（"搜所有层"）变成一条 SQL；
 *        ③ 层级特有的字段（lesson.corrected / project.subcategory+goal）保留成可空列，
 *           代价是几列空值，收益是少写六套查询代码。
 *
 * 安全默认：库文件 0600、WAL 模式、写入走事务。
 *
 * ⚠ 本文件曾被 PowerShell 的 Get-Content/Set-Content 改坏过（中文变乱码 + 换行被吞）。
 *   教训写进 AGENTS.md：**永远不要用 PowerShell 改 UTF-8 源码**，用 write/edit 工具。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, appendFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { LEVELS, STATUSES, PROJECT_SUBCATEGORIES, SENSITIVE_TITLE_PATTERN, LOG_MAX_PER_SESSION } from './config.js';

export const SCHEMA_VERSION = 1;

const DDL = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS entries (
     id TEXT PRIMARY KEY,
     level TEXT NOT NULL,
     title TEXT,
     content TEXT NOT NULL,
     keywords TEXT NOT NULL DEFAULT '[]',
     importance INTEGER NOT NULL DEFAULT 1,
     status TEXT NOT NULL DEFAULT 'active',
     project TEXT,
     subcategory TEXT,
     goal TEXT,
     corrected INTEGER NOT NULL DEFAULT 0,
     sensitive INTEGER NOT NULL DEFAULT 0,
     source_session TEXT,
     source_ref TEXT,
     hit_count INTEGER NOT NULL DEFAULT 0,
     inject_count INTEGER NOT NULL DEFAULT 0,
     last_injected_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     last_accessed_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_entries_level ON entries(level, status)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_updated ON entries(updated_at)`,
  // FTS 用普通虚表（不是 external-content），换取写入/重建的简单
  `CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5 (
     entry_id UNINDEXED,
     title,
     body,
     keywords,
     tokenize = 'unicode61'
   )`,
  `CREATE TABLE IF NOT EXISTS log_entries (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     workspace TEXT,
     turn INTEGER,
     role TEXT,
     text TEXT NOT NULL,
     chars INTEGER NOT NULL DEFAULT 0,
     distilled INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_log_session ON log_entries(session_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_log_undistilled ON log_entries(distilled, created_at)`,
  // 注入记录：面板上"这一轮到底注入了哪几条"要靠它。
  // 只加计数器不够 —— 计数器说明"注入过"，逐轮流水才能排查"它到底有没有在工作"。
  `CREATE TABLE IF NOT EXISTS injections (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     workspace TEXT,
     form TEXT NOT NULL DEFAULT 'recall',
     entry_ids TEXT NOT NULL DEFAULT '[]',
     chars INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_inject_session ON injections(session_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS distill_runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     started_at INTEGER NOT NULL,
     finished_at INTEGER,
     outcome TEXT,
     logs_in INTEGER NOT NULL DEFAULT 0,
     created INTEGER NOT NULL DEFAULT 0,
     updated INTEGER NOT NULL DEFAULT 0,
     note TEXT,
     raw_preview TEXT
   )`,
];

/** 简易 id：base36(ms) + 随机段。同毫秒并发也不会撞（随机段 26 字符） */
export function newId(now = Date.now()) {
  const t = now.toString(36).padStart(9, '0');
  const rand = Array.from({ length: 4 }, () => Math.floor(Math.random() * 0x100000000).toString(36).padStart(6, '0')).join('');
  return `${t}-${rand.slice(0, 26)}`;
}

function isSensitiveTitle(title, content) {
  return SENSITIVE_TITLE_PATTERN.test(`${title ?? ''}\n${String(content ?? '').slice(0, 400)}`);
}

/**
 * 打开（或创建）一个记忆库。
 * @param {{ dir: string, workspace?: string|null, archiveDir?: string|null }} options
 */
export function openMemory({ dir, workspace = null, archiveDir = null }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dbPath = join(dir, 'memory.db');
  const db = new DatabaseSync(dbPath);
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    /* Windows 上 chmod 语义有限，失败不致命 */
  }

  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA foreign_keys=ON');
  for (const sql of DDL) db.exec(sql);

  const metaGet = db.prepare('SELECT value FROM meta WHERE key = ?');
  const metaPut = db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  const storedVersion = Number(metaGet.get('schema_version')?.value ?? 0);
  if (storedVersion === 0) {
    metaPut.run('schema_version', String(SCHEMA_VERSION));
    metaPut.run('created_at', String(Date.now()));
  } else if (storedVersion > SCHEMA_VERSION) {
    throw new Error(`memory-lite: 记忆库 schema 版本 ${storedVersion} 高于本插件支持的 ${SCHEMA_VERSION}，请升级插件`);
  }
  if (workspace) metaPut.run('workspace', workspace);

  // ── 轻量迁移：老库缺列时补上 ──────────────────────────────────────────────
  // 用 `ALTER TABLE ADD COLUMN`（幂等、非破坏），不用整表重建 ——
  // "从解析结果重建整表"风险高得多（经验库 E17：别重建，做外科手术）。
  try {
    const cols = db.prepare('PRAGMA table_info(distill_runs)').all().map((c) => c.name);
    if (!cols.includes('raw_preview')) db.exec('ALTER TABLE distill_runs ADD COLUMN raw_preview TEXT');
  } catch {
    /* 老库结构异常时忽略，不影响主流程 */
  }
  try {
    const entryCols = db.prepare('PRAGMA table_info(entries)').all().map((c) => c.name);
    if (!entryCols.includes('inject_count')) db.exec('ALTER TABLE entries ADD COLUMN inject_count INTEGER NOT NULL DEFAULT 0');
    if (!entryCols.includes('last_injected_at')) db.exec('ALTER TABLE entries ADD COLUMN last_injected_at INTEGER');
  } catch {
    /* 忽略 */
  }

  // ── 预处理语句 ──────────────────────────────────────────────────────────
  const stmt = {
    insert: db.prepare(`INSERT INTO entries
      (id, level, title, content, keywords, importance, status, project, subcategory, goal, corrected, sensitive, source_session, source_ref, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    byId: db.prepare('SELECT * FROM entries WHERE id = ?'),
    update: db.prepare(`UPDATE entries SET
      title = COALESCE(?, title), content = COALESCE(?, content), keywords = COALESCE(?, keywords),
      importance = COALESCE(?, importance), status = COALESCE(?, status), project = ?,
      subcategory = COALESCE(?, subcategory), goal = COALESCE(?, goal), sensitive = COALESCE(?, sensitive),
      updated_at = ? WHERE id = ?`),
    del: db.prepare('DELETE FROM entries WHERE id = ?'),
    ftsDel: db.prepare('DELETE FROM entries_fts WHERE entry_id = ?'),
    ftsIns: db.prepare('INSERT INTO entries_fts(entry_id, title, body, keywords) VALUES(?,?,?,?)'),
    touch: db.prepare('UPDATE entries SET hit_count = hit_count + 1, last_accessed_at = ? WHERE id = ?'),
    touchInjected: db.prepare('UPDATE entries SET inject_count = inject_count + 1, last_injected_at = ? WHERE id = ?'),
    byLevel: db.prepare('SELECT * FROM entries WHERE (? IS NULL OR level = ?) AND (? IS NULL OR status = ?) ORDER BY level, updated_at DESC'),
    activeByLevel: db.prepare('SELECT * FROM entries WHERE level = ? AND status = ? ORDER BY importance DESC, updated_at DESC'),
    countByLevel: db.prepare('SELECT level, COUNT(*) AS n FROM entries WHERE status = ? GROUP BY level'),
    insertLog: db.prepare('INSERT INTO log_entries(session_id, workspace, turn, role, text, chars, created_at) VALUES(?,?,?,?,?,?,?)'),
    countLogSession: db.prepare('SELECT COUNT(*) AS n FROM log_entries WHERE session_id = ?'),
    countLogDay: db.prepare('SELECT COUNT(*) AS n FROM log_entries WHERE created_at >= ?'),
    lastLogAt: db.prepare('SELECT created_at FROM log_entries WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'),
    oldestLogs: db.prepare('SELECT * FROM log_entries WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'),
    delLogs: db.prepare('DELETE FROM log_entries WHERE id = ?'),
    undistilled: db.prepare('SELECT * FROM log_entries WHERE distilled = 0 ORDER BY created_at ASC LIMIT ?'),
    markDistilled: db.prepare('UPDATE log_entries SET distilled = 1 WHERE id <= ?'),
    recentDistill: db.prepare('SELECT * FROM distill_runs ORDER BY id DESC LIMIT 1'),
    startDistill: db.prepare('INSERT INTO distill_runs(started_at, logs_in) VALUES(?,?)'),
    finishDistill: db.prepare('UPDATE distill_runs SET finished_at = ?, outcome = ?, created = ?, updated = ?, note = ?, raw_preview = ? WHERE id = ?'),
    countDistillDay: db.prepare('SELECT COUNT(*) AS n FROM distill_runs WHERE started_at >= ? AND outcome IS NOT NULL'),
    insertInjection: db.prepare('INSERT INTO injections(session_id, workspace, form, entry_ids, chars, created_at) VALUES(?,?,?,?,?,?)'),
    recentInjections: db.prepare('SELECT * FROM injections WHERE (? IS NULL OR session_id = ?) ORDER BY id DESC LIMIT ?'),
  };

  function rowToEntry(row) {
    if (!row) return null;
    let keywords = [];
    try {
      keywords = JSON.parse(row.keywords ?? '[]');
    } catch {
      keywords = [];
    }
    return {
      id: row.id,
      level: row.level,
      title: row.title ?? '',
      content: row.content,
      keywords,
      importance: row.importance,
      status: row.status,
      project: row.project ?? null,
      subcategory: row.subcategory ?? null,
      goal: row.goal ?? null,
      corrected: Boolean(row.corrected),
      sensitive: Boolean(row.sensitive),
      sourceSession: row.source_session ?? null,
      sourceRef: row.source_ref ?? null,
      hitCount: row.hit_count,
      injectCount: row.inject_count ?? 0,
      lastInjectedAt: row.last_injected_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAccessedAt: row.last_accessed_at ?? null,
    };
  }

  function assertLevel(level) {
    if (!LEVELS.includes(level)) throw new Error(`memory-lite: 非法 level "${level}"，应为 ${LEVELS.join('/')}`);
  }

  /** 写一条记忆。sensitive 在这里算一次并落列 —— 注入侧只读列（fail-closed） */
  function put(input) {
    const level = input.level ?? 'fact';
    assertLevel(level);
    const status = input.status ?? 'active';
    if (!STATUSES.includes(status)) throw new Error(`memory-lite: 非法 status "${status}"`);
    if (level === 'project' && input.subcategory && !PROJECT_SUBCATEGORIES.includes(input.subcategory)) {
      throw new Error(`memory-lite: 非法 subcategory "${input.subcategory}"`);
    }
    const now = Date.now();
    const id = input.id ?? newId(now);
    const content = String(input.content ?? '').trim();
    if (!content) throw new Error('memory-lite: content 不能为空');
    const title = String(input.title ?? '').trim() || null;
    const keywords = Array.isArray(input.keywords) ? input.keywords.map(String) : [];
    const sensitive = input.sensitive === undefined ? (isSensitiveTitle(title, content) ? 1 : 0) : input.sensitive ? 1 : 0;

    stmt.insert.run(
      id, level, title, content, JSON.stringify(keywords), Number(input.importance ?? 1), status,
      input.project ?? null, input.subcategory ?? null, input.goal ?? null,
      input.corrected ? 1 : 0, sensitive, input.sourceSession ?? null, input.sourceRef ?? null, now, now,
    );
    stmt.ftsIns.run(id, title ?? '', content, keywords.join(' '));
    return get(id);
  }

  function get(id) {
    return rowToEntry(stmt.byId.get(id));
  }

  function update(id, patch = {}) {
    const current = get(id);
    if (!current) throw new Error(`memory-lite: 记忆不存在 ${id}`);
    if (patch.level !== undefined) assertLevel(patch.level);
    if (patch.status !== undefined && !STATUSES.includes(patch.status)) {
      throw new Error(`memory-lite: 非法 status "${patch.status}"`);
    }
    const nextContent = patch.content === undefined ? null : String(patch.content);
    const nextTitle = patch.title === undefined ? null : String(patch.title).trim();
    const nextKeywords = patch.keywords === undefined ? null : JSON.stringify(patch.keywords.map(String));
    const sensitive = patch.sensitive === undefined
      ? (isSensitiveTitle(nextTitle ?? current.title, nextContent ?? current.content) ? 1 : 0)
      : patch.sensitive ? 1 : 0;
    const now = Date.now();

    stmt.update.run(
      nextTitle, nextContent, nextKeywords,
      patch.importance === undefined ? null : Number(patch.importance),
      patch.status ?? null,
      // project 允许显式置空（null = 清空归属），所以不用 COALESCE
      patch.project === undefined ? current.project : patch.project,
      patch.subcategory ?? null, patch.goal ?? null,
      sensitive, now, id,
    );
    // FTS 是派生数据：整条重写，避免部分更新留下旧词残影
    const after = get(id);
    stmt.ftsDel.run(id);
    stmt.ftsIns.run(id, after.title ?? '', after.content, after.keywords.join(' '));
    return get(id);
  }

  function remove(id) {
    const existed = Boolean(get(id));
    stmt.ftsDel.run(id);
    stmt.del.run(id);
    return existed;
  }

  function list({ level = null, status = null, project = null, limit = 200 } = {}) {
    let rows = stmt.byLevel.all(level, level, status, status);
    if (project !== null) rows = rows.filter((r) => r.project === project);
    return rows.slice(0, limit).map(rowToEntry);
  }

  function activeOf(level) {
    return stmt.activeByLevel.all(level, 'active').map(rowToEntry);
  }

  /**
   * 关键词检索：FTS5 + LIKE 回退 + 加权排序（V2-3）。
   *
   * 三个实测出来的坑（都踩过，写在这里免得重犯）：
   *   ① FTS5 的 unicode61 把**连续 CJK 当成一个整体 token**，不做切分。
   *      所以喂 bigram（"日志"/"志层"）永远 0 命中 —— 实测 `"日志层"` 命中、
   *      `"日志"` 不命中。FTS 侧要传**完整 CJK 连续串**。
   *   ② LIKE 回退**不能拿整串匹配**：`LIKE '%日志层 蒸馏%'` 要求两词相邻，
   *      而原文里它们中间隔着别的字 → 必然 0 行。必须按词拆开、OR 连接。
   *   ③ 排序也要有依据：精确子串独占最高层（照 git-memory 的 tier 0），
   *      其余按 基分 × 重要性 × 时效 排（照 mneme / prime-memory 的系数与下限）。
   */
  function search(query, { level = null, status = 'active', project = null, limit = 10 } = {}) {
    const q = String(query ?? '').trim();
    if (!q) return [];

    const segments = querySegments(q);
    let hits = [];

    // 路径 1：FTS5（拉丁词效果最好；CJK 用完整串）
    const ftsQuery = segments.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
    if (ftsQuery) {
      try {
        const rows = db.prepare(
          `SELECT entry_id, bm25(entries_fts) AS rank FROM entries_fts WHERE entries_fts MATCH ? ORDER BY rank LIMIT ?`,
        ).all(ftsQuery, Math.max(limit * 8, 80));
        hits = rows.map((r) => ({ id: r.entry_id, score: 1 / (1 + Math.abs(r.rank ?? 0)), tier: 1 }));
      } catch {
        hits = [];
      }
    }

    // 路径 2：LIKE 降级（按词 OR，任一命中即算）
    if (!hits.length) {
      const clauses = segments.map(() => '(title LIKE ? OR content LIKE ? OR keywords LIKE ?)').join(' OR ');
      const params = [];
      for (const seg of segments) {
        const like = `%${seg}%`;
        params.push(like, like, like);
      }
      const rows = db.prepare(`SELECT id FROM entries WHERE (${clauses}) LIMIT ?`).all(...params, Math.max(limit * 8, 80));
      hits = rows.map((r) => ({ id: r.id, score: 0.5, tier: 1 }));
    }

    // 路径 3：仍为空时退到「最长 CJK 子串」逐个 LIKE（应对查询比正文更长）
    if (!hits.length) {
      const cjk = (q.match(/[\u3040-\u30ff\u4e00-\u9fff]+/g) ?? []).filter((s) => s.length >= 2);
      const probes = cjk.flatMap((run) => {
        const out = [];
        for (let len = Math.min(4, run.length); len >= 2; len--) {
          for (let i = 0; i + len <= run.length; i++) out.push(run.slice(i, i + len));
        }
        return out;
      });
      if (probes.length) {
        const clauses = probes.map(() => '(title LIKE ? OR content LIKE ?)').join(' OR ');
        const params = probes.flatMap((p) => [`%${p}%`, `%${p}%`]);
        const rows = db.prepare(`SELECT id FROM entries WHERE (${clauses}) LIMIT ?`).all(...params, Math.max(limit * 8, 80));
        hits = rows.map((r) => ({ id: r.id, score: 0.3, tier: 2 }));
      }
    }

    const out = [];
    for (const hit of hits) {
      const entry = get(hit.id);
      if (!entry) continue;
      if (level && entry.level !== level) continue;
      if (status && status !== 'all' && entry.status !== status) continue;
      if (project !== null && entry.project !== project) continue;
      out.push({ ...entry, score: hit.score, _base: hit.score, _tier: hit.tier ?? 1 });
    }

    // ── V2-3 加权排序 ────────────────────────────────────────────────────
    const HALF_LIFE_DAYS = 60;   // 记忆不像新闻，衰减要慢（prime-memory 用 30 天，我们更宽）
    const DECAY_FLOOR = 0.5;     // 下限是安全机制不是旋钮（prime-memory 注释原话）
    const now = Date.now();
    const qLower = q.toLowerCase();

    for (const item of out) {
      const hay = `${item.title ?? ''}\n${item.content ?? ''}\n${(item.keywords ?? []).join(' ')}`.toLowerCase();
      // 精确子串：最高层，且不受权重影响 —— 避免"匹配最准的那条被时效压下去"
      if (hay.includes(qLower)) {
        item._tier = 0;
        item.score = 1;
        continue;
      }
      let hitCount = 0;
      for (const seg of segments) if (hay.includes(seg.toLowerCase())) hitCount += 1;
      const coverage = segments.length ? hitCount / segments.length : 0;
      const base = Math.max(item._base ?? 0, coverage * 0.7, 0.05);
      const importanceFactor = 0.5 + Math.min(Math.max(item.importance ?? 1, 1), 8) / 8;
      const ageDays = Math.max(0, (now - (item.updatedAt ?? now)) / 86400000);
      const recencyFactor = Math.max(DECAY_FLOOR, Math.pow(0.5, ageDays / HALF_LIFE_DAYS));
      item.score = base * importanceFactor * recencyFactor;
    }

    out.sort((a, b) => {
      if (a._tier !== b._tier) return a._tier - b._tier;
      if (b.score !== a.score) return b.score - a.score;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });

    // 相对下限：丢掉明显不相关的（保留最高分的 30% 以上）。
    // 不用绝对阈值 —— 查询片段多时覆盖率天然偏低，绝对阈值会误杀。
    const top = out[0]?.score ?? 0;
    const kept = top > 0 ? out.filter((e) => e._tier === 0 || e.score >= top * 0.3) : out;
    const sliced = kept.slice(0, limit);
    for (const e of sliced) {
      delete e._base;
      delete e._tier;
    }
    if (sliced.length) {
      for (const e of sliced) stmt.touch.run(now, e.id);
    }
    return sliced;
  }

  function stats() {
    const byLevel = Object.fromEntries(stmt.countByLevel.all('active').map((r) => [r.level, r.n]));
    const total = db.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
    const sensitive = db.prepare('SELECT COUNT(*) AS n FROM entries WHERE sensitive = 1 AND status = ?').get('active').n;
    const undigested = db.prepare('SELECT COUNT(*) AS n FROM log_entries WHERE distilled = 0').get().n;
    const logs = db.prepare('SELECT COUNT(*) AS n FROM log_entries').get().n;
    const injections = db.prepare('SELECT COUNT(*) AS n FROM injections').get().n;
    return { total, activeByLevel: byLevel, sensitiveActive: sensitive, logs, logsUndistilled: undigested, injections };
  }

  // ── 日志层（第 1 档：零 LLM 成本）────────────────────────────────────────
  function appendLog({ sessionId, workspace: ws = workspace, turn = null, role = 'turn', text }) {
    const body = String(text ?? '');
    const now = Date.now();
    const info = stmt.insertLog.run(sessionId, ws, turn, role, body, body.length, now);
    rotateLogs(sessionId);
    return Number(info.lastInsertRowid);
  }

  /** 日志溢出 → 先落归档文件再删库内行（不静默丢） */
  function rotateLogs(sessionId) {
    const n = stmt.countLogSession.get(sessionId).n;
    if (n <= LOG_MAX_PER_SESSION) return 0;
    const overflow = n - LOG_MAX_PER_SESSION;
    const rows = stmt.oldestLogs.all(sessionId, overflow);
    if (archiveDir) {
      try {
        mkdirSync(archiveDir, { recursive: true });
        const file = join(archiveDir, `log-${sessionId}.jsonl`);
        appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      } catch {
        // 归档失败就本轮不删 —— 宁可库大一点，也不丢数据
        return 0;
      }
    }
    for (const row of rows) stmt.delLogs.run(row.id);
    return rows.length;
  }

  function logsSince(sessionId, ms) {
    const last = stmt.lastLogAt.get(sessionId);
    if (last && Date.now() - last.created_at < ms) return { tooSoon: true, lastAt: last.created_at };
    return { tooSoon: false, lastAt: last?.created_at ?? null };
  }

  /** 该会话最后一条日志的正文（用于"同一轮重复触发"的幂等判断） */
  function lastLogText(sessionId) {
    const row = db.prepare('SELECT text FROM log_entries WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sessionId);
    return row?.text ?? null;
  }

  function undistilled(limit) {
    return stmt.undistilled.all(limit);
  }

  function markDistilledUpTo(id) {
    stmt.markDistilled.run(id);
  }

  function dayCount() {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    return stmt.countLogDay.get(since.getTime()).n;
  }

  /** 今天跑过几次蒸馏（用于日配额；只算已结束的） */
  function dayDistillCount() {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    return stmt.countDistillDay.get(since.getTime()).n;
  }

  /**
   * 记一次注入（V2-1 注入可见性）。
   * 逐轮记的理由：计数器只能说明"注入过"，而排查"它到底有没有在工作"需要逐轮流水。
   * 同时把被注入的条目计数 +1，面板就能显示"这条被用过几次、最近一次什么时候"。
   */
  function recordInjection({ sessionId, workspace: ws = workspace, form = 'recall', entryIds = [], chars = 0 }) {
    const now = Date.now();
    stmt.insertInjection.run(sessionId, ws, form, JSON.stringify(entryIds), chars, now);
    for (const id of entryIds) {
      try {
        stmt.touchInjected.run(now, id);
      } catch {
        /* 条目可能已被删，忽略 */
      }
    }
  }

  /** 最近的注入记录（sessionId 传 null 则不限会话） */
  function recentInjections(sessionId = null, limit = 30) {
    return stmt.recentInjections.all(sessionId, sessionId, limit).map((row) => {
      let ids = [];
      try {
        ids = JSON.parse(row.entry_ids ?? '[]');
      } catch {
        ids = [];
      }
      return {
        id: row.id,
        sessionId: row.session_id,
        workspace: row.workspace ?? null,
        form: row.form,
        entryIds: ids,
        chars: row.chars,
        createdAt: row.created_at,
      };
    });
  }

  // ── 蒸馏留痕 ────────────────────────────────────────────────────────────
  function lastDistillRun() {
    return stmt.recentDistill.get() ?? null;
  }

  function startDistillRun(logsIn) {
    const info = stmt.startDistill.run(Date.now(), logsIn);
    return Number(info.lastInsertRowid);
  }

  /**
   * 收尾一次蒸馏。
   * `rawPreview` 是**模型原始输出的前若干字符** —— 加它的理由：
   * 第一次真机跑蒸馏时 created=0 而没有任何证据说明"模型到底回了什么"，只能靠猜。
   * 留一行原始输出在库里，下次一眼就能看出是"模型没按格式回"还是"解析器有 bug"。
   */
  function finishDistillRun(runId, { outcome, created = 0, updated = 0, note = null, rawPreview = null }) {
    stmt.finishDistill.run(Date.now(), outcome, created, updated, note, rawPreview ? String(rawPreview).slice(0, 4000) : null, runId);
  }

  function setMeta(key, value) {
    metaPut.run(String(key), String(value));
  }

  function getMeta(key) {
    return metaGet.get(String(key))?.value ?? null;
  }

  function close() {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }

  return {
    dir,
    dbPath,
    workspace,
    // 记忆条目
    put, get, update, remove, list, activeOf, search, stats,
    // 日志层
    appendLog, logsSince, lastLogText, undistilled, markDistilledUpTo, dayCount,
    // 蒸馏
    lastDistillRun, startDistillRun, finishDistillRun, dayDistillCount,
    // 注入可见性（V2-1）
    recordInjection, recentInjections,
    // 元数据与生命周期
    setMeta, getMeta, close,
    _raw: db,
  };
}

/**
 * 把查询切成"可检索片段"，供 FTS 与 LIKE 两条路径共用。
 *
 * 关键：CJK **不能**用 bigram 当片段 —— FTS5 的 unicode61 把连续 CJK 当一个整体
 * token（实测 `"日志层"` 命中、`"日志"` 0 命中），所以要把整串作为片段，
 * 再补上 2~4 字的子串，让它对"查询比正文长"的情形也有机会命中。
 * 拉丁词照常按词切（FTS 对它工作正常）。
 */
export function querySegments(query) {
  const s = String(query ?? '');
  const out = new Set();
  for (const m of s.matchAll(/[A-Za-z0-9_]{2,}/g)) out.add(m[0].toLowerCase());
  for (const run of s.match(/[\u3040-\u30ff\u4e00-\u9fff]+/g) ?? []) {
    if (run.length <= 8) {
      out.add(run);
    } else {
      for (let len = 4; len >= 2; len--) {
        for (let i = 0; i + len <= Math.min(run.length, 12); i++) out.add(run.slice(i, i + len));
      }
    }
    if (run.length >= 2 && run.length <= 12) {
      for (let len = Math.min(4, run.length); len >= 2; len--) {
        for (let i = 0; i + len <= run.length; i++) out.add(run.slice(i, i + len));
      }
    }
  }
  return [...out];
}

/** 兼容旧名（校验器还在用）：返回片段列表 */
export function tokenizeQuery(query) {
  return querySegments(query);
}

export function memoryDirFor(workspaceRoot, dirName) {
  const base = workspaceRoot && existsSync(workspaceRoot) ? workspaceRoot : null;
  return base ? join(base, dirName) : null;
}
