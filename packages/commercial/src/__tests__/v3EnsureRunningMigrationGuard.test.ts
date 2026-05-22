/**
 * Phase 1.B — ensureRunning open-migration guard TDD placeholder。
 *
 * R6.11 §13.3 重写 `supervisor.ensureRunning(uid)` 必须 LEFT JOIN agent_migrations
 * 联合判定。本文件锁 reader 闸门两条:
 *   - INV-3 见 open migration → 503 'migration_in_progress'(不可绕开,reuse 路径 / cold start fallback 都必须遵守)
 *   - INV-4 reuse predicate 的 NOT EXISTS 半截:'active∨pending_apply' 已半截 locked(`v3EnsureRunning.test.ts:370` + `v3Supervisor.test.ts:1256-1366`),本文件补上 'NOT EXISTS open migration' 半截
 *
 * 与 v3MigrationLedger.test.ts INV-3 的区别:这里测的是**完整 reader 路径**
 * (ensureRunning 表达式 SQL + 503 抛错 + 调用栈),v3MigrationLedger.test.ts 锁的是
 * ledger 模块本身的 INSERT/SELECT/UPDATE 行为。两者拆开避免任何一条 invariant
 * 被另一边的红测意外染色。
 *
 * **Phase 2 完工硬门**:本文件不允许 ship 时仍含 `test.todo`。
 */

import { describe, test } from "node:test";

describe("v3 supervisor.ensureRunning — open-migration guard (R6.11 §13.3) — Phase 2 TDD placeholder", () => {
  test.todo(
    "INV-3: 用户在 migration 进行中重连 ensureRunning(uid) → 必须 throw HttpError 503 with code='migration_in_progress' + Retry-After=2;断言不调用 docker.startContainer / supervisor.startAndWait / scheduler.assign 等任何 docker side-effect 入口",
  );

  test.todo(
    "INV-4 (NOT EXISTS half): ensureRunning SELECT 必须 WHERE state IN ('active','pending_apply') AND NOT EXISTS (SELECT 1 FROM agent_migrations m WHERE m.agent_container_id = c.id AND m.phase NOT IN ('committed','rolled_back')) — 行为测试:active/pending_apply 但有 open migration 的行不能被 ensureRunning 视作 reusable",
  );
});
