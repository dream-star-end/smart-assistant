# OCV5-415 Google Antigravity CLI 接入：调研结论与方案

2026-10-14 CST，cc3 会话（Claude Code account3）。个人版 `feat/v5-selfhost` 先行，商业版之后走两树同步。

**P1（第 1–5 节）没有登录任何 Google 账号，也没有使用任何真实 key；第 6–7 节的 P2 结论用用户确认的个人订阅账号实测。** P1 时 下面的「实测」都是在本机隔离 HOME 里跑官方二进制得到的：凭据是假 key，Gemini API 指向 loopback mock，没有调用付费接口。来源分三类：「实测」、「官方文档」、「二手/未核实」。

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

## 6. 用户决定（2026-10-14）

用户原话：「走个人订阅，遥测不拦，其它按推荐」，并明确知道并接受第 3 节的条款与封号风险；之后又定了「按推荐开放模型，开始第二阶段」。

- **D1 凭据**：个人订阅 Google 账号 OAuth（当前账号 d1193355375@gmail.com，Google AI Pro）。§3「个人订阅 OAuth 一律不接」的结论由用户决定推翻，风险由用户承担。
- **D2 账号主体**：上面这个个人订阅账号；没有 Cloud 项目，没有单独预算上限，按平台积分对用户扣费。
- **D3 模型和价格**：上线前实测账号只给 3.8 Flash 三档、Claude Sonnet 4.6、Claude Opus 4.6 Thinking、GPT-OSS 120B，**没有 3.1 Pro**。
  - `antigravity-gemini-3.8-flash`（low/medium/high）对所有用户公开：价格同 Cursor Gemini 3.8 Flash（120/150/5 分每百万，×1）。
  - `antigravity-claude-sonnet-4.6`（同 CCB Sonnet 4.6，150/750/15，×2）、`antigravity-claude-opus-4.6`（同 Opus 4.7，250/1250/25，×2）、`antigravity-gpt-oss-120b`（同 Flash）只给管理员。
- **D4 遥测**：不拦。容器里的 CLI 仍会直连 play.googleapis.com、antigravity-unleash.goog、aicode.googleapis.com、lh3.googleusercontent.com、www.googleapis.com（userinfo）。
- **D5 镜像**：接受 runtime 镜像约 +215 MB。

## 7. 方案（P2，个人版）

账号模式实测（v5-dev，2026-10-14）：

- `CLOUD_CODE_URL=<url>` 把 CLI 的**全部** `/v1internal:*` 调用改到这个地址，**保留路径前缀**。上游必须是 `daily-cloudcode-pa.googleapis.com`（`cloudcode-pa` 对这个 client 返回 429）。
- CLI 启动时的资格检查直连 `www.googleapis.com` 的 userinfo，所以 CLI 需要一个真的 Google token。用同一个 refresh token 以 `openid userinfo.email userinfo.profile` 换出的**受限令牌**就够：它调不了 Cloud Code。CLI 拿受限令牌、relay 换上全权限令牌，实测 6 个模型都通。
- 每次 HOME 只需要 `.gemini/antigravity-cli/antigravity-oauth-token`；数据共享开关在 Google 服务端（登录时已关），print 模式不需要 onboarding。
- 上游请求体的 `model` 就是 CLI 的模型 id；标题生成是 `gemini-3.5-flash-lite`（`requestType: checkpoint`）。

数据流：

1. **账号**：`gemini_oauth_accounts`（0307），refresh/access token 用 `loadKmsKey` AES-GCM 加密。接入走管理接口 `POST /api/admin/antigravity-accounts/auth/start|complete`（PKCE，与 CLI 同一个同意页），或运维脚本 `packages/commercial/scripts/antigravity-import-account.ts`（导入宿主机上已登录 CLI 的 token 文件）。client secret 是 1.3.4 二进制内嵌的 installed-app secret，放在 master/egress env `OC_ANTIGRAVITY_OAUTH_CLIENT_SECRET`。
2. **准入**（master，userChatBridge）：authority 必须是 `antigravity` 引擎 → 余额 > 0 → 选账号 → 签受限令牌 → 签 route（Redis，只存 token 的 sha256；绑定容器/用户/requestId/模型/账号/准入预算）→ 帧里带 `__oc_antigravity_route {baseUrl, routeToken, accessToken, accessTokenExpiresAt, idToken?}`，客户端同名字段一律剥掉。
3. **容器**（gateway）：`_buildSafeAntigravityRouteOverride` 逐字段校验 → adapter 把受限令牌写进本次 HOME 的 token 文件（0600，refresh_token 为空），设 `CLOUD_CODE_URL=<route>`。CLI 的请求打到 gateway 的 loopback relay，去掉 CLI 的 Authorization / x-goog-api-key / cookie，换成容器 token 转给 master/egress。
4. **relay**（`internalAntigravityRelay`，master 与 egress 都挂）：校验容器身份和 route；只放行 CLI 实际调用的 8 个方法；生成调用只放行该模型的 CLI id 和标题模型；按已计量费用 ≥ 准入预算时拒绝新调用（402）；注入账号全权限令牌转给 daily-cloudcode-pa；流结束前把 `usageMetadata` 写进 `antigravity_relay_usage`。
5. **结算**：adapter 只发状态（`external_billing`，engine=antigravity）。bridge 收到后按 `(request_id, user_id)` 汇总 relay 记的用量，按回合模型的目录价结算（`settleUsageAndLedger`，`usage_records` 唯一键保证幂等）；非 success 或无输出不扣（预算触顶按 success 结算已用部分）。
6. **账号调度**：与 OCV5-424 约定，账号池的统一调度策略由 424 实现。在那之前用 `account-pool/antigravityPoolInterim.ts`（`TODO(OCV5-424)`，数值与 424 的 DEFAULT_POLICY 一致）：429 按 Retry-After 冷却（15 秒到 15 分钟），认证失败按 5 分钟×2^n 冷却（上限 6 小时），从不写 `disabled`，冷却到期自动半开，没有自己的定时器。**必做后续**：424 合入后改成 `classifyHttpOutcome + decide`，并在 registry 注册 `probe = refresh 成功`。
7. **镜像**：`OC_INCLUDE_ANTIGRAVITY=1`（`deploy/v5-selfhost/runtime-build.env`）把钉死 sha512 的 1.3.4 装到 `/usr/local/bin/antigravity`，放在 base 阶段末尾，不使上面的大层缓存失效。

已知缺口：

- 回合结束前桥断开（浏览器关闭、master 重启），relay 已记的用量不会结算，路由也只在清理时失效。与 zcode 现状相同；补一个按 `antigravity_relay_usage` 找未结算 requestId 的对账任务列为后续。
- 一个回合内所有调用（含标题）按回合模型的价格计。
- 受限令牌在容器里可被 yolo 工具读到，只能读账号的邮箱和头像；CLI 在回合中途若重新做资格检查且令牌已过期（签发时保证 ≥20 分钟余量），回合会以认证失败结束。
- 迁移 0307 扩 `model_catalog` 的 engine CHECK（先 DROP 再 ADD），按个人版迁移门属于破坏性 DDL，发布需要 `OC_V5_ALLOW_BREAKING_MIGRATION=1` 或发布前人工 apply，并需要用户批准。

## 8. 证据

- 夹具：`packages/gateway/src/__tests__/fixtures/antigravity/*.ndjson`。全部来自 1.3.4 的真实输出，路径已替换成 `/work`。
- 交接目录 `$H/g415-*`：调研日志、mock 脚本、`--help`。
