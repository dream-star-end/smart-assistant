import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { publishBoxToolResume } from "./boxToolResumePublish.js";
import { BoxContinuationDecisionError } from "./boxPreparedContinuation.js";
import type { BoxDurableJournal } from "./boxDurableJournal.js";
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

function fixture(options: { ambiguousWrite?: boolean; wrongAccount?: boolean;
  failAt?: "pending-read" | "result-write" } = {}) {
  const sequence: string[] = [];
  const executionError = new BoxExecTransportError("BOX_EXEC_HTTP_417", false);
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
      if (request.args[0] === "-I" && request.args[1] === "-c"
        && request.args[2]?.includes("pending.")) {
        sequence.push("pending-read");
        if (options.failAt === "pending-read") throw executionError;
        return { stdout: JSON.stringify({ version: 1, modelToolUseId: id,
          mcpRequestId: 7, name: "t0", arguments: toolInput }),
        stderrBytes: 0, exitCode: 0 as const };
      }
      sequence.push("result-write"); writes++;
      if (options.failAt === "result-write") throw executionError;
      if (options.ambiguousWrite && writes === 1) {
        throw new BoxExecTransportError("synthetic write ambiguity", false);
      }
      return { stdout: `${request.args.at(-1) ?? "written"}\n`,
        stderrBytes: 0, exitCode: 0 as const };
    } } };
  const journal = { claimToolResume: async () => { sequence.push("claim"); return claim; },
    markUnknown: async () => { sequence.push("unknown"); } };
  const deps = { journal: journal as never,
    resolveTarget: async (args: { requiredAccountId: bigint; noLaunch?: boolean }) => {
      sequence.push("resolve"); assert.equal(args.requiredAccountId, 20n);
      // OCV5-390: publishing to the live run schedules no login
      assert.equal(args.noLaunch, true);
      return target as never;
    },
    retainUnknownTarget: () => { retained = true; sequence.push("retain"); },
    onUnknown: async () => { sequence.push("notify"); } };
  const input = { uid: 3n, sessionId: "session-synthetic", requestId: "box-next",
    canonicalModel: canonicalBody.model, canonicalBody,
    upstreamModel: "claude-opus-5-5", url: BOX_INTERNAL_ENDPOINT,
    init: { method: "POST", body: JSON.stringify(upstreamBody) } };
  return { input, deps, sequence, target, claim, executionError,
    get writes() { return writes; }, get retained() { return retained; } };
}

test("an in-progress decision does not publish or mark the owner unknown", async () => {
  const f = fixture();
  let marked = 0;
  const journal = { claimToolResume: async () => { throw new Error("claim must not run"); },
    decideToolResume: async () => ({ kind: "in_progress_or_unknown", code: "BOX_RESUME_IN_PROGRESS" }),
    markUnknown: async () => { marked += 1; } };
  await assert.rejects(() => publishBoxToolResume(f.input, { ...f.deps, journal: journal as never }),
    (error: unknown) => error instanceof BoxContinuationDecisionError
      && error.decision === "in_progress_or_unknown"
      && error.code === "BOX_RESUME_IN_PROGRESS");
  assert.equal(marked, 0);
  assert.equal(f.sequence.includes("resolve"), false);
  assert.equal(f.writes, 0);
});

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
    if (args[0] === "-I" && args[1] === "-c" && args[2]?.includes("pending.")) {
      const pendingId = args[4];
      if (pendingId === id && !bPublished) {
        throw new BoxExecTransportError("synthetic missing pending", true, 1);
      }
      return { stdout: JSON.stringify({ version: 1, modelToolUseId: pendingId,
        mcpRequestId: pendingId === b ? 8 : 7, name: "t0", arguments: toolInput }),
      stderrBytes: 0, exitCode: 0 as const };
    }
    const path = args[5] ?? "";
    if (args.length === 8 && path.includes("/result.")) {
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


type FailureRecord = Parameters<BoxDurableJournal["recordFirstFailure"]>[0];
function withFailureRecorder(f: ReturnType<typeof fixture>, recorder: BoxDurableJournal["recordFirstFailure"]) {
  Object.assign(f.deps.journal, { recordFirstFailure: recorder });
}

test("post-claim pending-read and result-stage 417 failures are observed before unknown with exact claim identity", async () => {
  for (const failAt of ["pending-read", "result-write"] as const) {
    const f = fixture({ failAt });
    const records: FailureRecord[] = [];
    withFailureRecorder(f, async (record) => {
      f.sequence.push("first-failure"); records.push(record); return null;
    });
    await assert.rejects(publishBoxToolResume(f.input, f.deps), (error: unknown) => error === f.executionError);
    assert.deepEqual(records, [{ requestId: f.input.requestId, uid: f.input.uid,
      accountId: f.claim.accountId, runNonce: f.claim.runNonce, leaseEpoch: f.claim.leaseEpoch,
      ownerRequestId: f.claim.ownerRequestId, code: "BOX_EXEC_HTTP_417", phase: "continuation",
      diagnostic: { branch: "resume_publish", upstreamStatus: 417 } }]);
    assert.ok(f.sequence.indexOf("first-failure") < f.sequence.indexOf("unknown"));
    assert.equal(f.sequence.filter(item => item === "claim").length, 1);
    assert.equal(f.writes, failAt === "result-write" ? 1 : 0, "publication is never retried");
    assert.equal(f.retained, true);
    assert.ok(f.sequence.includes("notify"));
  }
});

test("a rejected authoritative claim records no failure and does not mark an owner unknown", async () => {
  const f = fixture();
  let records = 0;
  withFailureRecorder(f, async () => { records++; return null; });
  Object.assign(f.deps.journal, { claimToolResume: async () => { throw f.executionError; } });
  await assert.rejects(publishBoxToolResume(f.input, f.deps), (error: unknown) => error === f.executionError);
  assert.equal(records, 0);
  assert.equal(f.sequence.includes("unknown"), false);
  assert.equal(f.sequence.includes("resolve"), false);
  assert.equal(f.writes, 0);
});

test("synchronous and rejected diagnostic writes cannot mask the publication failure or unknown path", async () => {
  for (const kind of ["throw", "reject"] as const) {
    const f = fixture({ failAt: "result-write" });
    withFailureRecorder(f, () => {
      f.sequence.push("first-failure");
      if (kind === "throw") throw new Error("synthetic diagnostic failure");
      return Promise.reject(new Error("synthetic diagnostic rejection"));
    });
    await assert.rejects(publishBoxToolResume(f.input, f.deps), (error: unknown) => error === f.executionError);
    assert.equal(f.writes, 1);
    assert.equal(f.retained, true);
    assert.ok(f.sequence.indexOf("first-failure") < f.sequence.indexOf("unknown"));
    assert.ok(f.sequence.includes("notify"));
  }
});

test("a hanging diagnostic write is bounded to 200ms and a late rejection stays observed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ failAt: "pending-read" });
  let started!: () => void, rejectLate!: (error: Error) => void;
  const recorded = new Promise<void>((resolve) => { started = resolve; });
  withFailureRecorder(f, () => {
    f.sequence.push("first-failure"); started();
    return new Promise<never>((_resolve, reject) => { rejectLate = reject; });
  });
  const task = assert.rejects(publishBoxToolResume(f.input, f.deps), (error: unknown) => error === f.executionError);
  await recorded;
  t.mock.timers.tick(199);
  await Promise.resolve();
  assert.equal(f.sequence.includes("unknown"), false);
  t.mock.timers.tick(1);
  await task;
  assert.equal(f.retained, true);
  assert.ok(f.sequence.includes("unknown"));
  assert.ok(f.sequence.includes("notify"));
  assert.equal(f.writes, 0);
  rejectLate(new Error("synthetic late diagnostic rejection"));
  await Promise.resolve();
});
