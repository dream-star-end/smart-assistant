import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runUpstreamRoundTrip } from "./core.js";
import { BoxCliToolHandoffError } from "./boxCliToolHandoff.js";
import { rememberBoxRefusal, recentBoxRefusal, _resetBoxRefusalMemoryForTest } from "./boxRefusalMemory.js";

function fixture() {
  const req = Object.assign(new EventEmitter(), { headers: {}, complete: true, aborted: false });
  const writes: string[] = [];
  const res = Object.assign(new EventEmitter(), {
    headersSent: false, writableEnded: false, statusCode: 200,
    setHeader: () => {},
    writeHead: () => { res.headersSent = true; },
    write: (bytes: Uint8Array | string) => { writes.push(Buffer.from(bytes).toString()); return true; },
    end: () => { res.writableEnded = true; res.emit("close"); },
  });
  const events: Array<{ message: string; fields: unknown }> = [];
  const log = (message: string, fields?: unknown) => { events.push({ message, fields }); };
  const failures: string[] = [];
  let commits = 0;
  const outcome = { state: "aborted", attributionCredits: null, debitedCredits: null,
    finalCredits: 0n, balanceAfter: null };
  const ctx = {
    pgPool: { query: async () => ({ rows: [] }) }, req, res,
    requestId: "core-failure", uid: 4n,
    body: { model: "box-api-claude-opus-5-5", max_tokens: 128, stream: true,
      messages: [{ role: "user", content: "synthetic" }] },
    session: { accountId: null, slotId: null, pinnedUserId: null, personaTimezone: null,
      endpoint: "http://example.invalid", upstreamModel: "claude-opus-5-5",
      dispatcher: undefined, shouldUpdateQuotaFromResponse: false,
      applyUpstreamAuth: () => {}, sanitizeMessages: (messages: unknown[]) => messages,
      zeroizeSecrets: () => {} },
    quotaProbeProviderId: null, sessionId: "synthetic-session",
    parentSessionId: null, delegateAgentId: null,
    userLog: { info: log, warn: log, error: log },
    finalize: {
      fail: async (_observed: unknown, _error: unknown, code: string) => { failures.push(code); return outcome; },
      failClient: async (_observed: unknown, _error: unknown, code: string) => { failures.push(code); return outcome; },
      commit: async () => { commits++; return outcome; },
    },
  };
  return { ctx, req, res, writes, events, failures, commits: () => commits };
}

test("mid-stream Box refusal survives the resolved pipe error after headers were sent", async () => {
  _resetBoxRefusalMemoryForTest();
  const f = fixture();
  const key = { uid: 4n, sessionId: "synthetic-session", turnKey: "a".repeat(64),
    model: f.ctx.body.model };
  let launches = 0;
  let reads = 0;
  const error = new BoxCliToolHandoffError("BOX_CLI_UPSTREAM_RATE_LIMITED");
  await runUpstreamRoundTrip({ ...f.ctx,
    onBoxRefusal: (code: string) => {
      assert.equal(f.res.headersSent, true);
      rememberBoxRefusal(key, code);
    },
    fetchFn: (async (_url: unknown, init: RequestInit) => {
      launches++;
      f.req.emit("close");
      assert.equal(init.signal?.aborted, false, "normal completed request must not cancel the model");
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (reads++ === 0) controller.enqueue(Buffer.from("event: ping\ndata: {}\n\n"));
          else controller.error(error);
        },
      }));
    }) as typeof fetch,
  } as never);
  assert.equal(launches, 1);
  assert.equal(recentBoxRefusal(key), "BOX_CLI_UPSTREAM_RATE_LIMITED");
  assert.ok(f.writes.some((s) => s.includes("event: ping")));
  assert.deepEqual(f.failures, ["STREAM_FAILED"]);
  assert.equal(f.commits(), 0);
  assert.equal(f.events.filter((e) => e.message === "proxy_transport_cancelled").length, 0,
    "res.end close is completion, not a user cancellation");
});

test("actual request abort is recorded once and retains client-abort settlement", async () => {
  const f = fixture();
  await runUpstreamRoundTrip({ ...f.ctx,
    fetchFn: (async (_url: unknown, init: RequestInit) => {
      f.req.complete = false;
      f.req.aborted = true;
      f.req.emit("aborted");
      f.req.emit("close");
      assert.equal(init.signal?.aborted, true);
      throw Object.assign(new Error("synthetic transport abort"), { name: "AbortError" });
    }) as typeof fetch,
  } as never);
  assert.deepEqual(f.failures, ["CLIENT_ABORT"]);
  const cancelled = f.events.filter((e) => e.message === "proxy_transport_cancelled");
  assert.equal(cancelled.length, 1);
  assert.equal((cancelled[0].fields as { source: string }).source, "request_aborted");
  assert.equal(f.commits(), 0);
});
