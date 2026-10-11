/**
 * client/client.js —— 设置页「记忆控制」客户端 bundle
 *
 * 写法依据（都是本机已验证过的）：
 *   · 注册形态：`window.__ModuleLoader__.load({ id, factory })` —— 客户端 bundle **不是 ESM**。
 *   · `factory(require)` 的 require 能取到 `react` / `react/jsx-runtime`
 *     （本机 @changfenhuang/dsh-genui 的 client.js 就是这么取的）。
 *   · 槽位契约照官方账号页（dsh-client-ui-settings-account/lib/client.js:4501）：
 *       ctx.slots.inject('settings.section', () => ctx.slots.register(
 *         { name:'settings.section', id, order, label: () => t('nav'), locale, inject: () => data },
 *         Component))
 *     第二个参数是组件，`inject` 的返回值作为组件的 props。
 *
 * ⚠ 两条自我约束（因为我没有浏览器控制权，界面只能靠"照抄 + 自保"）：
 *   ① **不 import `@deepseek-ai/dsh-client-ui-primitives` 等 UI 包** —— 纯 JS 插件没有类型检查，
 *      组件一抛错整个槽位条目会变空白（控制台报 `slot entry crashed`）。
 *      全局指令也明确禁止。所有控件自己写。
 *   ② 组件顶层 try/catch + 每个槽位注册 guarded：**渲染失败只让这一块变空白，不拖累设置页**。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-memory-lite',
  factory: (require) => {
    // 加载标记：浏览器控制台能看到这一行 → 说明 bundle 真的被加载了。
    // 用途：把「bundle 没加载」与「加载了但没显示」两种故障分开，否则只能猜。
    try {
      console.info('[memory-lite] client bundle loaded (v1.0.0)');
    } catch {
      /* 忽略 */
    }

    const React = require('react');

    const h = React.createElement;

    /** 客户端也要 guarded：注册失败不能把设置页搞坏 */
    function guarded(label, fn) {
      try {
        return fn();
      } catch (error) {
        try {
          console.warn(`memory-lite(client): ${label} failed: ${error?.message ?? error}`);
        } catch {
          /* 忽略 */
        }
        return undefined;
      }
    }

    function fmtTime(ts) {
      if (!ts) return '-';
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    const LEVEL_LABEL = {
      soul: 'AI 自身',
      user: '用户',
      rules: '准则',
      fact: '事实',
      lesson: '教训',
      topic: '话题',
      project: '项目',
    };

    const STATUS_LABEL = { active: '在用', stale: '已完成', archived: '已停用' };
    const STATUS_HINT = {
      active: '内容有效，会被搜到也可能被召回',
      stale: '这件事做完了；内容仍有效',
      archived: '不再被注入，但仍可搜到、可恢复',
    };

    /** 极简样式（只用于布局，不定义主题色 —— 颜色一律走主题 token） */
    const css = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      input: {
        flex: '1 1 220px',
        minWidth: 160,
        padding: '6px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'inherit',
        fontSize: 13,
      },
      button: {
        padding: '6px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 13,
      },
      list: { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 420, overflowY: 'auto' },
      card: {
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.28))',
        borderRadius: 8,
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      },
      meta: { fontSize: 12, opacity: 0.72, display: 'flex', gap: 8, flexWrap: 'wrap' },
      body: { fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      tag: {
        fontSize: 11,
        lineHeight: '16px',
        padding: '1px 6px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
        opacity: 0.9,
        // ⚠ 这两条是"标签占两行"的解药：不换行 + 不参与伸缩（宽度由列/内容决定）
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      },
      stat: { fontSize: 12, opacity: 0.8 },
    };

    /**
     * 列表的列模板（每行共用一张表 → 列宽统一、行高一致）。
     * 层级 52 · 项目 84 · 标题 自适应（minmax(0,1fr) 是省略号能生效的前提）· 敏感 30 · 用过 40 · 状态 88
     * ⚠ 改这里只要保证**总宽不超过面板**；列多了要相应收窄，不然标题就没地方了。
     */
    const LIST_COLS = '52px 84px minmax(0, 1fr) 30px 40px 88px';
    /** 行高固定（像素）：所有行等高，长文本不许把行撑高 */
    const ROW_HEIGHT = 32;

    function Tag({ children, warn, style, title }) {
      return h('span', {
        title,
        style: {
          ...css.tag,
          ...(warn ? { color: 'var(--dsw-alias-text-warning, #c98a00)' } : null),
          ...(style ?? null),
        },
      }, children);
    }

    /** 与宿主路由约定的前缀（改这里必须同时改 index.js 的 API_PREFIX） */
    const API = '/dsh-memory-lite/api';

    /** 同源请求宿主路由。为什么不用官方 remote：RPC 需要 TypertRemoteService 基类，解析不到。 */
    async function api(path, body) {
      const init = body === undefined
        ? { method: 'GET' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
      const res = await fetch(`${API}${path}`, init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }

    /** 组件级兜底：渲染抛错时给一句可读文案，而不是整块空白 */
    class Boundary extends React.Component {
      constructor(p) {
        super(p);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error: String(error?.message ?? error) };
      }

      render() {
        if (this.state.error) {
          return h('div', { style: { fontSize: 12, opacity: 0.8 } }, `记忆控制加载失败：${this.state.error}`);
        }
        return this.props.children;
      }
    }

    function MemorySection() {
      const [state, setState] = React.useState({ loading: true, error: null, notice: null, stores: [], active: 0 });
      const [query, setQuery] = React.useState('');
      const [statusFilter, setStatusFilter] = React.useState('active');
      const [busy, setBusy] = React.useState('');
      // 人设 / 工作规范：读写的是**宿主全局指令文件**（AGENTS.md），不是记忆库 ——
      // 因为它们必须每轮生效，而记忆库靠关键词召回（规范类"这轮没命中"就等于静默失效）
      const [persona, setPersona] = React.useState(null);
      const [draft, setDraft] = React.useState({ persona: '', rules: '' });
      const [personaBusy, setPersonaBusy] = React.useState('');

      const reload = React.useCallback(async () => {
        try {
          const data = await api('/snapshot');
          const stores = Array.isArray(data?.stores) ? data.stores : [];
          setState((prev) => {
            // 默认展示"条目最多的那个库"——迁移过来的数据通常在它里面
            const best = stores.reduce((acc, s, i) => ((s.entries?.length ?? 0) > ((stores[acc]?.entries?.length) ?? -1) ? i : acc), 0);
            return {
              // ⚠ 必须 `...prev`：这个方法在"立即整理 / 改状态"之后被调用，
              //   而那两个动作**先** setState 了 error/notice。第一版这里直接返回新对象、
              //   把 error/notice 重置成 undefined → 提示**只闪一下就消失**
              //   （真机现象："界面闪了一下，没反应"）。这两个字段属于"动作的结果"，不该被刷新清掉。
              ...prev,
              loading: false,
              // 快照自身的读取错误单独一个字段，避免把动作的错误冲掉
              snapshotError: data?.ok === false ? String(data.error ?? '未知错误') : null,
              stores,
              active: prev.stores.length === stores.length ? Math.min(prev.active, Math.max(stores.length - 1, 0)) : best,
            };
          });
        } catch (error) {
          setState((s) => ({ ...s, loading: false, snapshotError: `${String(error?.message ?? error)}（宿主路由 ${API}/snapshot 不可达）` }));
        }
      }, []);

      React.useEffect(() => {
        let alive = true;
        (async () => {
          if (alive) await reload();
        })();
        return () => {
          alive = false;
        };
      }, [reload]);

      const currentStore = state.stores[state.active] ?? null;
      const currentDir = currentStore?.dbPath ? currentStore.dbPath.replace(/[\\/]memory\.db$/i, '') : null;

      const doSetStatus = async (id, status) => {
        setBusy(id + status);
        setState((s) => ({ ...s, error: null, notice: null }));
        try {
          await api('/set-status', { id, status, dir: currentDir });
          await reload();
        } catch (error) {
          setState((s) => ({ ...s, error: String(error?.message ?? error) }));
        } finally {
          setBusy('');
        }
      };

      // ── 人设 / 工作规范：读写宿主 AGENTS.md（不是记忆库）──────────────────
      // 为什么读文件：这两块必须**每轮生效**；记忆库靠关键词召回，
      // 规范类的东西"这轮恰好没命中"就等于静默失效（详见 README 的说明）。
      const loadPersona = React.useCallback(async () => {
        try {
          const data = await api('/persona');
          setPersona(data);
          if (data?.ok) setDraft({ persona: data.persona ?? '', rules: data.rules ?? '' });
        } catch (error) {
          setPersona({ ok: false, error: `读取失败：${String(error?.message ?? error)}（宿主路由 ${API}/persona 不可达）` });
        }
      }, []);

      React.useEffect(() => {
        let alive = true;
        (async () => {
          if (alive) await loadPersona();
        })();
        return () => {
          alive = false;
        };
      }, [loadPersona]);

      const savePersona = async (slot) => {
        setPersonaBusy(slot);
        setState((s) => ({ ...s, error: null, notice: null }));
        try {
          // 带上打开面板时读到的 mtime：文件被别处改过时宿主会拒绝这次写入，
          // 免得把用户手工编辑的内容悄悄覆盖掉。
          const out = await api('/persona', { slot, text: draft[slot], mtime: persona?.mtimes?.[slot] });
          if (out?.ok === false) {
            // ⚠ 这类报错最常见的成因不是"文件坏了"，而是**面板里装的是旧快照**
            //   （面板打开之后宿主被重载过，或文件被别处改过）。所以先重读，
            //   并在提示里说清"已经重读、直接再点一次" —— 否则用户只会反复点同一个按钮。
            await loadPersona();
            setState((s) => ({ ...s, error: `${String(out.error ?? '保存失败')}　→ 已自动重新读取文件内容（你在框里的改动已被丢弃，需重新编辑），请确认后直接再点一次保存。` }));
          } else {
            await loadPersona();
            const label = slot === 'persona' ? '人设设定' : '工作规范与行为准则';
            setState((s) => ({ ...s, notice: `${label} 已保存（备份 ${String(out.backup ?? '').split(/[\\/]/).pop()}）` }));
          }
        } catch (error) {
          setState((s) => ({ ...s, error: String(error?.message ?? error) }));
        } finally {
          setPersonaBusy('');
        }
      };

      const doDistill = async () => {
        setBusy('distill');
        // 先清掉上一次的结果，否则新点了还显示旧提示（用户会以为"没反应"）
        setState((s) => ({ ...s, error: null, notice: null }));
        try {
          const out = await api('/distill', { dir: currentDir });
          const reason = out?.result?.reason;
          // ⚠「无流水 / 冷却 / 关着 / 退避」都不是故障，是**正常状态**。
          //   早期版本把 ok:false 一律显示成红字「出错了」，把一个正常状态报成错误，
          //   还让用户以为是插件坏了（真机踩到：显示「整理失败，no-logs」）。
          if (reason === 'no-logs') {
            setState((s) => ({ ...s, error: null, notice: '没有待整理的流水——每轮自动记录的内容都已经处理过了。再聊几轮之后来点它。' }));
          } else if (reason === 'disabled') {
            setState((s) => ({ ...s, error: null, notice: '自动整理在配置里是关闭的；这个按钮是手动触发，但服务端要求 autoDistill 开启才会执行。' }));
          } else if (reason === 'cooldown') {
            setState((s) => ({ ...s, error: null, notice: '距上次整理太近（有冷却时间，避免频繁调用模型），过一会儿再点。' }));
          } else if (reason === 'backoff') {
            setState((s) => ({ ...s, error: null, notice: '最近连续整理失败，已进入退避状态，过一会儿再试。' }));
          } else if (reason === 'llm-unavailable') {
            setState((s) => ({ ...s, error: '拿不到模型服务（ctx.llm），无法整理。请把这条告诉我。', notice: null }));
          } else if (reason === 'no-provider') {
            setState((s) => ({
              ...s,
              error: null,
              notice: `找不到可用的模型提供方。${out?.result?.message ?? ''} 可以在插件配置里指定 distillProvider / distillModel。`,
            }));
          } else if (out?.ok === false) {
            // ⚠ 这里曾经优先显示 `reason`，而失败的 reason 恒为 "error"，
            //   于是真正的错误消息（在 result.message 里）**被吞掉**，界面上只剩一个 "error"。
            //   用户看到的「整理未完成，error」就是这么来的 —— 前端把唯一的证据丢了。
            const detail = out?.result?.message ?? reason ?? '未知原因';
            setState((s) => ({ ...s, error: `整理未完成：${detail}`, notice: null }));
          } else if ((out?.result?.items ?? 0) === 0) {
            setState((s) => ({
              ...s,
              error: null,
              notice: `整理跑通了，但模型没产出条目（它返回了 ${out?.result?.rawLength ?? 0} 字）。原始输出已记在库里，告诉我一声我来查。`,
            }));
          } else {
            setState((s) => ({ ...s, error: null, notice: `整理完成：新增 ${out.result.created ?? 0} 条，更新 ${out.result.updated ?? 0} 条。` }));
          }
          await reload();
        } catch (error) {
          setState((s) => ({ ...s, error: String(error?.message ?? error) }));
        } finally {
          setBusy('');
        }
      };

      const entries = currentStore?.entries ?? [];
      const q = query.trim().toLowerCase();
      const shown = entries.filter((e) => {
        if (statusFilter !== 'all' && e.status !== statusFilter) return false;
        if (!q) return true;
        const hay = `${e.title ?? ''}\n${e.content ?? ''}\n${(e.keywords ?? []).join(' ')}\n${e.project ?? ''}`.toLowerCase();
        return hay.includes(q);
      });

      const byLevel = {};
      for (const e of entries) byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;

      return h('div', { style: css.wrap }, [
        // ── 人设 / 工作规范（读写宿主 AGENTS.md）──────────────────────────
        h('div', { key: 'persona', style: css.card }, [
          h('div', { key: 'h', style: css.meta }, [
            h('strong', { key: 't' }, '人设与行为准则'),
            h('span', { key: 'f' }, persona?.dir ? `存在插件自己的目录：${persona.dir}` : '每轮自动带进提示词（不依赖其它文件）'),
          ]),
          persona?.ok === false
            ? h('div', { key: 'pe', style: { ...css.stat, color: 'var(--dsw-alias-text-error, #d33)' } }, `读不到：${persona.error}`)
            : null,
          h('div', { key: 'grid', style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
            h('div', { key: 'p1', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
              h('div', { key: 'l', style: css.meta }, [
                h('strong', { key: 'n' }, '人设设定'),
                h('span', { key: 'd' }, '我是谁 / 什么语气 —— 每轮都会带上'),
              ]),
              h('textarea', {
                key: 'ta',
                style: { ...css.input, minHeight: 120, width: '100%', fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.6 },
                placeholder: '想写什么就写什么，没有任何格式要求（不用标题、不用 markdown）。',
                value: draft.persona,
                onChange: (e) => setDraft((d) => ({ ...d, persona: e.target.value })),
                disabled: persona?.ok === false,
              }),
              h('div', { key: 'acts', style: css.row }, [
                h('button', { key: 's', style: css.button, disabled: personaBusy !== '' || persona?.ok === false, onClick: () => savePersona('persona') },
                  personaBusy === 'persona' ? '保存中…' : '保存人设'),
                h('span', { key: 'hint', style: css.stat }, '保存时会先备份；文本框里写什么，文件里就是什么'),
              ]),
            ]),
            h('div', { key: 'p2', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
              h('div', { key: 'l', style: css.meta }, [
                h('strong', { key: 'n' }, '工作规范与行为准则'),
                h('span', { key: 'd' }, '该怎么做 —— 每轮都会带上'),
              ]),
              h('textarea', {
                key: 'ta',
                style: { ...css.input, minHeight: 160, width: '100%', fontFamily: 'inherit', resize: 'vertical', lineHeight: 1.6 },
                placeholder: '想写什么就写什么，没有任何格式要求。',
                value: draft.rules,
                onChange: (e) => setDraft((d) => ({ ...d, rules: e.target.value })),
                disabled: persona?.ok === false,
              }),
              h('div', { key: 'acts', style: css.row }, [
                h('button', { key: 's', style: css.button, disabled: personaBusy !== '' || persona?.ok === false, onClick: () => savePersona('rules') },
                  personaBusy === 'rules' ? '保存中…' : '保存规范'),
                h('button', { key: 'r', style: css.button, disabled: personaBusy !== '', onClick: loadPersona }, '重新读取'),
                h('span', { key: 'hint', style: css.stat }, '保存后下一轮立刻生效，不用重启'),
              ]),
            ]),
          ]),
        ]),
        // 库选择器：只在发现多个库时出现。不猜"哪个工作区在活跃"——列出来让你选。
        state.stores.length > 1
          ? h('div', { key: 'stores', style: css.row }, [
              h('select', {
                key: 'sel',
                style: { ...css.input, flex: '1 1 320px' },
                value: String(state.active),
                onChange: (e) => setState((s) => ({ ...s, active: Number(e.target.value) })),
              }, state.stores.map((s, i) => h('option', { key: `st${i}`, value: String(i) },
                // V1.7：用户级库（workspace=null）显示它的 label —— 「用户级（跨工作区）」。
                // 以后加别的非工作区库也在 label 里说明，别落下纯目录名。
                `${s.kind === 'user' ? s.label : (s.workspace || s.label)}（${(s.entries ?? []).length} 条）`))),
            ])
          : null,
        h('div', { key: 'stats', style: css.stat },
          `共 ${entries.length} 条` +
            Object.entries(byLevel).map(([k, v]) => ` · ${LEVEL_LABEL[k] ?? k} ${v}`).join('') +
            (currentStore?.dbPath ? ` · 库文件：${currentStore.dbPath}` : '')),
        h('div', { key: 'bar', style: css.row }, [
          h('input', {
            key: 'q',
            style: css.input,
            placeholder: '搜索内容 / 标题 / 关键词 / 项目',
            value: query,
            onChange: (e) => setQuery(e.target.value),
          }),
          h('select', {
            key: 's',
            style: { ...css.input, flex: '0 0 auto', minWidth: 110 },
            value: statusFilter,
            onChange: (e) => setStatusFilter(e.target.value),
          }, [
            h('option', { key: 'a', value: 'active' }, '在用（有效，会被召回）'),
            h('option', { key: 's', value: 'stale' }, '已完成（做完了，内容仍有效）'),
            h('option', { key: 'x', value: 'archived' }, '已停用（不再注入，可恢复）'),
            h('option', { key: 'all', value: 'all' }, '全部'),
          ]),
          h('button', { key: 'r', style: css.button, onClick: reload, disabled: state.loading || busy !== '' }, '刷新'),
          h('button', {
            key: 'd',
            style: css.button,
            disabled: busy !== '',
            title: '把「每轮自动记录的流水」用模型整理成长期条目。会调用一次模型（消耗少量额度），需要先在插件配置里开启 autoDistill 或点这个按钮手动触发',
            onClick: doDistill,
          }, busy === 'distill' ? '整理中…' : '立即整理'),
        ]),
        // 状态说明：把「三个状态到底啥区别」写在界面上，别让用户猜
        h('div', { key: 'legend', style: { ...css.stat, opacity: 0.65 } },
          '状态说明：在用 = 有效且可能被召回；已完成 = 这件事做完了（内容仍有效）；已停用 = 不再被注入，但仍可搜到、可随时恢复'),
        // 显示优先级：动作的错误 > 快照读取的错误；任一存在就不显示提示语
        (state.error ?? state.snapshotError)
          ? h('div', { key: 'err', style: { ...css.stat, color: 'var(--dsw-alias-text-error, #d33)' } },
              `${state.error ? '出错了：' : '读取出错：'}${state.error ?? state.snapshotError}`)
          : null,
        !(state.error ?? state.snapshotError) && state.notice
          ? h('div', { key: 'notice', style: { ...css.stat, color: 'var(--dsw-alias-text-secondary, inherit)' } }, state.notice)
          : null,
        state.loading
          ? h('div', { key: 'load', style: css.stat }, '读取中…')
          : h('div', { key: 'list', style: css.list }, shown.length
            // 一行一条。**用 grid 而不是 flex**（2026-10-12 改）：
            //   flex 下"长文本挤别人换行"是必然的 —— 45 条里有 40 条没有标题，回落成
            //   「正文前 24 字」长度不可控，于是 tag 被挤得自己断行，出现"有些标签占两行"。
            //   grid 的列宽由整张表统一决定，每行严格等高、列与列对齐，长文本一律省略号。
            //   正文**不在前端展示**（用户决定）：想看全文悬停，或问我。
            ? shown.map((e, i) => renderRow(e, i, {
                disabled: busy !== '',
                onStatus: (status) => doSetStatus(e.id, status),
              }))
            : h('div', { key: 'empty', style: css.stat }, '没有符合条件的记忆。')),
      ]);
    }

    /**
     * 一行 = 一条记忆。**抽成纯函数**的两个理由：
     *   ① 布局不变量可以离线断言（渲染函数里 useState 拿不到列表数据，
     *      所以这条渲染路径以前从未被校验器碰到过 —— 见 verify-client.mjs）；
     *   ② 改样式时不用在几百行 JSX 里找。
     */
    function renderRow(e, index, { onStatus, disabled }) {
      return h('div', {
        key: e.id,
        style: {
          display: 'grid',
          gridTemplateColumns: LIST_COLS,
          alignItems: 'center',
          columnGap: 8,
          padding: '0 10px',
          height: ROW_HEIGHT,
          overflow: 'hidden',
          border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.28))',
          borderRadius: 8,
          boxSizing: 'border-box',
          // 斑马纹：长列表里好扫行（比全白底好认）
          background: index % 2 ? 'rgba(128,128,128,.05)' : 'transparent',
        },
      }, [
        h(Tag, { key: 'l', style: { width: 52, textAlign: 'center', boxSizing: 'border-box' } },
          LEVEL_LABEL[e.level] ?? e.level),
        h(Tag, {
          key: 'p',
          title: e.project ? `项目：${e.project}` : '没有项目归属',
          style: { maxWidth: 84, overflow: 'hidden', textOverflow: 'ellipsis' },
        }, e.project || '—'),
        h('span', {
          key: 't',
          title: e.title ? String(e.title) : String(e.content ?? '').slice(0, 120),
          style: { fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        }, e.title || String(e.content ?? '').replace(/\s+/g, ' ').slice(0, 24) || '(无标题)'),
        // 敏感单独一列（窄），不占标题的位置；没有就是空格子，列对齐不受影响
        e.sensitive
          ? h(Tag, { key: 'se', warn: true, title: '含敏感内容：永远不会被自动注入（脱敏后也不会）', style: { width: 30, textAlign: 'center', boxSizing: 'border-box' } }, '敏')
          : h('span', { key: 'se' }),
        h('span', {
          key: 'used',
          title: e.injectCount ? `被自动注入过 ${e.injectCount} 次` : '还没被自动注入过',
          style: { ...css.stat, textAlign: 'right', whiteSpace: 'nowrap', opacity: e.injectCount ? 0.8 : 0.35 },
        }, e.injectCount ? `${e.injectCount}×` : '–'),
        h('select', {
          key: 'st',
          style: { ...css.input, width: '100%', minWidth: 0, padding: '2px 6px', fontSize: 12 },
          value: e.status,
          disabled,
          title: '在用 = 有效且可能被召回；已完成 = 这件事做完了（内容仍有效）；已停用 = 不再被注入，但仍可搜到、可恢复',
          onChange: (ev) => onStatus(ev.target.value),
        }, [
          h('option', { key: 'a', value: 'active' }, '在用'),
          h('option', { key: 's', value: 'stale' }, '已完成'),
          h('option', { key: 'x', value: 'archived' }, '已停用'),
        ]),
      ]);
    }

    /** 组件级兜底：渲染抛错时给一句可读文案，而不是整块空白 */
    function apply(ctx) {
      // ⚠ 客户端 ctx 是「按声明才给服务」的代理：**未 inject 就取属性会抛**
      //    `cannot get property "slots" without inject`（真机报错原文，2026-10-11）。
      //    所以必须先 inject 声明，再在回调给的作用域里取服务。
      guarded('slots', () => {
        if (typeof ctx.inject !== 'function') return undefined;
        return ctx.inject(['slots'], (scoped) => {
          const slots = scoped?.slots;
          if (typeof slots?.inject !== 'function' || typeof slots?.register !== 'function') {
            console.warn('[memory-lite] slots 服务不可用，跳过设置页注册');
            return undefined;
          }
          return slots.inject('settings.section', () =>
            guarded('register', () =>
              slots.register(
                {
                  name: 'settings.section',
                  id: 'memory-lite',
                  order: 40,
                  label: () => '记忆控制',
                },
                function MemorySectionSafe(props) {
                  return h(Boundary, null, h(MemorySection, props));
                },
              ),
            ),
          );
        });
      });
    }

    // `__test` 是给离线校验器用的（verify-client.mjs 用它断言列表布局不变量：
    // 每行等高、列模板一致、标签不换行、长文本省略号）。运行时没有任何代码读它，
    // 多这一个字段比"每次改样式都靠人眼"划算。
    return { apply, name: 'dsh-plugin-memory-lite', __test: { renderRow, LIST_COLS, ROW_HEIGHT, css } };
  },
});
