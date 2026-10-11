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
        padding: '1px 6px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
        opacity: 0.9,
      },
      stat: { fontSize: 12, opacity: 0.8 },
    };

    function Tag({ children, warn }) {
      return h('span', {
        style: warn ? { ...css.tag, color: 'var(--dsw-alias-text-warning, #c98a00)' } : css.tag,
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
        // 库选择器：只在发现多个库时出现。不猜"哪个工作区在活跃"——列出来让你选。
        state.stores.length > 1
          ? h('div', { key: 'stores', style: css.row }, [
              h('select', {
                key: 'sel',
                style: { ...css.input, flex: '1 1 320px' },
                value: String(state.active),
                onChange: (e) => setState((s) => ({ ...s, active: Number(e.target.value) })),
              }, state.stores.map((s, i) => h('option', { key: `st${i}`, value: String(i) },
                `${s.workspace || s.label}（${(s.entries ?? []).length} 条）`))),
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
            ? shown.map((e) => h('div', { key: e.id, style: css.card }, [
                h('div', { key: 'm', style: css.meta }, [
                  h('strong', { key: 'l' }, LEVEL_LABEL[e.level] ?? e.level),
                  e.project ? h(Tag, { key: 'p' }, e.project) : null,
                  e.subcategory ? h(Tag, { key: 'c' }, e.subcategory) : null,
                  h(Tag, { key: 'st' }, STATUS_LABEL[e.status] ?? e.status),
                  h('span', { key: 'i' }, `重要性 ${e.importance}`),
                  // V2-1 注入可见性：让"记忆到底有没有在工作"一眼可见
                  h('span', {
                    key: 'used',
                    title: '这条记忆被自动注入进对话的次数（括号内是最近一次的时间）',
                  }, e.injectCount ? `用过 ${e.injectCount} 次${e.lastInjectedAt ? `（${fmtTime(e.lastInjectedAt)}）` : ''}` : '还没被用过'),
                  e.sensitive ? h(Tag, { key: 'se', warn: true }, '敏感·不注入') : null,
                  h('span', { key: 't' }, fmtTime(e.updatedAt)),
                ].filter(Boolean)),
                h('div', { key: 'b', style: css.body }, String(e.content ?? '').slice(0, 600)),
                e.keywords?.length
                  ? h('div', { key: 'k', style: css.meta }, e.keywords.slice(0, 13).map((k, i) => h(Tag, { key: `k${i}` }, k)))
                  : null,
                h('div', { key: 'a', style: css.row }, [
                  e.status !== 'archived'
                    ? h('button', {
                        key: 'ar',
                        style: css.button,
                        disabled: busy !== '',
                        title: '这条不再正确或不再需要（过时、被取代、写错了）→ 不再被注入，但仍可搜到、可恢复',
                        onClick: () => doSetStatus(e.id, 'archived'),
                      }, '不再使用')
                    : h('button', {
                        key: 'un',
                        style: css.button,
                        disabled: busy !== '',
                        title: '重新启用这条记忆（回到「在用」）',
                        onClick: () => doSetStatus(e.id, 'active'),
                      }, '恢复使用'),
                  e.status === 'active'
                    ? h('button', {
                        key: 'st2',
                        style: css.button,
                        disabled: busy !== '',
                        title: '这件事已经做完了（todo 完成 / 话题达成目标）→ 内容仍然有效、仍可被搜到与召回，只是标记为已结束',
                        onClick: () => doSetStatus(e.id, 'stale'),
                      }, '已完成')
                    : null,
                  e.status === 'stale'
                    ? h('button', {
                        key: 're2',
                        style: css.button,
                        disabled: busy !== '',
                        title: '改回「在用」（例如这件事又需要继续跟进）',
                        onClick: () => doSetStatus(e.id, 'active'),
                      }, '重新进行')
                    : null,
                  h('span', { key: 'id', style: { ...css.meta, fontSize: 11 } }, e.id),
                ].filter(Boolean)),
              ]))
            : h('div', { key: 'empty', style: css.stat }, '没有符合条件的记忆。')),
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

    return { apply, name: 'dsh-plugin-memory-lite' };
  },
});
