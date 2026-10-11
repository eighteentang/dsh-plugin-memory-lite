/**
 * inject.js —— 注入与"自注入抑制"
 *
 * 注入形态（照官方 dsh-agent-instructions 的范式 + 两家第三方的一致做法）：
 *   · 恒定索引段 → systemPrompt.section（字节稳定，放在 system prompt 里）
 *   · 每轮召回   → 作为**独立消息追加在对话尾部**（不动已有前缀，因此不废 KV 缓存）
 *
 * 自注入抑制（不跳过就会自激）：
 *   我们把召回内容作为 user 消息追加进去；下一轮如果又拿它当"用户说的话"去检索，
 *   就会形成"注入→被当成输入→再注入"的自我放大。所以：
 *   ① 注入消息带自己的 `source.kind`（生产者自有 kind，DSH 没有通用 plugin 兜底 kind）
 *   ② 每轮先从候选消息里剔除自己注入过的，再做召回
 *   ③ 记 per-session 已注入 id，避免同一条反复出现
 */
import { randomUUID } from 'node:crypto';

/** 生产者自有 source kind —— 用于识别"这条是我注入的" */
export const SOURCE_KIND = 'memory-lite';

/** 构造一条注入用的消息（形态与 im-bridge 里已跑通的写法一致） */
export function createInjectedMessage(text, { form = 'recall' } = {}) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form },
  };
}

/** 这条消息是不是我们自己注入的？ */
export function isOwnInjection(message) {
  return message?.source?.kind === SOURCE_KIND;
}

/** 从一批消息里剔除自己注入过的（检索/摘要前必须先过这一步） */
export function stripOwnInjections(messages) {
  return (messages ?? []).filter((m) => !isOwnInjection(m));
}

/** 取一批消息里的纯文本（用于抽取检索 query；跳过自己的注入） */
export function textOf(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

/** 最近一条真实用户消息的文本（跳过注入） */
export function lastUserText(messages) {
  for (let i = (messages ?? []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user' || isOwnInjection(m)) continue;
    const text = textOf(m);
    // 系统注入的环境快照等以 <system-reminder> 起头的，不算"用户说的话"
    if (text && !text.startsWith('<system-reminder>')) return text;
  }
  return '';
}

/**
 * 每会话的注入状态：记录"已经注入过哪些条目"。
 * 为什么需要：同一条记忆反复注入 = 噪音；而且会让模型以为你在强调它。
 */
export function createInjectState() {
  const bySession = new Map();
  return {
    seen(sessionId) {
      return bySession.get(sessionId) ?? new Set();
    },
    mark(sessionId, ids) {
      const set = bySession.get(sessionId) ?? new Set();
      for (const id of ids) set.add(id);
      bySession.set(sessionId, set);
    },
    /** 压缩后清空 —— 压缩把上下文丢了，之前"注入过"的记录不再成立 */
    reset(sessionId) {
      bySession.delete(sessionId);
    },
    forget(sessionId) {
      bySession.delete(sessionId);
    },
    size() {
      return bySession.size;
    },
  };
}

/**
 * 挑出本轮要注入的条目。
 * @param {Array<object>} candidates 检索结果（按相关度排序）
 * @param {{ sessionId: string, seen: Set<string>, maxItems: number, includeAll?: boolean }} options
 */
export function pickForInjection(candidates, { sessionId, seen, maxItems, includeAll = false }) {
  void sessionId;
  const picked = [];
  for (const entry of candidates) {
    if (!entry || entry.sensitive) continue;
    if (!includeAll && seen?.has(entry.id)) continue;
    picked.push(entry);
    if (picked.length >= maxItems) break;
  }
  return picked;
}
