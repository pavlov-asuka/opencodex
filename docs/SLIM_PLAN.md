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
| **P4** | Antigravity / Grok / Claude 订阅导入 | ~1,800 | 低 | ⬜ |
| **P5** | Cursor(含 `router.ts` 手术) | ~17,900 | **中高** | ⬜ |
| **P6** | 子代理决策层 | ~1,600 | 中 | ⬜ |
| **P7** | 依赖瘦身、dashboard 收尾、README、重新发版 | — | 低 | ⬜ |

预期终态:**55,651 → 约 19,000 行**,依赖 7 个减到 6 个(去掉 `@bufbuild/protobuf`),测试 219 条减到约 150 条。

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

- `dashboard_contract`:删掉"保留会话导入/扫描/删除控件"整条;语言开关那条里的 MutationObserver 跳过选择器改为 `.log-row,[data-live-picker-model]`
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

保留:`macos-app/` 其余部分(见"待定"),`session_history.ts`。

测试:删 `live_model_picker`、`realtime_proxy`(其中 `copyNativeRequestHeaders` 的覆盖迁到新的 `native_headers.test.mjs`)、`live_model_picker_ui_contract`;`macos_app_contract` 删 4 条语音用例保留 2 条;`security_contract`、`dashboard_contract`、`session_projection` 局部修改。

## 待定:两个计划外的目录

原始盘点只走了 6 个根目录,漏了两个:

| 目录 | 行数 | 说明 |
| --- | --- | --- |
| `mobile/` | 3,969 | iOS 应用(Xcode 工程 + Widget 扩展)与 relay。**不被构建引用**,`tsconfig`、`package.json`、`src_v2` 里都没有它 |
| `macos-app/` | 955 | macOS 应用外壳与 DMG 打包。`scripts/package-app.sh` 里 44 行引用已删除的语音伴侣,现在指向不存在的路径 |

两者都不在已批准的删除清单里,等确认后再处理。

### P4 · Antigravity / Grok / Claude 订阅导入

- `services/subscription_auth.ts`(934)
- `gateway.ts`:`fetchAntigravityModelsDynamic` / `fetchGrokModelsDynamic` / `fetchClaudeModelsDynamic`(~170)、`/api/cli-bridge/*`(~138)、`recordSubscriptionImport`
- 测试:`subscription_protocol.test.mjs` 的对应用例

### P5 · Cursor(高风险)

- `services/cursor_gen/agent_pb.ts`(15,275)、`services/cursor_protocol.ts`(2,458)
- `router.ts` 手术:209 行 cursor 代码,含模块级状态 `cursorSessionHistory` / `cursorPendingToolCalls` / `cursorExternalToolQueues`,以及 `cursorHistoryKey` / `cursorRequestStateKey`(在 `handleResponses` 顶部**无条件调用**)、`pruneCursorPendingToolCalls`、`takeCursorExternalToolRequest`、`cursorMessagesIncludeHistory`、`cursorUserMessagesAfterToolResult`、`rememberCursorSession`
- 依赖 `@bufbuild/protobuf` 随之出局

**做法**:先删 cursor 专属函数与模块级状态,再摘 `handleResponses` 里的调用点,分两个 commit,每步跑不变量测试。动刀前重读本文档的不变量一节。

### P6 · 子代理决策层

- `services/agent_profile_store.ts`(267)
- `services/task_router.ts`:**只删 `route()` / `matchingProfileScore` / `resolveProfile` 一套**。`readRoutingCatalog`、`modelFromEntry`、`normalizeReasoningEffort`、`applyReasoningFloor`、`extractTaskText` 是主链路,必须保留
- `gateway.ts`:`/api/agent-profiles`、`/api/agent-routing/*`(~117)、`findSubagentProfileForModel`;`chooseSubagentRoute` 中**只删 Profile 匹配分支,保留 `explicit forced model` 分支**
- `dashboard.ts`:`agent-routing` 视图
- 测试:`agent_routing.test.mjs` 20 条里 **8 条决策层可删、12 条是核心必须保留**;`agent_routing_api.test.mjs` 整体可删

### P7 · 收尾

依赖清理、`dashboard.ts` 导航按钮、`README.md`、`scripts/package-windows.mjs` 里的说明文本、重新打包发版。

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
