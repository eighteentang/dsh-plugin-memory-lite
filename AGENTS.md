# D:\DSH-dev\memory-lite —— 工作区约定

> 这是**开发工作台**（`D:\DSH-dev`）下的项目，不是用户包。
> 用户包只有 `D:\EasyDSH`。验证通过后的产品代码才复制过去。

---

## 一、这个目录是什么

`memory-lite` 是我们自研的 DSH 记忆插件。但**当前阶段它不是产品代码，是探针**：
目的是先把两个"判错就白写"的障碍实测清楚，再写正式代码。

```
D:\DSH-dev\memory-lite\
├─ package.json                          bundle manifest（含关键的 peerDependencies）
├─ cordis.patch.yml                      loader patch：insert 一行
├─ index.js                              探针：4 个探测点
├─ tools/verify/verify-memory-lite-probe.mjs   离线校验器（21 项）
└─ AGENTS.md                             本文件
```

**正式插件的规划方案**（V1 六件事、文件结构、7 步落地）在会话记录里，
尚未落成文件。写代码前先回看：只做「薄切片」，不做功能广度。

---

## 二、验证命令

```powershell
$N = "C:\Users\10454\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $N D:\DSH-dev\memory-lite\tools\verify\verify-memory-lite-probe.mjs
```

产物：`$DSH_HOME\memory-lite-probe.log`（探针自己写的取证日志，宿主 console 不落盘）。

---

## 三、E35 的真实机理（已从 app.asar 读到，比经验库的表述更准确）

**文件**：`dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`（4138 行）
**关键函数**：`installRuntimeInterception`（:1641）、`findInterceptionLayer`（:1214）、
`routeLinked`（:1471）

DSH 在 app 进程里给 Node 的 ESM/CJS loader 装了 **in-memory profile package routing**：

```js
// :1643
const router = new ResolutionRouter(resolution, (directory) => cjs._nodeModulePaths(directory));
```

- 包路径在 **profiles 树**内 → 用该 profile 的 node_modules 层（能解析到只存在于 app.asar 的包）
- 包路径在 **linkedPaths** 内（即 `link:` 插件的真实路径）→ `{kind:'linked'}`，
  **没有 profile 层可借**，走 `routeLinked`（:1471）
- 路径前缀都不匹配（`$DSH_HOME` 之外）→ 完全不路由 → 只能靠 Node 原生逐级向上找 → 失败

`routeLinked` 放行 interception 的**唯一条件**（:1479）：

```js
if (ancestorSet.has(searchPath) && readPeerNames(directory).has(name)) { ... interception ... }
```

`ancestorSet` 与 `searchPath` 同源（都由 `_nodeModulePaths` 产生、从后往前配对），
**第一个条件恒真**；真正的门是 `readPeerNames(directory)` ——
读的是**那个目录的 `package.json` 的 `peerDependencies` 键**。

> **推论（待实测）**：`link:` 装法下想解析 `@deepseek-ai/*`，必须在**插件自己的
> `package.json` 里把它声明为 `peerDependencies`**。
> 这是**结构**而不是"记得"（见经验库 E19）—— 写进 manifest，就不依赖谁记得。

⚠ **不要用裸 node 复现 E35 来下结论**：裸 node 没有那层 router，
任何位置的 `import '@deepseek-ai/*'` 都会失败。必须装进 profile 才有判据。

---

## 四、E18 的结论（**已确认**，含真机证据）

`ctx.tools.register` 的 `parameters` 形态：

| 形态 | 注册期 | 模型调用时 |
|---|---|---|
| 真 JSON Schema `{type:'object',properties:{...},required:[...]}` | 接受 | ✅ 可用（待 v2 真机确认端到端） |
| DSH 简写 `{参数名:{type,required}}` | **也接受**（注册期不校验！） | ❌ **炸整轮** |

真机报错原文（v1 探针，2026-10-11）：

```
本轮运行失败 Invalid schema for function 'probe_shorthand':
schema must be a JSON Schema of 'type: "object"', got 'type: null'.
```

**判据推论**：简写不是"注册就会被拒"，而是**注册期静默通过、下游（发给 provider 时）才炸**——
而且炸的方式是**整个会话那一轮失败**，不是工具返回错误。这比经验库 E18 的表述更严重。
所以：**外部插件必须自己把简写转成真 JSON Schema**（`shorthandToJsonSchema()` 见 index.js，
或直接手写真 JSON Schema）。

### ⚠⚠ 探针的第一原则（v1 违反过，代价是打断用户一轮会话）

**不要把 schema 非法的工具注册成模型可见的探针。** 探针的观测点必须是"只读/只记录"的，
或者"可安全调用"的。v1 把 `probe_shorthand`（非法 schema）注册成了模型可见工具，
模型一调用它就炸掉整轮对话 —— 这违反了"失败只影响探针自己"。
**正确做法**：注册期探测（注册后立刻 `disposer()`），结论只写日志；
模型可见的工具**只能有一个且必须合法**。校验器已加断言守着这条：
`存活工具中没有简写（非法）schema` + `模型可见的工具只有 probe_ok`。

---

## 四之二、E35 的结论（部分确认，还需一次干净重跑）

- **已确认**：`link:` 装法下（profile 里 `link:D:/DSH-dev/memory-lite`，node_modules 是
  Junction 指向真实路径）插件**能加载、能注册工具、能注册 systemPrompt 段**
  —— peerDependencies 那个条件起了作用（至少让插件活了下来）。
- **待确认**：`@deepseek-ai/dsh-tools` 在 **app 进程里**仍解析失败（日志
  `defineTool-probe: ERR_MODULE_NOT_FOUND`）。但 v1 的日志混进了我自己离线校验器写的行
  （离线跑时路径同样在 `$DSH_HOME` 之外，必然失败），所以**这条还不能当结论**。
  v2 用 `RUN` 前缀区分「app 加载」与「离线校验」，并用 `app-import-probe` 一次性报三个包。
- **前提**：`ctx.tools.register` / `systemPrompt.section` 都能在**不 import 任何
  `@deepseek-ai/*`** 的情况下用（v1 已证实）—— 所以"解析不到"并不阻塞插件开发，
  只是不能用 `defineTool()` 等辅助函数。

---

## 五、安装：这一步做不了，必须人来

**本会话没有 `plugin_manager` 工具**（那是宿主侧 agent 工具），也没有 `dsh` CLI
（DSH 本体在 `app.asar` 内，runtime 里只有 node/pnpm/python）。所以：

1. 在 DSH 的**插件**页面添加本地/目录来源的插件，指向 `D:\DSH-dev\memory-lite`
2. 或由具备 `plugin_manager` 的 agent 用 `action: install_bundle` 装
3. 装完看 `C:\Users\10454\.dsh\memory-lite-probe.log` 与插件页面的错误信息

### ⚠ 风险与回滚

探针插件若因 load 失败拖累 profile，DSH 崩溃弹窗上有「禁用第三方插件」按钮；
正规恢复入口是 `plugin_manager` 的 `set_bundle` / `remove_bundle`。
**不要手改 profile 的 `package.json` 或 `cordis.patch.yml`** —— 那是 loader 层配置，
需要重启才会重读，而且手改会绕过 install_bundle 的一致性检查。

---

## 六、离线校验器能验什么 / 不能验什么

**能验**：manifest 合法性、patch 与包名一致性、JS 语法与顶层求值、
`apply(fakeCtx)` 行为、注册/释放是否成对、段的 `interpolate:false`、日志是否写对。

**不能验**（必须真装）：
- `link:` 装法下 `@deepseek-ai/*` 的真实解析（app 进程的 in-memory router）
- 简写形态在**模型真调用**时是否被下游拒（`Invalid schema for function`）
- `systemPrompt` 段的字节稳定性与 order 落点

> 校验器的假 ctx 有个**已知易错点**：`ctx.effect(fn)` 的契约是
> 「把 `fn` 的**返回值**注册为释放函数」。早期版本写成 `const d = fn()` 直接执行，
> 等于 apply 期间就把插件清理跑掉，会让"注册/释放成对"的断言变成假绿。
> 见 [verify-memory-lite-probe.mjs](tools/verify/verify-memory-lite-probe.mjs) 里的注释。

---

## 七、环境事实（本机，2026-10-11 核对）

- 宿主：`@deepseek-ai/dsh-desktop 0.2.0-rc.2`（`runtime.json` 与 asar 内 package.json）
- Node：`v24.21.0`（DSH 自带 runtime）
- Cordis：`4.0.4`
- profile：`desktop`（`C:\Users\10454\.dsh\profiles\desktop`）
- 已装插件：`dsh-plugin-dev-tools`(link) / `dsh-plugin-im-bridge`(link) / `dsh-context` /
  `@changfenhuang/dsh-genui` / `meow-memory`
- `@deepseek-ai/*` **不存在于任何 profile 的 node_modules** —— 只活在 app.asar 内，
  靠上面那层 in-memory router 暴露

## 八、参考实现（已克隆，只读）

`D:\DSH-dev\ref-plugins\` 下有 13 个仓库 + 一份横向对比笔记
（`_analysis\横向对比-接缝用法.md`）。要抄具体写法时的首选：

| 抄什么 | 去哪抄 |
|---|---|
| `agent/pre-step` 尾部追加注入（官方范式） | `app.asar` 的 `dsh-agent-instructions/lib/index.js`（用 `diag-grep-asar.mjs` 读） |
| 静态段 + 动态消息分离（护前缀缓存） | `ref-plugins\dsh-meow-memory\src\index.ts`、`Aik358-dsh-auto-memory\lib\index.js` |
| 敏感标题整段排除（比密钥正则强） | `Aik358-dsh-auto-memory\lib\injection-policy.js` |
| 破坏性操作交宿主审批 | `AskTheWay-dsh-auto-memory\src\tools.ts`（`tools/pre-execute` 返回 `{kind:'ask'}`） |
| 注入边界防御（花括号中和 / 代理对安全截断） | `ref-plugins\mneme\dsh-mneme\src\inject.js` |

---

## 九、V1 正式代码（开发中）

**目录**（探针已归档到 `D:\DSH-dev\tools\legacy\memory-lite-probe\`，不再参与运行时）：

```
D:\DSH-dev\memory-lite\
├─ package.json / cordis.patch.yml       bundle manifest（含 peerDependencies / icon / exports）
├─ index.js                              插件入口（apply 箭头函数 / 动态 import / 每处 guard）
├─ lib/config.js                         配置 + 预算常量 + Standard Schema + 文本中和
├─ lib/storage.js                        记忆库（node:sqlite）：entries + FTS5 + 注入记录 + 日志层
├─ lib/capture.js                        第 1 档：每轮自动落日志
├─ lib/distill.js                        第 2 档：蒸馏（含 shouldAutoDistill 闸门 / 流式消费）
├─ lib/inject.js                         注入：恒定段 + 尾部追加 + 自抑制
├─ lib/prompt.js                         注入文本与索引段渲染
├─ lib/tools.js                          模型工具（真 JSON Schema + 审批闸门 + 跨库检索）
├─ client/client.js                      设置页「记忆控制」客户端 bundle
├─ locale/{en,zh}.json                   插件卡片标题/描述（★ 不是 package.json 的 meta）
├─ icon.svg                              插件卡片图标（≤256 KiB，相对路径）
├─ README.md / LICENSE                   对外文档
├─ CHANGELOG.md                          变更记录（Keep a Changelog 格式）
└─ tools/
    ├─ verify/                           5 个校验器（共 158 项）
    ├─ diag/                             诊断脚本（库状态 / 注册表 / 元数据 / 表结构）
    ├─ migrate/                          meow → memory-lite 迁移
    └─ release/release-copy.mjs          白名单发布到 D:\EasyDSH\memory-lite
```

> **探针去哪了**（2026-10-11）：移到了 `D:\DSH-dev\tools\legacy\memory-lite-probe\`。
> 它完成使命后留在插件目录里是**误导**（下次进来的人会以为还是现役代码）。
> 归档位置与项目里其他历史资料一致（`tools/legacy/`）。

### ⚠⚠ 绝对不要用 PowerShell 改这个项目的源码（2026-10-11 血的教训）

我用这一行「顺手」把 `limit * 4` 改成 `limit * 8`：

```powershell
(Get-Content $p -Raw) -replace 'a','b' | Set-Content $p -Encoding UTF8
```

结果 **`storage.js` 被改坏，最后整份重写**：

| 破坏 | 原因 |
|---|---|
| 中文全变乱码（`外键` → `澶栭敭`） | `Get-Content -Raw` **不带 `-Encoding` 时用 ANSI 代码页解码** UTF-8 文件 |
| 换行被吞（注释和下一行粘在一起） | GBK 解码时把换行字节当成了多字节字符的一部分 |
| 出现 `�`（真丢字节） | 无效序列被替换成 U+FFFD，**不可逆** |

**逆向恢复只能救回一部分**（字符能回、被吞的换行和丢掉的字节回不来）。
**正确做法**：改源码一律用 `write` / `edit` 工具；确实要在 shell 里读写 UTF-8，
用 .NET 显式指定编码：

```powershell
$t = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))
```

**判据**：只要命令里出现 `Get-Content`/`Set-Content`/`Out-File` 改源码文件 → 停下换工具。

---

### ctx.llm 的真实契约（第三个真机未知，已解决 2026-10-11）

**官方文档**：`dsh/node_modules/@deepseek-ai/dsh-llm/README.zh.md:50-57`（用 `diag-read-doc.mjs` 读）

```js
for await (const chunk of ctx.llm.stream({
  provider: 'deepseek-official',   // ⚠ 必给！不能省 —— 见下面第三条坑
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
})) {
  // 分片类型：block-start, text-delta, ..., usage, finish
}
```

**我踩的坑（三处，症状各不相同）：**

| 我写的 | 真实契约 | 后果 |
|---|---|---|
| `{ system, prompt, maxTokens }` | `{ messages: [{role, content:[{type:'text',text}]}] }` | 模型收到空输入 |
| `await ctx.llm.stream(...)` | 返回**异步可迭代**，要 `for await` 消费 `text-delta` | 拿到迭代器本身 → 文本长度 0 |
| **省略 `provider`** | **必给**（框架没有全局默认提供方） | `NO_ADAPTER: no adapter registered for provider "undefined"` |

**症状**：`distill_runs` 里 `outcome=ok, created=0, note="模型未产出条目（raw 长度 0）"`。
**判据**：看到「调用成功但产出为空」时，**先核对参数名与消费方式**，别急着改提示词。

**关于 provider（2026-10-11 真机第二次失败）**：

文档里"direct call 会用已配置的提供方/模型对，回退到最近一次已记录请求目标，
再回退到 AgentOptions"这句话**误导了我** —— 实测省略 provider 直接失败。
参照 `dsh-compaction-basic`：它用的是**自己的配置项** `summarizationProvider` /
`summarizationModel`。**结论：框架没有全局默认提供方，每个调用方都得自己指定。**

正确做法（已实现，见 `resolveDistillTargets()`）：

1. 显式配置优先（`config.distillProvider` / `distillModel`）
2. 否则从 **`ctx.llm.listProviders()`**（同步，按注册顺序）逐个发现，
   各取 **`ctx.llm.listModels(provider)`**（**异步**，返回 `{provider,id,name,…}`）的第一个模型
3. **按顺序尝试**：遇到 `NO_ADAPTER` / `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` / `AUTH`
   就换下一个；其它错误（如 `CONTEXT_WINDOW_EXCEEDED`）直接放弃，不浪费尝试
4. 一个候选都没有 → 返回 `no-provider` 并提示去配置（而不是抛 NO_ADAPTER 谜题）

**失败分片的真实形状**：`{ type:'finish', reason:{ kind:'error', failure:{ code, message } } }`
（注意是 `reason.failure`，不是顶层 `failure`）。稳定 code：`NO_ADAPTER` /
`MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` / `AUTH` / `RATE_LIMIT` / `CONTEXT_WINDOW_EXCEEDED`。
**按 code 处理，不要解析消息文本。**

> ⚠ **一个被校验器抓到的误判**：正常结束分片是 `{ type:'finish', reason:'stop' }` ——
> `reason` 是**字符串**。我第一版把"字符串 reason"也当失败，于是每次整理都会报
> `模型流错误：stop`。**判据：只有对象形态的 reason（带 kind/failure）才是失败。**
> 这个 bug 在真机上会表现为"永远报错"，是 `verify-v2` 第 ⑤ 组断言拦下来的。

**诊断手段**：宿主路由 `GET /dsh-memory-lite/api/llm-probe` 返回这台机器上
实际注册的提供方、各自的模型、以及解析出的候选列表 —— 排查"模型调不通"先看它。

**顺带修掉的一类隐患**：流里的 `error` 分片、或空内容，**必须判失败**，
不能记成 `outcome=ok` —— 否则失败会伪装成"整理成功但没内容"，谁也发现不了。
现在两条都有断言守着（`verify-v1` 的负面路径）。

---

### 插件展示元数据：真实契约（读源码确认，2026-10-11）

**规则来源**：`dsh-app-boot/lib/index.js` 的
`readPluginMeta()` / `iconOf()` / `dictionariesOf()` / `localizedText()`。
（asar 只能宿主侧读：用 `diag-read-doc.mjs` 读它。）

| 项 | 真实规则 |
|---|---|
| 标题/描述 | 来自 **`locale/en.json`** 的 `{"meta":{"title","description"}}` |
| ⚠ 无效字段 | **package.json 里的 `meta` 根本不被读**（im-bridge 里有这个字段，是无效的） |
| `en.json` | **是 base**：它不存在 → 其他语言也一概不查 |
| 其他语言 | `locale/<lang>.json`，lang 必须匹配 `/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/` |
| 返回值 | 语言→文本的映射，且**始终保留 `en` 回退**（`{en: ..., zh: ...}`） |
| 回退链 | 没有 locale → 用 package.json 的 `name`（标题）/ `description` |
| 图标 | package.json 顶层 **`icon`** = **相对路径**；svg/png/jpeg/webp；**≤256 KiB**；realpath 后不能出包目录；绝对路径或带 scheme **会抛** |

**四种失效方式全是静默的**（插件照常工作，只是卡片没名字/没图标、不报错）：

1. `exports` 里没有 locale 子路径 → locale 经 **Node ESM 解析器**读取，
   报 `ERR_PACKAGE_PATH_NOT_EXPORTED`，而代码把这类错误当"没有元数据"**略过**
2. `locale/en.json` 不存在 → 连 `zh.json` 也不会被查
3. npm `files` 数组不含 `locale`/`icon` → 发布出去的包里就没有它们
4. locale JSON 文件名不是合法语言 id → 直接抛错，整个元数据失败

**已经把这些固化进 `tools/verify/verify-package-meta.mjs`（17 项）** ——
包括"package.json 里不该有 `meta` 字段"这条反向断言，免得以后有人"顺手加回去"。

### 发布流程：白名单复制（`tools/release/release-copy.mjs`）

开发在 `D:\DSH-dev\memory-lite`，发布到 `D:\EasyDSH\memory-lite`（产品）。

```powershell
$N = "C:\Users\10454\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $N D:\DSH-dev\memory-lite\tools\release\release-copy.mjs           # 演练（不写）
& $N D:\DSH-dev\memory-lite\tools\release\release-copy.mjs --apply   # 真复制
```

**git 仓库在开发目录**（`D:\DSH-dev\memory-lite`，2026-10-11 首次提交 `cf0f213`），
**不在用户包**。理由：版本控制应该覆盖校验器、诊断脚本、AGENTS.md 这些工程资产，
而它们按约定不许进用户包 —— 若把仓库建在用户包里，这些资产就落不进版本库。
对外发布由 `package.json` 的 `files` 字段门控，与仓库位置无关。

> 对比 im-bridge：它的开发目录**就是**产品目录（`D:\EasyDSH\im-bridge`，profile 直接链到那里），
> 所以它的 `.git` 在用户包里 —— 那不是矛盾，是因为它没有单独的开发目录。
> **发布副本（`D:\EasyDSH\memory-lite`）是构建产物**：改了 DSH-dev 的源码后必须重跑发布脚本，否则两边会漂移。

**为什么是白名单而不是黑名单**：黑名单一定会漏（"靠记得排除什么"是本项目反复失败的模式）。
脚本还会①清掉目标目录里不在白名单的残留；②**在自检里拦开发产物**；
③缺 `locale/en.json`、`locale/zh.json`、`icon.svg` 时直接报错。

**两个自己踩过的坑（都写进了脚本）**：

- **白名单里放目录 = 变相黑名单**：我一开始写 `lib/`，于是 `lib/storage.js.corrupt-bak`
  （一次误操作留下的备份）被演练抓出来要发布出去。现在加了 `JUNK_PATTERNS`
  在复制前**报错**，而不是静默带出去。
- **自检用子串匹配会误报**：`FORBIDDEN.includes(f)` 把 `lib/tools.js`（正常的源文件）
  当成了开发产物目录 `tools/`。必须**按路径段**匹配（`parts.includes('tools')`）。

---

### V2 四项（2026-10-11）

| 项 | 做了什么 | 关键取舍 |
|---|---|---|
| **V2-1 注入可见性** | `injections` 表逐轮记录 + entries 加 `inject_count`/`last_injected_at`；面板显示"用过 N 次"；`memory_search` 的元数据视图也带上 | **逐轮流水比计数器重要**：计数器只能说"注入过"，流水才能回答"哪一轮、注入了什么" |
| **V2-2 空闲自动整理** | `autoDistill` 默认开；四道闸门（空闲 30 分钟 / 冷却 30 分钟 / 每日 4 次 / 有流水可整理） | **闸门抽成纯函数 `shouldAutoDistill()`** —— 原来写在 `setInterval` 里，校验器没有入口，只能真机等 30 分钟 |
| **V2-3 检索质量** | 精确子串独占最高层；其余按 基分 × 重要性系数 × 时效系数（半衰期 60 天、下限 0.5）；相对下限砍掉不相关的 | 系数都有出处（git-memory 的 tier 0 / mneme 的重要性加权 / prime-memory 的衰减下限），**不是自己拍的** |
| **V2-4 跨工作区检索** | `memory_search` 加 `scope="all"`，扫全部已知库并按分数合并，每条标注来源工作区 | 复用了面板那套库发现逻辑 —— 两边不一致会让人以为数据丢了 |

**V2-2 那条的方法论值得单独记住**：凡"写在定时器/回调里的判断逻辑"，
**都应该抽成纯函数**，否则它只能靠人工等待来验证 —— 而人工等待的结果通常是"永远不验"。
抽出来之后，五条闸门分支校验器一次全走（`verify-v2.mjs` 的 ①②③④⑤）。

---
### 客户端 bundle 的两个实测坑（真机报错换来的，2026-10-11）

**坑 1 · 客户端 ctx 是「按声明才给服务」的代理 —— 未 inject 就取属性会抛。**
真机报错原文：

```
client.js:41 memory-lite(client): slots failed: cannot get property "slots" without inject
```

错误写法：`if (typeof ctx.slots?.inject !== 'function')` —— **这行本身就抛**。
正确写法（im-bridge / dsh-context / genui 都这样）：

```js
ctx.inject(['slots'], (scoped) => {
  scoped.slots.inject('settings.section', () => scoped.slots.register({...}, Component));
});
```

**坑 2 · 函数组件里 `h(ClassComponent)` 是合法的，但校验器必须用 `new` 展开它。**
真实 React 内部用 `new` 实例化 class 组件；如果校验器的假渲染器把 class 组件当函数调，
会抛 `Class constructor X cannot be invoked without 'new'` —— 那是**校验器错**，不是代码错。
但反过来说：如果假渲染器**不展开 class 组件**，那"渲染路径是否可跑"就从未被验到（假绿）。

### ⚠ 关于假 ctx：假环境比真环境宽松 = 校验器假绿

这两个坑都逃过了离线校验，根因是同一条：**我的假 ctx / 假渲染器比真环境宽松**。

| 我第一版假环境 | 真环境 | 后果 |
|---|---|---|
| `slots` 直接挂在 ctx 上 | 未 inject 取属性会抛 | 客户端注册的致命错误离线永远抓不到 |
| class 组件当函数调 | React 用 `new` 实例化 | 渲染路径从未被真正执行 |

**规则**：写假环境时，**先问"真环境在什么情况下会拒绝我"**，然后把那条约束也加进假环境。
否则校验器验的是"我以为的契约"，而不是真契约 —— 全绿也没意义。

### 存储层的两个实测坑（都踩过）

**坑 1 · FTS5 的 unicode61 把连续 CJK 当成一个整体 token，不做切分。**
实测：`entries_fts MATCH '"日志层"'` → 命中；`MATCH '"日志"'` / `'"志层"'` → **0 命中**。
所以**不要**用 bigram 去喂 FTS（那是 CJK 无分词器时的常见做法，但对 FTS5 的 unicode61 无效）。
正确做法：`querySegments()` 给出「完整 CJK 串 + 2~4 字子串」，FTS 用整串、LIKE 用子串。

**坑 2 · LIKE 回退不能拿整串匹配。**
`content LIKE '%日志层 蒸馏%'` 要求这两个词**相邻出现**，而原文里它们中间隔着别的字
（"日志层原样追加，…空闲蒸馏"）→ 必然 0 行。必须**按词拆开、OR 连接**。
这条的症状特别容易误判成"检索坏了"，实际是查询构造错了。

**校验命令**：

```powershell
$N = "C:\Users\10454\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $N D:\DSH-dev\memory-lite\tools\verify\verify-storage.mjs   # 存储层（34 项）
& $N D:\DSH-dev\memory-lite\tools\verify\verify-v1.mjs        # 全链路 + 蒸馏端到端（68 项）
& $N D:\DSH-dev\memory-lite\tools\verify\verify-v2.mjs        # V2 四项 + 空闲闸门五分支（21 项）
& $N D:\DSH-dev\memory-lite\tools\verify\verify-client.mjs    # 客户端 bundle（18 项，含严格假 ctx）
& $N D:\DSH-dev\memory-lite\tools\migrate\migrate-from-meow.mjs   # meow 迁移（dry-run，加 --apply 才写）
& $N D:\DSH-dev\memory-lite\tools\diag\diag-client-routes.mjs  # 探宿主暴露了哪些路由
& $N D:\DSH-dev\memory-lite\tools\diag\diag-registry.mjs       # 注册表 → 工作区库发现链路
& $N D:\DSH-dev\memory-lite\tools\diag\diag-schema-check.mjs   # 真实库的表/列（迁移是否生效）
& $N D:\DSH-dev\memory-lite\tools\diag\diag-memory-state.mjs   # 两个库的条目/日志概览
& $N D:\DSH-dev\memory-lite\tools\diag\diag-injections.mjs     # 注入流水（recall / recovery 各多少轮，反查条目）
& $N D:\DSH-dev\memory-lite\tools\diag\diag-v3-survey.mjs      # V3 体检：条目结构/索引段占用/日志积压/近重复
& $N D:\DSH-dev\memory-lite\tools\diag\diag-distill-input.mjs  # 蒸馏输入：清洗前后对比 + 日志是否"累积式"落库
& $N D:\DSH-dev\memory-lite\tools\diag\diag-recall-quality.mjs # 召回质量：重放 recall_runs，算零命中率
& $N D:\DSH-dev\memory-lite\tools\diag\diag-check-shapes.mjs   # 日志/注入/标题的列形状核对（改 schema 后跑）
```

**当前状态（2026-10-12 核对）**：五条校验器共 **268 项全绿**（V1 144 / V2 52 / 存储 34 /
客户端 21 / 元数据 17）；V1 + V2 + V3 + V3.1 + V1.6（人设/规范）+ V1.7（用户级库）全链路已跑通。

### 人设 / 规范：插件自己的文件 + 框架的段落（V1.6，**返工掉 V1.5 的做法**）

V1.5 我把这两块写进用户的 `$DSH_HOME/AGENTS.md`，并用自己加的 `### 身份` / `### 核心原则`
当锚点 —— 于是"标题行不能删"变成了对用户的约束。用户原话：
**「这些###的标题不能去掉吗？不合理。」** **他是对的**：那些标题只是我写文件时顺手加的
markdown 结构，跟他的内容无关；我把实现细节暴露成了他的负担。

现在的做法（改之前先读这几条）：

- 内容存 `$DSH_HOME/memory-lite/persona/{persona.md,rules.md}`，
  **文件内容 = 文本框内容**：不解析、不加标记、**不要求任何标题**。
- 靠 `ctx.systemPrompt.section` 注入（`memory-lite:persona`），
  order = `getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1` = **1**，即紧跟**框架自己的人设段**
  （框架 `SECTION_ORDERS`：`HARNESS_IDENTITY = -1000`、`DEPLOYMENT_PERSONA_PREFIX = 0`、
  `TOOLS_SDK = 5000`（记忆索引段在这）、`DEPLOYMENT_PERSONA_SUFFIX = 10200`）。
  **框架早就给了人设一个固定位置** —— 这才是"每轮必到"的正规做法，不是我发明的锚点。
- 校验器里两条断言专门钉住这次返工：**「正文逐字节原样落盘（没有任何标题要求）」**、
  **「没有偷偷加任何 markdown 标题」**。
- 代价（已与用户确认）：内容**随插件走** —— 插件停用/卸载就不生效了。

> **一条通用教训（值得记住）**：把"我怎么存你的数据"暴露成"你必须遵守的格式"是设计错误 ——
> **用户不该为我的实现细节负责**。以后遇到"某个字段 / 标题不能删"这类要求，先自问：
> 这是需求，还是我的实现偷懒？

| 真机已确认（附证据） | 真机仍未验 |
|---|---|
| 自动沉淀（`turn-stopping` → 日志层写入，日志层**不进提示词**） | `scope="all"` 跨工作区检索（离线校验器绿，真机未跑） |
| 蒸馏产出条目（run 57：`ok` / `created 3` / 走 `deepseek-official/deepseek-flash`，**provider 是自动发现的**） | 空闲自动整理的实际触发 —— **验不了**：`autoDistill` 已按决定默认关，要验须先手动开 |
| 召回注入（`agent/pre-step` → 本轮消息出现记忆片段；`injections` 表 `form=recall`） | |
| **压缩后补回**（`/compact` 后第一轮：`injections` 表 `form=recovery` / 18 条 / 1369 字，与 `lib/prompt.js:131` 的话术逐字对上） | |
| 日志层不再存系统样板、不再重复落整段历史（新增 `lib/text.js` + 水位持久化 + 重启守卫；存量清洗脚本可把 65 万字压到 19 万字） | |
| 注入计数（`inject_count` 累加，面板显示"用过 N 次"） | |
| 设置页「记忆控制」+ 面板读库（发现式定位 + 注册表） | |
| 老库迁移（`raw_preview` / `inject_count` 列已加，27 条完好） | |
| 插件卡片元数据（`locale/en.json` 的 title + 顶层 `icon.svg`，重启后可见） | |

> **怎么复核「压缩后补回」**（它只在你真的压缩过之后才有数据）：
> `node tools/diag/diag-injections.mjs` → 看有没有 `form=recovery` 那一行。
> 没有就说明压缩事件没被监听到，或该轮 `decision.kind !== 'enter'`。

---

## V3 三项：实测依据（**改这些常量之前先读这一节**）

V3 不是"想到什么做什么"，是先量了真库再定。量法见 `tools/diag/diag-v3-survey.mjs`
（**在库副本上量** —— `search()` 会写 `hit_count`，直接在真库上量会把面板的"用过 N 次"灌水）。

### V3-1 蒸馏输入：先剔样板，再头尾取样

| 实测（10 条真实日志） | 数字 |
|---|---|
| 旧行为：`text.slice(0, 1500)` 后，多条内容**逐字相同** | **7/10 条** |
| 那 1500 字是什么 | 用户全局 `AGENTS.md` 的样板（宿主以 `<system-reminder>` 注入） |
| 最大 4 条（7~10 万字）里蒸馏能看到多少 | **1.4% ~ 2%** |
| 清洗后总字符 | 649,870 → 450,701（降到 69.4%） |

所以 `pickLogExcerpt()` 的顺序是**先 `cleanLogText()` 再截断**；超长时取**头 40% + 尾 60%**
（结论在尾部，`capture.js` 的 `truncate()` 早就是这么做的，只是蒸馏这边没跟上）。

> **这一项改完仍有一半没解决** —— 已在下一版根治，见「日志层为什么会膨胀」一节。
> 简言之：清洗后依然有 7/10 条的**开头相同**，因为重复的不是系统样板而是**真实内容**
> （日志是"累积式"落库）。

### 日志层为什么会膨胀（已根治，2026-10-11 夜）

实测（10 条真实日志、一个会话）：

| 现象 | 数字 |
|---|---|
| 原文上"后一条完整包含前一条" | **6/9 对** |
| 10 轮对话写出来的体积 | **804 KB**（WAL 另有 1.4 MB） |
| 最大一条 | **104,405 字** |

根因是**水位失准**：`seenSeq` 是**进程内存里的 Map**，插件一重启就归零；
压缩后会话快照重新物化时事件编号也可能变小。两种情况都会让"本轮新增"变成"整段历史"。

修法有三条，**分工明确**（缺一条都不够）：

1. **水位持久化**：落盘到 `meta` 表的 `watermark:<sessionId>`，重启后不再从 -1 开始。
2. **重启守卫**：`extractTurnText()` 多返回一个 `maxSeqAll`（事件里真实存在的最大 seq，
   不受水位过滤影响）。若 `maxSeqAll < 水位`，说明编号重启了 —— 丢掉水位重来。
   ⚠ 没有这条守卫的话，水位会**静默跳过**整轮内容（丢数据比重复严重得多）。
3. **内容去重**：`diffAgainstPrevious()` —— 清洗后的文本若**包含**上一条，只存多出来的那段。
   水位负责**省事**，内容比对负责**正确**：就算水位数得对，这一步也只是空转。

> ⚠ 只认**包含**这种确定关系，不做"最长公共子串"之类的模糊匹配 —— 一旦切错就是
> **静默丢内容**。切不动就原样存：宁可重复，不可丢失。
>
> ⚠ **存量清洗的顺序**：必须**先在原文上比对、再清洗**。反过来（先各自清洗再比对）
> 包含关系会不成立 —— 跨边界的框架块让两边不一致，实测从 6/9 对掉到 **0 对**。
> 脚本：`tools/migrate/clean-log-boilerplate.mjs`（dry-run 默认，`--apply` 前先 VACUUM INTO 备份）。

### V3-2 索引段：真正决定容量的是**渲染截断长度**，不是标题回填

| 实测（33 条真实记忆） | 数字 |
|---|---|
| 索引段占用 | 3431 / 4096 B（**83.8%**） |
| 每行平均 | **123 B**（最长 170，最短 72） |
| 为什么这么长 | 30/33 条**没有标题**，渲染层回落到"正文前 48 字"；中文 1 字 = 3 B |
| 按行均算能列多少条 | 约 33 条 → **再多就会静默掉出 system prompt**（只显示"另有 N 条未列出"） |
| 截到 20 字后 | 每行约 83 B → 约 **49 条**（+48%）；截到 12 字则约 69 条（但太碎） |

**所以别去回填标题** —— 回填的标题同样会被 `INDEX_TITLE_CHARS` 截断，走同一条路，
额外容量是 **0**。要调容量就调 `INDEX_TITLE_CHARS`（`lib/config.js`）。

### V3-3 召回观测：以前**回答不了**"召回命中多少轮"

`recall_runs` 表每轮落一行（**含 0 命中**），`diag-recall-quality.mjs` 在库副本上重放，
给出零命中率 / 与历史记录的差异。这张表是"以后改检索"的**唯一验收依据** ——
没有它，改检索只能靠"感觉好像好点了"。

> 注意：`query` 落库前过 `redactSecrets()`，但**存的是文本不是哈希** ——
> 哈希做不到重放（没法拿哈希去检索）。日志层本来就存了整轮原文，这里不额外扩大暴露面。

### 设计取舍（记录理由，避免以后被"优化"掉）

- **一张 entries 表 + level 列**，而不是七张平行表。理由：FTS5 只能建在一个内容表上；
  跨层检索变一条 SQL；层级特有字段（corrected / subcategory / goal）保留成可空列。
- **`sensitive` 在写入时算一次并落列**，注入侧只读列。理由：注入路径上再判断等于把
  fail-closed 变成 fail-open（判断代码出错就注入了）。
- **日志溢出先写归档文件再删库内行**；归档写失败就**本轮不删**（宁可库大一点也不丢数据）。
- **FTS 是派生数据**：`update` 后整条重写 FTS 行，避免部分更新导致旧词残影。
- **面板用"发现式定位"而不是"推断当前工作区"**：注册表（`$DSH_HOME/memory-lite/workspaces.json`）
  记录每个库属于哪个工作区，读的时候还要容忍 BOM（PowerShell 写 JSON 会带 BOM，
  而 `JSON.parse` 遇 BOM 直接抛 —— 早期我的 catch 静默返回空数组，于是面板永远显示 0 条）。

### 校验器里的一个假绿（2026-10-11 修，值得记住）

`verify-v1` 的假 ctx 原本用 `new Map()` 存事件处理函数（`handlers.set(event, handler)`）。
但 `apply()` 对 **`agent/pre-step` 注册了两个**处理函数（召回、压缩后补回），
后一个把前一个**覆盖**了 —— 于是"pre-step 只追加不改写"这条断言实际上一直在测
**补回**分支，而**每轮都在跑的召回分支从未被检验过**（V3-3 的断言因此一直报"打不开库"）。

修法：假 ctx 改成 `Map<事件, 处理函数数组>`，并**按真实瀑布语义串起来跑**
（`h(payload, () => step(i + 1, d))`），另外断言"pre-step 有两个处理函数"。

**通用判据**：假 ctx 用 `Map<事件, fn>` 时，**任何一个被注册多次的事件都会静默丢掉
前面的处理函数**。凡是要断言"某条路径真的跑了"，先断言"它注册出来了"。

### 第二个假绿：假 ctx 没有 `inject`，整块 HTTP 路由测不到（2026-10-12 修）

`index.js` 的 HTTP 路由是在 `ctx.inject(['webServer'], …)` 里注册的，而校验器的假 ctx
既没有 `inject` 也没有 `webServer` —— 于是 **apply() 时那段直接抛错被 guarded 吞掉**，
一条路由都没注册，面板相关的代码**从来没有被测过**（真机日志里那句
`web-routes-FAILED ctx.inject is not a function` 就是它）。

修法：假 ctx 补上 `inject(names, cb)` 与一个 `webServer` 桩（`register` 收进数组），
然后**把真实的 handler 抓出来直接调**（造一个只有 `writeHead`/`end` 的假 res）。
现在 `/save` 的新增、空内容被拒、非法层级兜底、`project` 缺项目名被拒、
重要性夹取、编辑分支、**改完 FTS 已同步**，都是离线可验的。

**通用判据**：假 ctx 少一个服务，**依赖它的整块功能就集体消失**（而且因为每处注册都有
try/catch，是静默消失）。看到"某个子系统一行断言都没有"时，先查假 ctx 有没有给它那个服务。
