import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BoxInvocationConflict, BoxInvocationRegistry } from "./boxInvocationRegistry.js";

const limits = { maxPerUser: 1, maxPerAccount: 2, leaseMs: 1000 };
function rejected(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof BoxInvocationConflict && error.code === code);
}

describe("Box cross-HTTP invocation ownership", () => {
  it("keeps the same remote CLI alive after tool_use HTTP response ends", () => {
    const registry = new BoxInvocationRegistry(limits);
    const lease = registry.open({ uid: 3n, sessionId: "session-a", accountId: 20n });
    registry.handoff(lease, "toolu_289", 2);
    assert.equal(registry.firstResponseClosed(lease), "held");
    assert.equal(lease.signal.aborted, false);
    assert.deepEqual(registry.counts(3n, 20n), { user: 1, account: 1 });
    rejected(() => registry.claimToolResult({ uid: 4n, sessionId: "session-a", toolUseId: "toolu_289" }),
      "BOX_TOOL_RESULT_NOT_MATCHED");
    rejected(() => registry.claimToolResult({ uid: 3n, sessionId: "session-a", toolUseId: "toolu_wrong" }),
      "BOX_TOOL_RESULT_NOT_MATCHED");
    const resumed = registry.claimToolResult({ uid: 3n, sessionId: "session-a", toolUseId: "toolu_289" });
    assert.equal(resumed, lease);
    assert.equal(registry.firstResponseClosed(lease), "held", "late first close must not kill resumed CLI");
    rejected(() => registry.claimToolResult({ uid: 3n, sessionId: "session-a", toolUseId: "toolu_289" }),
      "BOX_TOOL_RESULT_NOT_MATCHED");
    registry.confirmRemoteStopped(lease);
    assert.deepEqual(registry.counts(3n, 20n), { user: 0, account: 0 });
    rejected(() => registry.handoff(lease, "toolu_late", 3), "BOX_LEASE_STALE");
  });

  it("early close aborts but retains account capacity until remote terminal proof", () => {
    const registry = new BoxInvocationRegistry(limits);
    const lease = registry.open({ uid: 3n, sessionId: "session-a", accountId: 20n });
    assert.equal(registry.firstResponseClosed(lease), "aborted");
    assert.equal(lease.signal.aborted, true);
    assert.equal(lease.state, "unknown");
    rejected(() => registry.open({ uid: 3n, sessionId: "session-b", accountId: 20n }),
      "BOX_USER_CAPACITY_FULL");
    registry.confirmRemoteStopped(lease);
    const next = registry.open({ uid: 3n, sessionId: "session-b", accountId: 20n });
    registry.confirmRemoteStopped(next);
  });

  it("isolates users, enforces per-account bound and blocks conflicting sessions", () => {
    const registry = new BoxInvocationRegistry(limits);
    const a = registry.open({ uid: 3n, sessionId: "session-a", accountId: 20n });
    const b = registry.open({ uid: 4n, sessionId: "session-a", accountId: 20n });
    rejected(() => registry.open({ uid: 3n, sessionId: "session-a", accountId: 21n }), "BOX_SESSION_BUSY");
    rejected(() => registry.open({ uid: 5n, sessionId: "session-c", accountId: 20n }),
      "BOX_ACCOUNT_CAPACITY_FULL");
    registry.confirmRemoteStopped(a);
    registry.confirmRemoteStopped(b);
  });

  it("lease expiry aborts remote but does not treat abort as terminal", async () => {
    const registry = new BoxInvocationRegistry(limits);
    const lease = registry.open({ uid: 3n, sessionId: "session-a", accountId: 20n });
    await new Promise((resolve) => setTimeout(resolve, 1050));
    assert.equal(lease.state, "unknown");
    assert.equal(lease.signal.aborted, true);
    assert.deepEqual(registry.counts(3n, 20n), { user: 1, account: 1 });
    registry.confirmRemoteStopped(lease);
    assert.deepEqual(registry.counts(3n, 20n), { user: 0, account: 0 });
  });

  it("rejects expiry synchronously even before the delayed timer callback runs", () => {
    let now = 1000;
    const registry = new BoxInvocationRegistry(limits, () => now);
    const lease = registry.open({ uid: 3n, sessionId: "session-a", accountId: 20n });
    registry.handoff(lease, "toolu_289", 2);
    now = 2001;
    rejected(() => registry.claimToolResult({ uid: 3n, sessionId: "session-a", toolUseId: "toolu_289" }),
      "BOX_LEASE_EXPIRED");
    assert.equal(lease.state, "unknown");
    assert.equal(lease.signal.aborted, true);
    assert.deepEqual(registry.counts(3n, 20n), { user: 1, account: 1 });
    registry.confirmRemoteStopped(lease);

    now = 5000;
    const second = registry.open({ uid: 3n, sessionId: "session-b", accountId: 20n });
    now = 6001;
    rejected(() => registry.handoff(second, "toolu_late", 3), "BOX_LEASE_EXPIRED");
    assert.equal(second.signal.aborted, true);
    registry.confirmRemoteStopped(second);
  });

  it("per-open remaining budget fences a long registry ceiling", () => {
    let now = 10_000;
    const registry = new BoxInvocationRegistry({ maxPerUser: 1, maxPerAccount: 1,
      leaseMs: 600_000 }, () => now);
    const lease = registry.open({ uid: 3n, sessionId: "session-a", accountId: 20n,
      leaseMs: 120_000 });
    assert.equal(lease.deadlineAt, 130_000);
    now = 130_000;
    rejected(() => registry.handoff(lease, "toolu_289", 2), "BOX_LEASE_EXPIRED");
    assert.deepEqual(registry.counts(3n, 20n), { user: 1, account: 1 });
    registry.confirmRemoteStopped(lease);
    rejected(() => registry.open({ uid: 3n, sessionId: "session-b", accountId: 20n,
      leaseMs: 600_001 }), "BOX_LEASE_LIMIT_INVALID");
  });
});
