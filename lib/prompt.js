/**
 * prompt.js —— 注入文本的渲染（纯函数，无副作用，可离线测试）
 *
 * 两条铁律（都来自实测/事故，不是风格偏好）：
 *   ① **同一输入必须产出同一字节**。常驻索引段进 system prompt，它一变，
 *      从该位置起的前缀缓存全部作废。所以这里不允许出现时间戳、随机序、
 *      相对时间（"3 小时前"这类会让每轮文本都不同）。
 *   ② 所有进入提示词的文本都要过 neutralizeBraces + escapeFrameTags，
 *      否则记忆正文里的 `{{` 会让组装抛异常（整轮崩），`</system-reminder>`
 *      会提前闭合我们自己的框架。
 */
import { INDEX_MAX_BYTES, INDEX_TITLE_CHARS, INJECT_MAX_CHARS_PER_ITEM, LEVELS, neutralizeBraces, escapeFrameTags, safeSlice } from './config.js';
// 边界截断与标题推导共用一份实现（两份迟早漂移 —— 见 lib/text.js 的注释）
import { truncateAtBoundary } from './text.js';

const LEVEL_LABEL = {
  soul: 'AI 自身',
  user: '用户',
  rules: '准则',
  fact: '事实',
  lesson: '教训',
  topic: '话题',
  project: '项目',
};

export function levelLabel(level) {
  return LEVEL_LABEL[level] ?? level;
}

/** 字节长度（中文按 UTF-8 算，别用 .length） */
function byteLen(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/**
 * 渲染「常驻索引段」——只列有什么，不列正文。
 *
 * 为什么只放索引：这段每轮都在 system prompt 里，放正文会让提示词体积随记忆增长
 * 而膨胀，且一旦新增/改动记忆就要重写整段（前缀缓存作废）。正文交给检索注入。
 *
 * @param {{ entries: Array<{id:string,level:string,title:string,project?:string|null,status:string,updatedAt:number}>, maxBytes?: number, maxItems?: number, titleChars?: number }} input
 * @returns {string} 恒定文本（同一组 entries → 同一字节）
 */
export function renderIndexSection({ entries = [], maxBytes = INDEX_MAX_BYTES, maxItems = 60, titleChars = INDEX_TITLE_CHARS } = {}) {
  const active = entries.filter((e) => e.status === 'active');
  if (!active.length) {
    // 空库也要有稳定文本：返回常量串，不返回 ''，避免"从无到有"时前缀突然变长
    return '（记忆库为空）';
  }

  // 稳定排序：先按 level 的固定次序，再按 updatedAt 倒序，最后按 id —— 保证同一集合总是同一顺序
  const levelRank = new Map(LEVELS.map((l, i) => [l, i]));
  const sorted = [...active].sort((a, b) => {
    const lr = (levelRank.get(a.level) ?? 99) - (levelRank.get(b.level) ?? 99);
    if (lr !== 0) return lr;
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    return String(a.id).localeCompare(String(b.id));
  });

  const header = '以下是记忆库索引（只列条目，正文按相关性注入）：';
  const lines = [];
  let used = byteLen(header) + 1;
  let omitted = 0;

  for (const entry of sorted) {
    if (lines.length >= maxItems) {
      omitted += 1;
      continue;
    }
    const label = levelLabel(entry.level);
    const project = entry.project && entry.project !== '全局' ? ` · ${entry.project}` : '';
    // 边界截断（不是硬切）：同一套规则也用在标题推导上 —— 见 lib/text.js 的 truncateAtBoundary。
    // 硬切会切出 `我反复把「判据本身的缺陷」读成「客体出了` / `用户包 D` 这种没法读的目录行，
    // 而索引段**每轮都在提示词里**，是最该好看的一段文字。
    const title = escapeFrameTags(neutralizeBraces(truncateAtBoundary(safeSlice(entry.title || entry.content, titleChars + 8), titleChars)));
    const line = `- [${label}${project}] ${title}`;
    const cost = byteLen(line) + 1;
    if (used + cost > maxBytes) {
      omitted += 1;
      continue;
    }
    used += cost;
    lines.push(line);
  }

  if (omitted > 0) lines.push(`-（另有 ${omitted} 条未列出）`);
  return [header, ...lines].join('\n');
}

/**
 * 渲染「每轮召回块」——这是要追加到对话尾部的那条消息正文。
 *
 * 每条都带出处（id + level），这样模型引用时能说清来源；也方便用 id 去 memory_read 看全文。
 *
 * @param {Array<{id:string,level:string,content:string,project?:string|null,sensitive?:boolean}>} entries
 * @param {{ maxChars?: number, maxCharsPerItem?: number }} options
 * @returns {string} 空数组 → 返回 ''（调用方据此决定不注入）
 */
export function renderRecallBlock(entries = [], { maxChars = 2000, maxCharsPerItem = INJECT_MAX_CHARS_PER_ITEM } = {}) {
  // 敏感条目**在注入前再挡一次**（写入侧已落 sensitive 列，这里是第二道防线）
  const usable = entries.filter((e) => !e.sensitive && e.content);
  if (!usable.length) return '';

  const lines = [];
  let used = 0;
  for (const entry of usable) {
    const body = safeSlice(escapeFrameTags(neutralizeBraces(entry.content)), maxCharsPerItem);
    const label = levelLabel(entry.level);
    const project = entry.project && entry.project !== '全局' ? ` · ${entry.project}` : '';
    const line = `- [${label}${project} · ${entry.id}] ${body}`;
    if (used + line.length > maxChars) break;
    used += line.length + 1;
    lines.push(line);
  }
  if (!lines.length) return '';

  return [
    '<system-reminder>',
    '以下是与当前话题相关的记忆片段，仅供参考。它们可能过时或有误，若与当前情况冲突以当前情况为准。',
    '需要全文或更多相关条目时，可用 memory_search / memory_read。',
    '',
    ...lines,
    '</system-reminder>',
  ].join('\n');
}

/**
 * 渲染「压缩后补回块」——压缩会丢掉上下文，这里把常驻内容重新交回去。
 * 与 recall 分开是因为它要带一句说明，让模型知道自己"刚失忆过"。
 */
export function renderRecoveryBlock(entries = [], { maxChars = 2000 } = {}) {
  const body = renderRecallBlock(entries, { maxChars });
  if (!body) return '';
  return body.replace(
    '以下是与当前话题相关的记忆片段，仅供参考。',
    '本次对话刚刚经过上下文压缩，以下记忆是为避免失忆而重新提供的，仅供参考。',
  );
}

export { byteLen };
