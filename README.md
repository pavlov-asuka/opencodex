# OpenCodex — Windows Provider Bridge

在 **Windows 11** 上让 Codex Desktop 同时使用官方 GPT 和第三方模型:官方模型保持原生 ChatGPT/Codex 线路,第三方模型经由 OpenCodex 网关路由。

这是 [AITabby/opencodex](https://github.com/AITabby/codexsplit)(现已更名为 CodexSplit)的一个 Fork。上游实现了 v1.2 的 provider split 架构,但**公开仓库中不包含任何 Windows 源码**,因此这套分流在 Windows 上从未真正工作。本 Fork 补上了缺失的平台层。

```
                    GPT-5.6 Sol
                         │
                    Codex 主 Agent
                         │
          ┌──────────────┼──────────────┐
          │              │              │
      自己执行       spawn_agent     新 Session
          │              │              │
          ▼              ▼              ▼
       OpenAI      DeepSeek Flash   DeepSeek Flash
                         │              │
                         └──────┬───────┘
                                ▼
                          OpenCodex 网关
                                ▼
                            DeepSeek
```

## 快速开始

1. 从 [Releases](https://github.com/pavlov-asuka/opencodex/releases/latest) 下载 `OpenCodex-1.2.0-win-x64.zip`,解压到任意位置
2. 双击 **`OpenCodex.exe`** —— 它会启动网关并打开控制台 `http://127.0.0.1:8765`
3. 在控制台配置服务商(API Key + 模型)并应用
4. 重启 Codex Desktop,第三方模型即出现在模型选择器中

**不需要安装 Node.js** —— 启动器会回落到 Codex 自带的运行时。

### 开机自启

```
schtasks /Create /TN "OpenCodex Gateway" /TR "\"%CD%\OpenCodex.exe\" --background" /SC ONLOGON /RL LIMITED /F
```

建议配置。`CODEX_CLI_PATH` 持久化在 `HKCU\Environment` 中,所以重启后 Codex Desktop 无论网关是否运行都会拉起 provider bridge;网关不在时 bridge 无处可路由,第三方模型会失败。

取消:`schtasks /Delete /TN "OpenCodex Gateway" /F`

## 相比上游修复了什么

| 问题 | 说明 |
| --- | --- |
| **Provider bridge 在 Windows 完全缺失** | 整个 Desktop 生命周期层(注册环境、发现、进程管理、启动)都是 macOS 专用;bridge launcher 是 POSIX `sh` 脚本,Windows 无法执行 |
| **`config.toml` 被损坏** | 目录路径写进了 TOML **基本字符串**,`C:\Users\...` 中的 `\U` 是非法 Unicode 转义,导致整个配置文件解析失败 —— 影响远超 OpenCodex 本身 |
| **无法保存 API Key** | `storeProviderSecret()` 在非 macOS 平台直接抛错,且 `saveProviders()` 会剥离 `api_key`,没有任何退路 |
| **Windows 沙箱设置失败** | Codex 按 `dirname(CODEX_CLI_PATH)` 解析三个辅助程序,bridge 目录里没有它们 |
| **第三方模型无法作为子代理** | Codex 用模型目录中的 `multi_agent_version` 决定 `spawn_agent` 资格,上游从不写这个字段 |
| **官方模型在子代理路径被误拒** | 已算出的 `nativePassthroughTurn` 未被采纳,官方模型新建 Session 会返回 400 |
| **网关生命周期竞争** | 抢端口失败的实例会清除健康实例的环境变量,导致 Desktop 静默退回原生 |
| **删除服务商残留密钥** | 密钥留在系统密钥库中,且配置里已无引用可清理 |

其中 TOML 转义修复与 Windows 无关的部分已向上游提交:[AITabby/codexsplit#37](https://github.com/AITabby/codexsplit/pull/37)。

## 工作原理

Codex Desktop 在 Windows 上是 MSIX 全信任应用(`OpenAI.Codex`)。它解析 app-server 时**优先读取 `CODEX_CLI_PATH`**,只校验文件存在,然后用 `child_process.spawn` **无 shell** 启动 —— 所以接管点必须是真正的 PE 可执行文件,`.cmd` 和 shebang 脚本都会被拒绝。

```
ChatGPT Desktop (MSIX)
        │  读 CODEX_CLI_PATH  ← HKCU\Environment + WM_SETTINGCHANGE 广播
        ▼
codex-provider-bridge.exe        Rust,零依赖,~200KB
        │  继承 stdio / 透传 argv / job object 防孤儿进程
        ▼
codex-provider-bridge.js
        ├── 官方 GPT  →  原生 codex.exe        (保持 ChatGPT 订阅线路)
        └── 第三方    →  网关 :8765  →  DeepSeek
```

与 macOS 的关键差异:

| | macOS | Windows |
| --- | --- | --- |
| 会话级环境变量 | `launchctl setenv` | `HKCU\Environment` + `WM_SETTINGCHANGE` |
| 应用发现 | `.app` bundle + PlistBuddy | MSIX 包查询(`Get-AppxPackage`) |
| 启动方式 | `open -a` | shell 激活(保住 package identity) |
| 进程管理 | `killall` / `pgrep` | `taskkill` / `Win32_Process` |
| 凭据存储 | Keychain | DPAPI(CurrentUser 作用域) |

Session 路由、`spawn_agent` 分流、同一会话内逐 turn 切换模型等能力由上游的 `codex-provider-bridge.ts` 提供,本身是平台中立的 —— 它们只是在 Windows 上从未被启动过。

## 配置

`opencodex.env` 与可执行文件同目录,启动时读取,每行一条 `KEY=VALUE`:

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `OPENCODEX_AGENT_MESSAGE_ORACLE` | 关闭 | 恢复加密的子代理任务载荷(见下) |
| `OPENCODEX_AGENT_MESSAGE_ORACLE_MODEL` | `gpt-5.6-sol` | 用于提取的模型 |
| `OPENCODEX_AGENT_MESSAGE_ORACLE_TIMEOUT_MS` | `60000` | 提取超时 |
| `OPENCODEX_PORT` | `8765` | 网关端口 |
| `OPENCODEX_WINDOWS_LAUNCH_MODE` | `shell` | `direct` 绕过 shell 激活启动 Desktop |
| `OPENCODEX_MULTI_AGENT_VERSION` | `v2` | 写入模型目录的多 Agent 协议版本 |
| `OPENCODEX_DEBUG_REQUEST_DUMP` | 关闭 | 记录发往服务商请求的目录(诊断用) |

## 已知限制

**子代理任务载荷是加密的。** Codex 多 Agent v2 把子代理的任务放在 `agent_message` 的 `encrypted_content` 中,那是给 ChatGPT 后端解密的 Fernet token,第三方模型收到的是一段读不懂的密文,因而报告"没有收到任务"。这是上游问题,不是路由缺陷:

- [openai/codex#32031](https://github.com/openai/codex/issues/32031) —— 上游跟踪
- [lidge-jun/opencodex#92](https://github.com/lidge-jun/opencodex/issues/92) —— 同一问题的详细分析,至今开放

`OPENCODEX_AGENT_MESSAGE_ORACLE=1` 提供了一条恢复路径(技术方案由 [@Joseffb](https://github.com/Joseffb) 在 [lidge-jun/opencodex#92](https://github.com/lidge-jun/opencodex/issues/92) 中公开):把信封用**你自己的 Codex 凭据**发回 ChatGPT,配合一次强制函数调用,由后端解密自己的密文并把明文作为函数参数返回,再转成标准输入交给第三方模型。**代价是每个不同任务多一次 ChatGPT 请求**,且依赖未公开的内部格式 —— 上游改动格式即会失效。关闭时该轮次会明确失败(`unreadable_encrypted_agent_task`),而不是让子代理拿着空任务运行。

**其他:**

- 这是**便携目录,不是安装程序**。上游的 Windows 安装外壳未公开,无法从源码复现。
- 只在 Windows 11 + 新版统一 ChatGPT Desktop(MSIX 包 `OpenAI.Codex`)上验证过。
- `deepseek-v4-pro` 目前会被 DeepSeek 服务端拒绝(提示 Codex 集成尚未开放),与本项目无关。
- macOS 路径行为保持不变,但本 Fork 未在 macOS 上回归测试。

## 从源码构建

需要 Node.js 20+、npm,以及 [Rust](https://rustup.rs)(用于两个可执行文件):

```bash
npm install
npm run build:windows      # 编译网关 + bridge shim + 启动器
npm run package:windows    # 生成 build/OpenCodex-win-x64 和 zip
```

```bash
npm test                   # 全量测试
```

当前:**209 通过 / 1 失败**。唯一失败项是 `session_projection` 中一条基于源码文本的断言,因 Windows 以 CRLF 检出而失效 —— 在上游同样失败,与本 Fork 改动无关。作为对照,上游 v1.2.0 在 Windows 上是 180 通过 / 10 失败。

### 主要新增文件

| 路径 | 作用 |
| --- | --- |
| `src_v2/platform/win32.ts` | Windows Desktop 控制器 |
| `src_v2/platform/darwin.ts` | macOS 逻辑(自 gateway.ts 原样迁出) |
| `src_v2/platform/secrets.ts` | DPAPI 凭据存储 |
| `src_v2/services/agent_message_oracle.ts` | 子代理加密载荷恢复 |
| `native/windows-bridge-launcher/` | Rust bridge shim |
| `native/windows-launcher/` | Rust 应用启动器(`OpenCodex.exe`) |
| `scripts/build.mjs` | 跨平台构建(替换 POSIX-only 的构建链) |
| `scripts/package-windows.mjs` | Windows 打包 |

## 致谢

- [AITabby/codexsplit](https://github.com/AITabby/codexsplit) —— 上游项目与 provider split 架构
- [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) —— 同领域更成熟的实现,子代理加密问题的分析来源
- [@Joseffb](https://github.com/Joseffb/codex-deepseek-shim) —— 加密载荷恢复方案

## License

与上游一致。

---

## English

A Windows 11 fork of [AITabby/opencodex](https://github.com/AITabby/codexsplit) (now CodexSplit) that makes the v1.2 provider split actually work: official GPT models stay on the native ChatGPT/Codex route while third-party models are routed through the OpenCodex gateway.

Upstream ships **no Windows source at all** — the Windows platform layer was removed before v1.0.8 and the published installers are built out of tree. This fork adds it: a Rust bridge shim (Codex spawns `CODEX_CLI_PATH` without a shell, so it must be a real PE executable), `HKCU\Environment` registration in place of `launchctl setenv`, MSIX package discovery, DPAPI credential storage, and a double-clickable launcher.

It also fixes a bug that breaks Codex for **every** Windows user regardless of this fork: the model catalog path was written into a TOML basic string, so `\U` in `C:\Users\...` made the entire `config.toml` unparseable. Submitted upstream as [#37](https://github.com/AITabby/codexsplit/pull/37).

**Install:** download the zip from [Releases](https://github.com/pavlov-asuka/opencodex/releases/latest), extract, run `OpenCodex.exe`. Node.js is not required.

**Known limitation:** multi-agent v2 delivers a subagent's task inside an `encrypted_content` block readable only by the ChatGPT backend, so third-party children receive an empty task ([openai/codex#32031](https://github.com/openai/codex/issues/32031)). Set `OPENCODEX_AGENT_MESSAGE_ORACLE=1` to recover it through your own Codex credentials, at the cost of one extra ChatGPT request per task.

Tests: 209 passing, 1 failing (a pre-existing CRLF assertion that also fails upstream).
