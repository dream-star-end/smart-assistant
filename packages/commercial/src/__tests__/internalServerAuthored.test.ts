/**
 * V3 commercial — master-side handler unit tests for the container →
 * master server-authored sink endpoint.
 *
 * Covers:
 *   - method whitelist (only POST)
 *   - container identity verification gate (bad token / bad ip / bad secret)
 *   - body schema (strict, rejects unknown keys + missing fields)
 *   - userId derivation (always `c:<identity.userId>`, never wire-supplied)
 *   - msgId derivation (always `srv-<sessionId>-t<turnIndex>`)
 *   - storage outcome mapping (applied / already_exists / session_not_found
 *     / malformed / thrown)
 *   - body cap (>256 KB → 413)
 *   - empty body → 400
 *   - non-JSON body → 400
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/internalServerAuthored.test.ts
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { ServerResponse, IncomingMessage } from "node:http";
import { createHash } from "node:crypto";

import {
  makeServerAuthoredHandler,
  SERVER_AUTHORED_PATH,
  type ServerAuthoredStorage,
  type ServerAuthoredHandlerCtx,
} from "../http/internalServerAuthored.js";
import type { V3SinkPersistOutcome, V3SinkPersistRole } from "../admin/metrics.js";
import type { ContainerIdentityRepo } from "../auth/containerIdentity.js";

// ─── tiny test fixtures ─────────────────────────────────────────────────

const VALID_SECRET = "a".repeat(64);
const VALID_TOKEN = `oc-v3.7.${VALID_SECRET}`;
const VALID_HOST = "host-uuid-1";
const VALID_IP = "172.30.0.5";

function makeRepoFor(token: string, hostUuid: string, boundIp: string, containerId = 7, userId = 42): ContainerIdentityRepo {
  const secretHash = createHash("sha256").update(Buffer.from(VALID_SECRET, "hex")).digest();
  void token; // bearer is parsed by handler, not the repo
  return {
    async findActiveByHostAndBoundIp(h, ip) {
      if (h !== hostUuid || ip !== boundIp) return null;
      return { id: containerId, user_id: userId, bound_ip: boundIp, host_uuid: hostUuid, secret_hash: secretHash };
    },
  };
}

function makeReq(opts: { method?: string; body?: string | Buffer; auth?: string; url?: string }): IncomingMessage {
  const body = opts.body ?? "";
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  // Build a fake IncomingMessage off a Readable. ServerAuthored handler
  // only uses .method / .url / .headers / async iteration → minimal shim.
  const req = Readable.from(buf.length > 0 ? [buf] : []) as unknown as IncomingMessage;
  req.method = opts.method ?? "POST";
  req.url = opts.url ?? SERVER_AUTHORED_PATH;
  req.headers = {};
  if (opts.auth) req.headers.authorization = opts.auth;
  return req;
}

interface RecordedRes {
  status?: number;
  headers: Record<string, string | number>;
  body: string;
  ended: boolean;
}

function makeRes(): { res: ServerResponse; rec: RecordedRes } {
  const rec: RecordedRes = { headers: {}, body: "", ended: false };
  // Minimal subset of ServerResponse — handler only calls writeHead / end /
  // setHeader / headersSent. Skip the full prototype chain; handler doesn't
  // need it.
  const res = {
    headersSent: false,
    setHeader(k: string, v: string | number) { rec.headers[String(k).toLowerCase()] = v; },
    writeHead(status: number, headers: Record<string, string | number>) {
      rec.status = status;
      for (const [k, v] of Object.entries(headers)) {
        rec.headers[String(k).toLowerCase()] = v;
      }
      this.headersSent = true;
    },
    end(chunk?: string) {
      if (chunk !== undefined) rec.body += chunk;
      rec.ended = true;
    },
  } as unknown as ServerResponse;
  return { res, rec };
}

const CTX: ServerAuthoredHandlerCtx = { hostUuid: VALID_HOST, boundIp: VALID_IP };

function fakeStorage(impl: ServerAuthoredStorage["appendServerAuthoredMessage"]): ServerAuthoredStorage {
  return {
    appendServerAuthoredMessage: impl,
    // Mirror to assistant *ForRequest path so existing assistant-text tests keep
    // passing without re-wiring requestId. Tests that exercise the request_map
    // semantics directly use a custom storage mock (recordingStorage below).
    async appendServerAuthoredMessageForRequest(_requestId, sessId, userId, msg) {
      const r = await impl(sessId, userId, msg);
      if (r.applied) return { applied: true };
      return { applied: false, reason: r.reason ?? "malformed" };
    },
  };
}

// ─── tests ───────────────────────────────────────────────────────────────

describe("internalServerAuthored handler — method gate", () => {
  test("405 on non-POST", async () => {
    const handler = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: true })),
    });
    const { res, rec } = makeRes();
    await handler(makeReq({ method: "GET" }), res, CTX);
    assert.equal(rec.status, 405);
  });
});

describe("internalServerAuthored handler — identity gate", () => {
  test("401 when bearer missing", async () => {
    const handler = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: true })),
    });
    const { res, rec } = makeRes();
    await handler(makeReq({ body: "{}" }), res, CTX);
    assert.equal(rec.status, 401);
  });

  test("401 when (host,ip) doesn't match repo", async () => {
    const handler = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: true })),
    });
    const { res, rec } = makeRes();
    await handler(
      makeReq({ body: "{}", auth: `Bearer ${VALID_TOKEN}` }),
      res,
      { hostUuid: "other-host", boundIp: "1.2.3.4" },
    );
    assert.equal(rec.status, 401);
  });

  test("401 when secret mismatches", async () => {
    const wrongTokenSecret = "b".repeat(64);
    const handler = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: true })),
    });
    const { res, rec } = makeRes();
    await handler(makeReq({ body: "{}", auth: `Bearer oc-v3.7.${wrongTokenSecret}` }), res, CTX);
    assert.equal(rec.status, 401);
  });
});

describe("internalServerAuthored handler — body schema", () => {
  function authedReq(body: string): IncomingMessage {
    return makeReq({ body, auth: `Bearer ${VALID_TOKEN}` });
  }
  const handlerWithStorage = (storage: ServerAuthoredStorage) =>
    makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage,
    });

  test("400 on empty body", async () => {
    const h = handlerWithStorage(fakeStorage(async () => ({ applied: true })));
    const { res, rec } = makeRes();
    await h(authedReq(""), res, CTX);
    assert.equal(rec.status, 400);
  });

  test("400 on invalid JSON", async () => {
    const h = handlerWithStorage(fakeStorage(async () => ({ applied: true })));
    const { res, rec } = makeRes();
    await h(authedReq("{not-json"), res, CTX);
    assert.equal(rec.status, 400);
  });

  test("400 on missing required field", async () => {
    const h = handlerWithStorage(fakeStorage(async () => ({ applied: true })));
    const { res, rec } = makeRes();
    await h(authedReq(JSON.stringify({ sessionId: "abc12345", turnIndex: 0, status: "completed" })), res, CTX);
    assert.equal(rec.status, 400);
  });

  test("400 on bad enum value for status", async () => {
    const h = handlerWithStorage(fakeStorage(async () => ({ applied: true })));
    const { res, rec } = makeRes();
    await h(
      authedReq(JSON.stringify({ sessionId: "abc12345", turnIndex: 0, status: "weird", text: "hi" })),
      res,
      CTX,
    );
    assert.equal(rec.status, 400);
  });

  test("400 on extra unknown keys (strict)", async () => {
    const h = handlerWithStorage(fakeStorage(async () => ({ applied: true })));
    const { res, rec } = makeRes();
    await h(
      authedReq(
        JSON.stringify({
          sessionId: "abc12345",
          turnIndex: 0,
          status: "completed",
          text: "hi",
          userId: "evil:99", // wire-supplied userId MUST be rejected
        }),
      ),
      res,
      CTX,
    );
    assert.equal(rec.status, 400);
  });

  test("413 on body > 256 KB", async () => {
    const h = handlerWithStorage(fakeStorage(async () => ({ applied: true })));
    const { res, rec } = makeRes();
    // Use a payload larger than MAX_BODY_BYTES + JSON overhead — handler
    // rejects via readBoundedJson before zod sees it.
    const giant = Buffer.alloc(256 * 1024 + 1024).fill(0x61).toString("ascii");
    await h(authedReq(giant), res, CTX);
    assert.equal(rec.status, 413);
  });
});

describe("internalServerAuthored handler — userId/msgId derivation", () => {
  test("storage receives c:<uid> and srv-<sessionId>-t<turn> regardless of wire body", async () => {
    let capturedUid: string | null = null;
    let capturedMsgId: string | null = null;
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP, 7, 42),
      storage: fakeStorage(async (sessId, userId, msg) => {
        void sessId;
        capturedUid = userId;
        capturedMsgId = msg.id;
        return { applied: true };
      }),
    });
    const { res, rec } = makeRes();
    await h(
      makeReq({
        body: JSON.stringify({ sessionId: "sess12345", turnIndex: 3, status: "completed", text: "hi", requestId: "req-12345abc" }),
        auth: `Bearer ${VALID_TOKEN}`,
      }),
      res,
      CTX,
    );
    assert.equal(rec.status, 200);
    assert.equal(capturedUid, "c:42");
    assert.equal(capturedMsgId, "srv-sess12345-t3");
  });
});

describe("internalServerAuthored handler — storage outcome mapping", () => {
  function authed(body: string) {
    return makeReq({ body, auth: `Bearer ${VALID_TOKEN}` });
  }
  const validBody = JSON.stringify({
    sessionId: "sess12345",
    turnIndex: 1,
    status: "completed",
    text: "hi",
    requestId: "req-12345abc",
  });

  test("200 ok on applied:true", async () => {
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: true })),
    });
    const { res, rec } = makeRes();
    await h(authed(validBody), res, CTX);
    assert.equal(rec.status, 200);
    const parsed = JSON.parse(rec.body) as { ok: boolean; idempotent?: boolean };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.idempotent, undefined);
  });

  test("200 ok+idempotent on already_exists", async () => {
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: false, reason: "already_exists" })),
    });
    const { res, rec } = makeRes();
    await h(authed(validBody), res, CTX);
    assert.equal(rec.status, 200);
    const parsed = JSON.parse(rec.body) as { ok: boolean; idempotent?: boolean };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.idempotent, true);
  });

  test("404 on session_not_found", async () => {
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: false, reason: "session_not_found" })),
    });
    const { res, rec } = makeRes();
    await h(authed(validBody), res, CTX);
    assert.equal(rec.status, 404);
  });

  test("410 on session_deleted (soft-deleted row, terminal — sink fatal-drops)", async () => {
    // Why a separate code from 404: soft-deleted is terminal (the row exists
    // but tombstoned), whereas 404 may be a first-turn race that resolves
    // after the frontend's debounced PUT lands. v3MasterSink classifies 410
    // as 'fatal' to prevent a 24h durable retry storm against a stable
    // tombstone (the original §1 root cause for user c:66).
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: false, reason: "session_deleted" })),
    });
    const { res, rec } = makeRes();
    await h(authed(validBody), res, CTX);
    assert.equal(rec.status, 410);
    const parsed = JSON.parse(rec.body) as { error: { code: string } };
    assert.equal(parsed.error.code, "SESSION_DELETED");
  });

  test("500 on malformed", async () => {
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: false, reason: "malformed" })),
    });
    const { res, rec } = makeRes();
    await h(authed(validBody), res, CTX);
    assert.equal(rec.status, 500);
  });

  test("500 when storage throws", async () => {
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => {
        throw new Error("disk full");
      }),
    });
    const { res, rec } = makeRes();
    await h(authed(validBody), res, CTX);
    assert.equal(rec.status, 500);
  });
});

describe("internalServerAuthored handler — sink persist metric outcomes", () => {
  // Why per-outcome here: ops dashboards use oc_v3_sink_persist_total to detect
  // post-deploy regression (boss-mandated root-cause monitoring for the
  // 2026-05-05 codex truncation incident — capability label drift between
  // master sink call sites and stale container image silently zeroes 'ok').
  // If a future refactor renames an outcome label string or moves a return
  // path, these assertions break loudly instead of dashboards going silent.
  function captureMetric(): {
    calls: V3SinkPersistOutcome[];
    metric: (o: V3SinkPersistOutcome) => void;
  } {
    const calls: V3SinkPersistOutcome[] = [];
    return { calls, metric: (o) => calls.push(o) };
  }
  function authed(body: string) {
    return makeReq({ body, auth: `Bearer ${VALID_TOKEN}` });
  }
  const validBody = JSON.stringify({
    sessionId: "sess12345",
    turnIndex: 1,
    status: "completed",
    text: "hi",
    requestId: "req-12345abc",
  });

  test("ok on applied:true", async () => {
    const m = captureMetric();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: true })),
      metric: m.metric,
    });
    const { res } = makeRes();
    await h(authed(validBody), res, CTX);
    assert.deepEqual(m.calls, ["ok"]);
  });

  test("deduped on already_exists", async () => {
    const m = captureMetric();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: false, reason: "already_exists" })),
      metric: m.metric,
    });
    const { res } = makeRes();
    await h(authed(validBody), res, CTX);
    assert.deepEqual(m.calls, ["deduped"]);
  });

  test("reject_session_missing on session_not_found", async () => {
    const m = captureMetric();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: false, reason: "session_not_found" })),
      metric: m.metric,
    });
    const { res } = makeRes();
    await h(authed(validBody), res, CTX);
    assert.deepEqual(m.calls, ["reject_session_missing"]);
  });

  test("reject_session_deleted on session_deleted (distinct from session_missing)", async () => {
    // Pinning a separate metric label so dashboards can distinguish:
    //   reject_session_missing → recoverable race (frontend PUT in flight)
    //   reject_session_deleted → terminal tombstone (stop retrying)
    // Conflating them masks user-c:66-class storms.
    const m = captureMetric();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: false, reason: "session_deleted" })),
      metric: m.metric,
    });
    const { res } = makeRes();
    await h(authed(validBody), res, CTX);
    assert.deepEqual(m.calls, ["reject_session_deleted"]);
  });

  test("reject_unauthorized on identity failure", async () => {
    const m = captureMetric();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: true })),
      metric: m.metric,
    });
    const { res } = makeRes();
    // No auth header → identity verification fails before any storage call.
    await h(makeReq({ body: validBody }), res, CTX);
    assert.deepEqual(m.calls, ["reject_unauthorized"]);
  });

  test("reject_bad_body on schema rejection", async () => {
    const m = captureMetric();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: true })),
      metric: m.metric,
    });
    const { res } = makeRes();
    await h(authed("{not-json"), res, CTX);
    assert.deepEqual(m.calls, ["reject_bad_body"]);
  });

  test("reject_bad_body on payload too large (413)", async () => {
    const m = captureMetric();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: true })),
      metric: m.metric,
    });
    const { res } = makeRes();
    const giant = Buffer.alloc(256 * 1024 + 1024).fill(0x61).toString("ascii");
    await h(authed(giant), res, CTX);
    assert.deepEqual(m.calls, ["reject_bad_body"]);
  });

  test("error on malformed master row", async () => {
    const m = captureMetric();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: false, reason: "malformed" })),
      metric: m.metric,
    });
    const { res } = makeRes();
    await h(authed(validBody), res, CTX);
    assert.deepEqual(m.calls, ["error"]);
  });

  test("error when storage throws", async () => {
    const m = captureMetric();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => {
        throw new Error("disk full");
      }),
      metric: m.metric,
    });
    const { res } = makeRes();
    await h(authed(validBody), res, CTX);
    assert.deepEqual(m.calls, ["error"]);
  });

  test("non-POST does not pollute persist metric (405 path skips counter)", async () => {
    const m = captureMetric();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: true })),
      metric: m.metric,
    });
    const { res } = makeRes();
    await h(makeReq({ method: "GET" }), res, CTX);
    assert.deepEqual(m.calls, []);
  });
});

// ─── Phase 0.4: thinking durability — dual-write paths ──────────────────
describe("internalServerAuthored handler — thinking durability", () => {
  type Call = [V3SinkPersistOutcome, V3SinkPersistRole | undefined];
  function captureMetricRich(): { calls: Call[]; metric: (o: V3SinkPersistOutcome, r?: V3SinkPersistRole) => void } {
    const calls: Call[] = [];
    return { calls, metric: (o, r) => calls.push([o, r]) };
  }
  function authed(body: string) {
    return makeReq({ body, auth: `Bearer ${VALID_TOKEN}` });
  }

  // Storage that records role + id of every call so we can assert the
  // double-write semantics (thinking row first, assistant row second).
  function recordingStorage(): {
    storage: ServerAuthoredStorage;
    rows: Array<{ role: string; id: string; ts: number; text: string }>;
    setNextResult: (r: Awaited<ReturnType<ServerAuthoredStorage["appendServerAuthoredMessage"]>>, role?: "thinking" | "assistant") => void;
    setNextThrow: (e: Error, role?: "thinking" | "assistant") => void;
  } {
    const rows: Array<{ role: string; id: string; ts: number; text: string }> = [];
    const overrides: Record<string, Awaited<ReturnType<ServerAuthoredStorage["appendServerAuthoredMessage"]>>> = {};
    const throwers: Record<string, Error> = {};
    return {
      rows,
      setNextResult(r, role) {
        if (role) overrides[role] = r;
        else { overrides["thinking"] = r; overrides["assistant"] = r; }
      },
      setNextThrow(e, role) {
        if (role) throwers[role] = e;
        else { throwers["thinking"] = e; throwers["assistant"] = e; }
      },
      storage: {
        async appendServerAuthoredMessage(_sessId, _userId, msg) {
          rows.push({ role: msg.role, id: msg.id, ts: msg.ts, text: msg.text });
          if (throwers[msg.role]) throw throwers[msg.role];
          return overrides[msg.role] ?? { applied: true };
        },
        // Plan §4.3 改动 6 — assistant write goes through *ForRequest. Mirror to
        // appendServerAuthoredMessage for these tests so the per-row recording
        // and override/throw matrices keep working unchanged. Tests that need
        // to assert the *ForRequest contract specifically (see usageAggregation
        // suite in storage package) cover the storage-layer behavior directly.
        async appendServerAuthoredMessageForRequest(_requestId, sessId, userId, msg) {
          const r = await this.appendServerAuthoredMessage(sessId, userId, msg);
          if (r.applied) return { applied: true };
          return { applied: false, reason: r.reason ?? "malformed" };
        },
      },
    };
  }

  // ─ thinking-only paths (Branch A) ─

  test("thinking-only applied → 200 ok, single thinking metric", async () => {
    const rec = recordingStorage();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    const body = JSON.stringify({
      sessionId: "sess12345",
      turnIndex: 1,
      status: "completed",
      text: "",
      thinkingText: "reasoning here",
    });
    await h(authed(body), res, CTX);
    assert.equal(resRec.status, 200);
    assert.equal(rec.rows.length, 1);
    assert.equal(rec.rows[0].role, "thinking");
    assert.equal(rec.rows[0].id, "srv-sess12345-t1-thinking");
    assert.deepEqual(m.calls, [["ok", "thinking"]]);
  });

  test("thinking-only already_exists → 200 idempotent, deduped/thinking", async () => {
    const rec = recordingStorage();
    rec.setNextResult({ applied: false, reason: "already_exists" }, "thinking");
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 1, status: "completed", text: "", thinkingText: "x",
    })), res, CTX);
    assert.equal(resRec.status, 200);
    const parsed = JSON.parse(resRec.body) as { ok: boolean; idempotent?: boolean };
    assert.equal(parsed.idempotent, true);
    assert.deepEqual(m.calls, [["deduped", "thinking"]]);
  });

  test("thinking-only session_not_found → 404, reject_session_missing/thinking", async () => {
    const rec = recordingStorage();
    rec.setNextResult({ applied: false, reason: "session_not_found" }, "thinking");
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 1, status: "completed", text: "", thinkingText: "x",
    })), res, CTX);
    assert.equal(resRec.status, 404);
    assert.deepEqual(m.calls, [["reject_session_missing", "thinking"]]);
  });

  test("thinking-only session_deleted → 410, reject_session_deleted/thinking (terminal)", async () => {
    const rec = recordingStorage();
    rec.setNextResult({ applied: false, reason: "session_deleted" }, "thinking");
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 1, status: "completed", text: "", thinkingText: "x",
    })), res, CTX);
    assert.equal(resRec.status, 410);
    assert.deepEqual(m.calls, [["reject_session_deleted", "thinking"]]);
  });

  test("thinking-only storage throws → 500 (sink retries; can't drop the only data)", async () => {
    const rec = recordingStorage();
    rec.setNextThrow(new Error("disk full"), "thinking");
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 1, status: "completed", text: "", thinkingText: "x",
    })), res, CTX);
    assert.equal(resRec.status, 500);
    assert.deepEqual(m.calls, [["error", "thinking"]]);
  });

  test("thinking-only malformed → 500, error/thinking", async () => {
    const rec = recordingStorage();
    rec.setNextResult({ applied: false, reason: "malformed" }, "thinking");
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 1, status: "completed", text: "", thinkingText: "x",
    })), res, CTX);
    assert.equal(resRec.status, 500);
    assert.deepEqual(m.calls, [["error", "thinking"]]);
  });

  // ─ both fields (Branch B) ─

  test("both fields, both applied → 200 ok, two metrics (thinking then assistant), thinking ts=baseTs-1, assistant ts=baseTs", async () => {
    const rec = recordingStorage();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 2, status: "completed",
      text: "answer", thinkingText: "reasoning", createdAt: 5_000,
      requestId: "req-12345abc",
    })), res, CTX);
    assert.equal(resRec.status, 200);
    // Two storage rows: thinking first (lower ts), assistant second.
    assert.equal(rec.rows.length, 2);
    assert.equal(rec.rows[0].role, "thinking");
    assert.equal(rec.rows[0].ts, 4_999);
    assert.equal(rec.rows[0].id, "srv-sess12345-t2-thinking");
    assert.equal(rec.rows[1].role, "assistant");
    assert.equal(rec.rows[1].ts, 5_000);
    assert.equal(rec.rows[1].id, "srv-sess12345-t2");
    // Two metrics in order: thinking, then assistant
    assert.deepEqual(m.calls, [["ok", "thinking"], ["ok", "assistant"]]);
  });

  test("both fields, thinking already_exists, assistant applied → 200, deduped/thinking + ok/assistant", async () => {
    const rec = recordingStorage();
    rec.setNextResult({ applied: false, reason: "already_exists" }, "thinking");
    rec.setNextResult({ applied: true }, "assistant");
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 2, status: "completed",
      text: "answer", thinkingText: "reasoning", requestId: "req-12345abc",
    })), res, CTX);
    assert.equal(resRec.status, 200);
    assert.deepEqual(m.calls, [["deduped", "thinking"], ["ok", "assistant"]]);
  });

  test("DEGRADE: thinking storage throws, assistant applied → 200 ok (thinking dropped, assistant preserved)", async () => {
    const rec = recordingStorage();
    rec.setNextThrow(new Error("disk full"), "thinking");
    rec.setNextResult({ applied: true }, "assistant");
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 3, status: "completed",
      text: "answer", thinkingText: "reasoning", requestId: "req-12345abc",
    })), res, CTX);
    // Assistant succeeded → 200 (degrade gracefully, thinking lost but
    // conversation flows). Both metrics emitted: error/thinking + ok/assistant.
    assert.equal(resRec.status, 200);
    assert.deepEqual(m.calls, [["error", "thinking"], ["ok", "assistant"]]);
  });

  test("DEGRADE: thinking applied, assistant session_not_found → 404 (sink retries; assistant decides HTTP)", async () => {
    const rec = recordingStorage();
    rec.setNextResult({ applied: true }, "thinking");
    rec.setNextResult({ applied: false, reason: "session_not_found" }, "assistant");
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 4, status: "completed",
      text: "answer", thinkingText: "reasoning", requestId: "req-12345abc",
    })), res, CTX);
    assert.equal(resRec.status, 404);
    assert.deepEqual(m.calls, [["ok", "thinking"], ["reject_session_missing", "assistant"]]);
  });

  test("DEGRADE: thinking applied, assistant session_deleted → 410 (sink fatal-drops; terminal)", async () => {
    // Subtle but important: thinking row landed (race-window: thinking write
    // happened *before* the soft-delete commit, or against a different row
    // state), but by the time the assistant write runs, the row is tombstoned.
    // The handler still emits both metrics in order so dashboards see the
    // partial-success and the terminal reject. HTTP status follows the
    // assistant outcome — 410 fatal — so the sink stops retrying.
    const rec = recordingStorage();
    rec.setNextResult({ applied: true }, "thinking");
    rec.setNextResult({ applied: false, reason: "session_deleted" }, "assistant");
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 4, status: "completed",
      text: "answer", thinkingText: "reasoning", requestId: "req-12345abc",
    })), res, CTX);
    assert.equal(resRec.status, 410);
    assert.deepEqual(m.calls, [["ok", "thinking"], ["reject_session_deleted", "assistant"]]);
  });

  test("assistant-only session_deleted → 410, reject_session_deleted/assistant", async () => {
    const rec = recordingStorage();
    rec.setNextResult({ applied: false, reason: "session_deleted" }, "assistant");
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 5, status: "completed", text: "answer",
      requestId: "req-12345abc",
    })), res, CTX);
    assert.equal(resRec.status, 410);
    assert.deepEqual(m.calls, [["reject_session_deleted", "assistant"]]);
  });

  test("assistant-only (no thinkingText key) → single assistant metric, no thinking row", async () => {
    const rec = recordingStorage();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 5, status: "completed", text: "answer",
      requestId: "req-12345abc",
    })), res, CTX);
    assert.equal(resRec.status, 200);
    assert.equal(rec.rows.length, 1);
    assert.equal(rec.rows[0].role, "assistant");
    assert.deepEqual(m.calls, [["ok", "assistant"]]);
  });

  test("schema rejects empty text + empty/missing thinkingText (refine: at least one field)", async () => {
    const rec = recordingStorage();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 6, status: "completed", text: "",
    })), res, CTX);
    assert.equal(resRec.status, 400);
    assert.equal(rec.rows.length, 0, "no storage call when schema rejects");
    assert.deepEqual(m.calls, [["reject_bad_body", undefined]]);
  });
});
