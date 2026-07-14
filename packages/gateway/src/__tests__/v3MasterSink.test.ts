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
  SERVER_AUTHORED_PATH,
  attemptSend,
  buildLosslessTurnTapeRequests,
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

type Capture = { url: string; body: string; headers: Record<string, string> };

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
  const parts = envelopes.filter((envelope) => envelope.action === "part");
  const finalizes = envelopes.filter((envelope) => envelope.action === "finalize");
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
    assert.ok(tape.parts.length > 4);
    const reconstructed = Buffer.concat(tape.parts.map((part) => {
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
    assert.deepEqual(first.parts, second.parts);
    assert.deepEqual(first.finalize, second.finalize);
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
  test("uploads every part then finalize with no semantic cap", async () => {
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
