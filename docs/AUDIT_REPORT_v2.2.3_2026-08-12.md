# OpenCodex v2.2.3 严格审阅报告

- 审阅对象：`pavlov-asuka/opencodex`
- 分支/提交：`main` / `7bea6a551f256b48edadc3e00959e72857aaeb77`
- Release：`v2.2.3`
- 日期：2026-08-12
- 重点：Windows 11 新用户的下载、首次启动、服务商配置、模型请求、端口冲突、恢复原生路径

## 总体判断

当前版本的核心转发链路已经能工作，明显强于早期版本：干净安装、TypeScript 编译成功；本地伪造 Responses 服务商的组合端到端测试通过，确认模型命名空间、后端模型映射、上游鉴权、SSE 文本、工具调用 ID 与完成事件均能穿过真实网关。

但我仍不建议把 v2.2.3 标为“新用户稳定版”。本轮确认 3 个高优先级问题、5 个中优先级问题，以及测试发布流程方面的缺口。最需要先处理的是：上游入口实际不强制令牌、Responses 被整段缓冲、OpenCode Go 默认预设不可用。

## 高优先级

### P1-1 可触达付费上游的入口没有真正强制网关令牌

README 声明“控制台 API 与所有可触达上游的入口都需要网关令牌”，但实现仅对 `/api/*` 强制认证。`/v1/responses`、`/responses/compact`、`/v1/images/generations` 等路径只在请求带 `Origin` / `Sec-Fetch-*` 且未认证时拒绝；不带浏览器标头的无令牌请求会继续执行。

本地组合 E2E 实测：删除 `Authorization` 后向 `/v1/responses` 发请求，返回 HTTP 200；网关仍把 DPAPI/配置中保存的服务商 Key 加到上游请求中。

影响：任何能访问本机 loopback、但读不到 DPAPI 文件或 `config.toml` 的本地进程，都可以消耗用户的第三方余额或 Codex 配额。浏览器 CSRF 防线是有的，但它不能替代入口认证，且文档给出了更强的安全承诺。

证据：[gateway.ts L2158-L2169](https://github.com/pavlov-asuka/opencodex/blob/7bea6a551f256b48edadc3e00959e72857aaeb77/src_v2/server/gateway.ts#L2158-L2169)、[gateway.ts L1577-L1624](https://github.com/pavlov-asuka/opencodex/blob/7bea6a551f256b48edadc3e00959e72857aaeb77/src_v2/server/gateway.ts#L1577-L1624)、[README L68](https://github.com/pavlov-asuka/opencodex/blob/7bea6a551f256b48edadc3e00959e72857aaeb77/README.md#L68)

建议：所有 `isUpstreamReachingPath()` 路径先执行 `requireAdmin()`；bridge 一律携带随机令牌。若必须兼容旧客户端，应提供明确、默认关闭的 legacy 选项，不能静默放行。

### P1-2 第三方 Responses 流被完整缓冲，用户长时间看不到首个 token

普通第三方 Responses 请求先由 `collectThirdPartyResponsesBody()` 收集全部 SSE 事件，等上游结束后才 `writeHead()` 并逐条写给 Codex。也就是说，接口名义上是 streaming，实际首字节延迟约等于整次模型生成时间。64 MiB 上限避免了无限 OOM，但没有解决延迟。

影响：DeepSeek V4 Flash 这类原生 Responses 模型在长任务、长推理或工具调用前会表现为“卡住/没反应”；新用户很容易误判网关、网络或 Codex 已崩溃。Chat 转换路径反而会逐块转发。

证据：[router.ts L222-L330](https://github.com/pavlov-asuka/opencodex/blob/7bea6a551f256b48edadc3e00959e72857aaeb77/src_v2/server/router.ts#L222-L330)、[router.ts L407-L477](https://github.com/pavlov-asuka/opencodex/blob/7bea6a551f256b48edadc3e00959e72857aaeb77/src_v2/server/router.ts#L407-L477)

建议：没有暴露网关内部 `spawn_agent` 工具时直接流式过滤；需要内部编排时只缓冲到确认是否出现相关 function call，或把内部调用拦截设计成增量状态机。增加“首个 SSE 事件必须在上游完成前到达”的时序测试。

### P1-3 OpenCode Go 预设的默认模型不存在

仓库把 OpenCode Go 默认模型写成 `opencode-go-pro`。OpenCode 官方当前列出的 Go 模型 ID 包括 `deepseek-v4-flash`、`deepseek-v4-pro`、`minimax-m3`、`qwen3.7-max` 等，没有 `opencode-go-pro`。新用户按预设只填 Key 并保存，会得到一个必然失败的模型。

另外，Go 的部分模型走 `/chat/completions`，部分模型走 `/v1/messages`。当前预设只有一个 Base URL，UI 只提供 Chat/Responses 两项，不能在同一个 Go provider 下表达官方文档里的两类端点。

证据：[gateway.ts L2435-L2437](https://github.com/pavlov-asuka/opencodex/blob/7bea6a551f256b48edadc3e00959e72857aaeb77/src_v2/server/gateway.ts#L2435-L2437)、[OpenCode Go 官方模型与端点](https://opencode.ai/docs/go/)

建议：默认模型至少改为真实可用的 `deepseek-v4-flash`；更稳妥的做法是保存 Key 后读取 `/models`，不硬编码会快速变化的列表。为 Go 增加 per-model endpoint/protocol，或拆成 Chat 与 Anthropic 两个 provider 配置。

## 中优先级

### P2-1 `Start-OpenCodex.cmd` 会关闭文档承诺的自动换端口

批处理启动器在未配置时主动设置 `OPENCODEX_PORT=8765`，而网关把环境里存在该变量视为“用户显式指定”，端口被占用时直接失败，不再顺延。双击 `OpenCodex.exe` 可以换端口，使用可见控制台启动器却不行。

证据：[package-windows.mjs L51-L68](https://github.com/pavlov-asuka/opencodex/blob/7bea6a551f256b48edadc3e00959e72857aaeb77/scripts/package-windows.mjs#L51-L68)、[gateway.ts L2004-L2029](https://github.com/pavlov-asuka/opencodex/blob/7bea6a551f256b48edadc3e00959e72857aaeb77/src_v2/server/gateway.ts#L2004-L2029)

建议：批处理不要设置默认变量，只在输出中显示“默认从 8765 开始尝试”。

### P2-2 Windows 配置弹窗仍显示“macOS Keychain”

服务商管理弹窗的说明和 placeholder 硬编码为 macOS Keychain；Windows 发行版实际使用 DPAPI。首次输入 API Key 时会直接出现平台错误文案。

证据：[dashboard/app.ts L88-L91](https://github.com/pavlov-asuka/opencodex/blob/7bea6a551f256b48edadc3e00959e72857aaeb77/src_v2/services/dashboard/app.ts#L88-L91)

建议：后端返回 `credential_backend_label`，前端统一使用，不在脚本中写平台名。

### P2-3 自定义 provider 实际只能保存一个，换地址还会遗留旧 DPAPI 密文

前端用 `preset_id === "custom"` 找当前 provider；后端也先按同一个 `preset_id` 找已有项，因此第二个自定义端点会覆盖第一个，冲突分支基本无法从 UI 触发。若 URL 导致 provider 名变化并输入新 Key，credential reference 会改到新 account，旧 DPAPI 文件没有删除。

证据：[dashboard/app.ts L53-L70](https://github.com/pavlov-asuka/opencodex/blob/7bea6a551f256b48edadc3e00959e72857aaeb77/src_v2/services/dashboard/app.ts#L53-L70)、[gateway.ts L2518-L2555](https://github.com/pavlov-asuka/opencodex/blob/7bea6a551f256b48edadc3e00959e72857aaeb77/src_v2/server/gateway.ts#L2518-L2555)

建议：给每个 provider 独立 UUID；`preset_id` 只表示模板，不作为实例主键。provider 改名后删除旧 credential reference。

### P2-4 自定义数据目录没有被完整遵守，恢复脚本也硬编码默认目录

`providers.json`、catalog 等使用 `OPENCODEX_DATA_DIR`，Windows DPAPI 密文却固定写到 `~/.opencodex/secrets`；bridge 的端口 lock 扫描同样固定读取 `~/.opencodex`。`Restore-Native-Codex.cmd` 固定清理 `%USERPROFILE%\.codex\config.toml`，不处理 `CODEX_HOME`，结尾也固定声称数据在默认目录。

影响：文档允许的自定义路径会形成“配置在 A、密钥和锁文件在 B、恢复脚本只清 C”的分裂状态。

证据：[secrets.ts L67-L77](https://github.com/pavlov-asuka/opencodex/blob/7bea6a551f256b48edadc3e00959e72857aaeb77/src_v2/platform/secrets.ts#L67-L77)、[codex-provider-bridge.ts L463-L477](https://github.com/pavlov-asuka/opencodex/blob/7bea6a551f256b48edadc3e00959e72857aaeb77/src_v2/codex-provider-bridge.ts#L463-L477)、[restore-native-codex.cmd L48-L58](https://github.com/pavlov-asuka/opencodex/blob/7bea6a551f256b48edadc3e00959e72857aaeb77/scripts/restore-native-codex.cmd#L48-L58)

建议：所有路径从 `openCodexDataDir()` / `codexHomePath()` 派生；恢复脚本读取用户环境里的 `CODEX_HOME`，并在清理前打印实际目标。

### P2-5 生产依赖 `undici@8.5.0` 当前有高危审计告警

`npm audit --omit=dev` 报告 `undici 8.0.0–8.8.0` 有 5 条公告，仓库锁定 8.5.0；当前 8.10.0 已超出受影响范围且 Node 要求仍是 `>=22.19.0`。其中多条涉及 cache/cookie/blob，OpenCodex 当前主要用 Agent + JSON POST，直接可利用性可能有限，但发布包不应继续带已知高危版本。

证据：[package.json L19-L24](https://github.com/pavlov-asuka/opencodex/blob/7bea6a551f256b48edadc3e00959e72857aaeb77/package.json#L19-L24)、[GHSA-8xcm-r25x-g524](https://github.com/advisories/GHSA-8xcm-r25x-g524)

建议：升级到 `undici@8.10.0`，重新跑网络重试、流式响应与 compaction 测试。

## 预设准确性补充

- MiniMax 官方直连模型 ID 写作 `MiniMax-M3`，仓库预设为小写 `minimax-m3`。官方 API 枚举使用区分大小写的 ID，建议用真实 API 做一次确认并修正预设。[MiniMax 官方接口说明](https://platform.minimaxi.com/docs/api-reference/api-overview)
- DeepSeek 默认 Base URL 与 `deepseek-v4-flash` Responses 路径符合当前官方文档；本轮未发现 endpoint 拼接错误。[DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api/)

## 测试与构建结果

### 已通过

- `npm ci`：通过（Node v24.14.0；项目最低要求 Node 22.19）
- `npm run typecheck`：通过
- `npm run build`：通过
- 发布 zip SHA-256：与 Release 页面一致
- `OpenCodex.exe`：PE32+ GUI x86-64
- `codex-provider-bridge.exe`：PE32+ console x86-64
- 发布包编译 JS：与提交 `7bea6a5` 的本地构建一致
- 自建组合 E2E：真实 gateway → 本地 Responses provider → 文本/SSE/tool call/完成事件通过
- 重点测试：49 个中 48 个通过；剩余 1 个因云沙箱禁止枚举网络接口而失败，与业务断言无关

### 全量测试的解释

在当前 Linux 云沙箱中，全量结果为 256 个：236 通过、8 失败、12 跳过。6 个失败来自测试未给 `OPENCODEX_DATA_DIR`，尝试写 `/root/.opencodex`；1 个来自沙箱禁止 `os.networkInterfaces()`；dashboard 快照根据平台显示 `unavailable` 而 fixture 固定为 Windows DPAPI。它们不能直接算 Windows 产品失败。

但测试仍有隔离缺陷：`port_conflict.test.mjs` 构造真实 server 时使用用户默认 `~/.opencodex`；`gateway_discovery.test.mjs` 扫真实 home、固定端口，并在单独运行时失败，因为伪 gateway 位于 8944，而候选只包含继承端口、真实 home lock 和 8765–8774。并行全量运行可能受其他测试占用端口/lock 影响，形成偶然绿色。

建议增加 Windows CI，并让 `npm test` 自动创建临时 `HOME`、`CODEX_HOME`、`OPENCODEX_DATA_DIR`，为每个测试分配随机端口；`package:windows` 应先强制执行 typecheck 与测试。

## 尚未覆盖

- 云机不是 Windows，无法真实执行 MSIX 包发现、HKCU 环境注册、`WM_SETTINGCHANGE`、DPAPI、SmartScreen、Desktop shell 激活和 Windows sandbox helper。
- 未使用真实 DeepSeek/OpenCode Go API Key，因此没有验证真实服务商的计费请求、超长输出、真实 tool schema 和 provider 特有错误码。
- 没有代码签名验证；发布包本身明确为未签名。

## 建议修复顺序

1. 强制所有上游入口认证，并增加 tokenless 负向 E2E。
2. 恢复 Responses 真流式首字节转发。
3. 修正 OpenCode Go 预设，改为 `/models` 驱动并支持 Chat/Anthropic 两类端点。
4. 修正 `Start-OpenCodex.cmd` 的端口变量和 Windows Keychain 文案。
5. 统一自定义目录、provider 实例 ID 与凭据迁移。
6. 升级 undici，补 Windows CI 与发行门禁。
