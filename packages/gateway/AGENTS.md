# `packages/gateway` 容器 Gateway 改码硬纪律

> 完整架构与自治闭环手册见 `docs/V5_SELFHOST_PLAYBOOK.md`；仓库路由见 `AGENTS.md`。

## 1. 强模型主权与 6 引擎适配边界

- **强模型主权（第一红线）**：主对话、`/btw` 快问、Cron 定时任务、`ai_review` 一律保持用户或系统显式指定的强模型，**严禁在任何执行/回退/默认分支偷偷降级到弱模型**；轻量模型仅限明确隔离的无决策杂务（如会话标题/索引）或用户手动显式切换（`npm run check:no-weak-downgrade`）。
- **6 引擎适配隔离**：`packages/gateway/src/engine/` 统一承载 6 引擎适配（Claude/CCB `ccbAdapter.ts`、Codex `codexAdapter.ts`、Antigravity `antigravityAdapter.ts`、Cursor `cursorAdapter.ts`/`cursorRoutingAdapter.ts`、Grok `grokAdapter.ts`、ZCode `zcodeAdapter.ts`）；引擎协议细节严禁外泄到通用调度层，跨包引用一律走 `@openclaude/<pkg>`（禁相对路径穿包）。
- **单权威提示词**：`packages/gateway/src/promptSlots.ts` 的 fallback 必须与平台权威 `packages/commercial/agent-sandbox/platform-runtime/prompts/platform-capabilities.md` 保持语义一致，严禁双写分叉导致能力误拒。

## 2. 执行端安全、存储 sidecar 与缓存契约

- **顾问与只读角色执行端硬禁写**：`advisor`、`auditor`、`verifier` 与只读诊断角色的无写/无执行/无 `skill_save`/无嵌套委派约束**必须在执行层工具白名单硬拦截**（`packages/protocol/src/advisorNoWrite.ts`、`packages/gateway/src/actionPolicyEngine.ts`、`packages/protocol/src/actionPolicy.ts`），绝不只靠 prompt 约束；无法证明执行端限制生效的引擎禁止开放为顾问。
- **外部动作与 Plan Mode 边界**：严格执行 `action-policy` 四档策略（`allow` / `ai_review` / `human_approval` / `deny`）；`EnterPlanMode` 必经用户明确同意。
- **容器 SQLite sidecar 分层**：`sessions.db`、`taskboard.db`、`delegate-jobs.db`、`delegate-inflight-surface.db` 为设计内本地存储层，**严禁运行中删除或移动 `sessions.db`**（防 WAL 撕裂与重启静默建空库假绿）；所有 upsert 守卫遵守冲突键函数依赖，失败统一走结构化可重试分类。
- **Box 与 Antigravity 缓存稳定**：Box 路由坚持走 Box（不建议直连）；维护会话级提示词冻结（`packages/gateway/src/promptFreeze.ts`）与 Antigravity 续轮去重（`packages/gateway/src/engine/resumedEnvelopeDedup.ts`）及固定 `launchHome`，保护高前缀缓存命中率。
- **`remote-driver-v4` 与路由三处同步**：策略变更必须同步更新 `policySha256`，`readOnly` 走 fail-closed 白名单，`cc5-att-us` 固定端口 `22022`；任何暴露在 `packages/gateway/src/server.ts` 的敏感/memory 子路由必须与 `packages/gateway/src/bridgeApiAllowlist.ts` 及 `packages/commercial/src/http/router.ts`（`BLOCKED_FOR_USER_RULES`）三处同步（`npm run check:route-sync`）。

## 3. 本地秒级验证与必跑构建

- **改码快门（`<10s`）**：
  - `npm run check:no-weak-downgrade && npm run check:route-sync`
  - `npx tsx scripts/check-architecture.ts --enforce`
- **提交前必跑构建与单测**：
  - `node packages/cli/scripts/build-container-gateway.mjs`（验证容器运行时打包零断链）
  - `npm run test:gateway`（核心单测；涉协议/存储同时跑 `npm run test:protocol && npm run test:storage`）
  - 涉 Box 上下文与恢复补跑 `npm run test:ccb:box-context`
