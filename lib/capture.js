/**
 * capture.js —— 第 1 档：每轮自动落日志（零 LLM 成本）
 *
 * 设计依据（照 prime-memory 的做法）：
 *   L0 在回合结束时**即时落盘、不排 LLM 队列** —— 因为排队会被慢 LLM 阻塞，
 *   进程退出还会丢消息。日志层就是流水账：不判断、不摘录、不调模型。
 *
 * 闸门全用便宜规则（照 memory-eternal 那套）：
 *   · 太短不记（LOG_MIN_CHARS）
 *   · 每会话冷却（LOG_COOLDOWN_MS）
 *   · 每日配额（LOG_MAX_PER_DAY）
 *   · 与上一条完全相同则不重复记（幂等）
 *
 * ⚠ 铁律：**日志层永远不进提示词**。只有蒸馏出的长期条目才会被注入。
 *   若哪天把流水账也注入了，前缀缓存与上下文预算就全废。
 */
import { LOG_MIN_CHARS, LOG_COOLDOWN_MS, LOG_MAX_PER_DAY } from './config.js';
import { cleanLogText, diffAgainstPrevious } from './text.js';

/** 从事件对象里尽量抽取纯文本（不同版本的字段名不一致，按可用性依次尝试） */
function textFromEvent(event) {
  const data = event?.data ?? event;
  if (!data) return '';
  if (typeof data.text === 'string') return data.text;
  const content = Array.isArray(data.content) ? data.content : null;
  if (content) {
    return content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  if (typeof data.message === 'string') return data.message;
  return '';
}

const INTERESTING_EVENT = /^(user\/message|assistant\/message|tool\/result|tool\/(call|execute)|turn\/(start|end))$/;

/**
 * 从会话里取出"本轮新增"的文本。
 * @param {object} session 形如 { snapshotEvents() } 或 { events: [] } 或 { surface: { nodes } }
 * @param {number} sinceSeq 上次处理到的事件序号（水位）
 * @returns {{ text: string, untilSeq: number, maxSeqAll: number, count: number }}
 */
export function extractTurnText(session, sinceSeq = -1) {
  let events = [];
  try {
    if (typeof session?.snapshotEvents === 'function') events = session.snapshotEvents() ?? [];
    else if (Array.isArray(session?.events)) events = session.events;
    else if (Array.isArray(session?._events)) events = session._events;
  } catch {
    return { text: '', untilSeq: sinceSeq, maxSeqAll: -1, count: 0 };
  }

  const parts = [];
  let maxSeq = sinceSeq;
  // ⚠ `maxSeqAll` 与 `maxSeq` 是两回事：前者是"事件里真实存在的最大 seq"（不受水位过滤
  //   影响，取不到就是 -1），调用方靠它判断"事件编号是不是重启了"（压缩后快照重新物化
  //   会导致这种情况）—— 那时持久化的水位会让本轮**一条都抽不出来**，属于静默丢内容。
  let maxSeqAll = -1;
  for (const event of events) {
    const seq = Number(event?.seq ?? event?.seqNo ?? 0);
    if (Number.isFinite(seq) && seq > maxSeqAll) maxSeqAll = seq;
    if (Number.isFinite(seq) && seq <= sinceSeq) continue;
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
    const type = String(event?.type ?? '');
    if (!INTERESTING_EVENT.test(type)) continue;
    const text = textFromEvent(event);
    if (!text) continue;
    // tool 结果可能巨大：单条截断，避免日志层被一次命令输出灌爆
    parts.push(truncate(text, 4000));
  }
  return { text: parts.join('\n\n'), untilSeq: maxSeq, maxSeqAll, count: parts.length };
}

function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.7);
  return `${s.slice(0, head)}\n…（中略 ${s.length - max} 字）…\n${s.slice(-(max - head))}`;
}

/**
 * 写一轮日志。返回结论对象（便于调用方记日志/校验器断言）。
 *
 * 闸门顺序（顺序本身就是设计，改之前先读 AGENTS.md 的「闸门顺序」那条教训）：
 *   ① 清洗样板 → ② 太短不记 → ③ 冷却（总闸）→ ④ 与上一条去重 → ⑤ 日配额
 *
 * ⚠ ①在③之前是有意的：日志一条 = 一整轮，其中 90% 可能是宿主注入的系统样板
 *   （实测 10 条真实日志，剔完只剩 69.4%）。不清洗的话，"太短不记"这道闸门量的
 *   是样板长度 —— 一条纯样板、零内容的轮次也能过闸。
 */
export function captureTurn({ memory, sessionId, workspace, turn, text, enabled = true, now = Date.now() }) {
  if (!enabled) return { written: false, reason: 'disabled' };

  // ① 只留真正的内容（采集侧清洗，实测依据见 lib/text.js）
  const cleaned = cleanLogText(text);
  if (cleaned.length < LOG_MIN_CHARS) return { written: false, reason: 'too-short', chars: cleaned.length };

  // ② 先判冷却：它是"每会话每 5 分钟最多一条"的总闸。
  //    ⚠ 顺序很重要：早期版本把"重复判定"放在冷却之前，于是第二次写入永远报
  //    `duplicate`，冷却这道闸门**看起来测过、其实从未被检验**（校验器断言跟着假绿）。
  const since = memory.logsSince(sessionId, LOG_COOLDOWN_MS);
  if (since.tooSoon) return { written: false, reason: 'cooldown', lastAt: since.lastAt };

  // ③ 与上一条去重（根治"累积式落库"）：水位失效时整段历史会被反复落库，
  //    实测相邻两条里 6/9 对满足"后一条完整包含前一条"。只在**确定包含**时才切，
  //    切不动就原样存 —— 宁可重复，也不能静默丢内容。
  const last = memory.lastLogText?.(sessionId);
  const diff = diffAgainstPrevious(cleaned, last);
  if (!diff.text) return { written: false, reason: 'duplicate', dropped: diff.dropped };
  if (diff.text.length < LOG_MIN_CHARS) {
    return { written: false, reason: 'too-short-after-diff', chars: diff.text.length, dropped: diff.dropped };
  }

  // ④ 日配额
  if (memory.dayCount() >= LOG_MAX_PER_DAY) return { written: false, reason: 'daily-quota' };

  const id = memory.appendLog({ sessionId, workspace, turn, role: 'turn', text: diff.text });
  return { written: true, id, chars: diff.text.length, dropped: diff.dropped, dedup: diff.reason, at: now };
}

export { LOG_MIN_CHARS, LOG_COOLDOWN_MS, LOG_MAX_PER_DAY };
