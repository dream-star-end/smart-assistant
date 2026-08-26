/**
 * Unit tests for POST /internal/v3/cron-origin-inject.
 * Run: npx tsx --test packages/commercial/src/__tests__/internalCronOriginInject.test.ts
 */

import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, test } from "node:test";

import { hashSecret, type ContainerIdentityRepo } from "../auth/containerIdentity.js";
import {
  CRON_ORIGIN_INJECT_PATH,
  makeCronOriginInjectHandler,
} from "../http/internalCronOriginInject.js";
import type { CronOriginInjectResult } from "../ws/userChatBridge.js";

const SECRET = "a".repeat(64);
const TOKEN = `oc-v3.7.${SECRET}`;
const CTX = { hostUuid: "host-1", boundIp: "172.31.0.7" };

function repoFor(userId = 3): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid, boundIp) {
      if (hostUuid !== CTX.hostUuid || boundIp !== CTX.boundIp) return null;
      return {
        id: 7,
        user_id: userId,
        bound_ip: boundIp,
        host_uuid: hostUuid,
        secret_hash: hashSecret(SECRET),
      };
    },
  };
}

function makeReq(opts: { method?: string; auth?: string; body?: unknown }): IncomingMessage {
  const raw = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage;
  req.method = opts.method ?? "POST";
  req.url = CRON_ORIGIN_INJECT_PATH;
  req.headers = {};
  if (opts.auth) req.headers.authorization = opts.auth;
  return req;
}

function makeRes(): ServerResponse & { body: any } {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string | number>,
    setHeader(k: string, v: string | number) {
      this.headers[k.toLowerCase()] = v;
    },
    end(s?: string) {
      (this as any).body = s ? JSON.parse(s) : {};
    },
  };
  return res as unknown as ServerResponse & { body: any };
}

const VALID_BODY = {
  sessionId: "webmt4irxnsr3brv0",
  text: "⏰ 定时续跑\n\n核验发布\n",
  clientMessageId: "cron-origin-cron240ccc",
  agentId: "main",
};

describe("cron-origin-inject handler", () => {
  test("rejects non-POST, missing bearer, and body.userId", async () => {
    const h = makeCronOriginInjectHandler({
      identityRepo: repoFor(),
      inject: async () => ({ kind: "injected" }),
    });

    let res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}`, method: "GET", body: VALID_BODY }), res, CTX);
    assert.equal(res.statusCode, 405);

    res = makeRes();
    await h(makeReq({ body: VALID_BODY }), res, CTX);
    assert.equal(res.statusCode, 401);

    res = makeRes();
    await h(
      makeReq({ auth: `Bearer ${TOKEN}`, body: { ...VALID_BODY, userId: "3" } }),
      res,
      CTX,
    );
    assert.equal(res.statusCode, 400);
  });

  test("maps inject results and stamps uid from bearer", async () => {
    const calls: Array<{ uid: string; sessionId: string }> = [];
    const sequence: CronOriginInjectResult[] = [
      { kind: "injected" },
      { kind: "gone" },
      { kind: "in_flight" },
      { kind: "no_transport" },
    ];
    const h = makeCronOriginInjectHandler({
      identityRepo: repoFor(3),
      inject: async (input) => {
        calls.push({ uid: input.uid.toString(), sessionId: input.sessionId });
        return sequence.shift() ?? { kind: "injected" };
      },
    });

    let res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: VALID_BODY }), res, CTX);
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0]?.uid, "3");
    assert.equal(calls[0]?.sessionId, VALID_BODY.sessionId);

    res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: VALID_BODY }), res, CTX);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body?.error?.code, "SESSION_GONE");

    res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: VALID_BODY }), res, CTX);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body?.error?.code, "TURN_IN_FLIGHT");

    res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: VALID_BODY }), res, CTX);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body?.error?.code, "NO_TRANSPORT");
  });
});
