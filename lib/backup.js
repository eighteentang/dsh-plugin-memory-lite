/**
 * 自动备份（V5，2026-10-13）
 *
 * ## 用什么方式备份
 *
 * **`node:sqlite` 的 `backup()`** —— 它就是 SQLite 的 Online Backup API：
 *   · 拿到的是**一致快照**（含当时 WAL 里已提交但未 checkpoint 的数据）
 *   · **不需要**关闭库、不需要 `wal_checkpoint(TRUNCATE)`、不阻塞正常读写
 *   · 是 Node 内置模块，**不新增任何依赖**
 *
 * ⚠ 为什么不直接复制 memory.db：库以 WAL 模式运行，已提交的数据可能还在 `-wal` 里。
 *   单复制主库会**静默丢掉那部分数据**，而备份看起来"成功了" —— 这是最坏的一种失败。
 *   现有那份 2026-10-11 的手动备份就是这个形态（只含主库、不含 WAL）。
 *
 * ## 保留策略
 *
 *   · 日常备份按时间戳命名，只保留最近 N 份（默认 7）
 *   · **迁移前备份**（`pre-migration`）单独归档，**不参与日常清理**
 *   · 清理顺序：**先验证新备份成功，再从旧到新删**；任何情况下不删最新一份
 *   · 空间不足 / 清理失败 → 写日志（不抛，不影响记忆读写）
 *
 * ## 隐私
 *
 *   · 备份目录权限收紧（0700）；备份文件 0600
 *   · 日志只记文件名、大小、校验结果、失败原因 —— **绝不记正文**
 *   · 不上传任何外部服务；备份目录在 `$DSH_HOME/memory-lite/backups`（不在 git 工作区）
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, chmodSync, appendFileSync, rmSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

/** 名称里带这个标记的备份不参与日常清理 */
const PROTECTED_MARK = 'pre-migration';

/** 时间戳：本地时间 + 毫秒。
 *
 * ⚠ 2026-10-13 修：第一版只到秒，于是**同一秒内的两次备份会撞名**，
 *   而 Windows 的 `renameSync` 会**静默覆盖**已存在的文件 ——
 *   实测表现为"迁移前备份报告成功、但目录里找不到它"（被后一份覆盖了）。
 *   加上毫秒 + 一个进程内自增序号，彻底避免撞名。
 */
let seq = 0;
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  seq = (seq + 1) % 1000;
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}${String(seq).padStart(3, '0')}`;
}

/** 日志一行。**只写元数据，不写正文** —— 备份里可能有私人记忆。 */
function logLine(logFile, level, msg) {
  if (!logFile) return;
  try {
    mkdirSync(join(logFile, '..'), { recursive: true });
    appendFileSync(logFile, `${new Date().toISOString()} [${level}] ${msg}\n`, 'utf8');
  } catch { /* 日志失败不能连累备份 */ }
}

/**
 * 校验一份备份文件。
 *
 * 判据（任务书要求的最小集合）：文件存在且大小合理 → `integrity_check` 通过 →
 * 核心表齐全 → FTS 行数与 entries 一致 → schema_version 元数据在。
 *
 * @returns {{ok: boolean, reason?: string, size?: number, entries?: number, fts?: number, schemaVersion?: string|null}}
 */
export function verifyBackupFile(file) {
  if (!existsSync(file)) return { ok: false, reason: '文件不存在' };
  const size = statSync(file).size;
  if (size < 512) return { ok: false, reason: `文件过小（${size} 字节），不像完整库`, size };
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const ic = db.prepare('PRAGMA integrity_check').get();
    const verdict = ic?.integrity_check ?? ic?.['integrity_check'];
    if (verdict !== 'ok') return { ok: false, reason: `integrity_check=${verdict}`, size };
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const t of ['entries', 'entries_fts', 'recall_runs', 'meta']) {
      if (!tables.includes(t)) return { ok: false, reason: `缺表 ${t}`, size };
    }
    const entries = db.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
    const fts = db.prepare('SELECT COUNT(*) AS n FROM entries_fts').get().n;
    if (entries !== fts) return { ok: false, reason: `FTS 与条目数不一致（entries=${entries} fts=${fts}）`, size, entries, fts };
    const sv = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? null;
    return { ok: true, size, entries, fts, schemaVersion: sv };
  } catch (error) {
    return { ok: false, reason: `打开/校验失败：${String(error?.message ?? error).slice(0, 120)}`, size };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** 列出备份目录里的备份文件（按 mtime 从新到旧） */
export function listBackups(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({ name: f, path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs, size: statSync(join(dir, f)).size }))
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * 建一份备份。
 *
 * @param {object} p
 * @param {object} p.db         **打开着的** DatabaseSync（在线库；backup() 自己保证一致性）
 * @param {string} p.dir        备份目录
 * @param {string} [p.tag]      标记（如 `pre-migration`）
 * @param {number} [p.keep]     日常备份保留份数
 * @param {string} [p.logFile]  日志文件
 * @returns {Promise<{ok:boolean, file?:string, reason?:string, verified?:object}>}
 */
export async function createBackup({ db, dir, tag = 'daily', keep = 7, logFile = null }) {
  // ⚠ 先用**参数校验**挡住非法句柄（2026-10-13 实测发现）：
  //   把普通对象传给 `backup()` 会让进程**原生崩溃**（没有 JS 异常、没有栈、
  //   连 try/catch 都拦不住）—— 实测表现为校验器静默退出、什么都不打印。
  //   判据：**能被 catch 的前提是它是 JS 异常；原生崩溃必须先靠校验挡在门外。**
  if (!(db instanceof DatabaseSync)) {
    logLine(logFile, 'error', '备份跳过：db 不是 DatabaseSync 实例');
    return { ok: false, reason: 'db 句柄非法（必须是 DatabaseSync 实例）' };
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    logLine(logFile, 'error', `备份目录创建失败：${String(error?.message ?? error)}`);
    return { ok: false, reason: '备份目录不可用' };
  }
  const file = join(dir, `memory-${stamp()}${tag === PROTECTED_MARK ? `-${PROTECTED_MARK}` : ''}.db`);

  // ── 1. 用 Online Backup API 写入临时名，**校验通过后再改名**
  //      这样"校验失败"不会留下一个看起来可用的半成品
  const tmpFile = `${file}.partial`;
  try {
    if (existsSync(tmpFile)) rmSync(tmpFile, { force: true });
    await backup(db, tmpFile);
  } catch (error) {
    const reason = String(error?.message ?? error).slice(0, 160);
    logLine(logFile, 'error', `备份写入失败：${reason}`);
    try { if (existsSync(tmpFile)) rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
    return { ok: false, reason };
  }

  // ── 1·五 **把临时库变成自包含文件**（2026-10-13 修的真缺陷）
  //
  // ⚠ `backup()` 写出来的是一个**新开的 SQLite 库**，它同样跑在 WAL 模式下，
  //   于是临时文件旁边会有 `-wal` / `-shm`。第一版只 rename 了主文件 ——
  //   后果是：① 旁文件被遗留成垃圾；② **改名后的备份可能丢掉还在 WAL 里的数据**，
  //   而当时校验能过，因为校验时旁文件还在旁边。
  //   现在显式 checkpoint 到主文件，再删旁文件 —— 备份从此是**单个自包含文件**。
  try {
    const tmpDb = new DatabaseSync(tmpFile);
    try {
      tmpDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      tmpDb.exec('PRAGMA journal_mode=DELETE');   // 彻底脱离 WAL 模式
    } finally {
      try { tmpDb.close(); } catch { /* ignore */ }
    }
  } catch (error) {
    logLine(logFile, 'error', `备份收尾（checkpoint）失败：${String(error?.message ?? error).slice(0, 120)}`);
  }
  for (const side of ['-wal', '-shm']) {
    try { if (existsSync(`${tmpFile}${side}`)) rmSync(`${tmpFile}${side}`, { force: true }); } catch { /* ignore */ }
  }

  // ── 2. 校验（**未通过就不改名、也不清理旧备份**）
  const verified = verifyBackupFile(tmpFile);
  if (!verified.ok) {
    logLine(logFile, 'error', `备份校验失败（已丢弃，保留旧备份）：${verified.reason}`);
    try { if (existsSync(tmpFile)) rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
    return { ok: false, reason: verified.reason, verified };
  }

  try {
    // rename 是原子的（同一文件系统内）
    const { renameSync } = await import('node:fs');
    renameSync(tmpFile, file);
    try { chmodSync(file, 0o600); } catch { /* Windows 上语义有限 */ }
  } catch (error) {
    const reason = String(error?.message ?? error).slice(0, 160);
    logLine(logFile, 'error', `备份改名失败：${reason}`);
    try { if (existsSync(tmpFile)) rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
    return { ok: false, reason };
  }

  logLine(logFile, 'info', `备份成功 ${file.split(/[\\/]/).pop()} · ${Math.round(verified.size / 1024)}KB · ${verified.entries} 条 · FTS ${verified.fts} · schema ${verified.schemaVersion}`);

  // ── 3. 清理（**在新备份已验证之后**才做）
  const pruned = pruneBackups(dir, keep, logFile, file);
  return { ok: true, file, verified, pruned };
}

/**
 * 保留最近 `keep` 份**日常**备份；`pre-migration` 的永不清理。
 * **永远不删最新一份**（哪怕 keep=0，那是配置错误，不是删库的理由）。
 */
export function pruneBackups(dir, keep, logFile = null, justCreated = null) {
  const all = listBackups(dir);
  const daily = all.filter((b) => !b.name.includes(PROTECTED_MARK));
  if (daily.length <= Math.max(1, keep)) return 0;
  const victims = daily.slice(Math.max(1, keep));
  let removed = 0;
  for (const v of victims) {
    if (justCreated !== null && v.path === justCreated) continue;   // 绝不删刚建的那份
    try {
      unlinkSync(v.path);
      removed += 1;
      logLine(logFile, 'info', `清理旧备份 ${v.name}`);
    } catch (error) {
      logLine(logFile, 'error', `清理失败 ${v.name}：${String(error?.message ?? error).slice(0, 100)}`);
    }
  }
  return removed;
}

/**
 * 迁移前备份（**同步版**，2026-10-13 修一个生产级时序缺陷）。
 *
 * ⚠ 为什么必须同步：插件里**工具注册**这段是同步跑的，而它内部会调 storeForPanel() → 闸门。
 *   原来闸门靠异步的 `backup()` 就绪，于是 apply 期间闸门还没开 →
 *   storeForPanel() 返回 null → 注册抛错 → **6 个工具一个都注册不上**。
 *   实测（有库的正常环境）：immediate=0、等 400ms 后仍 afterWait=0。
 *   同步做备份，闸门在 apply 里**当场**就绪，注册恢复正常。
 *
 * 用 **`VACUUM INTO`**：SQLite 原生、**同步**、产出一致快照（含 WAL 里已提交的数据），
 * 且不要求关闭或 checkpoint 源库。它拒绝写入已存在的目标 —— 正好避免静默覆盖。
 */
export function backupBeforeMigrationSync({ dbPath, dir, keep = 7, logFile = null }) {
  if (!existsSync(dbPath)) return { ok: false, reason: '库文件不存在' };
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return { ok: false, reason: '备份目录不可用' }; }
  const file = join(dir, `memory-${stamp()}-pre-migration.db`);
  const tmpFile = `${file}.partial`;
  let src = null;
  try {
    src = new DatabaseSync(dbPath, { readOnly: true });
    if (existsSync(tmpFile)) rmSync(tmpFile, { force: true });
    src.exec(`VACUUM INTO '${tmpFile.replace(/'/g, "''")}'`);
  } catch (error) {
    const reason = String(error?.message ?? error).slice(0, 160);
    logLine(logFile, 'error', `迁移前备份失败：${reason}`);
    try { if (existsSync(tmpFile)) rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
    return { ok: false, reason };
  } finally {
    try { src?.close(); } catch { /* ignore */ }
  }
  const verified = verifyBackupFile(tmpFile);
  if (!verified.ok) {
    logLine(logFile, 'error', `迁移前备份校验失败（已丢弃）：${verified.reason}`);
    try { if (existsSync(tmpFile)) rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
    return { ok: false, reason: verified.reason, verified };
  }
  try { renameSync(tmpFile, file); chmodSync(file, 0o600); } catch (error) {
    return { ok: false, reason: `改名失败：${String(error?.message ?? error).slice(0, 100)}` };
  }
  logLine(logFile, 'info', `迁移前备份成功 ${file.split(/[\\/]/).pop()} · ${Math.round(verified.size / 1024)}KB · ${verified.entries} 条 · schema ${verified.schemaVersion}`);
  pruneBackups(dir, keep, logFile, file);
  return { ok: true, file, verified };
}

/**
 * 迁移前备份。
 *
 * ⚠ 关键：这里**不经过 openMemory()** —— 因为 openMemory() 一打开就会跑迁移，
 *   那就不是"迁移前"了。用裸 DatabaseSync 打开（不执行任何 DDL），再走同一套 backup()。
 */
export async function backupBeforeMigration({ dbPath, dir, keep = 7, logFile = null }) {
  if (!existsSync(dbPath)) return { ok: false, reason: '库文件不存在，无需迁移前备份' };
  let raw;
  try {
    raw = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    logLine(logFile, 'error', `迁移前备份：无法打开库（跳过，不阻塞迁移）：${String(error?.message ?? error).slice(0, 100)}`);
    return { ok: false, reason: '无法打开库' };
  }
  try {
    return await createBackup({ db: raw, dir, tag: PROTECTED_MARK, keep, logFile });
  } finally {
    try { raw.close(); } catch { /* ignore */ }
  }
}

/**
 * 从备份恢复到一个**明确指定的**目标目录（2026-10-13 新增）。
 *
 * ## 为什么是"指定目录"而不是"恢复回生产库"
 *
 * 恢复是**破坏性**操作：它会覆盖目标目录里的 `memory.db`。所以这一版刻意做成
 * **纯函数式的一步**——调用方必须自己给出 `targetDir`，**没有任何默认值指向生产库**，
 * 也**不接入插件启动流程**。要替换生产库，得由人或外部脚本显式调用这一步。
 *
 * ## 安全行为
 *
 *   · 备份文件必须存在且通过 `verifyBackupFile`（integrity_check + 核心表 + FTS 计数）才继续
 *   · **默认拒绝覆盖**已存在的 `<targetDir>/memory.db`；要覆盖必须显式传 `force: true`
 *   · 先复制成 `.restore-partial` → **校验复制出来的那一份** → 通过才 `rename` 成正式文件
 *     （所以任何中途失败都不会留下一个"看起来能用"的半成品）
 *   · **失败只清理自己创建的 `.restore-partial`**，绝不删原始备份、也绝不删既有目标文件
 *   · 全程不持有长效数据库句柄（`verifyBackupFile` 内部 open/close 用 finally 收尾）
 *
 * @returns {{ok:boolean, target?:string, verified?:object, reason?:string}}
 */
export function restoreBackup({ file, targetDir, force = false, logFile = null }) {
  if (!file || typeof file !== 'string') return { ok: false, reason: '必须指定备份文件 file' };
  if (!targetDir || typeof targetDir !== 'string') return { ok: false, reason: '必须指定目标目录 targetDir' };
  if (!existsSync(file)) return { ok: false, reason: `备份文件不存在：${file}` };

  const pre = verifyBackupFile(file);
  if (!pre.ok) return { ok: false, reason: `备份未通过校验，拒绝恢复：${pre.reason}` };

  try { mkdirSync(targetDir, { recursive: true, mode: 0o700 }); } catch (error) {
    return { ok: false, reason: `目标目录不可用：${String(error?.message ?? error).slice(0, 120)}` };
  }

  const target = join(targetDir, 'memory.db');
  if (existsSync(target) && force !== true) {
    return { ok: false, reason: `目标已存在，拒绝覆盖：${target}（确需覆盖请显式传 force:true）` };
  }

  const partial = `${target}.restore-partial`;
  const dropPartial = () => { try { if (existsSync(partial)) rmSync(partial, { force: true }); } catch { /* 清理失败不掩盖原错误 */ } };
  dropPartial();

  try {
    copyFileSync(file, partial);
  } catch (error) {
    dropPartial();
    const reason = String(error?.message ?? error).slice(0, 160);
    logLine(logFile, 'error', `恢复：复制失败 ${reason}`);
    return { ok: false, reason: `复制失败：${reason}` };
  }

  // 校验**复制出来的那一份**（而不是原备份）
  const post = verifyBackupFile(partial);
  if (!post.ok) {
    dropPartial();
    logLine(logFile, 'error', `恢复：结果校验失败（已清理临时产物）${post.reason}`);
    return { ok: false, reason: `恢复结果校验失败（已清理临时产物）：${post.reason}`, verified: post };
  }

  try {
    renameSync(partial, target);
  } catch (error) {
    dropPartial();
    const reason = String(error?.message ?? error).slice(0, 160);
    logLine(logFile, 'error', `恢复：改名失败 ${reason}`);
    return { ok: false, reason: `改名失败：${reason}` };
  }

  logLine(logFile, 'info', `恢复成功 ${targetDir.split(/[\\/]/).pop()}/memory.db · ${post.entries} 条 · FTS ${post.fts} · schema ${post.schemaVersion}`);
  return { ok: true, target, verified: post };
}
