# OCV5-415 Google Antigravity CLI 接入：调研结论与方案

2026-10-14 CST，cc3 会话（Claude Code account3）。个人版 `feat/v5-selfhost` 先行，商业版之后走两树同步。

**本轮没有登录任何 Google 账号，也没有使用任何真实 key。** 下面的「实测」都是在本机隔离 HOME 里跑官方二进制得到的：凭据是假 key，Gemini API 指向 loopback mock，没有调用付费接口。来源分三类：「实测」、「官方文档」、「二手/未核实」。

## 1. 它是什么

- Google Antigravity CLI，二进制名 `antigravity`（文档里的别名是 `agy`），是 Gemini CLI 的官方继任者。2026-06-18 起，Gemini CLI 不再服务 AI Pro/Ultra 订阅用户。闭源，GitHub 上只有 README 和 CHANGELOG。
- 版本：1.3.4，10-13 发布。

## 2. 安装与钉版本（实测）

- 官方安装脚本：`curl -fsSL https://antigravity.google/cli/install.sh | bash`。它的流程是先取 manifest，按 sha512 校验，再把二进制解到 `~/.local/bin`。
- 不跑脚本也可以钉版本：
  - manifest：`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json`
  - 1.3.4 包：`https://storage.googleapis.com/antigravity-public/antigravity-cli/1.3.4-5524158944247808/linux-x64/cli_linux_x64.tar.gz`
  - sha512：`dbdacfc5a1d9874fbbea3a21026d3990b4728e2e3487fd0316dc53cae9a3091023f969425828f3e2e0fadda43cea07dd978ea96f4ca7c202adf2201f419c56dd`
- 包内只有一个文件 `antigravity`，静态 ELF，大小 214,745,296 字节。不依赖 Node。另有 musl 和 arm64 版本。
- 首次运行时，会在 `$HOME/.gemini/antigravity-cli/bin/` 解出一个 16 MB 的 `webm_encoder` 和一个 `agentapi`。
- 关闭自动更新：设 `AGY_CLI_DISABLE_AUTO_UPDATE=true`。
- 版本号：`antigravity --version` 输出 `1.3.4`，不需要 TTY。

## 3. 鉴权

| 方式 | 实测/来源 | 能否用 relay 隔离凭据 | 条款 |
|---|---|---|---|
| Google 账号 OAuth（AI Pro/Ultra 等个人订阅） | 实测：无凭据时 `-p` 会打印 OAuth URL 并**阻塞 60 秒**，然后退出 | 否 | **禁止**，见下 |
| `GEMINI_API_KEY` + `settings.json {"modelProvider":"gemini"}` | 实测：所有模型请求都打到 `GOOGLE_GEMINI_BASE_URL`；base URL 带路径前缀时，CLI 在前缀后接 `/v1beta/models/<m>:streamGenerateContent?alt=sse`；key 放在 `x-goog-api-key` 头 | **能** | 普通 AI Studio key **不在**条款豁免名单内 |
| Enterprise ADC（`AGY_ADC_AUTH=true` + 服务账号） | 实测：CLI 会用我们指定的 token_uri 换 token，但随后**直连 Google**，不认 base URL | **不能**：要么真 token 进用户容器，要么不支持 | 豁免 |
| Gemini Enterprise API Key | 未实测，需要真 key | 未知 | 豁免 |

- **条款**（antigravity.google/terms，本人 10-14 01:4x 读取，页面无日期）
  - 第 6 节：「using the Service in connection with products not provided by us」属于违约，并举例「using third party software… (e.g. using OpenClaw with Antigravity OAuth)」，后果可能是封禁 Antigravity 及 Gemini CLI 账号。
  - 前言：只有通过 Gemini Enterprise（Google Cloud）、Gemini Enterprise for Business、Google Workspace 订阅，或 **Gemini Enterprise API Key** 访问时，这份条款才不适用。
  - 结论：
    - 个人订阅 OAuth 一律不接。
    - 普通 Gemini API key 仍受这份条款约束，有被认定为「与非 Google 产品一起使用」的风险。
- 凭据和配置目录固定在 `$HOME/.gemini/`，没有类似 `CODEX_HOME` 的环境变量。隔离做法是每次启动给一个独立的 HOME。
- 实测：CLI 会改写 `settings.json`，保留未知键和 `permissions`，但删掉了二手资料里的 `enableTelemetry` 键。因此**遥测怎么关目前未核实**。

## 4. 非交互契约（实测，1.3.4）

- 关键 flag：`--input-format stream-json --output-format stream-json --model <id> --dangerously-skip-permissions --disable-slash-commands [--conversation <uuid>]`。没有 `--cwd`、prompt 文件或 system prompt 相关的 flag。`--print-timeout` 默认是 0。
- **prompt 走 stdin**，形如 `{"event":"user","message":{"content":"..."}}`，一行一条。收到 `result` 后关闭 stdin，CLI 退出。argv 有约 128 KB 的上限，而且在 ps 里可见。
  - 350 KB 正常。
  - **1.1 MB 时返回 SUCCESS 但回复为空**，stderr 只有一句 "run ended with no output"。adapter 设上限 300 KB，并把这种情况判为失败。
- **模型 id**（API-key 模式下的 `agy models`）：
  - `gemini-3.8|3.7|3.6-flash-{low,medium,high}`、`gemini-3.1-pro-{low,high}`。
  - Claude 和 GPT-OSS 只在 OAuth 订阅下才有。
  - 上游实际请求的模型名：Pro 是 `gemini-3.1-pro-preview` 或 `…-customtools`，Flash 是 `gemini-3.8-flash`；thinkingBudget 分别为 low 1024/1000、medium 4000、high -1。
  - 每个新会话还会额外调一次 `gemini-3.1-flash-lite-preview` 生成标题。
  - `--effort` 配合 family id 时一律取最高档，所以 adapter 直接用显式 id。
- **stream-json 事件**：
  - `init`：含 conversation_id、tools[60]、permission_mode。
  - `step_update`：`step_type` 取值为 user_input / agent_response / tool / system_message / error_message / unknown（`ask_question` 就落在这里，对用户不可见）。
  - `result`：status 取值 SUCCESS / ERROR / CANCELED / …。
- **文本**：`agent_response.text_delta` 是**真增量**，逐块实时流出。**thinking 的正文不会出现在 stream 里**，只给 thinking_tokens 计数。
- **工具**：先发 ACTIVE（带 `tool_info.parameters`，CLI 已精简过），再发 DONE（带 output）或 ERROR（带 `error{type,message}`）。
  - `write_to_file` 不带内容，`view_file` 的 output 只是一句摘要。
  - **soft-deny 的表现是 DONE、无 output、exit 0，只在 stderr 提示**，所以必须靠 stderr 识别。
  - MCP 工具是懒加载的，统一经 `call_mcp_tool{ServerName,ToolName,Arguments}` 调用。
  - MCP 配置只读 `$HOME/.gemini/config/mcp_config.json`，格式是 `{"mcpServers":{name:{command,args,env}}}`，`agy mcp list` 已验证。
- **续聊**：每个会话一个 SQLite 文件 `conversations/<uuid>.db`。只要把这个目录软链到稳定位置，跨 HOME 用 `--conversation` 也能续上。
- **退出码**：成功 0（soft-deny 和空回复也是 0），上游出错 3，未知模型 1，stream 输入里带 slash command 是 2。
- 宿主机上 CLI 报过 inotify `too many open files`，只是警告。

## 5. 计费口径（实测）

- `step_update.usage` 是单次调用的值：`input_tokens = promptTokenCount − cachedContentTokenCount`，`output_tokens = candidates + thoughts`。
- `result.usage` 的问题：
  1. **不含标题生成那次调用**；
  2. 用 `--conversation` 续聊时是**整个对话的累计值**。
- 结论：计费不能用 CLI 自报的数，只能在 relay 侧按上游 SSE 的 `usageMetadata` 逐次计量（zcode 的 external 模式），并且白名单要包括标题调用的模型。

## 6. 方案

和 zcode、grok 同构：每轮起一个官方 CLI 进程，跑在用户容器里；凭据只在 egress 上；容器拿到的是一次性的不透明 route token。

- **P1（本 PR，个人版，不需要凭据）**：引擎骨架，隐藏且 fail-closed。
  - protocol：模型表 `antigravity-gemini-3.1-pro` 和 `antigravity-gemini-3.8-flash`（实验，不公开）、CLI id 与上游白名单的映射；authority 和 goalState 的 engine union 加上 `antigravity`。
  - gateway：
    - `antigravityAdapter`：stdin 输入、流解析、工具映射、soft-deny 和空回复判失败、OAuth 回退时立即杀进程、prompt 上限、只在成功时提交续聊 id、usage 按步骤累加。
    - `antigravityPlatform`：每次启动独立 HOME，conversations 和 bin 共享，settings 和 MCP 配置 0600。
    - 同时改了 registry、resumeArtifacts、catalogClient 和 server/sessionManager 的 union。
  - **没有 route 就不启动**。模型 id 不在 `ALLOWED_INBOUND_MODELS` 里，没有目录行，master 也不会签发 antigravity 的 authority，所以上线后用户侧不可达。
  - 测试用实测录下的 NDJSON 夹具回放。
- **P2（个人版）**：Gemini relay 加计量。
  - 网关侧 loopback `/internal/v5/antigravity-relay/route/<token>`，经 master/egress 转发。
  - egress 只放行 `antigravityAllowedUpstreamModels`，换成真 key，按 `usageMetadata` 逐次写 external billing（参照 zcode 的 `internalZcodeRelay`、`zcodeCatalogSettle`）。
  - bridge 下发 route，`OutboundExternalEngineBilling.engine` 加 `antigravity`，加 catalog engine CHECK 迁移和 staged 目录行。
  - **具体走哪种上游协议取决于下面的 D1。**
- **P3（需要凭据和用户拍板）**：
  - runtime 镜像按上面的 URL 和 sha512 装 1.3.4，并预解出 bin，镜像约增加 230 MB。v5-dev 根分区已用 95%。
  - 目录行加价格行，激活后用真实多轮 canary 和扣费对账。
  - 遥测和出网核对：看 CLI 在容器里除了 relay 之外还会连哪些地址。

## 7. 需要用户决定和提供的

- **D1 凭据路线**（决定 P2 relay 的协议）：
  - 推荐 **Gemini Enterprise API Key**：条款豁免，但需要先用真 key 验证它能走 `modelProvider:gemini` 加 base URL。
  - 次选普通 Gemini API 付费 key：已实测可以经 relay，但 Antigravity 条款仍然适用，有封号风险，需要你明确接受。
  - Vertex/Enterprise ADC：除非接受把短期的 cloud-platform token 放进用户容器（yolo 工具能读到，作用域是整个项目），否则不能用，不推荐。
  - 个人 Google 订阅 OAuth：条款禁止，不接。
- **D2 账号和计费主体**：用哪个 Google Cloud 项目或付费账户，预算上限多少。
- **D3 模型和价格**：上哪几个模型（当前是 3.1 Pro 和 3.8 Flash）、价格（积分/百万 token）、是否像 Grok 一样先只给管理员。
- **D4 遥测**：是否要求容器层面封掉 CLI 直连 Google 的遥测出网。
- **D5 镜像体积**：runtime 镜像约 +230 MB，可以接受吗？

## 8. 证据

- 夹具：`packages/gateway/src/__tests__/fixtures/antigravity/*.ndjson`。全部来自 1.3.4 的真实输出，路径已替换成 `/work`。
- 交接目录 `$H/g415-*`：调研日志、mock 脚本、`--help`。
