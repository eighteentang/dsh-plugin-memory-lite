/**
 * index.js —— memory-lite 插件入口
 *
 * 五条实机验证过的写法（都写在这里，改坏了会崩插件或崩整轮会话）：
 *   ① **不静态 import 任何 `@deepseek-ai/*`**：link: 装法下 `schemastery`/`cordis`
 *      解析不到，模块顶层的 import 失败会让插件启动即崩。需要什么就动态 import + try/catch。
 *   ② `apply` 必须是**箭头函数**：cordis 4 会把带 prototype 的 apply 当类构造器 `new apply()`，
 *      返回值被丢弃 → 我们的 disposer 永不执行。
 *   ③ **每个注册独立 try/catch**：重名注册会让整个 profile 加载失败，一个可选插件
 *      不该有这种权力（deja-vu 的 guarded() 就是这个理由）。
 *   ④ 工具参数一律真 JSON Schema（E18：简写注册期通过、模型一调用炸整轮）。
 *   ⑤ 注入只追加、不重复、跳过自己注入的消息（否则自激）。
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

import { Config as MemoryConfig, resolveConfig, redactSecrets, RECALL_RUN_KEEP } from './lib/config.js';
import { openMemory, memoryDirFor, querySegments } from './lib/storage.js';
import { renderIndexSection, renderRecallBlock, renderRecoveryBlock } from './lib/prompt.js';
import { createInjectState, createInjectedMessage, isOwnInjection, lastUserText, stripOwnInjections, pickForInjection, mergeRecallCandidates, memoryFingerprint } from './lib/inject.js';
import { captureTurn, extractTurnText } from './lib/capture.js';
import { buildTools, DESTRUCTIVE_TOOLS, normalizeEntryInput } from './lib/tools.js';
import { readPersona, writePersona, renderPersonaSection } from './lib/persona.js';
import { runDistill, shouldAutoDistill, resolveDistillTargets } from './lib/distill.js';

export const name = 'dsh-plugin-memory-lite';
export const inject = ['tools', 'systemPrompt'];
export { MemoryConfig as Config };

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
/** 人设 / 工作规范存放目录 —— 内容就是那两个文本框的内容，插件自己的文件 */
const PERSONA_DIR = join(DSH_HOME, 'memory-lite', 'persona');

function trace(logger, event, data) {
  try {
    logger?.info?.(`memory-lite: ${event}${data === undefined ? '' : ' ' + JSON.stringify(data)}`);
  } catch {
    /* 日志失败不能连累插件 */
  }
}

/** 注册失败只记录，不让整个 profile 挂掉 */
function guarded(logger, what, fn) {
  try {
    const disposer = fn();
    return typeof disposer === 'function' ? disposer : () => {};
  } catch (error) {
    trace(logger, `${what}-FAILED`, { message: String(error?.message ?? error).slice(0, 300) });
    return () => {};
  }
}

/** 工作区 → 记忆库目录。拿不到工作区时退到 $DSH_HOME 下的哈希目录（不污染用户目录） */
function dirForWorkspace(workspaceRoot, dirName) {
  const direct = memoryDirFor(workspaceRoot, dirName);
  if (direct) return direct;
  const key = workspaceRoot ? createHash('sha1').update(String(workspaceRoot)).digest('hex').slice(0, 12) : 'global';
  return join(DSH_HOME, 'memory-lite', key);
}

export const apply = (ctx, rawConfig = {}) => {
  const config = (() => {
    try {
      return resolveConfig(rawConfig);
    } catch (error) {
      trace(ctx?.logger, 'config-invalid', { message: String(error?.message ?? error) });
      return resolveConfig({});
    }
  })();

  if (!config.enabled) {
    trace(ctx?.logger, 'disabled');
    return;
  }

  /** 每工作区一个库（惰性打开并缓存） */
  const stores = new Map();
  const seenSeq = new Map();
  const injectState = createInjectState();
  /** 最近一次被 agent 解析到的工作区 —— 面板没有 agent 上下文时的一个兜底 */
  let lastWorkspace = null;

  /**
   * 记忆库注册表：把"哪个目录是记忆库、对应哪个工作区"记在文件里。
   *
   * 为什么需要：设置页面板没有 agent/session 上下文，任何"推断当前工作区"的方案
   * 在冷启动时都会落回 `$DSH_HOME/memory-lite/global` 那个空库 —— 真机踩到过，
   * 表现是"设置页显示 0 条，但数据明明在工作区库里"。
   * 注册表把这件事变成事实记录，而不是运行时推断。
   */
  const REGISTRY_FILE = join(DSH_HOME, 'memory-lite', 'workspaces.json');

  function readRegistry() {
    try {
      const raw = readFileSync(REGISTRY_FILE, 'utf8');
      // ⚠ 必须容忍 BOM：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM（\uFEFF），
      //    JSON.parse 会直接抛 → 若这里静默返回空数组，面板就永远显示 0 条（真机踩到过）。
      const cleaned = raw.replace(/^\uFEFF/, '');
      const parsed = JSON.parse(cleaned);
      return Array.isArray(parsed?.stores) ? parsed.stores : [];
    } catch (error) {
      trace(ctx?.logger, 'registry-read-FAILED', { file: REGISTRY_FILE, message: String(error?.message ?? error).slice(0, 160) });
      return [];
    }
  }

  function rememberStore(dir, workspaceRoot) {
    try {
      const list = readRegistry().filter((s) => String(s.dir).toLowerCase() !== String(dir).toLowerCase());
      list.push({ dir, workspace: workspaceRoot ?? null, seenAt: Date.now() });
      mkdirSync(dirname(REGISTRY_FILE), { recursive: true });
      writeFileSync(REGISTRY_FILE, JSON.stringify({ version: 1, stores: list.slice(-50) }, null, 1), 'utf8');
    } catch (error) {
      trace(ctx?.logger, 'registry-write-FAILED', { message: String(error?.message ?? error).slice(0, 160) });
    }
  }

  function storeFor(workspaceRoot) {
    const dir = dirForWorkspace(workspaceRoot, config.dirName);
    const key = String(dir).toLowerCase();
    if (stores.has(key)) {
      if (workspaceRoot) lastWorkspace = workspaceRoot;
      return stores.get(key);
    }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const memory = openMemory({ dir, workspace: workspaceRoot ?? null, archiveDir: join(dir, 'archive') });
      stores.set(key, memory);
      if (workspaceRoot) {
        lastWorkspace = workspaceRoot;
        // 只登记真正的工作区库；`storeFor(null)` 的 global 回退库不登记，
        // 否则注册表里会出现一个 workspace=null 的条目，在面板里看着像"工作区"
        rememberStore(dir, workspaceRoot);
      }
      trace(ctx?.logger, 'store-opened', { dir });
      return memory;
    } catch (error) {
      trace(ctx?.logger, 'store-open-FAILED', { dir, message: String(error?.message ?? error).slice(0, 200) });
      return null;
    }
  }

  /**
   * 面板/工具用的库解析。
   * ⚠ 不能用 storeFor(null)：那会落到 `$DSH_HOME/memory-lite/global` 这个**回退空库**，
   * 于是设置页永远显示 0 条（真机踩到过：面板读 global，实际数据在工作区库里）。
   * 优先用最近活跃工作区；真没有工作区上下文时才回退 global（最后兜底）。
   */
  function storeForPanel() {
    if (lastWorkspace) {
      const memory = storeFor(lastWorkspace);
      if (memory) return memory;
    }
    return storeFor(null);
  }

  /**
   * 按**目录**打开一个记忆库（带缓存）。
   * 面板列多个库、跨工作区检索都用它 —— 不复用"当前工作区"的推断，
   * 因为那正是当初"面板显示 0 条"的根因。
   */
  function storeByDir(dir) {
    const key = `dir:${String(dir).toLowerCase()}`;
    if (stores.has(key)) return stores.get(key);
    try {
      const memory = openMemory({ dir, workspace: null, archiveDir: join(dir, 'archive') });
      stores.set(key, memory);
      return memory;
    } catch (error) {
      trace(ctx?.logger, 'store-open-by-dir-FAILED', { dir, message: String(error?.message ?? error).slice(0, 160) });
      return null;
    }
  }

  /**
   * 用户级（跨工作区）记忆库 —— 目录就是 `dirForWorkspace(null)` 的现成路径
   * （`$DSH_HOME/memory-lite/global`），**不发明新位置**。
   *
   * ⚠ 这里刻意**不登记进注册表**：注册表是"工作区库"的清单，混进一个 workspace=null
   * 的条目会让面板看着像多了一个工作区（这是当初"面板显示 0 条"那个坑的邻居）。
   * 面板要显示它，走 listKnownStores 里显式加的那一条（`kind:'user'`）。
   *
   * 用 storeFor(null) 而不是 storeByDir()：两者缓存键不同（`dir:` 前缀 vs 裸路径），
   * 同一目录会被打开成两个数据库句柄。
   */
  function globalStoreFor() {
    if (!config.globalMemory) return null;
    return storeFor(null);
  }

  /** 用户级库的目录（不论开关） */
  function globalMemoryDir() {
    return dirForWorkspace(null, config.dirName);
  }

  function workspaceOf(agent) {
    try {
      const cwd = agent?.session?.header?.cwd;
      return typeof cwd === 'string' && cwd.trim() && existsSync(cwd) ? cwd : null;
    } catch {
      return null;
    }
  }

  /**
   * V2-4 跨工作区检索：列出"已知的全部记忆库"。
   * 复用面板那套发现逻辑（注册表 + 扫描 + 库内 meta），
   * 这样"跨库搜索"和"面板显示"看到的是同一组库 —— 不一致会让人怀疑数据丢了。
   */
  function listAllStores() {
    const out = [];
    const seen = new Set();
    const push = (dir, label) => {
      if (!dir) return;
      const key = String(dir).toLowerCase();
      if (seen.has(key)) return;
      if (!existsSync(join(dir, 'memory.db'))) return;
      const memory = storeByDir(dir);
      if (!memory) return;
      seen.add(key);
      out.push({ label: label ?? memory.getMeta('workspace') ?? dir, workspace: memory.getMeta('workspace') ?? null, memory });
    };
    try {
      for (const entry of readRegistry()) push(entry.dir, entry.workspace ?? null);
    } catch {
      /* 忽略 */
    }
    for (const info of knownStoreDirs()) push(info.dir, info.workspace ?? null);
    if (lastWorkspace) push(dirForWorkspace(lastWorkspace, config.dirName), lastWorkspace);
    // V1.7：用户级库也要能被 scope="all" 搜到 —— 它不在注册表里（有意），所以这里显式补上
    // （不补的话"跨工作区检索"会漏掉唯一真正跨工作区的那一份）
    const gdir = globalMemoryDir();
    if (config.globalMemory && existsSync(join(gdir, 'memory.db'))) {
      const gmem = globalStoreFor();
      if (gmem && !out.some((s) => s.memory === gmem)) {
        out.push({ label: '用户级（跨工作区）', workspace: null, kind: 'user', memory: gmem });
      }
    }
    return out;
  }

  /**
   * 扫描 $DSH_HOME/memory-lite/* 下的库目录（并读库内 meta 还原工作区名）。
   * 与 listKnownStores 的区别：那个是给面板的"仅工作区库"视图，这个不做过滤。
   */
  function knownStoreDirs() {
    const found = [];
    const root = join(DSH_HOME, 'memory-lite');
    try {
      if (existsSync(root)) {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const dir = join(root, entry.name);
          if (!existsSync(join(dir, 'memory.db'))) continue;
          let ws = null;
          try {
            const memory = storeByDir(dir);
            ws = memory?.getMeta('workspace') ?? null;
          } catch {
            /* 忽略 */
          }
          found.push({ dir, workspace: ws });
        }
      }
    } catch {
      /* 忽略 */
    }
    return found;
  }

  const disposers = [];

  // ── 1. 工具 ─────────────────────────────────────────────────────────────
  disposers.push(
    guarded(ctx?.logger, 'tools', () => {
      const tools = ctx.tools;
      if (!tools?.register) throw new Error('ctx.tools.register 不可用');
      const registry = storeForPanel();
      if (!registry) throw new Error('记忆库打不开');
      // 注册只做一次；记忆库按调用上下文解析（多工作区 → 多库）
      const definitions = buildTools({
        memory: registry,
        config,
        // V1.7：显式 scope —— "user" 走用户级库（跨工作区），其余走当前工作区库
        resolveMemory: (exec, opts) => (opts?.scope === 'user' ? globalStoreFor() ?? storeFor(workspaceOf(exec?.agent)) : storeFor(workspaceOf(exec?.agent))),
        // V1.7：按 id 的工具（read/update/forget）自动认库 —— 主库里没有就回退用户级库
        fallbackMemory: () => globalStoreFor(),
        // V2-4：跨工作区检索用 —— 让工具能看到全部已知库
        listStores: () => listAllStores(),
        findStoreByLabelOrDir: (needle) => {
          if (!needle) return null;
          const all = listAllStores();
          const hit = all.find((s) => String(s.label).toLowerCase() === String(needle).toLowerCase())
            ?? all.find((s) => String(s.workspace ?? '').toLowerCase() === String(needle).toLowerCase())
            ?? all.find((s) => String(s.label ?? '').toLowerCase().includes(String(needle).toLowerCase()));
          return hit?.memory ?? null;
        },
      });
      const cleanup = definitions.map((tool) =>
        tools.register({
          ...tool,
          async execute(args, exec) {
            return tool.execute(args, exec);
          },
        }),
      );
      trace(ctx?.logger, 'tools-registered', { count: cleanup.length });
      return () => cleanup.forEach((d) => { try { d?.(); } catch { /* 忽略 */ } });
    }),
  );

  // ── 2. 破坏性操作的宿主审批闸门 ─────────────────────────────────────────
  disposers.push(
    guarded(ctx?.logger, 'pre-execute-gate', () =>
      ctx.on('tools/pre-execute', async (exec, next) => {
        const decision = await next();
        if (decision?.kind !== 'allow') return decision;
        if (DESTRUCTIVE_TOOLS.has(exec?.name)) {
          return { kind: 'ask', reason: `memory-lite: ${exec.name} 会永久删除记忆条目，需要你确认。` };
        }
        return decision;
      }),
    ),
  );

  // ── 3. 常驻索引段（字节稳定）────────────────────────────────────────────
  disposers.push(
    guarded(ctx?.logger, 'index-section', () => {
      const section = ctx.systemPrompt?.section;
      if (typeof section !== 'function') throw new Error('ctx.systemPrompt.section 不可用');
      const raw = typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOLS_SDK') : 4000;
      const order = Number.isFinite(raw) ? raw : 4000;
      // 段文本按当前 agent 的工作区求值；同一组条目必须产出同一字节
      return section({
        name: 'memory-lite:index',
        order,
        interpolate: false, // 防记忆正文里的 {{ }} 让组装抛异常
        text: (assembly) => {
          try {
            const agent = assembly?.agent;
            const memory = storeFor(workspaceOf(agent));
            if (!memory) return '（记忆库暂不可用）';
            const entries = memory.list({ status: 'active', limit: 400 });
            return renderIndexSection({ entries });
          } catch (error) {
            trace(ctx?.logger, 'index-render-FAILED', { message: String(error?.message ?? error).slice(0, 200) });
            return '（记忆库读取失败）';
          }
        },
      });
    }),
  );

  // ── 3·五. 人设 / 工作规范段（V1.6：插件自己的文件，注入到框架的人设位置）──────
  // 为什么用 systemPrompt 段落而不是写进用户的 AGENTS.md：
  //   框架自己就有人设槽位（SECTION_ORDERS 里的 DEPLOYMENT_PERSONA_PREFIX = 0、后缀 = 10200），
  //   而 `systemPrompt.section` 正是"每轮必到"的机制。第一版我去改写用户的 AGENTS.md 并
  //   用自加的 `### 标题` 当锚点，于是"标题不能删"变成了对用户的约束（用户原话：不合理）。
  //   现在：内容存在插件自己的两个 .md 文件里（文件内容 = 文本框内容，零解析），
  //   段落紧跟框架的人设前缀（order + 1），保存后下一轮立刻生效。
  disposers.push(
    guarded(ctx?.logger, 'persona-section', () => {
      const section = ctx.systemPrompt?.section;
      if (typeof section !== 'function') throw new Error('ctx.systemPrompt.section 不可用');
      const base = typeof ctx.systemPrompt.getSectionOrder === 'function'
        ? ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')
        : 0;
      const order = (Number.isFinite(base) ? base : 0) + 1; // 紧跟框架自己的人设段
      return section({
        name: 'memory-lite:persona',
        order,
        interpolate: false, // 人设正文里可能有 {{ }}；这里不做变量插值
        text: () => {
          try {
            return renderPersonaSection(readPersona(PERSONA_DIR));
          } catch (error) {
            trace(ctx?.logger, 'persona-render-FAILED', { message: String(error?.message ?? error).slice(0, 200) });
            return '';
          }
        },
      });
    }),
  );

  // ── 4. 每轮自动落日志（第 1 档，零 LLM 成本）────────────────────────────
  disposers.push(
    guarded(ctx?.logger, 'capture', () =>
      ctx.on('agent/turn-stopping', (payload) => {
        try {
          // V2-2：刷新"最后活动时间"——空闲自动整理靠它判断"是不是真的闲了"
          lastActivityAt = Date.now();
          const agent = payload?.agent;
          if (!config.autoCapture) return;
          const session = agent?.session;
          const sessionId = session?.id ?? agent?.id;
          if (!sessionId) return;
          const memory = storeFor(workspaceOf(agent));
          if (!memory) return;
          // 水位：先看进程内存，再看库里持久化的那份。
          // ⚠ 实测教训：`seenSeq` 是**进程内存里的 Map** —— 插件一重启（或压缩后事件
          //   重新物化）就归零，下一轮把**整段历史**又存一遍。实测相邻两条日志里
          //   6/9 对满足"后一条完整包含前一条"，日志层因此膨胀、蒸馏输入被重复内容主导。
          let since = seenSeq.get(sessionId);
          if (since === undefined) {
            const persisted = Number(memory.getMeta?.(`watermark:${sessionId}`));
            since = Number.isFinite(persisted) && persisted >= 0 ? persisted : -1;
          }
          let { text, untilSeq, maxSeqAll } = extractTurnText(session, since);
          // 守卫：压缩后快照重新物化时事件编号可能变小，那时持久化水位会让本轮
          // **一条都抽不出来**（静默丢内容）。发现"最大 seq 比水位还小"就丢掉水位重来 ——
          // 重来会带进整段历史，但 captureTurn 里的"与上一条去重"会把重复部分切掉。
          // 分工：水位负责**省事**，内容比对负责**正确**。
          if (since > 0 && maxSeqAll >= 0 && maxSeqAll < since) {
            trace(ctx?.logger, 'capture-watermark-reset', { sessionId, since, maxSeqAll });
            since = -1;
            ({ text, untilSeq, maxSeqAll } = extractTurnText(session, -1));
          }
          if (untilSeq > since) {
            seenSeq.set(sessionId, untilSeq);
            try {
              memory.setMeta?.(`watermark:${sessionId}`, String(untilSeq));
            } catch {
              /* 水位写不进去就退回内存水位，不影响本轮落盘 */
            }
          }
          const result = captureTurn({
            memory,
            sessionId,
            workspace: workspaceOf(agent),
            turn: payload?.turn ?? null,
            text,
            enabled: true,
          });
          trace(ctx?.logger, 'capture', { sessionId, ...result, chars: result.chars ?? 0 });
        } catch (error) {
          trace(ctx?.logger, 'capture-FAILED', { message: String(error?.message ?? error).slice(0, 200) });
        }
      }),
    ),
  );

  // ── 5. 每轮召回注入（尾部追加，跳过自己注入的）──────────────────────────
  disposers.push(
    guarded(ctx?.logger, 'recall-inject', () =>
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        try {
          if (!config.autoRecall) return decision;
          if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;

          const agent = payload?.agent;
          const sessionId = agent?.session?.id ?? agent?.id ?? 'unknown';
          const memory = storeFor(workspaceOf(agent));
          if (!memory) return decision;

          // ③ 自抑制：候选里先剔除自己注入过的，再取最后一条真实用户消息当 query
          const incoming = stripOwnInjections(decision.messages);
          const query = lastUserText(incoming);
          if (!query || query.length < 4) return decision;

          // V1.7：候选 = 当前工作区库 + 用户级库（合并去重、共享名额）。
          // 顺序有意为之：工作区放第 0 个 —— 同分时它优先（"项目里的事"比"用户级的事"更具体）。
          const sources = [{ memory, tag: 'workspace' }];
          const userMemory = globalStoreFor();
          if (userMemory && userMemory !== memory) sources.push({ memory: userMemory, tag: 'user' });
          const candidates = mergeRecallCandidates(sources, query, { limitPerStore: 12 });
          const picked = pickForInjection(candidates, {
            sessionId,
            seen: injectState.seen(sessionId),
            maxItems: config.injectMaxItems,
          });
          // V3 召回观测：**每一轮都记**，包括"搜到了但都被注入过"和"0 命中"这两种。
          // 0 命中是最需要的样本 —— 它正是"换个说法就搜不到"的直接证据。
          try {
            memory.recordRecallRun({
              sessionId,
              turn: payload?.turn ?? null,
              query: redactSecrets(query),
              segments: querySegments(query).length,
              hits: candidates.length,
              picked: picked.length,
              keep: RECALL_RUN_KEEP,
            });
          } catch (error) {
            trace(ctx?.logger, 'record-recall-FAILED', { message: String(error?.message ?? error).slice(0, 160) });
          }
          if (!picked.length) return decision;

          const text = renderRecallBlock(picked, { maxChars: config.injectMaxChars });
          if (!text) return decision;

          const message = createInjectedMessage(text, { form: 'recall' });
          // ② 只追加：插在"本轮已领取消息"之后（照官方 dsh-agent-instructions 的位置）
          const claimed = payload?.messages ?? [];
          const lastClaimed = decision.messages.findLastIndex((m) => claimed.includes(m));
          const entered = decision.messages.toSpliced(lastClaimed + 1, 0, message);
          injectState.mark(sessionId, picked.map((p) => p.id));
          // V2-1 注入可见性：逐轮记账（面板据此显示"这条被用过几次 / 最近一次"）
          // ⚠ V1.7 起要**按条目所属的库**分开记：
          //   · injections 日志行记在工作区库（会话在哪就记在哪，面板读的是它）
          //   · 用户级条目的 inject_count 必须落在用户级库 —— 否则面板上它永远是"未用过"
          const userIds = picked.filter((p) => p._scope === 'user').map((p) => p.id);
          try {
            memory.recordInjection({
              sessionId,
              workspace: workspaceOf(agent),
              form: 'recall',
              entryIds: picked.filter((p) => p._scope !== 'user').map((p) => p.id),
              chars: text.length,
            });
          } catch (error) {
            trace(ctx?.logger, 'record-injection-FAILED', { message: String(error?.message ?? error).slice(0, 160) });
          }
          if (userIds.length && userMemory) {
            try {
              userMemory.bumpInjected(userIds);
            } catch (error) {
              trace(ctx?.logger, 'record-user-injection-FAILED', { message: String(error?.message ?? error).slice(0, 160) });
            }
          }
          trace(ctx?.logger, 'recall-injected', {
            sessionId,
            ids: picked.map((p) => p.id),
            fromUser: userIds.length,
            chars: text.length,
          });
          return { ...decision, messages: entered };
        } catch (error) {
          trace(ctx?.logger, 'recall-FAILED', { message: String(error?.message ?? error).slice(0, 200) });
          return decision; // 出错时原样返回，绝不改坏 decision
        }
      }),
    ),
  );

  // ── 6. 压缩后补回（压缩即失忆，所以要把常驻内容重新交回去）──────────────
  disposers.push(
    guarded(ctx?.logger, 'compaction', () => {
      const pending = new Set();
      const stopEvent = ctx.on('session/event', (session, event) => {
        try {
          const type = String(event?.type ?? '');
          if (!type.startsWith('compaction/')) return;
          const sessionId = session?.id ?? 'unknown';
          injectState.reset(sessionId); // 压缩后"注入过"的记录不再成立
          if (type === 'compaction/summary' || type === 'compaction/end') pending.add(sessionId);
        } catch {
          /* 忽略 */
        }
      });
      const stopStep = ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        try {
          const sessionId = payload?.agent?.session?.id ?? payload?.agent?.id ?? 'unknown';
          if (!pending.has(sessionId) || decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
          pending.delete(sessionId);
          const memory = storeFor(workspaceOf(payload?.agent));
          if (!memory) return decision;
          // 压缩后补回「常驻层」（user/rules + 重要性≥3 的条目）
          // V1.7：用户级库的常驻条目也要补回（那正是"用户级长期记忆"的意义 ——
          //   压缩后不能只把工作区的东西捡回来）。判重仍用内容指纹：两个库的 id 不同。
          const residentOf = (mem, tag) => (mem ? [
            ...mem.activeOf('user'),
            ...mem.activeOf('rules'),
            ...mem.list({ status: 'active', limit: 60 }).filter((e) => e.importance >= 3),
          ].map((e) => ({ ...e, _scope: tag })) : []);
          const userMem = globalStoreFor();
          const resident = [
            ...residentOf(memory, 'workspace'),
            ...(userMem && userMem !== memory ? residentOf(userMem, 'user') : []),
          ].filter((e, i, arr) => !e.sensitive && arr.findIndex((x) => memoryFingerprint(x) === memoryFingerprint(e)) === i);
          const text = renderRecoveryBlock(resident.slice(0, config.injectMaxItems + 2), { maxChars: config.injectMaxChars });
          if (!text) return decision;
          const message = createInjectedMessage(text, { form: 'recovery' });
          const claimed = payload?.messages ?? [];
          const lastClaimed = decision.messages.findLastIndex((m) => claimed.includes(m));
          injectState.mark(sessionId, resident.map((r) => r.id));
          try {
            memory.recordInjection({
              sessionId,
              workspace: workspaceOf(payload?.agent),
              form: 'recovery',
              entryIds: resident.filter((r) => r._scope !== 'user').map((r) => r.id),
              chars: text.length,
            });
          } catch (error) {
            trace(ctx?.logger, 'record-recovery-FAILED', { message: String(error?.message ?? error).slice(0, 160) });
          }
          const userResidentIds = resident.filter((r) => r._scope === 'user').map((r) => r.id);
          if (userResidentIds.length && userMem) {
            try {
              userMem.bumpInjected(userResidentIds);
            } catch {
              /* 计数失败不影响注入 */
            }
          }
          trace(ctx?.logger, 'recovery-injected', { sessionId, count: resident.length, fromUser: userResidentIds.length });
          return { ...decision, messages: decision.messages.toSpliced(lastClaimed + 1, 0, message) };
        } catch (error) {
          trace(ctx?.logger, 'recovery-FAILED', { message: String(error?.message ?? error).slice(0, 200) });
          return decision;
        }
      });
      return () => {
        stopEvent?.();
        stopStep?.();
      };
    }),
  );

  // ── 7. 空闲自动整理（V2-2）──────────────────────────────────────────────
  // 设计：在"最近没有对话"时才跑，且有三道成本闸门（空闲时长 / 冷却 / 日配额）。
  // 依据：meow 的 dream 就是这么做的（空闲 180 分钟 + 避开高峰时段），我们取更宽松的空闲阈值。
  let lastActivityAt = Date.now();   // 任何一轮结束都会刷新它
  disposers.push(
    guarded(ctx?.logger, 'idle-distill', () => {
      if (!config.autoDistill) {
        trace(ctx?.logger, 'distill-off', { hint: 'config.autoDistill=false；要开启请在 profile 的 config 里设 true' });
        return () => {};
      }
      let running = false;

      // 每 5 分钟检查一次（检查本身几乎零成本，真正的闸门在 shouldAutoDistill 里）
      const timer = setInterval(async () => {
        if (running) return;
        try {
          const memory = storeForPanel();
          if (!memory) return;
          // 闸门判断抽在 distill.js 里，接口可测（见 verify-v2.mjs）
          const verdict = shouldAutoDistill({ memory, config, lastActivityAt: lastActivityAt });
          if (!verdict.run) {
            if (verdict.reason !== 'not-idle') trace(ctx?.logger, 'distill-skip', verdict);
            return;
          }
          running = true;
          const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
          const result = await runDistill({ memory, config, llm: llm ?? ctx.llm, force: true });
          trace(ctx?.logger, result.ok ? 'distill-done' : 'distill-skipped', { ...result, idleFor: verdict.idleMs });
        } catch (error) {
          trace(ctx?.logger, 'distill-FAILED', { message: String(error?.message ?? error).slice(0, 200) });
        } finally {
          running = false;
        }
      }, 5 * 60 * 1000);
      return () => clearInterval(timer);
    }),
  );

  // ── 8. 设置页数据通道：宿主 HTTP 路由（客户端同源 fetch）──────────────────
  // 为什么不用官方 `remote`：RPC 需要 `TypertRemoteService` 基类，而那个包在 link:
  // 装法下解析不到。第三方插件的通用做法是走宿主 webServer 路由（Aik358 约 40 条路由）。
  disposers.push(
    guarded(ctx?.logger, 'web-routes', () => {
      const API_PREFIX = '/dsh-memory-lite/api';

      /**
       * 发现式定位：列出磁盘上**所有**记忆库，而不是猜"哪个工作区在活跃"。
       *
       * 为什么这么做：面板没有 agent/session 上下文，任何"推断当前工作区"的方案
       * 都会在冷启动时落回 `$DSH_HOME/memory-lite/global` 那个空库
       * （真机踩到：面板显示 0 条，实际数据在工作区库里）。
       * 列全部 → 客户端按库名分组显示，对"谁活跃"零依赖。
       */
      const listKnownStores = () => {
        const found = [];
        const find = (dir) => found.find((f) => f.dir.toLowerCase() === String(dir).toLowerCase());
        const add = (dir, workspaceHint = null) => {
          if (!dir) return;
          const dbFile = join(dir, 'memory.db');
          if (!existsSync(dbFile)) return;
          if (find(dir)) return;
          // 工作区名优先用注册表里的提示；否则读库内 meta（库自己记着 workspace）
          let workspace = workspaceHint;
          if (!workspace) {
            try {
              const memory = openMemory({ dir, archiveDir: join(dir, 'archive') });
              workspace = memory.getMeta('workspace');
              memory.close();
            } catch {
              workspace = null;
            }
          }
          // V1.7：用户级库（workspace=null 的那份）也要给面板看 —— 否则用户在面板里
          // 永远看不到自己刚写进去的用户级记忆，只能靠搜
          const isUserLevel = String(dir).toLowerCase() === globalMemoryDir().toLowerCase();
          found.push({
            dir,
            workspace: workspace ?? null,
            label: isUserLevel ? '用户级（跨工作区）' : (workspace ?? dir),
            kind: isUserLevel ? 'user' : 'workspace',
          });
        };

        // ① 权威来源：注册表（storeFor 每次打开工作区库都会登记）
        for (const entry of readRegistry()) add(entry.dir, entry.workspace ?? null);
        // ② 本次运行解析过的工作区
        if (lastWorkspace) add(dirForWorkspace(lastWorkspace, config.dirName), lastWorkspace);
        // ③ $DSH_HOME/memory-lite/* 下的全部（含 global 与按哈希分目录的工作区库）
        const root = join(DSH_HOME, 'memory-lite');
        try {
          if (existsSync(root)) {
            for (const entry of readdirSync(root, { withFileTypes: true })) {
              if (entry.isDirectory()) add(join(root, entry.name));
            }
          }
        } catch {
          /* 忽略 */
        }
        // 只把"真正的工作区库"和"用户级库"给面板看（其他哈希目录是拿不到工作区时的兜底）
        return found.filter((f) => f.workspace || f.kind === 'user');
      };

      const snapshotOf = (memory) => ({
        ok: true,
        dbPath: memory.dbPath,
        workspace: memory.getMeta('workspace') ?? null,
        stats: memory.stats(),
        entries: memory.list({ status: null, limit: 1000 }).map((e) => ({
          id: e.id,
          level: e.level,
          title: e.title,
          content: String(e.content).slice(0, 800),
          keywords: e.keywords,
          importance: e.importance,
          status: e.status,
          project: e.project,
          subcategory: e.subcategory,
          goal: e.goal,
          sensitive: e.sensitive,
          corrected: e.corrected,
          // V2-1：注入可见性 —— 面板据这两个字段显示"用过几次 / 最近一次"
          injectCount: e.injectCount ?? 0,
          lastInjectedAt: e.lastInjectedAt ?? null,
          hitCount: e.hitCount ?? 0,
          updatedAt: e.updatedAt,
        })),
      });

      /** 全库汇总：每个记忆库一份快照，客户端按库分组显示 */
      const snapshotAll = () => {
        const known = listKnownStores();
        const stores_ = [];
        const seen = new Set();
        for (const info of known) {
          const memory = storeByDir(info.dir);
          if (!memory) continue;
          if (seen.has(memory.dbPath.toLowerCase())) continue;
          seen.add(memory.dbPath.toLowerCase());
          stores_.push({ label: info.label, kind: info.kind ?? 'workspace', dir: info.dir, ...snapshotOf(memory) });
        }
        if (!stores_.length) {
          const fallback = storeForPanel();
          if (fallback) stores_.push({ label: 'fallback', ...snapshotOf(fallback) });
        }
        return { ok: true, stores: stores_, total: stores_.reduce((a, s) => a + (s.entries?.length ?? 0), 0) };
      };

      /** 极简 handler：返回 JSON。签名按“字段存在即用”的方式探测，不假设单一形态。 */
      const makeHandler = (fn) => async (req, res) => {
        const send = (code, payload) => {
          try {
            if (typeof res?.writeHead === 'function') {
              res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify(payload));
              return;
            }
            // 有些形态把响应交给 handler 自己返回
            if (typeof res?.setHeader === 'function' && typeof res?.end === 'function') {
              res.setHeader('content-type', 'application/json; charset=utf-8');
              res.statusCode = code;
              res.end(JSON.stringify(payload));
            }
          } catch (error) {
            trace(ctx?.logger, 'web-route-send-FAILED', { message: String(error?.message ?? error) });
          }
        };
        try {
          const body = await fn(req);
          send(200, body);
        } catch (error) {
          send(500, { ok: false, error: String(error?.message ?? error) });
        }
      };

      const readBody = async (req) => {
        try {
          if (req?.body && typeof req.body === 'object') return req.body;
          if (typeof req?.json === 'function') return await req.json();
          if (typeof req?.[Symbol.asyncIterator] === 'function') {
            let raw = '';
            for await (const chunk of req) raw += chunk;
            return raw ? JSON.parse(raw) : {};
          }
        } catch {
          /* 解析失败当空体 */
        }
        return {};
      };

      /** 从请求里取目标库目录（客户端点某条记忆时会带上它所在的库） */
      const dirFromRequest = (req, body) => {
        try {
          const url = String(req?.url ?? '');
          const q = url.includes('?') ? new URLSearchParams(url.slice(url.indexOf('?') + 1)) : null;
          const fromQuery = q?.get('dir');
          if (fromQuery) return fromQuery;
        } catch {
          /* 忽略 */
        }
        const fromBody = body?.dir;
        return typeof fromBody === 'string' && fromBody ? fromBody : null;
      };

      /** 按目录或当前工作区解析库；都没有时回退 */
      const resolveRouteStore = (dir) => (dir ? storeByDir(dir) : storeForPanel());

      return ctx.inject(['webServer'], (child) => {
        const server = child?.get?.('webServer');
        if (!server?.register) throw new Error('webServer.register 不可用');
        const routes = [
          server.register({
            kind: 'exact',
            path: `${API_PREFIX}/snapshot`,
            // 返回**所有**已知记忆库（客户端按库分组）—— 不猜哪个工作区在活跃
            handler: makeHandler(async () => snapshotAll()),
          }),
          server.register({
            kind: 'exact',
            path: `${API_PREFIX}/set-status`,
            handler: makeHandler(async (req) => {
              const body = await readBody(req);
              const memory = resolveRouteStore(dirFromRequest(req, body));
              if (!memory) return { ok: false, error: '记忆库不可用' };
              const next = memory.update(String(body.id ?? ''), { status: String(body.status ?? 'active') });
              return { ok: true, entry: { id: next.id, status: next.status } };
            }),
          }),
          server.register({
            kind: 'exact',
            path: `${API_PREFIX}/save`,
            /**
             * 面板里"新增 / 编辑一条记忆"（V3.1）。
             *
             * 两条硬约束：
             *   ① **写哪个库必须由调用方指定**（`dir`）。面板没有 agent 上下文，
             *      "推断当前工作区"在冷启动时必然落回 `$DSH_HOME/memory-lite/global`
             *      那个空库（V2 真机踩过：面板显示 0 条）。所以多库环境下没带 dir 就直接拒，
             *      **不猜**。
             *   ② 校验走 `normalizeEntryInput()` —— 与对话里的 `memory_note` **同一套规则**，
             *      避免"对话写不进去的、面板能写进去"。
             */
            handler: makeHandler(async (req) => {
              const body = await readBody(req);
              // V1.7：写哪个库要**显式**指定 —— scope="user" 写用户级库；否则按 dir 定位工作区库。
              const scope = body?.scope === 'user' ? 'user' : 'workspace';
              const dir = dirFromRequest(req, body);
              let memory;
              if (scope === 'user') {
                memory = globalStoreFor();
                if (!memory) return { ok: false, error: '用户级记忆库不可用（config.globalMemory 关着？）' };
              } else {
                if (!dir) {
                  // ⚠ 只数**工作区库**：用户级库是另一个目标（由 scope 选），不算"歧义"
                  const known = listKnownStores().filter((k) => k.kind !== 'user');
                  if (known.length !== 1) {
                    return {
                      ok: false,
                      error: `需要先指定记忆库（发现 ${known.length} 个工作区库，不允许猜）`,
                      stores: known.map((k) => k.label),
                    };
                  }
                }
                memory = resolveRouteStore(dir);
              }
              if (!memory) return { ok: false, error: '记忆库不可用' };

              const normalized = normalizeEntryInput(body);
              if (normalized.error) return { ok: false, error: normalized.error };

              const id = body?.id ? String(body.id) : null;
              try {
                const entry = id ? memory.update(id, normalized.value) : memory.put(normalized.value);
                return {
                  ok: true,
                  created: !id,
                  scope,
                  entry: {
                    id: entry.id,
                    level: entry.level,
                    status: entry.status,
                    sensitive: entry.sensitive,
                    injectCount: entry.injectCount ?? 0,
                  },
                };
              } catch (error) {
                return { ok: false, error: String(error?.message ?? error) };
              }
            }),
          }),
          server.register({
            kind: 'exact',
            path: `${API_PREFIX}/persona`,
            /**
             * 读 / 写「人设设定」与「工作规范与行为准则」（V1.6）。
             *
             * 内容存在插件自己的目录里（`$DSH_HOME/memory-lite/persona/*.md`），
             * **文件内容 = 文本框内容**：不解析、不加标记、不要求任何标题。
             * （V1.5 那版写的是宿主的 AGENTS.md，还要求用户保留我加的 `### 标题` —— 已废弃。）
             *
             * 写之前先备份；带 mtime 的乐观并发：该槽位文件被别处改过就拒绝这次写入，
             * 让人先刷新 —— 否则会把手改的内容覆盖掉。
             */
            handler: makeHandler(async (req) => {
              const method = String(req?.method ?? 'GET').toUpperCase();
              if (method !== 'POST') return readPersona(PERSONA_DIR);

              const body = await readBody(req);
              const slot = String(body?.slot ?? '');
              const current = readPersona(PERSONA_DIR);
              if (!current.ok) return current;
              if (!Object.hasOwn(current.mtimes, slot)) return { ok: false, error: 'slot 必须是 persona 或 rules' };
              if (body?.mtime !== undefined && Number(body.mtime) !== Number(current.mtimes[slot])) {
                return {
                  ok: false,
                  error: '这个文件刚被别处改过（可能是你手工编辑，或另一个会话），请点「重新读取」再保存',
                  mtimes: current.mtimes,
                };
              }
              const out = writePersona(PERSONA_DIR, slot, String(body?.text ?? ''));
              if (!out.ok) return out;
              const fresh = readPersona(PERSONA_DIR);
              return { ...out, mtimes: fresh.ok ? fresh.mtimes : null };
            }),
          }),
          server.register({
            kind: 'exact',
            path: `${API_PREFIX}/llm-probe`,
            // 诊断路由：宿主这边到底注册了哪些提供方、各自有哪些模型。
            // 加它的理由：蒸馏第一次真机失败是 `NO_ADAPTER: provider "undefined"`，
            // 而当时我**看不到这台机器上实际有哪些路由可用**，只能靠猜。
            handler: makeHandler(async () => {
              const llm = typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm;
              if (!llm) return { ok: false, error: 'ctx.llm 不可用' };
              let providers = [];
              try {
                providers = typeof llm.listProviders === 'function' ? llm.listProviders() : [];
              } catch (error) {
                return { ok: false, error: `listProviders 失败：${String(error?.message ?? error).slice(0, 200)}` };
              }
              if (!Array.isArray(providers)) providers = [];
              // ⚠ listProviders() 返回的是**对象数组**（路由名在 `.id`），不是字符串数组。
              //   这里同时给出扁平名字与原始对象：前者给人看，后者证明形状。
              const providerIds = providers
                .map((p) => (typeof p === 'string' ? p : typeof p?.id === 'string' ? p.id : null))
                .filter(Boolean);
              const models = {};
              for (const p of providerIds) {
                try {
                  const list = typeof llm.listModels === 'function' ? await llm.listModels(p) : [];
                  models[p] = (Array.isArray(list) ? list : []).slice(0, 8).map((m) => ({ id: m?.id, name: m?.name }));
                } catch (error) {
                  models[p] = `失败：${String(error?.message ?? error).slice(0, 120)}`;
                }
              }
              const resolvedTargets = await resolveDistillTargets({ llm, config });
              return { ok: true, providers, providerIds, models, resolvedTargets };
            }),
          }),
          server.register({
            kind: 'exact',
            path: `${API_PREFIX}/distill`,
            handler: makeHandler(async (req) => {
              const body = await readBody(req);
              const memory = resolveRouteStore(dirFromRequest(req, body));
              if (!memory) return { ok: false, error: '记忆库不可用' };
              const result = await runDistill({ memory, config, llm: ctx.get?.('llm') ?? ctx.llm, force: true });
              return { ok: Boolean(result.ok), result };
            }),
          }),
        ];
        trace(ctx?.logger, 'web-routes-registered', { prefix: API_PREFIX, count: routes.length });
        return () => routes.forEach((r) => { try { r?.(); } catch { /* 忽略 */ } });
      });
    }),
  );

  // ── 9. 宿主侧自省对象（调试与将来的 remote 用）───────────────────────────
  disposers.push(
    guarded(ctx?.logger, 'introspect', () => {
      ctx.memoryLite = {
        config,
        storeFor,
        dirForWorkspace: (ws) => dirForWorkspace(ws, config.dirName),
      };
      return () => {
        try { delete ctx.memoryLite; } catch { /* 忽略 */ }
      };
    }),
  );

  // ── 统一释放：注册要有 owner，卸载时全部撤掉 ────────────────────────────
  ctx.effect?.(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.();
      } catch {
        /* 卸载期静默 */
      }
    }
    for (const memory of stores.values()) {
      try {
        memory.close();
      } catch {
        /* 忽略 */
      }
    }
    stores.clear();
    trace(ctx?.logger, 'disposed');
  });

  trace(ctx?.logger, 'ready', { dirName: config.dirName, autoCapture: config.autoCapture, autoRecall: config.autoRecall, autoDistill: config.autoDistill });
};

export default { name, inject, Config: MemoryConfig, apply };
