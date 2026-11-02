import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findCompletedBoxReplay } from "./boxReplayCompleted.js";
import { readBoxReplayMessage, writeBoxReplayMessage } from "./boxReplayMessageFile.js";
import type { BoxReplayIdentity } from "./boxDurableJournal.js";
import type { ProxyBody } from "./shared.js";
import { _UsageObserver } from "./shared.js";

const message = { type: "message", role: "assistant", id: "msg_replay_http",
  model: "claude-opus-5-5", content: [{ type: "text", text: "synthetic answer" }],
  stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 3,
    cache_read_input_tokens: 8, cache_creation_input_tokens: 0 } };
const body = { model: "box-api-claude-opus-5-5", max_tokens: 128, stream: true,
  messages: [{ role: "user", content: "synthetic" }] } as ProxyBody;

test("one private completed Message serves SSE and JSON without another model call", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ocv5-box-replay-http-"));
  try {
    const pointer = await writeBoxReplayMessage(directory, { uid: "3",
      requestId: "original-http", runNonce: "a".repeat(24),
      leaseEpoch: "b".repeat(32), roundNo: 1 }, message);
    const identity: BoxReplayIdentity = { requestId: "original-http",
      rootRequestId: "original-http", uid: 3n, accountId: 20n,
      runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32),
      invocationMode: "text", state: "terminal", roundNo: 1,
      spoolOffset: 0, rootLaunchPermit: false, messagePointer: pointer };
    let lookups = 0, reads = 0;
    const deps = { journal: { findReplayIdentity: async () => { lookups++; return identity; } },
      readMessage: async (p: typeof pointer) => { reads++;
        return readBoxReplayMessage(directory, p); } } as never;
    const input = { uid: 3n, canonicalModel: body.model,
      canonicalBody: body, upstreamModel: message.model };
    const streamed = await findCompletedBoxReplay(input, deps);
    assert.equal(streamed.kind, "ready");
    if (streamed.kind !== "ready") return;
    assert.equal(streamed.response.headers.get("content-type"), "text/event-stream");
    const sse = await streamed.response.text();
    assert.match(sse, /msg_replay_http/);
    const observer = new _UsageObserver();
    observer.push(sse); observer.flush();
    assert.equal(observer.result().kind, "final");
    const fallback = await findCompletedBoxReplay({ ...input,
      canonicalBody: { ...body, stream: false } as unknown as ProxyBody }, deps);
    assert.equal(fallback.kind, "ready");
    if (fallback.kind !== "ready") return;
    assert.equal(fallback.response.headers.get("content-type"), "application/json");
    assert.deepEqual(await fallback.response.json(), message);
    assert.equal(lookups, 2);
    assert.equal(reads, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing and pending rows never start Box or invent a successful response", async () => {
  const input = { uid: 3n, canonicalModel: body.model,
    canonicalBody: body, upstreamModel: message.model };
  assert.deepEqual(await findCompletedBoxReplay(input, { journal: {
    findReplayIdentity: async () => null }, readMessage: async () => {
      throw new Error("must not read"); } } as never), { kind: "missing" });
  const pending = await findCompletedBoxReplay(input, { journal: {
    findReplayIdentity: async () => ({ requestId: "original-http",
      rootRequestId: "original-http", uid: 3n, accountId: 20n,
      runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32),
      invocationMode: "text", state: "unknown", roundNo: 1,
      spoolOffset: 0, rootLaunchPermit: false }) },
    readMessage: async () => { throw new Error("must not read"); } } as never);
  assert.equal(pending.kind, "pending");
});

test("a unique durable failure survives restart without reading a message or launching Box", async () => {
  const failure = { version: 1 as const, code: "BOX_TOOL_SNAPSHOT_MISMATCH" as const,
    phase: "continuation" as const, observedAtMs: 1_000, requestId: "original-failed" };
  let failureReads = 0, messageReads = 0;
  const deps = { journal: {
    findReplayIdentity: async () => null,
    findReadOnlyFallback: async () => { failureReads++; return { kind: "failure" as const, failure }; },
  }, readMessage: async () => { messageReads++; throw new Error("must not read"); } };
  const input = { uid: 3n, canonicalModel: body.model,
    canonicalBody: { ...body, stream: false } as ProxyBody, upstreamModel: message.model };
  assert.deepEqual(await findCompletedBoxReplay(input, deps), { kind: "failed", failure });
  assert.equal(failureReads, 1);
  assert.equal(messageReads, 0);
  assert.deepEqual(await findCompletedBoxReplay({ ...input, canonicalBody: body }, deps),
    { kind: "missing" }, "historical failure must not prevent a new streaming attempt");
  assert.equal(failureReads, 1);
});

test("a live pending attempt takes precedence over a historical failure", async () => {
  const identity: BoxReplayIdentity = { requestId: "current-pending",
    rootRequestId: "current-pending", uid: 3n, accountId: 20n,
    runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32), invocationMode: "text",
    state: "unknown", roundNo: 1, spoolOffset: 0, rootLaunchPermit: false };
  let failedReads = 0;
  const replay = await findCompletedBoxReplay({ uid: 3n, canonicalModel: body.model,
    canonicalBody: { ...body, stream: false } as ProxyBody, upstreamModel: message.model }, {
    journal: { findReplayIdentity: async () => identity,
      findReadOnlyFallback: async () => { failedReads++; return null; } },
    readMessage: async () => { throw new Error("must not read"); },
  });
  assert.deepEqual(replay, { kind: "pending", identity });
  assert.equal(failedReads, 0);
});

for (const completed of [false, true]) {
  test(`an attempt admitted after the initial miss wins as ${completed ? "ready" : "pending"}`, async () => {
    const identity: BoxReplayIdentity = { requestId: "new-between-lookups",
      rootRequestId: "new-between-lookups", uid: 3n, accountId: 20n,
      runNonce: "c".repeat(24), leaseEpoch: "d".repeat(32), invocationMode: "text",
      state: completed ? "terminal" : "unknown", roundNo: 1, spoolOffset: 0,
      rootLaunchPermit: false, ...(completed ? { messagePointer: {
        version: 1, uid: "3", requestId: "new-between-lookups",
        runNonce: "c".repeat(24), leaseEpoch: "d".repeat(32), roundNo: 1,
        sha256: "a".repeat(64), bytes: 1,
      } } : {}) };
    let ordinaryLookups = 0, atomicLookups = 0, messageReads = 0;
    const result = await findCompletedBoxReplay({ uid: 3n, canonicalModel: body.model,
      canonicalBody: { ...body, stream: false } as ProxyBody, upstreamModel: message.model }, {
      journal: {
        findReplayIdentity: async () => { ordinaryLookups++; return null; },
        findReadOnlyFallback: async () => { atomicLookups++;
          return { kind: "identity", identity }; },
      }, readMessage: async () => { messageReads++; return message; },
    });
    assert.equal(result.kind, completed ? "ready" : "pending");
    assert.equal(ordinaryLookups, 1);
    assert.equal(atomicLookups, 1);
    assert.equal(messageReads, completed ? 1 : 0);
    if (result.kind === "ready") assert.deepEqual(await result.response.json(), message);
    if (result.kind === "pending") assert.equal(result.identity, identity);
  });
}
