/**
 * Phase 1.B — warm pool ACK barrier TDD placeholder (INV-9)。
 *
 * **重要**:本文件**从 Phase 2 完工硬门中显式 carve out**(`PHASE1-TEST-COVERAGE-PLAN.md`
 * v3 修订 #2 + 1.D 表 2h 删除)。理由:warm pool 子系统本身 dormant(`v3_node_agent_dormant.md`
 * memory),Phase 2 不动它,转 real test 推迟到 **Phase 5**(warm pool 真正实装时)。
 *
 * 本文件依然在 Phase 1.B 创建,目的是把不变量"提前登记"到 placeholder 系统,避免
 * 未来 warm pool 上线时遗漏 ACK barrier 这一关键约束 — 这是 R6.11 设计里少数没在
 * 当前路径出现的 invariant,放占位让 Phase 5 不至于忘掉。
 *
 * **Phase 2 完工硬门**:**不**适用本文件。Phase 2 ship 时本文件可以仍含 `test.todo`,
 * 由 Phase 5 转为真 test()。
 */

import { describe, test } from "node:test";

describe("v3 warm pool — ACK barrier (R6.11 INV-9) — Phase 5 TDD placeholder (Phase 2 carve-out)", () => {
  test.todo(
    "INV-9: warm pool 消费需 ACK barrier — pool 消费侧从 prewarm slot 拉取容器后,必须等 host-agent ACK 通过(pollHostAgentApplyVersion)才能交给 ensureRunning 路径放流量;断言 ACK 未通过时返回伪 503 / 触发重试,而非提前 docker exec / docker start",
  );
});
