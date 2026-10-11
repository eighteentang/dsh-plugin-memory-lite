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
 *     provider: 'deepseek-official',   // 可省略 → 用会话默认模型
 *     model: 'deepseek-v4-flash',
 *     messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
 *   })) {
 *     // 分片类型：block-start, text-delta, ..., usage, finish
 *   }
 *
 * ⚠ 真机踩过的坑：`stream()` 返回的是**异步可迭代对象**，
 *   `await stream()` 只会拿到它自己，拿不到任何文本 —— 表现为"模型没产出条目（raw 长度 0）"。
 *   必须 `for await` 逐分片消费，并把 `text-delta` 拼起来。
 *
 * @returns {{ text: string, error: string|null, finish: object|null }}
 */
export async function collectStreamText(stream) {
  let text = '';
  let finish = null;
  let error = null;
  if (stream == null) return { text, error: 'stream 返回空值', finish };

  // 非流式的兜底（万一某个适配器返回的是普通对象/字符串）
  if (typeof stream === 'string') return { text: stream, error: null, finish };
  if (typeof stream?.[Symbol.asyncIterator] !== 'function' && typeof stream?.[Symbol.iterator] !== 'function') {
    if (typeof stream?.text === 'string') return { text: stream.text, error: null, finish };
    if (Array.isArray(stream?.content)) {
      return { text: stream.content.filter((b) => b?.type === 'text').map((b) => b.text).join(''), error: null, finish };
    }
    return { text, error: `stream 不可迭代（${typeof stream}）`, finish };
  }

  for await (const chunk of stream) {
    if (chunk == null) continue;
    if (typeof chunk === 'string') {
      text += chunk;
      continue;
    }
    const type = String(chunk.type ?? '');
    if (type === 'text-delta') {
      const piece = chunk.text ?? chunk.delta?.text ?? chunk.delta ?? '';
      if (typeof piece === 'string') text += piece;
      continue;
    }
    if (type === 'finish') {
      finish = chunk;
      // 终止分片带失败原因时不能当成功
      const reason = chunk.reason ?? chunk.error ?? chunk.finishReason;
      if (chunk.isError === true || (typeof reason === 'object' && reason !== null) || typeof chunk.error === 'string') {
        error = typeof chunk.error === 'string' ? chunk.error : JSON.stringify(reason ?? chunk).slice(0, 300);
      }
      continue;
    }
    if (type === 'error' || chunk.error) {
      error = String(chunk.error?.message ?? chunk.error ?? 'unknown stream error').slice(0, 300);
      continue;
    }
    // 其它分片（block-start / usage 等）不携带正文，忽略
  }
  return { text, error, finish };
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
    /**
     * 按官方签名调用：`ctx.llm.stream({ messages })`。
     * `provider` / `model` 可省略 —— 文档说明直接调用会用「已配置的提供方/模型对，
     * 回退到最近一次已记录请求目标，再回退到 AgentOptions」，也就是会话当前模型。
     */
    const options = {
      messages: buildMessages({ system: DISTILL_SYSTEM, user: buildUserPrompt(logs, knownTitles) }),
    };
    if (config.distillProvider) options.provider = config.distillProvider;
    if (config.distillModel) options.model = config.distillModel;

    const maybe = caller.fn(options);
    // stream() 返回异步可迭代（不是 Promise）；其它形态可能是 Promise —— 两种都收
    const resolved = maybe && typeof maybe.then === 'function' ? await maybe : maybe;
    const collected = await collectStreamText(resolved);
    raw = collected.text;
    // ⚠ 流里的错误必须当失败：早期版本把"拿到 0 字符"当成功，于是出现过
    //   outcome=ok 但 created=0、而没有任何人知道模型其实报错了。
    if (collected.error) throw new Error(`模型流错误：${collected.error}`);
    if (!raw.trim()) throw new Error('模型返回了空内容（未产出任何文本）');

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
    const empty = items.length === 0;
    memory.markDistilledUpTo(logs[logs.length - 1].id);
    memory.finishDistillRun(runId, {
      outcome: 'ok',
      created,
      updated,
      note: empty ? `via ${caller.kind} — 模型未产出条目（raw 长度 ${raw.length}）` : `via ${caller.kind}`,
      rawPreview: raw,
    });
    return { ok: true, created, updated, items: items.length, rawLength: raw.length, rawPreview: String(raw).slice(0, 1200) };
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

export { DISTILL_COOLDOWN_MS, DISTILL_MAX_ATTEMPTS, buildUserPrompt, DISTILL_MAX_TOKENS };
