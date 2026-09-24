import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { publishBoxToolResume } from "./boxToolResumePublish.js";
import { BoxExecTransportError } from "./boxExecTransport.js";
import { hashBoxToolInput } from "./boxToolInputHash.js";
import { BOX_INTERNAL_ENDPOINT } from "./upstream.js";
import type { ProxyBody } from "./shared.js";

const id = "toolu_synthetic_a";
const toolInput = { value: "private synthetic" };
const content = [{ type: "text" as const, text: "OpenClaude user-container result" }];
const contentHash = createHash("sha256").update(JSON.stringify({
  content, isError: false })).digest("hex");
const canonicalBody: ProxyBody = { model: "box-api-claude-opus-5-5", max_tokens: 128,
  stream: true, tools: [{ name: "local_echo", description: "synthetic",
    input_schema: { type: "object", properties: { value: { type: "string" } } } }],
  messages: [
    { role: "assistant", content: [{ type: "tool_use", id,
      name: "local_echo", input: toolInput }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: id,
      content: "OpenClaude user-container result" }] },
  ], metadata: { user_id: JSON.stringify({ session_id: "session-synthetic",
    oc_turn_key: "a".repeat(64) }) } };
const upstreamBody = { ...canonicalBody, model: "claude-opus-5-5" };

function fixture(options: { ambiguousWrite?: boolean; wrongAccount?: boolean } = {}) {
  const sequence: string[] = [];
  let writes = 0, retained = false;
  const claim = { ownerRequestId: "box-owner", accountId: 20n,
    runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32),
    spoolOffset: 1234, roundNo: 2, detachedRunnerHash: "c".repeat(64),
    catalogHash: "d".repeat(64), durableRevision: "synthetic-revision",
    toolUses: [{ id, boxName: "mcp__ocbridge__t0", clientName: "local_echo",
      inputHash: hashBoxToolInput(toolInput) }],
    results: [{ modelToolUseId: id, content, isError: false, contentHash }] };
  const target = { accountId: options.wrongAccount ? 21n : 20n,
    exec: { run: async (request: { args: string[] }) => {
      if (request.args[1]?.includes("pending.")) {
        sequence.push("pending-read");
        return { stdout: JSON.stringify({ version: 1, modelToolUseId: id,
          mcpRequestId: 7, name: "t0", arguments: toolInput }),
        stderrBytes: 0, exitCode: 0 as const };
      }
      sequence.push("result-write"); writes++;
      if (options.ambiguousWrite && writes === 1) {
        throw new BoxExecTransportError("synthetic write ambiguity", false);
      }
      return { stdout: `${request.args.at(-1) ?? "written"}\n`,
        stderrBytes: 0, exitCode: 0 as const };
    } } };
  const journal = { claimToolResume: async () => { sequence.push("claim"); return claim; },
    markUnknown: async () => { sequence.push("unknown"); } };
  const deps = { journal: journal as never,
    resolveTarget: async (args: { requiredAccountId: bigint }) => {
      sequence.push("resolve"); assert.equal(args.requiredAccountId, 20n);
      return target as never;
    },
    retainUnknownTarget: () => { retained = true; sequence.push("retain"); },
    onUnknown: async () => { sequence.push("notify"); } };
  const input = { uid: 3n, sessionId: "session-synthetic", requestId: "box-next",
    canonicalModel: canonicalBody.model, canonicalBody,
    upstreamModel: "claude-opus-5-5", url: BOX_INTERNAL_ENDPOINT,
    init: { method: "POST", body: JSON.stringify(upstreamBody) } };
  return { input, deps, sequence, target, claim,
    get writes() { return writes; }, get retained() { return retained; } };
}

test("resume CAS precedes one result publication through pinned account", async () => {
  const f = fixture();
  const published = await publishBoxToolResume(f.input, f.deps);
  assert.equal(published.target, f.target);
  assert.equal(published.claim.spoolOffset, 1234);
  assert.equal(published.access.cwd, `/tmp/ocv5-289-run-${"a".repeat(24)}`);
  assert.ok(f.sequence.indexOf("claim") < f.sequence.indexOf("result-write"));
  assert.deepEqual(f.sequence.slice(0, 3), ["claim", "resolve", "pending-read"]);
  assert.equal(f.writes, 2, "one WRITE plus one no-clobber FINISH");
  assert.equal(f.retained, false);
});

test("ambiguous result write is never retried and keeps the claim unknown", async () => {
  const f = fixture({ ambiguousWrite: true });
  await assert.rejects(() => publishBoxToolResume(f.input, f.deps),
    BoxExecTransportError);
  assert.equal(f.writes, 1);
  assert.equal(f.retained, true);
  assert.ok(f.sequence.includes("unknown"));
});

test("resolver account mismatch cannot publish a tool result", async () => {
  const f = fixture({ wrongAccount: true });
  await assert.rejects(() => publishBoxToolResume(f.input, f.deps),
    /BOX_TOOL_RESUME_ACCOUNT_MISMATCH/);
  assert.equal(f.writes, 0);
  assert.equal(f.retained, true);
});

test("same-turn cancellation and late pinned resolver completion retain the target", async () => {
  const f = fixture();
  const abort = new AbortController();
  let deliver!: (target: typeof f.target) => void;
  f.deps.resolveTarget = (() => new Promise((resolve) => { deliver = resolve; })) as never;
  const task = publishBoxToolResume({ ...f.input,
    init: { ...f.input.init, signal: abort.signal } }, f.deps);
  await new Promise((resolve) => setTimeout(resolve, 0));
  abort.abort(); deliver(f.target);
  await assert.rejects(() => task, /BOX_TOOL_RESUME_ABORTED/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.retained, true);
  assert.equal(f.writes, 0);
  assert.ok(f.sequence.includes("unknown"));
});

test("out-of-order pending B is published before dependent A without replay", async () => {
  const f = fixture();
  const b = "toolu_synthetic_b";
  f.claim.toolUses.push({ ...f.claim.toolUses[0]!, id: b });
  f.claim.results.push({ ...f.claim.results[0]!, modelToolUseId: b });
  let bPublished = false;
  const published: string[] = [];
  f.target.exec.run = async (request: { args: string[] }) => {
    const args = request.args;
    if (args[1]?.includes("pending.")) {
      const pendingId = args[3];
      if (pendingId === id && !bPublished) {
        throw new BoxExecTransportError("synthetic missing pending", true, 1);
      }
      return { stdout: JSON.stringify({ version: 1, modelToolUseId: pendingId,
        mcpRequestId: pendingId === b ? 8 : 7, name: "t0", arguments: toolInput }),
      stderrBytes: 0, exitCode: 0 as const };
    }
    const path = args[4] ?? "";
    if (args.length === 7 && path.includes("/result.")) {
      const resultId = path.includes(b) ? b : id;
      published.push(resultId);
      if (resultId === b) bPublished = true;
    }
    return { stdout: `${args.at(-1) ?? "written"}\n`, stderrBytes: 0,
      exitCode: 0 as const };
  };
  await publishBoxToolResume(f.input, f.deps);
  assert.deepEqual(published, [b, id]);
  assert.equal(f.retained, false);
});
