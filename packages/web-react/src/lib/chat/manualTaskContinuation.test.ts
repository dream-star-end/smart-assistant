import { describe, expect, test } from "vitest";
import { getUserError } from "@openclaude/protocol/browser";
import { splitStoppedNarration } from "../../components/chat/turnSegment";
import type { ChatMessage } from "./model";
import { canonicalTaskContinuationError, collectRecoveredTurnStatusRecordIds, manualTaskContinuationSource, taskContinuationPrompt } from "./manualTaskContinuation";

describe("t1360u every interrupted task continues in its original conversation", () => {
  test("zero output and partial work resolve the exact same latest source", () => {
    for (const code of ["model_authority_expired", "idle_timeout", "engine_error", "insufficient_credits", "auth_error", "context_too_long", "dispatch_not_accepted"]) {
      for (const output of [[], [{ id: "work", role: "assistant", text: "已完成第一步", ts: 2 }]]) {
        const user = { id: "u1", role: "user", text: "原任务", ts: 1 } as ChatMessage;
        const error = { id: "e1", role: "assistant", text: "", ts: 3, _errorCode: code, _clientMessageId: "u1" } as ChatMessage;
        expect(manualTaskContinuationSource([user, ...output as ChatMessage[], error], error)).toBe(user);
      }
    }
  });
  test("a historical, mismatched or missing source cannot continue another task", () => {
    const user = { id: "u1", role: "user", text: "原任务", ts: 1 } as ChatMessage;
    const error = { id: "e1", role: "assistant", text: "", ts: 2, _clientMessageId: "u1" } as ChatMessage;
    expect(manualTaskContinuationSource([user, error, { ...user, id: "u2" }], error)).toBeUndefined();
    expect(manualTaskContinuationSource([user, { ...error, _clientMessageId: "other" }], { ...error, _clientMessageId: "other" })).toBeUndefined();
    expect(manualTaskContinuationSource([error], error)).toBeUndefined();
  });
  test("a failed user row continues its own first or second goal", () => {
    const first = { id: "u1", role: "user", text: "首个目标", ts: 1, status: "error" } as ChatMessage;
    const second = { ...first, id: "u2", text: "第二个目标", ts: 2 } as ChatMessage;
    expect(manualTaskContinuationSource([first], first)).toBe(first);
    expect(manualTaskContinuationSource([first, second], second)).toBe(second);
    expect(manualTaskContinuationSource([first, second], first)).toBeUndefined();
  });
  test("an exhausted hidden recovery lineage continues the original human goal", () => {
    const root = { id: "u1", role: "user", text: "部署原目标", ts: 1 } as ChatMessage;
    const child = { ...root, id: "recovery", text: "INTERNAL_CONTROL", _recoveryOfClientMessageId: root.id };
    const error = { id: "e", role: "assistant", text: "", ts: 3, _clientMessageId: child.id } as ChatMessage;
    expect(manualTaskContinuationSource([root, child, error], error)).toBe(root);
    expect(manualTaskContinuationSource([child, error], error)).toBeUndefined();
  });
  test("only the latest terminal error continues; trailing transport records do not steal it", () => {
    const user = { id: "u", role: "user", text: "原目标", ts: 1 } as ChatMessage;
    const first = { id: "e1", role: "assistant", text: "", ts: 2, _errorCode: "engine_error" } as ChatMessage;
    const last = { ...first, id: "e2", ts: 3 };
    const transport = { id: "batch", role: "runtime-event", text: "", ts: 4 } as ChatMessage;
    expect(manualTaskContinuationSource([user, first, last, transport], first)).toBeUndefined();
    expect(manualTaskContinuationSource([user, first, last, transport], last)).toBe(user);
    expect(manualTaskContinuationSource([user, first, { ...last, _errorCode: undefined, text: "已经完成" }], first)).toBeUndefined();
  });
  test("a transport-only end status is not another interrupted task", () => {
    const user = { id: "u", role: "user", text: "原目标", ts: 1 } as ChatMessage;
    const error = { id: "e", role: "assistant", text: "已做完一半", ts: 2, _errorCode: "engine_error" } as ChatMessage;
    const status = { id: "status", role: "assistant", text: "本轮结束", ts: 3, _turnStatusRecord: true } as ChatMessage;
    expect(manualTaskContinuationSource([user, error, status], error)).toBe(user);
    expect(manualTaskContinuationSource([user, error, status], status)).toBeUndefined();
  });
  test("ordinary manual continuation includes the goal as context and forbids repeating completed work", () => {
    const prompt = taskContinuationPrompt("部署并验证版本A");
    expect(prompt).toContain("不要重新执行已经完成的步骤");
    expect(prompt).toContain("部署并验证版本A");
    expect(prompt).not.toBe("部署并验证版本A");
  });
});


describe("canonical continuation source integrity", () => {
  const stopped = () => {
    const user = { id: "human", role: "user", text: "原始部署目标", ts: 1 } as ChatMessage;
    const raw = { id: "narration", role: "assistant", text: "已经完成分析", ts: 2,
      _errorCode: "USER_CANCELLED", _clientMessageId: user.id } as ChatMessage;
    const tool = { id: "tool", role: "tool", text: "", ts: 3, _completed: true, _clientMessageId: user.id } as ChatMessage;
    const rows = [user, raw, tool];
    const view = splitStoppedNarration(rows).at(-1)!;
    return { user, raw, tool, rows, view };
  };
  test("only the real render projection maps to its raw stopped record and human goal", () => {
    const { user, raw, rows, view } = stopped();
    expect(view.id).toBe("narration:stopped");
    expect(view._continuationSourceId).toBe(raw.id);
    expect(canonicalTaskContinuationError(rows, view)).toBe(raw);
    expect(manualTaskContinuationSource(rows, view)).toBe(user);
    expect(raw._continuationSourceId).toBeUndefined();
    expect(Object.keys(view)).not.toContain("_continuationSourceId");
    expect(JSON.stringify(view)).not.toContain("_continuationSourceId");
    const serialized = JSON.parse(JSON.stringify(view)) as ChatMessage;
    expect(canonicalTaskContinuationError(rows, serialized)).toBeUndefined();
    const forged = { ...view, _continuationSourceId: raw.id };
    expect(canonicalTaskContinuationError(rows, forged)).toBeUndefined();
    expect(manualTaskContinuationSource([...rows, forged], forged)).toBeUndefined();
  });
  test("a missing, foreign-owned or superseded stop source never continues", () => {
    const { user, raw, tool, rows, view } = stopped();
    expect(manualTaskContinuationSource([user, tool], view)).toBeUndefined();
    const replacement = { ...raw };
    expect(canonicalTaskContinuationError([user, replacement, tool], view)).toBe(replacement);
    expect(manualTaskContinuationSource([user, replacement, tool], view)).toBe(user);
    expect(manualTaskContinuationSource([user, { ...raw, _clientMessageId: "foreign" }, tool], view)).toBeUndefined();
    expect(manualTaskContinuationSource([user, { ...raw, _errorCode: "engine_error" }, tool], view)).toBeUndefined();
    expect(manualTaskContinuationSource([...rows, { ...user, id: "new-human" }], view)).toBeUndefined();
    expect(manualTaskContinuationSource([...rows, { ...raw, id: "later-terminal" }], view)).toBeUndefined();
    view._clientMessageId = "foreign";
    expect(manualTaskContinuationSource(rows, view)).toBeUndefined();
  });
  test("the Master's root-owned give-up card survives hidden parallel recovery attempts", () => {
    const user = { id: "root", role: "user", text: "保留这个原目标", ts: 1 } as ChatMessage;
    const first = { ...user, id: "attempt-1", text: "CONTROL_1", _recoveryOfClientMessageId: user.id };
    const last = { ...user, id: "attempt-2", text: "CONTROL_2", _recoveryOfClientMessageId: user.id };
    const childError = { id: "child-error", role: "assistant", text: "", ts: 3,
      _errorCode: "engine_error", _clientMessageId: last.id } as ChatMessage;
    const giveup = { id: "giveup", role: "assistant", text: "自动恢复已停止", ts: 4,
      _userError: getUserError("automatic_retry_exhausted"), _clientMessageId: user.id } as ChatMessage;
    const rows = [user, first, last, childError, giveup];
    expect(manualTaskContinuationSource(rows, giveup)).toBe(user);
    expect(manualTaskContinuationSource(rows, childError)).toBeUndefined();
    expect(manualTaskContinuationSource([first, last, childError, giveup], giveup)).toBeUndefined();
    expect(manualTaskContinuationSource([user, { ...user, id: "unrelated" }, first, last, childError, giveup], giveup)).toBeUndefined();
    const foreign = { ...giveup, _clientMessageId: "unrelated" };
    expect(manualTaskContinuationSource([...rows.slice(0, -1), foreign], foreign)).toBeUndefined();
    const sibling = { ...giveup, _clientMessageId: first.id };
    expect(manualTaskContinuationSource([...rows.slice(0, -1), sibling], sibling)).toBeUndefined();
    expect(manualTaskContinuationSource([user, { ...last, _recoveryOfClientMessageId: last.id }, giveup], giveup)).toBeUndefined();
    expect(manualTaskContinuationSource([...rows, { ...user, id: "new-human" }], giveup)).toBeUndefined();
    expect(manualTaskContinuationSource([...rows, { ...childError, id: "later-terminal" }], giveup)).toBeUndefined();
  });
});


describe("dispatch status owns its hidden duplicate error", () => {
  const user = { id: "dispatch-human", role: "user", text: "原始目标", ts: 1 } as ChatMessage;
  const status = { id: "turn-status:dispatch-human", role: "system", text: "", ts: 2, _source: "server",
    _turnStatusRecord: true, _dispatchTerminal: true, _errorCode: "dispatch_lost", _clientMessageId: user.id } as ChatMessage;
  const duplicate = { id: "duplicate-error", role: "assistant", text: "", ts: 3,
    _errorCode: "ENGINE_ERROR", _clientMessageId: user.id } as ChatMessage;

  test("the visible canonical status can continue before its renderer-suppressed empty error", () => {
    expect(manualTaskContinuationSource([user, status, duplicate], status)).toBe(user);
    expect(manualTaskContinuationSource([user, status, { ...duplicate, text: "  " }], status)).toBe(user);
    expect(canonicalTaskContinuationError([user, status, duplicate], status)).toBe(status);
  });
  test("new tasks, other owners, real answers and newer statuses still revoke the old status", () => {
    const blockers: ChatMessage[] = [
      { ...user, id: "new-human" },
      { ...duplicate, _clientMessageId: "foreign-owner" },
      { ...duplicate, _clientMessageId: undefined },
      { ...duplicate, text: "真实部分回答" },
      { ...duplicate, _errorCode: undefined, _userError: getUserError("engine_error") },
      { ...status, id: "later-status", ts: 4 },
    ];
    for (const blocker of blockers) {
      expect(manualTaskContinuationSource([user, status, blocker], status)).toBeUndefined();
    }
    for (const invalid of [{ ...status, _source: undefined }, { ...status, _dispatchTerminal: false },
      { ...status, _errorCode: undefined }, { ...status, role: "assistant" as const }]) {
      expect(manualTaskContinuationSource([user, invalid, duplicate], invalid)).toBeUndefined();
    }
  });
  test("a status suppressed by actual server output cannot claim the later empty error", () => {
    const answer = { id: "actual-answer", role: "assistant", text: "实际回答", ts: 2,
      _clientMessageId: user.id, _source: "server" } as ChatMessage;
    expect(manualTaskContinuationSource([user, status, answer, duplicate], status)).toBeUndefined();
    expect(manualTaskContinuationSource([user, status, answer, duplicate], duplicate)).toBe(user);
  });
});

describe("recovery dispatch statuses remain raw while their intermediate view collapses", () => {
  test.each(["previous", "root"] as const)("%s recovery lineage keeps only the last empty status, without rewriting 33 rows", (parent) => {
    const rows: ChatMessage[] = [];
    for (let attempt = 0; attempt <= 10; attempt++) {
      const id = `failed-${attempt}`;
      rows.push({ id, role: "user", text: attempt ? "RECOVERY_CONTROL" : "原始目标", ts: attempt * 3,
        ...(attempt ? { _recoveryOfClientMessageId: parent === "root" ? "failed-0" : `failed-${attempt - 1}`, _recoveryMode: "replay" as const,
          _automaticRecovery: true, _automaticRecoveryRootClientMessageId: "failed-0",
          _automaticRecoveryAttempt: attempt, _automaticRecoveryMax: 10 } : {}) },
      { id: `turn-status:${id}`, role: "system", text: "", ts: attempt * 3 + 1, _source: "server",
        _turnStatusRecord: true, _dispatchTerminal: true, _errorCode: "dispatch_lost", _clientMessageId: id },
      { id: `error-${id}`, role: "assistant", text: "", ts: attempt * 3 + 2,
        _errorCode: "ENGINE_ERROR", _clientMessageId: id });
    }
    const before = JSON.stringify(rows);
    expect([...collectRecoveredTurnStatusRecordIds(rows)]).toEqual(
      Array.from({ length: 10 }, (_, attempt) => `turn-status:failed-${attempt}`));
    expect(manualTaskContinuationSource(rows, rows[31])).toBe(rows[0]);
    expect(JSON.stringify(rows)).toBe(before);
    expect(rows).toHaveLength(33);
  });
  test("independent tasks, missing/cyclic or interrupted ancestry, unknown owners and real work stay visible", () => {
    const root = { id: "root-status-task", role: "user", text: "原目标", ts: 1 } as ChatMessage;
    const status = { id: "root-status", role: "system", text: "", ts: 2, _source: "server",
      _turnStatusRecord: true, _dispatchTerminal: true, _errorCode: "dispatch_lost", _clientMessageId: root.id } as ChatMessage;
    const child = { ...root, id: "recovery-child", text: "CONTROL", _recoveryOfClientMessageId: root.id };
    expect(collectRecoveredTurnStatusRecordIds([root, status, child])).toEqual(new Set([status.id]));
    for (const rows of [
      [root, status, { ...root, id: "independent" }],
      [status, child],
      [root, status, { ...child, _recoveryOfClientMessageId: child.id }],
      [root, status, { ...root, id: "independent" }, child],
      [root, { ...status, _clientMessageId: "unknown" }, child],
      [root, { ...status, text: "真实状态内容" }, child],
      [root, { ...status, _source: undefined }, child],
      [root, { ...status, _dispatchTerminal: false }, child],
    ]) expect(collectRecoveredTurnStatusRecordIds(rows)).toEqual(new Set());
    for (const work of [
      { id: "paid-answer", role: "assistant", text: "保留部分回答", _errorCode: "ENGINE_ERROR", ts: 3 },
      { id: "paid-thinking", role: "thinking", text: "已完成分析", ts: 3 },
      { id: "paid-tool", role: "tool", text: "", _completed: true, ts: 3 },
    ] as ChatMessage[]) {
      expect(collectRecoveredTurnStatusRecordIds([root, status, { ...work, _clientMessageId: root.id }, child])).toEqual(new Set());
    }
  });
});
