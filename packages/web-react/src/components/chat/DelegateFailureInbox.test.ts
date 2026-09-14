import { expect, test } from "vitest";
import { knownFailureParentId, sessionFailureDiagnostics } from "./DelegateFailureInbox";
import { parseFailurePage } from "../../lib/delegateFailures";
import type { Session } from "../../lib/types";

const sessions: Session[] = [{ id: "client-a", agentId: "main", ownerUserId: "alice", title: "Original", updatedAt: "", messageCount: 0 }];
test("parent navigation uses exact known client/agent/account and never fabricates an absent session", () => {
  expect(knownFailureParentId("agent:main:webchat:dm:client-a", sessions, "alice")).toBe("client-a");
  for (const key of ["agent:other:webchat:dm:client-a", "agent:main:delegate:main:client-a", "agent:main:webchat:dm:unknown", "client-a", "https://evil.test/client-a"]) {
    expect(knownFailureParentId(key, sessions, "alice")).toBeNull();
  }
  expect(knownFailureParentId("agent:main:webchat:dm:client-a", sessions, "bob")).toBeNull();
});
test("unrenderable timestamp rejects the whole DTO instead of throwing from the real failure dialog", () => {
  expect(() => parseFailurePage({ version: 1, count: 1, nextCursor: null, items: [{ jobId: "job", generation: 0, parentSessionKey: "parent", summaryCode: "delegate_failed", summaryText: "", failedAt: Number.MAX_SAFE_INTEGER, retry: { available: false, reason: null } }] })).toThrow();
});

test("diagnostics are bounded pure historical projections, never raw results or ACK identities", () => {
  const input = Array.from({ length: 25 }, (_, i) => ({ jobId: `old-${i}`, runId: `run-${i}`, agentId: "worker",
    goal: i === 0 ? '{"token":"PRIVATE_RESULT_SECRET"}' : "目标".repeat(100), state: "failed" as const,
    liveHint: "PRIVATE_RESULT_SECRET", resultSummary: "PRIVATE_RESULT_SECRET", updatedAt: 1,
    parentSessionKey: "agent:main:webchat:dm:client-a" }));
  const projection = sessionFailureDiagnostics(input);
  expect(projection).toHaveLength(20);
  expect(projection[0].goal).toBe("当前会话子任务");
  expect(projection[1].goal.length).toBe(160);
  expect(JSON.stringify(projection)).not.toContain("PRIVATE_RESULT_SECRET");
  expect(Object.keys(projection[0]).sort()).toEqual(["goal", "jobId", "parentSessionKey", "summary"]);
  expect(input).toHaveLength(25);
});
