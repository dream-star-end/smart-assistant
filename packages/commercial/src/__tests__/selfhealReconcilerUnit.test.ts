import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileOnce } from "../selfheal/reconciler.js";

// Mocked query: returns canned condition / incident rows by SQL shape. tx is
// mocked to record resolve attempts WITHOUT running the real resolveIncident —
// we only assert the reconciler's decision (whether it resolves), not the DB write.
function fakeQuery(conditions: unknown[], incidents: unknown[]) {
  return (async (sql: string) => {
    if (/FROM admin_alert_rule_state/.test(sql)) return { rows: conditions };
    if (/FROM incidents WHERE status/.test(sql)) return { rows: incidents };
    return { rows: [] };
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  }) as any;
}

const incident = {
  id: "5",
  condition_key: "ops.monitor:svc_v5",
  severity: "warning",
  audience: "all",
};

describe("reconciler resolve — condition absence handling (Codex H1)", () => {
  it("does NOT resolve (no false recovery) when the condition ROW is missing", async () => {
    const txCalls: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const tx = (async () => {
      txCalls.push("resolve");
      return { resolved: true };
    }) as any;
    const r = await reconcileOnce({
      query: fakeQuery([], [incident]), // no condition rows at all
      tx,
      matchPolicy: async () => null,
      safeEnqueueAlert: () => {},
    });
    assert.deepEqual(r.resolved, [], "a missing condition must NOT resolve the incident");
    assert.equal(txCalls.length, 0, "resolve must not even be attempted on absence");
  });

  it("resolves when the condition EXISTS and is explicitly firing=false", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const tx = (async () => ({ resolved: true })) as any;
    const cond = {
      condition_key: "ops.monitor:svc_v5",
      firing: false,
      level: "warning",
      snapshot: null,
    };
    const r = await reconcileOnce({
      query: fakeQuery([cond], [incident]),
      tx,
      matchPolicy: async () => null,
      safeEnqueueAlert: () => {},
    });
    assert.deepEqual(r.resolved, ["ops.monitor:svc_v5"]);
  });

  it("keeps an incident open while its condition is still firing", async () => {
    const txCalls: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const tx = (async () => {
      txCalls.push("resolve");
      return { resolved: true };
    }) as any;
    const cond = {
      condition_key: "ops.monitor:svc_v5",
      firing: true,
      level: "warning",
      snapshot: null,
    };
    const r = await reconcileOnce({
      query: fakeQuery([cond], [incident]),
      tx,
      matchPolicy: async () => null, // firing but no policy → no open either
      safeEnqueueAlert: () => {},
    });
    assert.deepEqual(r.resolved, [], "a firing condition must keep the incident open");
    assert.equal(txCalls.length, 0);
  });
});
