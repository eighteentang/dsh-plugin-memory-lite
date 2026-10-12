/**
 * text.js —— 日志文本的清洗（**采集侧与蒸馏侧共用一份实现**）
 *
 * 为什么单独成文件：这段逻辑两边都要用 ——
 *   · 采集侧（capture.js）：落盘前先剔样板，否则日志层存的大部分是系统样板；
 *   · 蒸馏侧（distill.js）：送进模型前再剔一次（旧数据是清洗前写入的，仍需兜底）。
 * 两份实现迟早会漂移（改了一边忘另一边），所以只留一份。
 *
 * 实测依据（2026-10-11，10 条真实日志）：日志一条 = 一整轮，里面夹着宿主以
 * `<system-reminder>` 注入的用户全局 AGENTS.md 等样板；**7 条的"前 1500 字"逐字相同**，
 * 最大的 4 条（7~10 万字）蒸馏只看到 1.4%~2%。剔掉样板后总字符降到 69.4%。
 *
 * 同时剔掉**我们自己注入的记忆块**：不剔的话，注入内容会被再蒸一遍写回库里，
 * 形成「注入 → 蒸馏 → 再注入」的自激放大。
 */

/**
 * 逐行剔掉的运行时样板（每轮都出现、且与对话内容无关）。
 * ⚠ 只按"整行匹配"剔，不做子串替换 —— 避免误伤正文里恰好提到这些词的地方。
 */
const RUNTIME_NOISE = [
  /^\s*Time sampled while preparing turn/i,
  /^\s*Browser time zone for this request:/i,
  /^\s*Elapsed since the preceding/i,
  /^\s*Interpret otherwise-unqualified dates and times/i,
  /^\s*Runtime context\./i,
  /^\s*Current DSH file policy:/i,
  /^\s*Approval prompts are disabled/i,
];

/**
 * 剔掉文本里的"系统样板"，只留真正的内容。
 * @param {string} text
 * @returns {string} 清洗后的文本（可能为 ''，调用方需自行决定怎么处理空串）
 */
export function cleanLogText(text) {
  let s = String(text ?? '');
  if (!s) return '';

  // ① 整块剔除宿主注入的框架块（未闭合的那种也要剔，否则尾部的样板永远留着）
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '\n');
  s = s.replace(/<system-reminder>[\s\S]*$/i, '\n');
  s = s.replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '\n');
  s = s.replace(/<environment_context>[\s\S]*$/i, '\n');

  // ② 逐行剔运行时样板
  s = s
    .split('\n')
    .filter((line) => !RUNTIME_NOISE.some((re) => re.test(line)))
    .join('\n');

  // ③ 折叠空白：日志里大量空行与行尾空格，白占字符预算
  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** 上一条日志短于这个长度就不做前缀比对 —— 太短的串到处都是，误伤概率高 */
export const DIFF_MIN_PREV_CHARS = 200;

/**
 * 去掉与"上一条日志"重复的部分（根治"累积式落库"）。
 *
 * 实测现象：相邻两条日志里 **6/9 对**满足"后一条完整包含前一条" —— 即水位失效后
 * 整段历史被反复落库，日志层膨胀 100 倍、蒸馏输入被重复内容主导。
 *
 * 为什么用内容比对而不是信 `seq` 水位：水位为什么失效**没有查清**
 * （只证明了现象：`seenSeq` 是进程内存里的 Map，重启或压缩后事件重新物化都会让它失准）。
 * 内容比对不依赖对 seq 语义的假设 —— 就算水位数得对，这一步也只是空转。
 *
 * ⚠ 不做的两件事：
 *   · 不比对"上一条太短"的情况（`DIFF_MIN_PREV_CHARS`），否则一个 "好" 字就能把正文切掉；
 *   · 不用"最长公共子串"之类的模糊匹配 —— 只认**前缀/包含**这种确定关系，
 *     因为一旦切错就是**静默丢内容**，那比重复严重得多。
 *
 * @param {string} text 本次清洗后的文本
 * @param {string} prevText 上一条已落库的文本（未提供或过短则原样返回）
 * @returns {{ text: string, dropped: number, reason: string }}
 */
export function diffAgainstPrevious(text, prevText) {
  const cur = String(text ?? '');
  const prev = String(prevText ?? '');
  if (!cur) return { text: '', dropped: 0, reason: 'empty' };
  if (prev.length < DIFF_MIN_PREV_CHARS) return { text: cur, dropped: 0, reason: 'no-prev' };
  if (cur === prev) return { text: '', dropped: cur.length, reason: 'identical' };

  const at = cur.lastIndexOf(prev);
  if (at >= 0) {
    const delta = `${cur.slice(0, at)}${cur.slice(at + prev.length)}`.trim();
    return { text: delta, dropped: cur.length - delta.length, reason: 'contains-prev' };
  }
  return { text: cur, dropped: 0, reason: 'unrelated' };
}

/** 从正文里推标题时最多留多少字（列表/索引段都会再截，这里不用太长） */
export const DERIVED_TITLE_MAX = 28;

/** 成对符号：截断时**整对要么都留、要么都不留**，不能切出「落单的左括号** */
const TITLE_PAIRS = { '「': '」', '【': '】', '『': '』', '《': '》', '（': '）', '(': ')' };

/**
 * 从正文**规则化**推一个短标题（不调模型，零成本、可复现）。
 *
 * 为什么需要：实测 47 条 active 条目里 **40 条没有标题** ——
 * 列表与索引段只好回落"正文前 24 字"，而那个回落会**在句子中间硬切**，
 * 于是目录看起来一团糟。标题的作用就是当目录，值得单独存一份。
 *
 * 规则（每一步都是为实测里出现过的形态写的）：
 *   ① 取第一行，剥 markdown 标记（`**`、反引号、`- `、`# `、【小标题】），折叠空白；
 *   ② 开头若是**短标签**（`用户要求：`、`用户决定：` —— 冒号前 ≤6 字），丢掉标签只留后面那句
 *      （实测这几条的信息全在冒号后面，"用户决定："当标题等于没标题）；
 *   ③ 从前往后找第一个**可截断点**，途中的成对括号**整对跳过**（放得下就留全，放不下就在括号前截）：
 *      `。`、`；`、`;`、`：`、`，`（≥12 字时）；
 *   ④ 超出上限时**优先在空格处收**（否则会把 `node` 切成 `no`）；再清掉落单的左括号与尾部标点；
 *   ⑤ 结果太短（<4 字）就退回"正文前 N 字"。
 *
 * @param {string} content 条目正文
 * @param {number} [max] 标题上限（默认 {@link DERIVED_TITLE_MAX}）
 * @returns {string} 标题；正文为空时返回 ''
 */
export function deriveTitle(content, max = DERIVED_TITLE_MAX) {
  const raw = String(content ?? '').trim();
  if (!raw) return '';
  let s = raw.split('\n')[0] ?? '';
  // ① 剥 markdown 与列表符号
  s = s
    .replace(/^\s*(?:[-*+>]\s+|#{1,6}\s+)/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^\s*【[^】]{0,12}】\s*/, '') // 【总原则】这类小标题不是内容
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (!s) return '';

  // ② 短标签前缀：`用户要求：xxx` → `xxx`
  const label = /^([^：:]{1,6})[：:]\s*(.+)$/.exec(s);
  if (label && label[2].trim().length >= 4) s = label[2].trim();

  // ③ 找第一个可截断点（成对括号整对跳过）
  let cut = -1;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const closer = TITLE_PAIRS[ch];
    if (closer) {
      const close = s.indexOf(closer, i + 1);
      if (close > 0 && close + 1 <= max) {
        i = close + 1; // 整对放得下 → 跳过它继续找
        continue;
      }
      cut = i; // 放不下或不成对 → 就在括号前截
      break;
    }
    if (ch === '。' || ch === '；' || ch === ';' || ch === '：' || ch === ':') {
      cut = i;
      break;
    }
    // `——` 是"结论 + 解释"的分界，正好适合当标题的终点（实测多条条目都是「结论」——展开）
    if (ch === '—' && s[i + 1] === '—' && i >= 8) {
      cut = i;
      break;
    }
    if (ch === '，' && i >= 12) {
      cut = i;
      break;
    }
    i += 1;
  }
  let out = (cut >= 0 ? s.slice(0, cut) : s).trim();

  // ④ 超长：只把**短尾巴**退到空格前（别切出 `no` 这种半个词）；
  //    尾巴还很长时不退 —— 否则会把"用户对 memory-lite X（Twitter）…"砍成"用户对 memory-lite"
  if (out.length > max) {
    const head = out.slice(0, max);
    const sp = head.lastIndexOf(' ');
    const tail = sp >= 8 ? head.slice(sp + 1) : '';
    out = (tail && tail.length <= 10 ? head.slice(0, sp) : head).trim();
  }
  // 落单的左括号：从它起丢掉
  for (let k = 0; k < out.length; k += 1) {
    const closer = TITLE_PAIRS[out[k]];
    if (closer && !out.slice(k + 1).includes(closer)) {
      out = out.slice(0, k).trim();
      break;
    }
  }
  out = out.replace(/[\s，,。.、：:；;]+$/g, '').trim();

  // ⑤ 兜底
  if (out.length < 4) out = s.replace(/\s+/g, ' ').slice(0, max).trim();
  return out;
}
