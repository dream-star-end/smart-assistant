# config 配置子系统全栈深审（阶段 A）· storage ↔ protocol ↔ gateway ↔ cli ↔ web-react

> 任务：t-1698「A·config 配置子系统全栈深审」· 协同组「v5个人版的记忆、skills、配置审查」· 指挥官 fable-5-1-36
> 基线 `aeae1d72ee8fa01475eebf016278841c96b91056` · 分支 `feat/v5-selfhost-msc-config` · 工作树 `wt/msc-config`
> 审计人：fable-5-1-38 · 日期 2026-09-18 · 口径 `TEAM_PLAYBOOK_MSC.md` §4.3 文件清单 + §5 八项清单
> 严重度：P1 数据丢失/损坏/安全/不可用 · P2 常见路径错误/契约不一致/静默失败/明显性能 · P3 健壮性/测试补齐/默认值打磨
> **阶段 A 未改任何业务代码**。本分支只新增本文档 + 2 个纯测试文件（7 用例，5 红灯标 `TODO(msc-config)`，2 绿灯回归锁）。
> 行号以基线为准；`server.ts` / `lib/api.ts` 是共享文件（§4.4），本轮只读。

## 1. 范围与文件清单（含行数）

| 层 | 文件（前缀 `v5-selfhost/`） | 行数 | 本轮关注点 |
|---|---|---|---|
| storage | `packages/storage/src/config.ts` | 247 | `OpenClaudeConfig` / `AgentsConfig` 类型、`readConfig` / `writeConfig` / `readAgentsConfig` / `updateAgentsConfig` |
| storage | `packages/storage/src/paths.ts` | 168 | `OPENCLAUDE_HOME` 与全部路径常量 |
| storage | `packages/storage/src/credentials.ts` | 26 | 渠道凭据文件读写 |
| storage | `packages/storage/src/identityCompatAssets.ts` | 267 | 身份兼容 profile 对本地 agents.yaml / openclaude.json 的一致性校验 |
| storage | `packages/storage/src/identityCompatRuntime.ts` | 52 | master 投影拉取 + 执行身份解析 |
| protocol | `packages/protocol/src/collaboration.ts` | 37 | collabMode 词汇 / 归一 / configVersion |
| protocol | `packages/protocol/src/identityCompat.ts` | 81 | 投影 wire 校验（`parseIdentityCompatProjection`） |
| protocol | `packages/protocol/src/modelAuthority.ts` | 812 | 签名执行描述符编解码 / 验签 / keyring env 解析 |
| protocol | `packages/protocol/src/staticKeyProviders.ts` | 426 | 静态 key provider 注册表（纯数据） |
| gateway | `packages/gateway/src/index.ts` | 118 | 仅 re-export（**启动时的配置加载不在这里**，在 `cli/src/commands/gateway.ts` + `server.ts` 构造器） |
| gateway | `packages/gateway/src/gatewayBind.ts` | 39 | `OPENCLAUDE_GATEWAY_BIND/PORT` 覆盖 |
| gateway | `packages/gateway/src/envProbe.ts` | 369 | 环境事实探针（`OC_USER_TZ` 等 env 清洗） |
| gateway | `packages/gateway/src/codexLaunchOverrides.ts` | 502 | codex 子进程 `-c` 覆盖（gateway token 落文件不进 argv） |
| gateway | `packages/gateway/src/efficiencyHookConfig.ts` | 78 | 引擎 hooks 配置文件原子写 |
| gateway | `packages/gateway/src/advisorConfigStore.ts` | 316 | `collaboration-config.json` CAS 存储 |
| gateway | `packages/gateway/src/hostStaticProviders.ts` | 144 | host 静态 provider key seam |
| gateway | `packages/gateway/src/bridgeApiAllowlist.ts` | 518 | bridge 绕过 token 的路由白名单 |
| gateway | `packages/gateway/src/collaboratorAgents.ts` | 37 | 可协作 agent 过滤 |
| gateway | `packages/gateway/src/teamMode.ts` | 365 | 团队模式纯逻辑（无配置读写） |
| gateway | `packages/gateway/src/modelAuthority.ts` | 575 | 容器侧验签消费（`OC_MODEL_AUTHORITY*` env） |
| gateway | `packages/gateway/src/pathAcl.ts` | 69 | 路径包含判定 |
| gateway | `packages/gateway/src/localBridgeAuth.ts` | 70 | `OPENCLAUDE_LOCAL_BRIDGE_TOKEN` 回环鉴权 |
| gateway | `packages/gateway/src/auth.ts` | 67 | accessToken 比对 / scrypt / HS256 JWT |
| gateway（共享） | `packages/gateway/src/server.ts` | 23314 | 只看：构造器 2819-2923、`_getAgentsConfig` 2637-2679、登录/鉴权 4120-4191 & 6635-6716 & 7478-7488 & 7682-7720、`/api/config` 5964-5992、`/api/agents*` 5993-6010 & 8685-8853、`/api/collaboration-config` 6254-6257 & 13526-13680、OAuth 落盘 17066-17083 & 17168-17186、`/api/file` cwd 白名单 7896-7898 & 8099-8101、`createGateway` 24032-24037 |
| cli | `packages/cli/src/commands/onboard.ts` | 111 | 首次写出 openclaude.json / agents.yaml |
| cli | `packages/cli/src/commands/doctor.ts` | 123 | 读回诊断 |
| cli | `packages/cli/src/commands/gateway.ts` | 206 | **gateway 进程的配置加载入口** |
| cli | `packages/cli/src/commands/agents.ts` | 31 | agents.yaml 增删（CLI 面） |
| web | `src/components/SettingsCenter.tsx` | 623 | 偏好加载/patch 的状态持有者 |
| web | `src/components/ProjectSettingsDialog.tsx` | 452 | 项目设置（看板绑定 + 指令两阶段保存） |
| web | `src/components/settings/PreferencesTab.tsx` | 459 | 主题 / 默认模型 / effort / 通知 / Auto-Dream |
| web | `src/components/settings/AccountTab.tsx` | 568 | 账户（commercial 数据面，只审状态机） |
| web | `src/components/settings/ApiAccessTab.tsx` | 847 | admin API key（commercial 数据面，只审状态机） |
| web | `src/lib/collaborationConfig.ts` | 175 | 协作配置 wire 类型 + UI helper |
| web | `src/lib/modelPreferences.ts` | 123 | 偏好快照解析 / 默认模型解析 |
| web | `src/lib/productCapabilities.ts` | 343 | 能力注册表（纯数据，无问题） |
| web | `src/lib/identityCompat.ts` | 29 | 身份兼容投影读取 |
| web | `src/lib/teamMode.ts` | 58 | 团队模式 localStorage 持久化 |
| web（共享） | `src/lib/api.ts` | 4591 | 只看：登录 1111-1161、`getPreferences/patchPreferences` 1336-1342 & 1407-1418、`get/putCollaborationConfig` 1344-1405、agents 段 2799-3010 |

**不在 gateway 实现的路由**：`/api/me/preferences` 在 gateway 内 **无实现**（`rg '/api/me' server.ts` 零命中），它由 commercial master 提供；web-react 的 `api.getPreferences/patchPreferences` 直接打 master。本文只审其 web 消费侧。同理 web-react 的 `/api/auth/login` 契约（`{email,password}` → `{access_token,...}`，api.ts:1119-1161）是 master 契约，与 gateway 自带的 `{username,password}` → `{token}`（server.ts:4139-4165）**不是同一个协议**——selfhost 部署走 `COMMERCIAL_ENABLED=1` 由 commercial 先接管（server.ts:3941-3949），gateway 的多用户登录只在纯个人版路径可达。

## 2. 架构与数据流速写

```
                 写                                                  读
openclaude onboard ──writeConfig(整文件覆盖)──▶ ~/.openclaude/openclaude.json ◀── cli/gateway.ts:99 readConfig()（启动，只判 null）
gateway OAuth 回调/刷新 ──readConfig→改→writeConfig──▶      │                       ├─ Gateway 构造器：SessionManager(config)、outboundRing
   (server.ts:17067-17080 / 17169-17180，≤10min 一次)      │                       ├─ /api/config 投影（5964-5992，脱敏后返回）
                                                            │                       └─ doctor 读回诊断
onboard / CLI agents add / POST|PUT|DELETE /api/agents /   │
marketplace sync（memory/skills owner 的 storage 代码）──updateAgentsConfig(锁+tmp+rename)──▶ ~/.openclaude/agents.yaml
                                                            ├─ _getAgentsConfig()（mtime 缓存，枚举面：GET /api/agents、/v1/models、技能作用域）
                                                            ├─ deps.agentsConfig（构造快照；Router、/v1/chat、/api/file cwd 白名单；仅 API 写回时替换）
                                                            └─ readAgentsConfig()（直读：GET /api/agents/:id、persona、sessionManager 建会话）
PUT /api/collaboration-config ──AdvisorConfigStore.mutate(锁+CAS rev+tmp+rename)──▶ ~/.openclaude/collaboration-config.json ◀── GET 同路由每次直读
web PreferencesTab ──PATCH /api/me/preferences(master)──▶ PG user_preferences ◀── SettingsCenter 一次性 GET
web teamMode ──localStorage oc_v5_team_mode[:sid]（纯前端，turn 帧 teamMode/collabMode 字段）
env：OPENCLAUDE_HOME(paths.ts:4) · OPENCLAUDE_GATEWAY_BIND/PORT(gatewayBind) · OPENCLAUDE_LOCAL_BRIDGE_TOKEN · OC_MODEL_AUTHORITY(_KEYRING) ·
     OC_SELFHOST_ENGINE_LOCAL_TURNS · OC_USER_ID/OC_CONTAINER_ID/OC_BRIDGE_NONCE/OPENCLAUDE_TRUST_BRIDGE_IP · OPENCLAUDE_V3_MASTER_BASE_URL/CONTAINER_TOKEN
```

契约定义位置：`OpenClaudeConfig` / `AgentDef` / `AgentsConfig` 只有 TS 类型（config.ts:45-186），**没有运行时 schema**；`CollaborationConfigDoc` 有完整运行时校验（advisorConfigStore.ts:66-143）；`IdentityCompatProjection` 有运行时校验（protocol/identityCompat.ts:41-65）；`ModelAuthorityPayload` 有严格形状 + 未知字段拒绝（protocol/modelAuthority.ts:703-882）。前端 wire 类型：`lib/collaborationConfig.ts:18-29` 与 `lib/api.ts:1345-1361` 各写一份。

### 2.1 配置项总表（字段 / 权威源 / 默认值 / 谁读 / 谁写 / 敏感 / 热更新）

**openclaude.json**（`paths.config`）

| 字段 | 权威源 | 默认值 | 谁读 | 谁写 | 敏感 | 热更新 |
|---|---|---|---|---|---|---|
| `version` | onboard.ts:84 | `1` | 无人校验（version:2 照读，见 CFG-04） | onboard | 否 | — |
| `gateway.bind` | onboard.ts:75；env `OPENCLAUDE_GATEWAY_BIND` 覆盖（gatewayBind.ts:36） | `127.0.0.1` | server 监听、doctor:113、/api/config | onboard | 否 | 否（重启） |
| `gateway.port` | onboard.ts:74；env `OPENCLAUDE_GATEWAY_PORT` 覆盖（gatewayBind.ts:39） | `18789`；onboard 用 `Number()` 不校验 | server 监听、cli/gateway.ts:138、codexLaunchOverrides、doctor | onboard | 否 | 否 |
| `gateway.accessToken` | onboard.ts:88（重跑时保留） | `randomBytes(32).hex` | checkHttpAuth:6662、login:4147、JWT 密钥:4148/4164/6665/7480、setSessionCookie:7699、mcp token 文件、doctor:129（脱敏） | onboard | **是** | 否；/api/config **不返回**（已验证） |
| `gateway.users[]` | 手写（无 CLI/API 写入口） | 无 → 单 token 模式 | login:4140-4165 | 无 | passwordHash 中敏 | 否 |
| `gateway.outboundRing` | config.ts:59-63 | `DEFAULT_RING_CONFIG` 2000/10min/5MB | 构造器 2870-2875 | 无 | 否 | 否 |
| `auth.mode` | onboard.ts:91 | `subscription` | /api/config:5974 | onboard、OAuth 回调 17077 | 否 | 部分（OAuth 写回时整体替换 deps.config） |
| `auth.claudeCodePath/Entry/Runtime` | onboard.ts:92-94 | cwd/../claude-code-best · `src/entrypoints/cli.tsx` · `bun` | subprocessRunner、codexLaunchOverrides、doctor:41-53 | onboard | 否 | 否 |
| `auth.claudeOAuth` / `codexOAuth` | server.ts:17066-17083（回调）、17168-17186（刷新） | 无 | sessionManager、刷新器 17127 | gateway（≤10min 定时） | **是** | 是（写回同时 `deps.config=config`、`sessions.updateConfig`）；/api/config 只回 `{active,expiresAt}` |
| `defaults.model` | onboard.ts:78 | `claude-opus-4-6`（与 sessionManager:4980 兜底 `glm-5.3-zai`、web `deepseek-v4-flash` 三处不一，CFG-16） | server.ts ~25 处、sessionManager:3848 | onboard | 否 | 否 |
| `defaults.permissionMode` | onboard.ts:98 | onboard 写 `acceptEdits`；**缺失时 undefined → CCB 不带 `--permission-mode` → 引擎默认(default/ask)**（sessionManager:4114 → subprocessRunner:1134） | sessionManager:4114、server.ts:8727、identityCompatAssets:105 | onboard | 否（安全语义） | 否 |
| `defaults.toolsets` | config.ts:92 | undefined → 全部工具 | server.ts:20560、sessionManager:4117 | 无 | 否 | 否 |
| `toolsets` | config.ts:97 | undefined | subprocessRunner | 无 | 否 | 否 |
| `provider` | config.ts:102 | undefined（universal） | /api/config:5968、server.ts:21340、subprocessRunner | 无 | 否 | 否 |
| `channels.webchat` | onboard.ts:101 | `{enabled:true}` | /api/config（仅 keys） | onboard | 否 | 否 |
| `channels.telegram` | 类型 config.ts:105 `botTokenRef`；**运行时读 `botToken`/`mentionRequired`**（cli/gateway.ts:177-190，`as any`） | 无 | cli/gateway.ts | 手写 | botToken **是** | 否 |
| `channels.wechat` / `feishu` | config.ts:106-107 | 无 | cli/gateway.ts:157、server.ts:15662（`as any`） | 手写 | 否 | 否 |
| `mcpServers[]` | config.ts:17-29 | 无 | subprocessRunner:2372/2581（**env 原样注入子进程**）、/api/config:5969-5973（脱敏为 id/label/provider/tools） | 手写 | `env` **是** | 否 |
| `terminal` | config.ts:112-124 | `type:'local'`（subprocessRunner:1570） | subprocessRunner | 手写 | 否 | 否 |

**agents.yaml**（`paths.agentsYaml`；ENOENT → `{agents:[{id:'main'}],routes:[],default:'main'}`，config.ts:194）

| 字段 | 权威源 | 默认值 | 谁读 | 谁写 | 敏感 | 热更新 |
|---|---|---|---|---|---|---|
| `agents[].id` | POST /api/agents 校验 `^[a-zA-Z0-9_-]+$`（8701）；CLI `agents add` **不校验**（CFG-14） | `main` | 全站 | onboard、CLI、POST /api/agents、市场同步 | 否 | 枚举面 mtime 热；`deps.agentsConfig` 仅 API 写回时替换（CFG-10） |
| `agents[].model` | PUT 8789 零校验 | 继承 `defaults.model` | sessionManager、resolveSyntheticTurnModel | API/CLI/市场 | 否 | 同上 |
| `agents[].persona` | PUT 8790 零校验（任意路径） | `agents/<id>/CLAUDE.md`；onboard 写入**绝对路径** | handlePersona:8822、sessionManager:4087 | API/onboard/市场 | 路径 | 同上 |
| `agents[].cwd` | PUT 8791 零校验 | undefined | sessionManager、**/api/file 白名单 7896/8099** | API | 路径（安全边界） | `/api/file` 用 `deps.agentsConfig`：API 写回即刻生效，手改 yaml 不生效 |
| `agents[].permissionMode` | PUT 8792 / POST 8724 **不校验枚举** | 继承 `defaults.permissionMode` | sessionManager:4114 → CCB argv | API | 安全语义 | 同上 |
| `agents[].toolsets` | PUT 8797 / POST 8730 **不校验类型** | 继承 `defaults.toolsets` | server.ts:20560、sessionManager:4117 | API | 否 | 同上 |
| `agents[].mcpServers[]` | PUT 8798 **不校验形状** | 无 | subprocessRunner:2378/2594（command 以 gateway 用户 spawn，env 注入） | API | `command`/`env` **是** | 同上 |
| `agents[].displayName/avatarEmoji/greeting/provider` | PUT 8793-8796 零校验 | 无 | 展示 / 路由 | API/市场 | 否 | 同上 |
| `agents[].source` | 市场同步 | 无 | collaboratorAgents、handleAgentItem 8777（marketplace 保护） | 市场同步 | 否 | 同上 |
| `agents[].version/updatedAt/runnerKind` | 市场同步/codex | 无 | codex runner | 市场同步 | 否 | 同上 |
| `routes[]` | 无 API 写入口 | `[]` | Router:26 | 手写 | 否 | Router 仅 API 写回时 `reload` |
| `default` | onboard/bootstrap | `main`；**不校验是否存在**（repro：`default: ghost` 照收） | Router:19、userVisibleDefaultAgentId | onboard | 否 | 同上 |
| 未知键（如残留 `teams:`、agent 级自定义键） | — | — | 无消费方 | `stringifyYaml` **原样写回**（已验证）；**注释与键序丢失** | — | — |

**collaboration-config.json**（selfhost 专用，`isEngineLocalTurnExempt()` 门，server.ts:13531）

| 字段 | 权威源 | 默认值 | 谁读 | 谁写 | 敏感 | 热更新 |
|---|---|---|---|---|---|---|
| `format` / `rev` | advisorConfigStore.ts:20,207-208 | `1` / `0`（CAS 单调） | GET/PUT 同路由 | `mutate()`（锁 + tmp+rename） | 否 | 是（每次读盘，无缓存） |
| `defaultMode` / `defaultAdvisorModel` | :50-52 | `solo` / `null` | resolveSessionCollab | putDefault/putIntent(asDefault) | 否 | 是 |
| `sessions[sid]` | :22-26 | `{}` | resolveSessionCollab | putSession/putIntent；DELETE /api/sessions/:id 时 best-effort 清理（5954） | 否 | 是 |
| `provenEngines` / `provenCcbModels` | :53-54 | `[]` | catalogOptions 13540 | markEngineProven/markProvenCcbModel | 否 | 是 |
| 损坏文件 | :175-190 | — | GET → 500「original file left intact」（13595） | 从不覆盖原文件 | — | — |

**web 侧偏好**（master 权威，gateway 不落盘）：`prefs.theme/default_model/default_effort/notify_email/qq_proactive_push/auto_dream_enabled/auto_optimizer_enabled/hotkeys`（modelPreferences.ts:7-19）· 读 SettingsCenter:152 一次性 · 写 PreferencesTab→`patchPreferences` · 本设备偏好 `useLocalComposerPrefs` / `oc_v5_team_mode[:sid]`（teamMode.ts）走 localStorage。

## 3. 方法与证据

**读了什么**：§1 清单全部文件通读；server.ts 只读 §1 列出的行段（grep 定位：`/api/config`、`/api/agents`、`/api/collaboration-config`、`deps.config.*`、`deps.agentsConfig`、`writeConfig(`、`checkHttpAuth`、`getUserId`）；sessionManager.ts:4085-4145、subprocessRunner.ts:1134-1139 & 2372-2600 作为消费侧佐证；router.ts:11-26。

**跑了哪些测试**（全部在 `wt/msc-config`，Node 22.22.0，Windows）：

| 命令 | 结果 |
|---|---|
| `npx tsc --build`（基线） | exit 0，98s 冷 / 11s 增量 |
| `npx tsc --build`（含 2 个新测试文件） | exit 0 |
| `npm run typecheck --workspace packages/web-react` | exit 0，68s |
| `npx tsx --test` storage `agentsConfigTransaction` + protocol `collaboration/identityCompat/modelAuthority/staticKeyProviders` | 99 pass / 16 fail —— 16 个失败全部来自 `identityCompatAssets.test.ts`：`EPERM: operation not permitted, symlink`（Windows 非管理员无 symlink 权限）→ **NOT RUN**（环境，非代码） |
| `npx tsx --test --test-concurrency=1` gateway 14 个配置相关文件 | 200 pass / 9 fail —— `codexLaunchOverrides` ×5（断言 POSIX 路径 `sessionDir/…`，实际 `C:\…`）、`envProbe` ×1、`pathAcl` ×2（用例名即「Linux regression」）→ **NOT RUN**（Windows 路径分隔符，非代码）；`collaborationConfigHttp`、`advisorConfigStore`、`bridgeApiAllowlist`、`gatewayBind`、`localBridgeAuth`、`modelAuthority*`、`hostStaticProviders`、`teamMode*`、`collaboratorAgents` 全绿 |
| `cd packages/web-react; npx vitest run` `lib/{collaborationConfig,modelPreferences,teamMode}.test.ts` `components/{SettingsCenter,ProjectSettingsDialog}.test.tsx` `components/settings/PreferencesTab.test.tsx` `--maxWorkers=1` | 6 files / 80 tests pass，42s |
| `npx biome check` 两个新测试文件 | exit 0（`--write` 格式化一次后） |
| **新增** `npx tsx --test packages/storage/src/__tests__/mscConfigAgentsYamlShape.test.ts` | 1 pass / **2 fail（预期红灯）** |
| **新增** `npx tsx --test --test-concurrency=1 packages/gateway/src/__tests__/mscConfigAgentsApiValidation.test.ts` | 1 pass / **3 fail（预期红灯）** |
| `AccountTab.test.tsx` / `ApiAccessTab.test.tsx` / `api.test.ts` | NOT RUN（commercial 数据面，本轮只审状态机，未改动） |
| cli 四个命令 | 仓库内 **零测试文件**（`packages/cli/src` 无 `*.test.ts`），见 CFG-25 |

**复现脚本**（仓库外 `D:\code\test_project\test123\.audit-tmp\msc-config\repro\`，`cd wt\msc-config; npx tsx <脚本>` 运行；完整输出在同目录 `output.txt`）：

| 脚本 | 关键输出 |
|---|---|
| `agentsYamlShape.repro.mts` | `[empty agents.yaml → readAgentsConfig()] resolved: null`；`[empty → updateAgentsConfig(cfg.agents.length)] THREW: TypeError - Cannot read properties of null (reading 'agents')`；`[no agents key → updateAgentsConfig(find)] THREW: TypeError - Cannot read properties of undefined (reading 'find')`；`[agents is a string] THREW: cfg.agents.find is not a function`；`default → ghost` 原样接受 |
| `agentsYamlRoundtrip.repro.mts` | `unknown per-agent key kept: true` · `unknown top-level key kept: true` · `comments preserved: false` · `marketplace source kept: true` |
| `openclaudeJsonShape.repro.mts` | `{}` / `[1,2,3]` / `"port":"18789"` / `version:2` 全部被 `readConfig()` 原样返回，首个消费点 `TypeError: Cannot read properties of undefined (reading 'port')` 或 `Cannot convert undefined or null to object`（= `Object.keys(config.channels)`，/api/config:5985）；`permissionMode:"yolo"` 无人拦；`writeConfig` 源码 `uses tmp+rename: false | takes lock: false`；`writeConfig({version:1} as any)` 落盘成功 |
| `onboardRerun.repro.mts` | 重跑 `onboard({nonInteractive:true,...})` 后：`kept gateway.accessToken`；**LOST** `gateway.users`、`gateway.outboundRing`、`auth.claudeOAuth`、`auth.codexOAuth`、`defaults.toolsets`、`toolsets`、`provider`、`channels.telegram`、`mcpServers`、`terminal`；`defaults.permissionMode before=default after=acceptEdits`；`agents before=[main, shop-assistant(marketplace), coder] after=['main'] routes=0` |

## 4. 问题清单

| 编号 | 位置 | 现象 | 影响 | 严重度 | 证据 |
|---|---|---|---|---|---|
| CFG-01 | `packages/cli/src/commands/onboard.ts:83-112`（`cfg` 全新对象 + `writeConfig` + `writeAgentsConfig` 整文件覆盖）；提示文案 :28-29 称「keep credentials」 | 重跑 `onboard`（含 `--non-interactive`）只保留 `gateway.accessToken`；`users`/`outboundRing`/`claudeOAuth`/`codexOAuth`/`provider`/`toolsets`/`mcpServers`/`terminal`/`channels.telegram` 全部丢失；agents.yaml 被重置为单个 `main`，**市场安装的 agent、自建 agent、routes 全丢**；`defaults.permissionMode` 被静默改成 `acceptEdits` | 数据丢失（凭据 + 市场 agent 注册），与文案承诺相反 | **P1** | `onboardRerun.repro.mts` 输出（§3） |
| CFG-02 | `packages/storage/src/config.ts:136-140`（`writeConfig` = `writeFile` 直写，无 tmp+rename、无锁）；运行时写入方 `server.ts:17067-17080`（OAuth 回调）、`17169-17180`（≤10min 定时刷新） | 进程崩溃/断电/磁盘满发生在写入中 → openclaude.json 半截；下次启动 `readConfig()` 的 `JSON.parse` 抛出，`gatewayCmd`（cli/gateway.ts:99）未捕获 → **gateway 无法启动**，且 OAuth 凭据一起丢；两个写入方之间也无互斥（onboard 重跑 vs 定时刷新 → lost update）。同文件里 `writeAgentsConfigUnlocked`（:231-240）已做 tmp+rename+锁，`atomicWriteJsonFile`（efficiencyHookConfig.ts:36-50）、`AdvisorConfigStore.mutate`（:210-212）也都做了 | 配置损坏 → 不可用 + 凭据丢失 | **P1** | `openclaudeJsonShape.repro.mts`：`uses tmp+rename: false / takes lock: false` |
| CFG-03 | `packages/storage/src/config.ts:188-198`（`parseYaml(raw) as AgentsConfig`，仅 ENOENT 给默认） | 空文件 / 仅注释 → 返回 `null`；缺 `agents` 键 → `undefined`；`agents` 非数组照返。消费方 `updateAgentsConfig`（:222 `cfg.agents`）、`server.ts:8715/8773`、`router.ts:19/26`、`sessionManager` 直接 TypeError；`gatewayCmd` 启动读到 null 会在 `new Router(null)` 之后首帧崩 | 常见路径（编辑器清空/保存失败留空文件）静默变成运行时崩溃 | P2 | `agentsYamlShape.repro.mts`；红灯 `mscConfigAgentsYamlShape.test.ts` #1 #2 |
| CFG-04 | `config.ts:127-134`（`JSON.parse(raw) as OpenClaudeConfig`）、`cli/gateway.ts:99-103`（只判 `!config`）、`server.ts:5964-5992`（`res.writeHead(200)` 在 :5965 先于取值，:5985 `Object.keys(config.channels)`） | openclaude.json 无 schema 校验：缺 `gateway/auth/defaults/channels`、`port` 为字符串、`version` 非 1、`permissionMode` 非法枚举，全部读入；首个消费点 TypeError。`/api/config` 已发 200 头后抛异常 → 客户端拿到空体 200 | 静默错误、诊断困难；`doctor` 也不查（CFG-13） | P2 | `openclaudeJsonShape.repro.mts` 五组输入 |
| CFG-05 | `server.ts:8789-8798`（PUT）、`8720-8731`（POST）：`body.permissionMode/toolsets/mcpServers/model/provider/cwd/persona` 直接赋值 | 任意 JSON 值直写 agents.yaml：`permissionMode:'yolo'` → 下次 spawn `--permission-mode yolo`（subprocessRunner:1134-1139）→ CCB 拒启；`toolsets:'coding'`（字符串）→ 两个消费点**各自静默走偏**：`toolsetIntent.normalizeToolsetList:25` 非数组当「未配置」→ 放开全部工具，而 `subprocessRunner:2357-2362` `for…of` 逐字符迭代 `'c','o','d'…` → `allowedMcpIds` 空集 → **零工具**；`mcpServers:{...}`（非数组）→ subprocessRunner:2378 `for…of` 抛 TypeError | 一次错误 PUT 让该 agent 拒启或工具集面目全非，且 UI 无提示 | P2 | 红灯 `mscConfigAgentsApiValidation.test.ts` #3（实际 200，落盘 `yolo`）、#4 |
| CFG-06 | `server.ts:8686-8694`（GET 列表 = `view.agents` 原样）、`8760-8763`（GET 单个 = `{agent}` 原样） | 响应含 `agents[].mcpServers[].env`（第三方 API key 载体，subprocessRunner:2589/2600 原样注入子进程）与 `cwd`/`persona` 宿主绝对路径。对比 `/api/config:5966-5973` 已把全局 `mcpServers` 脱敏为 `id/label/provider/tools`，agent 级没有同等处理；bridge 白名单把 `GET /api/agents(/:id)` 标为 `proxyFromCommercial:true`（bridgeApiAllowlist.ts:81-97），商业版浏览器也能拿到 | 凭据经管理 API 外泄（同用户可见，但违反「/api 不回 secret」纪律，且进浏览器内存/日志） | P2 | 红灯 `mscConfigAgentsApiValidation.test.ts` #2（`GET /api/agents leaked mcpServers[].env`）；绿灯 #1 证明 `/api/config` 已脱敏 |
| CFG-07 | `server.ts:8790`（persona 任意路径）+ `8813-8853`（PUT persona 写 `currentAgent.persona`）；`8791`（cwd 任意）+ `7896-7898/8099-8101`（`/api/file` 用 `deps.agentsConfig.agents[].cwd` 当读白名单，`8802` 写回即刻替换）；`8798`（mcpServers.command 任意 → subprocessRunner 以 gateway 进程用户 spawn）；`handleAgentItem` 全程不读 `getUserId` | 持有任一有效凭据即可：① 把 persona 指向任意文件再 PUT persona = **任意文件写**；② 把 cwd 设为 `/` 再 `GET /api/file?path=` = **任意文件读**；③ 写 mcpServers.command = 下次会话以 gateway 用户执行任意命令。单租户 selfhost 里凭据持有者=机主（自伤面）；开启 `gateway.users` 多用户后，任意普通用户 → gateway OS 用户提权，且 agents 全局无 owner | 配置面即安全边界，缺最小校验 | P2（多用户模式下 P1） | 代码路径逐行核对；`/api/file` 白名单来源 :7896 & :8099 |
| CFG-08 | `server.ts:4140-4165`（login）、`6662-6674`（checkHttpAuth：JWT 用 accessToken 做 HMAC 密钥，验不过再 `checkToken` 原始 token）、`7478-7488`（getUserId：原始 token → `'default'`）、`7663`（JWT 30 天） | `gateway.accessToken` 同时是 ① 万能 bearer ② JWT 签名密钥 ③ codex mcp-memory 回调 token（codexLaunchOverrides:487）。配置了 `users` 后原始 token 仍直接通过鉴权且身份是 `default`，多用户边界不成立；无轮换命令（改 token 即全员下线）；`verifyJwt`（auth.ts:71-73）接受无 `exp` 的载荷 | 「多用户与 accessToken 的边界」：边界只存在于登录页，不存在于 API | P2 | 代码核对；`gateway.users` 无任何写入口（grep 仓库仅 login 读） |
| CFG-09 | `config.ts:105`（类型 `telegram?: {enabled; botTokenRef?}`）vs `cli/gateway.ts:157,177`（`config.channels as any`）、`:179`（读 `tgCfg.botToken`）、`:190`（读 `tgCfg.mentionRequired`）；`server.ts:15662` 同样 `as any` | 类型与运行时字段名不一致（`botTokenRef` vs `botToken`），`mentionRequired` 在类型中不存在；`as any` 让 tsc 完全失效。按类型写配置的用户 telegram 永远「no botToken found」 | 契约不一致 + `any` 漏洞 | P2 | 行号对照 |
| CFG-10 | `server.ts:2820`（`new Router(deps.agentsConfig)`）、`4201`（/v1 用 `deps.agentsConfig`）、`7896/8099`（/api/file 白名单）、`8736/8802`（仅 API 写回时替换 + `router.reload`）vs `2637-2653`（`_getAgentsConfig` mtime 缓存，外部编辑热生效）；openclaude.json 侧 `17080/17180`（OAuth 写回时 `deps.config = 磁盘内容` + `sessions.updateConfig`，但 outboundRing/其他持有者不更新） | 同一 agents.yaml 有两份内存权威：CLI `agents add`、手改 yaml、市场同步（另一进程写）→ 枚举面（GET /api/agents、/v1/models、技能作用域）热生效，但 Router 路由、/v1/chat 目标解析、/api/file cwd 白名单**仍是旧快照**直到有人调 API 写回或重启；openclaude.json 的「热更新」只在 OAuth 刷新时**意外**发生且只推到 SessionManager | 热更新语义不一致 → 「改了配置怎么没生效 / 怎么突然生效了」 | P2 | grep `deps.agentsConfig` 6 处 + `_getAgentsConfig` 21 处 |
| CFG-11 | `packages/storage/src/identityCompatRuntime.ts:8-26`（每次 `fetch` master `/internal/v3/marketplace/sync`，10s 超时，无缓存）；调用点 `server.ts:8693`（GET /api/agents）、`8710`（POST）、`8767`（PUT/DELETE）、`resolveRuntimeExecutionAgent:33`（每次 admission） | 容器模式（三件套 env 齐全）下每次 agent 列表/写入/建会话都同步打一次 master；master 抖动 → `COMPAT_AUTHORITY_UNAVAILABLE` → GET /api/agents 500、turn 被拒。文件头注释「Never a display/sync cache」是安全语义（不能拿陈旧投影当授权），但 **展示面**（GET 列表）不需要这一强度 | 性能 + 可用性耦合（selfhost 无容器 env 时走 `return undefined`，不受影响） | P2（仅容器模式） | 代码核对；测试中三件套缺席即走本地分支（新测试 before 钩子） |
| CFG-12 | `onboard.ts:74`（`Number(...)` 不校验 NaN/0/>65535）、`:55-63`（`opts.authMode` 来自 CLI 不校验枚举）、`:117`（**明文打印 accessToken**，而 doctor:127-132 默认脱敏）、`:109`（agents.yaml 里 persona 写**绝对路径** `paths.agentClaudeMd('main')`，OPENCLAUDE_HOME 迁移即断） | 非法端口要到监听时才报错；token 进终端历史/截图；HOME 搬家后 persona 路径失效（identityCompatAssets:109-112 支持相对路径，onboard 不用） | 健壮性 / 默认值打磨 | P3 | 行号 |
| CFG-13 | `doctor.ts:41`（`cfg.auth.claudeCodePath` 无守卫）、`:55-56`（只打印 agents，不校验 `default` 存在、persona 文件存在、permissionMode 合法、port 范围、model 非空） | 缺 `auth` 时 doctor 自己 TypeError 而不是给诊断；CFG-03/04 那类问题 doctor 全部放行 | doctor 未承担 schema 诊断职责 | P3 | 行号 |
| CFG-14 | `cli/agents.ts:18-33`（`agentsAdd(id)` 不校验 id，直接 `paths.agentClaudeMd(id)` / `paths.agentSessionsDir(id)`） | `openclaude agents add ../../x` 在 HOME 外建目录写文件；与 POST /api/agents 的 `^[a-zA-Z0-9_-]+$` 不一致；且 bridgeApiAllowlist.ts:76-84 宣称「用户不能自建容器内 agent」，CLI 面仍可 | 契约不一致；本地 CLI 受信用户，风险低 | P3 | 行号 |
| CFG-15 | `storage/credentials.ts:6-14,16-23`（`channel`/`accountId` 直接 `join`） | 无 basename/正则校验；当前调用方受控（pairing 命令），缺纵深防御 | 健壮性 | P3 | 行号 |
| CFG-16 | `onboard.ts:78`（`claude-opus-4-6`）、`sessionManager.ts:4980`（`?? 'glm-5.3-zai'`）、`web/lib/modelPreferences.ts:75`（`PLATFORM_NEW_USER_MODEL='deepseek-v4-flash'`） | 「默认模型」三层三个值；onboard 默认值在 selfhost（无 Anthropic 直连）下不可路由 | 默认值不一致 | P3（改默认值需 ask_decision） | 行号 |
| CFG-17 | `server.ts:5964-5992` | `/api/config` 不判 method（PUT/POST/DELETE 均 200 回投影）；`writeHead` 先于 body 构造（与 CFG-04 叠加） | 契约松散 | P3 | 行号 |
| CFG-18 | `bridgeApiAllowlist.ts:76-84` 注释「砍掉唯一的创建路径 POST /api/agents」vs `server.ts:8696-8746` handler 仍在 | 白名单只挡 bridge，本地 token 仍可 POST；注释与实现漂移，后来者按注释推理会误判「无创建面」 | 文档/契约漂移 | P3 | 行号 |
| CFG-19 | `web/lib/identityCompat.ts:14`：`parseIdentityCompatProjection(result.identityCompat, result.identityCompat?.userId)` | 用投影自身的 userId 当 `expectedUserId`，校验恒真；protocol 契约要求传「已认证身份」（protocol/identityCompat.ts:41-48） | 契约误用（展示面，低风险） | P3 | 行号 |
| CFG-20 | `web/lib/api.ts:1344-1405` 与 `web/lib/collaborationConfig.ts:18-29` 重复手写同一 wire 类型；`CollabMode` 未复用 protocol `CollaborationMode`（collaboration.ts:7-8） | 三份词汇表，改一处漏两处 | 可维护性 | P3 | 行号 |
| CFG-21 | `advisorConfigStore.ts:237-242`（`deleteSession` 不校验 sessionId，`putSession:224` 校验）、`:293-303`（`markEngineProven` 超 32 字符时在 `parseCollaborationConfigDoc:121-123` 报 `CORRUPT` 而非 `VALIDATION`） | 错误码语义漂移（调用方按 code 分流） | P3 | 行号 |
| CFG-22 | `gateway/auth.ts:71-73`（`payload.exp &&` → 无 exp 永不过期）；`verifyJwt` 不校验 `userId` 类型 | 仅密钥泄露时可利用；纵深防御 | P3 | 行号 |
| CFG-23 | web 状态机：`SettingsCenter.tsx:145-170`（`prefs != null` 短路，重开不刷新、多 Tab 陈旧）、`:172-182`（`patchPref` 无序列号，乱序响应覆盖新快照）、`PreferencesTab.tsx:118-121`（主题 live 先切、patch 失败不回滚 → 与后端分叉，设计如此但无提示）、`ProjectSettingsDialog.tsx:217-253`（`putProjectContext` 成功后 `onSave` 失败 → 无回滚且 `contextVersion` 不刷新，二次保存必撞「刚被他处修改」）、`AccountTab.tsx:166-178`（`loadMore` 与 `reloadKey` 重拉竞态 → 追加旧页） | 少见路径下 UI 与服务端状态分叉 | P3 | 行号 |
| CFG-24 | `efficiencyHookConfig.ts:39`（`target.split('/')` 在 win32 路径下 tmp 名含整路径） | 仅桌面 Host（win32）场景 tmp 文件名异常 | P3（建议不修，见 §7） | 行号 |
| CFG-25 | 测试覆盖：`storage/config.ts` 只有事务用例（`agentsConfigTransaction.test.ts`），**无** readConfig/writeConfig/shape 用例；`packages/cli/src` 零测试；`/api/config`、`/api/agents` CRUD 无 HTTP 用例；Windows 上 `identityCompatAssets`（symlink EPERM）、`codexLaunchOverrides`/`envProbe`/`pathAcl`（POSIX 路径断言）NOT RUN | 本轮补 2 文件 7 用例（5 红 2 绿） | P3 | §3 |

**统计**：P1 ×2（CFG-01、CFG-02）· P2 ×9（CFG-03 ~ CFG-11）· P3 ×14（CFG-12 ~ CFG-25）。

### §5 八项清单逐项结论

1. **数据正确性** — agents.yaml 的读-改-写事务（锁 + tmp+rename，`updateAgentsConfig`）与 collaboration-config（锁 + CAS + tmp+rename）是对的；**openclaude.json 是例外**（CFG-02 非原子 + 无锁，且是运行时高频写）；onboard 重跑整文件覆盖（CFG-01）。旧格式兼容：agents.yaml 残留 `teams:` 原样带过（已验证），无迁移逻辑也无需要。边界：空文件/缺键崩（CFG-03/04）。
2. **契约一致性** — 类型 vs 运行时：`telegram.botTokenRef`/`botToken`（CFG-09）；bridge 注释 vs handler（CFG-18）；web 三份 collab 类型（CFG-20）；默认模型三值（CFG-16）；`as any` 3 处（cli/gateway.ts:157,177；server.ts:15662）；web `identityCompat` 契约误用（CFG-19）。protocol 层 `modelAuthority`/`identityCompat`/`staticKeyProviders`/`collaboration` 契约本身严谨（未知字段拒绝、fail-closed），无问题。
3. **错误处理与恢复** — `readConfig` 抛 JSON 错在 `gatewayCmd` 未捕获（CFG-02 后果）；OAuth 刷新中 `readConfig` 抛 → 吞成 log，上游已换 refresh_token 而本地未落盘（同 CFG-02 尾巴）；`/api/config` 先发 200 再抛（CFG-04/17）；`fetchIdentityCompatProjection` fail-closed 正确但无退避/缓存（CFG-11）；advisorConfigStore 损坏读 fail-closed 且不覆盖原文件（正确）。
4. **安全** — `/api/config` 响应逐字段核过：`gateway{bind,port}` / `defaults{model,permissionMode,toolsets}` / `channels` keys / `provider` / `auth{mode, claudeOAuth{active,expiresAt}}` / `mcpServers[{id,label,provider,tools}]` —— **无 accessToken、无 OAuth token、无 mcp env、无 users**（绿灯用例锁定）。`/api/agents(/:id)` **有** `mcpServers[].env`（CFG-06）。日志：OAuth 落盘只记 `provider`（17082/17182），codex 路径 token 走 0600 文件不进 argv（codexLaunchOverrides:481-488，既有测试锁），doctor 默认脱敏，**onboard 明文打印**（CFG-12）。鉴权/owner：`handleAgentItem` 不校验 owner（CFG-07）；accessToken 万能 bearer（CFG-08）。权限模式默认值：onboard 写 `acceptEdits`；缺失时 CCB 走引擎默认；PUT 可写任意字符串（CFG-05）；`bypassPermissions` 由任一有效凭据即可设置（单租户可接受，多用户不可）。
5. **性能** — agents.yaml 枚举面走 mtime 缓存（好）；`GET /api/agents/:id`、persona、建会话每次直读 yaml（小文件可接受）；容器模式每请求同步打 master（CFG-11）；`fetchIdentityCompatProjection` 在 GET 列表里串行等待。无 N+1 / 无上限列表问题。
6. **状态机与前端行为** — CFG-23 五条；`collaborationConfig` 的 epoch 陈旧忽略（`isStaleCollabEpoch`）与 CAS rev 设计正确；`teamMode` per-session 键语义清晰。
7. **测试覆盖** — CFG-25；现有 `collaborationConfigHttp.test.ts` 是很好的真 HTTP 范式，本轮新增用例沿用；`agentsConfigTransaction.test.ts` 真跨进程锁争用（好）。
8. **配置与默认值** — schema 校验：openclaude.json / agents.yaml **零**（CFG-03/04），collaboration-config 完整；缺字段默认值：只有 ENOENT 级默认，字段级默认散在消费点（表 2.1）；非法值：不拦（CFG-04/05）；写回保留未知字段：**是**（stringifyYaml / JSON.stringify 原样），但注释与键序丢失（可接受，需在文档写明）；热更新：agents.yaml 枚举面热、路由/白名单/`/v1` 不热（CFG-10），openclaude.json 只在 OAuth 刷新时意外整体替换；**CLI onboard 写出 → gateway 原样读回**：字段级是（同一 `writeConfig/readConfig`，JSON 往返无损；agents.yaml 往返无损），但 onboard 写出的 `defaults.model='claude-opus-4-6'` 在 selfhost 不可路由、persona 绝对路径不可迁移（CFG-12/16）。

## 5. 改进建议（问题之外的设计层建议，标优先级）

| 优先级 | 建议 |
|---|---|
| 高 | 给 `OpenClaudeConfig` / `AgentsConfig` 一个**运行时 schema + 归一函数**（`parseOpenClaudeConfig(raw): {config, warnings}` / `normalizeAgentsConfig(raw)`），放 storage 层，`readConfig`/`readAgentsConfig`/`doctor`/API 写入前四处共用；未知字段透传（保留写回），已知字段类型/枚举校验，缺字段填默认，`version` 不认识则拒。零依赖手写即可（仓库已有 `parseCollaborationConfigDoc` 范式），不引 zod（引依赖要 ask_decision）。 |
| 高 | `writeConfig` 改为 `acquireKernelFileLock(paths.config + '.lock')` + tmp + rename（复用 `writeAgentsConfigUnlocked` 形态）；再提供 `updateConfig(fn)` 读-改-写事务，OAuth 回调/刷新与 onboard 全部改走它。 |
| 高 | onboard 重跑改为「合并」：`existing` 深合并只覆盖本次询问过的字段（bind/port/model/claudeCodePath/authMode），`users/oauth/mcpServers/...` 保留；agents.yaml 已存在则**不碰**（或只补 `main`）。 |
| 中 | 统一 agents.yaml 内存权威：去掉 `deps.agentsConfig` 长期持有，Router / `/v1` / `/api/file` 白名单一律经 `_getAgentsConfig()`（mtime 缓存）取；`router.reload` 由缓存刷新驱动。 |
| 中 | `/api/agents(/:id)` 返回投影：`mcpServers[].env` → 只回 key 名（或 `env: {…keys: [..]}`），`cwd/persona` 保留（用户需要看）但注明；与 `/api/config` 的脱敏形态对齐。 |
| 中 | `PUT/POST /api/agents` 加字段级校验（permissionMode 五枚举、toolsets string[]、mcpServers 形状、persona/cwd 必须在 HOME 或既有 allowlist 内，除非请求方是 legacy accessToken 且单用户）。 |
| 中 | `doctor` 承担 schema 诊断：调上面的归一函数打印 warnings；检查 default agent 存在、persona 文件存在、port 范围、defaults.model 在本地 catalog 可路由。 |
| 低 | `telegram` 配置字段以类型为准改运行时（或反之），删掉 `as any`；`channels` 类型补 `mentionRequired`。 |
| 低 | 多用户模式（`gateway.users`）要么明确弃用（文档 + doctor 警告），要么补 owner 模型 —— 需专项，见 §7。 |
| 低 | web：`lib/api.ts` 的 collab 方法直接引用 `lib/collaborationConfig.ts` 的 `CollaborationConfigDoc`；`CollabMode` = protocol `CollaborationMode`。 |

## 6. 修复计划（阶段 B）

| 编号 | 改哪些文件 | 怎么改 | 补什么测试 | 风险 | 触及共享文件 |
|---|---|---|---|---|---|
| CFG-01 | `packages/cli/src/commands/onboard.ts` | `existing` 存在时构造 `cfg = deepMerge(existing, 本次输入字段)`；仅覆盖 gateway.bind/port、auth.mode/claudeCodePath/Entry/Runtime、defaults.model；`defaults.permissionMode` 存在则保留；agents.yaml 存在时跳过 `writeAgentsConfig`（只确保 `main` 目录存在）；文案改为实际行为 | 新建 `packages/cli/src/__tests__/onboard.test.ts`（node:test，临时 HOME，非交互）：重跑后 users/oauth/mcpServers/agents 全保留；首装路径不变 | 低；改的是 CLI 一次性路径 | 否 |
| CFG-02 | `packages/storage/src/config.ts`；`packages/gateway/src/server.ts`（17067-17080、17169-17180 两段）；`packages/storage/src/index.ts`（若新增导出） | `writeConfig` 内部 `acquireKernelFileLock(paths.config+'.lock')` + `tmp-<pid>-<rand>` + `rename`；新增 `updateConfig<T>(fn)` 事务（与 `updateAgentsConfig` 同构）；OAuth 两处改 `await updateConfig(c => { c.auth.claudeOAuth = …; c.auth.mode = … })` 并用返回值刷新 `deps.config` | `packages/storage/src/__tests__/mscConfigOpenclaudeJsonWrite.test.ts`：写后无 `.tmp` 残留、内容完整；跨进程争用（复用 agentsConfigTransaction 的 spawn 范式）；模拟写中抛异常原文件不变 | 中：OAuth 刷新是热路径，锁超时要给（8s，同 advisorConfigStore）；lock 文件路径新增 | **是**（server.ts 两个小段，单独 commit + 先 acquire_file_lock） |
| CFG-03 | `packages/storage/src/config.ts` | `readAgentsConfig` 解析后过 `normalizeAgentsConfig`：非对象/null → 默认；`agents` 非数组 → `[]`（空则补 `{id:'main'}`）；`routes` 非数组 → `[]`；`default` 缺或不在 agents 中 → 首个 agent id（并 warn 一次）；agent 级 id 非字符串的条目丢弃并 warn | 已提交红灯 `mscConfigAgentsYamlShape.test.ts` #1 #2 转绿；加「default 指向 ghost 归一」用例 | 低；只在畸形输入时改变行为 | 否 |
| CFG-04 | `packages/storage/src/config.ts`（新增 `parseOpenClaudeConfig`）；`packages/cli/src/commands/gateway.ts`（启动时调用，warnings 打日志，致命项 exit(1) 带可读原因）；`server.ts` `/api/config` 段 | 归一函数：version≠1 → throw；gateway.port 非 1-65535 整数 → throw；bind 非字符串 → 默认；auth/defaults/channels 缺 → 填默认 + warning；permissionMode 非五枚举 → 回 `default` + warning；未知字段透传。`/api/config` 改为先构造 body 再 `sendJson`，并判 `GET` | `mscConfigOpenclaudeJsonShape.test.ts`：五组畸形输入的归一结果；`mscConfigAgentsApiValidation.test.ts` 加 `/api/config` 非 GET → 405 | 中：致命项会让以前「能起来但半残」的配置起不来 —— 属预期，但要在 doctor 里先给出同样报告 | **是**（server.ts `/api/config` 段） |
| CFG-05 | `server.ts` 8700-8731（POST）、8771-8799（PUT）；校验函数放 `packages/storage/src/config.ts`（`validateAgentPatch`）以便 CLI 复用 | permissionMode ∈ 五枚举；toolsets 为 `string[]`；mcpServers 为 `McpServerConfig[]`（id/command 字符串、args string[]、env Record<string,string>）；model/provider/displayName 为字符串；非法 → 400 不落盘 | 已提交红灯 #3 #4 转绿；加 mcpServers 形状用例 | 低 | **是**（server.ts agents 路由块） |
| CFG-06 | `server.ts` 8686-8694、8760-8763 | 输出前 `projectAgentForApi(agent)`：`mcpServers` → `[{id,label,provider,tools,enabled,envKeys:string[]}]`；其余字段原样。web `types.ts`/`api.ts` agents 段若有类型引用 `env` 需同步（先 grep） | 已提交红灯 #2 转绿 | 低-中：若前端某处编辑 agent mcpServers 依赖读回 env 值，会变成只能新写不能回显 —— 阶段 B 先 grep `mcpServers` 在 web 的消费；无消费则直接脱敏 | **是**（server.ts；可能 `web-react/src/lib/types.ts`） |
| CFG-07 | `server.ts` 8790-8791（persona/cwd）、8798（mcpServers）；`packages/gateway/src/pathAcl.ts`（复用 `isPathWithinRoot`） | persona 必须在 `paths.home` 内（相对路径解析后）；cwd 允许绝对路径但拒绝 `/`、系统根与 `paths.home` 之外的敏感根（沿用 FILE_ALLOWED_DIRS 思路，白名单可配置）；mcpServers.command 只能是既有 `config.mcpServers[].command` 集合或 `npx`/`node`/绝对路径且文件存在（保守版：仅记录 warning 并要求 `X-OpenClaude-Confirm` 头 —— 具体口径 ask_decision）| HTTP 用例：persona `../../etc/x` → 400；cwd `/` → 400；写入合法值 → 200 | 中：可能影响现有用户已写入的合法绝对 cwd（如 `/home/agent/work`）—— 校验只对**新写入**生效，读侧不变 | **是**（server.ts） |
| CFG-08 | `server.ts` 6662-6674、4140-4165；`docs/`（配置说明） | 若 `users` 非空：`checkHttpAuth` 不再接受原始 accessToken 作为 bearer（仅 JWT），`login` 不再走 legacy 分支；`getUserId` 同步。JWT 密钥改为 `HMAC(accessToken, 'jwt')` 派生（不再直接用 token）。加 `openclaude token rotate` CLI（可选） | HTTP 用例：users 模式下原始 token → 401；单 token 模式行为不变 | **高**：改鉴权语义；selfhost 若在用 users 且客户端拿原始 token 会掉线。**需 ask_decision**，默认建议只做「单 token 模式零变化 + users 模式收口」 | **是**（server.ts 鉴权段） |
| CFG-09 | `packages/storage/src/config.ts:105`、`packages/cli/src/commands/gateway.ts:157-190`、`server.ts:15662` | 类型改为 `telegram?: { enabled; botToken?; botTokenRef?; mentionRequired? }`（运行时已是 botToken），删 `as any`，`botTokenRef` 保留为「从 credentials 目录读」的显式路径 | cli 启动装配用例（mock 动态 import） | 低 | **是**（server.ts 一行） |
| CFG-10 | `server.ts` 2820、4201、7896、8099、8736、8802 | 删除 `deps.agentsConfig` 的长期持有：新增 `private async _agents()` = `_getAgentsConfig()`；Router 构造改为惰性读取（`router.reload` 在 mtime 变化时触发）；`/api/file` 白名单与 `/v1` 改用它。openclaude.json 侧：OAuth 写回后除 `sessions.updateConfig` 外不再整体替换 `deps.config`（只更新 `auth`），避免意外把手改字段拉进内存 | 用例：外部 `writeAgentsConfig` 改 cwd 后 `/api/file` 白名单即刻反映；路由 reload | 中：Router 变成异步取配置，需检查 `route()` 调用点是否可 await（router.ts 20 行，调用点需 grep） | **是**（server.ts 多段，建议独立 commit） |
| CFG-11 | `packages/storage/src/identityCompatRuntime.ts`；`server.ts:8693` | 展示面（GET /api/agents）用带 TTL（如 30s）的投影缓存 + 失败时返回上次成功值并附 `identityCompatStale:true`；**执行面**（admission、PUT/POST 判定）保持每次拉取、fail-closed 不变 | 用例：fetch 抛 → GET 列表仍 200 且带 stale 标记；admission 仍抛 | 中：注释明确「Never a display/sync cache」—— 只对展示面放松，**需 ask_decision** | **是**（server.ts 一行） |
| CFG-12 | `onboard.ts` | port 用 `parseGatewayPortOverride` 同款校验；authMode 枚举校验；token 默认脱敏 + `--show-token`；agents.yaml persona 写相对路径 `agents/main/CLAUDE.md`（`personaCandidate` 已支持相对） | onboard 用例 | 低 | 否 |
| CFG-13 | `doctor.ts` | 调 `parseOpenClaudeConfig`/`normalizeAgentsConfig` 打印 warnings；检查 default 存在、persona 文件存在、model 非空、port 范围 | doctor 用例（临时 HOME） | 低 | 否 |
| CFG-14 | `cli/agents.ts` | id 正则与 API 一致；hidden id 拒绝 | 用例 | 低 | 否 |
| CFG-15 | `storage/credentials.ts` | `channel`/`accountId` 过 `^[A-Za-z0-9_-]{1,64}$` | 用例 | 低 | 否 |
| CFG-16 | `onboard.ts:78`（+ 文档） | onboard 默认模型改为 selfhost 可路由值（建议与 sessionManager 兜底一致 `glm-5.3-zai`，或读本地 catalog 首个可路由）；web/sessionManager 不动 | onboard 用例 | 低；**改默认值需 ask_decision** | 否 |
| CFG-17 | `server.ts:5964` | 判 `GET` else 405；body 先构造 | 用例 | 低 | **是**（同 CFG-04 段） |
| CFG-18 | `bridgeApiAllowlist.ts:76-84` 注释；或 `server.ts:8696` 去掉 POST | 与指挥官确认产品口径：若「用户不能自建 agent」是产品决定，则 POST 返回 410 并让 CLI `agents add` 打 warning；否则改注释 | bridgeApiAllowlist 用例不变 | 低 | 视决定 |
| CFG-19 | `web/lib/identityCompat.ts:14` | `expectedUserId` 改为从 `AuthSession`/`/api/me` 取的当前用户 id；拿不到时不调 parse，直接返回 null | vitest 用例 | 低 | 否 |
| CFG-20 | `web/lib/api.ts:1344-1405`、`web/lib/collaborationConfig.ts:3` | api 方法泛型引用 `CollaborationConfigDoc`；`CollabMode = CollaborationMode` | 现有 vitest 通过即可 | 低 | **是**（lib/api.ts collab 段） |
| CFG-21 | `advisorConfigStore.ts` | `deleteSession` 校验 id；`markEngineProven` 先判长度报 VALIDATION | 现有 `advisorConfigStore.test.ts` 加 2 用例 | 低 | 否 |
| CFG-22 | `gateway/auth.ts` | `verifyJwt` 要求 `exp` 为有限数且 `userId` 为非空字符串 | 用例 | 低 | 否 |
| CFG-23 | `SettingsCenter.tsx`、`PreferencesTab.tsx`、`ProjectSettingsDialog.tsx`、`AccountTab.tsx` | 偏好：open 时重拉（或 `visibilitychange` 时）；patch 加递增 seq，只接受最新响应；ProjectSettingsDialog：PUT context 成功后先更新 `contextVersion` 再 onSave，失败提示区分两阶段；AccountTab：loadMore 带 reloadKey 快照，过期丢弃 | vitest：乱序响应、两阶段失败重试 | 低 | 否 |
| CFG-25 | 上述所有测试文件 | 阶段 B 每条改动配测试；cli 包建 `__tests__/` | — | — | — |

**共享文件小 commit 规划**：server.ts 分 4 个 commit —— ①`/api/config` 段（CFG-04/17）②agents 路由块校验 + 投影（CFG-05/06/07）③OAuth 写回改 `updateConfig`（CFG-02）④`deps.agentsConfig` 收口（CFG-10）；鉴权段（CFG-08）与 identityCompat 缓存（CFG-11）等 ask_decision 结果单独 commit。`lib/api.ts` 一个 commit（CFG-20）。

## 7. 建议不修 / 暂缓 / 需专项

| 项 | 处置 | 理由 |
|---|---|---|
| CFG-08 多用户边界重构（owner 模型、token 与 JWT 密钥分离、轮换） | **需专项**（阶段 B 只做「users 模式下拒绝原始 token」的最小收口，且先 ask_decision） | v5 selfhost 单租户；`gateway.users` 无任何写入口，疑似遗留；完整多用户需要 agents 归属模型与会话隔离，超出配置子系统 |
| CFG-07 中「cwd / mcpServers.command 的允许范围」 | **ask_decision 后做** | 单租户下机主自伤面 vs 多用户提权面，收紧口径影响存量 cwd；建议阶段 B 先做 persona 必须在 HOME 内 + permissionMode/toolsets/mcpServers 形状校验（无争议部分） |
| CFG-11 展示面投影缓存 | **暂缓 → ask_decision** | 文件头「Never a display/sync cache」是有意设计；只在容器模式生效，selfhost 不受影响；需指挥官确认展示面可放松 |
| CFG-16 默认模型统一 | **ask_decision** | 改默认值影响新装用户；建议 onboard 默认取 `glm-5.3-zai`（与 sessionManager 兜底一致） |
| CFG-18 POST /api/agents 去留 | **ask_decision** | 产品口径问题（bridge 注释 vs 本地 CLI） |
| CFG-24 `efficiencyHookConfig` win32 tmp 名 | **不修** | 仅桌面 Host 分支，生产 Linux 不触发；改动收益低 |
| Windows 上 NOT RUN 的 4 个既有测试（symlink EPERM、POSIX 路径断言） | **不修** | CI 与生产均 Linux；不是代码缺陷 |
| agents.yaml 写回丢注释/键序 | **不修，文档写明** | `yaml.stringify(parse())` 语义；保注释需换 `parseDocument` 往返，收益低风险高 |
| `/api/me/preferences` 服务端 | **范围外** | 不在 gateway 实现（master），本轮只审 web 消费侧 |
| `gateway.users` 密码管理 CLI | **范围外/专项** | 与 CFG-08 同属多用户专项 |

---

# 阶段 B · 修复记录 / 验证 / 遗留

> 任务：t-1868「B·config 配置子系统修复」+ 续做 t-1962（fable-5-1-38 掉线后由指挥官 fable-5-1-36 / fable-5-1-63 接手代做）· 分支 `feat/v5-selfhost-msc-config` · 基线 `aeae1d72e`
> 统计：**发现 25 / 修复 21 / 遗留 4**（CFG-08 最小收口改为「只告警」、CFG-11 暂缓、CFG-07 之 mcpServers.command 范围未收紧、CFG-24 不修）· 新增测试 9 文件 64 例，阶段 A 5 条红灯全部转绿
> 指挥官拍板（阶段 B 开工前，对应 §7 的 ask_decision 项）：CFG-07 只做「persona 限 HOME + cwd 非根/非系统目录 + 形状校验」这一无争议部分，`mcpServers.command` 允许范围不收紧；CFG-08 单/多用户鉴权语义**零变化**，只在 `doctor` 对 `gateway.users` 遗留模式告警；CFG-11 暂缓（仅容器模式生效，selfhost 不受影响）；CFG-16 onboard 默认模型改取 `SELFHOST_FALLBACK_MODEL`（= sessionManager 兜底 `glm-5.3-zai`，web 不动）；CFG-18 保留 `POST /api/agents`，只改 `bridgeApiAllowlist` 注释使其与实现一致。

## 8. 修复记录

按提交顺序；`server.ts` 按 §6 末尾的规划拆成 4 个独立 commit（每段先 `acquire_file_lock`）。

| commit | 层 | 覆盖问题 | 改了什么 |
|---|---|---|---|
| `a7471fdb9` | storage | CFG-02/03/04/05/07/09/15/16 | `config.ts`：新增 `parseOpenClaudeConfig(raw) → {config, warnings}`（`version`≠1 / `port` 非 1-65535 致命，其余缺字段填默认 + warning，未知键透传）；`writeConfig` 改 `acquireKernelFileLock(paths.config+'.lock')` + `tmp-<pid>-<rand>` + `rename`；新增 `updateConfig(fn)` 读-改-写事务（与 `updateAgentsConfig` 同构）；`readAgentsConfig` 过 `normalizeAgentsConfig`（空文件 / 缺 `agents`·`routes` 键 / `default` 指向 ghost → 归一 + warn）；新增 `validateAgentPatch`（permissionMode 五枚举、toolsets `string[]`、mcpServers 形状、persona 限 HOME、cwd 非根非系统目录）供 API 与 CLI 复用；`telegram` 类型对齐运行时字段（`botToken` / `mentionRequired`）；`credentials.ts` 的 `channel` / `accountId` 过 `^[A-Za-z0-9_-]{1,64}$`；新增 `SELFHOST_FALLBACK_MODEL` 常量 |
| `9a80e302c` | cli | CFG-01/04/09/12/13/14/16 | `onboard.ts`：重跑改深合并（`users` / OAuth / `mcpServers` / `provider` / `terminal` / `telegram` / `defaults.permissionMode` 全保留，agents.yaml 已存在则不碰），端口 / authMode 校验，重跑默认脱敏 token，默认模型取 `SELFHOST_FALLBACK_MODEL`，persona 写相对路径；`doctor.ts`：新增纯函数 `doctorConfigFindings`（归一 warnings + `default` / persona 一致性 + `gateway.users` 遗留模式告警）；`agents.ts`：`agents add` 复用 `AGENT_ID_RE` / `validateAgentPatch`；`gateway.ts`：启动时致命项可读报错 + warnings 日志，`channels` 去 `as any`；`gateway/index.ts` 导出 `gatewayBind` |
| `6c3705d24` | gateway | CFG-18/21/22 | `auth.ts`：`verifyJwt` 要求 `exp` 为有限数且 `userId` 为非空字符串（单 token 模式零变化）；`advisorConfigStore.ts`：`deleteSession` 校验 id，`markEngineProven` 超长先报 `VALIDATION`；`bridgeApiAllowlist.ts` 注释改为「仅 bridge 路径封禁 POST /api/agents，本地 token 路径保留」 |
| `d1f780c6c` | web-react | CFG-19/20/23 | `lib/identityCompat.ts`：`expectedUserId` 取已认证 JWT `sub`，拿不到不调 parse；`lib/collaborationConfig.ts`：`CollabMode` 复用 protocol `CollaborationMode` / `isCollaborationMode`；`SettingsCenter.tsx`：关闭即丢弃偏好快照、重开重拉，`patchPref` 加序列号丢弃乱序旧响应；`ProjectSettingsDialog.tsx`：两阶段保存先推进 `contextVersion` 再 `onSave`，失败提示区分两段。fable-5-1-38 遗留的未提交工作区改动，指挥官验证后代提 |
| `941811be0` | server.ts ① | CFG-04/17 | `/api/config` 只认 `GET`（其余 405）；响应 body 先构造再 `sendJson`，不再先 `writeHead(200)` 再取值造成「200 + 空体」 |
| `69837c868` | server.ts ② | CFG-05/06/07 | `POST` / `PUT /api/agents` 接入 `storage.validateAgentPatch`，非法 400 不落盘（展示类字段空串 = 清除）；GET 列表 / 详情 / POST / PUT 响应把 `agents[].mcpServers[].env` 投影为 `envKeys`（与 `/api/config` 脱敏形态对齐，磁盘原值不动；已 grep web 无消费 `env` 值） |
| `091cbb4ea` | server.ts ③ | CFG-02（openclaude.json 侧）/ CFG-10 | OAuth 回调与 ≤10min 定时刷新的凭据落盘改走 `storage.updateConfig` 事务，新增唯一入口 `_persistOAuthCredential`；写回后只把 `auth` 段同步进 `deps.config`（不整体替换内存配置）；`openclaude.json` 缺失时跳过并 warn（与旧行为一致） |
| `e9b10af47` | server.ts ④ | CFG-10 | agents.yaml 单一内存权威：`_getAgentsConfig` 的 mtime 缓存刷新成为唯一触发点，刷新时 `_syncAgentsConfigSnapshot` 同步替换 `deps.agentsConfig` 并 `router.reload`（CLI / 手改 / 市场同步的外部写入也热生效）；`/api/file` 与 media 的 cwd 白名单改从最新快照取；API 写回统一走 `_adoptWrittenAgentsConfig`。Router 保持同步 API，未改异步（比 §6 计划保守） |
| （本次） | docs / test | — | 本节三段；`mscConfigAgentsApiValidation.test.ts` 文件头的阶段 A 红灯说明更新为阶段 B 状态 |

新增 / 转绿的测试（共 9 文件 64 例）：`storage/__tests__/mscConfigOpenclaudeJson.test.ts`（20：五组畸形输入归一、`writeConfig` 无 tmp 残留 / 事务 / 未知键保留、`validateAgentPatch`、credentials 段校验）、`mscConfigAgentsYamlShape.test.ts`（4：阶段 A 红灯 #1 #2 转绿 + ghost default 归一）、`cli/__tests__/onboard.test.ts`（7：真 HOME 非交互重跑全保留 / 首装路径不变 / 端口·authMode 校验）、`agentsDoctor.test.ts`（8：`agents add` id 校验、`doctorConfigFindings`）、`gateway/__tests__/mscConfigAgentsApiValidation.test.ts`（8：阶段 A 红灯 #2 #3 #4 转绿 + persona / cwd / mcpServers 形状 / POST / `/api/config` 405 / 外部写入热生效）、`mscConfigAuthAndAdvisorStore.test.ts`（6）、`mscConfigOAuthPersist.test.ts`（2：未知字段保留 / 无 tmp 残留 / 只同步 auth / 缺文件不凭空创建）、`web-react/lib/identityCompat.test.ts`（6）、`components/mscConfigSettingsStateMachine.test.tsx`（3：乱序 patch 丢弃、重开重拉、两阶段保存）。

## 9. 验证（09-18 23:3x，Windows 11 / Node 22.22.0 / 工作树 `wt\msc-config` @ `e9b10af47`）

| 门 | 命令 | 结果 |
|---|---|---|
| 全仓类型检查 | `npx tsc --build` | **PASS**（exit 0） |
| web-react 类型检查 | `npm run typecheck --workspace packages/web-react` | **PASS** |
| storage 单测（全包 56 文件） | `npx tsx --test <packages\storage\src\**\*.test.ts>` | 538 例：**510 pass / 26 fail / 2 cancelled**。26 fail + 2 cancelled 全部为 **Windows 环境项且与基线一致**：`identityCompatAssets` ×16（symlink EPERM）、`projectContext` cwd allowlist ×1 与 `skillStore` ×1+2（symlink EPERM）、`kernelFileLock` ×2、`projectContextMigrate` ×1、`skillDraftStore` ×5 —— 后三组在基线工作树 `wt\msc-memory`（aeae1d72e + 纯文档提交）复跑得到**完全相同的 8 条失败**。本轮两个新文件 `mscConfigOpenclaudeJson` / `mscConfigAgentsYamlShape` 全绿 |
| cli 单测 | `npx tsx --test <packages\cli\src\__tests__\*.test.ts>` | 15 / 15 **PASS**（本轮之前 cli 包零测试） |
| gateway 相关单测（10 文件） | `npx tsx --test --test-concurrency=1 mscConfig*.test.ts advisorConfigStore bridgeApiAllowlist collaborationConfigHttp envProbe gatewayBind localBridgeAuth pathAcl` | 73 例：**69 pass / 4 fail**；4 条 fail = `envProbe` ×1、`pathAcl` ×2（+1 父级）POSIX 路径断言，阶段 A 已列 **NOT RUN（Windows）**，与基线一致。三个 msc-config 文件 + advisorConfigStore + bridgeApiAllowlist + collaborationConfigHttp 全绿 |
| web-react 单测 | `npx vitest run identityCompat.test.ts mscConfigSettingsStateMachine.test.tsx SettingsCenter.test.tsx ProjectSettingsDialog.test.tsx PreferencesTab.test.tsx AccountTab.test.tsx collaborationConfig.test.ts --maxWorkers=1` | 7 文件 **84 / 84 PASS** |
| biome（新增文件） | `biome check <9 个新测试文件>` | **0 error**（按 LF 内容核；Windows 工作区 autocrlf 产生的 CRLF 会让 formatter 误报，已用 `git -c core.autocrlf=false archive` 导出后对照） |
| biome（既有改动文件） | 基线 vs HEAD 逐文件对照（同上导出法） | **无新增诊断**；顺手消掉 5 条 pre-existing（`config.ts` / `advisorConfigStore.ts` / `cli/gateway.ts` 的 organizeImports+format、`auth.ts` `gateway/index.ts` format）；剩余 `ProjectSettingsDialog.tsx` ×4、`SettingsCenter.tsx` ×3、`collaborationConfig.ts` / `identityCompat.ts` format 均为基线既有，未做全文件重排（同 skills 轮口径） |
| biome（server.ts） | `biome check --files-max-size=2097152 packages/gateway/src/server.ts` 基线 vs HEAD | lint 剖面**完全一致**：34 条 / 10 种规则同计数（useTemplate 7、noDelete 7、useOptionalChain 5 …），4 段改动未引入新违规。⚠ 见 §10 第 5 条：HEAD 的 `server.ts` 已越过 biome `files.maxSize` 1 MiB |
| 阶段 A 红灯 | `TODO(msc-config)` 标记 | 5 条红灯全部转绿；测试文件内不再有待修标记 |

`npm ci` 后 `packages/cli/src/index.ts`、`packages/mcp-memory/src/index.ts` 的 `M` 是 autocrlf 假改动，未提交（手册 §2）。

## 10. 遗留

1. **CFG-08 多用户边界**：按拍板只做 `doctor` 告警（`gateway.users` 非空时提示「遗留模式：原始 accessToken 仍可直通」）；`checkHttpAuth` / `login` / JWT 密钥派生 / token 轮换均未动 → **需专项**（同 §7）。
2. **CFG-11 展示面投影缓存**：暂缓。仅容器模式（三件套 env 齐全）触发，selfhost 不受影响；放开前需确认 `identityCompatRuntime.ts` 文件头「Never a display/sync cache」的安全语义可对展示面放松。
3. **CFG-07 之 `mcpServers.command` 允许范围**：只做了形状校验（`id` / `command` 字符串、`args string[]`、`env Record<string,string>`），未限定命令白名单；persona 限 HOME、cwd 非根 / 非系统目录已落地。多用户模式开启后此项需与 CFG-08 一并处理。
4. **CFG-24**（`efficiencyHookConfig` win32 tmp 名）不修；Windows 上 NOT RUN 的既有测试（symlink EPERM / POSIX 路径断言）不修；agents.yaml 写回丢注释 / 键序不修（`yaml.stringify(parse())` 语义，本文档已写明）。
5. **新发现 · `server.ts` 越过 biome `files.maxSize`**：基线 1,044,171 B → HEAD 1,049,188 B（LF 计），超过 biome 默认上限 1,048,576 B，`biome check packages`（`npm run lint`）对该文件改为报「file too large」并**跳过全部 lint / format / organizeImports**。memory 阶段 B 还会继续加行。建议 integration 合入时在 `biome.json` 加 `"files": { "maxSize": 2097152 }`（或拆分 server.ts —— 需专项）；本轮未改共享配置，留指挥官在 integration 上决定。
6. **既有文件的 pre-existing biome format 差异**未重排（避免无关大 diff）；`ProjectSettingsDialog.tsx` 两处 `useSemanticElements`、`SettingsCenter.tsx` 一处 `noNoninteractiveTabindex` 为上一轮 UI 审计（SET-12）的有意写法，未动。
7. **文档未同步项**：`openclaude.json` / `agents.yaml` 的字段级默认值与致命项口径（§2.1 表 + `parseOpenClaudeConfig`）尚未落到用户可见文档（`docs/` 配置说明）；`/api/agents` 响应 `mcpServers[].env → envKeys` 的契约变化需在前端接入 agent 级 MCP 编辑面时注意（当前 web 无消费）。
