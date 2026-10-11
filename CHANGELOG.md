# 变更记录

本文件记录每个**打过标签**的版本。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

**怎么钉版本**（避免"装到一半上游改了"）：

```sh
dsh plugin --profile <你的profile名> add github:eighteentang/dsh-plugin-memory-lite#v1.2.0
```

---

## [1.2.0] - 2026-10-11

这一版的三项都不是"想到什么做什么"，而是**先量了真库**再定（量法与数字见 `AGENTS.md`
的「V3 实测依据」一节）。量的时候把库**拷一份到临时目录**再跑 —— `search()` 会写
`hit_count`，直接在真库上量会把面板的「用过 N 次」灌水。

### 修复

- **蒸馏看到的其实是同一段系统样板**
  日志一条 = 一整轮，里面夹着宿主以 `<system-reminder>` 注入的用户全局 `AGENTS.md`。
  而蒸馏原本只取**前 1500 字** —— 实测 10 条真实日志里**有 7 条的"前 1500 字"逐字相同**，
  最大的 4 条（7~10 万字）只能看到 **1.4%~2%**。也就是说：模型拿到的不是"这一轮发生了什么"，
  而是同一段样板，蒸馏出来的条目自然只能反映那段样板。
  现在 `pickLogExcerpt()` **先剔样板再截断**：整块剔除 `<system-reminder>` / `<environment_context>`
  （含未闭合的）、逐行剔运行时样板（`Runtime context.` / `Elapsed since …` / `Browser time zone …`），
  再把重心放到**尾部**（头 40% + 中略标记 + 尾 60% —— 结论在尾部，提问在头部）。
  总字符：649,870 → 450,701（降到 69.4%）。

### 新增

- **召回观测（`recall_runs` 表）**：**每一轮**召回尝试都落一行，**包括 0 命中的那种**。
  以前回答不了"召回到底命中多少轮" —— 日志层存的是一整轮文本，拿不到"当时那句 query"，
  于是离线既复现不了、也验收不了任何检索改动。现在配 `tools/diag/diag-recall-quality.mjs`
  可以在库副本上**逐条重放**，给出零命中率与和历史记录的差异。
  query 落库前过 `redactSecrets()` 并截到 500 字；只保留最近 500 行（观测数据不该让库膨胀）。

### 变更

- **常驻索引段每条只列 20 字**（原为 48 字）。实测依据：33 条真实记忆时索引段已占
  3431/4096 B（83.8%），**每行 123 B**（30/33 条没有标题，回落到"正文前 48 字"，
  中文 1 字 = 3 B）→ 只装得下约 33 条，再多就会**静默**从 system prompt 里消失。
  截到 20 字后每行约 83 B，约能装 49 条（+48%）。
  ⚠ **不要用"给旧条目回填标题"来解决这件事** —— 回填的标题同样会被截断，额外容量是 0；
  要调容量就调 `INDEX_TITLE_CHARS`。

### 开发期修掉的两个"校验器假绿"

- **假 ctx 覆盖了同名事件的多个处理函数**：`verify-v1` 原本用 `Map<事件, 函数>` 存处理函数，
  而 `apply()` 对 `agent/pre-step` 注册了**两个**（召回、压缩后补回），后一个把前一个覆盖 ——
  于是"pre-step 只追加不改写"实际测的是**补回**分支，**每轮都在跑的召回分支从未被检验过**。
  现在改成数组并按真实瀑布语义串起来跑，召回路径的断言才真正生效。
- **校验器污染真实注册表**：`apply()` 会往 `$DSH_HOME/memory-lite/workspaces.json` 登记工作区库，
  而校验器用的是临时目录 —— 每跑一次就留下一条指向已删除路径的记录。现在校验器先把
  `DSH_HOME` 指向临时目录再加载 `index.js`。

---

## [1.1.0] - 2026-10-11

首个版本。

### 功能

- **两层记忆**
  - **日志层**：每轮对话结束把内容原样追加到本地 SQLite（**零模型调用**），
    每会话上限约 200 条，溢出**先写归档文件再删库内行**（不静默丢）
  - **长期条目层**：把日志蒸馏成记忆条目。**默认手动触发**（点「立即整理」），
    可开 `autoDistill` 让它空闲时自己整理（默认关，避免没打招呼就花额度）
- **注入**（每轮自动，零成本）
  - 恒定索引段放进 system prompt（字节稳定，护前缀缓存）
  - 命中的记忆作为**独立消息追加在尾部**，不改写已有历史
  - 同一会话已注入过的不重复注入；**压缩后自动补回**常驻记忆
- **检索**：FTS5 + LIKE 双路，精确子串独占最高层，其余按 基分 × 重要性 × 时效 排序
- **跨工作区检索**：`memory_search` 传 `scope="all"` 可搜所有已知工作区，结果标注来源
- **注入可见性**：逐轮记录注入了哪些条目；面板显示「用过 N 次（最近一次）」
- **七层语义**：`soul` / `user` / `rules` / `fact` / `lesson` / `topic` / `project`（含子类）
- **设置页「记忆控制」**：查看、搜索、按层级/状态筛选、改状态、手动整理
- **六个模型工具**：`memory_note` / `memory_search` / `memory_read` / `memory_update` /
  `memory_forget`（**删除走人工审批**）/ `memory_stats`
- **本地优先**：不联网、不上传；库文件 0600 + WAL

### 安全

- **敏感内容双防线**：写入时单点脱敏（密钥类正则）+ `sensitive` 在**写入时**判定并落列，
  注入侧只读列（fail-closed —— 注入路径上再判断等于把 fail-closed 变成 fail-open）
- **删除走审批**：`memory_forget` 声明为破坏性工具，转人工确认

### 修复（开发期实测发现的问题）

- **蒸馏调用没给 `provider` → `NO_ADAPTER`**：`ctx.llm.stream()` 的 `provider` **不能省**
  （框架没有全局默认提供方；参照 `dsh-compaction-basic`，它用的是自己配置的
  `summarizationProvider` / `summarizationModel`）。现在显式配置优先，
  否则从 `ctx.llm.listProviders()` / `listModels()` 发现候选并**逐个尝试**
  （`NO_ADAPTER` / 凭据类失败就换下一个），成功的那对会记进 `distill_runs.note`
- **正常结束被误判成错误**：`{type:'finish', reason:'stop'}` 的 `reason` 是**字符串**，
  第一版把它也当失败 → 每次整理都报「模型流错误：stop」。
  现在只有对象形态的 `reason` / `failure`（带 kind/code）才算失败
- **前端吞掉真实错误**：失败时界面只显示「整理未完成：error」
  （代码优先显示 `reason`，而它恒为 `"error"`），真正的 `message` 被丢掉。现在显示完整原因
- **蒸馏提示词构造的 TDZ**：`const known = ... ${known.map(...)}` —— 在变量自己的初始化
  表达式里引用它，命中暂时性死区直接抛 `Cannot access 'known' before initialization`。
  **只在「已有记忆标题非空」时触发**，空库第一次整理反而正常
- **`ctx.llm.stream()` 用法**：真实签名是 `stream({ messages: [...] })` 且返回**异步可迭代**，
  必须 `for await` 消费 `text-delta` 分片。早期写成 `{system, prompt}` + `await`，
  于是"调用成功但产出为空（raw 长度 0）"
- **蒸馏输入无上限**：实测送进去 14.7 万字（单条 7.4 万）导致模型零产出。
  现在单条截断 1500 字、总量 ≤20000 字，**超预算的流水留到下次**而不是标记成已处理
- **面板读错库**：面板没有 agent 上下文，任何"推断当前工作区"的方案在冷启动时都会落回
  空的全局回退库 → 显示 0 条。改为**发现式定位**（注册表 + 扫描 + 库内 meta），
  并列多个库供选择
- **注册表 BOM**：PowerShell 写 JSON 会带 BOM，`JSON.parse` 直接抛，而当时的 catch
  静默返回空数组 → 面板永远 0 条。现在容错 BOM 且读失败会记日志
- **中文检索**：FTS5 的 `unicode61` 把连续 CJK 当一个整体 token，
  必须传完整连续串；LIKE 回退也不能拿整串匹配（要求相邻必 0 行）
- **客户端 ctx 是声明门控代理**：未 `inject` 就取属性会抛
  `cannot get property "slots" without inject`
- **插件卡片没名字没图标**：元数据在 `locale/en.json` 的 `meta` 里，
  **不在 `package.json` 的 `meta`**；且 locale 受 `exports` 门控（缺了会静默略过）

### 已知限制

- 检索是**关键词级**的，不是语义向量检索 —— 换个说法可能搜不到
- 每个工作区一个库，默认只搜当前工作区（跨库要显式 `scope="all"`）
- 空闲自动整理依赖宿主进程活着（客户端关着时不会整理）

---

[1.1.0]: https://github.com/eighteentang/dsh-plugin-memory-lite/releases/tag/v1.1.0
[1.2.0]: https://github.com/eighteentang/dsh-plugin-memory-lite/releases/tag/v1.2.0
