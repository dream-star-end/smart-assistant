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

describe("reconciler suppression(H1b)", () => {
  const policy = {
    id: 1, matchKind: "prefix", matchKey: "ops.monitor:", surface: "global",
    audience: "all", resolveMode: "probe", autoRepair: true, severityFloor: "critical",
    userTitle: "t", userMessage: "m", repairHint: null, enabled: true,
    // biome-ignore lint/suspicious/noExplicitAny: test stub
  } as any;

  it("suppressed+firing 的 condition 不 open 新 incident", async () => {
    const txCalls: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const tx = (async () => { txCalls.push("open"); return { created: true, rev: 1 }; }) as any;
    const cond = {
      condition_key: "ops.monitor:svc_v5",
      firing: true,
      suppressed: true,
      level: "critical",
      snapshot: null,
    };
    const r = await reconcileOnce({
      query: fakeQuery([cond], []), // 无活跃 incident
      tx,
      matchPolicy: async () => policy,
      safeEnqueueAlert: () => {},
    });
    assert.deepEqual(r.opened, [], "压制中的 condition 不投影");
    assert.equal(txCalls.length, 0);
  });

  it("suppressed+firing 的遗留 open incident 被 resolve(source='admin' 兜底)", async () => {
    const resolveSources: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const tx = (async (fn: any) => {
      // resolveIncident 在 tx 内被调;拦截 client.query 捕获 resolve_source 参数。
      const client = {
        query: async (sql: string, params?: unknown[]) => {
          if (/UPDATE incidents/.test(sql)) {
            resolveSources.push(String((params as unknown[])[1]));
            return { rows: [{ rev: "2", audience: "all" }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
      };
      return fn(client);
    }) as any;
    const cond = {
      condition_key: "ops.monitor:svc_v5",
      firing: true,
      suppressed: true,
      level: "critical",
      snapshot: null,
    };
    const r = await reconcileOnce({
      query: fakeQuery([cond], [incident]),
      tx,
      matchPolicy: async () => policy,
      safeEnqueueAlert: () => {},
    });
    assert.deepEqual(r.resolved, ["ops.monitor:svc_v5"]);
    assert.deepEqual(resolveSources, ["admin"], "压制关闭归因 admin,非 probe");
    assert.deepEqual(r.opened, [], "同轮也不重开");
  });

  it("未压制 firing 照常投影(suppressed 缺省=falsy 向后兼容)", async () => {
    let opened = 0;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const tx = (async () => { opened++; return { created: true, rev: 1, incidentId: "9", severity: "critical" }; }) as any;
    const cond = { condition_key: "ops.monitor:svc_v5", firing: true, level: "critical", snapshot: null };
    const r = await reconcileOnce({
      query: fakeQuery([cond], []),
      tx,
      matchPolicy: async () => policy,
      safeEnqueueAlert: () => {},
    });
    assert.deepEqual(r.opened, ["ops.monitor:svc_v5"]);
    assert.equal(opened, 1);
  });
});
