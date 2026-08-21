/**
 * Commercial container → master lossless turn-tape sink tests.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/v3MasterSink.test.ts
 */

import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  LOSSLESS_TURN_TAPE_LEGACY_AGENT_ID,
  LOSSLESS_TURN_TAPE_PART_BYTES,
} from "@openclaude/protocol";

import {
  fetchAskUserPermissionCard,
  SERVER_AUTHORED_PATH,
  attemptSend,
  buildLosslessTurnTapeRequests,
  buildPermissionSidecarV1Body,
  iterateLosslessTurnTapeParts,
  isPermissionSidecarPayload,
  getV3MasterSinkOrNull,
  makeV3MasterSink,
  readV3MasterSinkConfig,
  setV3MasterSinkSingleton,
  V3SinkError,
  type V3MasterSinkPayload,
  type V3MasterSinkWirePayload,
} from "../v3MasterSink.js";
import type { V3MasterRetryQueue } from "../v3MasterRetryQueue.js";

const PAYLOAD: V3MasterSinkPayload = {
  sessionId: "sess12345",
  agentId: "main",
  turnIndex: 1,
  status: "completed",
  text: "hello world",
};

const CFG = {
  baseUrl: "http://master.test:18791",
  bearer: "oc-v3.7." + "a".repeat(64),
};

type Capture = { url: string; method: string; body: string; headers: Record<string, string> };

function makeFetcher(opts: {
  status?: number;
  body?: string;
  throwError?: Error;
} = {}): {
  fetcher: typeof import("undici").request;
  captures: Capture[];
} {
  const captures: Capture[] = [];
  const fn = async (url: string, init: any) => {
    captures.push({
      url,
      method: String(init?.method ?? "GET"),
      body: typeof init?.body === "string" ? init.body : "",
      headers: init?.headers ?? {},
    });
    if (opts.throwError) throw opts.throwError;
    const text = opts.body ?? "";
    return {
      statusCode: opts.status ?? 200,
      headers: {},
      trailers: {},
      opaque: undefined,
      context: {},
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(text, "utf8");
        },
        text: async () => text,
      } as any,
    };
  };
  return { fetcher: fn as unknown as typeof import("undici").request, captures };
}

function decodeCapturedTape(captures: Capture[]): {
  envelopes: Array<Record<string, any>>;
  canonical: Buffer;
  payload: Record<string, any>;
} {
  const envelopes = captures.map((capture) => JSON.parse(capture.body) as Record<string, any>);
  const visibles = envelopes.filter((envelope) => envelope.action === "visible");
  const parts = envelopes.filter((envelope) => envelope.action === "part");
  const finalizes = envelopes.filter((envelope) => envelope.action === "finalize");
  assert.equal(visibles.length, 1);
  assert.equal(envelopes[0]?.action, "visible", "visible commit must precede every multipart part");
  assert.equal(finalizes.length, 1);
  assert.equal(parts.length, finalizes[0]!.partCount);
  parts.sort((a, b) => a.partIndex - b.partIndex);
  const canonical = Buffer.concat(parts.map((part) => Buffer.from(part.data, "base64")));
  assert.equal(canonical.length, finalizes[0]!.totalBytes);
  assert.equal(createHash("sha256").update(canonical).digest("hex"), finalizes[0]!.tapeSha256);
  return { envelopes, canonical, payload: JSON.parse(canonical.toString("utf8")) };
}

function fakeQueue(): V3MasterRetryQueue & { enqueued: any[]; kicks: number } {
  const enqueued: any[] = [];
  return {
    enqueued,
    kicks: 0,
    async stageDurable(entry) {
      enqueued.push(entry);
      return `1-${String(enqueued.length).padStart(16, "0")}.json`;
    },
    async ackDurable() { enqueued.shift(); },
    async enqueueDurable(entry) { enqueued.push(entry); },
    async drainOnce() {
      return {
        considered: 0,
        drained: 0,
        retried: 0,
        ttlDropped: 0,
        fatalDropped: 0,
        errors: 0,
        pending: 0,
      };
    },
    kick() { this.kicks++; },
    startPeriodic() {},
    stopPeriodic() {},
    async pendingCount() { return enqueued.length; },
    async hasEntryForDispatch(dispatchId, attemptNo) {
      return enqueued.some(
        (e) => e?.payload?.dispatchId === dispatchId && e?.payload?.attemptNo === attemptNo,
      );
    },
  };
}

describe("lossless v2 turn tape", () => {
  test("large thinking/tool/subagent payload is split and reconstructs byte-for-byte", () => {
    const thinkingText = "推理😀".repeat(90_000);
    const toolOutput = "tool-output\n".repeat(45_000);
    const childText = "child-detail".repeat(40_000);
    const tools = Array.from({ length: 75 }, (_, index) => ({
      toolUseId: `tu-${index}`,
      blockId: `tu-${index}`,
      toolName: "Bash",
      inputJson: { command: `${index}:` + "x".repeat(8_000) },
      inputPreview: "derived preview",
      output: index === 0 ? toolOutput : `result-${index}`,
      isError: false,
      durationMs: 1,
      ts: index + 1,
      arrivedAt: index + 1,
    }));
    const agentGroups = Array.from({ length: 75 }, (_, index) => ({
      runId: `dlg-${index}`,
      agentId: "reviewer",
      goal: `review-${index}`,
      status: "ok" as const,
      resultSummary: index === 0 ? childText : `child-${index}`,
      transcript: [{ kind: "text", text: index === 0 ? childText : `child-${index}` }],
      completedAt: index + 100,
    }));
    const payload: V3MasterSinkPayload = {
      ...PAYLOAD,
      text: "final answer".repeat(30_000),
      thinkingText,
      tools,
      agentGroups,
      createdAt: 1_783_944_000_000,
    };

    const tape = buildLosslessTurnTapeRequests(payload);
    const parts = [...iterateLosslessTurnTapeParts(tape)];
    assert.ok(parts.length > 4);
    const reconstructed = Buffer.concat(parts.map((part) => {
      const bytes = Buffer.from(part.data, "base64");
      assert.ok(bytes.length <= LOSSLESS_TURN_TAPE_PART_BYTES);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), part.partSha256);
      return bytes;
    }));
    assert.deepEqual(reconstructed, tape.canonical);
    const parsed = JSON.parse(reconstructed.toString("utf8"));
    assert.equal(parsed.thinkingText, thinkingText);
    assert.equal(parsed.tools.length, 75);
    assert.equal(parsed.tools[0].output, toolOutput);
    assert.equal(parsed.tools[0].inputJson.command, "0:" + "x".repeat(8_000));
    assert.equal(parsed.agentGroups.length, 75);
    assert.equal(parsed.agentGroups[0].resultSummary, childText);
    assert.equal(parsed.agentGroups[0].transcript[0].text, childText);
    assert.doesNotMatch(reconstructed.toString("utf8"), /…\[truncated\]/);
  });

  test("canonical bytes and identities are deterministic", () => {
    const payload = { ...PAYLOAD, createdAt: 123, turnKey: "a".repeat(64) };
    const first = buildLosslessTurnTapeRequests(payload);
    const second = buildLosslessTurnTapeRequests({ ...payload });
    assert.deepEqual(first.canonical, second.canonical);
    assert.deepEqual(
      [...iterateLosslessTurnTapeParts(first)],
      [...iterateLosslessTurnTapeParts(second)],
    );
    assert.deepEqual(first.visible, second.visible);
    assert.deepEqual(first.finalize, second.finalize);
  });

  test("RFC §2.4:payload 带 dispatch 身份 → 每个 part+finalize 信封携带;缺省则不携带(legacy 形状不变)", () => {
    // 2026-07-18 实证回归门:此前信封漏传 dispatchId/attemptNo → 全量 tape 无身份 →
    // turn_dispatches 恒停 accepted、零 terminal(§2.4 收敛全断)。
    const withDispatch = buildLosslessTurnTapeRequests({
      ...PAYLOAD,
      createdAt: 123,
      turnKey: "c".repeat(64),
      dispatchId: "3e0a2b52-9d31-4c8f-9b6e-000000000001",
      attemptNo: 2,
    });
    for (const part of iterateLosslessTurnTapeParts(withDispatch)) {
      assert.equal(part.dispatchId, "3e0a2b52-9d31-4c8f-9b6e-000000000001");
      assert.equal(part.attemptNo, 2);
    }
    assert.equal(withDispatch.visible.dispatchId, "3e0a2b52-9d31-4c8f-9b6e-000000000001");
    assert.equal(withDispatch.visible.attemptNo, 2);
    assert.equal(withDispatch.finalize.dispatchId, "3e0a2b52-9d31-4c8f-9b6e-000000000001");
    assert.equal(withDispatch.finalize.attemptNo, 2);
    // 身份是信封元数据,canonical 本体语义不因信封补齐而改(payload 自身字段决定 canonical)。
    const parsed = JSON.parse(withDispatch.canonical.toString("utf8"));
    assert.equal(parsed.dispatchId, "3e0a2b52-9d31-4c8f-9b6e-000000000001");
    // legacy(无身份)payload:信封不得出现 undefined 字段污染既有形状。
    const legacy = buildLosslessTurnTapeRequests({ ...PAYLOAD, createdAt: 123, turnKey: "d".repeat(64) });
    assert.ok(!("dispatchId" in [...iterateLosslessTurnTapeParts(legacy)][0]!));
    assert.ok(!("dispatchId" in legacy.visible));
    assert.ok(!("dispatchId" in legacy.finalize));
  });

  test("auto-waive reason is fsynced on every envelope and canonical tape", () => {
    const tape = buildLosslessTurnTapeRequests({
      ...PAYLOAD,
      turnKey: "b".repeat(64),
      waiveReason: "platform_authority_expired",
      usage: { model: "kimi-k3-ark" },
    });
    assert.equal(tape.visible.waiveReason, "platform_authority_expired");
    assert.equal(tape.visible.model, "kimi-k3-ark");
    assert.equal(tape.finalize.waiveReason, "platform_authority_expired");
    assert.equal(tape.finalize.model, "kimi-k3-ark");
    assert.ok([...iterateLosslessTurnTapeParts(tape)].every(
      (part) =>
        part.waiveReason === "platform_authority_expired" &&
        part.model === "kimi-k3-ark",
    ));
    const canonical = JSON.parse(tape.canonical.toString("utf8"));
    assert.equal(canonical.waiveReason, "platform_authority_expired");
    assert.equal(canonical.usage.model, "kimi-k3-ark");
  });

  test("part envelopes never carry finalize.settlement; finalize keeps it", () => {
    const tape = buildLosslessTurnTapeRequests({
      ...PAYLOAD,
      createdAt: 123,
      turnKey: "e".repeat(64),
      dispatchId: "3e0a2b52-9d31-4c8f-9b6e-000000000002",
      attemptNo: 1,
    });
    assert.equal("settlement" in tape.visible, true);
    assert.equal(typeof tape.visible.settlement, "object");
    assert.equal("settlement" in tape.finalize, true);
    assert.equal(typeof tape.finalize.settlement, "object");
    const parts = [...iterateLosslessTurnTapeParts(tape)];
    assert.ok(parts.length >= 1);
    for (const part of parts) {
      assert.equal("settlement" in part, false);
      assert.equal(part.action, "part");
    }
  });
});

describe("readV3MasterSinkConfig", () => {
  test("requires both env values", () => {
    assert.equal(readV3MasterSinkConfig({}), null);
    assert.equal(readV3MasterSinkConfig({ OPENCLAUDE_V3_MASTER_BASE_URL: "http://x" }), null);
    assert.equal(readV3MasterSinkConfig({ OPENCLAUDE_V3_CONTAINER_TOKEN: "tok" }), null);
  });

  test("returns config and strips trailing slashes", () => {
    assert.deepEqual(readV3MasterSinkConfig({
      OPENCLAUDE_V3_MASTER_BASE_URL: "http://m.test:18791///",
      OPENCLAUDE_V3_CONTAINER_TOKEN: "tok",
    }), { baseUrl: "http://m.test:18791", bearer: "tok" });
  });
});

describe("attemptSend — multipart upload", () => {
  test("commits visible before every part, then uploads every part and finalize", async () => {
    const { fetcher, captures } = makeFetcher({ status: 200, body: '{"ok":true}' });
    const payload: V3MasterSinkPayload = {
      ...PAYLOAD,
      text: "正文".repeat(150_000),
      thinkingText: "思考".repeat(150_000),
      tools: Array.from({ length: 80 }, (_, index) => ({
        toolUseId: `tool-${index}`,
        blockId: `tool-${index}`,
        toolName: "Read",
        inputJson: { path: `/tmp/${index}`, exact: "i".repeat(2_000) },
        inputPreview: `/tmp/${index}`,
        output: "o".repeat(2_000),
        isError: false,
        durationMs: index,
        ts: index + 1,
        arrivedAt: index + 1,
      })),
      agentGroups: Array.from({ length: 80 }, (_, index) => ({
        runId: `run-${index}`,
        agentId: "worker",
        goal: `goal-${index}`,
        status: "ok" as const,
        resultSummary: "r".repeat(2_000),
        transcript: [{ kind: "thinking", text: "d".repeat(2_000) }],
        completedAt: index + 1,
      })),
    };

    await attemptSend(payload, { config: CFG, fetcher });
    assert.ok(captures.length > 2);
    assert.ok(captures.every((capture) => capture.url === `${CFG.baseUrl}${SERVER_AUTHORED_PATH}`));
    assert.ok(captures.every((capture) => capture.headers.authorization === `Bearer ${CFG.bearer}`));
    const decoded = decodeCapturedTape(captures);
    assert.equal(decoded.envelopes.at(-1)!.action, "finalize");
    assert.equal(decoded.payload.text, payload.text);
    assert.equal(decoded.payload.thinkingText, payload.thinkingText);
    const visible = decoded.envelopes[0]!;
    assert.equal(visible.action, "visible");
    assert.equal(visible.settlement.truncated, true);
    assert.ok(Buffer.byteLength(visible.settlement.text, "utf8") <= 128 * 1024);
    assert.ok(Buffer.byteLength(captures[0]!.body, "utf8") < 192 * 1024);
    assert.deepEqual(decoded.payload.tools, payload.tools);
    assert.deepEqual(decoded.payload.agentGroups, payload.agentGroups);
  });

  test("pre-agentId retry entry upgrades to reserved v2 identity", async () => {
    const { fetcher, captures } = makeFetcher();
    const legacy: V3MasterSinkWirePayload = {
      sessionId: "sess12345",
      turnIndex: 7,
      status: "completed",
      text: "legacy exact reply",
      thinkingText: "legacy exact thinking",
      tools: [],
    };
    await attemptSend(legacy, { config: CFG, fetcher });
    const decoded = decodeCapturedTape(captures);
    assert.equal(decoded.payload.agentId, LOSSLESS_TURN_TAPE_LEGACY_AGENT_ID);
    assert.equal(decoded.payload.text, legacy.text);
    assert.equal(decoded.payload.thinkingText, legacy.thinkingText);
    assert.ok(decoded.envelopes.every((envelope) => envelope.agentId === LOSSLESS_TURN_TAPE_LEGACY_AGENT_ID));
  });

  test("different agent ids retain distinct tape identities", async () => {
    const a = buildLosslessTurnTapeRequests({ ...PAYLOAD, agentId: "codex", createdAt: 1 });
    const b = buildLosslessTurnTapeRequests({ ...PAYLOAD, agentId: "main", createdAt: 1 });
    assert.notEqual(a.finalize.turnKey, b.finalize.turnKey);
    assert.notEqual(a.finalize.tapeId, b.finalize.tapeId);
  });

  for (const status of [200, 204]) {
    test(`${status} on every envelope resolves`, async () => {
      const { fetcher } = makeFetcher({ status });
      await assert.doesNotReject(() => attemptSend(PAYLOAD, { config: CFG, fetcher }));
    });
  }

  test("404 is session_missing", async () => {
    const { fetcher } = makeFetcher({ status: 404, body: "session missing" });
    await assert.rejects(
      () => attemptSend(PAYLOAD, { config: CFG, fetcher }),
      (error: unknown) => error instanceof V3SinkError
        && error.errorClass === "session_missing"
        && error.httpStatus === 404,
    );
  });

  test("410 is the sole fatal owner-deletion acknowledgement", async () => {
    const { fetcher } = makeFetcher({ status: 410, body: "session deleted" });
    await assert.rejects(
      () => attemptSend(PAYLOAD, { config: CFG, fetcher }),
      (error: unknown) => error instanceof V3SinkError
        && error.errorClass === "fatal"
        && error.httpStatus === 410,
    );
  });

  for (const status of [400, 401, 403, 409, 413, 429, 500, 502]) {
    test(`${status} remains transient so staged bytes are retried`, async () => {
      const { fetcher } = makeFetcher({ status, body: "repairable" });
      await assert.rejects(
        () => attemptSend(PAYLOAD, { config: CFG, fetcher }),
        (error: unknown) => error instanceof V3SinkError
          && error.errorClass === "transient"
          && error.httpStatus === status,
      );
    });
  }

  test("network failure remains transient", async () => {
    const { fetcher } = makeFetcher({ throwError: new Error("ECONNREFUSED") });
    await assert.rejects(
      () => attemptSend(PAYLOAD, { config: CFG, fetcher }),
      (error: unknown) => error instanceof V3SinkError && error.errorClass === "transient",
    );
  });

  test("the attempt deadline aborts the HTTP request and remains a durable transient", async () => {
    let signalAborted = false;
    const fetcher = (async (_url: string, init: any) => {
      await new Promise<never>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          signalAborted = true;
          reject(new DOMException("deadline", "AbortError"));
        }, { once: true });
      });
      throw new Error("unreachable");
    }) as unknown as typeof import("undici").request;
    await assert.rejects(
      () => attemptSend(PAYLOAD, { config: CFG, fetcher, timeoutMs: 5 }),
      (error: unknown) => error instanceof V3SinkError &&
        error.errorClass === "transient" &&
        /network error/i.test(error.message),
    );
    assert.equal(signalAborted, true);
  });

  test("finalize has no content-size deadline while parts keep the bounded signal", async () => {
    let finalizeInit: any;
    let releaseFinalize!: () => void;
    const finalizeBarrier = new Promise<void>((resolve) => { releaseFinalize = resolve; });
    const fetcher = (async (_url: string, init: any) => {
      const action = JSON.parse(init.body).action;
      if (action === "finalize") {
        finalizeInit = init;
        await finalizeBarrier;
      } else {
        assert.ok(init.signal instanceof AbortSignal, "part retains its bounded deadline signal");
        assert.equal(init.headersTimeout, undefined);
        assert.equal(init.bodyTimeout, undefined);
      }
      return {
        statusCode: 200,
        headers: {},
        trailers: {},
        opaque: undefined,
        context: {},
        body: {
          async *[Symbol.asyncIterator]() { yield Buffer.from('{"ok":true}', "utf8"); },
        } as any,
      };
    }) as unknown as typeof import("undici").request;

    const sending = attemptSend(PAYLOAD, { config: CFG, fetcher, timeoutMs: 5 });
    for (let i = 0; i < 100 && finalizeInit === undefined; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(finalizeInit, "finalize envelope reached the fetcher");
    assert.equal(finalizeInit.signal, undefined, "finalize must not inherit the part AbortSignal");
    assert.equal(finalizeInit.headersTimeout, 0);
    assert.equal(finalizeInit.bodyTimeout, 0);
    releaseFinalize();
    await sending;
  });
});

describe("makeV3MasterSink.persistOrQueue", () => {
  test("stages before send and ACK removes only after success", async () => {
    const queue = fakeQueue();
    let stagedAtAttempt = false;
    const sink = makeV3MasterSink({
      config: CFG,
      retryQueue: queue,
      attemptSendImpl: async () => { stagedAtAttempt = queue.enqueued.length === 1; },
    });
    const outcome = await sink.persistOrQueue(PAYLOAD);
    assert.deepEqual(outcome, { ok: true });
    assert.equal(stagedAtAttempt, true);
    assert.equal(queue.enqueued.length, 0);
  });

  for (const [name, error, expectedClass] of [
    ["transient", new V3SinkError("master 502", "transient", 502), "transient"],
    ["session_missing", new V3SinkError("session missing", "session_missing", 404), "session_missing"],
    ["non-410 contract error", new V3SinkError("master 400", "fatal", 400), "transient"],
  ] as const) {
    test(`${name} remains durably queued`, async () => {
      const queue = fakeQueue();
      const sink = makeV3MasterSink({
        config: CFG,
        retryQueue: queue,
        attemptSendImpl: async () => { throw error; },
      });
      const outcome = await sink.persistOrQueue(PAYLOAD);
      assert.equal(outcome.ok, false);
      if (outcome.ok || !outcome.queued) assert.fail("expected queued outcome");
      assert.equal(outcome.errorClass, expectedClass);
      assert.equal(queue.enqueued.length, 1);
      assert.equal(queue.enqueued[0].attempts, 0);
      assert.equal(typeof queue.enqueued[0].payload.createdAt, "number");
    });
  }

  test("explicit 410 owner deletion ACK removes the staged entry", async () => {
    const queue = fakeQueue();
    const sink = makeV3MasterSink({
      config: CFG,
      retryQueue: queue,
      attemptSendImpl: async () => { throw new V3SinkError("session deleted", "fatal", 410); },
    });
    const outcome = await sink.persistOrQueue(PAYLOAD);
    assert.equal(outcome.ok, false);
    if (outcome.ok || outcome.queued) assert.fail("expected explicit dropped outcome");
    assert.match(outcome.droppedReason, /deleted/);
    assert.equal(queue.enqueued.length, 0);
  });

  test("unknown throw is retained as transient", async () => {
    const queue = fakeQueue();
    const sink = makeV3MasterSink({
      config: CFG,
      retryQueue: queue,
      attemptSendImpl: async () => { throw new Error("unexpected"); },
    });
    const outcome = await sink.persistOrQueue(PAYLOAD);
    assert.equal(outcome.ok, false);
    if (outcome.ok || !outcome.queued) assert.fail("expected queued outcome");
    assert.equal(outcome.errorClass, "transient");
    assert.equal(queue.enqueued.length, 1);
  });
});

describe("M-R1-1 ① — onAck gates durable entry deletion", () => {
  const DISPATCH_PAYLOAD: V3MasterSinkPayload = {
    ...PAYLOAD,
    dispatchId: "d-sink-1",
    attemptNo: 1,
  };

  test("terminal CAS confirmed (onAck true) → entry deleted, ok", async () => {
    const queue = fakeQueue();
    let ackCalls = 0;
    const sink = makeV3MasterSink({
      config: CFG,
      retryQueue: queue,
      attemptSendImpl: async () => { /* master ACK ok */ },
      inboxHooks: { onAck: async () => { ackCalls++; return true; } },
    });
    const outcome = await sink.persistOrQueue(DISPATCH_PAYLOAD);
    assert.deepEqual(outcome, { ok: true });
    assert.equal(ackCalls, 1, "onAck fired once");
    assert.equal(queue.enqueued.length, 0, "terminal 确认 → entry 删除");
  });

  test("terminal CAS unconfirmed (onAck false) → entry retained + queued outcome + drainer kicked", async () => {
    const queue = fakeQueue();
    let ackCalls = 0;
    const sink = makeV3MasterSink({
      config: CFG,
      retryQueue: queue,
      attemptSendImpl: async () => { /* master ACK ok */ },
      inboxHooks: { onAck: async () => { ackCalls++; return false; } },
    });
    const outcome = await sink.persistOrQueue(DISPATCH_PAYLOAD);
    assert.equal(outcome.ok, false);
    if (outcome.ok || !outcome.queued) assert.fail("expected queued outcome");
    assert.equal(outcome.errorClass, "transient");
    assert.equal(ackCalls, 1);
    assert.equal(queue.enqueued.length, 1, "terminal 未确认 → entry 保留(下轮 drain 重试)");
    assert.equal(queue.kicks, 1, "kick drainer to retry terminal migration");
  });

  test("onAck throws → treated as unconfirmed → entry retained", async () => {
    const queue = fakeQueue();
    const sink = makeV3MasterSink({
      config: CFG,
      retryQueue: queue,
      attemptSendImpl: async () => { /* master ACK ok */ },
      inboxHooks: { onAck: async () => { throw new Error("inbox CAS write failed"); } },
    });
    const outcome = await sink.persistOrQueue(DISPATCH_PAYLOAD);
    assert.equal(outcome.ok, false);
    if (outcome.ok || !outcome.queued) assert.fail("expected queued outcome");
    assert.equal(queue.enqueued.length, 1, "onAck 抛 → 视为未确认 → entry 保留");
  });

  test("dispatch payload without onAck hook → still acked (no hook = nothing to converge)", async () => {
    const queue = fakeQueue();
    const sink = makeV3MasterSink({
      config: CFG,
      retryQueue: queue,
      attemptSendImpl: async () => { /* master ACK ok */ },
      // no inboxHooks
    });
    const outcome = await sink.persistOrQueue(DISPATCH_PAYLOAD);
    assert.deepEqual(outcome, { ok: true });
    assert.equal(queue.enqueued.length, 0);
  });
});

describe("V3MasterSink singleton", () => {
  test("set/get/clear", () => {
    setV3MasterSinkSingleton(null);
    assert.equal(getV3MasterSinkOrNull(), null);
    const sink = makeV3MasterSink({
      config: CFG,
      retryQueue: fakeQueue(),
      attemptSendImpl: async () => undefined,
    });
    setV3MasterSinkSingleton(sink);
    assert.equal(getV3MasterSinkOrNull(), sink);
    setV3MasterSinkSingleton(null);
    assert.equal(getV3MasterSinkOrNull(), null);
  });
});

describe("permission sidecar (detached ask_user)", () => {
  const CARD = {
    requestId: "ask-user:" + "ab".repeat(16),
    questions: [{ question: "Which editor?", options: [{ label: "Vim" }, { label: "Emacs" }] }],
    sessionKey: "agent:main:webchat:dm:sess12345",
    expiresAt: 1_720_086_400_000,
    ts: 1_720_000_000_000,
    channel: "webchat",
    peer: { id: "sess12345", kind: "dm" as const },
  };
  const SIDECAR: V3MasterSinkPayload = {
    sessionId: "sess12345",
    agentId: "main",
    turnIndex: 0,
    status: "completed",
    text: "",
    createdAt: CARD.ts,
    permissionCards: [CARD],
  };

  test("classifies permission-only payloads and not ordinary turns", () => {
    assert.equal(isPermissionSidecarPayload(SIDECAR), true);
    assert.equal(isPermissionSidecarPayload(PAYLOAD), false);
    assert.equal(isPermissionSidecarPayload({ ...SIDECAR, text: "also an answer" }), false);
  });

  test("POSTs a v1 JSON body (not a lossless tape) so master can append role:permission", async () => {
    const { fetcher, captures } = makeFetcher({ status: 200, body: '{"ok":true}' });
    await attemptSend(SIDECAR, { config: CFG, fetcher });
    assert.equal(captures.length, 1);
    assert.equal(captures[0]!.url, `${CFG.baseUrl}${SERVER_AUTHORED_PATH}`);
    const body = JSON.parse(captures[0]!.body) as Record<string, unknown>;
    assert.equal(body.action, undefined);
    assert.equal(body.text, "");
    assert.equal(body.agentId, "main");
    assert.ok(Array.isArray(body.permissionCards));
    assert.equal((body.permissionCards as typeof CARD[])[0]!.requestId, CARD.requestId);
    assert.deepEqual(body, buildPermissionSidecarV1Body(SIDECAR));
  });

  test("404 remains session_missing so persistOrQueue retries", async () => {
    const { fetcher } = makeFetcher({ status: 404, body: "session missing" });
    await assert.rejects(
      () => attemptSend(SIDECAR, { config: CFG, fetcher }),
      (error: unknown) => error instanceof V3SinkError
        && error.errorClass === "session_missing"
        && error.httpStatus === 404,
    );
  });

  test("persistOrQueue stages a permission sidecar and keeps it on first-attempt failure", async () => {
    const queue = fakeQueue();
    const sink = makeV3MasterSink({
      config: CFG,
      retryQueue: queue,
      attemptSendImpl: async () => { throw new V3SinkError("master 502", "transient", 502); },
    });
    const outcome = await sink.persistOrQueue(SIDECAR);
    assert.equal(outcome.ok, false);
    if (outcome.ok || !outcome.queued) assert.fail("expected queued outcome");
    assert.equal(queue.enqueued.length, 1);
    assert.equal(queue.enqueued[0].payload.permissionCards[0].requestId, CARD.requestId);
  });

  test("classifies a resolved-state sidecar (patches / user answers, no cards)", () => {
    const resolved: V3MasterSinkPayload = {
      sessionId: "sess12345",
      agentId: "main",
      turnIndex: 0,
      status: "completed",
      text: "",
      permissionPatches: [{
        requestId: CARD.requestId,
        behavior: "allow",
        settledReason: "remote",
      }],
      userAnswerMessages: [{ id: "ask-ans-sess12345abcdefghijkl", text: "用户已回答提问：" }],
    };
    assert.equal(isPermissionSidecarPayload(resolved), true);
    assert.equal(isPermissionSidecarPayload({ ...resolved, text: "turn text" }), false);
  });

  test("POSTs a v1 JSON body for a resolved-state sidecar", async () => {
    const resolved: V3MasterSinkPayload = {
      sessionId: "sess12345",
      agentId: "main",
      turnIndex: 0,
      status: "completed",
      text: "",
      permissionPatches: [{
        requestId: CARD.requestId,
        behavior: "deny",
        settledReason: "timeout",
      }],
    };
    const { fetcher, captures } = makeFetcher({ status: 200, body: '{"ok":true}' });
    await attemptSend(resolved, { config: CFG, fetcher });
    assert.equal(captures[0]!.method, "POST");
    const body = JSON.parse(captures[0]!.body) as Record<string, unknown>;
    assert.equal(body.action, undefined);
    assert.ok(Array.isArray(body.permissionPatches));
    assert.equal(body.permissionCards, undefined);
  });
});

describe("fetchAskUserPermissionCard (GET hydrate)", () => {
  test("GETs the existing server-authored path with sessionId+requestId", async () => {
    const requestId = "ask-user:" + "ab".repeat(16);
    const message = {
      id: requestId,
      role: "permission",
      _detachedAskUser: true,
      _askUserExpiresAt: Date.now() + 24 * 60 * 60_000,
      _askUserSessionKey: "agent:main:webchat:dm:sess12345",
    };
    const { fetcher, captures } = makeFetcher({
      status: 200,
      body: JSON.stringify({ ok: true, message }),
    });
    const got = await fetchAskUserPermissionCard({
      sessionId: "sess12345",
      requestId,
      config: CFG,
      fetcher,
    });
    assert.equal(captures.length, 1);
    assert.equal(captures[0]!.method, "GET");
    assert.equal(captures[0]!.body, "");
    assert.match(captures[0]!.url, /sessionId=sess12345/);
    assert.match(captures[0]!.url, /requestId=ask-user/);
    assert.equal(got?.id, requestId);
    assert.equal(got?._detachedAskUser, true);
  });

  test("404/410 hydrate misses return null rather than throwing", async () => {
    const requestId = "ask-user:" + "ab".repeat(16);
    const miss = await fetchAskUserPermissionCard({
      sessionId: "sess12345",
      requestId,
      config: CFG,
      fetcher: makeFetcher({ status: 404, body: '{"error":{"code":"PERMISSION_NOT_FOUND"}}' }).fetcher,
    });
    assert.equal(miss, null);
    const gone = await fetchAskUserPermissionCard({
      sessionId: "sess12345",
      requestId,
      config: CFG,
      fetcher: makeFetcher({ status: 410, body: '{"error":{"code":"SESSION_DELETED"}}' }).fetcher,
    });
    assert.equal(gone, null);
  });
});
