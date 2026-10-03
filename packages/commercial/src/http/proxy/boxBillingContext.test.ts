import test from "node:test";
import assert from "node:assert/strict";
import { parseBoxBillingContext, serializeBoxBillingContext } from "./boxBillingContext.js";

test("Box recovery context preserves delegate attribution and fenced authority", () => {
  const input = { sessionId: "agent:child", mode: "delegate" as const,
    parentSessionId: "web-parent", delegateAgentId: "coding-assistant",
    turnKey: "a".repeat(64), parentTurnKey: "b".repeat(64),
    authority: { kind: "bridge_signed" as const, executionRevision: "rev-exec",
      projectionRevision: "rev-project", securityEpoch: 42n },
    dispatchId: "dispatch-1", attemptNo: 2, verificationSponsorship: null,
    apiKeyId: null };
  const frozen = serializeBoxBillingContext(input);
  assert.equal(frozen.authority?.securityEpoch, "42");
  assert.deepEqual(parseBoxBillingContext(JSON.parse(JSON.stringify(frozen))), input);
  assert.equal(parseBoxBillingContext({ ...frozen, turnKey: null }), null);
  assert.equal(parseBoxBillingContext({ ...frozen,
    authority: { ...frozen.authority, securityEpoch: "not-a-number" } }), null);
});
