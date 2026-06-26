# P1f — 去 codex 结构性清理(执行计划)

> 目标:v5 商业版彻底移除**产品运行时**的 codex(gpt)路径,只保留 ccb(claude + 域名模型 glm/deepseek/minimax)。
> 注意:开发流程的 Codex(gpt-5.5)评审质量门**不在**删除范围。
>
> **状态(2026-06-26)**:已做 — ① 运行时镜像 ccb-only(v5-ccb 镜像不含 @openai/codex);② 模型面 `dropGptForV5Channel`(v5 public models 去 gpt);③ codex 路径全加 channel 过滤(P1d 过渡防御);④ 删纯 ops 脚本(codex-auth-audit/rewrite)。**待做**:runtime 代码删除(下列分片)。

## 关键约束(必须遵守)

1. **worktree 隔离**:v3 树 `/opt/openclaude/openclaude-v3`(v3 分支)独立 checkout,删 v5 分支 codex **不影响 v3 现网**(v3 仍 serve gpt-5.5)。
2. **高风险:不能整删的共享代码(只能"改造")**:
   - `agent-sandbox/v3supervisor.ts` import `internalCodexRelay`(buildCodexRelayLocalBaseUrl/readCodexUpstreamBaseUrl)+ `codex-auth/codexAuthFile`(writeCodexContainerAuthFile)→ v3supervisor 是容器供给共享代码,v5 也跑;删这俩文件会断 v3supervisor 编译。
   - `account-pool/codexEgress.ts` 被 `refresh.ts`(账号刷新,共享)依赖。
   - `@openclaude/protocol` 的 codex 字段(conversationMode/requestId/OutboundCodexBilling*)**红线不删**(master/v3 wire 向后兼容;v5 container 永不发,master 见到忽略)。
3. **不破坏已跑通的 v5 canary**:glm-5.2 真实对话链路(WS bridge→ensureRunning→容器→proxy→火山ark)+ ccb/标准计费(outbound.cost_charged)不能因删 codex 受损。
4. **高风险:删的是 v3 现网在用的 gpt-5.5 功能** → 删 runtime 代码前与 boss 定时机。
5. **每片独立 typecheck 通过 + Codex 审 + 不在超大上下文里硬塞**(逐片 fresh 上下文)。

## 分片(每片可独立 typecheck + 测试,避免大爆炸)

### 片 1 — 纯 codex 控制面 actor(v5 本就 controlPlaneEnabled=false 不跑)
删:`account-pool/codexAccountActor.ts`、`account-pool/codexDisableFanout.ts`(含 startCodexDisableDriftReconciler)、`account-pool/codexLazyMigrate.ts` + 各自 test。
改:`index.ts` 去 import + startCodexRefreshActor/codexDriftReconciler 启动(~90/1812/3015)+ enabledSchedulers(3120/3125)+ shutdown(3210/3225);`http/internalCodexTokenRefresh.ts`(依赖 codexLazyMigrate)同片处理或先 stub。
注意:codexAccountActor 仅 index 引用(干净);codexLazyMigrate 被 codexDisableFanout + internalCodexTokenRefresh + index codex route(~2827)引用 → 须一并处理。

### 片 2 — runner seam 收敛(核心)
删:`gateway/codexRunner.ts`、`gateway/codexAppServerRunner.ts`、`gateway/v3CodexRelay.ts` + test。
改:`gateway/sessionManager.ts` 1245-1290 删 codex-native 分支,所有 agent 无条件走 SubprocessRunner(保留 1236-1243 v5 不变量作兜底)。
注意:`gateway/codexLaunchOverrides.ts` 的 `buildOpenClaudeVisionMcpEnv` 被 `subprocessRunner.ts` re-export → 先把该函数实现搬进 subprocessRunner 再删 codexLaunchOverrides。

### 片 3 — 模型推断去 gpt
改:`gateway/inferAgentForModel.ts` 删 gpt-*→codex 路由(87-108),gpt-* 直接 error;`gateway/promptSlots.ts` 删 codex 分支(207-220 / 842-854)。
删:`gateway/codexAutoPlanMode.ts`、`gateway/codexAuthSync.ts` + test;`server.ts` 去对应 import/hook(~1214/1222/1268)。

### 片 4 — commercial index codex 初始化 + billing(高风险,共享)
改:`index.ts` codex billing finalizer/三件套/codexBinding/codexRoute(~234-248/2953-3027)条件化删;`ws/userChatBridge.ts` 删 codexFinalizer 分支(65,~billing settle)——**务必只删 codex 分支,保 ccb/标准计费**。
删:`billing/codexFinalizer.ts` + test。
保留(改造/条件化,v3supervisor/refresh 依赖):`http/internalCodexRelay.ts`、`codex-auth/codexAuthFile.ts`、`codex-auth/remoteCodexAuth.ts`、`account-pool/codexEgress.ts` —— v5 下不装配 handler / 不走分支,但文件留(供 v3supervisor 编译 + 容器共享)。或后续把 v3supervisor 的 codex 注入也 channel 化剥离,届时再整删。

### 片 5 — 前端去 gpt(web/public/modules)
改:`modelPolicy.js`(删 isGptModel/isCodexNativeAgent + gpt-*→codex)、`main.js`(删 codex-native 默认推断)、`agentTeams.js`、`admin.js`(去 codex provider 选项)、`oauth.js`(去 codex oauth 分支)。纯表现层,后端有兜底。

### 片 6 — 收尾
迁移文件(0054/0076 codex 相关)保留仅标注遗留;清剩余悬空 test;`npm run check` 全绿;确认 v3 树仍编译(无污染)。

## 每片 QA
typecheck → test:gateway / test:commercial:unit → lint(scheduler-wiring 检查 enabledSchedulers 无悬空)→ Codex 审至 PASS → OC_RUNTIME_CHANNEL=v5 启动验证 codex actor 未启 + v5 canary 对话仍通。
