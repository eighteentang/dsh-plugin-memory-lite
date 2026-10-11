/**
 * config.js —— 配置、预算常量与工具 schema 形态转换
 *
 * 两条实测约束决定了这里的写法（见 AGENTS.md 第四节）：
 *   ① `@deepseek-ai/schemastery` 在 link: 装法下解析不到 → 配置声明用 Standard Schema
 *      形态（`{ '~standard': { version, vendor, validate } }`），不 import 任何 @deepseek-ai/*；
 *   ② `ctx.tools.register` 的 parameters **必须**是真 JSON Schema。DSH 内部简写
 *      `{参数名:{type,required}}` 注册期静默通过、模型一调用就炸整个会话那一轮，
 *      所以这里提供 `toJsonSchema()` 做转换，并且**只在导出里用它**，绝不让简写直接进 registry。
 */

/** 记忆层级（沿用十家主流插件的语义，便于对照） */
export const LEVELS = ['soul', 'user', 'rules', 'fact', 'lesson', 'topic', 'project'];

/** 项目类记忆的子类 */
export const PROJECT_SUBCATEGORIES = ['overview', 'structure', 'decisions', 'quotes', 'ops', 'todo'];

/** 状态：active=在用 / stale=完结（todo 做完、话题达成目标）/ archived=作废 */
export const STATUSES = ['active', 'stale', 'archived'];

// ── 预算常量（都有先例，见注释里的来源）────────────────────────────────────
/** 每轮注入的记忆条数上限。先例：prime-memory maxResults=5、meow hitTopK=2 */
export const INJECT_MAX_ITEMS = 3;
/** 每轮注入的总字符上限。先例：prime-memory maxTotalRecallChars=2000 */
export const INJECT_MAX_CHARS = 2000;
/** 单条注入内容的截断长度。先例：prime-memory maxCharsPerMemory=500 */
export const INJECT_MAX_CHARS_PER_ITEM = 500;
/** 常驻索引段的字节上限。先例：dsh-auto-memory maxBytes=4096、AskTheWay 同值 */
export const INDEX_MAX_BYTES = 4096;
/** 常驻索引段里最多列几条。索引只列"有什么"，正文靠检索 */
export const INDEX_MAX_ITEMS = 60;
/**
 * 常驻索引段里每条标题的截断长度（字符）。
 *
 * 实测依据（2026-10-11，33 条真实记忆）：索引段当时已占 3431/4096 B（83.8%），
 * **每行 123 B** —— 因为 30/33 条没有标题，渲染层回落到"正文前 48 字"，而中文
 * 1 字 = 3 B。按行均字节算，4096 B 只装得下约 33 条；截到 20 字后每行约 83 B，
 * 装得下约 49 条（+48%）。
 *
 * ⚠ 不要指望"给旧条目回填标题"能多装 —— 回填的标题同样会被这里截断，
 * 走的是同一条路，额外容量是 0。真正决定容量的是这个常量。
 */
export const INDEX_TITLE_CHARS = 20;

/** 日志层：单条最小长度（低于此不记）。先例：memory-eternal captureMinChars=200 */
export const LOG_MIN_CHARS = 200;
/** 日志层：每会话冷却毫秒。先例：memory-eternal captureCooldownMs=5 分钟 */
export const LOG_COOLDOWN_MS = 5 * 60 * 1000;
/** 日志层：每会话条数上限，溢出归档。先例：dsh-trilogy 200 条 */
export const LOG_MAX_PER_SESSION = 200;
/** 日志层：每日条数配额。先例：memory-eternal maxCardsPerDay=60 */
export const LOG_MAX_PER_DAY = 60;

/**
 * 召回观测（V3）：保留最近多少轮"召回尝试"。
 *
 * 为什么加：以前**回答不了"召回到底命中多少轮"** —— 日志层存的是整轮文本
 * （含系统样板），拿不到"当时那句 query"，所以离线既复现不了、也验收不了
 * 任何检索改动。现在每轮记一行（**含 0 命中**，那正是最需要的样本）。
 *
 * 上限 500 行：一行约 200 B，封顶约 100 KB，不会让库膨胀。
 */
export const RECALL_RUN_KEEP = 500;
/** 召回观测里 query 的存储长度（先过 redactSecrets 再截断） */
export const RECALL_QUERY_CHARS = 500;

/** 蒸馏：连续失败多少次后放弃本轮。先例：prime-memory 退避 60s×2^n 封顶 30min */
export const DISTILL_MAX_ATTEMPTS = 3;
/** 蒸馏：冷却时长，避免频繁调 LLM */
export const DISTILL_COOLDOWN_MS = 30 * 60 * 1000;
/** 蒸馏：单次送入模型的最大日志条数 */
export const DISTILL_MAX_LOGS = 40;
/**
 * 蒸馏：单条流水送入模型前的截断长度。
 * 实测教训：不截断时单条流水能到 **7 万字**（一轮里带了整段对话+工具输出），
 * 三条加起来 14.7 万字送进模型，结果模型直接回了空数组。
 */
export const DISTILL_MAX_CHARS_PER_LOG = 1500;
/**
 * 蒸馏：送入模型的流水总字符预算。
 * 先例：dsh-knowledge `extractionMaxInputChars = 30000`；我们取更保守的 20000，
 * 因为超预算的流水会**留到下次**而不是被截掉（宁可分几次整理，也别丢内容）。
 */
export const DISTILL_MAX_INPUT_CHARS = 20000;
/** 蒸馏：输出 token 上限 */
export const DISTILL_MAX_TOKENS = 2048;

/** 敏感标题：命中这些词的标题，**整段不注入**（fail-closed）。
 *  先例：Aik358 injection-policy.js 的 sensitiveSections() */
export const SENSITIVE_TITLE_PATTERN = /敏感|凭据|密钥|口令|令牌|密码|token|secret|password|credential|api[_\s-]?key|pat\b/i;

/** 密钥类正则：写入时单点脱敏。先例：AskTheWay redactSecrets */
const SECRET_PATTERNS = [
  [/\b(sk|pk)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:api-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED:github-token]'],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, '[REDACTED:npm-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED:jwt]'],
  [/\b(?:\d[ -]?){13,19}\b(?=\s|$)/g, '[REDACTED:card-like]'],
  [/\b1[3-9]\d{9}\b/g, '[REDACTED:phone]'],
  [/\b\d{17}[\dXx]\b/g, '[REDACTED:id-card]'],
];

export const DEFAULTS = Object.freeze({
  /** 总开关 */
  enabled: true,
  /** 记忆库所在目录名（相对工作区）。全局库放 $DSH_HOME 下同名目录 */
  dirName: '.dsh-memory',
  /** 是否每轮结束自动落日志 */
  autoCapture: true,
  /** 是否每轮按关键词注入召回 */
  autoRecall: true,
  /**
   * 是否允许空闲自动整理（会调用 LLM，产生额度消耗）。
   *
   * ⚠ 默认**关**（2026-10-11 用户定）：不想要"没打招呼就花额度"的行为。
   * 关掉 ≠ 不能用 —— 日志照记，随时点设置页的「立即整理」手动触发。
   * 想让它自己长出来就改成 true；成本由三道闸门兜住
   * （空闲多久才算闲、两次之间的冷却、每天最多几次）。
   */
  autoDistill: false,
  /** 距最后一次对话空闲多少分钟后才允许自动整理 */
  distillIdleMinutes: 30,
  /** 自动整理两次之间的最小间隔（分钟） */
  distillMinIntervalMinutes: 30,
  /** 每天最多自动整理几次（成本硬上限） */
  distillMaxPerDay: 4,
  /** 单次注入条数上限 */
  injectMaxItems: INJECT_MAX_ITEMS,
  /** 单次注入字符上限 */
  injectMaxChars: INJECT_MAX_CHARS,
  /** 跨工作区检索是否开启（memory_search 的 scope="all"） */
  crossWorkspaceSearch: true,
  /**
   * 用户级（跨工作区）记忆库：`$DSH_HOME/memory-lite/global`。
   *
   * V1.7 起它是一等公民：写入要**显式**指定 scope="user"（不猜），召回时与当前工作区库
   * 合并搜索（共享同一个注入名额，避免写多了撑爆提示词）；但**不进**常驻索引段 ——
   * 索引段只有 4096 B，容量留给工作区条目。
   */
  globalMemory: true,
  /** 蒸馏使用的模型（留空则用会话默认模型） */
  distillProvider: '',
  distillModel: '',
});

// ── 简写 → 真 JSON Schema（E18 的转换步骤，外部插件必须自己写）──────────────
/**
 * 把 DSH 内部简写 `{ 参数名: { type, required?, description?, ... } }`
 * 转成 registry 真正接受的 JSON Schema。
 *
 * ⚠ 为什么不直接用简写：`ctx.tools.register` **不会**帮你转。简写会在注册期静默通过，
 * 直到模型真的调用这个工具时，provider 才拒绝整个请求：
 *   Invalid schema for function 'x': schema must be a JSON Schema of 'type: "object"',
 *   got 'type: null'.
 * 而那次失败是**整个会话那一轮**失败，不是工具返回错误。
 *
 * @param {Record<string, {type?: string, required?: boolean, [k: string]: unknown}>} spec
 * @returns {{type: 'object', properties: Record<string, unknown>, required: string[], additionalProperties: false}}
 */
export function toJsonSchema(spec) {
  const properties = {};
  const required = [];
  for (const [key, raw] of Object.entries(spec ?? {})) {
    const { required: isRequired, ...rest } = raw ?? {};
    properties[key] = rest;
    if (isRequired) required.push(key);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

// ── 脱敏与文本中和 ─────────────────────────────────────────────────────────
/** 写入时单点脱敏：所有字段统一过这里，别散在各处（散在各处必然漏） */
export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * 中和花括号：system prompt 的段默认做 `{{变量}}` 插值，
 * 记忆正文里出现 `{{` 会让组装抛异常 → 整轮崩。
 * 两道防线：段上声明 interpolate:false（首选），外加这里把 `{{` 打断。
 */
export function neutralizeBraces(text) {
  let out = String(text ?? '');
  // 循环到稳定：`{{{` 这类嵌套要全部打断
  for (let i = 0; i < 5 && out.includes('{{'); i++) out = out.replaceAll('{{', '{\u200b{');
  return out;
}

/** 防标签逃逸：注入内容里字面的 </system-reminder> 会提前闭合我们自己的框架 */
export function escapeFrameTags(text) {
  return String(text ?? '').replaceAll('</system-reminder>', '<\\/system-reminder>');
}

/** UTF-16 安全截断：尾字符是高位代理就丢掉，防劈开 emoji 导致请求永久 400 */
export function safeSlice(text, maxChars) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  let end = maxChars;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // 尾字符是高位代理 → 连它一起丢
  return s.slice(0, end);
}

/** 同一输入的稳定摘要（用于"内容没变就不重复注入"） */
export function stableHash(text) {
  const s = String(text ?? '');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
}

// ── Standard Schema：不依赖 schemastery 的配置声明 ─────────────────────────
function coerce(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    const expected = typeof DEFAULTS[key];
    if (typeof value !== expected) {
      throw new Error(`memory-lite: config "${key}" 期望 ${expected}，实际 ${typeof value}`);
    }
    if (expected === 'number' && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`memory-lite: config "${key}" 必须是非负有限数`);
    }
    out[key] = value;
  }
  const unknown = Object.keys(source).filter((k) => !(k in DEFAULTS));
  if (unknown.length) throw new Error(`memory-lite: 未知配置项 ${unknown.join(', ')}`);
  return out;
}

/**
 * 配置声明。用 Standard Schema 而不是 schemastery —— 后者在 link: 装法下
 * `ERR_MODULE_NOT_FOUND`，import 它会直接让插件起不来。
 *
 * 注意：DSH 的 Config 校验可能把它当异步 schema 处理，所以 validate 返回 Promise。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'memory-lite',
    validate(value) {
      try {
        return { value: coerce(value) };
      } catch (error) {
        return { issues: [{ message: String(error?.message ?? error) }] };
      }
    },
  },
};

/** apply() 里拿到 config 后自己归一化一次（不依赖宿主替我们校验） */
export function resolveConfig(raw) {
  return coerce(raw);
}
