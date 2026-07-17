/**
 * resolveTurnGoalState 二分语义单测(批D D8;2026-07-17 goal 停摆事故根治)。
 *
 * userChatBridge 转发前加载 goal 归因时的二分不变量:
 *   - loadGoalState 抛 GoalStateError(NOT_FOUND) → `_goalState:null` **放行**
 *     (会话行还不存在,目标不可能存在,归因仍可修复);
 *   - 抛其它任何错误 → **拒轮**(调用方发 GOAL_STATE_UNAVAILABLE),绝不静默降级为 null。
 * 两断言锁死这条二分,防未来把瞬态失败误当"无目标"放行(那会让本轮无 goal_id 落地、
 * 后续 durable 修复不可能)。
 *
 * 跑法:npx tsx --test packages/commercial/src/__tests__/goalStateResolution.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GoalStateSnapshot } from "@openclaude/protocol";

import { resolveTurnGoalState } from "../ws/userChatBridge.js";
import { GoalStateError } from "../goal/goalStateService.js";

const UID = 42n;
const SESSION = "c-sess-goal";

test("NOT_FOUND → 放行(kind:ok, goalState:null)", async () => {
  const resolved = await resolveTurnGoalState(
    async () => {
      throw new GoalStateError("NOT_FOUND", "client_sessions row absent");
    },
    UID,
    SESSION,
  );
  assert.deepEqual(resolved, { kind: "ok", goalState: null });
});

test("瞬态错误(非 GoalStateError)→ 拒轮(kind:unavailable),原始 err 透传给调用方", async () => {
  const boom = new Error("pg read timeout");
  const resolved = await resolveTurnGoalState(
    async () => {
      throw boom;
    },
    UID,
    SESSION,
  );
  assert.equal(resolved.kind, "unavailable");
  assert.equal(
    (resolved as { kind: "unavailable"; err: unknown }).err,
    boom,
    "拒轮时必须透传原始 err 供调用方日志/回滚",
  );
});

test("GoalStateError 但 code≠NOT_FOUND(如 CONFLICT/INVALID)→ 拒轮,绝不误当放行", async () => {
  for (const code of ["CONFLICT", "INVALID"] as const) {
    const resolved = await resolveTurnGoalState(
      async () => {
        throw new GoalStateError(code, `goal ${code}`);
      },
      UID,
      SESSION,
    );
    assert.equal(
      resolved.kind,
      "unavailable",
      `GoalStateError(${code}) 只有 NOT_FOUND 放行,其余必须拒轮`,
    );
  }
});

test("成功加载 → 透传真实快照(kind:ok, goalState=snapshot)", async () => {
  const snapshot = { objective: "ship", status: "active" } as unknown as GoalStateSnapshot;
  const resolved = await resolveTurnGoalState(async () => snapshot, UID, SESSION);
  assert.deepEqual(resolved, { kind: "ok", goalState: snapshot });
});

test("成功加载但目标为 null(会话有行、无目标)→ 放行且 goalState:null", async () => {
  const resolved = await resolveTurnGoalState(async () => null, UID, SESSION);
  assert.deepEqual(resolved, { kind: "ok", goalState: null });
});
