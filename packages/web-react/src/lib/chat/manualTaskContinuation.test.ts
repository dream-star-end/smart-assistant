import { describe, expect, test } from "vitest";
import type { ChatMessage } from "./model";
import { manualTaskContinuationSource, taskContinuationPrompt } from "./manualTaskContinuation";

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
  test("ordinary manual continuation includes the goal as context and forbids repeating completed work", () => {
    const prompt = taskContinuationPrompt("部署并验证版本A");
    expect(prompt).toContain("不要重新执行已经完成的步骤");
    expect(prompt).toContain("部署并验证版本A");
    expect(prompt).not.toBe("部署并验证版本A");
  });
});
