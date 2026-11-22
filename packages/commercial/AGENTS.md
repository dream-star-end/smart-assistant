# `packages/commercial` Master / Egress 改码硬纪律

> 完整开发与治理手册见 `docs/V5_SELFHOST_PLAYBOOK.md`；商业版专有发布见 `docs/V5_DEV_PLAYBOOK.md`；仓库导航见 `AGENTS.md`。

## 1. 架构分层与单权威边界

- **L0–L6 单向分层与作用域**：所有生产文件必须登记在 `arch/modules.json` 对应层与 `master`/`egress` 作用域内，严禁向上依赖、非法同层耦合或跨包相对路径导入（必须走 `@openclaude/<pkg>`）。
- **单权威源**：
  - 计费/积分/结算仅由 `packages/commercial/src/billing/` 权威模块写入，严禁业务层散写计费 SQL（`R3-billing-sql`）。
  - 会话存储权威启动经 `packages/commercial/src/db/sessionsStoreAuthority.ts` 四元组矩阵 fail-closed 裁决（Selfhost `OC_SESSIONS_STORE=pg`）。
  - 平台能力基线单一权威在 `packages/commercial/agent-sandbox/platform-runtime/prompts/platform-capabilities.md`，严禁用 user skill shadow 替代修复平台基线。
  - 环境变量统一走配置权威模块，调度器统一登记（`npm run lint:scheduler-wiring`）。
- **多租户路由三处同步（硬门）**：任何暴露给容器的 memory/internal 敏感子路由，必须在以下三处保持精确一致，漏配即多租户越权：
  1. `packages/gateway/src/server.ts`
  2. `packages/gateway/src/bridgeApiAllowlist.ts`
  3. `packages/commercial/src/http/router.ts`（`BLOCKED_FOR_USER_RULES`）

## 2. 强模型主权、数据库迁移与高可靠纪律

- **禁弱模型暗降（第一红线）**：主脑、`/btw`、Cron、`ai_review` 严禁静默降级至弱模型；仅允许明确登记的纯杂务（标题/索引等）或用户显式选择（`npm run check:no-weak-downgrade`）。
- **PG 迁移安全与 REST 契约兼容（已入 PR CI）**：新增 SQL 迁移（`packages/commercial/src/db/migrate.ts`）前必须自答「旧活跃实例兼容？是否锁表？回滚后旧码可读？」；强制 Expand-Contract 两步迁移，严禁未经人工审签的破坏性/锁表 DDL，必跑 `npm run lint:migration-order`、`npm run check:pg-migration-safety -- --base origin/feat/v5-selfhost`、`scripts/v5-selfhost-migration-precheck.sh`、`scripts/v5-selfhost-migration-compat-check.sh`；涉核心 5 域 REST 接口同步更新 `packages/protocol/src/httpContracts.ts` 与 `packages/protocol/rest-contract-snapshot.json` 并过 `npm run check:rest-contract`。
- **高可靠 SQL 与错误处理**：`ON CONFLICT (k) DO UPDATE ... WHERE` 守卫仅能比对冲突键 `k` 函数决定的列，且 `RETURNING` 0 行必区分守卫假与行不存在；跨层失败用结构化可重试标记，禁止正则匹配错误字符串；永久失败绝不重连/重试循环；遵循 `npm run lint:agent-containers-sql`。
- **Feature Flag 与 `changelog.json`**：所有活跃 Selfhost Flag 须登记在 `deploy/v5/feature-flags-registry.json`（个人版默认 TTL ≤30 天，上线即直切 `enforce` + 判停秒回）；`changelog.json` 仅人类可改（`npm run check:changelog-guard`）。
- **测试真结果与梯队登记**：新增 `*.integ.test.ts` 必须登记进 `.github/integ-tiers/`；测试须经真实入口断言账务/状态终态，禁无保护静默 retry（`npm run check:test-retries`）。

## 3. 本地秒级验证命令

- **架构与红线快门（`<10s`）**：
  - `npx tsx scripts/check-architecture.ts --enforce`
  - `npm run check:route-sync && npm run check:no-weak-downgrade && npm run check:feature-flags-ttl && npm run check:changelog-guard && npm run check:rest-contract`
  - `npm run check:pg-migration-safety -- --base origin/feat/v5-selfhost && npm run lint:scheduler-wiring && npm run lint:agent-containers-sql && npm run lint:migration-order && npm run lint:integ-tiers && npm run check:test-retries`
- **单测与构建**：
  - `npm run test:commercial:unit:gate`（Master/Egress 单元门）& `npm run test:storage`（`selfhost-storage` 已入 PR CI）
  - 涉 `node-agent` 跑 `npm run build:node-agent`
  - 涉共享协议/容器交互补跑 `node packages/cli/scripts/build-container-gateway.mjs`
