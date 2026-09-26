import test from "node:test";
import assert from "node:assert/strict";
import { BoxTextFetch, BoxTextFetchError } from "./boxTextFetch.js";
import { BoxExecTransportError, type BoxExecResult,
  type BoxExecTransport } from "./boxExecTransport.js";
import { BoxInvocationRegistry, type BoxInvocationLease } from "./boxInvocationRegistry.js";
import { _UsageObserver, type ProxyBody } from "./shared.js";
import { BOX_INTERNAL_ENDPOINT } from "./upstream.js";
import type { BoxCcExecRequest } from "@openclaude/gateway";

const model = "claude-opus-5";
const canonicalAlias = "box-api-claude-opus-5";
const body: ProxyBody = { model, max_tokens: 256, stream: true,
  metadata: { user_id: JSON.stringify({ oc_turn_key: "a".repeat(64), session_id: "session-289" }) },
  messages: [{ role: "user", content: "synthetic text only" }] };
const input = { uid: 3n, sessionId: "session-289", requestId: "req-289",
  canonicalModel: model, canonicalBody: body, upstreamModel: model,
  url: BOX_INTERNAL_ENDPOINT, init: { method: "POST", body: JSON.stringify(body) } };
const line = (value: unknown) => JSON.stringify(value) + "\n";
const cliOutput = [
  { type: "system", subtype: "init", tools: [], mcp_servers: [] },
  { type: "stream_event", event: { type: "message_start", message: {
    id: "msg_289", model, role: "assistant", content: [],
    usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 20 } } } },
  { type: "stream_event", event: { type: "content_block_start", index: 1,
    content_block: { type: "text", text: "" } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 1,
    delta: { type: "text_delta", text: "answer" } } },
  { type: "assistant", message: { id: "msg_289", model, role: "assistant",
    content: [{ type: "text", text: "answer" }] } },
  { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
  { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 7, input_tokens: 2, cache_read_input_tokens: 20 } } },
  { type: "stream_event", event: { type: "message_stop" } },
  { type: "result", subtype: "success", is_error: false,
    usage: { input_tokens: 2, output_tokens: 7, cache_read_input_tokens: 20 } },
].map(line).join("");
const ok = (stdout = ""): BoxExecResult => ({ stdout, stderrBytes: 0, exitCode: 0 });
const noopJournal = { admit: async () => {}, markRunning: async () => {},
  markPrestartStopped: async () => {}, markUnknown: async () => {},
  complete: async () => {} };

class SpyRegistry extends BoxInvocationRegistry {
  last: BoxInvocationLease | null = null;
  override open(input: Parameters<BoxInvocationRegistry["open"]>[0]): BoxInvocationLease {
    this.last = super.open(input);
    return this.last;
  }
}
type Runner = Pick<BoxExecTransport, "run">;
function fixture(opts: { failPhase?: "stage" | "stage_typeerror" | "keeper" | "keeper_known" | "model" | "proof" | "cleanup";
  journalFailPhase?: "admit" | "running" | "complete";
  advanceAtStage?: () => void; hangUnknown?: boolean; badCli?: boolean;
  resolverThrow?: boolean; onDispose?: () => void; holdModel?: boolean } = {}) {
  let now = 1000, active = 0, maxActive = 0;
  let releaseModel = (): void => {};
  let proofDir = "", leaseEpoch = "";
  const stages: string[] = [], unknowns: string[] = [], journalCalls: string[] = [];
  let journalUsage: unknown = null;
  const registry = new SpyRegistry({ maxPerUser: 1, maxPerAccount: 1, leaseMs: 600_000 }, () => now);
  const runner: Runner = { async run(request: BoxCcExecRequest,
    options: Parameters<Runner["run"]>[1]): Promise<BoxExecResult> {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const isModel = request.args[0] === "-I"
      && request.args[1]?.startsWith("/tmp/ocv5-289-v2-keeper-");
    const isSupervisor = request.args[3]?.startsWith("/tmp/ocv5-289-v2-supervisor-");
    const isKeeper = request.args[3]?.startsWith("/tmp/ocv5-289-v2-keeper-");
    const isCleanup = request.args[2]?.includes("print('clean')");
    const isProof = request.args[2]?.includes("terminal.json");
    const phase = isModel ? "model" : isSupervisor ? "supervisor"
      : isKeeper ? "keeper" : isCleanup ? "cleanup" : isProof ? "proof" : "stage";
    stages.push(phase);
    active--;
    if (phase === "stage") opts.advanceAtStage?.();
    if (phase === "keeper" && opts.failPhase === "keeper_known") {
      throw new BoxExecTransportError("BOX_EXEC_REMOTE_EXIT", true, 1);
    }
    if (opts.failPhase === phase) throw new BoxExecTransportError("BOX_EXEC_TRANSPORT_UNKNOWN", false);
    if (phase === "stage" && opts.failPhase === "stage_typeerror") {
      throw new TypeError("getReader locked before terminal frame");
    }
    if (isModel) {
      proofDir = request.args[request.args.indexOf("--proof-dir") + 1] ?? "";
      leaseEpoch = request.args[request.args.indexOf("--lease-epoch") + 1] ?? "";
      assert.equal(request.environment.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "256");
      const output = opts.badCli
        ? cliOutput.replace('"content":[{"type":"text","text":"answer"}]',
          '"content":[{"type":"text","text":"contradiction"}]')
        : cliOutput;
      if (opts.holdModel) {
        const lines = output.split("\n");
        options.onStdout?.(lines.slice(0, 4).join("\n") + "\n");
        await Promise.race([new Promise<void>((resolve) => { releaseModel = resolve; }),
          new Promise<never>((_, reject) => {
            const cancelled = () => reject(new BoxExecTransportError("BOX_EXEC_ABORTED", false));
            if (options.signal?.aborted) cancelled();
            else options.signal?.addEventListener("abort", cancelled, { once: true });
          })]);
        options.onStdout?.(lines.slice(4).join("\n"));
      } else options.onStdout?.(output);
      return ok(output);
    }
    if (isSupervisor || isKeeper) return ok(Array.from(
      { length: (request.args.length - 3) / 4 }, (_, i) => request.args[5 + i * 4]).join(","));
    if (isProof) return ok(JSON.stringify({ runNonce: proofDir.slice(-24), leaseEpoch,
      keeperPid: 101, cliPid: 102, reason: "worker_complete", revision: 1 }) + "\n");
    if (isCleanup) return ok("clean\n");
    return ok();
  } };
  const service = new BoxTextFetch({ supervisorAsset: Buffer.from("#!/usr/bin/python3\nprint('fixture')\n"),
    keeperAsset: Buffer.from("#!/usr/bin/python3\nprint('keeper fixture')\n"),
    registry,
    journal: { admit: async () => { journalCalls.push("admit");
        if (opts.journalFailPhase === "admit") throw new Error("db down"); },
      markRunning: async () => { journalCalls.push("running");
        if (opts.journalFailPhase === "running") throw new Error("db down"); },
      markPrestartStopped: async () => { journalCalls.push("prestart_stopped"); },
      markUnknown: async () => { journalCalls.push("unknown"); },
      complete: async (evidence) => { journalCalls.push("complete");
        journalUsage = evidence.usage;
        if (opts.journalFailPhase === "complete") throw new Error("db down"); } },
    maxOutputTokensForModel: (value) => value === model || value === canonicalAlias ? 128_000 : null,
    resolveTarget: async () => {
      if (opts.resolverThrow) throw new Error("raw credential detail must not leak");
      return { accountId: 20n, exec: runner, dispose: opts.onDispose };
    },
    onUnknown: async ({ phase }) => {
      unknowns.push(phase);
      if (opts.hangUnknown) await new Promise<void>(() => {});
    },
    now: () => now, budgetMs: 600_000 });
  return { service, registry, stages, unknowns, journalCalls,
    getJournalUsage: () => journalUsage, getMaxActive: () => maxActive,
    advance: (ms: number) => { now += ms; }, releaseModel: () => releaseModel() };
}

test("one authenticated proxy fetch stages serially, returns billable SSE, then releases capacity", async () => {
  const f = fixture();
  const response = await f.service.fetch(input);
  assert.equal(response.status, 200);
  const sse = await response.text();
  assert.ok(sse.includes("event: message_stop"));
  assert.ok(sse.includes('"index":0'), "visible original index=1 is normalized");
  const observer = new _UsageObserver();
  observer.push(sse); observer.flush();
  const result = observer.result();
  assert.equal(result.kind, "final");
  if (result.kind === "final") {
    assert.deepEqual(result.usage, { input_tokens: 2n, output_tokens: 7n,
      cache_read_tokens: 20n, cache_write_tokens: 0n });
  }
  assert.equal(f.stages.filter((phase) => phase === "model").length, 1);
  assert.equal(f.stages.at(-1), "cleanup");
  assert.equal(f.getMaxActive(), 1, "stage steps may not overlap");
  assert.deepEqual(f.registry.counts(3n, 20n), { user: 0, account: 0 });
  assert.deepEqual(f.unknowns, []);
  assert.deepEqual(f.journalCalls, ["admit", "running", "complete"]);
  assert.deepEqual(f.getJournalUsage(), { inputTokens: 2, outputTokens: 7,
    cacheReadTokens: 20, cacheWriteTokens: 0 });
});

test("text batch stages both immutable assets in one Exec without changing billing", async () => {
  const previous = process.env.OC_BOX_ASSET_BATCH;
  process.env.OC_BOX_ASSET_BATCH = "1";
  try {
    const f = fixture();
    const response = await f.service.fetch(input);
    assert.ok((await response.text()).includes("event: message_stop"));
    assert.equal(f.stages.filter((phase) => phase === "supervisor").length, 1);
    assert.equal(f.stages.filter((phase) => phase === "keeper").length, 0);
    assert.equal(f.stages.filter((phase) => phase === "model").length, 1);
    assert.deepEqual(f.journalCalls, ["admit", "running", "complete"]);
  } finally {
    if (previous === undefined) delete process.env.OC_BOX_ASSET_BATCH;
    else process.env.OC_BOX_ASSET_BATCH = previous;
  }
});

test("canonical billing identity stays distinct from the Box upstream model", async () => {
  const f = fixture();
  const response = await f.service.fetch({ ...input, canonicalModel: canonicalAlias,
    canonicalBody: { ...body, model: canonicalAlias } });
  assert.ok((await response.text()).includes("event: message_stop"));
  assert.equal(f.stages.filter((phase) => phase === "model").length, 1);
  assert.deepEqual(f.journalCalls, ["admit", "running", "complete"]);
});

test("missing remote stop proof withholds final usage and fences capacity", async () => {
  const f = fixture({ failPhase: "proof" });
  const response = await f.service.fetch(input);
  await assert.rejects(() => response.text(),
    (error: unknown) => error instanceof BoxTextFetchError
      && error.code === "BOX_MODEL_OUTCOME_UNKNOWN");
  assert.ok(f.stages.includes("model"));
  assert.ok(f.stages.includes("proof"));
  assert.ok(!f.stages.includes("cleanup"));
  assert.deepEqual(f.registry.counts(3n, 20n), { user: 1, account: 1 });
  assert.ok(f.unknowns.includes("model_outcome_unknown"));
  // Test teardown only: the fake transport cannot produce later reconciliation.
  f.registry.confirmRemoteStopped(f.registry.last!);
});

test("journal admission or start failure cannot issue a paid Box model call", async () => {
  for (const phase of ["admit", "running"] as const) {
    const f = fixture({ journalFailPhase: phase });
    await assert.rejects(() => f.service.fetch(input),
      (error: unknown) => error instanceof BoxTextFetchError
        && error.code === (phase === "admit"
          ? "BOX_JOURNAL_ADMISSION_FAILED" : "BOX_JOURNAL_START_FAILED"));
    assert.ok(!f.stages.includes("model"));
    for (let i = 0; i < 50 && f.registry.counts(3n, 20n).account !== 0; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(f.registry.counts(3n, 20n), { user: 0, account: 0 });
    if (phase === "running") assert.ok(f.journalCalls.includes("prestart_stopped"));
  }
});

test("durable usage write failure withholds terminal SSE and keeps recovery fence", async () => {
  const f = fixture({ journalFailPhase: "complete" });
  const response = await f.service.fetch(input);
  await assert.rejects(() => response.text(),
    (error: unknown) => error instanceof BoxTextFetchError
      && error.code === "BOX_BILLING_EVIDENCE_UNAVAILABLE");
  assert.equal(f.stages.filter((phase) => phase === "model").length, 1);
  assert.ok(f.journalCalls.includes("complete"));
  assert.deepEqual(f.registry.counts(3n, 20n), { user: 1, account: 1 });
  f.registry.confirmRemoteStopped(f.registry.last!); // teardown after fence assertion
});

test("BoxTextFetch delivers first model text delta before remote model exit", async () => {
  const f = fixture({ holdModel: true });
  const response = await f.service.fetch(input);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    while (!received.includes("event: content_block_delta")) {
      const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("FIRST_DELTA_BUFFERED_UNTIL_EXIT")), 800);
      })]);
      if (timer) { clearTimeout(timer); timer = undefined; }
      assert.equal(chunk.done, false);
      received += decoder.decode(chunk.value, { stream: true });
    }
    assert.ok(f.stages.includes("model"));
    assert.ok(!f.stages.includes("cleanup"), "remote CLI remains held before exit");
    assert.ok(!received.includes("event: message_delta"), "final usage cannot escape early");
  } finally {
    if (timer) clearTimeout(timer);
    f.releaseModel();
  }
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    received += decoder.decode(part.value, { stream: true });
  }
  received += decoder.decode();
  assert.ok(received.includes("event: message_stop"));
  const observer = new _UsageObserver(); observer.push(received); observer.flush();
  assert.equal(observer.result().kind, "final");
  assert.equal(f.stages.at(-1), "cleanup");
});

test("client cancels a live Box response without cleanup or duplicate unknown notice", async () => {
  const f = fixture({ holdModel: true });
  const response = await f.service.fetch(input);
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(f.unknowns, ["request_abort"]);
  assert.ok(!f.stages.includes("cleanup"));
  assert.deepEqual(f.registry.counts(3n, 20n), { user: 1, account: 1 });
  f.registry.confirmRemoteStopped(f.registry.last!);
});

test("invalid final Box snapshot cannot emit final usage on live response", async () => {
  const f = fixture({ badCli: true });
  const reader = (await f.service.fetch(input)).body!.getReader();
  const observer = new _UsageObserver();
  let sawStreamError = false;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      observer.push(new TextDecoder().decode(part.value));
    }
  } catch (error) {
    sawStreamError = error instanceof BoxTextFetchError
      && error.code === "BOX_MODEL_PROTOCOL_INVALID";
  }
  observer.flush();
  assert.equal(sawStreamError, true);
  assert.equal(observer.result().kind, "partial");
});

test("unknown stage never starts model or cleans, and holds account capacity", async () => {
  const f = fixture({ failPhase: "stage" });
  await assert.rejects(f.service.fetch(input),
    (error: unknown) => error instanceof BoxTextFetchError && error.code === "BOX_STAGING_FAILED");
  assert.ok(!f.stages.includes("model"));
  assert.ok(!f.stages.includes("cleanup"));
  assert.deepEqual(f.unknowns, ["staging_unknown"]);
  assert.deepEqual(f.registry.counts(3n, 20n), { user: 1, account: 1 });
  f.registry.confirmRemoteStopped(f.registry.last!); // test-only authoritative fence
});

test("unknown keeper stage holds capacity; known remote keeper failure releases before model", async () => {
  const unknown = fixture({ failPhase: "keeper" });
  await assert.rejects(unknown.service.fetch(input),
    (error: unknown) => error instanceof BoxTextFetchError && error.code === "BOX_STAGING_FAILED");
  assert.ok(unknown.stages.includes("keeper") && !unknown.stages.includes("model"));
  assert.ok(!unknown.stages.includes("cleanup"));
  assert.deepEqual(unknown.unknowns, ["staging_unknown"]);
  assert.deepEqual(unknown.registry.counts(3n, 20n), { user: 1, account: 1 });
  unknown.registry.confirmRemoteStopped(unknown.registry.last!);

  const known = fixture({ failPhase: "keeper_known" });
  await assert.rejects(known.service.fetch(input),
    (error: unknown) => error instanceof BoxTextFetchError && error.code === "BOX_STAGING_FAILED");
  assert.ok(known.stages.includes("keeper") && !known.stages.includes("model"));
  assert.deepEqual(known.unknowns, []);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(known.registry.counts(3n, 20n), { user: 0, account: 0 });
});

test("unclassified stage reader error defaults to unknown, never cleanup/release", async () => {
  const f = fixture({ failPhase: "stage_typeerror" });
  await assert.rejects(f.service.fetch(input),
    (error: unknown) => error instanceof BoxTextFetchError && error.code === "BOX_STAGING_FAILED");
  assert.ok(!f.stages.includes("model") && !f.stages.includes("cleanup"));
  assert.deepEqual(f.unknowns, ["staging_unknown"]);
  assert.deepEqual(f.registry.counts(3n, 20n), { user: 1, account: 1 });
  f.registry.confirmRemoteStopped(f.registry.last!);
});

test("late stage budget exhaustion rejects before any paid model start", async () => {
  let advanced = false;
  const f = fixture({ advanceAtStage: () => {
    if (!advanced) { f.advance(485_000); advanced = true; }
  } });
  await assert.rejects(f.service.fetch(input),
    (error: unknown) => error instanceof BoxTextFetchError && error.code === "BOX_BUDGET_EXHAUSTED");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(!f.stages.includes("model"));
  assert.equal(f.stages.at(-1), "cleanup");
  assert.deepEqual(f.registry.counts(3n, 20n), { user: 0, account: 0 });
});

test("GC unknown does not erase a completed billable SSE response", async () => {
  const f = fixture({ failPhase: "cleanup" });
  const response = await f.service.fetch(input);
  assert.equal(response.status, 200);
  const observer = new _UsageObserver();
  observer.push(await response.text()); observer.flush();
  assert.equal(observer.result().kind, "final");
  assert.deepEqual(f.unknowns, ["completed_gc_unknown"]);
  assert.deepEqual(f.registry.counts(3n, 20n), { user: 1, account: 1 });
  f.registry.confirmRemoteStopped(f.registry.last!);
});

test("a hung durable unknown notifier cannot hold successful SSE past cleanup bound", async () => {
  const f = fixture({ failPhase: "cleanup", hangUnknown: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([f.service.fetch(input),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("UNKNOWN_NOTIFIER_HUNG")), 900);
      })]);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes("event: message_stop"));
    assert.deepEqual(f.unknowns, ["completed_gc_unknown"]);
    assert.deepEqual(f.registry.counts(3n, 20n), { user: 1, account: 1 });
  } finally {
    if (timer) clearTimeout(timer);
    f.registry.confirmRemoteStopped(f.registry.last!);
  }
});

test("protocol failure after known supervisor exit cleans and releases without inventing SSE", async () => {
  const f = fixture({ badCli: true });
  const response = await f.service.fetch(input);
  await assert.rejects(response.text(),
    (error: unknown) => error instanceof BoxTextFetchError && error.code === "BOX_MODEL_PROTOCOL_INVALID");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.stages.at(-1), "cleanup");
  assert.deepEqual(f.registry.counts(3n, 20n), { user: 0, account: 0 });
});

test("resolver errors are fixed-code and cannot leak raw credential details", async () => {
  const f = fixture({ resolverThrow: true });
  await assert.rejects(f.service.fetch(input),
    (error: unknown) => error instanceof BoxTextFetchError
      && error.code === "BOX_TARGET_UNAVAILABLE"
      && !error.message.includes("credential detail"));
  assert.deepEqual(f.stages, []);
});

test("known terminal closes private egress, unknown retains it for reconciliation", async () => {
  let knownClosed = 0;
  const known = fixture({ onDispose: () => { knownClosed++; } });
  await (await known.service.fetch(input)).text();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(knownClosed, 1);

  let unknownClosed = 0;
  const unknown = fixture({ failPhase: "model", onDispose: () => { unknownClosed++; } });
  const response = await unknown.service.fetch(input);
  await assert.rejects(response.text(),
    (error: unknown) => error instanceof BoxTextFetchError && error.code === "BOX_MODEL_OUTCOME_UNKNOWN");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(unknownClosed, 0);
  unknown.registry.confirmRemoteStopped(unknown.registry.last!);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(unknownClosed, 1);
});

test("a resolver that completes after abort releases its private target without opening a lease", async () => {
  let finish!: (target: { accountId: bigint; exec: Runner; dispose: () => void }) => void;
  let closed = 0;
  const registry = new SpyRegistry({ maxPerUser: 1, maxPerAccount: 1, leaseMs: 600_000 });
  const service = new BoxTextFetch({
    supervisorAsset: Buffer.from("fixture"), keeperAsset: Buffer.from("keeper"), registry,
    journal: noopJournal,
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: () => new Promise((resolve) => { finish = resolve; }),
    onUnknown: async () => {},
  });
  const controller = new AbortController();
  const pending = service.fetch({ ...input, init: { ...input.init, signal: controller.signal } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending,
    (error: unknown) => error instanceof BoxTextFetchError && error.code === "BOX_FETCH_ABORTED");
  finish({ accountId: 20n, exec: { run: async () => ok() }, dispose: () => { closed++; } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
  assert.equal(registry.last, null);
});

test("failed orphan close retains ownership for explicit retry", async () => {
  let finish!: (target: { accountId: bigint; exec: Runner; dispose: () => void }) => void;
  let calls = 0;
  const service = new BoxTextFetch({
    supervisorAsset: Buffer.from("fixture"), keeperAsset: Buffer.from("keeper"),
    registry: new SpyRegistry({ maxPerUser: 1, maxPerAccount: 1, leaseMs: 600_000 }),
    journal: noopJournal,
    maxOutputTokensForModel: () => 128_000,
    resolveTarget: () => new Promise((resolve) => { finish = resolve; }),
    onUnknown: async () => {},
  });
  const controller = new AbortController();
  const pending = service.fetch({ ...input, init: { ...input.init, signal: controller.signal } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending);
  finish({ accountId: 20n, exec: { run: async () => ok() }, dispose: () => {
    calls++;
    if (calls === 1) throw new Error("simulated close failure");
  } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(await service.retryFailedOrphanCleanup(), 0);
  assert.equal(calls, 2);
});

test("real fetch close failure stays owned and recovers through public identity retry", async () => {
  let calls = 0;
  const f = fixture({ onDispose: () => {
    calls++;
    if (calls === 1) throw new Error("simulated private egress close failure");
  } });
  const response = await f.service.fetch(input);
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes("event: message_stop"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(f.registry.counts(3n, 20n), { user: 1, account: 1 });
  assert.equal(await f.service.retryFailedOrphanCleanup(), 0,
    "a leased target is not an orphan");
  assert.throws(() => f.service.retryFailedCleanup({ uid: 3n,
    sessionId: "session-289", accountId: 21n }));
  await f.service.retryFailedCleanup({ uid: 3n,
    sessionId: "session-289", accountId: 20n });
  assert.equal(calls, 2);
  assert.deepEqual(f.registry.counts(3n, 20n), { user: 0, account: 0 });
});
