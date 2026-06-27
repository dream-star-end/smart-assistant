/**
 * V3 commercial container → master sink unit tests.
 *
 * Covers:
 *   - readV3MasterSinkConfig env handling (both set / one missing /
 *     trailing slash normalisation)
 *   - attemptSend HTTP status classification (200 / 404 / 5xx / 4xx /
 *     401-403 / network err / timeout / payload-too-large)
 *   - persistOrQueue orchestration (success → ok / transient → queued /
 *     session_missing → queued / fatal → dropped / unexpected throw →
 *     queued-as-transient)
 *   - module singleton getter (set / clear)
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/v3MasterSink.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  attemptSend,
  getV3MasterSinkOrNull,
  makeV3MasterSink,
  readV3MasterSinkConfig,
  setV3MasterSinkSingleton,
  V3SinkError,
  type V3MasterSinkPayload,
} from "../v3MasterSink.js";
import type { V3MasterRetryQueue } from "../v3MasterRetryQueue.js";

// ─── tiny test fixtures ─────────────────────────────────────────────────

const PAYLOAD: V3MasterSinkPayload = {
  sessionId: "sess12345",
  agentId: "main",
  turnIndex: 1,
  status: "completed",
  text: "hello world",
};

const CFG = { baseUrl: "http://master.test:18791", bearer: "oc-v3.7." + "a".repeat(64) };

function makeFakeFetcher(opts: {
  status?: number;
  body?: string;
  throwError?: Error;
}): typeof import("undici").request {
  const fn = async () => {
    if (opts.throwError) throw opts.throwError;
    const text = opts.body ?? "";
    const buf = Buffer.from(text, "utf8");
    return {
      statusCode: opts.status ?? 200,
      headers: {},
      trailers: {},
      opaque: undefined,
      context: {},
      body: {
        async *[Symbol.asyncIterator]() {
          yield buf;
        },
        // Methods undici body has but our handler doesn't use — stubbed
        // so structural typing passes if anything peeks.
        text: async () => text,
      } as any,
    };
  };
  return fn as unknown as typeof import("undici").request;
}

function fakeQueue(): V3MasterRetryQueue & { enqueued: any[] } {
  const enqueued: any[] = [];
  return {
    enqueued,
    async enqueueDurable(entry) { enqueued.push(entry); },
    async drainOnce() { return { considered: 0, drained: 0, retried: 0, ttlDropped: 0, fatalDropped: 0, errors: 0, pending: 0 }; },
    kick() {},
    startPeriodic() {},
    stopPeriodic() {},
    async pendingCount() { return enqueued.length; },
  };
}

// ─── readV3MasterSinkConfig ──────────────────────────────────────────────

describe("readV3MasterSinkConfig", () => {
  test("returns null when both env missing", () => {
    assert.equal(readV3MasterSinkConfig({}), null);
  });

  test("returns null when only one env present", () => {
    assert.equal(readV3MasterSinkConfig({ OPENCLAUDE_V3_MASTER_BASE_URL: "http://x" }), null);
    assert.equal(readV3MasterSinkConfig({ OPENCLAUDE_V3_CONTAINER_TOKEN: "tok" }), null);
  });

  test("returns config and strips trailing slashes", () => {
    const cfg = readV3MasterSinkConfig({
      OPENCLAUDE_V3_MASTER_BASE_URL: "http://m.test:18791///",
      OPENCLAUDE_V3_CONTAINER_TOKEN: "tok",
    });
    assert.deepEqual(cfg, { baseUrl: "http://m.test:18791", bearer: "tok" });
  });
});

// ─── attemptSend classification ──────────────────────────────────────────

describe("attemptSend — status classification", () => {
  test("200 → resolves void", async () => {
    await assert.doesNotReject(() =>
      attemptSend(PAYLOAD, { config: CFG, fetcher: makeFakeFetcher({ status: 200, body: '{"ok":true}' }) }),
    );
  });

  test("204 → resolves void", async () => {
    await assert.doesNotReject(() =>
      attemptSend(PAYLOAD, { config: CFG, fetcher: makeFakeFetcher({ status: 204 }) }),
    );
  });

  test("404 → V3SinkError(session_missing)", async () => {
    await assert.rejects(
      () => attemptSend(PAYLOAD, { config: CFG, fetcher: makeFakeFetcher({ status: 404, body: '{"error":"session_not_found"}' }) }),
      (err: unknown) => {
        assert.ok(err instanceof V3SinkError);
        assert.equal((err as V3SinkError).errorClass, "session_missing");
        assert.equal((err as V3SinkError).httpStatus, 404);
        return true;
      },
    );
  });

  test("410 → V3SinkError(fatal)  // soft-deleted master row is terminal — retry won't resurrect it", async () => {
    // Why fatal not session_missing: 404 is a recoverable race (frontend's
    // debounced PUT may still land), but 410 is a stable tombstone — the
    // master row exists with deleted_at != NULL. Classifying as fatal stops
    // the 24h durable retry storm that was the original c:66 root cause.
    await assert.rejects(
      () => attemptSend(PAYLOAD, { config: CFG, fetcher: makeFakeFetcher({ status: 410, body: '{"error":"session_deleted"}' }) }),
      (err: unknown) => {
        assert.ok(err instanceof V3SinkError);
        assert.equal((err as V3SinkError).errorClass, "fatal");
        assert.equal((err as V3SinkError).httpStatus, 410);
        return true;
      },
    );
  });

  test("500 → V3SinkError(transient)", async () => {
    await assert.rejects(
      () => attemptSend(PAYLOAD, { config: CFG, fetcher: makeFakeFetcher({ status: 500, body: "boom" }) }),
      (err: unknown) => {
        assert.ok(err instanceof V3SinkError);
        assert.equal((err as V3SinkError).errorClass, "transient");
        assert.equal((err as V3SinkError).httpStatus, 500);
        return true;
      },
    );
  });

  test("502 → V3SinkError(transient)", async () => {
    await assert.rejects(
      () => attemptSend(PAYLOAD, { config: CFG, fetcher: makeFakeFetcher({ status: 502 }) }),
      (err: unknown) => err instanceof V3SinkError && (err as V3SinkError).errorClass === "transient",
    );
  });

  test("401 → V3SinkError(transient)  // auth misconfig is recoverable", async () => {
    await assert.rejects(
      () => attemptSend(PAYLOAD, { config: CFG, fetcher: makeFakeFetcher({ status: 401 }) }),
      (err: unknown) => err instanceof V3SinkError && (err as V3SinkError).errorClass === "transient",
    );
  });

  test("403 → V3SinkError(transient)", async () => {
    await assert.rejects(
      () => attemptSend(PAYLOAD, { config: CFG, fetcher: makeFakeFetcher({ status: 403 }) }),
      (err: unknown) => err instanceof V3SinkError && (err as V3SinkError).errorClass === "transient",
    );
  });

  test("400 → V3SinkError(fatal)  // schema rejection — retry won't help", async () => {
    await assert.rejects(
      () => attemptSend(PAYLOAD, { config: CFG, fetcher: makeFakeFetcher({ status: 400 }) }),
      (err: unknown) => err instanceof V3SinkError && (err as V3SinkError).errorClass === "fatal",
    );
  });

  test("405 → V3SinkError(fatal)", async () => {
    await assert.rejects(
      () => attemptSend(PAYLOAD, { config: CFG, fetcher: makeFakeFetcher({ status: 405 }) }),
      (err: unknown) => err instanceof V3SinkError && (err as V3SinkError).errorClass === "fatal",
    );
  });

  test("413 → V3SinkError(fatal)", async () => {
    await assert.rejects(
      () => attemptSend(PAYLOAD, { config: CFG, fetcher: makeFakeFetcher({ status: 413 }) }),
      (err: unknown) => err instanceof V3SinkError && (err as V3SinkError).errorClass === "fatal",
    );
  });

  test("network error throw → V3SinkError(transient)", async () => {
    await assert.rejects(
      () => attemptSend(PAYLOAD, { config: CFG, fetcher: makeFakeFetcher({ throwError: new Error("ECONNREFUSED") }) }),
      (err: unknown) => err instanceof V3SinkError && (err as V3SinkError).errorClass === "transient",
    );
  });

  test("client-side oversized payload → V3SinkError(fatal)", async () => {
    const huge: V3MasterSinkPayload = { ...PAYLOAD, text: "x".repeat(300 * 1024) };
    await assert.rejects(
      () => attemptSend(huge, { config: CFG, fetcher: makeFakeFetcher({ status: 200 }) }),
      (err: unknown) => err instanceof V3SinkError && (err as V3SinkError).errorClass === "fatal",
    );
  });
});

// ─── body cap shrink (Phase 0.4 thinking durability) ────────────────────
describe("attemptSend — body cap shrink", () => {
  // Capture the actual JSON body that fetcher saw, so we can assert the
  // shrink branch fired.
  function makeCapturingFetcher(): {
    fetcher: typeof import("undici").request;
    captures: Array<{ url: string; body: string }>;
  } {
    const captures: Array<{ url: string; body: string }> = [];
    const fn = async (url: string, init: any) => {
      captures.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      return {
        statusCode: 200,
        headers: {},
        trailers: {},
        opaque: undefined,
        context: {},
        body: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from('{"ok":true}', "utf8");
          },
          text: async () => '{"ok":true}',
        } as any,
      };
    };
    return { fetcher: fn as unknown as typeof import("undici").request, captures };
  }

  test("combined-over-cap drops thinkingText and preserves assistant (request body excludes thinkingText)", async () => {
    const { fetcher, captures } = makeCapturingFetcher();
    // Assistant alone fits (< 256 KB), but assistant + thinking exceeds cap.
    const oversizedThinking: V3MasterSinkPayload = {
      ...PAYLOAD,
      text: "x".repeat(200 * 1024), // 200 KB assistant alone (under cap)
      thinkingText: "y".repeat(80 * 1024), // pushes combined over 256 KB
    };
    await attemptSend(oversizedThinking, { config: CFG, fetcher });
    assert.equal(captures.length, 1);
    const sent = JSON.parse(captures[0].body) as Record<string, unknown>;
    assert.equal(sent.text, "x".repeat(200 * 1024));
    assert.equal(
      sent.thinkingText,
      undefined,
      "thinkingText should be stripped when combined exceeds body cap",
    );
  });

  test("combined-over-cap with assistant alone still over cap → fatal", async () => {
    const { fetcher } = makeCapturingFetcher();
    const giant: V3MasterSinkPayload = {
      ...PAYLOAD,
      text: "x".repeat(280 * 1024), // assistant alone over 256 KB
      thinkingText: "y".repeat(8 * 1024),
    };
    await assert.rejects(
      () => attemptSend(giant, { config: CFG, fetcher }),
      (err: unknown) => err instanceof V3SinkError && (err as V3SinkError).errorClass === "fatal",
    );
  });

  test("thinking-only over cap → fatal (parser cap leaked)", async () => {
    const { fetcher } = makeCapturingFetcher();
    // Empty assistant, thinking-only, over cap. Parser is supposed to cap
    // thinking at 8 KB so this branch should never fire in production —
    // but if it does we must NOT silently drop the only piece of data.
    const thinkingOnly: V3MasterSinkPayload = {
      ...PAYLOAD,
      text: "",
      thinkingText: "z".repeat(300 * 1024),
    };
    await assert.rejects(
      () => attemptSend(thinkingOnly, { config: CFG, fetcher }),
      (err: unknown) =>
        err instanceof V3SinkError &&
        (err as V3SinkError).errorClass === "fatal" &&
        err.message.includes("thinking-only"),
    );
  });

  test("under-cap body with thinkingText is forwarded as-is", async () => {
    const { fetcher, captures } = makeCapturingFetcher();
    const small: V3MasterSinkPayload = {
      ...PAYLOAD,
      text: "answer",
      thinkingText: "reasoning",
    };
    await attemptSend(small, { config: CFG, fetcher });
    assert.equal(captures.length, 1);
    const sent = JSON.parse(captures[0].body) as Record<string, unknown>;
    assert.equal(sent.text, "answer");
    assert.equal(sent.thinkingText, "reasoning");
  });

  test("payload without thinkingText omits the key entirely (not null/empty)", async () => {
    const { fetcher, captures } = makeCapturingFetcher();
    await attemptSend(PAYLOAD, { config: CFG, fetcher }); // no thinkingText set
    const sent = JSON.parse(captures[0].body) as Record<string, unknown>;
    assert.equal("thinkingText" in sent, false);
  });

  // ── Phase 1: tools[] drop precedes thinkingText drop ────────────────────
  // Why: tools[] is durable redundancy of the live-streamed tool rows the
  // client already has. Dropping it degrades refresh-recovery only. thinkingText
  // is auxiliary debug content that has no other persistence — drop it last,
  // before going fatal. Tests pin this priority order so a future cap refactor
  // can't silently invert it.

  function bigTool(blockId: string, payloadKb: number): import("../ccbMessageParser.js").TurnToolEntry {
    return {
      toolUseId: blockId,
      blockId,
      toolName: "Bash",
      inputJson: { cmd: "x".repeat(payloadKb * 1024) },
      inputPreview: "preview",
      output: "y".repeat(payloadKb * 1024),
      isError: false,
      durationMs: 1,
      ts: 1_000_000,
      arrivedAt: 1_000_000,
    };
  }

  test("oversized tools[] alone → drops tools[] only, thinkingText preserved", async () => {
    const { fetcher, captures } = makeCapturingFetcher();
    const payload: V3MasterSinkPayload = {
      ...PAYLOAD,
      text: "small assistant",
      thinkingText: "small reasoning",
      // Two big tools — together ~280 KB — push body over 256 KB cap.
      tools: [bigTool("blk-A", 70), bigTool("blk-B", 70)],
    };
    await attemptSend(payload, { config: CFG, fetcher });
    assert.equal(captures.length, 1);
    const sent = JSON.parse(captures[0].body) as Record<string, unknown>;
    assert.equal("tools" in sent, false, "tools[] dropped to fit cap");
    assert.equal(sent.thinkingText, "small reasoning", "thinking preserved");
    assert.equal(sent.text, "small assistant", "assistant preserved");
  });

  test("agentSessionId 透传进 POST body(供 master 按 session 精确排空 pending cost)", async () => {
    const { fetcher, captures } = makeCapturingFetcher();
    const payload: V3MasterSinkPayload = {
      ...PAYLOAD,
      text: "answer",
      agentSessionId: "113cb35c-c1d0-41ff-9cda-a6f370b622e0",
    };
    await attemptSend(payload, { config: CFG, fetcher });
    assert.equal(captures.length, 1);
    const sent = JSON.parse(captures[0].body) as Record<string, unknown>;
    assert.equal(sent.agentSessionId, "113cb35c-c1d0-41ff-9cda-a6f370b622e0");
  });

  test("无 agentSessionId 时 body 不带该键(老路径/缺省安全)", async () => {
    const { fetcher, captures } = makeCapturingFetcher();
    await attemptSend({ ...PAYLOAD, text: "answer" }, { config: CFG, fetcher });
    const sent = JSON.parse(captures[0].body) as Record<string, unknown>;
    assert.equal("agentSessionId" in sent, false);
  });

  test("tools[] + thinking together exceed cap → tools[] dropped first; if still over, thinkingText dropped second", async () => {
    const { fetcher, captures } = makeCapturingFetcher();
    const payload: V3MasterSinkPayload = {
      ...PAYLOAD,
      // 200 KB assistant alone (under cap)
      text: "x".repeat(200 * 1024),
      // 50 KB thinking + 50 KB tools combined push to ~300 KB.
      thinkingText: "y".repeat(50 * 1024),
      tools: [bigTool("blk-A", 50)],
    };
    await attemptSend(payload, { config: CFG, fetcher });
    const sent = JSON.parse(captures[0].body) as Record<string, unknown>;
    // Step 1: tools dropped → body ≈ 250 KB. Step 2 not needed (< cap).
    assert.equal("tools" in sent, false, "tools dropped (step 1)");
    assert.equal(sent.thinkingText, "y".repeat(50 * 1024), "thinking still present");
  });

  test("tools[] + thinking + assistant all together still over cap → drops tools, then thinking, sends assistant", async () => {
    const { fetcher, captures } = makeCapturingFetcher();
    const payload: V3MasterSinkPayload = {
      ...PAYLOAD,
      // 200 KB assistant
      text: "x".repeat(200 * 1024),
      // 80 KB thinking → assistant + thinking alone ~280 KB > cap
      thinkingText: "y".repeat(80 * 1024),
      tools: [bigTool("blk-A", 50)], // adds another 50 KB
    };
    await attemptSend(payload, { config: CFG, fetcher });
    const sent = JSON.parse(captures[0].body) as Record<string, unknown>;
    // Step 1: tools dropped (~330 → ~280, still > cap).
    // Step 2: thinking dropped (~280 → ~200, < cap).
    assert.equal("tools" in sent, false);
    assert.equal("thinkingText" in sent, false);
    assert.equal((sent.text as string).length, 200 * 1024, "assistant preserved");
  });

  test("under-cap with tools[] is forwarded as-is", async () => {
    const { fetcher, captures } = makeCapturingFetcher();
    const payload: V3MasterSinkPayload = {
      ...PAYLOAD,
      text: "answer",
      thinkingText: "reasoning",
      tools: [bigTool("blk-A", 1)], // tiny
    };
    await attemptSend(payload, { config: CFG, fetcher });
    const sent = JSON.parse(captures[0].body) as Record<string, unknown>;
    const tools = sent.tools as Array<Record<string, unknown>>;
    assert.equal(Array.isArray(tools), true);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].blockId, "blk-A");
  });

  test("payload without tools[] omits the key entirely (not [] / null)", async () => {
    const { fetcher, captures } = makeCapturingFetcher();
    await attemptSend(PAYLOAD, { config: CFG, fetcher }); // no tools set
    const sent = JSON.parse(captures[0].body) as Record<string, unknown>;
    assert.equal("tools" in sent, false);
  });

  test("empty tools[] array is also omitted (treated as no tools)", async () => {
    const { fetcher, captures } = makeCapturingFetcher();
    const payload: V3MasterSinkPayload = { ...PAYLOAD, tools: [] };
    await attemptSend(payload, { config: CFG, fetcher });
    const sent = JSON.parse(captures[0].body) as Record<string, unknown>;
    assert.equal("tools" in sent, false, "spread guard skips empty array");
  });

  // Count cap (must precede byte cap): master rejects > 50 tools with 400
  // INVALID_BODY which classifier marks as fatal — that would also drop
  // assistant text. Sink-side count cap drops the durable tool snapshot
  // so the primary assistant write still goes through.
  function tinyTool(blockId: string): import("../ccbMessageParser.js").TurnToolEntry {
    return {
      toolUseId: blockId,
      blockId,
      toolName: "Bash",
      inputJson: { cmd: "ls" },
      inputPreview: "ls",
      output: "ok",
      isError: false,
      durationMs: 1,
      ts: 1_000_000,
      arrivedAt: 1_000_000,
    };
  }

  test("51 tiny tools (under byte cap, over master count cap) → drops tools[], assistant preserved", async () => {
    const { fetcher, captures } = makeCapturingFetcher();
    const tools = Array.from({ length: 51 }, (_, i) => tinyTool(`blk-${i}`));
    const payload: V3MasterSinkPayload = {
      ...PAYLOAD,
      text: "answer",
      thinkingText: "reasoning",
      tools,
    };
    await attemptSend(payload, { config: CFG, fetcher });
    assert.equal(captures.length, 1, "POST proceeds (no fatal throw)");
    const sent = JSON.parse(captures[0].body) as Record<string, unknown>;
    assert.equal("tools" in sent, false, "tools[] dropped by count cap");
    assert.equal(sent.thinkingText, "reasoning", "thinking preserved");
    assert.equal(sent.text, "answer", "assistant preserved");
  });

  test("exactly 50 tools (at master count cap) → tools[] forwarded as-is", async () => {
    const { fetcher, captures } = makeCapturingFetcher();
    const tools = Array.from({ length: 50 }, (_, i) => tinyTool(`blk-${i}`));
    const payload: V3MasterSinkPayload = { ...PAYLOAD, text: "ok", tools };
    await attemptSend(payload, { config: CFG, fetcher });
    const sent = JSON.parse(captures[0].body) as Record<string, unknown>;
    assert.equal(Array.isArray(sent.tools), true, "tools[] preserved at boundary");
    assert.equal((sent.tools as unknown[]).length, 50);
  });
});

// ─── agentId wire field (2026-05-13 mid-chat-model-switch fix) ──────────
//
// agentId is what disambiguates two AgentSessions that share a peerId
// (chat-level identity) but each track session.turns from 0 — without it,
// turn 1 of codex and turn 1 of main both stamp `srv-${peerId}-t1` and
// master would UPSERT them into a single row, merging the two answers
// the user actually saw as separate bubbles. Master folds agentId into
// the persisted messageId; these tests pin that gateway puts it on the
// wire in the right shape so master can do its part.
describe("attemptSend — agentId wire shape", () => {
  function makeCapturingFetcher(): {
    fetcher: typeof import("undici").request;
    captures: Array<{ url: string; body: string }>;
  } {
    const captures: Array<{ url: string; body: string }> = [];
    const fn = async (url: string, init: any) => {
      captures.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      return {
        statusCode: 200,
        headers: {},
        trailers: {},
        opaque: undefined,
        context: {},
        body: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from('{"ok":true}', "utf8");
          },
          text: async () => '{"ok":true}',
        } as any,
      };
    };
    return { fetcher: fn as unknown as typeof import("undici").request, captures };
  }

  test("agentId from V3MasterSinkPayload is forwarded verbatim on the wire", async () => {
    const { fetcher, captures } = makeCapturingFetcher();
    await attemptSend(
      { ...PAYLOAD, agentId: "codex" },
      { config: CFG, fetcher },
    );
    const sent = JSON.parse(captures[0].body) as Record<string, unknown>;
    assert.equal(sent.agentId, "codex");
  });

  test("two payloads with same sessionId/turnIndex but different agentId both serialize their own id (no merge)", async () => {
    // Regression: prior to 2026-05-13 these two POSTs would have arrived
    // with byte-identical bodies (agentId field didn't exist), causing
    // master to UPSERT both into `srv-${sessionId}-t1`. The gateway-side
    // contribution to the fix is just making sure the bodies actually
    // differ — master's idPart fold handles the messageId derivation.
    const { fetcher, captures } = makeCapturingFetcher();
    await attemptSend(
      { ...PAYLOAD, agentId: "codex", text: "codex answer" },
      { config: CFG, fetcher },
    );
    await attemptSend(
      { ...PAYLOAD, agentId: "main", text: "main answer" },
      { config: CFG, fetcher },
    );
    assert.equal(captures.length, 2);
    const a = JSON.parse(captures[0].body) as Record<string, unknown>;
    const b = JSON.parse(captures[1].body) as Record<string, unknown>;
    assert.equal(a.agentId, "codex");
    assert.equal(b.agentId, "main");
    assert.equal(a.sessionId, b.sessionId, "same chat-level identity");
    assert.equal(a.turnIndex, b.turnIndex, "same turn index pre-disambig");
    assert.notEqual(a.agentId, b.agentId, "disambiguation key differs");
  });

  test("legacy wire payload without agentId omits the key entirely (drainer back-compat)", async () => {
    // The retry queue may hold pre-Fix-A entries (written before 2026-05-13
    // by a now-replaced container image). Those entries have no agentId
    // on disk. The drainer calls attemptSend with that legacy shape; we
    // must not synthesize an agentId, and must not include the key as
    // null/empty — master's schema accepts the optional but enforces
    // charset when present, so a null would 400 fatal-drop the entry.
    const { fetcher, captures } = makeCapturingFetcher();
    const legacy: import("../v3MasterSink.js").V3MasterSinkWirePayload = {
      sessionId: "sess12345",
      turnIndex: 1,
      status: "completed",
      text: "legacy",
    };
    await attemptSend(legacy, { config: CFG, fetcher });
    const sent = JSON.parse(captures[0].body) as Record<string, unknown>;
    assert.equal("agentId" in sent, false, "agentId omitted, not nulled");
  });
});

// ─── persistOrQueue orchestration ────────────────────────────────────────

describe("makeV3MasterSink.persistOrQueue", () => {
  test("ok on success — does NOT enqueue", async () => {
    const queue = fakeQueue();
    const sink = makeV3MasterSink({
      config: CFG,
      retryQueue: queue,
      attemptSendImpl: async () => undefined,
    });
    const out = await sink.persistOrQueue(PAYLOAD);
    assert.equal(out.ok, true);
    assert.equal(queue.enqueued.length, 0);
  });

  test("queued on transient — enqueues with attempts=1 and stamps lastErrorClass", async () => {
    const queue = fakeQueue();
    const sink = makeV3MasterSink({
      config: CFG,
      retryQueue: queue,
      attemptSendImpl: async () => {
        throw new V3SinkError("master 502", "transient", 502);
      },
    });
    const out = await sink.persistOrQueue(PAYLOAD);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.queued, true);
    if (!out.queued) return;
    assert.equal(out.errorClass, "transient");
    assert.equal(queue.enqueued.length, 1);
    const entry = queue.enqueued[0];
    assert.equal(entry.attempts, 1);
    assert.equal(entry.lastErrorClass, "transient");
    assert.equal(typeof entry.firstSeenAt, "number");
    assert.equal(entry.payload.sessionId, PAYLOAD.sessionId);
    // createdAt must be auto-stamped when caller didn't supply one
    assert.equal(typeof entry.payload.createdAt, "number");
  });

  test("queued on session_missing", async () => {
    const queue = fakeQueue();
    const sink = makeV3MasterSink({
      config: CFG,
      retryQueue: queue,
      attemptSendImpl: async () => {
        throw new V3SinkError("session_not_found", "session_missing", 404);
      },
    });
    const out = await sink.persistOrQueue(PAYLOAD);
    assert.equal(out.ok, false);
    if (out.ok) return;
    if (!out.queued) {
      assert.fail("expected queued");
      return;
    }
    assert.equal(out.errorClass, "session_missing");
    assert.equal(queue.enqueued[0].lastErrorClass, "session_missing");
  });

  test("dropped on fatal — does NOT enqueue", async () => {
    const queue = fakeQueue();
    const sink = makeV3MasterSink({
      config: CFG,
      retryQueue: queue,
      attemptSendImpl: async () => {
        throw new V3SinkError("master rejected 400", "fatal", 400);
      },
    });
    const out = await sink.persistOrQueue(PAYLOAD);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.queued, false);
    if (out.queued) return;
    assert.match(out.droppedReason, /400/);
    assert.equal(queue.enqueued.length, 0);
  });

  test("dropped on 410 session_deleted (fatal) — does NOT enqueue", async () => {
    // Pinning the end-to-end behavior at persistOrQueue: a 410 from master
    // must short-circuit to drop, not queue. Otherwise replay loops would
    // hammer the same tombstoned row for 24h (ENTRY_TTL_MS), exactly the
    // pathology Plan A is designed to remove.
    const queue = fakeQueue();
    const sink = makeV3MasterSink({
      config: CFG,
      retryQueue: queue,
      attemptSendImpl: async () => {
        throw new V3SinkError("master 410 session_deleted", "fatal", 410);
      },
    });
    const out = await sink.persistOrQueue(PAYLOAD);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.equal(out.queued, false);
    if (out.queued) return;
    assert.match(out.droppedReason, /410|session_deleted/);
    assert.equal(queue.enqueued.length, 0, "tombstoned row must not enqueue — terminal");
  });

  test("unexpected (non-V3SinkError) throw → defensively queued as transient", async () => {
    const queue = fakeQueue();
    const sink = makeV3MasterSink({
      config: CFG,
      retryQueue: queue,
      attemptSendImpl: async () => {
        throw new Error("totally unexpected");
      },
    });
    const out = await sink.persistOrQueue(PAYLOAD);
    assert.equal(out.ok, false);
    if (out.ok) return;
    if (!out.queued) {
      assert.fail("expected queued");
      return;
    }
    assert.equal(out.errorClass, "transient");
    assert.equal(queue.enqueued.length, 1);
  });
});

// ─── singleton getter ────────────────────────────────────────────────────

describe("V3MasterSink module singleton", () => {
  test("getter returns null by default and after clear", () => {
    setV3MasterSinkSingleton(null);
    assert.equal(getV3MasterSinkOrNull(), null);
  });

  test("getter returns set sink", () => {
    const queue = fakeQueue();
    const sink = makeV3MasterSink({
      config: CFG,
      retryQueue: queue,
      attemptSendImpl: async () => undefined,
    });
    setV3MasterSinkSingleton(sink);
    assert.equal(getV3MasterSinkOrNull(), sink);
    setV3MasterSinkSingleton(null);
    assert.equal(getV3MasterSinkOrNull(), null);
  });
});
