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
import { resolveConfig, toJsonSchema } from '../../lib/config.js';
import { runDistill, buildUserPrompt } from '../../lib/distill.js';

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

// ── E. 接线（假 ctx 跑 apply）────────────────────────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'memwire-'));
  const registered = [];
  const disposed = [];
  const effectCleanups = [];
  const handlers = new Map();

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
      handlers.set(event, handler);
      return () => disposed.push(`on:${event}`);
    },
    get: () => undefined,
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') effectCleanups.push(cleanup);
      return cleanup;
    },
  };

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
    handlers.has(evt) ? ok(`接线：注册了 ${evt}`) : bad(`接线：注册了 ${evt}`);
  }

  // pre-step 行为：只追加、不改写既有消息
  const preStep = handlers.get('agent/pre-step');
  if (typeof preStep === 'function') {
    const claimed = [{ role: 'user', content: [{ type: 'text', text: '问一个关于记忆插件架构的问题' }], source: { kind: 'user' } }];
    const baseDecision = { kind: 'enter', messages: [...claimed] };
    const before = JSON.stringify(baseDecision.messages);
    const out = await preStep({ agent: { session: { id: 'w1', header: { cwd: root } } }, messages: claimed, step: 1 }, async () => baseDecision);
    JSON.stringify(baseDecision.messages) === before ? ok('pre-step 不修改传入的 decision（无副作用）') : bad('pre-step 不修改传入的 decision');
    out?.kind === 'enter' && Array.isArray(out.messages) && out.messages.length >= claimed.length
      ? ok('pre-step 返回合法 enter 决策', `消息数 ${out.messages.length}`)
      : bad('pre-step 返回合法 enter 决策', JSON.stringify(out)?.slice(0, 200));
    out.messages[0] === claimed[0] ? ok('pre-step 保留原有消息在前（只追加）') : bad('pre-step 保留原有消息在前');
  }

  // pre-execute 审批闸门
  const gate = handlers.get('tools/pre-execute');
  if (typeof gate === 'function') {
    const allow = await gate({ name: 'memory_search' }, async () => ({ kind: 'allow' }));
    allow?.kind === 'allow' ? ok('审批闸门：非破坏性工具放行') : bad('审批闸门：非破坏性工具放行', JSON.stringify(allow));
    const ask = await gate({ name: 'memory_forget' }, async () => ({ kind: 'allow' }));
    ask?.kind === 'ask' && ask.reason ? ok('审批闸门：破坏性工具转人工审批', ask.reason.slice(0, 40)) : bad('审批闸门：破坏性工具转人工审批', JSON.stringify(ask));
    const passed = await gate({ name: 'memory_forget' }, async () => ({ kind: 'reject', reason: '别的插件拒了' }));
    passed?.kind === 'reject' ? ok('审批闸门：不覆盖上游的 reject') : bad('审批闸门：不覆盖上游的 reject');
  }

  // 释放
  for (const cleanup of effectCleanups) { try { cleanup(); } catch (e) { bad('effect 清理可执行', String(e.message)); } }
  const registeredCount = registered.length;
  disposed.length >= registeredCount
    ? ok('注册/释放成对', `注册 ${registeredCount} → 释放 ${disposed.length}`)
    : bad('注册/释放成对', `注册 ${registeredCount} → 释放 ${disposed.length}`);

  rmSync(root, { recursive: true, force: true });
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
