/**
 * distill.js —— 第 2 档：空闲蒸馏（把日志层蒸成长期条目）
 *
 * 成本模型（决定了这里的全部设计）：
 *   第 1 档是零成本的流水账；只有本档会调用 LLM。所以：
 *   · 默认**关闭**（config.autoDistill=false），用户显式打开才跑；
 *   · 有冷却（DISTILL_COOLDOWN_MS）、有日配额、失败有退避（连续失败即停）；
 *   · 一次只处理有限条日志（DISTILL_MAX_LOGS），成本与库总量解耦。
 *
 * ⚠ `ctx.llm` 的调用签名我**没有在真机上验证过**（十家里的调用方式各不相同）。
 *   所以这里做多重探测：认 `stream` / `complete` / `generate` 三种形态，
 *   都认不出就返回 `{ ok:false, reason:'llm-unavailable' }` —— 不抛、不猜。
 *   第一次真机跑通后，把确定下来的签名写回这里并删掉多余分支。
 */
import {
  DISTILL_MAX_LOGS,
  DISTILL_MAX_TOKENS,
  DISTILL_COOLDOWN_MS,
  DISTILL_MAX_ATTEMPTS,
  DISTILL_MAX_CHARS_PER_LOG,
  DISTILL_MAX_INPUT_CHARS,
  LEVELS,
  redactSecrets,
} from './config.js';

const DISTILL_SYSTEM = `你是一个记忆整理器。给你一段对话流水，提取值得**跨会话长期保留**的条目。

规则：
- 只提取"下次新会话仍需要知道"的内容：用户的偏好/事实/项目决策/教训/进行中的话题。
- 不要提取一次性的操作细节、临时路径、命令输出、寒暄。
- 每条聚焦一件事；一句话能说清的就用 fact，不要硬凑成 topic。
- 用户介绍设计思路或决策理由时，content 必须保留用户原话措辞。
- keywords 按"用户提到哪些词时该想起这条"来写，8~13 个，优先专有名词。
- 如果流水里没有值得长期保留的内容，返回空数组。

只输出 JSON，不要任何解释文字。格式：
{"items":[{"level":"fact|lesson|topic|project|user|rules","content":"...","keywords":["..."],"importance":1,"project":"项目名或全局","subcategory":"仅project时:overview|structure|decisions|quotes|ops|todo","goal":"仅topic时","corrected":false}]}`;

function buildUserPrompt(logs, knownTitles) {
  const body = logs
    .map((l, i) => `--- 流水 ${i + 1}（${new Date(l.created_at).toISOString().slice(0, 16).replace('T', ' ')}）---\n${l.text}`)
    .join('\n\n');
  // ⚠ 别把下面的模板串再命名成 known —— 早期版本写成
  //   const known = knownTitles.length ? `...${known.map(...)}...` : ''
  //  即「在 known 的初始化表达式里引用 known」，命中 JS 的 TDZ，运行期直接抛
  //  `Cannot access 'known' before initialization`（真机报错原文，2026-10-11）。
  // 更隐蔽的是：只在【已有记忆标题】非空时才会踩到 —— 空库第一次整理反而正常。
  const knownSection = knownTitles.length
    ? `\n\n【已有记忆标题，避免重复造新条目；若讲的是同一件事请返回相同主题的内容以便合并】\n${knownTitles.map((t) => `- ${t}`).join('\n')}`
    : '';
  return `以下是最近的对话流水，请提取长期记忆条目：\n\n${body}${knownSection}`;
}

/** 从模型输出里抠出 JSON（模型经常包裹在 ```json 或说明文字里） */
export function parseItems(raw) {
  const text = String(raw ?? '');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return [];
  }
  const items = Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed) ? parsed : [];
  return items.filter((it) => it && typeof it.content === 'string' && it.content.trim());
}

/** 校验并规整单条候选（非法值不抛，降级到安全默认） */
export function sanitizeItem(item) {
  const level = LEVELS.includes(item.level) ? item.level : 'fact';
  const keywords = (Array.isArray(item.keywords) ? item.keywords : []).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 13);
  const project = typeof item.project === 'string' && item.project.trim() ? item.project.trim() : level === 'project' ? null : '全局';
  return {
    level,
    content: redactSecrets(String(item.content).trim()),
    keywords: keywords.length ? keywords : ['未分类'],
    importance: Math.max(1, Math.min(Number(item.importance) || 1, 4)),
    project,
    subcategory: level === 'project' && typeof item.subcategory === 'string' ? item.subcategory : null,
    goal: level === 'topic' && typeof item.goal === 'string' ? item.goal : null,
    corrected: Boolean(item.corrected),
  };
}

/**
 * 探测 ctx.llm 的可用调用形态。
 * @returns {{ kind: 'stream'|'complete'|'generate', fn: Function } | null}
 */
export function detectLlmCaller(llm) {
  if (!llm) return null;
  for (const kind of ['stream', 'complete', 'generate']) {
    if (typeof llm[kind] === 'function') return { kind, fn: llm[kind].bind(llm) };
  }
  return null;
}

/**
 * 消费 `ctx.llm.stream()` 的返回。
 *
 * 官方签名（dsh-llm/README.zh.md:50-57）：
 *
 *   for await (const chunk of ctx.llm.stream({
 *     provider: 'deepseek-official',   // ⚠ 必给！见下面的坑
 *     model: 'deepseek-v4-flash',
 *     messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
 *   })) {
 *     // 分片类型：block-start, text-delta, ..., usage, finish
 *   }
 *
 * ⚠ 坑 1：`stream()` 返回的是**异步可迭代对象**，
 *   `await stream()` 只会拿到它自己，拿不到任何文本 —— 表现为"模型没产出条目（raw 长度 0）"。
 *   必须 `for await` 逐分片消费，并把 `text-delta` 拼起来。
 *
 * ⚠ 坑 2（2026-10-11 真机）：**`provider` 不能省**。
 *   我一度按文档的"回退到已配置的提供方/模型对"省略了它，结果是：
 *   `{"kind":"error","failure":{"message":"no adapter registered for provider \"undefined\"","code":"NO_ADAPTER"}}`
 *   实测参照：`dsh-compaction-basic` 用的是它**自己配置项** `summarizationProvider` /
 *   `summarizationModel` —— 说明**框架没有全局默认提供方**，每个调用方都得自己指定。
 *
 * 失败分片的真实形状（实测）：`{ type: 'finish', reason: { kind: 'error', failure: { code, message } } }`
 * 稳定 code：`NO_ADAPTER` / `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` / `AUTH` /
 * `RATE_LIMIT` / `CONTEXT_WINDOW_EXCEEDED`。**按 code 处理，不要解析消息文本**。
 *
 * @returns {{ text: string, error: string|null, code: string|null, finish: object|null }}
 */
export async function collectStreamText(stream) {
  let text = '';
  let finish = null;
  let error = null;
  let code = null;
  if (stream == null) return { text, error: 'stream 返回空值', code, finish };

  // 非流式的兜底（万一某个适配器返回的是普通对象/字符串）
  if (typeof stream === 'string') return { text: stream, error: null, code, finish };
  if (typeof stream?.[Symbol.asyncIterator] !== 'function' && typeof stream?.[Symbol.iterator] !== 'function') {
    if (typeof stream?.text === 'string') return { text: stream.text, error: null, code, finish };
    if (Array.isArray(stream?.content)) {
      return { text: stream.content.filter((b) => b?.type === 'text').map((b) => b.text).join(''), error: null, code, finish };
    }
    return { text, error: `stream 不可迭代（${typeof stream}）`, code, finish };
  }

  for await (const chunk of stream) {
    if (chunk == null) continue;
    if (typeof chunk === 'string') {
      text += chunk;
      continue;
    }
    // 分片类型字段可能是 `type`，也可能是 `kind`（实测失败分片用 kind）
    const kind = String(chunk.kind ?? chunk.type ?? '');

    const failure = extractFailure(chunk);
    if (failure) {
      error = failure.message;
      code = failure.code;
      if (kind === 'finish') finish = chunk;
      continue;
    }
    if (kind === 'error' || kind === 'aborted') {
      error = `流以 ${kind} 结束（未带 failure 详情）`;
      continue;
    }
    if (kind === 'text-delta') {
      const piece = chunk.text ?? chunk.delta?.text ?? chunk.delta ?? '';
      if (typeof piece === 'string') text += piece;
      continue;
    }
    if (kind === 'finish') {
      finish = chunk;
      continue;
    }
    // 其它分片（block-start / usage 等）不携带正文，忽略
  }
  return { text, error, code, finish };
}

/**
 * 从分片里挖出失败信息（code + message）。
 *
 * ⚠ 只认**对象**形态的失败。实测失败形状：
 *     { type:'finish', reason:{ kind:'error', failure:{ code:'NO_ADAPTER', message:'…' } } }
 *   而正常结束是 `reason: 'stop'` / `'length'` —— **字符串**。
 *   第一版我把"字符串 reason"也当成失败，于是正常结束被误判成错误
 *   （错误消息变成了 `模型流错误：stop`）—— 这个误判是校验器抓出来的，
 *   否则真机上会表现为"每次整理都报错"。**判据：string reason ≠ 失败**。
 */
function extractFailure(chunk) {
  const candidates = [chunk?.failure, chunk?.reason?.failure, chunk?.error?.failure, chunk?.reason, chunk?.error];
  for (const c of candidates) {
    if (c && typeof c === 'object') {
      // 只认带 kind:'error'/'aborted' 或带 code/message 的对象
      const kind = typeof c.kind === 'string' ? c.kind : null;
      const code = typeof c.code === 'string' ? c.code : null;
      const message = typeof c.message === 'string' ? c.message : null;
      if (code || message || kind === 'error' || kind === 'aborted') {
        return { code, message: message ?? JSON.stringify(c).slice(0, 300) };
      }
    }
  }
  // 字符串形态：只有 `error` 字段算失败；`reason: 'stop'` 是正常结束
  if (typeof chunk?.error === 'string') return { code: null, message: chunk.error.slice(0, 300) };
  if (chunk?.reason === 'error') return { code: null, message: 'stream finished with reason "error"' };
  return null;
}

/**
 * 构造给模型的消息。
 * 注意 `messages` 的元素形状：`{ role, content: [{ type:'text', text }] }`。
 */
export function buildMessages({ system, user }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: [{ type: 'text', text: system }] });
  messages.push({ role: 'user', content: [{ type: 'text', text: user }] });
  return messages;
}

/** 这些 code 表示"这个提供方用不了"，应该换下一个试（而不是直接放弃） */
const CURABLE_CODES = new Set(['NO_ADAPTER', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'AUTH']);

/**
 * 决定"用哪个提供方 + 哪个模型"。
 *
 * 为什么需要它（2026-10-11 真机）：
 *   省略 `provider` 直接调 `ctx.llm.stream()` 会失败：
 *   `no adapter registered for provider "undefined"` → `NO_ADAPTER`。
 *   **框架没有全局默认提供方** —— 参照 `dsh-compaction-basic`，它用的是自己的配置项
 *   `summarizationProvider` / `summarizationModel`。所以每个调用方都得自己定。
 *
 * 候选顺序：
 *   ① 显式配置（config.distillProvider / distillModel）—— 用户说了算
 *   ② 从 `ctx.llm.listProviders()` 逐个发现，各取其 `listModels()` 的第一个模型
 * 调用方按顺序尝试，遇到 CURABLE_CODES 就换下一个。
 *
 * @returns {Promise<Array<{provider: string, model: string, source: string}>>}
 */
export async function resolveDistillTargets({ llm, config }) {
  const targets = [];
  const push = (provider, model, source) => {
    if (!provider) return;
    if (targets.some((t) => t.provider === provider && t.model === model)) return;
    targets.push({ provider, model: model ?? '', source });
  };

  const listProviders = () => {
    try {
      const r = typeof llm?.listProviders === 'function' ? llm.listProviders() : null;
      return Array.isArray(r) ? r.filter((p) => typeof p === 'string' && p) : [];
    } catch {
      return [];
    }
  };
  const listModels = async (provider) => {
    try {
      const r = typeof llm?.listModels === 'function' ? await llm.listModels(provider) : null;
      return Array.isArray(r) ? r : [];
    } catch {
      return [];
    }
  };

  const explicitProvider = String(config?.distillProvider ?? '').trim();
  const explicitModel = String(config?.distillModel ?? '').trim();

  if (explicitProvider) {
    if (explicitModel) {
      push(explicitProvider, explicitModel, 'config');
    } else {
      for (const m of await listModels(explicitProvider)) push(explicitProvider, m?.id ?? '', 'config+discovered-model');
      // 拿不到模型列表也仍然试一次：让适配器用它自己的默认模型
      push(explicitProvider, '', 'config-no-model');
    }
  } else {
    for (const provider of listProviders().slice(0, 4)) {
      const models = await listModels(provider);
      if (models.length) push(provider, models[0]?.id ?? '', 'discovered');
      else push(provider, '', 'discovered-no-model');
    }
  }
  return targets;
}

/**
 * 跑一次蒸馏。
 * @param {{ memory, config, llm, now?: number, force?: boolean }} deps
 * @returns {Promise<{ ok: boolean, reason?: string, created?: number, updated?: number, items?: number }>}
 */
export async function runDistill({ memory, config, llm, now = Date.now(), force = false }) {
  if (!config.autoDistill && !force) return { ok: false, reason: 'disabled' };

  // 冷却：按上一次**成功的**蒸馏时间算
  if (!force) {
    const lastRun = memory.lastDistillRun();
    if (lastRun?.finished_at && now - lastRun.finished_at < DISTILL_COOLDOWN_MS) {
      return { ok: false, reason: 'cooldown', lastAt: lastRun.finished_at };
    }
    // 连续失败退避：最近 DISTILL_MAX_ATTEMPTS 次都失败就不再试
    const recent = memory._raw
      .prepare('SELECT outcome FROM distill_runs ORDER BY id DESC LIMIT ?')
      .all(DISTILL_MAX_ATTEMPTS);
    if (recent.length >= DISTILL_MAX_ATTEMPTS && recent.every((r) => r.outcome && r.outcome !== 'ok')) {
      return { ok: false, reason: 'backoff' };
    }
  }

  const caller = detectLlmCaller(llm);
  if (!caller) return { ok: false, reason: 'llm-unavailable' };

  const allLogs = memory.undistilled(DISTILL_MAX_LOGS);
  if (!allLogs.length) return { ok: false, reason: 'no-logs' };

  /**
   * 输入预算裁剪（实测教训）：第一次真机跑蒸馏时送进去 3 条流水共 **146,721 字**
   * （单条就有 74,919 字），结果模型回了个空数组。先例：dsh-knowledge 的
   * `extractionMaxInputChars = 30000`；我们取更保守的 20000 字。
   *
   * ⚠ 关键细节：**只裁剪"真的会送进去"的那几条**，并且只标记这几条为已蒸馏。
   *   如果把超预算的流水也一并标记，就等于"发都没发出去却记成处理过了"，永久丢内容。
   */
  const logs = [];
  let budget = DISTILL_MAX_INPUT_CHARS;
  for (const log of allLogs) {
    const text = String(log.text ?? '');
    const piece = text.length > DISTILL_MAX_CHARS_PER_LOG ? text.slice(0, DISTILL_MAX_CHARS_PER_LOG) : text;
    // 至少要能放下一条；放不下就不放（它留到下次）
    if (logs.length > 0 && piece.length + 200 > budget) break;
    logs.push({ ...log, text: piece });
    budget -= piece.length + 200;
    if (budget <= 0) break;
  }
  if (!logs.length) {
    // 单条流水本身就超过总预算：至少裁到能发出去，避免永远卡住
    const first = allLogs[0];
    logs.push({ ...first, text: String(first.text ?? '').slice(0, Math.max(1000, DISTILL_MAX_INPUT_CHARS - 500)) });
  }

  const runId = memory.startDistillRun(logs.length);
  const knownTitles = memory.list({ status: 'active', limit: 60 }).map((e) => e.title || String(e.content).slice(0, 40));

  let raw = '';
  try {
    const messages = buildMessages({ system: DISTILL_SYSTEM, user: buildUserPrompt(logs, knownTitles) });
    /**
     * 决定用哪个提供方/模型，并**按顺序尝试**。
     *
     * ⚠ 这一段是被真机教出来的：省略 `provider` 会 `NO_ADAPTER`（框架没有全局默认），
     *   而"配置里只有一个提供方能用"这种事不该让用户去猜 —— 所以逐个试，
     *   遇到 NO_ADAPTER / 凭据类失败就换下一个，并把成功的那对记进 note（下次能直接看到）。
     */
    const targets = await resolveDistillTargets({ llm, config });
    if (!targets.length) {
      memory.finishDistillRun(runId, {
        outcome: 'error',
        note: '没有可用的模型提供方：ctx.llm.listProviders() 返回空，且配置里没指定 distillProvider',
      });
      return {
        ok: false,
        reason: 'no-provider',
        message: '找不到可用的模型提供方。请在插件配置里指定 distillProvider / distillModel，或确认已挂载至少一个 llm 适配器。',
      };
    }

    let collected = null;
    let used = null;
    let lastFailure = null;
    for (const target of targets) {
      const options = { messages };
      if (target.provider) options.provider = target.provider;
      if (target.model) options.model = target.model;
      const maybe = caller.fn(options);
      // stream() 返回异步可迭代（不是 Promise）；其它形态可能是 Promise —— 两种都收
      const resolved = maybe && typeof maybe.then === 'function' ? await maybe : maybe;
      const got = await collectStreamText(resolved);
      if (!got.error) {
        collected = got;
        used = target;
        break;
      }
      lastFailure = { ...got, target };
      // 这不是"这个提供方不行"，而是别的问题（比如上下文超限）→ 换下一个也没用，直接报
      if (!got.code || !CURABLE_CODES.has(got.code)) break;
    }

    if (!collected) {
      const detail = lastFailure ? `${lastFailure.error}${lastFailure.code ? `（${lastFailure.code}）` : ''}` : '未知原因';
      const tried = targets.map((t) => `${t.provider}${t.model ? `/${t.model}` : ''}`).join(', ');
      memory.finishDistillRun(runId, { outcome: 'error', note: `模型流错误：${detail}；试过：${tried}` });
      return { ok: false, reason: 'error', message: `模型流错误：${detail}（试过：${tried}）` };
    }

    raw = collected.text;
    if (!raw.trim()) {
      memory.finishDistillRun(runId, {
        outcome: 'error',
        note: `模型返回空内容（${used.provider}${used.model ? `/${used.model}` : ''}）`,
      });
      return { ok: false, reason: 'error', message: '模型返回了空内容（未产出任何文本）' };
    }

    const parsed = parseItems(raw);
    const items = parsed.map(sanitizeItem);

    let created = 0;
    let updated = 0;
    for (const item of items) {
      // 简化版的去重：同层 + 标题/内容前 40 字高度相似 → 视为同一件事，走更新而不是新增
      const dup = memory.list({ level: item.level, status: 'active', limit: 200 }).find((e) => {
        const a = String(e.title || e.content).slice(0, 40).replace(/\s+/g, '');
        const b = String(item.content).slice(0, 40).replace(/\s+/g, '');
        return a && b && (a === b || a.includes(b) || b.includes(a));
      });
      if (dup) {
        memory.update(dup.id, { content: item.content, keywords: item.keywords, importance: item.importance });
        updated += 1;
      } else {
        memory.put({ ...item, title: '', sourceRef: `distill:${runId}` });
        created += 1;
      }
    }

    // ⚠ 「调用成功但零产出」必须和「调用失败」区分开：
    //   真机第一次就是 outcome=ok 但 created=0，而当时没有任何证据说明模型回了什么。
    //   所以这里记下原始输出片段；解析出 0 条时用 note 明确标注。
    //   同时记下**实际用了哪个提供方/模型** —— 否则每次都要重新猜。
    const empty = items.length === 0;
    const via = `${used.provider}${used.model ? `/${used.model}` : ''}`;
    memory.markDistilledUpTo(logs[logs.length - 1].id);
    memory.finishDistillRun(runId, {
      outcome: 'ok',
      created,
      updated,
      note: empty ? `via ${caller.kind} (${via}) — 模型未产出条目（raw 长度 ${raw.length}）` : `via ${caller.kind} (${via})`,
      rawPreview: raw,
    });
    return { ok: true, created, updated, items: items.length, rawLength: raw.length, rawPreview: String(raw).slice(0, 1200), via };
  } catch (error) {
    memory.finishDistillRun(runId, {
      outcome: 'error',
      note: String(error?.message ?? error).slice(0, 300),
      rawPreview: raw,
    });
    return { ok: false, reason: 'error', message: String(error?.message ?? error), rawPreview: String(raw).slice(0, 600) };
  }
}

/**
 * 判断"现在该不该自动整理"—— 抽成纯函数是为了**能测**。
 *
 * 为什么必须抽出来：这段逻辑原来是写在 `setInterval` 回调里的，于是校验器
 * 根本没有入口去验它（只能靠真机等 30 分钟）。而"闸门类逻辑一次写错就一直错"
 * 正是本项目踩过的坑（见 AGENTS.md 里"闸门顺序"那条）。
 *
 * 四道闸门，任一条不满足就不跑：
 *   ① 开关打开        ② 距最后一次活动够久（真的空闲了）
 *   ③ 今天次数没超额  ④ 距上次整理超过冷却时间  ⑤ 有东西可整理
 *
 * @param {{ memory: object, config: object, lastActivityAt: number, now?: number }} input
 * @returns {{ run: boolean, reason: string, idleMs?: number }}
 */
export function shouldAutoDistill({ memory, config, lastActivityAt, now = Date.now() }) {
  if (!config?.autoDistill) return { run: false, reason: 'disabled' };

  const idleMs = Math.max(1, Number(config.distillIdleMinutes) || 30) * 60 * 1000;
  const idleFor = now - (lastActivityAt ?? 0);
  if (idleFor < idleMs) return { run: false, reason: 'not-idle', idleMs: idleFor };

  const maxPerDay = Math.max(1, Number(config.distillMaxPerDay) || 4);
  try {
    if (memory.dayDistillCount() >= maxPerDay) {
      return { run: false, reason: 'daily-quota', used: memory.dayDistillCount() };
    }
  } catch {
    /* 计数失败就不拦（宁可多跑一次，也别因为统计坏了彻底不整理） */
  }

  const minIntervalMs = Math.max(1, Number(config.distillMinIntervalMinutes) || 30) * 60 * 1000;
  try {
    const last = memory.lastDistillRun();
    if (last?.finished_at && now - last.finished_at < minIntervalMs) {
      return { run: false, reason: 'cooldown', lastAt: last.finished_at };
    }
  } catch {
    /* 同上 */
  }

  try {
    if (!memory.undistilled(1).length) return { run: false, reason: 'no-logs' };
  } catch {
    return { run: false, reason: 'no-logs' };
  }

  return { run: true, reason: 'ok', idleMs: idleFor };
}

export { DISTILL_COOLDOWN_MS, DISTILL_MAX_ATTEMPTS, buildUserPrompt, DISTILL_MAX_TOKENS, CURABLE_CODES };
