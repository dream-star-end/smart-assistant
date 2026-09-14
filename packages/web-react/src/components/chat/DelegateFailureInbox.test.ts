import { expect, test } from "vitest";
import { knownFailureParentId } from "./DelegateFailureInbox";
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
