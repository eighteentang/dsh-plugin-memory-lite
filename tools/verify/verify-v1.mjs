#!/usr/bin/env node
/**
 * verify-v1.mjs —— V1 全链路离线校验器
 *
 * 覆盖能离线覆盖的部分：
 *   A. 注入文本：字节稳定（同一输入同一字节）、花括号中和、标签逃逸转义、条数/字数预算
 *   B. 自注入抑制：识别自己的注入、剔除后再取 query、已注入不重复
 *   C. 工具：schema 必须是真 JSON Schema（E18）、六个工具齐全、破坏性工具清单正确
 *   D. 捕获闸门：太短/冷却/重复/配额
 *   E. 接线：用假 ctx 跑 apply()，验证注册/释放成对、pre-step 只追加不改写
 *
 * 用法: node verify-v1.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderIndexSection, renderRecallBlock, renderRecoveryBlock } from '../../lib/prompt.js';
import { createInjectState, createInjectedMessage, isOwnInjection, stripOwnInjections, lastUserText, pickForInjection, SOURCE_KIND } from '../../lib/inject.js';
import { buildTools, DESTRUCTIVE_TOOLS } from '../../lib/tools.js';
import { captureTurn, extractTurnText } from '../../lib/capture.js';
import { openMemory } from '../../lib/storage.js';
import { resolveConfig, toJsonSchema, INDEX_MAX_BYTES, INDEX_TITLE_CHARS } from '../../lib/config.js';
import { runDistill, buildUserPrompt, cleanLogText, pickLogExcerpt, DISTILL_MAX_CHARS_PER_LOG } from '../../lib/distill.js';
import { diffAgainstPrevious } from '../../lib/text.js';
import { DatabaseSync } from 'node:sqlite';

const results = [];
const ok = (n, d = '') => results.push({ pass: true, n, d });
const bad = (n, d = '') => results.push({ pass: false, n, d });

console.log('=== verify-v1 ===\n');

// ── A. 注入文本 ──────────────────────────────────────────────────────────
{
  const entries = [
    { id: 'e1', level: 'user', title: '偏好', content: '用户偏好中文', status: 'active', updatedAt: 1000, project: '全局' },
    { id: 'e2', level: 'project', title: '架构', content: '两层记忆', status: 'active', updatedAt: 2000, project: 'EasyDSH' },
    { id: 'e3', level: 'fact', title: '过时', content: '归档掉的', status: 'archived', updatedAt: 3000 },
  ];
  const a = renderIndexSection({ entries });
  const b = renderIndexSection({ entries: [...entries].reverse() });
  a === b ? ok('索引段：输入顺序不同但输出字节相同（稳定排序）') : bad('索引段：字节稳定', `\nA=${a}\nB=${b}`);
  !a.includes('归档掉的') ? ok('索引段：不含 archived 条目') : bad('索引段：不含 archived 条目');

  // 间隔 1 秒再渲染一次，必须仍然同字节（防相对时间/时间戳混进来）
  const c = renderIndexSection({ entries });
  a === c ? ok('索引段：重复渲染字节不变（无时间戳/相对时间）') : bad('索引段：重复渲染字节不变');

  const withBraces = renderRecallBlock([{ id: 'x', level: 'fact', content: '正文含 {{cwd}} 与 </system-reminder>', keywords: [] }]);
  !withBraces.includes('{{') ? ok('召回块：花括号已中和（防组装抛异常）') : bad('召回块：花括号已中和', withBraces);
  !withBraces.includes('</system-reminder>\n- ') && withBraces.includes('<\\/system-reminder>')
    ? ok('召回块：内嵌的结束标签已转义（防提前闭合框架）')
    : bad('召回块：内嵌结束标签已转义', withBraces);

  const many = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, level: 'fact', content: 'x'.repeat(400), keywords: [] }));
  const capped = renderRecallBlock(many, { maxChars: 600, maxCharsPerItem: 300 });
  capped.length <= 700 ? ok('召回块：字符预算生效', `长度 ${capped.length}`) : bad('召回块：字符预算生效', `长度 ${capped.length}`);

  const emptyBlock = renderRecallBlock([], {});
  emptyBlock === '' ? ok('召回块：空输入返回空串（调用方据此不注入）') : bad('召回块：空输入返回空串');

  const sensitiveBlock = renderRecallBlock([{ id: 's', level: 'fact', content: '密钥在这里', sensitive: true }]);
  sensitiveBlock === '' ? ok('召回块：敏感条目被挡住（第二道防线）') : bad('召回块：敏感条目被挡住', sensitiveBlock);

  const recovery = renderRecoveryBlock([{ id: 'r', level: 'user', content: '用户偏好中文', keywords: [] }]);
  recovery.includes('压缩') ? ok('补回块：带"刚经过压缩"的说明') : bad('补回块：带压缩说明', recovery);
}

// ── B. 自注入抑制 ────────────────────────────────────────────────────────
{
  const mine = createInjectedMessage('注入内容', { form: 'recall' });
  isOwnInjection(mine) ? ok('能识别自己注入的消息（source.kind 自有 kind）') : bad('能识别自己注入的消息');
  mine.source.kind === SOURCE_KIND && mine.role === 'user' && Array.isArray(mine.content) && mine.id
    ? ok('注入消息形态完整（id/role/content/source）')
    : bad('注入消息形态完整', JSON.stringify(mine));

  const messages = [
    { role: 'user', content: [{ type: 'text', text: '真实问题' }], source: { kind: 'user' } },
    createInjectedMessage('上一轮注入的内容', {}),
    { role: 'assistant', content: [{ type: 'text', text: '回答' }], source: { kind: 'model' } },
  ];
  const stripped = stripOwnInjections(messages);
  stripped.length === 2 ? ok('剔除自己的注入后只剩真实消息') : bad('剔除自己的注入后只剩真实消息', String(stripped.length));
  lastUserText(messages) === '真实问题' ? ok('lastUserText 跳过自己注入的消息（防自激）') : bad('lastUserText 跳过自己注入的消息', lastUserText(messages));
  lastUserText([{ role: 'user', content: [{ type: 'text', text: '<system-reminder>环境快照' }], source: { kind: 'user' } }]) === ''
    ? ok('lastUserText 忽略 system-reminder 开头的注入（不算用户说的话）')
    : bad('lastUserText 忽略 system-reminder 开头的注入');

  const state = createInjectState();
  state.mark('s1', ['a', 'b']);
  const picked1 = pickForInjection([{ id: 'a' }, { id: 'c' }], { sessionId: 's1', seen: state.seen('s1'), maxItems: 5 });
  picked1.length === 1 && picked1[0].id === 'c' ? ok('已注入过的不再注入') : bad('已注入过的不再注入', JSON.stringify(picked1));
  state.reset('s1');
  const picked2 = pickForInjection([{ id: 'a' }], { sessionId: 's1', seen: state.seen('s1'), maxItems: 5 });
  picked2.length === 1 ? ok('reset 后可以重新注入（压缩后用）') : bad('reset 后可以重新注入');

  const sensitivePick = pickForInjection([{ id: 'x', sensitive: true }, { id: 'y' }], { sessionId: 's2', seen: new Set(), maxItems: 5 });
  sensitivePick.length === 1 && sensitivePick[0].id === 'y' ? ok('挑注入时跳过敏感条目') : bad('挑注入时跳过敏感条目', JSON.stringify(sensitivePick));
}

// ── C. 工具 schema ───────────────────────────────────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'memv1-'));
  const memory = openMemory({ dir: join(root, 'mem') });
  const config = resolveConfig({});
  const tools = buildTools({ memory, config });

  const names = tools.map((t) => t.name).sort();
  const expect = ['memory_forget', 'memory_note', 'memory_read', 'memory_search', 'memory_stats', 'memory_update'];
  JSON.stringify(names) === JSON.stringify(expect)
    ? ok('六个工具齐全', names.join(','))
    : bad('六个工具齐全', names.join(','));

  let allGood = true;
  const offenders = [];
  for (const tool of tools) {
    const p = tool.parameters;
    const isObjectSchema = p?.type === 'object' && p.properties && Array.isArray(p.required) && p.additionalProperties === false;
    if (!isObjectSchema) {
      allGood = false;
      offenders.push(`${tool.name}: ${JSON.stringify(p)}`);
    }
    // required 里的名字必须都在 properties 里（否则 registry 侧会拒）
    const missing = (p?.required ?? []).filter((k) => !(k in (p?.properties ?? {})));
    if (missing.length) {
      allGood = false;
      offenders.push(`${tool.name}: required 引用了不存在的属性 ${missing.join(',')}`);
    }
  }
  allGood ? ok('所有工具的 parameters 都是合法真 JSON Schema（E18）') : bad('所有工具的 parameters 都是合法真 JSON Schema', offenders.join(' | '));

  tools.every((t) => typeof t.output?.schema === 'object' && typeof t.output?.render === 'function')
    ? ok('所有工具都声明了 output.schema + render')
    : bad('所有工具都声明了 output.schema + render');

  DESTRUCTIVE_TOOLS.has('memory_forget') && DESTRUCTIVE_TOOLS.size === 1
    ? ok('破坏性工具清单正确（只有 memory_forget）')
    : bad('破坏性工具清单正确', [...DESTRUCTIVE_TOOLS].join(','));

  // 真调一遍工具（用假 exec）
  const exec = { agent: { session: { id: 'sess-tool', header: { cwd: root } } } };
  const note = tools.find((t) => t.name === 'memory_note');
  const w = await note.execute({ content: '用户偏好中文回复', project: '全局', keywords: ['中文', '偏好'], importance: 3, level: 'user' }, exec);
  w.includes('已写入') ? ok('memory_note 能写入', w.split('\n')[0]) : bad('memory_note 能写入', w);
  const missKw = await note.execute({ content: 'x', project: '全局', importance: 1 }, exec);
  missKw.includes('keywords 必填') ? ok('memory_note 缺 keywords 时拒绝并提示') : bad('memory_note 缺 keywords 时拒绝', missKw);
  const projNoName = await note.execute({ content: 'x', keywords: ['k'], importance: 1, level: 'project' }, exec);
  projNoName.includes('必须给出 project') ? ok('level=project 无 project 时拒绝') : bad('level=project 无 project 时拒绝', projNoName);

  const search = tools.find((t) => t.name === 'memory_search');
  const s1 = await search.execute({ query: '中文 偏好' }, exec);
  s1.includes('检索到') && !s1.includes('用户偏好中文回复') ? ok('memory_search 返回元数据视图而不夹带全文') : bad('memory_search 返回元数据视图', s1.slice(0, 160));
  const sEmpty = await search.execute({}, exec);
  sEmpty.includes('query 不能为空') ? ok('memory_search 空 query 时拒绝') : bad('memory_search 空 query 时拒绝', sEmpty);

  const stats = tools.find((t) => t.name === 'memory_stats');
  const st = await stats.execute({}, exec);
  st.includes('active 条目') ? ok('memory_stats 可用') : bad('memory_stats 可用', st);

  memory.close();
  rmSync(root, { recursive: true, force: true });
}

// ── D. 捕获闸门 ──────────────────────────────────────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'memcap-'));
  const memory = openMemory({ dir: join(root, 'mem') });

  const short = captureTurn({ memory, sessionId: 'a', workspace: root, text: '太短' });
  short.reason === 'too-short' ? ok('捕获闸门：太短不记') : bad('捕获闸门：太短不记', JSON.stringify(short));

  const long = 'x'.repeat(300);
  const first = captureTurn({ memory, sessionId: 'a', workspace: root, text: long });
  first.written === true ? ok('捕获闸门：够长则写入') : bad('捕获闸门：够长则写入', JSON.stringify(first));

  const second = captureTurn({ memory, sessionId: 'a', workspace: root, text: 'y'.repeat(300) });
  second.reason === 'cooldown' ? ok('捕获闸门：冷却期内不再写（换内容也拦）') : bad('捕获闸门：冷却期内不再写', JSON.stringify(second));

  // 造出"冷却已过、内容与上一条相同"的情形 → 必须走 duplicate 分支。
  // 为什么需要这一步：冷却在前时 duplicate 分支在真实时序里几乎不可达，
  // 不去刻意构造就等于"这条断言从未真正检验过"（E42 那类假绿）。
  const backdate = (ts) => memory._raw.prepare('UPDATE log_entries SET created_at = ? WHERE session_id = ?').run(ts, 'a');
  backdate(Date.now() - 10 * 60 * 1000);
  const dup = captureTurn({ memory, sessionId: 'a', workspace: root, text: long });
  dup.reason === 'duplicate' ? ok('捕获闸门：冷却过后，与上一条完全相同则不重复记') : bad('捕获闸门：冷却过后，与上一条完全相同则不重复记', JSON.stringify(dup));

  backdate(Date.now() - 10 * 60 * 1000);
  const fresh = captureTurn({ memory, sessionId: 'a', workspace: root, text: 'z'.repeat(300) });
  fresh.written === true ? ok('捕获闸门：冷却过后、内容不同则正常写入') : bad('捕获闸门：冷却过后、内容不同则正常写入', JSON.stringify(fresh));

  const off = captureTurn({ memory, sessionId: 'b', workspace: root, text: long, enabled: false });
  off.reason === 'disabled' ? ok('捕获闸门：可整体关闭') : bad('捕获闸门：可整体关闭');

  // extractTurnText 水位
  const events = [
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '第一轮问题' }] } },
    { seq: 2, type: 'assistant/message', data: { content: [{ type: 'text', text: '第一轮回答' }] } },
    { seq: 3, type: 'turn/start', data: {} },
  ];
  const session = { snapshotEvents: () => events };
  const all = extractTurnText(session, -1);
  all.count === 2 && all.untilSeq === 3 && all.text.includes('第一轮问答'.slice(0, 0) + '第一轮问题')
    ? ok('extractTurnText：抽取正文并推进水位', `count=${all.count} until=${all.untilSeq}`)
    : bad('extractTurnText：抽取正文并推进水位', JSON.stringify(all));
  const none = extractTurnText(session, 3);
  none.count === 0 ? ok('extractTurnText：水位之后无新事件则不重复抽') : bad('extractTurnText：水位之后无新事件', JSON.stringify(none));
  const gated = extractTurnText(session, 99); // 水位比所有 seq 都大（模拟"压缩后编号重启"）
  gated.count === 0 && gated.maxSeqAll === 3
    ? ok('extractTurnText：maxSeqAll 不受水位影响（重启守卫的依据）', `maxSeqAll=${gated.maxSeqAll}`)
    : bad('extractTurnText：maxSeqAll', JSON.stringify(gated));

  // 水位持久化（插件重启后内存水位归零，靠这一份兜底）
  memory.setMeta('watermark:s9', '42');
  memory.getMeta('watermark:s9') === '42'
    ? ok('水位可持久化到 meta（重启后不丢）')
    : bad('水位持久化', String(memory.getMeta('watermark:s9')));

  // ── 采集清洗：日志层不再存系统样板 ──────────────────────────────────────
  const boiler = '<system-reminder>\n（用户全局 AGENTS.md 那一大段样板）\n</system-reminder>\n';
  const mixed = captureTurn({ memory, sessionId: 'c', workspace: root, text: `${boiler}${'a'.repeat(260)}` });
  const storedC = memory._raw.prepare("SELECT text, chars FROM log_entries WHERE session_id = 'c' ORDER BY id DESC LIMIT 1").get();
  mixed.written === true && storedC && !String(storedC.text).includes('system-reminder')
    ? ok('采集清洗：样板不落库，只存真实内容', `${storedC.chars} 字`)
    : bad('采集清洗：样板不落库', JSON.stringify({ r: mixed, t: String(storedC?.text ?? '').slice(0, 60) }));

  const pureBoiler = captureTurn({ memory, sessionId: 'd', workspace: root, text: boiler.repeat(3) });
  pureBoiler.reason === 'too-short'
    ? ok('采集清洗：整轮都是样板 → 不落库（短闸门量的是真实内容）')
    : bad('采集清洗：整轮都是样板', JSON.stringify(pureBoiler));

  // ── 去重复前缀：根治"累积式落库"（实测 6/9 对相邻日志是包含关系）────────
  const backdateSession = (sid) =>
    memory._raw.prepare('UPDATE log_entries SET created_at = ? WHERE session_id = ?').run(Date.now() - 10 * 60 * 1000, sid);

  const base = `第一段的真实内容。${'甲'.repeat(300)}`;
  captureTurn({ memory, sessionId: 'e', workspace: root, text: base });
  backdateSession('e');
  const cum = captureTurn({ memory, sessionId: 'e', workspace: root, text: `${base}\n${'乙'.repeat(250)}` });
  const storedE = memory._raw.prepare("SELECT text FROM log_entries WHERE session_id = 'e' ORDER BY id DESC LIMIT 1").get();
  cum.written === true && cum.dedup === 'contains-prev' && String(storedE?.text ?? '') === '乙'.repeat(250)
    ? ok('去重复前缀：累积文本只存增量', `丢掉 ${cum.dropped} 字，存 ${cum.chars} 字`)
    : bad('去重复前缀：累积文本只存增量', JSON.stringify({ r: cum, t: String(storedE?.text ?? '').slice(0, 40) }));

  backdateSession('e');
  const unrelated = captureTurn({ memory, sessionId: 'e', workspace: root, text: `完全无关的另一段。${'丙'.repeat(250)}` });
  const storedE2 = memory._raw.prepare("SELECT text FROM log_entries WHERE session_id = 'e' ORDER BY id DESC LIMIT 1").get();
  unrelated.written === true && unrelated.dedup === 'unrelated' && String(storedE2?.text ?? '').startsWith('完全无关的另一段。')
    ? ok('去重复前缀：无关内容原样存（不误伤）')
    : bad('去重复前缀：无关内容原样存', JSON.stringify({ r: unrelated }));

  // 纯函数边界：上一条太短时不比对（否则一个"好"字就能把正文切掉）
  const cur = `新的一轮内容。${'丁'.repeat(250)}`;
  diffAgainstPrevious(cur, '').reason === 'no-prev' && diffAgainstPrevious(cur, '好').reason === 'no-prev'
    ? ok('去重复前缀：没有上一条 / 上一条太短 → 不比对')
    : bad('去重复前缀：no-prev 分支', JSON.stringify(diffAgainstPrevious(cur, '好')));
  diffAgainstPrevious(cur, cur).reason === 'identical' && diffAgainstPrevious(cur, cur).text === ''
    ? ok('去重复前缀：与上一条完全相同 → 空（走 duplicate 分支）')
    : bad('去重复前缀：identical', JSON.stringify(diffAgainstPrevious(cur, cur)));

  memory.close();
  rmSync(root, { recursive: true, force: true });
}

// ── D2. 蒸馏端到端（假 LLM）──────────────────────────────────────────────
// 为什么必须有这一段：`lib/distill.js` 是我从没跑过的代码路径，结果第一次真机点
// 「立即整理」就报 `Cannot access 'known' before initialization`
// （TDZ：在变量自己的初始化表达式里引用了它）。只做语法检查、只跑 import，
// **永远抓不到这种错** —— 必须用假 LLM 把整条链路真跑一遍。
{
  const root = mkdtempSync(join(tmpdir(), 'memdistill-'));
  const memory = openMemory({ dir: join(root, 'mem') });
  const config = resolveConfig({ autoDistill: true });

  memory.appendLog({ sessionId: 's-d', turn: 1, text: `用户说：这个项目用两层记忆架构。${'x'.repeat(220)}` });
  memory.appendLog({ sessionId: 's-d', turn: 2, text: `又补充：日志层永不进提示词。${'y'.repeat(220)}` });

  // ⚠ 必须先放一条已有条目：TDZ 那个 bug **只在「已有记忆标题非空」时触发**，
  //   空库第一次整理反而正常 —— 不构造这个前提就等于没测到。
  memory.put({ level: 'fact', content: '已有的一条事实', keywords: ['已有'], importance: 1, project: '全局' });

  // 提示词构造（TDZ 的确切位置）
  try {
    const withTitles = buildUserPrompt([{ text: 'abc', created_at: Date.now() }], ['已有标题A', '已有标题B']);
    withTitles.includes('已有标题A') ? ok('buildUserPrompt 处理非空标题列表（TDZ 回归点）') : bad('buildUserPrompt 处理非空标题列表', withTitles.slice(0, 120));
    const withoutTitles = buildUserPrompt([{ text: 'abc', created_at: Date.now() }], []);
    withoutTitles.includes('abc') ? ok('buildUserPrompt 处理空标题列表') : bad('buildUserPrompt 处理空标题列表');
  } catch (error) {
    bad('buildUserPrompt 构造提示词不抛错', String(error?.message ?? error));
  }

  // 假 LLM：**按官方签名实现** —— `stream(options)` 返回**异步可迭代**（不是 Promise），
  // 分片类型含 `text-delta` / `finish`。同时记录收到的 options 以便断言参数形状。
  // 这样校验器模拟的就是真契约；之前我模拟成 `{system, prompt}` + 普通对象返回，
  // 于是"参数名错、消费方式错"这两个真机故障在校验器里完全看不出来。
  let capturedOptions = null;
  const jsonPayload = JSON.stringify({
    items: [
      { level: 'fact', content: '项目采用两层记忆架构', keywords: ['两层记忆', '架构'], importance: 3, project: 'EasyDSH' },
      { level: 'lesson', content: '日志层不能进提示词，否则前缀缓存失效', keywords: ['日志层', '前缀缓存'], importance: 3, project: 'EasyDSH' },
    ],
  });
  const fakeLlm = {
    // ⚠ 必须同时实现 listProviders / listModels：真机上 `provider` **不能省**
    //   （省略会 `NO_ADAPTER: provider "undefined"`）。假 LLM 只实现 stream 的话，
    //   模拟的不是真实契约，也测不到"候选解析"那一步。
    listProviders: () => ['fake-route'],
    listModels: async () => [{ id: 'fake-model', name: 'Fake' }],
    stream(options) {
      capturedOptions = options;
      const pieces = jsonPayload.match(/[\s\S]{1,40}/g) ?? [];
      const chunks = [
        { type: 'block-start' },
        { type: 'text-delta', text: '这是整理结果：\n```json\n' },
        ...pieces.map((piece) => ({ type: 'text-delta', text: piece })),
        { type: 'text-delta', text: '\n```' },
        { type: 'usage', inputTokens: 100, outputTokens: 50 },
        { type: 'finish', reason: 'stop' },
      ];
      return (async function* generate() {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };

  let result;
  try {
    result = await runDistill({ memory, config, llm: fakeLlm, force: true });
  } catch (error) {
    bad('runDistill 端到端不抛错', String(error?.message ?? error));
  }
  if (result) {
    result.ok ? ok('runDistill 端到端跑通', `created=${result.created} updated=${result.updated}`) : bad('runDistill 端到端跑通', JSON.stringify(result));
    if (result.ok) {
      (result.created ?? 0) >= 1 ? ok('蒸馏真的落库了新条目') : bad('蒸馏真的落库了新条目', JSON.stringify(result));
      memory.search('两层记忆架构', { status: 'active' }).length
        ? ok('蒸馏出的条目可被检索到')
        : bad('蒸馏出的条目可被检索到');
      memory.undistilled(10).length === 0 ? ok('已蒸馏的日志被标记（不会重复蒸馏）') : bad('已蒸馏的日志被标记');
      memory.lastDistillRun()?.outcome === 'ok' ? ok('蒸馏留痕记为 ok') : bad('蒸馏留痕记为 ok', JSON.stringify(memory.lastDistillRun()));
      // 参数形状断言：必须是官方签名 `{ messages: [...] }`，
      // **不能**是我早期猜的 `{ system, prompt }`（真机因此拿到 0 字符）。
      capturedOptions ? ok('假 stream 收到了 options') : bad('假 stream 收到了 options');
      Array.isArray(capturedOptions?.messages)
        ? ok('调用参数含 messages 数组（官方签名）', `${capturedOptions.messages.length} 条消息`)
        : bad('调用参数含 messages 数组', JSON.stringify(Object.keys(capturedOptions ?? {})));
      !('prompt' in (capturedOptions ?? {})) && !('system' in (capturedOptions ?? {}))
        ? ok('没有传错的 system/prompt 字段（那两个不是 stream 的参数）')
        : bad('没有传错的 system/prompt 字段', JSON.stringify(Object.keys(capturedOptions ?? {})));
      const msgShapeOk = (capturedOptions?.messages ?? []).every((m) => m?.role && Array.isArray(m.content) && m.content.every((b) => b?.type === 'text' && typeof b.text === 'string'));
      msgShapeOk ? ok('messages 元素形状正确（role + content[text]）') : bad('messages 元素形状正确', JSON.stringify(capturedOptions?.messages)?.slice(0, 160));

      // 输入预算：真机第一次送进去 14.7 万字，模型回了空数组。
      const promptLen = JSON.stringify(capturedOptions?.messages ?? []).length;
      promptLen <= 20000 + 6000
        ? ok('送入模型的内容受预算限制（≤20k+余量）', `${promptLen} 字`)
        : bad('送入模型的内容受预算限制', `${promptLen} 字（预算 20000）`);
      memory.lastDistillRun()?.raw_preview
        ? ok('原始输出已留证（raw_preview）', `${String(memory.lastDistillRun().raw_preview).length} 字`)
        : bad('原始输出已留证（raw_preview）');
    }
  }

  // 负面路径：流里带 error / 空内容必须判失败，不能记成 outcome=ok
  {
    const root2 = mkdtempSync(join(tmpdir(), 'memstream-'));
    const mem2 = openMemory({ dir: join(root2, 'mem') });
    mem2.appendLog({ sessionId: 's-e', turn: 1, text: `随便什么内容。${'z'.repeat(220)}` });
    const errLlm = {
      stream() {
        return (async function* generate() {
          yield { type: 'text-delta', text: 'partial' };
          yield { type: 'error', error: { message: 'provider exploded' } };
        })();
      },
    };
    const r1 = await runDistill({ memory: mem2, config: resolveConfig({ autoDistill: true }), llm: errLlm, force: true });
    r1?.ok === false ? ok('流里报错 → 判失败（不记成 ok）', String(r1.message ?? r1.reason).slice(0, 60)) : bad('流里报错 → 判失败', JSON.stringify(r1));

    const emptyLlm = {
      stream() {
        return (async function* generate() {
          yield { type: 'block-start' };
          yield { type: 'finish', reason: 'stop' };
        })();
      },
    };
    const r2 = await runDistill({ memory: mem2, config: resolveConfig({ autoDistill: true }), llm: emptyLlm, force: true });
    r2?.ok === false ? ok('模型返回空内容 → 判失败（不再静默记成 ok）', String(r2.message ?? '').slice(0, 40)) : bad('模型返回空内容 → 判失败', JSON.stringify(r2));

    mem2.close();
    rmSync(root2, { recursive: true, force: true });
  }

  const noLlm = await runDistill({ memory, config, llm: null, force: true });
  noLlm?.reason === 'llm-unavailable' ? ok('无 llm 时返回 llm-unavailable（不抛错）') : bad('无 llm 时返回 llm-unavailable', JSON.stringify(noLlm));

  memory.close();
  rmSync(root, { recursive: true, force: true });
}

// ── D3. 蒸馏输入清洗（V3-1）──────────────────────────────────────────────
// 真机病根（2026-10-11 实测）：日志一条 = 一整轮，里面夹着宿主注入的
// <system-reminder>（AGENTS.md 样板等）。原本只取前 1500 字 → 10 条日志里
// **7 条的"前 1500 字"逐字相同**，模型拿到的是同一段样板而不是这一轮发生了什么。
{
  const mixed = [
    '<system-reminder>',
    '（用户全局 AGENTS.md 那一大段样板）',
    '</system-reminder>',
    'Runtime context.',
    'Current DSH file policy: danger-full-access',
    '',
    '用户说：把那个坑记下来',
    'Elapsed since the preceding step context: 3m',
    'Browser time zone for this request: Asia/Shanghai',
  ].join('\n');
  const cleaned = cleanLogText(mixed);
  !cleaned.includes('system-reminder') ? ok('清洗：剔掉 <system-reminder> 整块') : bad('清洗：剔掉 <system-reminder> 整块', cleaned.slice(0, 80));
  cleaned.includes('用户说：把那个坑记下来') ? ok('清洗：保留真实内容') : bad('清洗：保留真实内容', cleaned);
  !/Runtime context\.|Elapsed since|Browser time zone|file policy/.test(cleaned)
    ? ok('清洗：剔掉运行时样板行')
    : bad('清洗：剔掉运行时样板行', cleaned.slice(0, 120));

  const unclosed = cleanLogText('正文A\n<system-reminder>\n这段永远闭合不了\n');
  unclosed === '正文A' ? ok('清洗：未闭合的 <system-reminder> 也剔掉') : bad('清洗：未闭合的块', JSON.stringify(unclosed));

  // 病根回归：样板相同、只有结尾不同的两条，清洗后**必须不再相同**
  const boiler = '<system-reminder>\n（同一段样板）\n</system-reminder>\n';
  const a = cleanLogText(`${boiler}结尾甲：把 E49 记进经验库`);
  const b = cleanLogText(`${boiler}结尾乙：把 E50 记进经验库`);
  a !== b && a.includes('结尾甲') && b.includes('结尾乙')
    ? ok('清洗：样板相同、结尾不同 → 结果不再相同（病根回归）')
    : bad('清洗：样板相同、结尾不同', `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

  const onlyNoise = cleanLogText('<system-reminder>\n整条都是样板\n</system-reminder>');
  onlyNoise === '' ? ok('清洗：整条都是样板时返回空串') : bad('清洗：整条都是样板', JSON.stringify(onlyNoise));

  const long = `${'甲'.repeat(3000)}中段标记${'乙'.repeat(3000)}尾部结论`;
  const ex = pickLogExcerpt(long, 1500);
  ex.startsWith('甲') && ex.endsWith('尾部结论') && ex.includes('中略')
    ? ok('取样：头尾都留、中间有中略标记（结论在尾部，不能被切掉）', `${ex.length} 字`)
    : bad('取样：头尾都留', `${ex.slice(0, 30)}…${ex.slice(-30)}`);
  ex.length <= 1500 ? ok('取样：含中略标记后仍不超预算', `${ex.length} ≤ 1500`) : bad('取样：超预算', String(ex.length));
  pickLogExcerpt('很短的一条', 1500) === '很短的一条' ? ok('取样：未超长时原样返回') : bad('取样：未超长时原样返回');
  DISTILL_MAX_CHARS_PER_LOG === 1500 ? ok('取样：默认上限已导出', String(DISTILL_MAX_CHARS_PER_LOG)) : bad('取样：默认上限');
}

// ── E. 接线（假 ctx 跑 apply）────────────────────────────────────────────
// ⚠ 2026-10-11 修：原来 `handlers` 是 Map<事件, 单个处理函数> —— 而 apply 对
//   `agent/pre-step` 注册了**两个**处理函数（召回、压缩后补回），后一个把前一个**覆盖**了。
//   于是"pre-step 只追加不改写"这条断言实际上一直在测**补回**那个分支，**召回从未被测到**
//   （而召回才是每轮都跑的那条）。同一形状的假绿在本项目出现过多次（E13/E42）。
//   现在改成 Map<事件, 处理函数数组>，并**按瀑布语义串起来跑**。
{
  const root = mkdtempSync(join(tmpdir(), 'memwire-'));
  const registered = [];
  const disposed = [];
  const effectCleanups = [];
  const handlers = new Map();
  // V3.1：假 ctx 也要提供 `inject`，否则 `ctx.inject(['webServer'], …)` 抛错、
  // 整块 HTTP 路由注册不上 —— 那样"面板新增/编辑"就完全测不到了。
  const routes = [];
  const fakeWebServer = {
    register(def) {
      routes.push(def);
      return () => disposed.push(`route:${def.path}`);
    },
  };
  const services = { webServer: fakeWebServer };

  const fakeCtx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: {
      register(tool) {
        registered.push(tool);
        return () => disposed.push(`tool:${tool.name}`);
      },
    },
    systemPrompt: {
      getSectionOrder: () => 4000,
      section(def) {
        registered.push({ __section: true, name: def.name, order: def.order, interpolate: def.interpolate, text: def.text });
        return () => disposed.push(`section:${def.name}`);
      },
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => disposed.push(`on:${event}`);
    },
    get: () => undefined,
    inject(names, cb) {
      // 近似实现：把声明的服务交给回调（真实实现里未声明的服务会在取属性时抛）
      const scoped = { get: (n) => (names.includes(n) ? services[n] : undefined) };
      return cb ? cb(scoped) : scoped;
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') effectCleanups.push(cleanup);
      return cleanup;
    },
  };

  // ⚠ 隔离 DSH_HOME：apply() 会打开面板回退库、并往注册表
  //   `$DSH_HOME/memory-lite/workspaces.json` 里登记工作区库。不隔离的话，
  //   每跑一次校验器就往**真实注册表**里塞一条指向临时目录的记录
  //   （实测污染过：留下 `Temp\memwire-XXXX\.dsh-memory-test` 这种已删除的路径）。
  //   index.js 在模块顶层读 DSH_HOME，所以必须在**动态 import 之前**设置。
  const prevDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, '.dsh-home');

  const mod = await import(pathToFileURL(join(process.cwd(), 'index.js')).href + `?t=${Date.now()}`);
  typeof mod.apply === 'function' ? ok('index.js 导出 apply') : bad('index.js 导出 apply');
  Array.isArray(mod.inject) ? ok('导出 inject', mod.inject.join(',')) : bad('导出 inject');

  await mod.apply(fakeCtx, { dirName: '.dsh-memory-test', autoCapture: true, autoRecall: true });

  const toolNames = registered.filter((r) => !r.__section).map((r) => r.name);
  toolNames.length === 6 ? ok('apply 注册了 6 个工具', toolNames.join(',')) : bad('apply 注册了 6 个工具', toolNames.join(','));
  const section = registered.find((r) => r.__section);
  section ? ok('apply 注册了索引段', `order=${section.order} interpolate=${section.interpolate}`) : bad('apply 注册了索引段');
  section?.interpolate === false ? ok('索引段声明了 interpolate:false') : bad('索引段声明了 interpolate:false');
  typeof section?.text === 'function' ? ok('索引段文本按 assembly 求值（可按工作区变化）') : bad('索引段文本按 assembly 求值');

  for (const evt of ['tools/pre-execute', 'agent/turn-stopping', 'agent/pre-step', 'session/event']) {
    (handlers.get(evt)?.length ?? 0) > 0
      ? ok(`接线：注册了 ${evt}`, `${handlers.get(evt).length} 个处理函数`)
      : bad(`接线：注册了 ${evt}`);
  }

  // ── V3.1：面板写入路由（/save）────────────────────────────────────────
  // 为什么值得这么测：#save 是"面板能自己敲记忆"的唯一入口，而它的校验必须和
  // 对话里的 memory_note 用同一套（normalizeEntryInput）—— 否则会出现
  // "对话里写不进去的、面板里能写进去"。这里把真实 handler 抓出来直接调。
  {
    const saveRoute = routes.find((r) => String(r.path).endsWith('/save'));
    saveRoute
      ? ok('接线：注册了 /save 路由', `共 ${routes.length} 条路由`)
      : bad('接线：注册了 /save 路由', routes.map((r) => r.path).join(', '));

    const call = async (body) => {
      let payload = null;
      const res = { writeHead: () => {}, end: (s) => { try { payload = JSON.parse(s); } catch { payload = null; } } };
      await saveRoute.handler({ url: '/dsh-memory-lite/api/save', body }, res);
      return payload;
    };
    const dir = join(root, '.dsh-memory-test');

    const created = await call({ dir, level: 'fact', content: '面板新增的测试条目，走 /save 路由', keywords: '面板,新增', importance: 3 });
    created?.ok === true && created.created === true
      ? ok('面板保存：新增成功', `id=${created.entry?.id}`)
      : bad('面板保存：新增成功', JSON.stringify(created));

    const empty = await call({ dir, content: '   ' });
    empty?.ok === false ? ok('面板保存：空内容被拒', String(empty.error)) : bad('面板保存：空内容被拒', JSON.stringify(empty));

    const badLevel = await call({ dir, level: '不存在的层级', content: '层级写错时的兜底', importance: 99 });
    badLevel?.entry?.level === 'fact'
      ? ok('面板保存：非法层级退到 fact（不炸）', badLevel.entry.level)
      : bad('面板保存：非法层级兜底', JSON.stringify(badLevel));

    const projMissing = await call({ dir, level: 'project', content: '项目层级但没写项目名' });
    projMissing?.ok === false ? ok('面板保存：project 缺项目名被拒', String(projMissing.error)) : bad('面板保存：project 缺项目名被拒', JSON.stringify(projMissing));

    const mm = openMemory({ dir });
    const readBack = mm.get(badLevel?.entry?.id);
    readBack?.importance === 4 ? ok('面板保存：越界重要性被夹到 4') : bad('面板保存：重要性夹取', String(readBack?.importance));

    const upd = await call({ dir, id: created.entry.id, level: 'fact', content: '面板更新后的内容：关键词换成 蓝鲸', keywords: '蓝鲸', title: '面板写入测试', importance: 2 });
    upd?.ok === true && upd.created === false ? ok('面板保存：编辑走更新分支') : bad('面板保存：编辑走更新分支', JSON.stringify(upd));

    const hitNew = mm.search('蓝鲸', { status: 'active' });
    const hitOld = mm.search('新增', { status: 'active' });
    hitNew.some((e) => e.id === created.entry.id)
      ? ok('面板保存：改完 FTS 已同步（新关键词能搜到）')
      : bad('面板保存：改完 FTS 已同步', `命中 ${hitNew.length} 条`);
    !hitOld.some((e) => e.id === created.entry.id)
      ? ok('面板保存：旧关键词不再命中（FTS 无残影）')
      : bad('面板保存：旧关键词残留', `命中 ${hitOld.length} 条`);

    mm.close();
  }

  {
    const seeded = openMemory({ dir: join(root, '.dsh-memory-test'), workspace: root });
    seeded.put({
      level: 'fact',
      content: '记忆插件采用两层架构：日志层只落盘、长期条目层才注入',
      keywords: ['记忆插件', '两层架构', '注入'],
      importance: 3,
    });
    seeded.close();
  }

  // 按真实瀑布语义串起同一事件的多个处理函数：handler(payload, next)
  const runPreStep = (payload, base) => {
    const list = handlers.get('agent/pre-step') ?? [];
    const step = (i, d) => {
      const h = list[i];
      if (typeof h !== 'function') return Promise.resolve(d);
      return h(payload, () => step(i + 1, d));
    };
    return step(0, base);
  };

  const preStepCall = () => {
    const claimed = [{ role: 'user', content: [{ type: 'text', text: '问一个关于记忆插件架构的问题' }], source: { kind: 'user' } }];
    const baseDecision = { kind: 'enter', messages: [...claimed] };
    const payload = { agent: { session: { id: 'w1', header: { cwd: root } } }, messages: claimed, step: 1, turn: 7 };
    return { claimed, baseDecision, payload };
  };

  if ((handlers.get('agent/pre-step') ?? []).length >= 2) {
    ok('接线：召回与压缩后补回登记为两个独立处理函数（不再互相覆盖）', `${handlers.get('agent/pre-step').length} 个`);
  } else {
    bad('接线：pre-step 应有两个处理函数', `实际 ${(handlers.get('agent/pre-step') ?? []).length} 个`);
  }

  {
    const { claimed, baseDecision, payload } = preStepCall();
    const before = JSON.stringify(baseDecision.messages);
    const out = await runPreStep(payload, baseDecision);
    JSON.stringify(baseDecision.messages) === before ? ok('pre-step 不修改传入的 decision（无副作用）') : bad('pre-step 不修改传入的 decision');
    out?.kind === 'enter' && Array.isArray(out.messages) && out.messages.length >= claimed.length
      ? ok('pre-step 返回合法 enter 决策', `消息数 ${out.messages.length}`)
      : bad('pre-step 返回合法 enter 决策', JSON.stringify(out)?.slice(0, 200));
    out.messages[0] === claimed[0] ? ok('pre-step 保留原有消息在前（只追加）') : bad('pre-step 保留原有消息在前');

    // 这次库里**有**匹配的条目，所以召回必须真的追加一条注入消息
    const injected = out.messages.filter((m) => m?.source?.kind === SOURCE_KIND);
    injected.length >= 1
      ? ok('召回：命中时追加一条注入消息', `注入 ${injected.length} 条`)
      : bad('召回：命中时追加一条注入消息', `消息数 ${out.messages.length}`);
    String(injected[0]?.content?.[0]?.text ?? '').includes('记忆插件')
      ? ok('召回：注入内容来自命中的记忆')
      : bad('召回：注入内容来自命中的记忆', JSON.stringify(injected[0]?.content)?.slice(0, 120));
  }

  // V3-3 召回观测：**0 命中也必须落一行** —— 那正是"换个说法就搜不到"的直接证据
  try {
    const conn = new DatabaseSync(join(root, '.dsh-memory-test', 'memory.db'), { readOnly: true });
    const rows = conn.prepare('SELECT query_text, segments, hits, picked FROM recall_runs ORDER BY id DESC').all();
    conn.close();
    rows.length >= 1
      ? ok('召回观测：落下了这一轮的 query 与命中数', `hits=${rows[0].hits} picked=${rows[0].picked} segments=${rows[0].segments}`)
      : bad('召回观测：落一行', `rows=${rows.length}`);
    String(rows[0]?.query_text ?? '').includes('记忆插件架构')
      ? ok('召回观测：记下了当时那句 query（离线可重放）')
      : bad('召回观测：query 内容', String(rows[0]?.query_text ?? '').slice(0, 60));
    (rows[0]?.hits ?? 0) >= 1 ? ok('召回观测：命中数被如实记录') : bad('召回观测：命中数', String(rows[0]?.hits));
  } catch (e) {
    bad('召回观测：落一行', String(e?.message ?? e));
  }

  // 0 命中也要落一行（同一条路径、换一句搜不到的 query；库里被标记为"已注入"后仍会记录）
  {
    const { baseDecision, payload } = preStepCall();
    const noHit = { ...payload, messages: [{ role: 'user', content: [{ type: 'text', text: 'zzz完全无关的查询词qqq' }], source: { kind: 'user' } }] };
    noHit.agent = { session: { id: 'w2', header: { cwd: root } } };
    const base2 = { kind: 'enter', messages: [...noHit.messages] };
    await runPreStep(noHit, base2);
    void baseDecision;
    try {
      const conn = new DatabaseSync(join(root, '.dsh-memory-test', 'memory.db'), { readOnly: true });
      const zero = conn.prepare('SELECT COUNT(*) AS n FROM recall_runs WHERE session_id = ? AND hits = 0').get('w2').n;
      conn.close();
      zero >= 1 ? ok('召回观测：0 命中的那一轮同样落了一行', `hits=0 的行 ${zero} 条`) : bad('召回观测：0 命中也落一行', `rows=${zero}`);
    } catch (e) {
      bad('召回观测：0 命中也落一行', String(e?.message ?? e));
    }
  }

  // pre-execute 审批闸门
  const gate = (handlers.get('tools/pre-execute') ?? [])[0];
  if (typeof gate === 'function') {
    const allow = await gate({ name: 'memory_search' }, async () => ({ kind: 'allow' }));
    allow?.kind === 'allow' ? ok('审批闸门：非破坏性工具放行') : bad('审批闸门：非破坏性工具放行', JSON.stringify(allow));
    const ask = await gate({ name: 'memory_forget' }, async () => ({ kind: 'allow' }));
    ask?.kind === 'ask' && ask.reason ? ok('审批闸门：破坏性工具转人工审批', ask.reason.slice(0, 40)) : bad('审批闸门：破坏性工具转人工审批', JSON.stringify(ask));
    const passed = await gate({ name: 'memory_forget' }, async () => ({ kind: 'reject', reason: '别的插件拒了' }));
    passed?.kind === 'reject' ? ok('审批闸门：不覆盖上游的 reject') : bad('审批闸门：不覆盖上游的 reject');
  }

  // 不带 dir 的分支放在**这里**测：前面跑过 pre-step 之后，工作区库才被 storeFor 登记进
  // 注册表（"只有一个已知库"这个前提才成立）。放在前面测会变成"没有已知库 → 被守卫拒"，
  // 那断言就成了必然通过的空话。
  {
    const saveRoute = routes.find((r) => String(r.path).endsWith('/save'));
    let payload = null;
    const res = { writeHead: () => {}, end: (s) => { try { payload = JSON.parse(s); } catch { payload = null; } } };
    await saveRoute.handler({ url: '/dsh-memory-lite/api/save', body: { content: '不带 dir 的写入：应当落到唯一已知的工作区库' } }, res);
    payload?.ok === true
      ? ok('面板保存：不带 dir 时落到唯一的已知库', `created=${payload.created}`)
      : bad('面板保存：不带 dir', JSON.stringify(payload));
  }

  // 释放
  for (const cleanup of effectCleanups) { try { cleanup(); } catch (e) { bad('effect 清理可执行', String(e.message)); } }
  const registeredCount = registered.length;
  disposed.length >= registeredCount
    ? ok('注册/释放成对', `注册 ${registeredCount} → 释放 ${disposed.length}`)
    : bad('注册/释放成对', `注册 ${registeredCount} → 释放 ${disposed.length}`);

  rmSync(root, { recursive: true, force: true });
  if (prevDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = prevDshHome;
}

// ── F. 索引段容量（V3-2）─────────────────────────────────────────────────
// 实测：33 条真实记忆时索引段已占 3431/4096 B，**每行 123 B**（30/33 条没标题，
// 回落到"正文前 48 字"，中文 1 字 = 3 B）→ 只装得下约 33 条。截到 20 字后每行约
// 83 B，装得下约 49 条。这里把这个结论钉成断言，防止以后有人把截断长度改回去。
{
  const mk = (i, title, content) => ({ id: `e${i}`, level: 'fact', title, content, status: 'active', updatedAt: i, project: '全局' });
  const many = Array.from({ length: 30 }, (_, i) => mk(i, null, `第 ${i} 条记忆的正文内容，用来测索引段容量。`.repeat(3)));
  const text = renderIndexSection({ entries: many });
  const lines = text.split('\n').slice(1).filter((l) => !l.startsWith('-（另有'));
  const bodies = lines.map((l) => l.replace(/^- \[[^\]]*\] /, ''));
  const longest = Math.max(...bodies.map((b) => b.length));
  longest <= INDEX_TITLE_CHARS
    ? ok('索引段：每行都截到 INDEX_TITLE_CHARS 字内', `最长 ${longest} 字 / 上限 ${INDEX_TITLE_CHARS}`)
    : bad('索引段：有行未被截断', `最长 ${longest} 字 > ${INDEX_TITLE_CHARS}`);
  const bytes = Buffer.byteLength(text, 'utf8');
  lines.length === 30 && bytes <= INDEX_MAX_BYTES
    ? ok('索引段：30 条全列出且不超字节预算', `${bytes} B / ${INDEX_MAX_BYTES} B`)
    : bad('索引段：30 条容量', `列出 ${lines.length} 行 · ${bytes} B`);

  const titled = renderIndexSection({ entries: [mk(1, '短标题', '正文很长'.repeat(60))] });
  titled.includes('短标题') && !titled.includes('正文很长')
    ? ok('索引段：有条目标题时优先用标题，不回落正文')
    : bad('索引段：标题优先', titled.replace(/\n/g, ' | ').slice(0, 80));
}

// ── 输出 ─────────────────────────────────────────────────────────────────
console.log('');
let pass = 0;
for (const r of results) {
  console.log(`${r.pass ? '✅' : '❌'} ${r.n}${r.d ? `  —— ${r.d}` : ''}`);
  if (r.pass) pass++;
}
console.log(`\n通过 ${pass}/${results.length}`);
console.log('\n⚠ 离线验不到的（必须真机）：');
console.log('   · agent/pre-step 的真实 decision 形状与 claimed 批次内容');
console.log('   · turn-stopping 里 session.snapshotEvents() 是否可用（我按可用性探测写的）');
console.log('   · ctx.llm 的真实调用签名（distill.js 做的是多形态探测）');
console.log('   · 注入消息是否真的进了模型上下文、是否触发前缀缓存失效');
process.exit(results.every((r) => r.pass) ? 0 : 1);
