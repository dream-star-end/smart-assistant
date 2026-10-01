// OCV5-304 live #aacd65f7: "从断点继续"/"重新尝试" create a new dispatch that
// resends the same tool results under a new turn key; the claim can only bind
// a continuation to its own dispatch -> 409 BOX_TOOL_OWNER_UNKNOWN on every
// retry ("任务执行失败"), while the old CLI waited for its deadline.
import test from "node:test";
import assert from "node:assert/strict";
import { BoxToolFetch } from "./boxToolFetch.js";
import { BoxDurableJournalError } from "./boxDurableJournal.js";
import { BOX_INTERNAL_ENDPOINT } from "./upstream.js";
import type { ProxyBody } from "./shared.js";

const tools = [{ name: "Skill", description: "skill", input_schema: { type: "object", properties: {} } }];
const body: ProxyBody = { model: "box-api-claude-opus-5-5", max_tokens: 128, stream: true, tools,
  metadata: { user_id: JSON.stringify({ session_id: "sess-recover", oc_turn_key: "cd".repeat(32) }) },
  messages: [{ role: "user", content: "deploy" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_S", name: "Skill", input: { skill: "x" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_S", content: "Launching skill: x" }] }] } as ProxyBody;
const call = { uid: 3n, sessionId: "sess-recover", requestId: "box-recover", canonicalModel: body.model,
  canonicalBody: body, upstreamModel: "claude-opus-5-5", url: BOX_INTERNAL_ENDPOINT,
  init: { method: "POST", body: JSON.stringify({ ...body, model: "claude-opus-5-5" }) } };
const orphan = { requestId: "box-orphan", uid: 3n, accountId: 20n, runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32) };

function service(opts: { orphan: unknown; stop?: string; error?: Error }) {
  const calls: string[] = [];
  let firstInput: { resumeToolResults?: boolean } | null = null;
  const journal = { claimRemoteCleanup: async () => true, remoteCleanupStatus: async () => "pending",
    remoteCleanupDoneByRunIdentity: async () => false, prelaunchCleanupDoneByRunIdentity: async () => false,
    markRemoteCleaned: async () => {}, listRemoteCleanupCandidates: async () => [],
    findOrphanToolHandoff: async (input: { toolIds: readonly string[]; turnKey: string }) => {
      calls.push(`find:${input.toolIds.join(",")}`); return opts.orphan; } };
  const svc = new BoxToolFetch({ supervisorAsset: Buffer.from("s"), keeperAsset: Buffer.from("k"),
    virtualMcpAsset: Buffer.from("m"), detachedRunnerAsset: Buffer.from("d"), journal: journal as never,
    maxOutputTokensForModel: () => 128_000, resolveTarget: async () => ({ accountId: 20n }) as never,
    onUnknown: async () => {},
    publishResume: (async () => { calls.push("claim"); throw opts.error
      ?? new BoxDurableJournalError("BOX_TOOL_OWNER_UNKNOWN"); }) as never,
    stopOrphanRun: async (identity) => { calls.push(`stop:${identity.requestId}`);
      return (opts.stop ?? "stopped_proven") as never; },
    runFirst: (async (input: { emit: (sse: string) => void; resumeToolResults?: boolean; onLaunchAck?: () => void }) => {
      calls.push("first"); firstInput = input; input.onLaunchAck?.();
      input.emit("event: message_stop\ndata: {}\n\n");
      return { kind: "final", plan: { runNonce: "c".repeat(24), leaseEpoch: "d".repeat(32) },
        target: { accountId: 20n }, proof: { runNonce: "c".repeat(24), leaseEpoch: "d".repeat(32),
          keeperPid: 1, cliPid: 2, reason: "worker_complete", revision: 1 } };
    }) as never,
  });
  return { svc, calls, firstInput: () => firstInput };
}

test("OCV5-304 a recovered dispatch stops the orphan and continues as a fresh invocation", async () => {
  const s = service({ orphan: { kind: "orphan", identity: orphan } });
  const response = await s.svc.fetch(call);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /message_stop/);
  assert.deepEqual(s.calls, ["claim", "find:toolu_S", "stop:box-orphan", "first"]);
  assert.equal(s.firstInput()?.resumeToolResults, true);
  // nothing waits on the exchange any more (e.g. stopped earlier): still continues
  const none = service({ orphan: { kind: "none" } });
  assert.equal((await none.svc.fetch(call)).status, 200);
  assert.deepEqual(none.calls, ["claim", "find:toolu_S", "first"]);
});

test("a live owner, an unproven stop or any other claim error keeps the rejection", async () => {
  for (const opts of [{ orphan: { kind: "live" } },
    { orphan: { kind: "orphan", identity: orphan }, stop: "pending" },
    { orphan: { kind: "orphan", identity: orphan }, stop: "completed_unsettled" },
    { orphan: { kind: "orphan", identity: orphan }, error: new BoxDurableJournalError("BOX_TOOL_CONTEXT_CHANGED") }]) {
    const s = service(opts);
    await assert.rejects(async () => { const r = await s.svc.fetch(call); await r.text(); });
    assert.ok(!s.calls.includes("first"), s.calls.join(" "));
  }
});
