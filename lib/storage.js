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
import { LEVELS, STATUSES, PROJECT_SUBCATEGORIES, SENSITIVE_TITLE_PATTERN, REDACTED_MARK, redactSecrets, LOG_MAX_PER_SESSION } from './config.js';

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
  // 召回观测（V3）：**每一轮**召回尝试都落一行，**包括 0 命中的那种**。
  //
  // 为什么要有这张表：以前回答不了"召回到底命中多少轮"。日志层存的是一整轮文本
  // （含系统样板），拿不到"当时那句 query"，所以离线既复现不了、也验收不了任何
  // 检索改动 —— 改完检索只能靠"感觉好像好点了"。有了这张表，`diag-recall-quality.mjs`
  // 可以在库副本上**逐条重放**并给出零命中率 / top1 命中率，检索改动从此可验收。
  //
  // 只存脱敏后的 query 文本（≤RECALL_QUERY_CHARS 字）：日志层本来就存了整轮原文，
  // 这里不额外扩大暴露面；但**哈希做不到重放**（没法拿哈希去检索），所以必须存文本。
  `CREATE TABLE IF NOT EXISTS recall_runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     turn INTEGER,
     query_text TEXT NOT NULL DEFAULT '',
     query_chars INTEGER NOT NULL DEFAULT 0,
     segments INTEGER NOT NULL DEFAULT 0,
     hits INTEGER NOT NULL DEFAULT 0,
     picked INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_recall_created ON recall_runs(created_at)`,
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

/**
 * 判定一条记忆是否敏感（**决定它会不会被自动注入**）。
 *
 * ⚠ 2026-10-13 重写（对着实测缺陷）：旧实现把正则打到 `标题 + 正文前 400 字`，
 *   而正则里有 `token` / `pat\b` 这类词。结果 **4 条 active 敏感里至少 3 条是误判**：
 *   · 「DSH 记忆插件 V1 的存储层实测结论」—— 讲的是 FTS 的**分词 token**，被当成凭据
 *   · 「IM 渠道能力诚实分级」—— 正文提到 AppID/AppSecret，被当成密钥
 *   · 「发版前插件体检：清私人信息」—— 正文出现"凭据/密钥"这几个字，被当成凭据
 *   代价是这些记忆**永远进不了提示词**，而它们是正常技术知识。误判还会掩盖真问题：
 *   敏感闸门看起来"在工作"，实际在拦错东西。
 *
 * 现在的两条判据，都比关键词猜测精确：
 *   ① **标题**命中敏感主题词（凭据/密钥/密码/token…）—— 标题是作者对内容的定性，可信度高
 *   ② **正文里出现脱敏标记 `[REDACTED:xxx]`** —— 这是**精确**信号：写入时
 *      `redactSecrets` 把真凭据换成了这个标记，所以它出现 = 这条**确实**含过真凭据
 *      （见 config.js 的 SECRET_PATTERNS）
 *
 * 这样"提到密钥这个词"不再等于"含密钥"，而"确实含过密钥"依然会被拦。
 */
function isSensitiveTitle(title, content) {
  if (SENSITIVE_TITLE_PATTERN.test(String(title ?? ''))) return true;
  return REDACTED_MARK.test(String(content ?? ''));
}

/** 显式回收 WAL。
 *
 * ⚠ 为什么需要（2026-10-13 实测）：库是**进程常驻打开**的，而 SQLite 默认
 *   `wal_autocheckpoint = 1000 页` —— 一页 4 KB，正好约 **4 MB**。
 *   实测工作区库主库 1312 KB、**WAL 4052 KB**，就是卡在这个默认值上：
 *   自动 checkpoint 会执行，但**文件不会缩回**（TRUNCATE 才会）。
 *   全局库同样（144 KB 主库 + 470 KB WAL）。全文里此前**没有任何**
 *   wal_checkpoint 调用，所以这不是"配置不当"，是**从来没回收过**。
 *
 * 只在没有其他读者时才能真正截断；失败的代价只是"这次没回收"，不影响正确性。
 */
function checkpoint(db, mode = 'TRUNCATE') {
  try {
    db.prepare(`PRAGMA wal_checkpoint(${mode})`).get();
    return true;
  } catch {
    return false;
  }
}

/** 解析 entry_ids 列。**脏数据不能让它抛** —— 一行坏数据不该让整个面板读不出来。 */
function safeParseIds(raw) {
  if (raw === null || raw === undefined || raw === '') return [];
  try {
    const v = JSON.parse(String(raw));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** 解析 feedback 列（`{ "<entryId>": { v, at } }`）。同样容忍脏数据。 */
function safeParseFeedback(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const v = JSON.parse(String(raw));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
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
  // 自动 checkpoint 的页阈值。默认 1000 页 × 4 KB ≈ **4 MB** —— 实测 WAL 4052 KB
  // 正好卡在这个默认值上（见 checkpoint() 的注释）。降到 256 页（≈1 MB）后，
  // 自动回收更频繁，且不依赖"何时关闭进程"。这是**有实测证据**的调整，不是凭感觉。
  db.exec('PRAGMA wal_autocheckpoint=256');
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
  // ── V4 迁移：recall_runs 补三列（阶段三反馈闭环的地基）────────────────────
  //
  // 为什么必须加 `entry_ids`：原来这张表只记 `hits`/`picked` **计数**，
  // 于是事后**无法对账"当时到底召回了哪几条"** —— 诊断脚本算出"与历史不一致 86/102"，
  // 但它连"哪条变了"都说不出来（只能比数字）。有了顺序 ID，才能做反馈闭环、
  // 才能把"标注测试集"和"真实使用证据"对上。
  //
  // `feedback` 存 JSON（`{ "<entryId>": { v, at } }`）而不是另开一张表 ——
  // 任务书要求"尽量复用已有结构，避免重复造表"，而这里是 1:N 的小数据。
  try {
    const recallCols = db.prepare('PRAGMA table_info(recall_runs)').all().map((c) => c.name);
    if (!recallCols.includes('entry_ids')) db.exec("ALTER TABLE recall_runs ADD COLUMN entry_ids TEXT NOT NULL DEFAULT '[]'");
    if (!recallCols.includes('algo_version')) db.exec('ALTER TABLE recall_runs ADD COLUMN algo_version TEXT');
    if (!recallCols.includes('feedback')) db.exec('ALTER TABLE recall_runs ADD COLUMN feedback TEXT');
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
    insertRecall: db.prepare('INSERT INTO recall_runs(session_id, turn, query_text, query_chars, segments, hits, picked, entry_ids, algo_version, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)'),
    // 只保留最近 N 行：观测数据不该成为库膨胀的来源
    trimRecall: db.prepare('DELETE FROM recall_runs WHERE id <= (SELECT MAX(id) - ? FROM recall_runs)'),
    recentRecall: db.prepare('SELECT * FROM recall_runs ORDER BY id DESC LIMIT ?'),
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
    // ⚠ 2026-10-13 安全复核发现：脱敏原本**只在 lib/tools.js 的调用方做**，
    //   而 `put()` 是公开 API —— 任何绕过 tools.js 的写入（诊断脚本、未来的新路径、
    //   面板的别的入口）都会把真凭据**原样落库**。
    //   更要命的是：敏感分类器依赖"脱敏标记已存在"，所以漏脱敏 = **既没脱敏、又没标敏感**，
    //   两个机制同时失效、而且悄无声息。
    //   现在把脱敏下沉到存储层（**单点**），调用方重复调用是幂等的。
    const content = redactSecrets(String(input.content ?? '').trim());
    if (!content) throw new Error('memory-lite: content 不能为空');
    const title = redactSecrets(String(input.title ?? '').trim()) || null;
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
    const nextContent = patch.content === undefined ? null : redactSecrets(String(patch.content));
    const nextTitle = patch.title === undefined ? null : redactSecrets(String(patch.title).trim());
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

    // ── 强片段（V4-1）────────────────────────────────────────────────────
    //
    // 这是「82% 无关注入」的正面修正：**只用能代表意图的片段去检索**。
    // 规则：整串（任意长度，含 2 字）总是强片段；作为**长 query 的碎片**时，
    //       中文要 ≥3 字、拉丁词要 ≥3 字母才算数。
    //
    // 依据（基线实测）：`滑雪` 这种 2 字 query 整串命中是有意义的；
    // 而 `再试一次` 的 `再试`/`试一`/`一次` 命中是撞上的。旧实现把 2~4 字
    // 碎片一律当可检索片段，于是「把这个文件删掉」这类 query 也能凑出 3 条注入。
    const segments = queryStrongSegments(q);
    if (!segments.length) return [];

    // 过滤条件**下推到 SQL**（D2）：旧实现在 `LIMIT 80` 之后才按 status 过滤，
    // 若前 80 条多是归档/过期条目，命中再多也会被滤成 0。
    const filters = [];
    const filterParams = [];
    if (status && status !== 'all') { filters.push('e.status = ?'); filterParams.push(status); }
    if (level) { filters.push('e.level = ?'); filterParams.push(level); }
    if (project !== null) { filters.push('e.project = ?'); filterParams.push(project); }
    const whereSql = filters.length ? ` AND ${filters.join(' AND ')}` : '';

    // ── 三条路径**并集**（D1）────────────────────────────────────────────
    // 旧实现是 `if (!hits.length)` 串联兜底：FTS 只要命中一条，LIKE 路径就
    // **永远不执行**，召回率被单路径锁死。现在三条都跑，同一条目取最高分。
    const merged = new Map();
    const put = (id, score, tier) => {
      const prev = merged.get(id);
      if (!prev || score > prev.score) merged.set(id, { id, score, tier });
    };

    // 路径 1：FTS5（拉丁词效果最好；CJK 要传完整串 —— unicode61 把连续 CJK 当一个 token）
    const ftsQuery = segments.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
    if (ftsQuery) {
      try {
        const rows = db.prepare(
          `SELECT f.entry_id AS entry_id, bm25(entries_fts) AS rank
             FROM entries_fts f JOIN entries e ON e.id = f.entry_id
            WHERE entries_fts MATCH ?${whereSql}
            ORDER BY rank LIMIT ?`,
        ).all(ftsQuery, ...filterParams, Math.max(limit * 8, 80));
        for (const r of rows) put(r.entry_id, 1 / (1 + Math.abs(r.rank ?? 0)), 1);
      } catch { /* FTS 不可用时靠下面两条 */ }
    }

    // 路径 2：LIKE（按强片段 OR，任一命中即算）
    {
      const clauses = segments.map(() => '(e.title LIKE ? OR e.content LIKE ? OR e.keywords LIKE ?)').join(' OR ');
      const params = [];
      for (const seg of segments) {
        const like = `%${seg}%`;
        params.push(like, like, like);
      }
      const rows = db.prepare(
        `SELECT e.id AS id FROM entries e WHERE (${clauses})${whereSql}
          ORDER BY e.updated_at DESC LIMIT ?`,
      ).all(...params, ...filterParams, Math.max(limit * 8, 80));
      for (const r of rows) put(r.id, 0.5, 1);
    }

    // 路径 3：查询比正文长时的补充探测。**只加不减**，且只在候选还不够时跑。
    if (merged.size < limit) {
      const probes = segments.filter((s) => s.length >= 3);
      if (probes.length) {
        const clauses = probes.map(() => '(e.title LIKE ? OR e.content LIKE ?)').join(' OR ');
        const params = probes.flatMap((p) => [`%${p}%`, `%${p}%`]);
        const rows = db.prepare(
          `SELECT e.id AS id FROM entries e WHERE (${clauses})${whereSql} LIMIT ?`,
        ).all(...params, ...filterParams, Math.max(limit * 8, 80));
        for (const r of rows) put(r.id, 0.3, 2);
      }
    }

    const out = [];
    for (const hit of merged.values()) {
      const entry = get(hit.id);
      if (!entry) continue;
      // ⚠ 过滤已下推到 SQL；这里保留一道 JS 兜底 —— 两道口径必须一致，
      //   防的是未来改 SQL 时漏改（改了 SQL 忘了这里，会出现"SQL 放行、JS 拒绝"的静默不一致）
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

  /**
   * 只给条目计数 +1（不写 injections 日志行）。
   *
   * 为什么需要它（V1.7）：用户级库的条目会在**别的**工作区的召回里被注入。
   * 那次注入的日志行记在工作区库里（会话在哪就记在哪），但"这条被用过几次"
   * 的计数必须落在**条目自己所属的库**里 —— 否则面板上用户级条目的 inject_count 永远是 0。
   */
  function bumpInjected(entryIds = []) {
    const now = Date.now();
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

  // ── 召回观测（V3）────────────────────────────────────────────────────────
  /**
   * 记一次"召回尝试"。**每一轮都记，包括 0 命中的那种** —— 0 命中恰恰是最需要的样本
   * （它回答的是"这条 query 为什么什么都没找到"）。
   * `query` 传进来前应当已经过 `redactSecrets()`（调用方负责），这里只做长度截断。
   */
  function recordRecallRun({ sessionId, turn = null, query = '', segments = 0, hits = 0, picked = 0, entryIds = [], algoVersion = null, keep = 500 }) {
    const now = Date.now();
    const text = String(query ?? '').slice(0, 500);
    // entryIds 按**注入顺序**存（顺序本身是数据：第 1 条 vs 第 3 条在反馈里含义不同）
    const ids = Array.isArray(entryIds) ? entryIds.slice(0, 20) : [];
    stmt.insertRecall.run(sessionId, turn, text, text.length, segments, hits, picked, JSON.stringify(ids), algoVersion ?? null, now);
    try {
      stmt.trimRecall.run(keep);
    } catch {
      /* 裁剪失败不影响记录本身 */
    }
  }

  /** 最近的召回尝试（倒序） */
  function recentRecallRuns(limit = 100) {
    return stmt.recentRecall.all(limit).map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      turn: row.turn,
      query: row.query_text,
      queryChars: row.query_chars,
      segments: row.segments,
      hits: row.hits,
      picked: row.picked,
      // V4：注入的条目 ID（**按注入顺序**）与算法版本 —— 反馈闭环靠它们定位
      entryIds: safeParseIds(row.entry_ids),
      algoVersion: row.algo_version ?? null,
      feedback: safeParseFeedback(row.feedback),
      createdAt: row.created_at,
    }));
  }

  // ── V4：召回反馈（阶段三）───────────────────────────────────────────────
  //
  // 设计取舍（对着任务书的六条要求）：
  //   · 六种标记分两类语义：`useless`/`duplicate` 是**本轮召回不相关**；
  //     `stale`/`conflict` 是**记忆本身有问题** —— 两者混在一起会让统计失去意义
  //   · `partial` 表示"部分有用"（介于 useful 与 useless 之间）
  //   · 反馈**只写 recall_runs.feedback 这一个字段**：不改记忆、不改状态、不删东西
  //     （要求 2：不自动视为新记忆；要求 3：不因单次负面反馈永久删除）
  //   · 可**撤销**：`clearRecallFeedback` 把某个条目的标记删掉
  //   · 写入发生在**召回之后**，不在 search() 路径上 —— 不拖慢召回（要求 6）
  function setRecallFeedback(runId, entryId, verdict, note = null) {
    const okVerdicts = ['useful', 'partial', 'useless', 'duplicate', 'stale', 'conflict'];
    if (!okVerdicts.includes(verdict)) return { ok: false, error: `verdict 必须是 ${okVerdicts.join('/')}` };
    const row = db.prepare('SELECT feedback FROM recall_runs WHERE id = ?').get(Number(runId));
    if (!row) return { ok: false, error: `找不到 recall_run ${runId}` };
    const fb = safeParseFeedback(row.feedback) ?? {};
    fb[String(entryId)] = { v: verdict, at: Date.now(), ...(note ? { note: String(note).slice(0, 200) } : {}) };
    db.prepare('UPDATE recall_runs SET feedback = ? WHERE id = ?').run(JSON.stringify(fb), Number(runId));
    return { ok: true, runId: Number(runId), entryId: String(entryId), verdict };
  }

  /** 撤销某条反馈（或整轮全部）。返回是否真的删掉了东西。 */
  function clearRecallFeedback(runId, entryId = null) {
    const row = db.prepare('SELECT feedback FROM recall_runs WHERE id = ?').get(Number(runId));
    if (!row) return { ok: false, error: `找不到 recall_run ${runId}` };
    const fb = safeParseFeedback(row.feedback) ?? {};
    if (entryId === null) {
      db.prepare('UPDATE recall_runs SET feedback = NULL WHERE id = ?').run(Number(runId));
      return { ok: true, cleared: Object.keys(fb).length };
    }
    delete fb[String(entryId)];
    db.prepare('UPDATE recall_runs SET feedback = ? WHERE id = ?').run(JSON.stringify(fb), Number(runId));
    return { ok: true, cleared: 1 };
  }

  /** 反馈统计：按标记计数 + 按算法版本分组（用来回答"新版检索是不是更准"）。 */
  function recallFeedbackStats(limit = 500) {
    const rows = db.prepare('SELECT feedback, algo_version FROM recall_runs WHERE feedback IS NOT NULL ORDER BY id DESC LIMIT ?').all(limit);
    const byVerdict = {};
    const byVersion = {};
    let marked = 0;
    for (const r of rows) {
      const fb = safeParseFeedback(r.feedback) ?? {};
      const ver = r.algo_version ?? '(未记录)';
      for (const [, v] of Object.entries(fb)) {
        byVerdict[v.v] = (byVerdict[v.v] ?? 0) + 1;
        byVersion[ver] = byVersion[ver] ?? {};
        byVersion[ver][v.v] = (byVersion[ver][v.v] ?? 0) + 1;
        marked += 1;
      }
    }
    return { runsWithFeedback: rows.length, marked, byVerdict, byVersion };
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
      // 关之前先回收 WAL（TRUNCATE）—— 见 checkpoint() 的注释：
      // 库是进程常驻打开的，默认 autocheckpoint 只搬数据不缩文件。
      // 这里失败不影响关闭（checkpoint() 自己吞异常）。
      checkpoint(db);
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
    recordInjection, bumpInjected, recentInjections,
    // 召回观测（V3）
    recordRecallRun, recentRecallRuns,
    // 召回反馈（V4）
    setRecallFeedback, clearRecallFeedback, recallFeedbackStats,
    // 元数据与生命周期
    setMeta, getMeta, close,
    /** 手动回收 WAL（面板「整理」/ 维护脚本可用）。失败只返回 false，不抛。 */
    checkpoint: (mode) => checkpoint(db, mode),
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

/**
 * 强片段：**只保留能代表查询意图的片段**（V4-1）。
 *
 * 与 {@link querySegments} 的区别就在于那一条规则：
 *   · 整串（任意长度，**含 2 字**）总是强片段 —— `滑雪` 这种 2 字 query，
 *     整串命中是有意义的（它就是完整的意图）
 *   · 作为**长 query 的碎片**时：中文 ≥3 字、拉丁词 ≥3 字母才算数
 *
 * 为什么需要它（基线实测）：`把这个文件删掉`、`再试一次`、`今天几号` 这类
 * 无记忆需求的 query，旧实现靠 2 字碎片也能凑出满 3 条注入 —— 基线里
 * **16 条负样本有 11 条被注入**，无关注入率 82.3%。碎片长度是能区分这两类的
 * 最直接判据，而且不需要引入任何新依赖。
 */
export function queryStrongSegments(query) {
  const s = String(query ?? '');
  const out = new Set();
  // 拉丁词：整串 ≥3 字母才算（HMR / FTS5 / ChatGPT）
  for (const m of s.matchAll(/[A-Za-z0-9_]{3,}/g)) out.add(m[0].toLowerCase());
  for (const run of s.match(/[\u3040-\u30ff\u4e00-\u9fff]+/g) ?? []) {
    out.add(run);                                    // 整串总是强片段
    for (let len = 4; len >= 3; len--) {             // 长 query 的碎片要 ≥3 字
      for (let i = 0; i + len <= run.length; i++) out.add(run.slice(i, i + len));
    }
  }
  return [...out].filter((t) => t !== '');
}

/** 兼容旧名（校验器还在用）：返回片段列表 */
export function tokenizeQuery(query) {
  return querySegments(query);
}

export function memoryDirFor(workspaceRoot, dirName) {
  const base = workspaceRoot && existsSync(workspaceRoot) ? workspaceRoot : null;
  return base ? join(base, dirName) : null;
}
