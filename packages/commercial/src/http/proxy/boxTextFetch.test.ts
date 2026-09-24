import test from "node:test";
import assert from "node:assert/strict";
import { BoxTextFetch, BoxTextFetchError } from "./boxTextFetch.js";
import { BoxExecTransportError, type BoxExecResult,
  type BoxExecTransport } from "./boxExecTransport.js";
import { BoxInvocationRegistry, type BoxInvocationLease } from "./boxInvocationRegistry.js";
import { _UsageObserver } from "./shared.js";
import { BOX_INTERNAL_ENDPOINT } from "./upstream.js";
import type { BoxCcExecRequest } from "@openclaude/gateway";

const model = "claude-opus-5";
const body = { model, max_tokens: 256, stream: true,
  messages: [{ role: "user", content: "synthetic text only" }] };
const input = { uid: 3n, sessionId: "session-289", requestId: "req-289",
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

class SpyRegistry extends BoxInvocationRegistry {
  last: BoxInvocationLease | null = null;
  override open(input: Parameters<BoxInvocationRegistry["open"]>[0]): BoxInvocationLease {
    this.last = super.open(input);
    return this.last;
  }
}
type Runner = Pick<BoxExecTransport, "run">;
function fixture(opts: { failPhase?: "stage" | "stage_typeerror" | "model" | "cleanup";
  advanceAtStage?: () => void; hangUnknown?: boolean; badCli?: boolean;
  resolverThrow?: boolean; onDispose?: () => void } = {}) {
  let now = 1000, active = 0, maxActive = 0;
  const stages: string[] = [], unknowns: string[] = [];
  const registry = new SpyRegistry({ maxPerUser: 1, maxPerAccount: 1, leaseMs: 600_000 }, () => now);
  const runner: Runner = { async run(request: BoxCcExecRequest): Promise<BoxExecResult> {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const isModel = request.args[0]?.startsWith("/tmp/ocv5-289-supervisor-");
    const isSupervisor = request.args[2]?.startsWith("/tmp/ocv5-289-supervisor-");
    const isCleanup = request.args[1]?.includes("print('clean')");
    const phase = isModel ? "model" : isSupervisor ? "supervisor" : isCleanup ? "cleanup" : "stage";
    stages.push(phase);
    active--;
    if (phase === "stage") opts.advanceAtStage?.();
    if (opts.failPhase === phase) throw new BoxExecTransportError("BOX_EXEC_TRANSPORT_UNKNOWN", false);
    if (phase === "stage" && opts.failPhase === "stage_typeerror") {
      throw new TypeError("getReader locked before terminal frame");
    }
    if (isModel) {
      assert.equal(request.environment.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "256");
      return ok(opts.badCli ? "not-json\n" : cliOutput);
    }
    if (isSupervisor) return ok(request.args[4]);
    if (isCleanup) return ok("clean\n");
    return ok();
  } };
  const service = new BoxTextFetch({ supervisorAsset: Buffer.from("#!/usr/bin/python3\nprint('fixture')\n"),
    registry, maxOutputTokensForModel: (value) => value === model ? 128_000 : null,
    resolveTarget: async () => {
      if (opts.resolverThrow) throw new Error("raw credential detail must not leak");
      return { accountId: 20n, exec: runner, dispose: opts.onDispose };
    },
    onUnknown: async ({ phase }) => {
      unknowns.push(phase);
      if (opts.hangUnknown) await new Promise<void>(() => {});
    },
    now: () => now, budgetMs: 600_000 });
  return { service, registry, stages, unknowns, getMaxActive: () => maxActive,
    advance: (ms: number) => { now += ms; } };
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
  await assert.rejects(f.service.fetch(input),
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
  await known.service.fetch(input);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(knownClosed, 1);

  let unknownClosed = 0;
  const unknown = fixture({ failPhase: "model", onDispose: () => { unknownClosed++; } });
  await assert.rejects(unknown.service.fetch(input),
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
    supervisorAsset: Buffer.from("fixture"), registry,
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
    supervisorAsset: Buffer.from("fixture"),
    registry: new SpyRegistry({ maxPerUser: 1, maxPerAccount: 1, leaseMs: 600_000 }),
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
