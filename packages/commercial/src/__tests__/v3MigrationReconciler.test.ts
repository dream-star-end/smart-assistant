/**
 * Phase 1.B — agent_migrations reconciler TDD placeholder。
 *
 * R6.11 §14.2.6 reconciler 在仓内**尚未存在**。本文件锁三条 reader-单点 invariant:
 *   - INV-2 open migration 期间 docker start 单点归 reconciler(reader 路径不允许独立 docker start)
 *   - INV-7 reconciler 在 phase='attached_route' 恢复时**必须重发 routing ACK** 才能 docker start + commit
 *   - INV-10 orphan sweep 处理 new_container_internal_id=NULL 的 planned 行(老 v3OrphanReconcile.test.ts:286 行为反转)
 *
 * INV-7 是 R6.11 整套 fix 的高风险点 —— 老 attached_route 恢复路径直接 docker start
 * 跳 routing ACK 屏障(R6.9 主契约被打穿)。Phase 2 此处必须由 reconciler 显式
 * INCREMENT host_state_version → NOTIFY → pollHostAgentApplyVersion → 再 docker start。
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
    "INV-10: orphan sweep 处理 planned 行 new_container_internal_id IS NULL — 老 v3OrphanReconcile.test.ts:286 测试 'NULL cid → skip',R6.11 要求 'NULL cid + planned + age > 1h → 兜底回收 + ledger 标 rolled_back';本测试反转该期望",
  );
});
