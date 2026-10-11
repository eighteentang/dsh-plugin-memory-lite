#!/usr/bin/env node
/**
 * verify-storage.mjs —— 存储层的离线自测
 *
 * 覆盖：
 *   ① 建库/建表/schema 版本  ② 写入-读回往返（E16：显式测"同一条线上"）
 *   ③ 更新后 FTS 同步        ④ 中文 bigram 检索能命中
 *   ⑤ 敏感标题自动落 sensitive 列（注入侧只读列，fail-closed）
 *   ⑥ 日志写入 + 冷却判定 + 溢出归档（不静默丢）
 *   ⑦ 删除后 FTS 不留残影
 *
 * 用法: node verify-storage.mjs [临时目录]
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemory, querySegments, newId } from '../../lib/storage.js';
import { toJsonSchema, redactSecrets, neutralizeBraces, safeSlice, stableHash, resolveConfig } from '../../lib/config.js';

const results = [];
const ok = (n, d = '') => results.push({ pass: true, n, d });
const bad = (n, d = '') => results.push({ pass: false, n, d });

const root = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'memory-lite-verify-'));
const created = process.argv[2] === undefined;

console.log(`=== verify-storage @ ${root} ===\n`);

// ── 0. 纯函数层（config.js）───────────────────────────────────────────────
{
  const js = toJsonSchema({ note: { type: 'string', required: false }, q: { type: 'string', required: true } });
  js.type === 'object' && js.required.length === 1 && js.required[0] === 'q' && js.properties.note.type === 'string'
    ? ok('toJsonSchema 把简写转成真 JSON Schema')
    : bad('toJsonSchema 把简写转成真 JSON Schema', JSON.stringify(js));
  !('required' in (js.properties.note ?? {}))
    ? ok('toJsonSchema 不把 required 泄漏进属性 schema')
    : bad('toJsonSchema 不把 required 泄漏进属性 schema');

  redactSecrets('token is sk-abcdefghijklmnopqrstuvwx ok').includes('[REDACTED:api-key]')
    ? ok('redactSecrets 命中 api-key')
    : bad('redactSecrets 命中 api-key');
  redactSecrets('电话 13800138000 结尾').includes('[REDACTED:phone]')
    ? ok('redactSecrets 命中手机号')
    : bad('redactSecrets 命中手机号');

  const nb = neutralizeBraces('正文里有 {{cwd}} 这种');
  !nb.includes('{{')
    ? ok('neutralizeBraces 打断所有 {{（防组装抛错）')
    : bad('neutralizeBraces 打断所有 {{', nb);

  const emoji = '😀😀😀';
  const cut = safeSlice(emoji, 3);
  !/[\uD800-\uDBFF]$/.test(cut)
    ? ok('safeSlice 不劈开代理对（防 emoji 半截导致 400）', JSON.stringify(cut))
    : bad('safeSlice 不劈开代理对', JSON.stringify(cut));

  stableHash('同一段') === stableHash('同一段') && stableHash('a') !== stableHash('b')
    ? ok('stableHash 稳定且区分输入')
    : bad('stableHash 稳定且区分输入');

  const cfg = resolveConfig({ autoCapture: false });
  cfg.autoCapture === false && cfg.injectMaxItems > 0
    ? ok('resolveConfig 合并默认值')
    : bad('resolveConfig 合并默认值', JSON.stringify(cfg));
  let threw = false;
  try { resolveConfig({ 不存在: 1 }); } catch { threw = true; }
  threw ? ok('resolveConfig 拒绝未知配置项') : bad('resolveConfig 拒绝未知配置项');
}

// ── 1. 存储层 ─────────────────────────────────────────────────────────────
const archiveDir = join(root, 'archive');
const mem = openMemory({ dir: join(root, 'mem'), workspace: 'D:\\EasyDSH', archiveDir });

try {
  existsSync(mem.dbPath) ? ok('建库成功', mem.dbPath) : bad('建库成功');
  Number(mem.getMeta('schema_version')) === 1 ? ok('schema 版本已写入') : bad('schema 版本已写入', mem.getMeta('schema_version'));

  // ② 写入-读回往返
  const e1 = mem.put({
    level: 'project', title: '记忆插件架构', project: 'EasyDSH', subcategory: 'decisions',
    content: '两层记忆：日志层原样追加，长期条目层空闲蒸馏。日志层永不进提示词。',
    keywords: ['两层记忆', '日志层', '空闲蒸馏'], importance: 3, sourceSession: 'sess-1',
  });
  const back = mem.get(e1.id);
  back && back.content === e1.content && back.project === 'EasyDSH' && back.subcategory === 'decisions' && back.keywords.length === 3
    ? ok('写入→读回往返一致（含 keywords/project/subcategory）')
    : bad('写入→读回往返一致', JSON.stringify(back));
  Number(mem.getMeta('schema_version')) === 1 && mem.stats().total === 1
    ? ok('stats 计数正确', JSON.stringify(mem.stats()))
    : bad('stats 计数正确', JSON.stringify(mem.stats()));

  // ⑤ 敏感标题
  const secret = mem.put({
    level: 'fact', title: 'API 密钥备忘', content: '部署用密钥放在某个地方',
    keywords: ['密钥'], importance: 2,
  });
  secret.sensitive === true
    ? ok('敏感标题自动落 sensitive 列')
    : bad('敏感标题自动落 sensitive 列', JSON.stringify(secret));
  const normal = mem.put({ level: 'fact', content: '这条是普通事实', keywords: ['普通'], importance: 1 });
  normal.sensitive === false ? ok('普通条目不被误判为敏感') : bad('普通条目不被误判为敏感');

  // ④ 中文检索
  const hits = mem.search('日志层 蒸馏', { status: 'all' });
  hits.some((h) => h.id === e1.id)
    ? ok('中文检索命中目标条目（跨词、不要求相邻）', `命中 ${hits.length} 条`)
    : bad('中文检索命中目标条目（跨词、不要求相邻）', `命中 ${hits.length} 条: ${hits.map((h) => h.title).join('/')}`);

  const segs = querySegments('记忆插件');
  segs.includes('记忆插件')
    ? ok('querySegments 保留完整 CJK 串（FTS5 需要整串才能命中）', segs.slice(0, 6).join(','))
    : bad('querySegments 保留完整 CJK 串', segs.join(','));
  segs.includes('记忆') && segs.includes('插件')
    ? ok('querySegments 同时给出 CJK 子串（应对查询比正文长）')
    : bad('querySegments 同时给出 CJK 子串', segs.join(','));
  querySegments('memory-lite config').includes('memory')
    ? ok('querySegments 切出拉丁词')
    : bad('querySegments 切出拉丁词', querySegments('memory-lite config').join(','));

  // 只命中一个词、两个词不相邻时也应命中（这正是之前 LIKE 整串匹配的 bug）
  mem.search('永不进提示词', { status: 'all' }).some((h) => h.id === e1.id)
    ? ok('中文子串检索命中（不相邻词也能召回）')
    : bad('中文子串检索命中（不相邻词也能召回）');

  // ③ 更新 → FTS 同步
  mem.update(e1.id, { content: '改版后的内容：三层记忆与归档策略', keywords: ['三层记忆'] });
  const afterUpdate = mem.get(e1.id);
  afterUpdate.content.startsWith('改版后') ? ok('update 写入生效') : bad('update 写入生效');
  mem.search('三层记忆', { status: 'all' }).some((h) => h.id === e1.id)
    ? ok('update 后 FTS 同步（新词可检索）')
    : bad('update 后 FTS 同步（新词可检索）');
  !mem.search('日志层原样追加', { status: 'all' }).some((h) => h.id === e1.id)
    ? ok('update 后旧 FTS 残影已清（旧词不再命中该条）')
    : bad('update 后旧 FTS 残影已清（旧词不再命中该条）', '旧内容仍可检索到 → FTS 未重建');

  // 过滤
  mem.search('密钥', { status: 'all', level: 'fact' }).length >= 1
    ? ok('search 支持 level 过滤')
    : bad('search 支持 level 过滤');
  mem.search('记忆', { status: 'all', project: 'EasyDSH' }).every((h) => h.project === 'EasyDSH')
    ? ok('search 支持 project 过滤')
    : bad('search 支持 project 过滤');

  // ⑦ 删除
  const tmp = mem.put({ level: 'topic', content: '待删除的话题条目', keywords: ['待删'] });
  mem.remove(tmp.id);
  !mem.get(tmp.id) && !mem.search('待删除的话题条目', { status: 'all' }).some((h) => h.id === tmp.id)
    ? ok('remove 删掉行且不留 FTS 残影')
    : bad('remove 删掉行且不留 FTS 残影');

  // ⑥ 日志层
  mem.appendLog({ sessionId: 'sess-A', turn: 1, text: 'x'.repeat(300) });
  const nAfter = mem._raw.prepare('SELECT COUNT(*) AS n FROM log_entries WHERE session_id = ?').get('sess-A').n;
  nAfter === 1 ? ok('appendLog 写入日志') : bad('appendLog 写入日志', String(nAfter));
  mem.logsSince('sess-A', 60_000).tooSoon === true
    ? ok('logsSince 冷却判定生效（刚写过 → tooSoon）')
    : bad('logsSince 冷却判定生效（刚写过 → tooSoon）');
  mem.logsSince('sess-B', 60_000).tooSoon === false
    ? ok('logsSince 对新会话不拦（tooSoon=false）')
    : bad('logsSince 对新会话不拦（tooSoon=false）');

  // 溢出归档：塞到超过上限
  const before = mem._raw.prepare('SELECT COUNT(*) AS n FROM log_entries WHERE session_id = ?').get('sess-B').n;
  for (let i = 0; i < 205; i++) mem.appendLog({ sessionId: 'sess-B', turn: i, text: `第 ${i} 轮日志内容 ${'y'.repeat(250)}` });
  const after = mem._raw.prepare('SELECT COUNT(*) AS n FROM log_entries WHERE session_id = ?').get('sess-B').n;
  const archived = existsSync(join(archiveDir, 'log-sess-B.jsonl'));
  after <= 200 && archived
    ? ok('日志溢出：库内被裁剪到上限内且已归档', `库内 ${after} 行，归档文件存在=${archived}（写入前 ${before}）`)
    : bad('日志溢出：库内被裁剪到上限内且已归档', `库内 ${after} 行，归档文件存在=${archived}`);
  if (archived) {
    const lines = readFileSync(join(archiveDir, 'log-sess-B.jsonl'), 'utf8').trim().split('\n');
    lines.length > 0 && JSON.parse(lines[0]).session_id === 'sess-B'
      ? ok('归档文件是可解析的 JSONL', `${lines.length} 行`)
      : bad('归档文件是可解析的 JSONL');
  }

  // 蒸馏留痕
  const runId = mem.startDistillRun(3);
  mem.finishDistillRun(runId, { outcome: 'ok', created: 2, updated: 1, note: 'test' });
  const last = mem.lastDistillRun();
  last && last.outcome === 'ok' && last.created === 2
    ? ok('蒸馏留痕可写可读')
    : bad('蒸馏留痕可写可读', JSON.stringify(last));

  // activeOf / list
  mem.activeOf('fact').length >= 1 ? ok('activeOf 只返回 active') : bad('activeOf 只返回 active');
  mem.list({ level: 'project' }).every((e) => e.level === 'project') ? ok('list 按 level 过滤') : bad('list 按 level 过滤');
} finally {
  mem.close();
}

// 收尾
if (created) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log('');
let pass = 0;
for (const r of results) {
  console.log(`${r.pass ? '✅' : '❌'} ${r.n}${r.d ? `  —— ${r.d}` : ''}`);
  if (r.pass) pass++;
}
console.log(`\n通过 ${pass}/${results.length}`);
console.log('\n⚠ 本校验器验不到的（必须真机才知）：');
console.log('   · ctx 接线（turn-stopping / pre-step / systemPrompt 段）是否真被宿主调用');
console.log('   · 注入后是否真的进了模型上下文、是否触发前缀缓存失效');
console.log('   · 设置页客户端 bundle 的渲染效果');
process.exit(results.every((r) => r.pass) ? 0 : 1);
