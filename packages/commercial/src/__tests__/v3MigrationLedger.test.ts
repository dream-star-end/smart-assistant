/**
 * Phase 1.B — agent_migrations ledger TDD placeholder。
 *
 * R6.11 设计的 `agent_migrations` ledger 在仓内**尚未存在**(Phase 1 audit 关键发现,
 * 见 `PHASE1-TEST-COVERAGE-PLAN.md` "背景与重大重构判定")。Phase 2 将按 TDD
 * 序对建设:每个 `test.todo` 在 Phase 2 用同名 `test()` 替换 — 红测先于实现。
 *
 * 本文件锁的不变量(R6.11 §13.3 / §14.2.4 / §14.2.6 引用):
 *   - INV-3 ensureRunning 见 open migration → 503 'migration_in_progress'
 *   - INV-5 ensureRunning SQL LEFT JOIN agent_migrations
 *   - INV-6 ledger INSERT 在 phase='planned'(pickHost 之后,任何 IO 之前)
 *   - INV-8 ⑥f 超时不回滚 state / host_id,只 force-rm 旧 paused
 *
 * **Phase 2 完工硬门**:本文件不允许 ship 时仍含 `test.todo` —
 * Phase 1.B 的 placeholder 是给 Phase 2 红测预占的"待填行",
 * Phase 2 完成对应 ledger 子模块的 implementation 后必须把每个 todo 转为
 * 真 test()(描述里写的"期望"必须在测试体里被断言、跑过)。
 */

import { describe, test } from "node:test";

describe("v3 agent_migrations ledger — Phase 2 TDD placeholder (R6.11)", () => {
  test.todo(
    "INV-3: ensureRunning 见 open migration(phase ∈ planned/created/detached/attached_pre/attached_route/started) → throw HttpError(503, 'migration_in_progress', Retry-After=2);绝不返回 {host,port},绝不 docker start",
  );

  test.todo(
    "INV-5: ensureRunning SELECT 显式 LEFT JOIN agent_migrations ON agent_container_id 且 WHERE phase NOT IN ('committed','rolled_back') — open migration 行被 ledger 单点拦截",
  );

  test.todo(
    "INV-6: agent_migrations.INSERT 在 phase='planned' 时机点 = §14.2.4 ①bis(pickHost 之后,任何 rsync/freeze/create 之前);planned 行 paused_at IS NULL + new_container_internal_id IS NULL",
  );

  test.todo(
    "INV-8: §14.2.4 ⑥f routing ACK 超时分支不回退 state / host_id;只 force-rm 旧 paused 容器,留 phase='attached_route',等 §14.2.6 reconciler 推前;尤其断言 host_id 字段在 ⑥f 超时前后保持 new(不回滚)",
  );
});
