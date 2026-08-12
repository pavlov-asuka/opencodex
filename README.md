# OpenCodex — Windows Provider Bridge

在 **Windows 11** 上让 Codex Desktop 同时使用官方 GPT 和第三方模型:官方模型保持原生 ChatGPT/Codex 线路,第三方模型经由本地网关路由。

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

这个项目只做一件事:**把多 provider 的第三方模型接进 Codex,像用原生模型一样用它们**。

## 快速开始

前提:已安装 Codex Desktop(MSIX 包 `OpenAI.Codex`)—— Node 运行时和原生 codex.exe 都从它那里取。

1. 从 [Releases](https://github.com/pavlov-asuka/opencodex/releases/latest) 下载 zip,解压到任意位置
2. 双击 **`OpenCodex.exe`** —— 它会启动网关并打开控制台 `http://127.0.0.1:8765`
   (两个可执行文件都**没有代码签名**,首次运行 Windows 会弹"已保护你的电脑",点"更多信息 → 仍要运行")
3. 在控制台填 API Key、加模型、应用
4. 重启 Codex Desktop,第三方模型即出现在模型选择器中

**不需要安装 Node.js** —— 启动器会回落到 Codex 自带的运行时。

### 开机自启

```
schtasks /Create /TN "OpenCodex Gateway" /TR "\"%CD%\OpenCodex.exe\" --background" /SC ONLOGON /RL LIMITED /F
```

建议配置。`CODEX_CLI_PATH` 持久化在 `HKCU\Environment` 中,所以重启后 Codex Desktop 无论网关是否运行都会拉起 provider bridge;网关不在时 bridge 无处可路由,第三方模型会失败。

取消:`schtasks /Delete /TN "OpenCodex Gateway" /F`

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
        └── 第三方    →  网关 :8765  →  DeepSeek / 任意 OpenAI 兼容 provider
```

模型的选择权始终在客户端:主会话由 Desktop 的模型选择器决定,子代理由父代理点名。网关不做任何"替你选模型"的策略。

## 支持的能力

| 能力 | 说明 |
| --- | --- |
| **多 provider** | 任意 OpenAI 兼容端点;Anthropic Messages 与 Google Gemini 协议由适配器按 URL/protocol 自动识别 |
| **Chat 与 Responses 两种协议** | 每个模型单独选,DeepSeek 这类原生支持 Responses 的直接走 Responses |
| **原生模型体验** | Computer Use、图像生成、apply_patch、MCP 工具对第三方模型同样可用 |
| **子代理** | 第三方模型可作为 `spawn_agent` 的子代理(需要目录里的 `multi_agent_version: v2`) |
| **Session 编排** | `thread/start` / `resume` / `fork`、同一会话内逐 turn 切换模型 |
| **推理档位** | 每模型的可选档位、默认档位,以及**下限**(见下) |

## 修复的问题

| 问题 | 说明 |
| --- | --- |
| **Windows 上没有 provider bridge** | 整个 Desktop 生命周期层(注册环境、发现、进程管理、启动)都只有 macOS 实现;bridge launcher 是 POSIX `sh` 脚本 |
| **`config.toml` 被损坏** | 目录路径写进了 TOML **基本字符串**,`C:\Users\...` 中的 `\U` 是非法 Unicode 转义,整个配置文件解析失败 —— 影响远超本项目 |
| **无法保存 API Key** | 凭据写入在非 macOS 平台直接抛错,且保存时会剥离 `api_key`,没有任何退路 |
| **Windows 沙箱设置失败** | Codex 按 `dirname(CODEX_CLI_PATH)` 解析三个辅助程序,bridge 目录里没有它们 |
| **第三方模型无法作为子代理** | Codex 用模型目录中的 `multi_agent_version` 决定 `spawn_agent` 资格,而这个字段从未被写入 |
| **官方模型在子代理路径被误拒** | 已算出的 `nativePassthroughTurn` 未被采纳,官方模型新建 Session 会返回 400 |
| **网关生命周期竞争** | 抢端口失败的实例会清除健康实例的环境变量,导致 Desktop 静默退回原生 |
| **删除服务商残留密钥** | 密钥留在系统密钥库中,且配置里已无引用可清理 |

TOML 转义修复与平台无关,已提交给上游项目:[AITabby/codexsplit#37](https://github.com/AITabby/codexsplit/pull/37)。

## 配置

`opencodex.env` 与可执行文件同目录,启动时读取,每行一条 `KEY=VALUE`:

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `OPENCODEX_AGENT_MESSAGE_ORACLE` | **开启** | 恢复加密的子代理任务载荷(见下)。**关掉它,第三方子代理就完全不可用** |
| `OPENCODEX_AGENT_MESSAGE_ORACLE_MODEL` | `gpt-5.6-sol` | 用于提取的模型 |
| `OPENCODEX_AGENT_MESSAGE_ORACLE_TIMEOUT_MS` | `60000` | 提取超时 |
| `OPENCODEX_PORT` | `8765` | 网关端口。**不设**时,若 8765 已被**别的程序**占用,网关会自动顺延到下一个空闲端口(最多试 10 个)并把新端口写进 Codex 配置;**显式设置**时端口被占用会直接报错而不是偷偷换。若占用者是**另一个 OpenCodex 实例**,则一律拒绝启动、不顺延 —— 两个实例会争抢注册表与 Codex 配置,顺延只会得到两个互相打架的网关 |
| `OPENCODEX_WINDOWS_LAUNCH_MODE` | `shell` | `direct` 绕过 shell 激活启动 Desktop |
| `OPENCODEX_MULTI_AGENT_VERSION` | `v2` | 写入模型目录的多 Agent 协议版本 |
| `OPENCODEX_NATIVE_EGRESS` | `1` | 官方模型流量是否经过本项目的路由代理。见下 |
| `OPENCODEX_DEBUG_REQUEST_DUMP` | 关闭 | 记录发往服务商请求的目录(诊断用) |

### 固定某个模型的推理档位

`~/.opencodex/providers.json` 里每个模型的 `model_metadata` 支持两个字段:

| 字段 | 作用 |
| --- | --- |
| `default_reasoning_level` | 目录默认档位;只在请求**没带**推理档位时填补 |
| `min_reasoning_level` | 下限;请求带了更低的档位也会被抬上来 |

```json
"model_metadata": {
  "deepseek-v4-flash": { "default_reasoning_level": "max", "min_reasoning_level": "max" }
}
```

第三方模型往往比官方便宜得多,而 Desktop 会把上一个模型的档位带到新模型上,只设默认值挡不住。下限只在模型自己声明支持该档位时生效,且不会把更深的档位(如 `ultra`)拉回来。改完重启网关。

### 官方模型线路(重要)

Codex 启动原生 app-server 时,本项目默认会把它的  改写到 bridge 的本地出口路由器 —— **官方 GPT 的流量也会穿过我们的进程**,然后原样转发到 chatgpt.com(凭据仍是原生 Codex 会话,不涉及任何第三方 Key)。

这么做的唯一原因:只有看得到请求,才能把 **Codex 派生的子代理**改派给第三方模型。

代价是爆炸半径:本项目出故障时,官方模型会跟着受影响。

控制台官方模型线路里的开关可以关掉它(等价于 ):

| | 开启(默认) | 关闭 |
| --- | --- | --- |
| 官方模型 | 经过本项目 | **直连 ChatGPT,不受本项目任何故障影响** |
| 第三方模型作主会话 | 可用 | 可用 |
| 第三方模型作子代理 | 可用 | **不可用** |

改动后需重启 Codex Desktop。

### 出问题时怎么退出

控制台顶栏的 **脱离 OpenCodex** 会注销 、移除托管配置并重启 Desktop,让 Codex 立刻回到原生状态(凭据与模型都保留)。

如果网关或 bridge 已经坏到打不开控制台,用安装目录里的 **** —— 它不依赖本项目的任何进程,直接清理注册表项和配置。

## 已知限制

**子代理任务载荷是加密的。** Codex 多 Agent v2 把子代理的任务放在 `agent_message` 的 `encrypted_content` 中,那是给 ChatGPT 后端解密的 Fernet token,第三方模型收到的是一段读不懂的密文,因而报告"没有收到任务"。这不是路由缺陷:

- [openai/codex#32031](https://github.com/openai/codex/issues/32031)
- [lidge-jun/opencodex#92](https://github.com/lidge-jun/opencodex/issues/92) —— 同一问题的详细分析,至今开放

`OPENCODEX_AGENT_MESSAGE_ORACLE=1` 提供了一条恢复路径(技术方案由 [@Joseffb](https://github.com/Joseffb) 在 [lidge-jun/opencodex#92](https://github.com/lidge-jun/opencodex/issues/92) 中公开):把信封用**你自己的 Codex 凭据**发回 ChatGPT,配合一次强制函数调用,由后端解密自己的密文并把明文作为函数参数返回,再转成标准输入交给第三方模型。**代价是每个不同任务多一次 ChatGPT 请求**,且依赖未公开的内部格式。

**这一项默认开启**,因为关掉它第三方子代理就完全不可用 —— 该轮次会明确失败(`unreadable_encrypted_agent_task`),而不是让子代理拿着空任务运行。如果你宁可让第三方子代理失败也不想多花那次请求,在 `opencodex.env` 里把该行注释掉即可。

**其他:**

- 这是**便携目录,不是安装程序**。
- 只在 Windows 11 + 新版统一 ChatGPT Desktop(MSIX 包 `OpenAI.Codex`)上验证过。
- `deepseek-v4-pro` 目前会被 DeepSeek 服务端拒绝(提示 Codex 集成尚未开放),与本项目无关。因此它**不在默认预设里**;等 DeepSeek 开放后手动添加即可。
- 代码里保留了 macOS 平台层,但没有在 macOS 上回归测试过。

## 从源码构建

运行发行包**不需要系统级 Node** —— 启动器先找 `OpenCodex.exe` 旁边的 `node.exe`,找不到就用 Codex Desktop 自带的 `%LOCALAPPDATA%\OpenAI\Codex\bin\node.exe`。

从源码构建则需要 Node.js 22.19+、npm,以及 [Rust](https://rustup.rs)(用于两个可执行文件):

```bash
npm install
npm run build:windows      # 编译网关 + bridge shim + 启动器
npm run package:windows    # 生成 build/OpenCodex-win-x64 和 zip
```

```bash
npm test                   # 全量测试
```

当前:**173 通过 / 0 失败**。

### 主要文件

| 路径 | 作用 |
| --- | --- |
| `src_v2/codex-provider-bridge.ts` | Codex Desktop 里的分流器:官方走原生,第三方走网关 |
| `src_v2/server/gateway.ts` | 本地网关与控制台 API |
| `src_v2/server/router.ts` | provider 请求、流式转换、子代理调度 |
| `src_v2/platform/win32.ts` | Windows Desktop 控制器 |
| `src_v2/platform/secrets.ts` | DPAPI 凭据存储 |
| `src_v2/services/catalog_sync.ts` | 模型目录生成与同步 |
| `src_v2/services/agent_message_oracle.ts` | 子代理加密载荷恢复 |
| `native/windows-bridge-launcher/` | Rust bridge shim |
| `native/windows-launcher/` | Rust 应用启动器(`OpenCodex.exe`) |

## 项目历史

本项目起源于 [AITabby/opencodex](https://github.com/AITabby/codexsplit)(现已更名 CodexSplit)的一个 Fork,补上了上游公开仓库里完全缺失的 Windows 平台层。

自 v1.2.0 起独立演进,并做了一次大幅精简:语音编排、GPT-Live、其他 CLI 的订阅导入(Cursor / Claude / Grok / Antigravity)、子代理决策路由、iOS 伴侣应用、macOS 应用外壳全部物理删除,代码量从 61,000 行降到约 18,000 行,打包体积从 166 MB 降到 3.1 MB(zip 1.1 MB),运行时依赖从 7 个减到 1 个。改造过程、每期的取舍与风险记录在 [docs/SLIM_PLAN.md](docs/SLIM_PLAN.md);改造前的完整状态保留在 `pre-slim` tag 与 `archive/upstream-features` 分支。

## 致谢

- [AITabby/codexsplit](https://github.com/AITabby/codexsplit) —— 起源项目与 provider split 架构
- [lidge-jun/opencodex](https://github.com/lidge-jun/opencodex) —— 子代理加密问题的分析来源
- [@Joseffb](https://github.com/Joseffb/codex-deepseek-shim) —— 加密载荷恢复方案

## License

MIT

---

## English

Makes Codex Desktop on **Windows 11** use third-party models alongside official GPT: official models stay on the native ChatGPT/Codex route, third-party models are routed through a local gateway.

Codex resolves its app-server from `CODEX_CLI_PATH` and spawns it **without a shell**, so the interception point has to be a real PE executable — this ships a ~200KB dependency-free Rust shim for that, registers the variable through `HKCU\Environment` with a `WM_SETTINGCHANGE` broadcast, discovers the MSIX package, and stores credentials with DPAPI.

It also fixes a bug that breaks Codex for **every** Windows user: the model catalog path was written into a TOML basic string, so `\U` in `C:\Users\...` made the entire `config.toml` unparseable. Submitted upstream as [#37](https://github.com/AITabby/codexsplit/pull/37).

**Install:** download the zip from [Releases](https://github.com/pavlov-asuka/opencodex/releases/latest), extract, run `OpenCodex.exe`. Node.js is not required.

**Scope:** this project routes third-party models into Codex and nothing else. Voice orchestration, GPT-Live, subscription imports from other CLIs, the subagent routing policy engine, and the iOS/macOS clients were all removed — see [docs/SLIM_PLAN.md](docs/SLIM_PLAN.md).

**Known limitation:** multi-agent v2 delivers a subagent's task inside an `encrypted_content` block readable only by the ChatGPT backend, so third-party children receive an empty task ([openai/codex#32031](https://github.com/openai/codex/issues/32031)). Set `OPENCODEX_AGENT_MESSAGE_ORACLE=1` to recover it through your own Codex credentials, at the cost of one extra ChatGPT request per task.

Tests: 173 passing.
