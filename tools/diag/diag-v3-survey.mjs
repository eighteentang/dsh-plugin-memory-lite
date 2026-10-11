// V3 决策用的现状测量：全部在**库的副本**上跑，绝不污染真库
// （search() 会写 hit_count / last_accessed_at，直接量真库会把"用过 N 次"灌水）
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openMemory } from '../../lib/storage.js';
import { renderIndexSection } from '../../lib/prompt.js';
import { INDEX_MAX_BYTES, INDEX_TITLE_CHARS, INJECT_MAX_CHARS, INJECT_MAX_ITEMS } from '../../lib/config.js';

const SRC = 'D:\\EasyDSH\\.dsh-memory';
const TMP = join(tmpdir(), 'memory-lite-v3-survey');

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  const from = join(SRC, `memory.db${suffix}`);
  if (existsSync(from)) copyFileSync(from, join(TMP, `memory.db${suffix}`));
}

const bytes = (n) => `${(n / 1024).toFixed(1)} KB`;
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');

console.log('库副本:', TMP);
console.log('原库体积:', ['', '-wal'].map((s) => {
  const f = join(SRC, `memory.db${s}` + '');
  return existsSync(f) ? `${s || '.db'} ${bytes(statSync(f).size)}` : `${s || '.db'} -`;
}).join(' / '));

const memory = openMemory({ dir: TMP, workspace: 'D:\\EasyDSH' });
const raw = memory._raw;
const all = memory.list({ limit: 9999 });

// ── ① 条目结构 ──────────────────────────────────────────────────────────
const byLevel = {};
const byStatus = {};
let noTitle = 0, noKeywords = 0, sensitive = 0, tiny = 0;
for (const e of all) {
  byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
  byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
  if (!e.title) noTitle += 1;
  if (!e.keywords?.length) noKeywords += 1;
  if (e.sensitive) sensitive += 1;
  if (String(e.content ?? '').length < 60) tiny += 1;
}
console.log('\n===== ① 条目结构 =====');
console.log(`总数 ${all.length} · active ${byStatus.active ?? 0} · stale ${byStatus.stale ?? 0} · archived ${byStatus.archived ?? 0}`);
console.log('按层:', JSON.stringify(byLevel));
console.log(`无标题 ${noTitle} · 无关键词 ${noKeywords} · 敏感 ${sensitive} · 正文<60字 ${tiny}`);
console.log('stats():', JSON.stringify(memory.stats()));

// ── ② 常驻索引段（system prompt 里那一段）的真实占用 ─────────────────────
console.log('\n===== ② 常驻索引段 =====');
const indexText = renderIndexSection({ entries: all, maxBytes: INDEX_MAX_BYTES });
const omitted = Number((indexText.match(/另有 (\d+) 条未列出/) ?? [])[1] ?? 0);
console.log(`预算 ${INDEX_MAX_BYTES} B · 实际 ${Buffer.byteLength(indexText, 'utf8')} B (${pct(Buffer.byteLength(indexText, 'utf8'), INDEX_MAX_BYTES)})`);
console.log(`列出 ${indexText.split('\n').length - 1 - (omitted ? 1 : 0)} 行 · 未列出 ${omitted} 条`);

// ②b 逐行字节构成 + "如果每行都有短标题能装多少"（补标题到底能拿回多少容量）
{
  const lines = indexText.split('\n').slice(1).filter((l) => !l.startsWith('-（另有'));
  const sizes = lines.map((l) => Buffer.byteLength(l, 'utf8'));
  const avg = sizes.reduce((a, b) => a + b, 0) / (sizes.length || 1);
  const titled = all.filter((e) => e.title);
  console.log(`每行平均 ${avg.toFixed(0)} B（最长 ${Math.max(...sizes)}，最短 ${Math.min(...sizes)}）`);
  console.log(`有标题的条目 ${titled.length} 条，标题均长 ${titled.length ? (titled.reduce((a, e) => a + e.title.length, 0) / titled.length).toFixed(1) : 0} 字`);
  const labelCost = Buffer.byteLength('- [项目 · EasyDSH] ', 'utf8');
  for (const n of [12, 20, 28, 48]) {
    const perLine = labelCost + Buffer.byteLength('字'.repeat(n), 'utf8') + 1;
    console.log(`  若标题限 ${n} 字：每行约 ${perLine} B → 4096 B 可列约 ${Math.floor(INDEX_MAX_BYTES / perLine)} 条`);
  }
  console.log(`  当前实际（INDEX_TITLE_CHARS=${INDEX_TITLE_CHARS}）：可列约 ${Math.floor(INDEX_MAX_BYTES / avg)} 条`);
}

// ── ③ 日志层积压 ────────────────────────────────────────────────────────
console.log('\n===== ③ 日志层 =====');
const logTotal = raw.prepare('SELECT COUNT(*) AS n FROM log_entries').get().n;
const backlog = memory.undistilled(9999);
console.log(`日志总数 ${logTotal} · 未蒸馏 ${backlog.length} 条`);
const perSession = raw.prepare("SELECT session_id, COUNT(*) AS n, SUM(CASE WHEN role='user' THEN 1 ELSE 0 END) AS users FROM log_entries GROUP BY session_id").all();
for (const s of perSession) console.log(`  ${s.session_id}: ${s.n} 条（其中 user ${s.users}）`);
const perDay = raw.prepare('SELECT date(created_at/1000, \'unixepoch\', \'localtime\') AS d, COUNT(*) AS n FROM log_entries GROUP BY d ORDER BY d DESC LIMIT 7').all();
console.log('最近 7 天:', perDay.map((r) => `${r.d} ${r.n}条`).join(' · '));

// ── ④ 注入流水与命中率 ──────────────────────────────────────────────────
console.log('\n===== ④ 注入流水 =====');
const inj = memory.recentInjections(null, 1000);
const byForm = {};
for (const r of inj) byForm[r.form] = (byForm[r.form] ?? 0) + 1;
console.log(`注入轮次 ${inj.length}：`, JSON.stringify(byForm));
const maxChars = Math.max(0, ...inj.map((r) => r.chars ?? 0));
const avgItems = inj.length ? inj.reduce((a, r) => a + (JSON.parse(r.entry_ids ?? '[]').length ?? 0), 0) / inj.length : 0;
console.log(`单轮最多 ${maxChars} 字（预算 ${INJECT_MAX_CHARS}，占 ${pct(maxChars, INJECT_MAX_CHARS)}）· 平均 ${avgItems.toFixed(1)} 条（上限 ${INJECT_MAX_ITEMS}）`);

// ── ⑤ 离线复现"召回到底命中多少轮" ──────────────────────────────────────
// 完全照 index.js 的召回路径：query = 最近一条真实用户消息，seen 集合按会话累积
console.log('\n===== ⑤ 离线复现召回（逐会话按时间顺序）=====');
const userMsgs = raw.prepare("SELECT session_id, turn, text, chars, created_at FROM log_entries WHERE role='user' ORDER BY session_id, turn ASC").all();
const seen = new Map();
let rounds = 0, injectRounds = 0, zeroHit = 0, shortSkip = 0;
const missedSamples = [];
for (const m of userMsgs) {
  const q = String(m.text ?? '').trim();
  if (!q || q.length < 4) { shortSkip += 1; continue; }
  rounds += 1;
  const got = memory.search(q, { status: 'active', limit: 12 });
  const set = seen.get(m.session_id) ?? new Set();
  const fresh = got.filter((e) => !e.sensitive && !set.has(e.id)).slice(0, INJECT_MAX_ITEMS);
  if (!got.length) {
    zeroHit += 1;
    if (missedSamples.length < 6) missedSamples.push({ turn: m.turn, head: q.replace(/\s+/g, ' ').slice(0, 70) });
  }
  if (fresh.length) {
    injectRounds += 1;
    for (const e of fresh) set.add(e.id);
    seen.set(m.session_id, set);
  }
}
console.log(`可当 query 的 user 消息 ${rounds} 条（跳过过短 ${shortSkip}）`);
console.log(`检索零命中 ${zeroHit} 轮（${pct(zeroHit, rounds)}）`);
console.log(`会真的注入 ≥1 条 ${injectRounds} 轮（${pct(injectRounds, rounds)}）`);
console.log('零命中样例:');
for (const s of missedSamples) console.log(`  turn=${s.turn} ${s.head}`);

// ── ⑥ 近重复检测（同一件事被记了几遍）───────────────────────────────────
console.log('\n===== ⑥ 近重复 =====');
const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const grams = (s, n = 4) => {
  const t = norm(s);
  const out = new Set();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n));
  return out;
};
const jac = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter += 1;
  return inter / (a.size + b.size - inter);
};
const gs = all.map((e) => grams(e.content));
const pairs = [];
for (let i = 0; i < all.length; i++) {
  for (let j = i + 1; j < all.length; j++) {
    const s = jac(gs[i], gs[j]);
    if (s >= 0.45) pairs.push({ s, a: all[i], b: all[j] });
  }
}
pairs.sort((x, y) => y.s - x.s);
console.log(`相似度 ≥0.45 的条目对: ${pairs.length}（共 ${(all.length * (all.length - 1)) / 2} 对）`);
for (const p of pairs.slice(0, 6)) {
  console.log(`  ${p.s.toFixed(2)} [${p.a.level}] ${(p.a.title ?? p.a.content).slice(0, 40)}`);
  console.log(`       ⇄ [${p.b.level}] ${(p.b.title ?? p.b.content).slice(0, 40)}`);
}
const idDup = raw.prepare('SELECT COUNT(*) AS n FROM (SELECT id FROM entries GROUP BY id HAVING COUNT(*)>1)').get().n;
console.log(`字面重复 id: ${idDup}`);

memory.close();
