/**
 * Unit tests for POST /internal/v3/cron-index.
 * Run: npx tsx --test packages/commercial/src/__tests__/internalCronIndex.test.ts
 */

import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, test } from "node:test";

import { hashSecret, type ContainerIdentityRepo } from "../auth/containerIdentity.js";
import type { CronWakeRunner } from "../agent-sandbox/cronWake.js";
import {
  CRON_INDEX_PATH,
  makeCronIndexHandler,
} from "../http/internalCronIndex.js";

const SECRET = "a".repeat(64);
const TOKEN = `oc-v3.7.${SECRET}`;
const CTX = { hostUuid: "host-1", boundIp: "172.31.0.7" };

function repoFor(userId = 42): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid, boundIp) {
      if (hostUuid !== CTX.hostUuid || boundIp !== CTX.boundIp) return null;
      return { id: 7, user_id: userId, bound_ip: boundIp, host_uuid: hostUuid, secret_hash: hashSecret(SECRET) };
    },
  };
}

function makeReq(opts: { method?: string; auth?: string; body?: unknown }): IncomingMessage {
  const raw = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as unknown as IncomingMessage;
  req.method = opts.method ?? "POST";
  req.url = CRON_INDEX_PATH;
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

function captureRunner() {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  const runner: CronWakeRunner = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 } as any;
    },
  };
  return { runner, calls };
}

describe("cron-index handler", () => {
  test("rejects non-POST and missing bearer", async () => {
    const { runner } = captureRunner();
    const h = makeCronIndexHandler({ identityRepo: repoFor(), runner });

    let res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}`, method: "GET", body: {} }), res, CTX);
    assert.equal(res.statusCode, 405);

    res = makeRes();
    await h(makeReq({ body: { nextFireAt: null, enabledCount: 0 } }), res, CTX);
    assert.equal(res.statusCode, 401);
  });

  test("valid body upserts parsed Date + enabledCount", async () => {
    const { runner, calls } = captureRunner();
    const h = makeCronIndexHandler({ identityRepo: repoFor(99), runner });
    const res = makeRes();
    await h(
      makeReq({ auth: `Bearer ${TOKEN}`, body: { nextFireAt: "2026-07-07T12:00:00.000Z", enabledCount: 3 } }),
      res,
      CTX,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /INSERT INTO cron_wake_index/);
    assert.equal(calls[0].params?.[0], "99"); // uid from identity, not body
    assert.ok(["v3", "v5"].includes(calls[0].params?.[1] as string));
    assert.equal(calls[0].params?.[2], "2026-07-07T12:00:00.000Z");
    assert.equal(calls[0].params?.[3], 3);
  });

  test("null nextFireAt upserts NULL", async () => {
    const { runner, calls } = captureRunner();
    const h = makeCronIndexHandler({ identityRepo: repoFor(), runner });
    const res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: { nextFireAt: null, enabledCount: 0 } }), res, CTX);
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0].params?.[2], null);
    assert.equal(calls[0].params?.[3], 0);
  });

  test("invalid nextFireAt / enabledCount / extra field → 400 (no upsert)", async () => {
    const { runner, calls } = captureRunner();
    const h = makeCronIndexHandler({ identityRepo: repoFor(), runner });

    for (const bad of [
      { nextFireAt: "not-a-date", enabledCount: 1 },
      { nextFireAt: null, enabledCount: -1 },
      { nextFireAt: null, enabledCount: 1.5 },
      { nextFireAt: null, enabledCount: 1, extra: true },
      { enabledCount: 1 }, // missing nextFireAt
    ]) {
      const res = makeRes();
      await h(makeReq({ auth: `Bearer ${TOKEN}`, body: bad }), res, CTX);
      assert.equal(res.statusCode, 400, JSON.stringify(bad));
    }
    assert.equal(calls.length, 0);
  });

  test("upsert failure → 500", async () => {
    const runner: CronWakeRunner = {
      async query() {
        throw new Error("pg down");
      },
    };
    const h = makeCronIndexHandler({ identityRepo: repoFor(), runner });
    const res = makeRes();
    await h(makeReq({ auth: `Bearer ${TOKEN}`, body: { nextFireAt: null, enabledCount: 0 } }), res, CTX);
    assert.equal(res.statusCode, 500);
  });
});
