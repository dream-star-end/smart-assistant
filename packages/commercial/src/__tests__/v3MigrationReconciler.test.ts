/**
 * Phase 1.B — agent_migrations reconciler TDD placeholder。
 *
 * R6.11 §14.2.6 reconciler 在仓内**尚未存在**。本文件锁三条 reader-单点 invariant:
 *   - INV-2 open migration 期间 docker start 单点归 reconciler(reader 路径不允许独立 docker start)
 *   - INV-7 reconciler 在 phase='attached_route' 恢复时**必须重发 routing ACK** 才能 docker start + commit
 *   - INV-10 planned phase 兜底 — phase='planned' + ledger.new_container_internal_id IS NULL
 *     + updated_at 超过 migrateSec 时,reconciler 必须 markMigration('rolled_back') +
 *     (paused_at 非空时)unpause 旧容器;agent_containers 行 state/host_id 不动;新 host
 *     可能残留 created-not-started docker 容器 → 交给独立的 §3H docker orphan reconciler 兜底
 *     (本文件**不**测 docker 残留清理,那条路径与 ledger reconciler 是两套不同 sweep,
 *     R6.11 §14.2.6 设计明确划分;参 02-DEVELOPMENT-PLAN.md:1935-1948)。
 *
 * INV-7 是 R6.11 整套 fix 的高风险点 —— 老 attached_route 恢复路径直接 docker start
 * 跳 routing ACK 屏障(R6.9 主契约被打穿)。Phase 2 此处必须由 reconciler 显式
 * INCREMENT host_state_version → NOTIFY → pollHostAgentApplyVersion → 再 docker start。
 *
 * **不混淆**:老 `v3OrphanReconcile.test.ts:286` 测的是 v2 direction-B 行为
 * (`agent_containers.container_internal_id IS NULL → 不 inspect / 不 vanish`),那是
 * `agent_containers` 表的字段,与 R6.11 `agent_migrations.new_container_internal_id`
 * 完全不同字段。Phase 2 落地 INV-10 时**不**翻转 v3OrphanReconcile.test.ts:286 —
 * 那个测试行为不动,继续锁 v2 direction-B 语义。
 *
 * **Phase 2 完工硬门**:本文件不允许 ship 时仍含 `test.todo`(同 v3MigrationLedger.test.ts)。
 */

import { describe, test } from "node:test";

describe("v3 agent_migrations reconciler — Phase 2 TDD placeholder (R6.11 §14.2.6)", () => {
  test.todo(
    "INV-2: open migration 期间 docker start 调用单点归 reconciler;断言 supervisor.startAndWait / docker.startContainer spy 在非 reconciler 调用点的计数 == 0(open migration 持续期间任何 reader 入口都不允许触发 docker start)",
  );

  test.todo(
    "INV-7: reconciler attached_route 恢复必须先重发 routing ACK 才 docker start — 断言调用顺序 INCREMENT host_state_version → NOTIFY → pollHostAgentApplyVersion(通过)→ docker start → markMigration('committed');spy 验顺序而非仅次数",
  );

  test.todo(
    "INV-10: planned 兜底 — phase='planned' + agent_migrations.new_container_internal_id IS NULL + updated_at > migrateSec → reconciler 必须 markMigration('rolled_back') + (paused_at 非空时)unpause old container;断言 agent_containers row state/host_id 全程不动;新 host docker create 残留交 §3H docker orphan 兜底,本测试**不**断言 docker 侧清理(那是另一条 sweep 路径,与 ledger reconciler 解耦,见 02-DEVELOPMENT-PLAN.md:1935-1948)",
  );
});
