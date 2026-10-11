# 变更记录

本文件记录每个**打过标签**的版本。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

**怎么钉版本**（避免"装到一半上游改了"）：

```sh
dsh plugin --profile <你的profile名> add github:eighteentang/dsh-plugin-memory-lite#v1.1.0
```

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
