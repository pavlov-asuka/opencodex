# 精简改造计划(Slim-down）

本仓库自 v1.2.0 起脱离上游独立演进。目标是只保留一件事:

> **把多 provider 的第三方模型接入 Codex Desktop,像使用原生模型一样使用它们。**

围绕这个目标之外的能力(语音编排、其他 CLI 的订阅导入、子代理决策路由、记忆源导入)物理删除,不做开关保留。

## 已定决策

| 决策 | 理由 |
| --- | --- |
| **物理删除,不同步上游** | 上游已更名 CodexSplit 并持续演进;保留 65% 的无关代码只为将来能 merge,不划算。已删 `upstream` remote |
| **保留 `subagent_orchestrator.ts`** | 只有 117 行,且被主链路调用(`start` / `complete` / `fail`),提供子代理任务的可观测性 |
| **保留 computer-use 与原生图像桥接** | 它们正是"像原生模型一样使用第三方模型"的组成部分,不是额外功能 |
| **保留 `session_history.ts`** | 主链路依赖它修复多轮工具调用历史;要删的是 `/api/sessions*` 那几个面板路由 |
| **Cursor 排到最后一期** | `router.ts` 里有 209 行 cursor 代码,而 `router.ts` 是所有 provider 请求的必经之路 |
| **改造走 `slim` 分支** | 默认分支 `feature/windows-provider-bridge` 是仓库首页,每期验证通过后再合入 |

## 不变量:`test/slim_invariants.test.mjs`

这四条断言描述本仓库存在的意义,**任何一期都不得让它们失败**。失败意味着删过头了,该改的是删除动作而不是测试。

| 不变量 | 防的是哪一期 |
| --- | --- |
| Responses provider 的一轮对话能完整流式透传到客户端(provider 收到 backend 名,客户端看到 catalog slug) | P5 |
| 工具调用的 `call_id` 在中继后保持不变(丢了就没有多步对话) | P5 |
| provider 报错要传回客户端而不是挂起 | P5 |
| **零 Profile 配置下**,显式点名的第三方子代理仍能解析出模型和推理档位 | P6 |

最后一条对应真实安装的状态:`~/.opencodex/` 下没有 `agent_profiles.json`,路由模式是 `off`,决策引擎从不运行 —— 子代理走的是 `explicit forced model` 分支,它和将被删除的 Profile 匹配写在同一个函数里。

其他已有覆盖(不必重复造):

- `multi_agent_version: v2` 写入目录 → `windows_provider_bridge.test.mjs`
- 推理档位归一化与下限 → `reasoning_floor.test.mjs`
- bridge 的官方/第三方分流 → `provider_split_bridge.test.mjs`、`provider_split_protocol.test.mjs`
- 目录/命名空间/托管配置 → `model_catalog_identity.test.mjs`

## 分期

每期一个 commit。验收命令固定为:

```bash
npx tsc --noEmit && node --test test/*.test.mjs && node scripts/build.mjs --windows
```

打包验证(不覆盖正在运行的安装,输出到独立目录):

```bash
node scripts/package-windows.mjs --out build/slim-verify --no-zip
```

| 期 | 内容 | 约行数 | 风险 | 状态 |
| --- | --- | --- | --- | --- |
| **P0** | tag / 存档分支 / 删 remote / 不变量测试 / 本文档 / `slim` 分支 / 测试归属盘点 | — | — | ✅ 完成 |
| **P1** | 删 `src/` 死代码 | 6,131(560 文件) | 零 | ✅ 完成 |
| **P2** | 记忆源导入 + 会话浏览面板 | 1,196 | 低 | ✅ 完成 |
| **P3** | 语音 / GPT-Live | 8,600 | 低 | ✅ 完成 |
| **P3.5** | 非 Windows 客户端(`mobile/` + `macos-app/`) | 4,924 | 零 | ✅ 完成 |
| **P4** | 订阅导入(发现 / 导入 / UI 侧) | 501 | 低 | ✅ 完成 |
| **P5** | Cursor + 订阅请求路径(`router.ts` 手术) | 19,674 | **中高** | ✅ 完成 |
| **P6** | 子代理决策层 | 1,366 | 中 | ✅ 完成 |
| **P7** | 依赖瘦身、dashboard 收尾、文档 | — | 低 | ✅ 完成(发版待定) |

起点 **61,247 行**(P0 的真实总量;最初对外说的 55,651 少算了 `mobile/` 与 `macos-app/`,又多算了当时尚未删除的 `src/`)。P3.5 结束时 **39,960 行**,预期终态约 **19,000 行**;依赖 7 个减到 6 个(去掉 `@bufbuild/protobuf`),测试 219 条减到约 150 条。

### P1 · `src/` 死代码 ✅

`tsconfig.json` 只包含 `src_v2/**/*`,且全仓库无一处 import `src/`。已删除 560 个文件 / 6,131 行:`src/codex-client/**`(ts-rs 生成的 Codex 协议类型)与 `src/cu/**`。

删除后 `tsc --noEmit` 干净,219 用例结果不变(218 通过),打包成功。

**P3 注意**:`security_contract.test.mjs` 断言 `gateway.ts` 里存在 `import("../services/visualizer.js")`,删语音时要同步改这条。

### P2 · 记忆源导入 + 会话浏览面板 ✅

已删 1,196 行:

- `gateway.ts` 六个路由处理器共 1,140 行 + 失去引用的 `extractSessionUuid`
- `dashboard.ts`:`sessions` 视图的 HTML、三段 CSS、17 个函数、导航按钮、`openView` 分支、视图记忆白名单、事件绑定,以及残留的死 CSS 选择器
- **保留** `services/session_history.ts` —— 主链路用它修复多轮工具调用历史

测试契约随之修正(删除的功能不该再有断言):

- `dashboard_contract`:删掉"保留会话导入/扫描/删除控件"整条;语言开关那条里的 MutationObserver 跳过选择器改为 `.log-row`(P3 又随 Live 悬浮球一起收敛过一次)
- `security_contract`:删掉 `execFileSync("sqlite3", [dbPath, sql]` 断言(记忆源扫描才用它),测试改名为 "voice shell calls…";`execSync` / `.exec(` 的禁止断言全部保留

**dashboard 验证方法(P3/P6 复用)**:不要为了看页面去启动第二个网关 —— 那会重写 `HKCU\Environment` 里的 `CODEX_CLI_PATH`,打断正在运行的安装。改用 `getDashboardHtml()` + 一个桩 API 的临时静态服务(端口 8799),浏览器打开后确认:控制台零报错、导航项正确、逐个 `openView()` 不抛异常、无残留 DOM 节点。

### P3 · 语音 / GPT-Live ✅

已删 8,600 行。

**先做的解耦**:`webrtc_proxy.ts` 不能整删 —— `copyNativeRequestHeaders` 有三个主链路调用点,`codex-provider-bridge.ts` 和 `agent_message_oracle.ts` 也各自 import 它。先把 `readNativeAccessToken` / `isLocalOrPlaceholderBearer` / `copyNativeRequestHeaders` 搬进新的 `server/native_headers.ts`,再删原文件。

删除:

- `voice/OpenCodexBar/**`、`macos-app/Sources/OpenCodexLivePicker/`(Live 悬浮球)
- `services/visualizer.ts`、`services/live_model_picker.ts`、`server/webrtc_proxy.ts`、`scripts/build-all.sh`(它只负责构建语音伴侣)与 `build:all` npm script
- `gateway.ts` 十个区域共 2,173 行:realtime/live 代理路由、live picker 六个路由、语音六个路由 + 原生语音观察器、`ensurePythonScripts`(内嵌 MiniMax TTS 与 Silero VAD 的 Python,写 `/tmp`,Windows 上本就是死代码)、VAD 方法、`chooseLiveWorkRoute` 与 picker 方法、WebSocket 服务器、STT/TTS/CDP/MCP 尾部方法
- `gateway.ts` 另外 131 行:P2 遗留的会话投影函数族(`projectCodexSessionMessages` 等七个函数互相引用,单看调用数看不出已死)+ Live picker 状态字段
- `dashboard.ts`:`voice` 视图、Live 悬浮球及其 1 秒轮询

**教训**:互相引用的函数族用"引用计数 > 1"判断存活会漏。要从**根**(有外部调用者的入口)往下判定。

**教训 2**:`refreshVoiceBarStatus()` 和 Live 悬浮球的 `setInterval` 是顶层语句,删掉函数定义后 `tsc` 依然通过,但页面加载会 ReferenceError 白屏 / 持续轮询已删除的端点。**类型检查查不出来,必须看运行中的页面和网络面板。**

保留:`session_history.ts`。(`macos-app/` 其余部分当时暂留,随后在 P3.5 删除。)

测试:删 `live_model_picker`、`realtime_proxy`(其中 `copyNativeRequestHeaders` 的覆盖迁到新的 `native_headers.test.mjs`)、`live_model_picker_ui_contract`;`macos_app_contract` 删 4 条语音用例保留 2 条;`security_contract`、`dashboard_contract`、`session_projection` 局部修改。

### P3.5 · 非 Windows 客户端 ✅

原始盘点只走了 6 个根目录,漏了两个,确认后一并删除(4,924 行):

| 目录 | 行数 | 说明 |
| --- | --- | --- |
| `mobile/` | 3,969 | iPhone 伴侣:锁屏 Live Activity 显示任务状态 + 远程看会话,经 VPS 中继出站推送。**网关侧那一半根本不在本仓库** —— README 要求网关读 `OPENCODEX_RELAY_*`,但 `src_v2` 里零处 relay 代码。加上它是 Xcode 工程、还需要 VPS 与 APNs 证书,在纯 Windows 项目里三重无用 |
| `macos-app/` | 955 | macOS 应用外壳与 DMG 打包;P3 删掉语音伴侣后其 `package-app.sh` 已指向不存在的路径 |

测试:`macos_app_contract.test.mjs` 改名为 `startup_contract.test.mjs` 并只保留 startup.sh 那条;`release_version.test.mjs` 的版本一致性断言从 `macos-app/Info.plist` 改为 `native/windows-launcher/Cargo.toml`。

**仍保留的 macOS 相关物**(不在本次批准范围,需要时再决定):

- `startup.sh` —— macOS launchd/pm2 开机脚本(Windows 侧的等价物是 `OpenCodex.exe` + 登录任务)
- `src_v2/platform/darwin.ts` —— 平台运行时层,不是打包脚本;删它要同时改 `platform/index.ts` 的分发

### P4 · 订阅导入的发现 / 导入 / UI 侧 ✅

已删 501 行。四个 CLI(Antigravity / Grok / Claude / Cursor)的**导入通路**一次性拿掉,而不是按原计划只删前三个 —— 导入侧四家结构相同,分两次做没有收益,反而让 P5 更肿。

- `gateway.ts` 475 行:`/api/cli-bridge/status` 与 `/activate`、四个 `fetch*ModelsDynamic`、四个 `has*Credential`、`SubscriptionImportState` / `readSubscriptionImports` / `recordSubscriptionImport` / `recordSubscriptionTest`、`/api/providers` 里的 `cliProviders` 合并、`/api/providers/test` 里的四个订阅分支、`hasCatalogModelsForProvider`
- `dashboard.ts`:"本机订阅导入"卡片、`loadSubscriptions`、`activateSubscription`、`subscriptionIcon`、`renderSubscriptionRisk`

**测试从此全绿(198/198)。** 那条长期失败的 CRLF 断言(`session_projection` 里"subscription imports require live provider models")测的正是刚删掉的订阅导入源码文本,随功能一起作废。

**`subscription_auth.ts`(934 行)保留到 P5** —— `router.ts` 仍在请求路径上用它,原因见下。

### P5 · Cursor + 订阅请求路径(高风险)

- `services/cursor_gen/agent_pb.ts`(15,275)、`services/cursor_protocol.ts`(2,458)、`services/subscription_auth.ts`(934)
- `router.ts` 手术:209 行 cursor 代码,含模块级状态 `cursorSessionHistory` / `cursorPendingToolCalls` / `cursorExternalToolQueues`,以及 `cursorHistoryKey` / `cursorRequestStateKey`(在 `handleResponses` 顶部**无条件调用**)、`pruneCursorPendingToolCalls`、`takeCursorExternalToolRequest`、`cursorMessagesIncludeHistory`、`cursorUserMessagesAfterToolResult`、`rememberCursorSession`
- 依赖 `@bufbuild/protobuf` 随之出局
- 测试:`subscription_protocol.test.mjs`(23 条,绝大多数是 Cursor 协议)

**已完成(19,674 行)**。P4 报告里说"整块删掉会让 API Key 接入 Anthropic 失去适配器"—— **那个判断是错的**,读了 `AdapterFactory` 才发现:适配器由 `getAdapter(protocol, providerUrl)` 通用选择,判据是 `protocol === "anthropic"` 或 URL 以 `/messages` 结尾,**完全不含厂商名**;`x-api-key` 也由 `adapter.name === "anthropic" && apiKey` 这条通用分支设置。所以四个厂商分支只是订阅路径的**覆盖层**,删掉它们不影响任何 API Key 接入的 provider。唯一的行为差异:base URL 既不以 `/messages` 结尾、又不显式声明 `protocol=anthropic` 的配置,以前靠 URL 里含 "anthropic"/"claude" 被兜住,现在不再兜 —— 而那正是 `factory.ts` 注释里明确拒绝的"按厂商名硬编码"。

`test/adapter_selection.test.mjs`(5 条)在动刀**之前**写好,锁住这个结论:三种协议各自选对适配器、工厂源码不含任何厂商名、Anthropic 用自己的 API Key 认证。

删除清单:

- `services/cursor_gen/agent_pb.ts`(15,275)、`services/cursor_protocol.ts`(2,458)、`services/subscription_auth.ts`(934)、`test/subscription_protocol.test.mjs`(470)
- `router.ts` 从 1,740 行降到 1,147 行:四个厂商分支、Cursor 的 AgentService 请求分支与 172 行流式分支、订阅 token 刷新重试、四段厂商专属错误文案、模块级 Cursor 状态与七个 Cursor 辅助函数、`acquireCursorStreamReader`(换回 `response.body.getReader()`)
- `gateway.ts`:`findCatalogProvider` 里为订阅厂商合成假 provider(`https://subscription.*.internal`)的分支
- 依赖 `@bufbuild/protobuf` 出局(7 → 6)

**教训 3**:顺手把 `stripReasoningSuffix` 里 `clean.includes("gemini"|"grok"|"antigravity")` 改成查目录,结果 8 条测试红,其中就有一条 slim 不变量 —— `findCatalogMatches` 会回调 `stripReasoningSuffix`。已回退。**那三个词在这里不是厂商标记,是模型名里本来就带 level 词的家族**;订阅导入没了,但用 API Key 接 Gemini / Grok 依然是正当用法。护栏起作用了。

**原 P4 记录的陷阱分析(已被上面更正,保留以备查)**:`router.ts` 里 `isAntigravityModel` / `isGrokModel` / `isClaudeModel` / `isCursorModel` 四个分支**不只是订阅认证,还兼着协议适配器的选择**:

```ts
if (isClaudeModel) {
  activeAdapter = new AnthropicAdapter();      // ← 合法 API Key 用户也走这里
  finalTargetUrl = "https://api.anthropic.com/v1/messages";
  const claudeKey = await SubscriptionAuthService.getClaudeAccessToken();
  if (claudeKey.startsWith("sk-ant-")) finalHeaders["x-api-key"] = claudeKey;
```

`isClaudeModel` 的判定包含 `providerUrl.includes("anthropic")`,而 `getClaudeAccessToken()` **第一优先返回真实 API Key**。整块删掉会让"用 API Key 接入 Anthropic"这种完全正当的第三方 provider 失去适配器 —— 那正是本仓库存在的目的。Antigravity 分支同理挂着 `GoogleGeminiAdapter`。

所以 P5 要做的不是删四个 if,而是**把适配器选择与订阅认证拆开**:保留按 provider 协议选适配器,去掉 `SubscriptionAuthService` 的取 token 路径。动手前先补一条"API Key 接入 Anthropic 仍走 AnthropicAdapter"的断言。

### P5 · Cursor(高风险)

- `services/cursor_gen/agent_pb.ts`(15,275)、`services/cursor_protocol.ts`(2,458)
- `router.ts` 手术:209 行 cursor 代码,含模块级状态 `cursorSessionHistory` / `cursorPendingToolCalls` / `cursorExternalToolQueues`,以及 `cursorHistoryKey` / `cursorRequestStateKey`(在 `handleResponses` 顶部**无条件调用**)、`pruneCursorPendingToolCalls`、`takeCursorExternalToolRequest`、`cursorMessagesIncludeHistory`、`cursorUserMessagesAfterToolResult`、`rememberCursorSession`
- 依赖 `@bufbuild/protobuf` 随之出局

**做法**:先删 cursor 专属函数与模块级状态,再摘 `handleResponses` 里的调用点,分两个 commit,每步跑不变量测试。动刀前重读本文档的不变量一节。

### P6 · 子代理决策层 ✅

已删 1,366 行。子代理现在只有一条入口:**父代理点名模型**。

- `services/agent_profile_store.ts`(267)整体删除
- `services/task_router.ts` 589 → 339 行:删掉 `resolve()` / `matchingProfileScore` / `resolveProfile` / `resolveProfileDirect` / `unavailable` / `record` / `listProfiles` / `getSettings`、`TaskRouteRequest` / `ResolvedTaskRoute` 类型,以及失去调用者的 `capabilityTokens` / `list` / `extractTaskText`。新增一个窄接口 `resolveModel(model, effort, preserveExplicit)`:查目录、判可用、归一化档位,**没有任何策略**
- 构造函数从 `new TaskRouter(store)` 改为 `new TaskRouter(dataDir)`
- `gateway.ts`:`/api/agent-profiles` 与 `/api/agent-routing/*` 六个路由(98)、`findSubagentProfileForModel`(27);`chooseSubagentRoute` 里 Profile 相关的 40 行(`configuredProfiles` / `requestedProfileId` / `explicitProfile` / `modelProfile` / `boundProfile` / `bindingProfile`)
- `dashboard.ts` 246 → 149 行:`agent-routing` 视图整块

**保留**:`subagent_orchestrator`(任务台账与可观测性)、绑定复用(按 `child_thread_id` 记住这个子代理是谁)、档位归一化与下限。

测试:`agent_routing.test.mjs`(20 条)按盘点拆分 —— 8 条决策层用例作废,**12 条核心迁进新的 `subagent_routing.test.mjs`** 并改写为显式点名模型的形式,另加 6 条新用例覆盖:目录里没有的模型必须拒绝而不是静默换一个、同一父代理的并发子代理按 `thread_id` 各自路由、prewarm 不建任务、以及一条**反向断言**确保 `TaskRouter` 不再暴露 `resolve` / `listProfiles` / `getSettings` / `record`。`agent_routing_api.test.mjs` 与 `dashboard_contract` 里的"模型能力目录"契约整体删除。

### P7 · 收尾 ✅(发版待定)

**依赖瘦身 —— 这一期最大的收获。** 逐个核查后发现六个运行时依赖里**四个从来没被 import 过**:

| 依赖 | 体积 | 使用情况 |
| --- | --- | --- |
| `node-pty` | 61.4 MB | 零引用 |
| `sql.js` | 18.2 MB | 零引用 |
| `@modelcontextprotocol/sdk` | 4.1 MB | 零引用 |
| `https-proxy-agent` | — | 零引用 |
| `ws` | 0.1 MB | P3 删掉 WebSocket 服务器后失去最后一个使用者 |
| `undici` | 1.6 MB | **在用**(`upstream_fetch.ts`) |

现在运行时依赖只剩 `undici` 一个,开发依赖只剩 `typescript` 与 `@types/node`。

```
打包体积   166.1 MB / 4,538 文件  →  3.6 MB / 339 文件
```

验证方式:在**只装了 undici** 的打包目录里逐个 `import()` 全部 11 个核心模块 + bridge,确认没有任何 `ERR_MODULE_NOT_FOUND`。

**dashboard**:删掉 `.subscription-*` / `.brand-antigravity|grok|claude|cursor` 等死选择器,以及 P3 漏掉的**"高级语音"卡片**(它藏在"应用与安全"视图里,带 VAD 阈值输入框)。

**文档**:删除四份为已删子系统写的文档 —— `VOICE_GUIDE.md`、`SESSION_PROGRESS.md`(语音开发日志)、`TEST_FLOW.md`(pm2 / `$HOME` 的 macOS 时代流程)、`docs/PROVIDER_WORKSPACE_REDESIGN.md`(macOS Provider Workspace 设计)。`README.md` 按精简后的实际情况重写。

**教训 4:翻译词典的裁剪失败并回退。** 想删掉 83 条指向已删功能的 `['中文','English']` 条目,正则合并逗号时在数组里留下了空洞,`new Map(pairs)` 抛出 `Iterator value undefined is not an entry object`,整个语言模块没初始化 —— **`tsc` 通过、5 条 dashboard 契约测试也通过**(它们只 grep 源码文本),是在浏览器里点语言开关才发现的。已整体回退。那些条目是惰性查找数据,收益纯粹是整洁度,不值得再冒一次风险。

**仍保留**(需要时再定):`startup.sh`(macOS launchd 脚本,`startup_contract.test.mjs` 仍在断言它)、`src_v2/platform/darwin.ts`(运行时平台层)。

## 风险与缓解

| 编号 | 风险 | 缓解 |
| --- | --- | --- |
| R1 | `router.ts` 手术影响所有第三方模型的流式与工具调用 | 排最后;`slim_invariants` 三条流式断言;分两个 commit |
| R2 | 删测试时连带删掉核心覆盖 | 已完成归属盘点(见下);`agent_routing.test.mjs` 只删 8 条 |
| R3 | `gateway.ts` 是 6,933 行巨型 `if` 链,按行删块会破坏结构 | 每删一块立刻 `tsc --noEmit`,不批量删 |
| R4 | `dashboard.ts` 单文件、部分行长 5,000 字符,改错即控制台白屏(填 API Key 的唯一入口) | 只删导航按钮与视图安装函数;每次改完打开页面确认 |
| R5 | 打断正在运行的网关与 bridge | 只改仓库源码;打包输出到 `build/slim-verify`;确认后再切换正式安装 |
| R6 | 不可回头 | `pre-slim` tag 与 `archive/upstream-features` 分支(均已推送 origin) |
| R7 | 误删 `chooseSubagentRoute` 的显式分支 | `slim_invariants` 第四条 |

## 测试归属盘点(P0 完成)

共 219 条用例(含 4 条新增不变量)。按功能归属:

| 文件 | 用例 | 归属 |
| --- | --- | --- |
| `model_catalog_identity` | 30 | 核心 29 / CLI 订阅 1 |
| `v2_architecture` | 25 | 核心 25 |
| `subscription_protocol` | 23 | CLI 订阅 23(P4/P5 整体删) |
| `agent_routing` | 20 | 核心 12 / 决策层 8 |
| `windows_provider_bridge` | 12 | 核心 12 |
| `computer_use_native` | 11 | 核心 11 |
| `provider_registry` | 10 | 核心 10 |
| `agent_message_oracle` | 8 | 核心 8 |
| `dashboard_contract` | 8 | 核心 6 / 语音 1 / CLI 1 |
| `provider_split_protocol` | 8 | 核心 8 |
| `realtime_proxy` | 8 | 核心 5 / 语音 3 |
| `live_model_picker` | 7 | 语音 5 / 核心 2 |
| `security_contract` | 7 | 核心 5 / 语音 2 |
| `macos_app_contract` | 6 | 语音 3 / 核心 3 |
| `provider_split_bridge` | 6 | 核心 6 |
| `compaction_routing` | 5 | 核心 5 |
| `reasoning_floor` | 5 | 核心 5 |
| `slim_invariants` | 4 | 核心 4 |
| `session_projection` | 4 | 核心 3 / CLI 1 |
| 其余 9 个文件 | 12 | 核心 11 / 语音 1 |

`session_projection.test.mjs` 有一条基于源码文本的断言在 Windows(CRLF 检出)下长期失败,与本改造无关。

## 回滚

```bash
git checkout pre-slim            # 改造前的完整状态
git checkout archive/upstream-features
```

两者均已推送到 origin。查看已删代码不需要检出:

```bash
git show pre-slim:src_v2/services/cursor_protocol.ts
```
