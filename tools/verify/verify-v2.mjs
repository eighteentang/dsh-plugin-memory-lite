#!/usr/bin/env node
/**
 * verify-v2.mjs —— V2 四项功能的离线校验器
 *
 *   ① 注入可见性   recordInjection / injectCount / brief 里的"用过 N 次"
 *   ② 空闲自动整理 shouldAutoDistill 的**五条分支**都要走到（这是闸门类逻辑，
 *                  一次写错就一直错 —— 见 AGENTS.md「闸门顺序」那条教训）
 *   ③ 检索质量     精确子串优先 / 重要性加权 / 时效衰减带下限 / 相对下限
 *   ④ 跨工作区检索 scope=all 合并多库并标注来源
 *
 * 用法: node verify-v2.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openMemory } from '../../lib/storage.js';
import { resolveConfig } from '../../lib/config.js';
import { buildTools, brief } from '../../lib/tools.js';
import { shouldAutoDistill, runDistill, resolveDistillTargets } from '../../lib/distill.js';

const results = [];
const ok = (n, d = '') => results.push({ pass: true, n, d });
const bad = (n, d = '') => results.push({ pass: false, n, d });

console.log('=== verify-v2 ===\n');

const root = mkdtempSync(join(tmpdir(), 'memv2-'));
const A = openMemory({ dir: join(root, 'wsA'), workspace: 'D:\\WS-A' });
const B = openMemory({ dir: join(root, 'wsB'), workspace: 'D:\\WS-B' });

try {
  // ── ① 注入可见性 ──────────────────────────────────────────────────────
  const e1 = A.put({ level: 'fact', content: 'A 库里的一条事实', keywords: ['事实'], importance: 2, project: '全局' });
  A.recordInjection({ sessionId: 's1', form: 'recall', entryIds: [e1.id], chars: 120 });
  A.recordInjection({ sessionId: 's1', form: 'recall', entryIds: [e1.id], chars: 80 });

  const after = A.get(e1.id);
  after.injectCount === 2 ? ok('注入次数被累计（injectCount=2）') : bad('注入次数被累计', String(after.injectCount));
  Number.isFinite(after.lastInjectedAt) ? ok('最后注入时间被记录') : bad('最后注入时间被记录', String(after.lastInjectedAt));

  const recents = A.recentInjections('s1', 10);
  recents.length === 2 && recents[0].entryIds.includes(e1.id) && recents[0].form === 'recall'
    ? ok('注入流水可查（逐轮记录，含 form 与 entryIds）', `${recents.length} 条`)
    : bad('注入流水可查', JSON.stringify(recents));
  A.recentInjections(null, 10).length === 2 ? ok('注入流水不限会话也能查') : bad('注入流水不限会话也能查');
  A.stats().injections === 2 ? ok('stats 里含 injections 计数') : bad('stats 里含 injections 计数', JSON.stringify(A.stats()));

  brief(after).includes('用过') ? ok('元数据视图带上"用过 N 次"') : bad('元数据视图带上"用过 N 次"', brief(after));

  // ── ② 空闲自动整理的闸门（逐条分支）────────────────────────────────────
  // ⚠ 默认是**关**（2026-10-11 用户定：不想要"没打招呼就花额度"的行为）。
  //   所以测后面那些闸门时必须**显式给一个 autoDistill:true 的配置**，
  //   不能拿默认配置去测 —— 否则第一道闸门就返回 disabled，
  //   剩下四条分支永远走不到（"闸门顺序让后续闸门测不到"那类坑）。
  const cfgDefault = resolveConfig({});
  cfgDefault.autoDistill === false
    ? ok('默认**关**闭空闲自动整理（不擅自花额度；仍可手动点「立即整理」）')
    : bad('默认为关闭空闲自动整理', String(cfgDefault.autoDistill));

  const cfg = resolveConfig({ autoDistill: true });
  const idleLong = Date.now() - 60 * 60 * 1000; // 一小时没活动
  let v = shouldAutoDistill({ memory: A, config: cfgDefault, lastActivityAt: idleLong });
  v.reason === 'disabled' ? ok('闸门①：开关关闭 → disabled（默认配置下走这条）') : bad('闸门①：开关关闭', JSON.stringify(v));

  v = shouldAutoDistill({ memory: A, config: cfg, lastActivityAt: Date.now() });
  v.reason === 'not-idle' ? ok('闸门②：刚活动过 → not-idle') : bad('闸门②：刚活动过', JSON.stringify(v));

  v = shouldAutoDistill({ memory: A, config: cfg, lastActivityAt: idleLong });
  v.reason === 'no-logs' ? ok('闸门③：没有待整理流水 → no-logs（不浪费一次模型调用）') : bad('闸门③：没有待整理流水', JSON.stringify(v));

  A.appendLog({ sessionId: 's1', turn: 1, text: `有内容可整理了。${'x'.repeat(200)}` });
  v = shouldAutoDistill({ memory: A, config: cfg, lastActivityAt: idleLong });
  v.run === true ? ok('全部门槛满足 → 该跑（run=true）') : bad('全部门槛满足 → 该跑', JSON.stringify(v));

  // 冷却：插一条刚结束的蒸馏记录
  const runId = A.startDistillRun(1);
  A.finishDistillRun(runId, { outcome: 'ok', created: 1 });
  v = shouldAutoDistill({ memory: A, config: cfg, lastActivityAt: idleLong });
  v.reason === 'cooldown' ? ok('闸门④：距上次整理太近 → cooldown') : bad('闸门④：距上次整理太近', JSON.stringify(v));

  // 日配额：把今天的记录堆到上限
  const maxPerDay = cfg.distillMaxPerDay;
  for (let i = A.dayDistillCount(); i < maxPerDay; i++) {
    const r = A.startDistillRun(1);
    A.finishDistillRun(r, { outcome: 'ok' });
  }
  v = shouldAutoDistill({ memory: A, config: cfg, lastActivityAt: idleLong });
  v.reason === 'daily-quota' ? ok('闸门⑤：今天次数用满 → daily-quota', `上限 ${maxPerDay}`) : bad('闸门⑤：今天次数用满', JSON.stringify(v));

  // 反证：闸门不是永久锁死 —— 把"上次整理时间"回填到很久以前 + 放大配额后应该能跑。
  // ⚠ 必须**回填所有 distill_runs 行**的时间：只改 runId 那一行不够 ——
  //   上面配额循环又插了更晚的行，而 lastDistillRun() 取的是 id 最大的那条。
  //   （第一次我就只改了一行，于是冷却依然命中，白白红了一次。）
  const longAgo = Date.now() - 48 * 60 * 60 * 1000;
  A._raw.prepare('UPDATE distill_runs SET started_at = ?, finished_at = ?').run(longAgo, longAgo);
  const loose = resolveConfig({ autoDistill: true, distillMaxPerDay: 99, distillMinIntervalMinutes: 1 });
  const afterQuota = shouldAutoDistill({ memory: A, config: loose, lastActivityAt: idleLong });
  afterQuota.run === true
    ? ok('放宽冷却/配额后闸门恢复放行（不是永久锁死）')
    : bad('放宽冷却/配额后闸门恢复放行', JSON.stringify(afterQuota));

  // ── ③ 检索质量 ────────────────────────────────────────────────────────
  const exact = A.put({ level: 'fact', content: '目标查询词：日志层永不进提示词', keywords: ['日志层'], importance: 1, project: '全局' });
  const partial = A.put({ level: 'fact', content: '日志 与 提示词 是两回事，别混为一谈', keywords: ['日志'], importance: 4, project: '全局' });
  const unrelated = A.put({ level: 'fact', content: '完全无关的内容：数据库索引优化', keywords: ['数据库'], importance: 4, project: '全局' });

  const hits = A.search('日志层永不进提示词', { status: 'active', limit: 10 });
  hits[0]?.id === exact.id
    ? ok('精确子串独占最高层（压过重要性更高的近似匹配）')
    : bad('精确子串独占最高层', hits.map((h) => `${h.title || h.content.slice(0, 12)}=${h.score}`).join(' | '));
  !hits.some((h) => h.id === unrelated.id) ? ok('相对下限把无关条目挡掉') : bad('相对下限把无关条目挡掉', JSON.stringify(hits.map((h) => h.id)));
  void partial;

  // 重要性加权：两条同样只被"覆盖率"部分命中的条目，重要性高的应排前
  const lowImp = A.put({ level: 'fact', content: '覆盖率测试 甲 稳定性', keywords: ['覆盖'], importance: 1, project: '全局' });
  const highImp = A.put({ level: 'fact', content: '覆盖率测试 乙 稳定性', keywords: ['覆盖'], importance: 4, project: '全局' });
  const cov = A.search('覆盖率 稳定性', { status: 'active', limit: 10 });
  const li = cov.findIndex((h) => h.id === lowImp.id);
  const hi = cov.findIndex((h) => h.id === highImp.id);
  hi >= 0 && (li < 0 || hi < li)
    ? ok('重要性加权生效（同覆盖率时 4 分排在 1 分之前）', `high@${hi} low@${li}`)
    : bad('重要性加权生效', `high@${hi} low@${li}`);

  // 时效下限：把一条条目的更新时间改到很久以前，它仍应被搜到（floor 0.5 的证明）
  const oldOne = A.put({ level: 'fact', content: '很老但很准的一条：时效下限测试', keywords: ['时效'], importance: 3, project: '全局' });
  A._raw.prepare('UPDATE entries SET updated_at = ? WHERE id = ?').run(Date.now() - 3650 * 86400000, oldOne.id);
  A.search('时效下限测试', { status: 'active', limit: 5 }).some((h) => h.id === oldOne.id)
    ? ok('很老的条目仍能被搜到（时效衰减带下限，不会衰减到 0）')
    : bad('很老的条目仍能被搜到');

  // ── ④ 跨工作区检索 ────────────────────────────────────────────────────
  const b1 = B.put({ level: 'lesson', content: 'B 工作区里的教训：跨库检索应当能找到', keywords: ['跨库'], importance: 3, project: '全局' });
  const listStores = () => [
    { label: 'D:\\WS-A', workspace: 'D:\\WS-A', memory: A },
    { label: 'D:\\WS-B', workspace: 'D:\\WS-B', memory: B },
  ];
  const tools = buildTools({ memory: A, config: resolveConfig({}), listStores });
  const search = tools.find((t) => t.name === 'memory_search');
  const exec = { agent: { session: { id: 'sx', header: { cwd: root } } } };

  const onlyA = await search.execute({ query: '跨库检索' }, exec);
  onlyA.includes('没有检索到') ? ok('默认只搜当前工作区（搜不到别的库）', onlyA.slice(0, 40)) : bad('默认只搜当前工作区', onlyA.slice(0, 80));

  const allWs = await search.execute({ query: '跨库检索', scope: 'all' }, exec);
  allWs.includes(b1.id) && allWs.includes('工作区: D:\\WS-B')
    ? ok('scope=all 跨库命中并标注来源工作区')
    : bad('scope=all 跨库命中并标注来源工作区', allWs.slice(0, 160));

  const noHit = await search.execute({ query: '这个词肯定不存在啊啊啊', scope: 'all' }, exec);
  noHit.includes('都没检索到') && noHit.includes('2 个工作区')
    ? ok('跨库搜不到时说明扫了几个库（可诊断）', noHit.slice(0, 60))
    : bad('跨库搜不到时说明扫了几个库', noHit.slice(0, 80));

  // 参数形状：新增的 scope 必须出现在 schema 里（不是靠模型猜）
  const scopeProp = tools.find((t) => t.name === 'memory_search')?.parameters?.properties?.scope;
  scopeProp?.enum?.includes('all') ? ok('scope 参数在 JSON Schema 里声明（含 all）') : bad('scope 参数在 JSON Schema 里声明', JSON.stringify(scopeProp));

  // ── ⑤ 蒸馏的「提供方解析 + 逐个试」（真机 NO_ADAPTER 教出来的）────────────
  // 真机错误原文：{"kind":"error","failure":{"message":"no adapter registered for
  //              provider \"undefined\"","code":"NO_ADAPTER"}}
  // 根因：省略 provider 直接调 ctx.llm.stream() —— **框架没有全局默认提供方**。
  // 这一段把"必须自己指定 + 一个不行就换下一个"固化成断言。
  {
    const root3 = mkdtempSync(join(tmpdir(), 'memprov-'));
    const mem = openMemory({ dir: join(root3, 'mem') });
    mem.appendLog({ sessionId: 'sp', turn: 1, text: `提供方测试内容。${'q'.repeat(220)}` });
    const cfgD = resolveConfig({ autoDistill: true });
    const json = JSON.stringify({ items: [{ level: 'fact', content: '提供方解析测试条目', keywords: ['提供方'], importance: 2, project: '全局' }] });
    const gen = (chunks) => (async function* g() { for (const c of chunks) yield c; })();
    const okChunks = () => [{ type: 'text-delta', text: json }, { type: 'finish', reason: 'stop' }];

    // ① 没有任何注册路由 → 候选为空（不能拿 undefined 去调用）
    const emptyTargets = await resolveDistillTargets({ llm: { listProviders: () => [], listModels: async () => [] }, config: cfgD });
    emptyTargets.length === 0 ? ok('无注册路由时解析出空候选（不会拿 undefined 去调用）') : bad('无注册路由时解析出空候选', JSON.stringify(emptyTargets));

    const r0 = await runDistill({ memory: mem, config: cfgD, llm: { listProviders: () => [], listModels: async () => [], stream: () => gen(okChunks()) }, force: true });
    r0?.reason === 'no-provider'
      ? ok('无提供方时返回 no-provider（可指导用户去配置，而不是抛 NO_ADAPTER 谜题）')
      : bad('无提供方时返回 no-provider', JSON.stringify(r0));

    // ② 第一个提供方 NO_ADAPTER → 自动换下一个并成功
    const tried = [];
    const flaky = {
      listProviders: () => ['dead-route', 'good-route'],
      listModels: async (p) => [{ id: `model-of-${p}`, name: p }],
      stream(options) {
        tried.push(options.provider);
        if (options.provider === 'dead-route') {
          return gen([{ type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'no adapter registered for provider "dead-route"' } } }]);
        }
        return gen(okChunks());
      },
    };
    const r1 = await runDistill({ memory: mem, config: cfgD, llm: flaky, force: true });
    r1?.ok === true && r1.via === 'good-route/model-of-good-route'
      ? ok('第一个提供方 NO_ADAPTER → 自动换下一个并成功', `试过 ${tried.join(' → ')}；成功 ${r1.via}`)
      : bad('第一个提供方 NO_ADAPTER → 自动换下一个并成功', JSON.stringify({ r1, tried }));
    tried.length === 2 ? ok('只试了必要次数（不重复试同一个）', String(tried.length)) : bad('只试了必要次数', String(tried.length));

    // ③ 不可换的错误（上下文超限）→ 不浪费时间换提供方
    // ⚠ 每次都要补一条**新流水**：上一次成功的运行会 markDistilledUpTo，
    //   否则后续用例一律 `no-logs`（我第一次就踩了这个，三个用例连着假红）。
    mem.appendLog({ sessionId: 'sp', turn: 2, text: `上下文超限用例。${'q'.repeat(220)}` });
    const tried2 = [];
    const overflow = {
      listProviders: () => ['a', 'b'],
      listModels: async () => [{ id: 'm' }],
      stream(options) {
        tried2.push(options.provider);
        return gen([{ type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' } } }]);
      },
    };
    const r2 = await runDistill({ memory: mem, config: cfgD, llm: overflow, force: true });
    r2?.ok === false && tried2.length === 1
      ? ok('不可换的错误（CONTEXT_WINDOW_EXCEEDED）不浪费一次尝试')
      : bad('不可换的错误不换提供方', JSON.stringify({ r2, tried2 }));

    // ④ 传进去的 options 必须带 provider + model（这正是真机 NO_ADAPTER 的直接修复）
    mem.appendLog({ sessionId: 'sp', turn: 3, text: `参数形状用例。${'q'.repeat(220)}` });
    let seenOptions = null;
    const spy = {
      listProviders: () => ['only'],
      listModels: async () => [{ id: 'only-model' }],
      stream(options) { seenOptions = options; return gen(okChunks()); },
    };
    await runDistill({ memory: mem, config: cfgD, llm: spy, force: true });
    seenOptions?.provider === 'only' && seenOptions?.model === 'only-model'
      ? ok('调用时带上了 provider 与 model（真机 NO_ADAPTER 的直接修复）')
      : bad('调用时带上了 provider 与 model', JSON.stringify(seenOptions));
    Array.isArray(seenOptions?.messages) ? ok('同时仍然带 messages（签名没写坏）') : bad('同时仍然带 messages', JSON.stringify(Object.keys(seenOptions ?? {})));

    // ⑤ 显式配置优先于自动发现
    const explicit = await resolveDistillTargets({ llm: { listProviders: () => ['auto'], listModels: async () => [{ id: 'automodel' }] }, config: resolveConfig({ distillProvider: 'mine', distillModel: 'mymodel' }) });
    explicit[0]?.provider === 'mine' && explicit[0]?.model === 'mymodel'
      ? ok('显式配置的 distillProvider/distillModel 优先')
      : bad('显式配置优先', JSON.stringify(explicit));

    // ⑥ **真实契约**：`listProviders()` 返回**对象数组**（路由名在 `.id`），不是字符串数组。
    //    来源：`dsh-llm/lib/index.js:1899`
    //      `[...this.adapters.values()].map(({ provider }) => ({ ...provider }))`
    //    我按 README 那句"报告已注册路由"猜成字符串数组，又用
    //    `.filter(p => typeof p === 'string')` 把真实路由**全过滤掉**了 →
    //    真机表现："没有可用的模型提供方"。这条断言就是钉住这个形状的。
    const objectShaped = await resolveDistillTargets({
      llm: { listProviders: () => [{ id: 'route-a', name: 'A' }, { id: 'route-b' }], listModels: async (p) => [{ id: `${p}-model` }] },
      config: resolveConfig({}),
    });
    objectShaped.length === 2 && objectShaped[0]?.provider === 'route-a' && objectShaped[0]?.model === 'route-a-model'
      ? ok('listProviders() 返回**对象数组**时能解析出路由（真实契约）', objectShaped.map((t) => t.provider).join(','))
      : bad('对象数组形态的 listProviders 能解析', JSON.stringify(objectShaped));

    const stringShaped = await resolveDistillTargets({
      llm: { listProviders: () => ['plain-a'], listModels: async (p) => [{ id: `${p}-model` }] },
      config: resolveConfig({}),
    });
    stringShaped[0]?.provider === 'plain-a' ? ok('字符串数组形态也兼容（防御）') : bad('字符串数组形态也兼容', JSON.stringify(stringShaped));

    // ⑦ 端到端：对象形态 + 第一个路由 NO_ADAPTER → 换第二个并成功
    mem.appendLog({ sessionId: 'sp', turn: 4, text: `对象形态提供方用例。${'q'.repeat(220)}` });
    const tried3 = [];
    const objectFlaky = {
      listProviders: () => [{ id: 'obj-dead' }, { id: 'obj-good' }],
      listModels: async (p) => [{ id: `${p}-m` }],
      stream(options) {
        tried3.push(options.provider);
        if (options.provider === 'obj-dead') {
          return gen([{ type: 'finish', reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'x' } } }]);
        }
        return gen(okChunks());
      },
    };
    const r3 = await runDistill({ memory: mem, config: cfgD, llm: objectFlaky, force: true });
    r3?.ok === true && r3.via === 'obj-good/obj-good-m'
      ? ok('端到端：对象形态 + 第一个不可用 → 换下一个成功', `试过 ${tried3.join(' → ')}`)
      : bad('端到端：对象形态换路', JSON.stringify({ r3, tried3 }));

    mem.close();
    rmSync(root3, { recursive: true, force: true });
  }
} finally {
  A.close();
  B.close();
  rmSync(root, { recursive: true, force: true });
}

console.log('');
let pass = 0;
for (const r of results) {
  console.log(`${r.pass ? '✅' : '❌'} ${r.n}${r.d ? `  —— ${r.d}` : ''}`);
  if (r.pass) pass++;
}
console.log(`\n通过 ${pass}/${results.length}`);
console.log('\n⚠ 离线验不到的：');
console.log('   · 空闲计时器在真机上的实际触发（5 分钟检查一次 + 30 分钟空闲阈值）');
console.log('   · 面板上"用过 N 次"的显示效果');
console.log('   · scope=all 在真机上扫到的库是否与注册表一致');
process.exit(results.every((r) => r.pass) ? 0 : 1);
