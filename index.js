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
import { createInjectState, createInjectedMessage, isOwnInjection, lastUserText, stripOwnInjections, pickForInjection } from './lib/inject.js';
import { captureTurn, extractTurnText } from './lib/capture.js';
import { buildTools, DESTRUCTIVE_TOOLS } from './lib/tools.js';
import { runDistill, shouldAutoDistill, resolveDistillTargets } from './lib/distill.js';

export const name = 'dsh-plugin-memory-lite';
export const inject = ['tools', 'systemPrompt'];
export { MemoryConfig as Config };

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');

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
        resolveMemory: (exec) => storeFor(workspaceOf(exec?.agent)),
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
          const since = seenSeq.get(sessionId) ?? -1;
          const { text, untilSeq } = extractTurnText(session, since);
          if (untilSeq > since) seenSeq.set(sessionId, untilSeq);
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

          const candidates = memory.search(query, { status: 'active', limit: 12 });
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
          try {
            memory.recordInjection({
              sessionId,
              workspace: workspaceOf(agent),
              form: 'recall',
              entryIds: picked.map((p) => p.id),
              chars: text.length,
            });
          } catch (error) {
            trace(ctx?.logger, 'record-injection-FAILED', { message: String(error?.message ?? error).slice(0, 160) });
          }
          trace(ctx?.logger, 'recall-injected', { sessionId, ids: picked.map((p) => p.id), chars: text.length });
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
          const resident = [
            ...memory.activeOf('user'),
            ...memory.activeOf('rules'),
            ...memory.list({ status: 'active', limit: 60 }).filter((e) => e.importance >= 3),
          ].filter((e, i, arr) => !e.sensitive && arr.findIndex((x) => x.id === e.id) === i);
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
              entryIds: resident.map((r) => r.id),
              chars: text.length,
            });
          } catch (error) {
            trace(ctx?.logger, 'record-recovery-FAILED', { message: String(error?.message ?? error).slice(0, 160) });
          }
          trace(ctx?.logger, 'recovery-injected', { sessionId, count: resident.length });
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
        const add = (dir, workspaceHint = null) => {
          if (!dir) return;
          const dbFile = join(dir, 'memory.db');
          if (!existsSync(dbFile)) return;
          if (found.some((f) => f.dir.toLowerCase() === String(dir).toLowerCase())) return;
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
          found.push({ dir, workspace: workspace ?? null, label: workspace ?? dir });
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
        return found.filter((f) => f.workspace); // 只把"真正的工作区库"给面板看
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
          stores_.push({ label: info.label, ...snapshotOf(memory) });
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
