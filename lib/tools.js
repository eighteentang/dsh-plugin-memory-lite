/**
 * tools.js —— 给模型的记忆工具
 *
 * 三条硬约束（都有实测依据，改坏会炸整轮会话或让红线失效）：
 *   ① `parameters` 必须是**真 JSON Schema**。DSH 简写 `{参数名:{type,required}}` 注册期
 *      静默通过，模型一调用就炸整个会话那一轮（E18 真机证据）。所以这里全部用
 *      `{type:'object', properties:{...}, required:[], additionalProperties:false}`。
 *   ② 破坏性操作**不在工具层自证**（模型可以写 confirm:true 骗过），必须交给宿主审批：
 *      `ctx.on('tools/pre-execute', ...)` 返回 `{kind:'ask'}`。工具描述里也明确写「调用会弹审批」。
 *   ③ 工具返回值给模型看的应当是"元数据视图"（id/层/关键词/时间），正文按需再用
 *      memory_read 取 —— 一次返回全文会把上下文灌满。
 */
import { LEVELS, PROJECT_SUBCATEGORIES, STATUSES, toJsonSchema, redactSecrets } from './config.js';
import { levelLabel } from './prompt.js';

const TEXT_OUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
};

function relTime(ts) {
  if (!ts) return '';
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d <= 0) return '今天';
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  return `${Math.floor(d / 30)} 个月前`;
}

function brief(entry) {
  const proj = entry.project && entry.project !== '全局' ? ` project=${entry.project}` : '';
  // V2-1：把"用过几次 / 最近一次"放进元数据视图 ——
  // 这是排查"记忆到底有没有在工作"最直接的证据，也让模型知道哪条是常用的。
  const used = entry.injectCount ? ` 用过${entry.injectCount}次${entry.lastInjectedAt ? `(${relTime(entry.lastInjectedAt)})` : ''}` : '';
  return [
    `[${levelLabel(entry.level)}${proj}${entry.subcategory ? `:${entry.subcategory}` : ''}]`,
    `[${entry.id}]`,
    `[${relTime(entry.updatedAt)}]`,
    entry.sensitive ? '[敏感·不注入]' : '',
    used,
    `keywords: ${(entry.keywords ?? []).join(', ') || '(无)'}`,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * 构建工具定义数组。
 *
 * @param {object} deps
 * @param {object} deps.memory 默认记忆库（拿不到工作区库时用它）
 * @param {object} deps.config
 * @param {((exec: object) => object) | undefined} deps.resolveMemory
 *        按调用上下文解析"该用哪个记忆库"（多工作区时用）。
 *        设计理由：工具注册是**全局一次**的，但记忆库是**按工作区分库**的，
 *        所以解析必须发生在 execute 里，而不是注册时。
 * @param {(() => Array<{label:string, workspace:string|null, memory:object}>) | undefined} deps.listStores
 *        V2-4 跨工作区检索用：列出全部已知库。
 * @returns {Array<{name:string, description:string, parameters:object, output:object, execute:Function}>}
 */
export function buildTools({ memory: defaultMemory, config, resolveMemory, listStores }) {
  const tools = [];
  const memOf = (exec) => (typeof resolveMemory === 'function' ? resolveMemory(exec) ?? defaultMemory : defaultMemory);

  // ── 写：memory_note ─────────────────────────────────────────────────────
  tools.push({
    name: 'memory_note',
    description: [
      '把一条值得跨会话记住的信息写进记忆库。',
      '什么时候用：用户明确说「记住…」；或出现了下次新会话仍然需要的事实/偏好/决策/教训。',
      '写什么层级（level）：user=用户的偏好与基本情况；rules=行为准则；fact=原子事实（一句话）；',
      'lesson=被纠正后学到的教训；topic=一件事的来龙去脉；project=项目信息（配 subcategory）；soul=AI 自身设定。',
      'keywords 要按「我希望用户提到哪些词时这条被想起来」来写，8~13 个，优先专有名词与核心实体，不要用项目名当关键词。',
      '与已有条目高度重复时应当用 memory_update 更新而不是新增。',
    ].join(''),
    parameters: toJsonSchema({
      content: { type: 'string', required: true, description: '要记住的内容。用户介绍设计思路/决策理由时，必须保留用户原话措辞，不要转述。' },
      project: { type: 'string', description: '归属项目名；全局适用的填「全局」；多个用英文逗号分隔。' },
      keywords: {
        type: 'array',
        required: true,
        description: '8~13 个检索关键词。',
        items: { type: 'string' },
      },
      importance: { type: 'integer', required: true, description: '1~4：4=红线/致命；3=用户强调或全局适用；2=用户决策；1=琐碎。' },
      level: { type: 'string', enum: LEVELS, description: '默认 fact。' },
      subcategory: { type: 'string', enum: PROJECT_SUBCATEGORIES, description: '仅 level=project 时用：overview/structure/decisions/quotes/ops/todo。' },
      goal: { type: 'string', description: '仅 level=topic 时建议填：这件事的目标句。' },
      title: { type: 'string', description: '可选短标题，便于索引段显示。' },
      corrected: { type: 'boolean', description: '内容来自用户纠正时填 true（尤其 level=lesson）。' },
    }),
    output: TEXT_OUT,
    async execute(args, exec) {
      const memory = memOf(exec);
      const content = redactSecrets(String(args?.content ?? '').trim());
      if (!content) return '写入失败：content 不能为空。';
      const keywords = Array.isArray(args?.keywords) ? args.keywords.map(String).filter(Boolean) : [];
      if (!keywords.length) return '写入失败：keywords 必填（8~13 个检索关键词），请重新调用并给出关键词。';
      const level = args?.level && LEVELS.includes(args.level) ? args.level : 'fact';
      if (level === 'project' && !args?.project) return '写入失败：level=project 时必须给出 project（项目名）。';
      const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id ?? null;
      const entry = memory.put({
        level,
        title: args?.title ?? '',
        content,
        keywords,
        importance: Number(args?.importance ?? 1),
        project: args?.project ?? (level === 'project' ? null : '全局'),
        subcategory: level === 'project' ? (args?.subcategory ?? null) : null,
        goal: level === 'topic' ? (args?.goal ?? null) : null,
        corrected: Boolean(args?.corrected),
        sourceSession: sessionId,
      });
      return `已写入（${levelLabel(entry.level)}，id=${entry.id}）\n${brief(entry)}\n${entry.sensitive ? '⚠ 这条被判为敏感内容，不会被自动注入（仍可用 memory_read 查看）。' : ''}`;
    },
  });

  // ── 查：memory_search ───────────────────────────────────────────────────
  tools.push({
    name: 'memory_search',
    description: [
      '按关键词检索记忆库，返回条目的**元数据视图**（id/层级/关键词/时间/用过几次），不含正文。',
      '需要某条的全文时，用返回的 id 调 memory_read。',
      '默认只搜 active 条目；要看归档的传 status="all"。',
      '默认只搜**当前工作区**；要跨工作区找「我在别的项目里记过什么」，传 scope="all"。',
    ].join(''),
    parameters: toJsonSchema({
      query: { type: 'string', required: true, description: '检索关键词或句子（不能为空）。' },
      level: { type: 'string', description: `限定层级，逗号分隔，可选：${LEVELS.join('/')}。留空=全部。` },
      project: { type: 'string', description: '按项目过滤。' },
      status: { type: 'string', description: 'active（默认）/ stale / archived / all。' },
      scope: { type: 'string', enum: ['workspace', 'all'], description: '检索范围：workspace=当前工作区（默认）；all=所有已知工作区。' },
      limit: { type: 'integer', description: '返回条数，默认 10，最大 50。' },
    }),
    output: TEXT_OUT,
    async execute(args, exec) {
      const memory = memOf(exec);
      const query = String(args?.query ?? '').trim();
      if (!query) return '检索失败：query 不能为空。请给出要查的关键词。';
      const levels = String(args?.level ?? '').split(',').map((s) => s.trim()).filter((s) => LEVELS.includes(s));
      const status = STATUSES.includes(args?.status) || args?.status === 'all' ? args.status : 'active';
      const limit = Math.max(1, Math.min(Number(args?.limit) || 10, 50));
      const scope = args?.scope === 'all' ? 'all' : 'workspace';

      /** 在一个库里搜（按需扫多个 level） */
      const searchOne = (mem) => {
        const acc = [];
        const scanLevels = levels.length ? levels : [null];
        for (const level of scanLevels) {
          for (const hit of mem.search(query, { level, status, project: args?.project ?? null, limit })) {
            if (!acc.some((f) => f.id === hit.id)) acc.push(hit);
          }
        }
        return acc;
      };

      // ── V2-4 跨工作区：扫全部已知库，合并后按分数排序 ────────────────────
      if (scope === 'all' && config.crossWorkspaceSearch !== false && typeof listStores === 'function') {
        let all = [];
        try {
          all = listStores() ?? [];
        } catch {
          all = [];
        }
        const merged = [];
        for (const store of all) {
          for (const hit of searchOne(store.memory)) {
            merged.push({ ...hit, _ws: store.workspace ?? store.label ?? '(未知工作区)' });
          }
        }
        if (!merged.length) {
          return `在所有工作区里都没检索到与「${query}」相关的记忆（status=${status}，共扫了 ${all.length} 个工作区库）。`;
        }
        merged.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        const top = merged.slice(0, limit);
        const lines = top.map((e) => `${brief(e)}\n    ↳ 工作区: ${e._ws}`);
        return `跨 ${all.length} 个工作区检索到 ${top.length} 条（不含正文，需要全文用 memory_read 传 id）：\n${lines.join('\n')}`;
      }

      // ── 默认：只搜当前工作区 ─────────────────────────────────────────────
      const found = searchOne(memory);
      if (!found.length) {
        const hint = typeof listStores === 'function' ? '；也可以传 scope="all" 跨工作区找' : '';
        return `没有检索到与「${query}」相关的记忆（status=${status}）。可以换关键词，或用 status="all" 把归档条目也纳入${hint}。`;
      }
      const lines = found.slice(0, limit).map(brief);
      return `检索到 ${lines.length} 条（不含正文，需要全文用 memory_read 传 id）：\n${lines.join('\n')}`;
    },
  });

  // ── 读：memory_read ─────────────────────────────────────────────────────
  tools.push({
    name: 'memory_read',
    description: '按 id 读取一条记忆的完整内容与元数据。',
    parameters: toJsonSchema({ id: { type: 'string', required: true, description: '记忆 id（从 memory_search 或注入块里得到）。' } }),
    output: TEXT_OUT,
    async execute(args, exec) {
      const memory = memOf(exec);
      const id = String(args?.id ?? '').trim();
      const entry = id ? memory.get(id) : null;
      if (!entry) return `没有找到 id=${id} 的记忆。`;
      memory._raw?.prepare?.('UPDATE entries SET hit_count = hit_count + 1, last_accessed_at = ? WHERE id = ?')?.run?.(Date.now(), id);
      return [
        `[${levelLabel(entry.level)}${entry.project ? ` · ${entry.project}` : ''}${entry.subcategory ? ` · ${entry.subcategory}` : ''}] 状态=${entry.status} 重要性=${entry.importance}${entry.corrected ? ' 用户纠正过' : ''}`,
        `id: ${entry.id}`,
        `关键词: ${(entry.keywords ?? []).join(', ') || '(无)'}`,
        entry.goal ? `目标: ${entry.goal}` : '',
        `更新于: ${relTime(entry.updatedAt)}`,
        '',
        entry.content,
      ]
        .filter((l) => l !== '')
        .join('\n');
    },
  });

  // ── 改：memory_update ───────────────────────────────────────────────────
  tools.push({
    name: 'memory_update',
    description: [
      '更新一条已有记忆（内容/状态/重要性/关键词/归属）。',
      'status：active=在用；stale=完结（todo 做完、话题达成目标）；archived=作废（过时、重复、被替代）。',
      '发现某条记忆过时或不准时必须更新，不要让错误内容留在 active。',
    ].join(''),
    parameters: toJsonSchema({
      id: { type: 'string', required: true, description: '要更新的记忆 id。' },
      content: { type: 'string', description: '新内容。' },
      status: { type: 'string', enum: STATUSES, description: '新状态。' },
      importance: { type: 'integer', description: '新重要性 1~4。' },
      keywords: { type: 'array', items: { type: 'string' }, description: '新关键词（不传=不改）。' },
      project: { type: 'string', description: '新项目归属（传空字符串=清空归属）。' },
    }),
    output: TEXT_OUT,
    async execute(args, exec) {
      const memory = memOf(exec);
      const id = String(args?.id ?? '').trim();
      if (!memory.get(id)) return `没有找到 id=${id} 的记忆。`;
      const patch = {};
      if (args?.content !== undefined) patch.content = redactSecrets(String(args.content));
      if (args?.status !== undefined) patch.status = args.status;
      if (args?.importance !== undefined) patch.importance = Number(args.importance);
      if (args?.keywords !== undefined) patch.keywords = (args.keywords ?? []).map(String);
      if (args?.project !== undefined) patch.project = String(args.project) || null;
      const next = memory.update(id, patch);
      return `已更新（id=${next.id}）\n${brief(next)}`;
    },
  });

  // ── 删：memory_forget（破坏性 → 走宿主审批）─────────────────────────────
  tools.push({
    name: 'memory_forget',
    description: [
      '永久删除一条记忆。**这是破坏性操作，调用时会弹出人工审批**，被拒绝则不会删除。',
      '如果只是"作废/过时"，优先用 memory_update 把 status 设为 archived（保留可追溯）。',
      '只有确认这条记忆完全不该存在时才用它。',
    ].join(''),
    parameters: toJsonSchema({ id: { type: 'string', required: true, description: '要删除的记忆 id。' } }),
    output: TEXT_OUT,
    async execute(args, exec) {
      const memory = memOf(exec);
      const id = String(args?.id ?? '').trim();
      const entry = memory.get(id);
      if (!entry) return `没有找到 id=${id} 的记忆（未删除任何东西）。`;
      memory.remove(id);
      return `已永久删除 id=${id}（原层级 ${levelLabel(entry.level)}，内容片段：${String(entry.content).slice(0, 60)}…）`;
    },
  });

  // ── 统计：memory_stats ──────────────────────────────────────────────────
  tools.push({
    name: 'memory_stats',
    description: '查看记忆库统计（各层条数、敏感条数、日志层积压）。用于判断是否需要整理。',
    parameters: toJsonSchema({}),
    output: TEXT_OUT,
    async execute(_args, exec) {
      const memory = memOf(exec);
      const s = memory.stats();
      const byLevel = Object.entries(s.activeByLevel).map(([k, v]) => `${levelLabel(k)}=${v}`).join(' · ') || '(空)';
      return [
        `记忆库: ${memory.dbPath}`,
        `active 条目: ${Object.values(s.activeByLevel).reduce((a, b) => a + b, 0)} 条（${byLevel}）`,
        `总条目（含归档）: ${s.total}`,
        `敏感且 active: ${s.sensitiveActive} 条（不会被自动注入）`,
        `日志层: ${s.logs} 条，其中未蒸馏 ${s.logsUndistilled} 条`,
        `自动沉淀=${config.autoCapture ? '开' : '关'} 自动召回=${config.autoRecall ? '开' : '关'} 自动蒸馏=${config.autoDistill ? '开' : '关'}`,
      ].join('\n');
    },
  });

  return tools;
}

/**
 * 破坏性工具清单 —— 交给 `tools/pre-execute` 用。
 * 为什么不写在工具里自证：模型可以在参数里写 confirm=true 骗过工具层，
 * 只有宿主的审批服务是真的"外部决定"。
 */
export const DESTRUCTIVE_TOOLS = new Set(['memory_forget']);

export { brief };
