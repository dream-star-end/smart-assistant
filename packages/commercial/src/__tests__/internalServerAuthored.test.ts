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
import type { Logger } from "../logging/logger.js";
import {
  LOSSLESS_TURN_TAPE_PART_BYTES,
  LOSSLESS_TURN_TAPE_VERSION,
  type LosslessTurnTapeFinalizeRequest,
  type LosslessTurnTapePartRequest,
} from "@openclaude/protocol";

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
    writeHead(this: { headersSent: boolean }, status: number, headers: Record<string, string | number>) {
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
    // ccb-spawn(无 requestId)助手路径:mirror 到同一 impl,既有断言不变(drain 行为由 storage
    // 单测覆盖;这里只验 handler 路由)。
    async appendServerAuthoredMessageDrainByUser(sessId, userId, msg) {
      const r = await impl(sessId, userId, msg);
      if (r.applied) return { applied: true };
      return { applied: false, reason: r.reason ?? "malformed" };
    },
    // 委派成本归并 by storage 单测覆盖;handler 路由测试用 no-op 桩(无委派成本语义)。
    async drainDelegateCostForClientSession() {
      return { merged: "0", drained: 0 };
    },
  };
}

describe("internalServerAuthored handler — lossless v2 multipart", () => {
  test("accepts a full 192 KiB raw part without applying the legacy 256 KiB JSON-body cap", async () => {
    const bytes = Buffer.from("x".repeat(LOSSLESS_TURN_TAPE_PART_BYTES), "utf8");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const turnKey = "a".repeat(64);
    const tapeId = "b".repeat(64);
    let staged: Buffer | null = null;
    const handler = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: true })),
      losslessTurnTapeStorage: {
        async stageLosslessTurnTapePart(_userId, _body, payload) {
          staged = Buffer.from(payload);
          return { applied: "stored" };
        },
        async finalizeLosslessTurnTape() {
          return { applied: "finalized", recordCount: 1, engineBillings: [] };
        },
      },
    });
    const part: LosslessTurnTapePartRequest = {
      protocolVersion: LOSSLESS_TURN_TAPE_VERSION,
      action: "part",
      sessionId: "web-test1",
      agentId: "main",
      turnIndex: 1,
      status: "completed",
      turnKey,
      tapeId,
      tapeSha256: sha,
      totalBytes: bytes.length,
      partCount: 1,
      partIndex: 0,
      partSha256: sha,
      data: bytes.toString("base64"),
      createdAt: 1_783_944_000_000,
    };
    const { res, rec } = makeRes();
    await handler(makeReq({ body: JSON.stringify(part), auth: `Bearer ${VALID_TOKEN}` }), res, CTX);
    assert.equal(rec.status, 200);
    assert.deepEqual(staged, bytes);

    const finalize: LosslessTurnTapeFinalizeRequest = {
      protocolVersion: LOSSLESS_TURN_TAPE_VERSION,
      action: "finalize",
      sessionId: part.sessionId,
      agentId: part.agentId,
      turnIndex: part.turnIndex,
      status: part.status,
      turnKey,
      tapeId,
      tapeSha256: sha,
      totalBytes: bytes.length,
      partCount: 1,
      createdAt: part.createdAt,
    };
    const finalRes = makeRes();
    await handler(
      makeReq({ body: JSON.stringify(finalize), auth: `Bearer ${VALID_TOKEN}` }),
      finalRes.res,
      CTX,
    );
    assert.equal(finalRes.rec.status, 200);
    assert.equal(JSON.parse(finalRes.rec.body).recordCount, 1);
  });

  test("does not ACK a finalized paid tape until durable Codex billing settles", async () => {
    const billing = {
      requestId: "c".repeat(32),
      turnKey: "a".repeat(64),
      engineSessionId: `oceng-${"d".repeat(48)}`,
      status: "success" as const,
      durationMs: 12,
      usage: { input_tokens: 3, output_tokens: 4 },
    };
    let finalizeCalls = 0;
    let settleCalls = 0;
    const handler = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async () => ({ applied: true })),
      losslessTurnTapeStorage: {
        async stageLosslessTurnTapePart() {
          return { applied: "stored" };
        },
        async finalizeLosslessTurnTape() {
          finalizeCalls++;
          return {
            applied: finalizeCalls === 1 ? "finalized" : "idempotent",
            recordCount: 2,
            engineBillings: [billing],
          };
        },
      },
      async settleCodexBilling(userId, exact) {
        settleCalls++;
        assert.equal(userId, 42n);
        assert.deepEqual(exact, billing);
        if (settleCalls === 1) throw new Error("temporary billing database outage");
      },
    });
    const finalize: LosslessTurnTapeFinalizeRequest = {
      protocolVersion: LOSSLESS_TURN_TAPE_VERSION,
      action: "finalize",
      sessionId: "web-test1",
      agentId: "codex",
      turnIndex: 1,
      status: "completed",
      turnKey: "a".repeat(64),
      tapeId: "b".repeat(64),
      tapeSha256: "e".repeat(64),
      totalBytes: 1,
      partCount: 1,
      createdAt: 1_783_944_000_000,
    };

    const first = makeRes();
    await handler(
      makeReq({ body: JSON.stringify(finalize), auth: `Bearer ${VALID_TOKEN}` }),
      first.res,
      CTX,
    );
    assert.equal(first.rec.status, 503, "transient settle failure must keep the fsynced tape queued");

    const retry = makeRes();
    await handler(
      makeReq({ body: JSON.stringify(finalize), auth: `Bearer ${VALID_TOKEN}` }),
      retry.res,
      CTX,
    );
    assert.equal(retry.rec.status, 200);
    assert.equal(JSON.parse(retry.rec.body).idempotent, true);
    assert.equal(finalizeCalls, 2);
    assert.equal(settleCalls, 2, "idempotent finalize must replay durable billing evidence");
  });
});

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

// ─── agentId fold-in (Fix A, 2026-05-13) ─────────────────────────────────
//
// Why this exists:
//   A single chat (peerId) can rotate across multiple AgentSessions when the
//   user switches model mid-conversation. Each AgentSession's `session.turns`
//   restarts at 0, so both `codex` and `main` would mint
//   `srv-${sessionId}-t1` — same id, two distinct answers → client merges
//   them, only one ever shows. Fix A passes `agentId` from the container
//   gateway; when present, master folds it into the persisted message id so
//   each agent's turn gets its own row.
//
// Wire-optional rationale:
//   On a rolling container-image deploy, master is upgraded before container
//   images, so the upgraded master must still accept pre-Fix-A bodies (no
//   `agentId` field). The legacy id format is preserved for that case so
//   in-flight turns from old containers persist cleanly.

describe("internalServerAuthored handler — agentId schema validation", () => {
  function authed(body: string) {
    return makeReq({ body, auth: `Bearer ${VALID_TOKEN}` });
  }
  const handlerWithStorage = (storage: ServerAuthoredStorage) =>
    makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage,
    });

  test("accepts valid agentId 'main'", async () => {
    const h = handlerWithStorage(fakeStorage(async () => ({ applied: true })));
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345", turnIndex: 0, status: "completed", text: "hi",
        agentId: "main", requestId: "req-12345abc",
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 200);
  });

  test("accepts valid agentId 'codex'", async () => {
    const h = handlerWithStorage(fakeStorage(async () => ({ applied: true })));
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345", turnIndex: 0, status: "completed", text: "hi",
        agentId: "codex", requestId: "req-12345abc",
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 200);
  });

  test("accepts boundary lengths: 1 char + 64 chars", async () => {
    const h = handlerWithStorage(fakeStorage(async () => ({ applied: true })));
    for (const agentId of ["a", "A".repeat(64), "_-Az09"]) {
      const { res, rec } = makeRes();
      await h(
        authed(JSON.stringify({
          sessionId: "sess12345", turnIndex: 0, status: "completed", text: "hi",
          agentId, requestId: "req-12345abc",
        })),
        res,
        CTX,
      );
      assert.equal(rec.status, 200, `agentId=${agentId} should pass`);
    }
  });

  test("400 when agentId contains illegal char (.)", async () => {
    // Personal-version-style ids like `minimax2.7` would fail master charset
    // even if they somehow reached this endpoint. Wider charset on master =
    // wider attack surface for log/URL injection in derived messageIds.
    const h = handlerWithStorage(fakeStorage(async () => ({ applied: true })));
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345", turnIndex: 0, status: "completed", text: "hi",
        agentId: "minimax2.7",
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 400);
  });

  test("400 when agentId is empty string", async () => {
    const h = handlerWithStorage(fakeStorage(async () => ({ applied: true })));
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345", turnIndex: 0, status: "completed", text: "hi",
        agentId: "",
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 400);
  });

  test("400 when agentId exceeds 64 chars", async () => {
    const h = handlerWithStorage(fakeStorage(async () => ({ applied: true })));
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345", turnIndex: 0, status: "completed", text: "hi",
        agentId: "a".repeat(65),
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 400);
  });

  test("400 when agentId is not a string (number)", async () => {
    const h = handlerWithStorage(fakeStorage(async () => ({ applied: true })));
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345", turnIndex: 0, status: "completed", text: "hi",
        agentId: 42,
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 400);
  });
});

describe("internalServerAuthored handler — agentId fold-in derives unique msgId", () => {
  function authed(body: string) {
    return makeReq({ body, auth: `Bearer ${VALID_TOKEN}` });
  }

  test("agentId present → assistant msgId = srv-<sessionId>-<agentId>-t<turn>", async () => {
    let capturedMsgId: string | null = null;
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async (_sessId, _userId, msg) => {
        capturedMsgId = msg.id;
        return { applied: true };
      }),
    });
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345", turnIndex: 1, status: "completed", text: "hi",
        agentId: "codex", requestId: "req-12345abc",
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 200);
    assert.equal(capturedMsgId, "srv-sess12345-codex-t1");
  });

  test("agentId absent → assistant msgId falls back to legacy srv-<sessionId>-t<turn>", async () => {
    // Critical compatibility check: pre-Fix-A container images that haven't
    // been redeployed yet send no agentId, and master MUST accept them at
    // the legacy id (rolling-deploy safety).
    let capturedMsgId: string | null = null;
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async (_sessId, _userId, msg) => {
        capturedMsgId = msg.id;
        return { applied: true };
      }),
    });
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345", turnIndex: 1, status: "completed", text: "hi",
        requestId: "req-12345abc",
        // agentId intentionally omitted
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 200);
    assert.equal(capturedMsgId, "srv-sess12345-t1");
  });

  test("two agentIds at same (sessionId, turnIndex) produce distinct msgIds — regression for 2026-05-13 model-switch merge bug", async () => {
    // The exact bug shape: user types in a chat, codex (agentId=codex) answers
    // turn 1. User switches to deepseek (agentId=main, fresh AgentSession with
    // session.turns=0 → projected turnIndex=1). Both turns hit master with the
    // same (sessionId, turnIndex). Without agentId disambiguation they collide
    // at `srv-<sessionId>-t1`; with it they're `-codex-t1` vs `-main-t1`.
    const capturedIds: string[] = [];
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async (_sessId, _userId, msg) => {
        capturedIds.push(msg.id);
        return { applied: true };
      }),
    });
    // Call 1 — codex turn 1.
    {
      const { res } = makeRes();
      await h(
        authed(JSON.stringify({
          sessionId: "sess12345", turnIndex: 1, status: "completed", text: "codex answer",
          agentId: "codex", requestId: "req-codex-1",
        })),
        res,
        CTX,
      );
    }
    // Call 2 — main turn 1 (after the user switched models).
    {
      const { res } = makeRes();
      await h(
        authed(JSON.stringify({
          sessionId: "sess12345", turnIndex: 1, status: "completed", text: "deepseek answer",
          agentId: "main", requestId: "req-main-1",
        })),
        res,
        CTX,
      );
    }
    assert.equal(capturedIds.length, 2);
    assert.equal(capturedIds[0], "srv-sess12345-codex-t1");
    assert.equal(capturedIds[1], "srv-sess12345-main-t1");
    assert.notEqual(capturedIds[0], capturedIds[1], "msgIds must differ (regression guard)");
  });

  test("agentId present + thinkingText → thinking msgId = srv-<sessionId>-<agentId>-t<turn>-thinking", async () => {
    const captured: Array<{ role: string; id: string }> = [];
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async (_sessId, _userId, msg) => {
        captured.push({ role: msg.role, id: msg.id });
        return { applied: true };
      }),
    });
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345", turnIndex: 2, status: "completed",
        text: "answer", thinkingText: "reasoning",
        agentId: "codex", requestId: "req-12345abc",
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 200);
    // Order: thinking row written first (ts = baseTs - 1), then assistant.
    const thinking = captured.find((c) => c.role === "thinking");
    const assistant = captured.find((c) => c.role === "assistant");
    assert.ok(thinking);
    assert.ok(assistant);
    assert.equal(thinking.id, "srv-sess12345-codex-t2-thinking");
    assert.equal(assistant.id, "srv-sess12345-codex-t2");
  });

  test("agentId absent + thinkingText → thinking msgId falls back to legacy srv-<sessionId>-t<turn>-thinking", async () => {
    const captured: Array<{ role: string; id: string }> = [];
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async (_sessId, _userId, msg) => {
        captured.push({ role: msg.role, id: msg.id });
        return { applied: true };
      }),
    });
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345", turnIndex: 2, status: "completed",
        text: "answer", thinkingText: "reasoning",
        requestId: "req-12345abc",
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 200);
    const thinking = captured.find((c) => c.role === "thinking");
    const assistant = captured.find((c) => c.role === "assistant");
    assert.ok(thinking);
    assert.ok(assistant);
    assert.equal(thinking.id, "srv-sess12345-t2-thinking");
    assert.equal(assistant.id, "srv-sess12345-t2");
  });

  test("agentId present + tools[] → tool msgId = srv-<sessionId>-<agentId>-t<turn>-tool-<blockId>", async () => {
    const captured: Array<{ role: string; id: string }> = [];
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async (_sessId, _userId, msg) => {
        captured.push({ role: msg.role, id: msg.id });
        return { applied: true };
      }),
    });
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345", turnIndex: 3, status: "completed",
        text: "answer",
        agentId: "codex", requestId: "req-12345abc",
        tools: [
          { toolUseId: "tu1", blockId: "blkA", toolName: "Read",
            inputJson: { path: "/x" }, inputPreview: "Read /x",
            output: "ok", isError: false, durationMs: 10, ts: 1700000000000 },
        ],
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 200);
    const tool = captured.find((c) => c.role === "tool");
    const assistant = captured.find((c) => c.role === "assistant");
    assert.ok(tool);
    assert.ok(assistant);
    assert.equal(tool.id, "srv-sess12345-codex-t3-tool-blkA");
    assert.equal(assistant.id, "srv-sess12345-codex-t3");
  });

  test("agentId absent + tools[] → tool msgId falls back to legacy srv-<sessionId>-t<turn>-tool-<blockId>", async () => {
    const captured: Array<{ role: string; id: string }> = [];
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: fakeStorage(async (_sessId, _userId, msg) => {
        captured.push({ role: msg.role, id: msg.id });
        return { applied: true };
      }),
    });
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345", turnIndex: 3, status: "completed",
        text: "answer", requestId: "req-12345abc",
        tools: [
          { toolUseId: "tu1", blockId: "blkA", toolName: "Read",
            inputJson: { path: "/x" }, inputPreview: "Read /x",
            output: "ok", isError: false, durationMs: 10, ts: 1700000000000 },
        ],
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 200);
    const tool = captured.find((c) => c.role === "tool");
    assert.ok(tool);
    assert.equal(tool.id, "srv-sess12345-t3-tool-blkA");
  });
});

describe("internalServerAuthored handler — requestId dispatch (cost-late-patch routing)", () => {
  // Why this section exists:
  //   master schema dropped the "requestId required when text non-empty"
  //   refine because non-codex (ccb-spawn) paths legitimately have no late-
  //   cost-patch consumer — gateway finalizes token usage inline. Handler
  //   now dispatches assistant writes by `body.requestId` presence:
  //     - present → appendServerAuthoredMessageForRequest (drains pending
  //       costCredits + records server_authored_request_map row)
  //     - absent  → appendServerAuthoredMessage (plain, no map row)
  //   These tests pin that exactly one of the two storage methods is hit
  //   per turn; the existing `fakeStorage` mirror would mask which path ran.
  //   Historical bug 2026-05-08~05-09: every DeepSeek V4 Pro turn was
  //   400-rejected, fatal-dropped at the sink, refresh-recovery saw zero
  //   server-authored data.
  function authed(body: string) {
    return makeReq({ body, auth: `Bearer ${VALID_TOKEN}` });
  }
  function spyStorage(): {
    plainCalls: Array<{ sessId: string; userId: string; msgId: string; role: string }>;
    forRequestCalls: Array<{ requestId: string; sessId: string; userId: string; msgId: string; role: string }>;
    drainByUserCalls: Array<{ sessId: string; userId: string; msgId: string; role: string; agentSessionId?: string | null }>;
    delegateDrainCalls: Array<{ clientSessionId: string; userId: string; msgId: string }>;
    storage: ServerAuthoredStorage;
  } {
    const plainCalls: Array<{ sessId: string; userId: string; msgId: string; role: string }> = [];
    const forRequestCalls: Array<{ requestId: string; sessId: string; userId: string; msgId: string; role: string }> = [];
    const drainByUserCalls: Array<{ sessId: string; userId: string; msgId: string; role: string; agentSessionId?: string | null }> = [];
    const delegateDrainCalls: Array<{ clientSessionId: string; userId: string; msgId: string }> = [];
    const storage: ServerAuthoredStorage = {
      async appendServerAuthoredMessage(sessId, userId, msg) {
        plainCalls.push({ sessId, userId, msgId: msg.id, role: msg.role });
        return { applied: true };
      },
      async appendServerAuthoredMessageForRequest(requestId, sessId, userId, msg) {
        forRequestCalls.push({ requestId, sessId, userId, msgId: msg.id, role: msg.role });
        return { applied: true };
      },
      async appendServerAuthoredMessageDrainByUser(sessId, userId, msg, agentSessionId) {
        drainByUserCalls.push({ sessId, userId, msgId: msg.id, role: msg.role, agentSessionId });
        return { applied: true };
      },
      async drainDelegateCostForClientSession(clientSessionId, userId, msgId) {
        delegateDrainCalls.push({ clientSessionId, userId, msgId });
        return { merged: "0", drained: 0 };
      },
    };
    return { plainCalls, forRequestCalls, drainByUserCalls, delegateDrainCalls, storage };
  }

  test("assistant text + requestId → routes to appendServerAuthoredMessageForRequest", async () => {
    const spy = spyStorage();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: spy.storage,
    });
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345",
        turnIndex: 0,
        status: "completed",
        text: "answer",
        requestId: "req-12345abc",
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 200);
    assert.equal(spy.forRequestCalls.length, 1);
    assert.equal(spy.forRequestCalls[0].requestId, "req-12345abc");
    assert.equal(spy.forRequestCalls[0].role, "assistant");
    // Plain path MUST NOT fire for the assistant write — that would skip the
    // cost-late-patch protocol entirely on codex turns.
    assert.equal(
      spy.plainCalls.filter((c) => c.role === "assistant").length,
      0,
    );
  });

  test("assistant text + missing requestId → routes to appendServerAuthoredMessageDrainByUser (200 ok)", async () => {
    // ccb-spawn 路径(无 requestId):助手写入走 drainByUser(落库时按 user 排空 pending cost),
    // 而非 plain append——使跨设备 reload 也能看到 per-response 积分。
    // (pre-fix 老 bug:该 body 曾因 "requestId required" 400 拒 → sink fatal-drop → 数据全丢,
    //  那条已修;本测试现锁定 ccb 助手路由到 drainByUser。)
    const spy = spyStorage();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: spy.storage,
    });
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345",
        turnIndex: 0,
        status: "completed",
        text: "answer",
        // requestId intentionally omitted — ccb-spawn path
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 200);
    assert.equal(spy.forRequestCalls.length, 0);
    // 助手写入走 drainByUser,不再走 plain。
    assert.equal(spy.plainCalls.filter((c) => c.role === "assistant").length, 0);
    assert.equal(spy.drainByUserCalls.length, 1);
    assert.equal(spy.drainByUserCalls[0].msgId, "srv-sess12345-t0");
    assert.equal(spy.drainByUserCalls[0].userId, "c:42");
    assert.equal(spy.drainByUserCalls[0].role, "assistant");
  });

  test("assistant + missing requestId + agentSessionId → 透传 agentSessionId 给 storage(按 session 精确)", async () => {
    const spy = spyStorage();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: spy.storage,
    });
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345",
        turnIndex: 0,
        status: "completed",
        text: "answer",
        agentSessionId: "113cb35c-c1d0-41ff-9cda-a6f370b622e0", // ccb getSessionId
        // requestId 缺省 → ccb 路径
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 200);
    assert.equal(spy.drainByUserCalls.length, 1);
    assert.equal(
      spy.drainByUserCalls[0].agentSessionId,
      "113cb35c-c1d0-41ff-9cda-a6f370b622e0",
      "agentSessionId 从 body 透传到 storage drain(精确按 session 排空)",
    );
  });

  test("assistant text + missing requestId + tools[] → tool plain, assistant drainByUser", async () => {
    // Tools 始终 plain-append(best-effort,无 requestId join)。ccb 助手写入走 drainByUser
    // (落库排空 pending cost),不会误路由到 *ForRequest;tool 仍走 plain。
    const spy = spyStorage();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: spy.storage,
    });
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345",
        turnIndex: 0,
        status: "completed",
        text: "answer",
        tools: [{
          toolUseId: "tu1", blockId: "blk1", toolName: "Read",
          inputJson: { path: "/tmp/x" }, inputPreview: "Read /tmp/x",
          output: "ok", isError: false, durationMs: 10, ts: 1700000000000,
        }],
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 200);
    assert.equal(spy.forRequestCalls.length, 0);
    // tool 走 plain;assistant 走 drainByUser。
    assert.deepEqual(spy.plainCalls.map((c) => c.role).sort(), ["tool"]);
    assert.deepEqual(spy.drainByUserCalls.map((c) => c.role).sort(), ["assistant"]);
  });

  // ── Fix A durable — 两条 sink 路径落库后都触发 client-session 委派 drain ──
  //
  // 委派成本按父客户端会话(= body.sessionId)归并进队长助手行。requestId 路径(codex)与
  // drain-by-user 路径(ccb)都必须触发这一步——统一收口,别只加一条留另一条死。drain key =
  // (body.sessionId 客户端会话, lastAssistant.id 队长行)。

  test("requestId(codex) 路径落库后触发 drainDelegateCostForClientSession(body.sessionId, msgId)", async () => {
    const spy = spyStorage();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: spy.storage,
    });
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345",
        agentId: "main",
        turnIndex: 3,
        status: "completed",
        text: "队长综合回答",
        requestId: "req-leader-codex",
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 200);
    assert.equal(spy.forRequestCalls.length, 1, "codex 走 ForRequest");
    // 委派 drain 触发一次,key = (客户端会话 body.sessionId, 队长助手行 id)。
    assert.equal(spy.delegateDrainCalls.length, 1);
    assert.equal(spy.delegateDrainCalls[0].clientSessionId, "sess12345", "按父客户端会话(body.sessionId)");
    assert.equal(spy.delegateDrainCalls[0].userId, "c:42");
    assert.equal(spy.delegateDrainCalls[0].msgId, "srv-sess12345-main-t3", "归并进队长助手行(lastAssistant.id)");
  });

  test("drain-by-user(ccb) 路径落库后同样触发 drainDelegateCostForClientSession", async () => {
    const spy = spyStorage();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: spy.storage,
    });
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345",
        agentId: "main",
        turnIndex: 4,
        status: "completed",
        text: "队长回答",
        agentSessionId: "engine-leader-uuid",
        // requestId 缺省 → ccb drain-by-user 路径
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 200);
    assert.equal(spy.forRequestCalls.length, 0);
    assert.equal(spy.drainByUserCalls.length, 1, "ccb 走 drainByUser");
    // 两条路径统一收口:委派 drain 同样触发一次。
    assert.equal(spy.delegateDrainCalls.length, 1);
    assert.equal(spy.delegateDrainCalls[0].clientSessionId, "sess12345");
    assert.equal(spy.delegateDrainCalls[0].msgId, "srv-sess12345-main-t4");
  });

  // 2026-06-18 — per-turn traceId 透传:gateway 把 master canonical traceId 折进
  // usage.traceId,master schema(.strict() usage)必须接受并原样传给 storage,
  // 最终落 messages[i].usage.traceId 供前端"请求ID"芯片 + 刷新后反查日志。
  test("usage.traceId accepted by schema + forwarded to storage as-is", async () => {
    let capturedUsage: unknown;
    const storage: ServerAuthoredStorage = {
      async appendServerAuthoredMessage(_sessId, _userId, _msg) {
        return { applied: true };
      },
      async appendServerAuthoredMessageForRequest(_requestId, _sessId, _userId, msg) {
        capturedUsage = (msg as { usage?: unknown }).usage;
        return { applied: true };
      },
      async appendServerAuthoredMessageDrainByUser(_sessId, _userId, msg) {
        capturedUsage = (msg as { usage?: unknown }).usage;
        return { applied: true };
      },
      async drainDelegateCostForClientSession() {
        return { merged: "0", drained: 0 };
      },
    };
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage,
    });
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345",
        turnIndex: 0,
        status: "completed",
        text: "answer",
        requestId: "req-12345abc",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          turn: 1,
          traceId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
        },
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 200, "usage.traceId must not be rejected by strict schema");
    assert.deepEqual(capturedUsage, {
      inputTokens: 100,
      outputTokens: 50,
      turn: 1,
      traceId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    });
  });

  test("usage.traceId with illegal chars → 400 (schema regex guard)", async () => {
    const spy = spyStorage();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: spy.storage,
    });
    const { res, rec } = makeRes();
    await h(
      authed(JSON.stringify({
        sessionId: "sess12345",
        turnIndex: 0,
        status: "completed",
        text: "answer",
        requestId: "req-12345abc",
        usage: { inputTokens: 1, traceId: "bad id with spaces!" },
      })),
      res,
      CTX,
    );
    assert.equal(rec.status, 400, "illegal traceId must be schema-rejected");
    assert.equal(spy.forRequestCalls.length, 0);
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
        // ccb 助手写入(无 requestId)走此路径;mirror 到 appendServerAuthoredMessage 保 rows
        // 记录 + override/throw 矩阵不变(drain 行为由 storage 单测覆盖)。
        async appendServerAuthoredMessageDrainByUser(sessId, userId, msg) {
          const r = await this.appendServerAuthoredMessage(sessId, userId, msg);
          if (r.applied) return { applied: true };
          return { applied: false, reason: r.reason ?? "malformed" };
        },
        async drainDelegateCostForClientSession() {
          return { merged: "0", drained: 0 };
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

// ─── Phase 1: tool durability — wire schema + handler write order ───────
describe("internalServerAuthored handler — tool durability", () => {
  type Call = [V3SinkPersistOutcome, V3SinkPersistRole | undefined];
  function captureMetricRich(): { calls: Call[]; metric: (o: V3SinkPersistOutcome, r?: V3SinkPersistRole) => void } {
    const calls: Call[] = [];
    return { calls, metric: (o, r) => calls.push([o, r]) };
  }
  function authed(body: string) {
    return makeReq({ body, auth: `Bearer ${VALID_TOKEN}` });
  }

  /** A minimal valid tool entry; tests override individual fields. */
  function tool(over: Partial<{
    toolUseId: string;
    blockId: string;
    toolName: string;
    inputJson: unknown;
    inputPreview: string;
    output: string;
    isError: boolean;
    durationMs: number;
    ts: number;
    arrivedAt: number;
    inputTruncated: boolean;
    outputTruncated: boolean;
  }> = {}): Record<string, unknown> {
    return {
      toolUseId: over.toolUseId ?? "tu-A",
      blockId: over.blockId ?? "blk-A",
      toolName: over.toolName ?? "Bash",
      inputJson: over.inputJson ?? { command: "echo hi" },
      inputPreview: over.inputPreview ?? "echo hi",
      output: over.output ?? "hi\n",
      isError: over.isError ?? false,
      durationMs: over.durationMs ?? 12,
      ts: over.ts ?? 100,
      ...(over.arrivedAt !== undefined ? { arrivedAt: over.arrivedAt } : {}),
      ...(over.inputTruncated !== undefined ? { inputTruncated: over.inputTruncated } : {}),
      ...(over.outputTruncated !== undefined ? { outputTruncated: over.outputTruncated } : {}),
    };
  }

  function segments(count: number, prefix = "segment"): Array<{
    index: number;
    text: string;
    ts: number;
  }> {
    return Array.from({ length: count }, (_, index) => ({
      index,
      text: `${prefix}-${index}`,
      ts: 1_000 + index,
    }));
  }

  /** Recording storage keyed by role + blockId for tool-aware overrides. */
  function recStore(): {
    storage: ServerAuthoredStorage;
    rows: Array<{ role: string; id: string; ts: number; text: string; blockId?: string; toolName?: string; inputJson?: unknown; output?: string; error?: boolean; _completed?: boolean; inputTruncated?: boolean; outputTruncated?: boolean; usage?: unknown; _truncated?: boolean; _errorCode?: string; _errorDetail?: string }>;
    setToolResult: (blockId: string, r: Awaited<ReturnType<ServerAuthoredStorage["appendServerAuthoredMessage"]>>) => void;
    setToolThrow: (blockId: string, e: Error) => void;
    setAssistantResult: (r: Awaited<ReturnType<ServerAuthoredStorage["appendServerAuthoredMessage"]>>) => void;
    setAssistantThrow: (e: Error) => void;
    setThinkingResult: (r: Awaited<ReturnType<ServerAuthoredStorage["appendServerAuthoredMessage"]>>) => void;
  } {
    const rows: Array<{ role: string; id: string; ts: number; text: string; blockId?: string; toolName?: string; inputJson?: unknown; output?: string; error?: boolean; _completed?: boolean; inputTruncated?: boolean; outputTruncated?: boolean; usage?: unknown; _truncated?: boolean; _errorCode?: string; _errorDetail?: string }> = [];
    const toolOverrides = new Map<string, Awaited<ReturnType<ServerAuthoredStorage["appendServerAuthoredMessage"]>>>();
    const toolThrowers = new Map<string, Error>();
    let assistantOverride: Awaited<ReturnType<ServerAuthoredStorage["appendServerAuthoredMessage"]>> | undefined;
    let assistantThrow: Error | undefined;
    let thinkingOverride: Awaited<ReturnType<ServerAuthoredStorage["appendServerAuthoredMessage"]>> | undefined;
    return {
      rows,
      setToolResult(b, r) { toolOverrides.set(b, r); },
      setToolThrow(b, e) { toolThrowers.set(b, e); },
      setAssistantResult(r) { assistantOverride = r; },
      setAssistantThrow(e) { assistantThrow = e; },
      setThinkingResult(r) { thinkingOverride = r; },
      storage: {
        async appendServerAuthoredMessage(_sessId, _userId, msg) {
          // Check throw conditions BEFORE recording so a "row never persisted"
          // assertion can distinguish thrown writes from successful ones —
          // mirrors real storage behavior where a thrown insert leaves no row.
          if (msg.role === "tool") {
            const b = msg.blockId ?? "";
            const t = toolThrowers.get(b);
            if (t) throw t;
          } else if (msg.role === "assistant" && assistantThrow) {
            throw assistantThrow;
          }
          rows.push({
            role: msg.role, id: msg.id, ts: msg.ts, text: msg.text,
            blockId: msg.blockId, toolName: msg.toolName, inputJson: msg.inputJson,
            output: msg.output, error: msg.error, _completed: msg._completed,
            inputTruncated: msg.inputTruncated, outputTruncated: msg.outputTruncated,
            usage: msg.usage, _truncated: msg._truncated,
            _errorCode: msg._errorCode, _errorDetail: msg._errorDetail,
          });
          if (msg.role === "tool") {
            const b = msg.blockId ?? "";
            return toolOverrides.get(b) ?? { applied: true };
          }
          if (msg.role === "thinking") return thinkingOverride ?? { applied: true };
          return assistantOverride ?? { applied: true };
        },
        async appendServerAuthoredMessageForRequest(_requestId, sessId, userId, msg) {
          // Assistant goes through *ForRequest in branch B; mirror to direct
          // path so the rows[] recording and override matrix work uniformly.
          const r = await this.appendServerAuthoredMessage(sessId, userId, msg);
          if (r.applied) return { applied: true };
          return { applied: false, reason: r.reason ?? "malformed" };
        },
        // ccb 助手(无 requestId)走 drainByUser;同样 mirror,保 rows/override 矩阵一致。
        async appendServerAuthoredMessageDrainByUser(sessId, userId, msg) {
          const r = await this.appendServerAuthoredMessage(sessId, userId, msg);
          if (r.applied) return { applied: true };
          return { applied: false, reason: r.reason ?? "malformed" };
        },
        async drainDelegateCostForClientSession() {
          return { merged: "0", drained: 0 };
        },
      },
    };
  }

  // ── Schema rejection ─────────────────────────────────────────────────────

  test("schema rejects unknown tool field (.strict() on ToolEntry)", async () => {
    // The tool entry schema is `.strict()` so a typo or future-only field
    // surfaces as 400 rather than being silently dropped — keeps the
    // master/container contract tight (caught the 'isError' vs 'error' wire
    // confusion during Phase 1 dev).
    const rec = recStore();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    const badTool = { ...tool(), wat: "nope" };
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 1, status: "completed",
      text: "answer", requestId: "req-12345abc", tools: [badTool],
    })), res, CTX);
    assert.equal(resRec.status, 400);
    assert.equal(rec.rows.length, 0);
    assert.deepEqual(m.calls, [["reject_bad_body", undefined]]);
  });

  test("schema rejects oversized inputJson (post-encode > cap)", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    // 17 KB string > SCHEMA_TOOL_INPUT_JSON_MAX_CHARS (16 KB)
    const huge = "x".repeat(17 * 1024);
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 1, status: "completed",
      text: "answer", requestId: "req-12345abc",
      tools: [tool({ inputJson: { payload: huge } })],
    })), res, CTX);
    assert.equal(resRec.status, 400);
    assert.equal(rec.rows.length, 0);
    assert.deepEqual(m.calls, [["reject_bad_body", undefined]]);
  });

  test("schema rejects empty blockId (min(1))", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 1, status: "completed",
      text: "answer", requestId: "req-12345abc",
      tools: [tool({ blockId: "" })],
    })), res, CTX);
    assert.equal(resRec.status, 400);
    assert.deepEqual(m.calls, [["reject_bad_body", undefined]]);
  });

  test("schema rejects oversized output (> SCHEMA_TOOL_OUTPUT_MAX_CHARS)", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    // 9 KB > 8 KB output cap
    const out = "y".repeat(9 * 1024);
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 1, status: "completed",
      text: "answer", requestId: "req-12345abc",
      tools: [tool({ output: out })],
    })), res, CTX);
    assert.equal(resRec.status, 400);
    assert.deepEqual(m.calls, [["reject_bad_body", undefined]]);
  });

  test("schema rejects tools[] > SCHEMA_TOOLS_MAX_LEN (50)", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    const tools51 = Array.from({ length: 51 }, (_, i) => tool({ blockId: `blk-${i}`, toolUseId: `tu-${i}` }));
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 1, status: "completed",
      text: "answer", requestId: "req-12345abc", tools: tools51,
    })), res, CTX);
    assert.equal(resRec.status, 400);
    assert.deepEqual(m.calls, [["reject_bad_body", undefined]]);
  });

  // ── Tools-only path (Branch A, !hasAssistant && !hasThinking) ─────────

  test("tools-only: single tool applied → 200 ok, ts = baseTs - 1 + 0, correct id and stored fields", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 7, status: "completed",
      text: "", createdAt: 5_000,
      tools: [tool({ blockId: "blk-A", output: "out-A", isError: false, inputTruncated: true })],
    })), res, CTX);
    assert.equal(resRec.status, 200);
    assert.equal(rec.rows.length, 1);
    const r = rec.rows[0]!;
    assert.equal(r.role, "tool");
    assert.equal(r.id, "srv-sess12345-t7-tool-blk-A");
    // toolsCount=1, baseTs - toolsCount + i = 5000 - 1 + 0 = 4999
    assert.equal(r.ts, 4_999);
    assert.equal(r.blockId, "blk-A");
    assert.equal(r.toolName, "Bash");
    assert.equal(r.output, "out-A");
    assert.equal(r.text, "out-A", "msg.text mirrors output for legacy renderers");
    assert.equal(r.error, false, "wire isError=false → stored error=false");
    assert.equal(r._completed, true);
    assert.equal(r.inputTruncated, true);
    assert.deepEqual(m.calls, [["ok", "tool"]]);
  });

  test("tools-only: multi-tool ts ordering — baseTs - N + i for i=0..N-1", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 7, status: "completed",
      text: "", createdAt: 5_000,
      tools: [
        tool({ blockId: "blk-0", toolUseId: "tu-0", output: "0" }),
        tool({ blockId: "blk-1", toolUseId: "tu-1", output: "1" }),
        tool({ blockId: "blk-2", toolUseId: "tu-2", output: "2" }),
      ],
    })), res, CTX);
    assert.equal(resRec.status, 200);
    assert.equal(rec.rows.length, 3);
    assert.equal(rec.rows[0].ts, 4_997, "i=0: 5000-3+0");
    assert.equal(rec.rows[1].ts, 4_998, "i=1: 5000-3+1");
    assert.equal(rec.rows[2].ts, 4_999, "i=2: 5000-3+2");
    assert.deepEqual(m.calls, [["ok", "tool"], ["ok", "tool"], ["ok", "tool"]]);
  });

  test("tools-only: first tool storage_threw → 500, error/tool metric, remaining tools still attempted (best-effort)", async () => {
    const rec = recStore();
    rec.setToolThrow("blk-0", new Error("disk full"));
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 7, status: "completed", text: "",
      tools: [
        tool({ blockId: "blk-0", toolUseId: "tu-0" }),
        tool({ blockId: "blk-1", toolUseId: "tu-1" }),
      ],
    })), res, CTX);
    assert.equal(resRec.status, 500);
    // blk-0 threw before push; blk-1 still attempted (best-effort) so its row lands.
    assert.equal(rec.rows.length, 1);
    assert.equal(rec.rows[0].blockId, "blk-1");
    // Per-tool metrics: error for blk-0, ok for blk-1.
    assert.deepEqual(m.calls, [["error", "tool"], ["ok", "tool"]]);
  });

  test("tools-only: first tool already_exists → 200 idempotent", async () => {
    const rec = recStore();
    rec.setToolResult("blk-0", { applied: false, reason: "already_exists" });
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 7, status: "completed", text: "",
      tools: [tool({ blockId: "blk-0" })],
    })), res, CTX);
    assert.equal(resRec.status, 200);
    const parsed = JSON.parse(resRec.body) as { ok: boolean; idempotent?: boolean };
    assert.equal(parsed.idempotent, true);
    assert.deepEqual(m.calls, [["deduped", "tool"]]);
  });

  test("tools-only: first tool session_deleted → 410 (terminal)", async () => {
    const rec = recStore();
    rec.setToolResult("blk-0", { applied: false, reason: "session_deleted" });
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 7, status: "completed", text: "",
      tools: [tool({ blockId: "blk-0" })],
    })), res, CTX);
    assert.equal(resRec.status, 410);
    assert.deepEqual(m.calls, [["reject_session_deleted", "tool"]]);
  });

  test("tools-only: first tool session_not_found → 404", async () => {
    const rec = recStore();
    rec.setToolResult("blk-0", { applied: false, reason: "session_not_found" });
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 7, status: "completed", text: "",
      tools: [tool({ blockId: "blk-0" })],
    })), res, CTX);
    assert.equal(resRec.status, 404);
    assert.deepEqual(m.calls, [["reject_session_missing", "tool"]]);
  });

  test("tools-only: first tool malformed → 500, error/tool", async () => {
    const rec = recStore();
    rec.setToolResult("blk-0", { applied: false, reason: "malformed" });
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 7, status: "completed", text: "",
      tools: [tool({ blockId: "blk-0" })],
    })), res, CTX);
    assert.equal(resRec.status, 500);
    const parsed = JSON.parse(resRec.body) as { error: { code: string } };
    assert.equal(parsed.error.code, "ROW_MALFORMED");
    assert.deepEqual(m.calls, [["error", "tool"]]);
  });

  // ── Branch B: assistant + tools (with optional thinking) ─────────────

  test("both fields: thinking → tools → assistant write order (ts strictly increasing)", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 9, status: "completed",
      text: "answer", thinkingText: "reasoning", createdAt: 10_000,
      requestId: "req-12345abc",
      tools: [
        tool({ blockId: "blk-0", toolUseId: "tu-0", output: "out-0" }),
        tool({ blockId: "blk-1", toolUseId: "tu-1", output: "out-1" }),
      ],
    })), res, CTX);
    assert.equal(resRec.status, 200);
    // 4 storage rows: thinking, tool[0], tool[1], assistant.
    assert.equal(rec.rows.length, 4);
    assert.equal(rec.rows[0].role, "thinking");
    assert.equal(rec.rows[0].ts, 9_997, "thinkingTs = baseTs - toolsCount - 1 = 10000 - 2 - 1");
    assert.equal(rec.rows[1].role, "tool");
    assert.equal(rec.rows[1].ts, 9_998);
    assert.equal(rec.rows[1].blockId, "blk-0");
    assert.equal(rec.rows[2].role, "tool");
    assert.equal(rec.rows[2].ts, 9_999);
    assert.equal(rec.rows[2].blockId, "blk-1");
    assert.equal(rec.rows[3].role, "assistant");
    assert.equal(rec.rows[3].ts, 10_000);
    // ts strictly increasing
    for (let i = 1; i < rec.rows.length; i++) {
      assert.ok(rec.rows[i].ts > rec.rows[i - 1].ts, `row ${i} ts must be > prev`);
    }
    // metrics: thinking + per-tool + assistant
    assert.deepEqual(m.calls, [
      ["ok", "thinking"],
      ["ok", "tool"],
      ["ok", "tool"],
      ["ok", "assistant"],
    ]);
  });

  test("DEGRADE: assistant primary + tool storage_threw → 200 ok (tool best-effort, assistant decides)", async () => {
    const rec = recStore();
    rec.setToolThrow("blk-0", new Error("disk full"));
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 9, status: "completed",
      text: "answer", requestId: "req-12345abc",
      tools: [tool({ blockId: "blk-0" })],
    })), res, CTX);
    assert.equal(resRec.status, 200);
    // Assistant landed; tool threw before push → only assistant row.
    assert.equal(rec.rows.length, 1);
    assert.equal(rec.rows[0].role, "assistant");
    assert.deepEqual(m.calls, [["error", "tool"], ["ok", "assistant"]]);
  });

  test("assistant primary fails (storage_threw) but tool applied → 500 (assistant decides), tool metric still emitted", async () => {
    const rec = recStore();
    rec.setAssistantThrow(new Error("disk full"));
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 9, status: "completed",
      text: "answer", requestId: "req-12345abc",
      tools: [tool({ blockId: "blk-0" })],
    })), res, CTX);
    assert.equal(resRec.status, 500);
    // Tool row was attempted before assistant → it landed.
    assert.equal(rec.rows.length, 1);
    assert.equal(rec.rows[0].role, "tool");
    assert.deepEqual(m.calls, [["ok", "tool"], ["error", "assistant"]]);
  });

  test("assistant primary session_deleted with tools → 410, both per-tool and assistant metrics still emitted", async () => {
    const rec = recStore();
    rec.setAssistantResult({ applied: false, reason: "session_deleted" });
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 9, status: "completed",
      text: "answer", requestId: "req-12345abc",
      tools: [tool({ blockId: "blk-0" })],
    })), res, CTX);
    assert.equal(resRec.status, 410);
    assert.deepEqual(m.calls, [["ok", "tool"], ["reject_session_deleted", "assistant"]]);
  });

  test("isError=true on wire → error=true on stored row (rendering pill)", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 9, status: "completed", text: "",
      tools: [tool({ blockId: "blk-A", isError: true, output: "boom\n" })],
    })), res, CTX);
    assert.equal(resRec.status, 200);
    assert.equal(rec.rows[0].error, true);
    assert.deepEqual(m.calls, [["ok", "tool"]]);
  });

  test("inputTruncated/outputTruncated propagate only when true (avoid bloat on common case)", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 9, status: "completed", text: "",
      tools: [
        tool({ blockId: "blk-A", inputTruncated: false, outputTruncated: false }),
        tool({ blockId: "blk-B", inputTruncated: true, outputTruncated: true }),
      ],
    })), res, CTX);
    assert.equal(resRec.status, 200);
    // Spread guard: handler only sets the field when t.inputTruncated is true.
    assert.equal(rec.rows[0].inputTruncated, undefined);
    assert.equal(rec.rows[0].outputTruncated, undefined);
    assert.equal(rec.rows[1].inputTruncated, true);
    assert.equal(rec.rows[1].outputTruncated, true);
  });

  // ── Fix B: per-segment row id + tool arrivedAt ─────────────────────────
  //
  // Plan: docs/wip/fixb-per-segment-row-id-PLAN.md §3.5
  //
  // Wire shape: text → tool → text → tool → text within one turn emits
  //   assistantSegments=[{0,"a",T1},{1,"b",T3},{2,"c",T5}]  (3 segments)
  //   tools=[tool-x@arrivedAt=T2, tool-y@arrivedAt=T4]
  // Master writes ONE assistant row per segment (3 rows) + one tool row
  // per tool (2 rows); the LAST assistant segment carries usage/_truncated.

  test("oversized thinkingSegments degrades to thinkingText and preserves assistant", async () => {
    const rec = recStore();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345",
      agentId: "main",
      turnIndex: 11,
      status: "completed",
      text: "final answer",
      thinkingText: "aggregate thinking",
      thinkingSegments: segments(65),
    })), res, CTX);

    assert.equal(resRec.status, 200);
    const thinking = rec.rows.filter((row) => row.role === "thinking");
    const assistant = rec.rows.filter((row) => row.role === "assistant");
    assert.equal(thinking.length, 1);
    assert.equal(thinking[0].id, "srv-sess12345-main-t11-thinking");
    assert.equal(thinking[0].text, "aggregate thinking");
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0].text, "final answer");
  });

  test("oversized thinkingSegments without thinkingText still preserves assistant", async () => {
    const rec = recStore();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345",
      agentId: "main",
      turnIndex: 12,
      status: "completed",
      text: "final answer survives",
      thinkingSegments: segments(65),
    })), res, CTX);

    assert.equal(resRec.status, 200);
    assert.equal(rec.rows.filter((row) => row.role === "thinking").length, 0);
    const assistant = rec.rows.filter((row) => row.role === "assistant");
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0].text, "final answer survives");
  });

  test("oversized assistantSegments degrades to aggregate text", async () => {
    const rec = recStore();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345",
      agentId: "main",
      turnIndex: 13,
      status: "completed",
      text: "aggregate assistant",
      assistantSegments: segments(65),
    })), res, CTX);

    assert.equal(resRec.status, 200);
    const assistant = rec.rows.filter((row) => row.role === "assistant");
    assert.equal(assistant.length, 1);
    assert.equal(assistant[0].id, "srv-sess12345-main-t13");
    assert.equal(assistant[0].text, "aggregate assistant");
  });

  test("oversized thinking-only segments without a fallback remain rejected", async () => {
    const rec = recStore();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345",
      agentId: "main",
      turnIndex: 14,
      status: "completed",
      text: "",
      thinkingSegments: segments(65),
    })), res, CTX);

    assert.equal(resRec.status, 400);
    assert.equal(rec.rows.length, 0);
  });

  test("exactly 64 thinkingSegments keep the segmented persistence path", async () => {
    const rec = recStore();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345",
      agentId: "main",
      turnIndex: 15,
      status: "completed",
      text: "",
      thinkingSegments: segments(64),
    })), res, CTX);

    assert.equal(resRec.status, 200);
    const thinking = rec.rows.filter((row) => row.role === "thinking");
    assert.equal(thinking.length, 64);
    assert.equal(thinking[0].id, "srv-sess12345-main-t15-thinking-s0");
    assert.equal(thinking[63].id, "srv-sess12345-main-t15-thinking-s63");
  });

  test("oversized segment warnings expose metadata only", async () => {
    const warnings: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const logger: Logger = {
      trace() {},
      debug() {},
      info() {},
      warn(msg, fields) { warnings.push({ msg, fields }); },
      error() {},
      child() { return logger; },
    };
    const rec = recStore();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      logger,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345",
      agentId: "main",
      turnIndex: 16,
      status: "completed",
      text: "DO_NOT_LOG aggregate assistant",
      thinkingText: "DO_NOT_LOG aggregate thinking",
      assistantSegments: segments(65, "DO_NOT_LOG-assistant"),
      thinkingSegments: segments(65, "DO_NOT_LOG-thinking"),
    })), res, CTX);

    assert.equal(resRec.status, 200);
    assert.equal(warnings.length, 2);
    assert.deepEqual(
      warnings.map(({ msg, fields }) => ({ msg, fields })),
      [
        {
          msg: "oversized_segments_degraded",
          fields: { sessionId: "sess12345", field: "assistantSegments", count: 65, cap: 64 },
        },
        {
          msg: "oversized_segments_degraded",
          fields: { sessionId: "sess12345", field: "thinkingSegments", count: 65, cap: 64 },
        },
      ],
    );
    for (const warning of warnings) {
      assert.deepEqual(
        Object.keys(warning.fields ?? {}).sort(),
        ["cap", "count", "field", "sessionId"],
      );
    }
    assert.equal(JSON.stringify(warnings).includes("DO_NOT_LOG"), false);
  });

  test("Fix B: assistantSegments writes one assistant row per segment, last segment carries usage", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 5, status: "completed",
      // legacy `text` carries the concatenation for old-master fallback;
      // Fix-B master prefers `assistantSegments` and ignores `text` as a row.
      text: "first part second part third part",
      agentId: "main",
      requestId: "req-12345abc",
      usage: { inputTokens: 10, outputTokens: 100, turn: 5 },
      assistantSegments: [
        { index: 0, text: "first part ", ts: 1_000 },
        { index: 1, text: "second part ", ts: 3_000 },
        { index: 2, text: "third part", ts: 5_000 },
      ],
      tools: [
        tool({ blockId: "blk-x", toolUseId: "tu-x", arrivedAt: 2_000, output: "x" }),
        tool({ blockId: "blk-y", toolUseId: "tu-y", arrivedAt: 4_000, output: "y" }),
      ],
    })), res, CTX);
    assert.equal(resRec.status, 200, "primary write succeeds → 200");
    // 3 assistant + 2 tool rows = 5 rows total.
    const asst = rec.rows.filter((r) => r.role === "assistant");
    const tools = rec.rows.filter((r) => r.role === "tool");
    assert.equal(asst.length, 3, "one assistant row per segment");
    assert.equal(tools.length, 2, "one tool row per tool");
    // IDs per-segment.
    assert.equal(asst[0].id, "srv-sess12345-main-t5-s0");
    assert.equal(asst[1].id, "srv-sess12345-main-t5-s1");
    assert.equal(asst[2].id, "srv-sess12345-main-t5-s2");
    // Each segment's ts is its own wall-clock (interleaves with tools).
    assert.equal(asst[0].ts, 1_000);
    assert.equal(asst[1].ts, 3_000);
    assert.equal(asst[2].ts, 5_000);
    // Tool rows use arrivedAt (Fix B priority chain).
    assert.equal(tools[0].ts, 2_000);
    assert.equal(tools[1].ts, 4_000);
    // Segment text matches.
    assert.equal(asst[0].text, "first part ");
    assert.equal(asst[1].text, "second part ");
    assert.equal(asst[2].text, "third part");
    // Usage lives ONLY on the last segment.
    assert.equal(asst[0].usage, undefined, "first segment carries no usage");
    assert.equal(asst[1].usage, undefined, "middle segment carries no usage");
    assert.deepEqual(
      asst[2].usage,
      { inputTokens: 10, outputTokens: 100, turn: 5 },
      "last segment carries usage (refresh-recovery picks up costCredits patch here)",
    );
  });

  test("Fix B: _truncated / _errorCode / _errorDetail land only on the last assistant segment", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 5, status: "completed",
      text: "a b",
      agentId: "main",
      requestId: "req-12345abc",
      truncated: true,
      errorCode: "overloaded_error",
      errorDetail: "upstream returned 529",
      assistantSegments: [
        { index: 0, text: "a", ts: 1_000 },
        { index: 1, text: " b", ts: 3_000 },
      ],
    })), res, CTX);
    assert.equal(resRec.status, 200);
    const asst = rec.rows.filter((r) => r.role === "assistant");
    assert.equal(asst.length, 2);
    assert.equal(asst[0]._truncated, undefined);
    assert.equal(asst[0]._errorCode, undefined);
    assert.equal(asst[0]._errorDetail, undefined);
    assert.equal(asst[1]._truncated, true);
    assert.equal(asst[1]._errorCode, "overloaded_error");
    assert.equal(asst[1]._errorDetail, "upstream returned 529");
  });

  test("Fix B: thinkingSegments writes one thinking row per segment", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 7, status: "completed",
      text: "answer",
      agentId: "main",
      requestId: "req-12345abc",
      thinkingText: "part1 part2",  // legacy concat for old-master fallback
      thinkingSegments: [
        { index: 0, text: "part1 ", ts: 500 },
        { index: 1, text: "part2", ts: 1_500 },
      ],
    })), res, CTX);
    assert.equal(resRec.status, 200);
    const thinking = rec.rows.filter((r) => r.role === "thinking");
    assert.equal(thinking.length, 2);
    assert.equal(thinking[0].id, "srv-sess12345-main-t7-thinking-s0");
    assert.equal(thinking[1].id, "srv-sess12345-main-t7-thinking-s1");
    assert.equal(thinking[0].ts, 500);
    assert.equal(thinking[1].ts, 1_500);
  });

  test("Fix B: tool ts uses arrivedAt when present, falls back to offset when absent (pre-Fix-B gateway)", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 3, status: "completed",
      text: "", createdAt: 10_000,
      tools: [
        // Mix: one with arrivedAt (new gateway), one without (legacy entry from
        // pre-Fix-B retry queue drain). Master must use arrivedAt when given,
        // fall back to baseTs - N + i otherwise.
        tool({ blockId: "blk-fresh", arrivedAt: 7_500, output: "ok-fresh" }),
        tool({ blockId: "blk-legacy", output: "ok-legacy" }), // no arrivedAt
      ],
    })), res, CTX);
    assert.equal(resRec.status, 200);
    assert.equal(rec.rows.length, 2);
    // Order in rec.rows follows the iteration order of body.tools.
    assert.equal(rec.rows[0].blockId, "blk-fresh");
    assert.equal(rec.rows[0].ts, 7_500, "arrivedAt wins when present");
    assert.equal(rec.rows[1].blockId, "blk-legacy");
    // toolsCount=2, i=1 → 10000 - 2 + 1 = 9999
    assert.equal(rec.rows[1].ts, 9_999, "legacy entry uses computed offset");
  });

  test("Fix B: schema accepts assistantSegments + thinkingSegments and refine guard passes on segments-only turn", async () => {
    // A turn with only segments and no legacy text/thinkingText must still
    // satisfy the cross-field refine.
    const rec = recStore();
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 1, status: "completed",
      text: "",  // empty text
      agentId: "main",
      requestId: "req-12345abc",
      assistantSegments: [{ index: 0, text: "only seg", ts: 1_000 }],
    })), res, CTX);
    assert.equal(resRec.status, 200, "segments-only turn satisfies refine");
    const asst = rec.rows.filter((r) => r.role === "assistant");
    assert.equal(asst.length, 1);
    assert.equal(asst[0].id, "srv-sess12345-main-t1-s0");
  });

  test("Fix B: 410 on session_deleted with segments — last-segment outcome surfaces, no partial-row leakage", async () => {
    const rec = recStore();
    rec.setAssistantResult({ applied: false, reason: "session_deleted" });
    const m = captureMetricRich();
    const h = makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
    const { res, rec: resRec } = makeRes();
    await h(authed(JSON.stringify({
      sessionId: "sess12345", turnIndex: 5, status: "completed",
      text: "a b c", agentId: "main", requestId: "req-12345abc",
      assistantSegments: [
        { index: 0, text: "a", ts: 1_000 },
        { index: 1, text: " b", ts: 2_000 },
        { index: 2, text: " c", ts: 3_000 },
      ],
    })), res, CTX);
    // All segment writes get the same session_deleted (overrides are global
    // on recStore); HTTP outcome = last segment's = 410.
    assert.equal(resRec.status, 410);
    // Metrics for non-last segments emitted as best-effort + last one as primary.
    // 3 segments, each gets a reject_session_deleted metric (one per write).
    const sdCalls = m.calls.filter((c) => c[0] === "reject_session_deleted" && c[1] === "assistant");
    assert.equal(sdCalls.length, 3, "every assistant segment write emits its own metric");
  });
});

// ── P2 债A — agent-group (team card) durability ─────────────────────────────
describe("internalServerAuthored handler — agent-group durability (P2 债A)", () => {
  type Call = [V3SinkPersistOutcome, V3SinkPersistRole | undefined];
  function captureMetricRich(): { calls: Call[]; metric: (o: V3SinkPersistOutcome, r?: V3SinkPersistRole) => void } {
    const calls: Call[] = [];
    return { calls, metric: (o, r) => calls.push([o, r]) };
  }
  function authed(body: string) {
    return makeReq({ body, auth: `Bearer ${VALID_TOKEN}` });
  }
  function ag(over: Partial<{
    runId: string; agentId: string; goal: string;
    status: "ok" | "failed" | "timeout"; resultSummary: string; completedAt: number;
  }> = {}): Record<string, unknown> {
    return {
      runId: over.runId ?? "dlg-abc",
      agentId: over.agentId ?? "coding-assistant",
      goal: over.goal ?? "重构模块",
      status: over.status ?? "ok",
      completedAt: over.completedAt ?? 1720000000000,
      ...(over.resultSummary !== undefined ? { resultSummary: over.resultSummary } : {}),
    };
  }
  /** Recording storage capturing full agent-group display fields. */
  function recStore(): {
    storage: ServerAuthoredStorage;
    rows: Array<Record<string, unknown>>;
    setAgentGroupResult: (runId: string, r: Awaited<ReturnType<ServerAuthoredStorage["appendServerAuthoredMessage"]>>) => void;
    setAgentGroupThrow: (runId: string, e: Error) => void;
  } {
    const rows: Array<Record<string, unknown>> = [];
    const agOverrides = new Map<string, Awaited<ReturnType<ServerAuthoredStorage["appendServerAuthoredMessage"]>>>();
    const agThrowers = new Map<string, Error>();
    const store: ServerAuthoredStorage = {
      async appendServerAuthoredMessage(_s, _u, msg) {
        if (msg.role === "agent-group") {
          const rid = String(msg._delegateRunId ?? "");
          const t = agThrowers.get(rid);
          if (t) throw t;
        }
        rows.push({ ...(msg as unknown as Record<string, unknown>) });
        if (msg.role === "agent-group") {
          return agOverrides.get(String(msg._delegateRunId ?? "")) ?? { applied: true };
        }
        return { applied: true };
      },
      async appendServerAuthoredMessageForRequest(_r, s, u, msg) {
        const r = await store.appendServerAuthoredMessage(s, u, msg);
        return r.applied ? { applied: true } : { applied: false, reason: r.reason ?? "malformed" };
      },
      async appendServerAuthoredMessageDrainByUser(s, u, msg) {
        const r = await store.appendServerAuthoredMessage(s, u, msg);
        return r.applied ? { applied: true } : { applied: false, reason: r.reason ?? "malformed" };
      },
      async drainDelegateCostForClientSession() { return { merged: "0", drained: 0 }; },
    };
    return {
      storage: store,
      rows,
      setAgentGroupResult(rid, r) { agOverrides.set(rid, r); },
      setAgentGroupThrow(rid, e) { agThrowers.set(rid, e); },
    };
  }
  function handler(rec: ReturnType<typeof recStore>, m: ReturnType<typeof captureMetricRich>) {
    return makeServerAuthoredHandler({
      identityRepo: makeRepoFor(VALID_TOKEN, VALID_HOST, VALID_IP),
      storage: rec.storage,
      metric: m.metric,
    });
  }

  test("ok: writes an agent-group row with mapped display fields; assistant still decides HTTP 200", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const { res, rec: resRec } = makeRes();
    await handler(rec, m)(authed(JSON.stringify({
      sessionId: "sess12345", agentId: "main", turnIndex: 2, status: "completed",
      text: "队长总结", requestId: "req-12345abc",
      agentGroups: [ag({ runId: "dlg-1", agentId: "coding-assistant", goal: "重构", resultSummary: "完成", completedAt: 1720000000500 })],
    })), res, CTX);
    assert.equal(resRec.status, 200);
    const agr = rec.rows.find((r) => r.role === "agent-group");
    assert.ok(agr, "an agent-group row was written");
    assert.equal(agr!.id, "srv-sess12345-main-t2-agentgroup-dlg-1");
    assert.equal(agr!.ts, 1720000000500, "ts = completedAt (turn插序)");
    assert.equal(agr!._delegate, true);
    assert.equal(agr!._delegateRunId, "dlg-1", "runId → _delegateRunId (dedupe key)");
    assert.equal(agr!._delegateAgentId, "coding-assistant");
    assert.equal(agr!._delegateGoal, "重构");
    assert.equal(agr!.text, "重构", "text carries goal");
    assert.equal(agr!._delegateStatus, "ok");
    assert.equal(agr!._isError, false, "ok → _isError false");
    assert.equal(agr!._resultPreview, "完成");
    assert.equal(agr!._completed, true);
    // agent-group metric emitted; assistant metric also emitted (HTTP decider).
    assert.ok(m.calls.some((c) => c[0] === "ok" && c[1] === "agent-group"));
  });

  test("failed status → _isError true, _delegateStatus 'failed'", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const { res, rec: resRec } = makeRes();
    await handler(rec, m)(authed(JSON.stringify({
      sessionId: "sess12345", agentId: "main", turnIndex: 1, status: "completed",
      text: "总结", requestId: "req-12345abc",
      agentGroups: [ag({ runId: "dlg-f", status: "failed", resultSummary: "子任务报错" })],
    })), res, CTX);
    assert.equal(resRec.status, 200);
    const agr = rec.rows.find((r) => r.role === "agent-group")!;
    assert.equal(agr._delegateStatus, "failed");
    assert.equal(agr._isError, true);
    assert.equal(agr._resultPreview, "子任务报错");
  });

  test("timeout status → _isError true, _delegateStatus 'timeout' (distinguishable from failed)", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const { res, rec: resRec } = makeRes();
    await handler(rec, m)(authed(JSON.stringify({
      sessionId: "sess12345", agentId: "main", turnIndex: 1, status: "completed",
      text: "总结", requestId: "req-12345abc",
      agentGroups: [ag({ runId: "dlg-t", status: "timeout", resultSummary: "超时" })],
    })), res, CTX);
    assert.equal(resRec.status, 200);
    const agr = rec.rows.find((r) => r.role === "agent-group")!;
    assert.equal(agr._delegateStatus, "timeout");
    assert.equal(agr._isError, true);
  });

  test("agentGroups-only turn (crash flush: no assistant/thinking/tools) persists + 200", async () => {
    // Leader crashed right after delegating; refine + Branch A must accept it.
    const rec = recStore();
    const m = captureMetricRich();
    const { res, rec: resRec } = makeRes();
    await handler(rec, m)(authed(JSON.stringify({
      sessionId: "sess12345", agentId: "main", turnIndex: 3, status: "crashed",
      text: "",
      agentGroups: [ag({ runId: "dlg-only", completedAt: 1720000009000 })],
    })), res, CTX);
    assert.equal(resRec.status, 200, "first agent-group outcome decides HTTP");
    const agr = rec.rows.find((r) => r.role === "agent-group")!;
    assert.equal(agr.id, "srv-sess12345-main-t3-agentgroup-dlg-only");
    assert.ok(m.calls.some((c) => c[0] === "ok" && c[1] === "agent-group"));
  });

  test("multiple delegations → one agent-group row each, ts = each completedAt", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const { res, rec: resRec } = makeRes();
    await handler(rec, m)(authed(JSON.stringify({
      sessionId: "sess12345", agentId: "main", turnIndex: 1, status: "completed",
      text: "总结", requestId: "req-12345abc",
      agentGroups: [
        ag({ runId: "dlg-a", completedAt: 1720000001000 }),
        ag({ runId: "dlg-b", status: "failed", completedAt: 1720000002000 }),
      ],
    })), res, CTX);
    assert.equal(resRec.status, 200);
    const agRows = rec.rows.filter((r) => r.role === "agent-group");
    assert.equal(agRows.length, 2);
    assert.deepEqual(agRows.map((r) => r.ts).sort(), [1720000001000, 1720000002000]);
  });

  test("agentGroups is best-effort under assistant path: a thrown agent-group write doesn't change HTTP 200", async () => {
    const rec = recStore();
    rec.setAgentGroupThrow("dlg-x", new Error("storage boom"));
    const m = captureMetricRich();
    const { res, rec: resRec } = makeRes();
    await handler(rec, m)(authed(JSON.stringify({
      sessionId: "sess12345", agentId: "main", turnIndex: 1, status: "completed",
      text: "队长答案", requestId: "req-12345abc",
      agentGroups: [ag({ runId: "dlg-x" })],
    })), res, CTX);
    assert.equal(resRec.status, 200, "assistant write is authoritative; agent-group throw is best-effort");
    assert.ok(m.calls.some((c) => c[0] === "error" && c[1] === "agent-group"));
  });

  test("schema rejects unknown field in an agentGroups entry (.strict())", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const { res, rec: resRec } = makeRes();
    const bad = { ...ag(), wat: "nope" };
    await handler(rec, m)(authed(JSON.stringify({
      sessionId: "sess12345", agentId: "main", turnIndex: 1, status: "completed",
      text: "answer", requestId: "req-12345abc", agentGroups: [bad],
    })), res, CTX);
    assert.equal(resRec.status, 400);
    assert.equal(rec.rows.length, 0);
  });

  test("schema rejects invalid agentGroups status enum", async () => {
    const rec = recStore();
    const m = captureMetricRich();
    const { res, rec: resRec } = makeRes();
    await handler(rec, m)(authed(JSON.stringify({
      sessionId: "sess12345", agentId: "main", turnIndex: 1, status: "completed",
      text: "answer", requestId: "req-12345abc",
      agentGroups: [{ ...ag(), status: "cancelled" }],
    })), res, CTX);
    assert.equal(resRec.status, 400);
  });
})
