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
import type { V3SinkPersistOutcome } from "../admin/metrics.js";
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
  return { appendServerAuthoredMessage: impl };
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
        body: JSON.stringify({ sessionId: "sess12345", turnIndex: 3, status: "completed", text: "hi" }),
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
