# OpenCodex 2.1.0 全面审计报告

> 审计对象：`D:\coding\Development\tools\opencodex-fork`  
> 上游：`https://github.com/pavlov-asuka/opencodex.git`  
> 分支：`main`（与 `origin/main` 对齐）  
> 提交：`1c38e371ef33b7bb22b33b29ca894a618bed25e1`  
> 提交说明：`feat: make official-model interception optional and add a real way out`  
> 日期：2026-08-11

## 1. 结论摘要

当前版本尚不适合直接作为“新用户默认稳定版”发布。

最需要优先处理的不是单个供应商适配，而是三项基础可靠性问题：

1. **“官方模型不经过代理”的开关在实际 ESM 运行环境中很可能无法关闭。** 读取设置时使用了不可用的 `require()`，异常又被静默吞掉；同时持久化环境变量优先于设置文件，导致关闭操作会被旧值覆盖。这直接破坏了项目最重要的安全承诺：网关故障时官方模型仍可走官方链路。
2. **测试套件会操作真实 Windows 用户环境并可能重启 Codex Desktop。** `npm test` 中多个测试直接调用真实 `CodexBridgeServer.start()`，而启动逻辑会写 `HKCU\Environment`、注册 `CODEX_CLI_PATH`，并在特定状态下结束和重新启动 Desktop。测试不是隔离测试。
3. **配置清理和会话修复的作用域过宽。** “脱离 OpenCodex / 还原原生”可能删除用户自己维护的 Codex 配置，并会遍历、重写全部活动和归档 rollout 文件，存在不可逆数据损坏风险。

此外还确认了服务商编辑后旧模型残留、Node 版本要求错误、连接测试误报成功、凭据配置保存失败却返回成功、Windows 子代理命令执行固定调用 `/bin/zsh`、本地 Responses 入口可借用用户 Codex 登录态等问题。

### 风险统计

| 等级 | 数量 | 含义 |
| --- | ---: | --- |
| P0 | 2 | 会破坏核心隔离承诺，或审计/测试本身可能影响正在运行的 Codex |
| P1 | 10 | 新用户高概率遇到失败、误配置、数据破坏或明显安全边界问题 |
| P2 | 5 | 兼容性、资源消耗、文档和维护性问题 |

## 2. P0：发布前必须修复

### P0-1 “官方模型直连”开关实际上无法可靠关闭

位置：

- `src_v2/platform/paths.ts:50-59`
- `src_v2/platform/paths.ts:62-70`
- `src_v2/server/gateway.ts:2781-2791`
- `src_v2/codex-provider-bridge.ts:1277-1284`

问题链路：

1. 项目是 ESM（`package.json` 含 `"type": "module"`），但 `nativeEgressEnabled()` 使用 `require("node:fs")`。
2. ESM 中 `require` 未定义，异常被空 `catch` 吞掉，函数回落到 `return true`。
3. 网关启动后又把 `OPENCODEX_NATIVE_EGRESS=1` 写入用户环境和当前进程。
4. 用户在控制台关闭开关时，接口虽然把 `{ enabled: false }` 写进 JSON，但重新发布环境变量时优先读取旧的 `process.env.OPENCODEX_NATIVE_EGRESS=1`，因此仍写回 `1`。
5. 后续 Desktop 启动的 bridge 继续拦截官方流量；网关挂掉时，涉及被识别为子代理的官方请求仍依赖网关。

影响：项目最核心的故障隔离能力与 UI 展示不一致。用户以为已关闭拦截，实际仍可能处于拦截状态。

建议：

- 直接使用文件顶部已导入的 `fs.readFileSync`，不要在 ESM 中调用 `require`。
- 区分“用户显式外部覆盖值”和“OpenCodex 自己上次写入的派生环境值”；设置文件应为控制台开关的唯一持久化事实源。
- `bridgeEnvironmentValues()` 应接收明确的 `nativeEgress` 参数，避免内部再次从陈旧环境读取。
- 增加真正的进程级测试：设置文件为 `false`、环境无覆盖时必须返回 `false`；从 `true` 切换到 `false` 后重新注册必须发布 `0`。

### P0-2 `npm test` 会修改真实系统状态并可能重启 Codex

位置：

- `test/v2_server.test.mjs:10-35`
- `test/gateway_lock.test.mjs:13-25`
- `test/port_conflict.test.mjs`
- `src_v2/server/gateway.ts:1780-1865`
- `src_v2/server/gateway.ts:2897-2915`
- `src_v2/platform/win32.ts:373-411`
- `src_v2/server/gateway.ts:1138-1164`

多个测试直接启动真实 `CodexBridgeServer`。监听成功后，生产代码会：

- 写入 `HKCU\Environment`；
- 设置 `CODEX_CLI_PATH` 和 `OPENCODEX_*`；
- 广播环境变化；
- 创建 Desktop 重启标记；
- 在检测到原生 app-server 时调用 `restartDesktopClients(true)`。

测试只替换了部分数据/配置路径，没有替换平台控制器；`CredentialStore` 还在模块加载时固定指向真实的 `~/.opencodex/providers.json`。即使测试最后调用 `server.stop()`，已经排队的 500ms Desktop 重启定时器也没有被取消。

影响：开发者、CI 或审计者运行常规测试，可能导致正在工作的 Codex 被结束、桥接环境短暂被改写、真实供应商配置被读取或同步。这也是审计过程中不能直接运行完整测试套件的原因。

建议：

- 给 `CodexBridgeServer` 注入 `DesktopController`、凭据目录、目录同步器和计时器。
- 测试默认使用 no-op 平台控制器，禁止注册表、进程、真实 HOME 和真实 Codex 文件访问。
- 增加硬门禁，例如 `OPENCODEX_TEST_MODE=1` 时所有系统级写操作直接抛错或记录到 mock。
- `stop()` 必须取消所有延迟任务。

## 3. P1：高优先级问题

### P1-1 编辑服务商模型时过滤条件反了，已删除模型会残留

位置：`src_v2/server/gateway.ts:2305-2347`

注释要求“删除该服务商已不再选择的模型”，但 `filter()` 对属于当前服务商的条目执行的是：只要条目匹配 `desiredSlugs` 就删除，否则保留。随后当前选择又被 `upsert` 回去，最终结果是：

- 当前选择仍存在；
- 本应删除的旧选择也继续存在。

影响：用户修改模型列表后，旧模型仍出现在 Codex 模型菜单或路由目录中；如果旧模型已失效，会造成“明明删了仍能选、选了就报错”。

建议：将逻辑改为保留 `desiredSlugs` 中的条目，或更稳妥地先删除该 owner 的全部条目，再由当前提交列表完整重建；为“从 A,B 改为 B,C”增加回归测试。

### P1-2 清理托管配置会删除用户自己的全局配置

位置：`src_v2/server/gateway.ts:162-168`

`stripManagedCodexConfig()` 除了删除带 OpenCodex marker 的区块，还会无条件删除所有顶层：

- `model_catalog_json = ...`
- `openai_base_url = ...`

这些值可能是用户原本就有的配置，不一定由 OpenCodex 创建。

影响：用户点击还原、脱离或删除最后一个第三方模型后，其他 Codex 自定义目录或代理配置会被静默抹掉。

建议：只删除 marker 包围的内容；若要兼容旧版无 marker 配置，应精确匹配 OpenCodex 自己写入的路径、端口和 provider，并先备份。

### P1-3 会话“修复”遍历并原地重写所有活动及归档 rollout

位置：`src_v2/server/gateway.ts:705-771`

`repairNativeRollouts()` 扫描 `~/.codex/sessions` 与 `~/.codex/archived_sessions` 的全部文件，并：

- 删除所有被判为 gateway reasoning 的记录；
- 删除所有 ID 不符合 native 模式的 reasoning 记录；
- 改写所有不符合 `fc_*` 格式的 function call ID；
- 直接覆盖原文件，没有备份、临时文件原子替换或目标 session 限定。

影响：可能修改从未经过 OpenCodex 的会话、其他工具生成的会话或以后新版 Codex 的合法格式；中途崩溃还可能留下截断文件。

建议：只修复有明确 OpenCodex provenance 的 session；写前备份；使用临时文件 + 原子 rename；先 dry-run 并在 UI 展示将修改的文件数；不可识别格式应跳过。

### P1-4 本地 Responses/Images/Compact 入口没有认证，却会注入用户的 Codex 登录令牌

位置：

- `src_v2/server/gateway.ts:1891-1946`
- `src_v2/server/native_headers.ts:30-71`

只有 `/api/*` 受 admin token 保护；`/v1/responses`、`/responses/compact`、`/v1/images/generations` 不要求认证。转发到官方链路时，如果来访请求没有 bearer、使用 dummy token 或使用本地 admin token，代码会读取 `~/.codex/auth.json` 并换成用户的真实 access token。

影响：任意本地进程，以及能打到 loopback 的浏览器/恶意页面链路，都可能借用用户的 Codex 登录态发起官方请求。仅监听 `127.0.0.1` 不能替代客户端认证。

建议：所有能够触发官方或第三方上游请求的入口都验证随机 bridge token；token 只通过受控 bridge 参数/环境传递；同时校验 `Origin`/`Host`，限制浏览器跨站滥用。

### P1-5 Windows 子代理 `exec_command` 固定调用 `/bin/zsh`，且不是真沙箱

位置：`src_v2/server/gateway.ts:805-870`

Windows 发行版中 `/bin/zsh` 通常不存在，因此第三方子代理一旦调用 `exec_command` 就会失败。另一方面，这里只是限制了 `cwd` 必须位于当前工作区；shell 命令本身仍可使用绝对路径、环境变量、网络和系统命令访问工作区之外，也没有复用 Codex 的审批或沙箱机制。

影响：Windows 新用户获得的是“命令工具不可用”；在有 zsh 的系统上又可能获得超出 UI 暗示的系统访问能力。

建议：不要在 gateway 内实现任意 shell 执行。应通过 Codex 原生工具/审批链执行；若必须保留，至少按平台选择 shell、清理环境、施加 OS 沙箱并对每次执行进行用户审批。

### P1-6 供应商连接测试会把 404/429/500 等错误标记为“连接成功”

位置：`src_v2/server/gateway.ts:2455-2514`

`/api/providers/test` 只把 401 和 403 判为失败；其他 HTTP 状态，包括 404、429、500、502，都会走到 `connected`。

影响：新用户输入错误 Base URL、上游故障或限流时，控制台显示连接成功，真正发起模型请求才失败。

建议：只有 `2xx` 才算成功；404 应提示 Base URL 可能已包含错误路径；429、5xx 分别显示限流和上游故障。对于没有 `/models` 的供应商应采用协议级最小请求，而不是放宽为任意状态成功。

### P1-7 配置落盘失败被吞掉，API 仍可能返回保存成功

位置：

- `src_v2/services/credential_store.ts:140-156`
- `src_v2/server/gateway.ts:2285-2304`

`CredentialStore.saveProviders()` 捕获写文件/权限错误后仅输出日志，不向调用方抛出。服务商保存接口随后继续更新目录并返回 HTTP 200。

影响：只读目录、杀毒软件占用、权限或磁盘错误时，UI 显示“保存成功”，重启后配置消失；还可能出现凭据已经写入系统密钥库、provider 元数据却没有落盘的半成功状态。

建议：让保存函数抛错；凭据写入和 provider 文件更新采用可回滚顺序；接口只有在全部持久化成功后返回 200。

### P1-8 Windows 重启实现会按映像名结束全部 Codex/ChatGPT 进程

位置：`src_v2/platform/win32.ts:299-307`

`taskkill /F /T /IM` 对固定映像名执行全局强杀，没有限定为当前 OpenCodex 管理的 Desktop PID。

影响：用户的其他 Codex 窗口、并行任务甚至同名 ChatGPT 进程都可能被一起结束；未保存的交互状态可能丢失。

建议：启动时记录并验证受管 Desktop PID；重启只作用于该进程树。无法确认归属时应要求用户手动重启，而不是全局强杀。

### P1-9 文档声明 Node 20+，实际依赖要求 Node 22.19+

位置：

- `README.md:166`
- `scripts/package-windows.mjs:61,150`
- `package-lock.json` 中 `undici@8.5.0`

锁定的 `undici@8.5.0` 声明 `engines.node >= 22.19.0`，但 README 和 Windows 启动提示均告诉用户 Node 20+ 即可。

影响：严格 engine 环境会直接安装失败；宽松环境可能安装成功但在运行时遇到缺失 API。新用户会按官方说明安装一个项目并不支持的 Node 版本。

建议：要么把最低版本统一提升为 Node 22.19+，要么降级并锁定真正支持 Node 20 的 undici 版本，同时在 CI 覆盖声明的最低版本。

### P1-10 “还原原生”硬编码把默认模型改成 `gpt-5.5`

位置：

- `src_v2/server/gateway.ts:2838-2844`
- `src_v2/codex-provider-bridge.ts:214-225`

项目当前面向 5.6，但 reset 会强制把现有 `model = "..."` 改成 `gpt-5.5`，bridge 无法判断默认模型时也回退到 `gpt-5.5`。

影响：用户原本选择的官方模型被改写；当账号/客户端已不提供该模型时，新 session 会失败或产生与 UI 不一致的状态。

建议：还原时不要改用户的 `model`；确需选择默认值时，从当前原生 catalog/客户端配置中解析，不要硬编码版本。

## 4. P2：中优先级问题

### P2-1 多处忽略 `CODEX_HOME`，便携或自定义目录会出现“分裂状态”

`src_v2/platform/paths.ts` 已提供 `codexHomePath()`，但下列模块仍直接使用 `os.homedir()/.codex`：

- `src_v2/codex-provider-bridge.ts` 的模型目录、配置及响应字段；
- `src_v2/server/gateway.ts` 的模型缓存和 rollout 修复；
- `src_v2/server/native_headers.ts` 的 `auth.json`；
- `src_v2/services/catalog_sync.ts`、`session_history.ts`、`task_router.ts`。

影响：使用 `CODEX_HOME` 的用户会出现配置写在 A、令牌从 B 读、会话从 B 修、缓存同步到 B 的问题。

建议：所有 Codex 文件路径统一从 `codexHomePath()` 派生，并允许测试注入。

### P2-2 第三方 Responses 子代理路径会把完整 SSE 响应保存在内存中

位置：`src_v2/server/router.ts:222-283`

`collectThirdPartyResponsesBody()` 把每个 SSE event 放入 `events[]`，直到上游完整结束后才返回。长回复、工具循环或异常上游可以造成显著内存增长；非 SSE 错误体也通过无上限的 `response.text()` 读取。

建议：为累计事件、错误体和单事件设置硬上限；能在线消费的内容不要完整保留；超过限制时返回明确的 provider protocol error。

### P2-3 rollout 和关键 JSON 文件写入普遍不是原子操作

模型目录、provider 配置、native-egress 设置和 rollout 修复多处直接 `writeFileSync` 覆盖最终文件。进程崩溃、磁盘满或杀毒软件干预时可能留下空文件/半文件。

建议：统一实现 `writeJsonAtomic()`：同目录临时文件、flush、rename，并保留最近一次可恢复备份。

### P2-4 Windows 发行包默认开启付费/额外请求功能，与文档默认值冲突

位置：`scripts/package-windows.mjs:125-136,216-220`

生成的 README 写明 `OPENCODEX_AGENT_MESSAGE_ORACLE` 默认关闭，但生成的 `opencodex.env` 主动写入 `OPENCODEX_AGENT_MESSAGE_ORACLE=1`。该功能每个不同的加密子代理任务会多发一次 ChatGPT 请求，并依赖未公开格式。

影响：新用户在没有明确选择的情况下承担额外请求、延迟和兼容性风险。

建议：发行包默认注释掉该变量；首次启用时在 UI 明确说明额外请求和隐私/兼容风险。

### P2-5 预设模型包含已知不可用项

位置：

- `src_v2/server/gateway.ts:2151-2161`
- `README.md:161`

DeepSeek 预设直接提供 `deepseek-v4-pro`，而 README 同时承认该模型当前会被服务端拒绝。新用户通常会把预设视为已验证推荐项。

建议：从默认预设移除已知不可用模型，或标记为实验性并禁止一键启用；预设应由可更新 registry 驱动，而不是写死在 gateway 源码。

## 5. 新用户最容易遇到的实际故障路径

1. 按 README 安装 Node 20，依赖安装或运行失败。
2. 选择预设中的已知不可用模型，连接测试还可能显示成功，正式请求才报错。
3. 编辑服务商删掉旧模型，旧模型仍留在菜单里。
4. 关闭“官方模型经过代理”开关，UI 看似成功，但持久化环境仍是开启状态。
5. 网关停止后重新打开 Codex，持久化的 `CODEX_CLI_PATH` 仍可能让 Desktop 启动 bridge；第三方请求失败，用户难以判断是网关、bridge 还是模型问题。
6. 点击还原/脱离时，用户自己的 `model_catalog_json` 或 `openai_base_url` 被删除，同时所有历史 rollout 被批量重写。
7. 第三方子代理尝试执行命令时，Windows 因找不到 `/bin/zsh` 失败。

## 6. 建议修复顺序

### 第一批：先守住“不弄崩 Codex”

1. 修复 `nativeEgressEnabled()` 和环境变量优先级。
2. 将所有测试与真实注册表、进程、HOME、Codex 配置完全隔离。
3. 停止全量 rollout 自动修复；改成有备份、可预览、仅处理明确归属 session。
4. `stripManagedCodexConfig()` 只删除 marker 内容。
5. Windows 重启只处理明确受管 PID。

### 第二批：修复新用户高频失败

1. 修正 provider 模型过滤方向并补回归测试。
2. 统一 Node 最低版本。
3. 连接测试只接受 2xx。
4. 保存失败必须返回失败。
5. 去掉 `gpt-5.5` 和已知不可用模型的硬编码。

### 第三批：收紧安全和长期维护

1. 给所有上游代理入口增加 bridge 认证。
2. 统一 `CODEX_HOME` 与 OpenCodex data-dir 路径解析。
3. 移除 gateway 内任意 shell，或接入原生审批/沙箱。
4. 为流式响应、错误体、日志和调试转储设置大小与保留上限。
5. 所有关键配置改为原子写入。

## 7. 最低回归测试清单

- 设置文件为 `false` 时，bridge 启动参数不得包含 `openai_base_url` 覆盖。
- 从开切到关后，新启动 Desktop 必须收到 `OPENCODEX_NATIVE_EGRESS=0`。
- 网关未运行时，普通官方模型 turn 仍能直连官方链路。
- 运行完整测试前后，`HKCU\Environment`、Codex/ChatGPT PID、真实 `~/.codex` 和 `~/.opencodex` 内容完全不变。
- provider 模型从 `A,B` 改为 `B,C` 后目录中只能留下 `B,C`。
- 用户自有 `model_catalog_json`、`openai_base_url` 在脱离 OpenCodex 后保持原样。
- rollout 修复失败时原文件保持完整，且非 OpenCodex session 不发生任何字节变化。
- `/models` 返回 404/429/500 时控制台不得显示连接成功。
- provider 配置目录只读时保存接口返回非 2xx，UI 不显示成功。
- `CODEX_HOME` 指向临时目录时，auth、config、cache、sessions 全部只访问该目录。
- Windows 第三方子代理调用命令工具时，不依赖 `/bin/zsh`。
- 未携带 bridge token 的本地 `/v1/responses` 请求被拒绝。

## 8. 本次审计边界

- 审计的是上述提交对应的最新源码仓库，不是 `OpenCodex-2.0.0-win-x64` 发行目录。
- 为避免影响正在运行的 Codex，本次没有启动 gateway、没有执行完整 `npm test`、没有调用重启/脱离/reset API，也没有修改注册表、Codex 配置、凭据和 session。
- 结论来自源码、构建/测试脚本、发行脚本和现有测试的交叉审阅；报告本身是本次唯一新增文件。
