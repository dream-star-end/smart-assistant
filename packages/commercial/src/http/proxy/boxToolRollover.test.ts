import test from "node:test";
import assert from "node:assert/strict";
import { BoxToolFetch } from "./boxToolFetch.js";
import { BoxToolRolloverRequired, toolRolloverReason, type BoxToolRolloverClaim } from "./boxToolRollover.js";
import { resumeMayPublish } from "./boxPreparedContinuation.js";
import { BOX_TOOL_SPOOL_MAX_BYTES, BOX_TOOL_MESSAGE_STREAM_MAX_BYTES,
  BOX_TOOL_POST_ECHO_RESERVE_BYTES, reserveBoxToolEcho } from "./boxToolCapacity.js";
import { BOX_INTERNAL_ENDPOINT } from "./upstream.js";
import type { ProxyBody } from "./shared.js";

test("resource boundaries apply to one generation and reserve a complete next message", () => {
  const message = { role: "user",content: "synthetic result" };
  const last = BOX_TOOL_SPOOL_MAX_BYTES - reserveBoxToolEcho(0,message)
    - BOX_TOOL_MESSAGE_STREAM_MAX_BYTES - BOX_TOOL_POST_ECHO_RESERVE_BYTES;
  assert.equal(toolRolloverReason(127,0,last,message),null);
  assert.equal(toolRolloverReason(128,0,100,message),"rounds");
  assert.equal(toolRolloverReason(1,210 * 60_000 - 1,100,message),null);
  assert.equal(toolRolloverReason(1,210 * 60_000,100,message),"wall");
  assert.equal(toolRolloverReason(1,0,last + 1,message),"spool");
  assert.throws(() => toolRolloverReason(129,0,100,message),/FENCE_LOST/);
  assert.equal(resumeMayPublish({ kind: "rollover_claim" }),false);
});

const body = { model: "box-api-claude-opus-5-5",max_tokens: 128,stream: true,
  tools: [{ name: "Echo",description: "synthetic",input_schema: { type: "object",properties: {} } }],
  metadata: { user_id: JSON.stringify({ session_id: "rollover-test",oc_turn_key: "a".repeat(64) }) },
  messages: [{ role: "user",content: "synthetic" },{ role: "assistant",content: [
    { type: "tool_use",id: "toolu_once",name: "Echo",input: {} }] },
  { role: "user",content: [{ type: "tool_result",tool_use_id: "toolu_once",content: "completed" }] }] } as ProxyBody;
const claim: BoxToolRolloverClaim = { v: 1,requestId: "rollover-child",ownerRequestId: "rollover-owner",
  accountId: 20n,runNonce: "b".repeat(24),leaseEpoch: "c".repeat(32),
  durableRevision: "11111111-1111-4111-8111-111111111111",reason: "rounds",sessionId: "rollover-test",
  turnKey: "a".repeat(64),model: body.model,nextContextHash: "d".repeat(64),roundNo: 128,
  catalogHash: "e".repeat(64),detachedRunnerHash: "f".repeat(64),
  resultHashes: [{ modelToolUseId: "toolu_once",contentHash: "1".repeat(64),isError: false }] };

test("only a durable stopped generation reaches fresh launch; unknown and cancellation keep the claim", async () => {
  for (const mode of ["stopped_proven","pending","completed_unsettled","lost_receipt","cancelled"] as const) {
    const calls: string[] = [];
    const abort = new AbortController();
    const svc = new BoxToolFetch({ supervisorAsset: Buffer.from("s"),keeperAsset: Buffer.from("k"),
      virtualMcpAsset: Buffer.from("m"),detachedRunnerAsset: Buffer.from("d"),
      journal: { finishToolRollover: async () => {
        calls.push("proof-durable"); if (mode === "lost_receipt") throw new Error("COMMIT response lost");
      } } as never,maxOutputTokensForModel: () => 128_000,
      resolveTarget: async () => { throw new Error("unexpected resolve"); },onUnknown: async () => {},
      publishResume: async () => { calls.push("bound-claim"); throw new BoxToolRolloverRequired(claim); },
      stopOrphanRun: async () => {
        calls.push("stop"); if (mode === "cancelled") abort.abort();
        return mode === "pending" || mode === "completed_unsettled" ? mode : "stopped_proven";
      },
      runFirst: (async (input: { resumeToolResults?: boolean; emit: (sse: string) => void }) => {
        assert.equal(input.resumeToolResults,true); calls.push("fresh");
        input.emit("event: message_stop\ndata: {}\n\n");
        return { kind: "tool_handoff",plan: { runNonce: "2".repeat(24),leaseEpoch: "3".repeat(32) },
          target: { accountId: 20n } };
      }) as never });
    const run = async () => {
      const response = await svc.fetch({ uid: 3n,sessionId: "rollover-test",requestId: "rollover-child",
        canonicalModel: body.model,canonicalBody: body,upstreamModel: "claude-opus-5-5",url: BOX_INTERNAL_ENDPOINT,
        init: { method: "POST",signal: abort.signal,body: JSON.stringify({ ...body,model: "claude-opus-5-5" }) } });
      return response.text();
    };
    if (mode === "stopped_proven") {
      await run(); assert.deepEqual(calls,["bound-claim","stop","proof-durable","fresh"]);
    } else { await assert.rejects(run); assert.ok(!calls.includes("fresh"),mode); }
    assert.ok(!calls.includes("release"),"an uncertain predecessor claim is never released for a duplicate launch");
  }
});
