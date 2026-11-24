import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, test } from "node:test";

import {
  hashSecret,
} from "../auth/containerIdentity.js";
import {
  insertTurnObservation,
  makeTurnObservationHandler,
  type TurnObservationBody,
  type TurnObservationDeps,
} from "../http/internalTurnObservation.js";

const TEST_SECRET = "a".repeat(64);
const TEST_AUTH_HEADER = `Bearer oc-v3.7.${TEST_SECRET}`;

function makeReq(method: string, body: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & {
    method: string;
    headers: Record<string, string>;
    [Symbol.asyncIterator](): AsyncIterator<Buffer>;
  };
  req.method = method;
  req.headers = { authorization: TEST_AUTH_HEADER };
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  req[Symbol.asyncIterator] = async function* () {
    yield raw;
  };
  return req;
}

function makeRes() {
  let status = 200;
  let body = "";
  const headers = new Map<string, string>();
  const res = {
    get statusCode() { return status; },
    set statusCode(v: number) { status = v; },
    setHeader(k: string, v: string) { headers.set(k.toLowerCase(), String(v)); },
    getHeader(k: string) { return headers.get(k.toLowerCase()); },
    end(chunk?: string) { if (chunk) body += chunk; },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    json() { return JSON.parse(body) as Record<string, unknown>; },
  };
}

function makeDeps(queries: Array<{ sql: string; params?: readonly unknown[] }>, inserted = true): TurnObservationDeps {
  return {
    identityRepo: {
      findActiveByHostAndBoundIp: async () => ({
        id: 7,
        user_id: 42,
        host_uuid: "host-1",
        bound_ip: "127.0.0.1",
        secret_hash: hashSecret(TEST_SECRET),
      }),
    },
    queryRunner: {
      async query<Row>(sql: string, params?: readonly unknown[]) {
        queries.push({ sql, params });
        if (sql.includes("turn_runtime_observations")) {
          return { rows: [{ inserted }] as Row[], rowCount: 1 };
        }
        return { rows: [] as Row[], rowCount: 1 };
      },
    },
    now: () => 1_780_000_000_000,
  };
}

describe("internalTurnObservation contextEvents extension", () => {
  test("accepts TurnObservationBody with valid contextEvents and writes context_eval_events even on duplicate turn", async () => {
    const queries: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const deps = makeDeps(queries, false);
    const body: TurnObservationBody = {
      schemaVersion: 1,
      eventId: "turn-dup-1",
      sessionKey: "agent:main:webchat:dm:s1",
      agentId: "main",
      traceId: "a".repeat(32),
      model: "gpt-5.6-sol",
      durationMs: 400,
      toolCalls: 2,
      timestamp: 1_780_000_000_000,
      contextEvents: [
        {
          eventId: "ctx-1",
          eventKind: "prompt_context_decision",
          engine: "antigravity",
          decision: "elide_resumed",
          reason: "elided",
          changedSlots: ["SOUL"],
          staticPrefixSha256: "b".repeat(64),
          totalBytes: 8000,
          tokensEstimate: 2000,
          observedAt: 1_780_000_000_000,
        },
        {
          eventId: "ctx-2",
          eventKind: "context_compacted",
          compactionScope: "launch_prompt",
          compactionStrategy: "history_suffix",
          beforeBytes: 150000,
          afterBytes: 80000,
          droppedEntries: 3,
          observedAt: 1_780_000_000_000,
        },
      ],
    };

    const res = await insertTurnObservation(deps, 42, 7, body);
    assert.deepEqual(res, { duplicate: true });
    assert.equal(queries.length, 4);
    assert.match(queries[1]!.sql, /INSERT INTO context_eval_events/);
    assert.match(queries[1]!.sql, /ON CONFLICT \(event_id\) DO UPDATE/);
    assert.equal(queries[1]!.params?.[0], "ctx-1");
    assert.deepEqual(queries[1]!.params?.[19], ["SOUL"]);
    assert.equal(queries[2]!.params?.[0], "ctx-2");
    assert.equal(queries[2]!.params?.[11], "history_suffix");
    assert.match(queries[3]!.sql, /UPDATE context_eval_events cee/);
  });

  test("contextOnly=true writes only context_eval_events and never touches turn_runtime_observations or turn_traces", async () => {
    const queries: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const deps = makeDeps(queries, true);
    const now = 1_780_000_000_000;
    const commitSha = "9".repeat(40);
    const res = await insertTurnObservation(deps, 42, 7, {
      schemaVersion: 1,
      eventId: "ctx-batch-1",
      sessionKey: "agent:main:webchat:dm:s1",
      agentId: "main",
      traceId: "a".repeat(32),
      durationMs: 0,
      toolCalls: 0,
      runtimeSourceCommit: commitSha,
      timestamp: now,
      contextOnly: true,
      contextEvents: [
        {
          eventId: "ctx-only-ev-1",
          eventKind: "context_compacted",
          compactionScope: "session",
          compactionStrategy: "checkpoint_reset",
          beforeTokens: 120000,
          afterTokens: 8000,
          observedAt: now,
        },
      ],
    });
    assert.deepEqual(res, { duplicate: false });
    assert.equal(queries.length, 1);
    assert.match(queries[0]!.sql, /INSERT INTO context_eval_events/);
    assert.doesNotMatch(queries[0]!.sql, /turn_runtime_observations/);
    assert.equal(queries[0]!.params?.[24], commitSha);
  });

  test("HTTP handler accepts valid contextEvents and rejects >16 events, >32 changedSlots, or negative counts with 400", async () => {
    const now = 1_780_000_000_000;
    const base = {
      schemaVersion: 1,
      eventId: "turn-http-1",
      sessionKey: "agent:main:webchat:dm:s1",
      agentId: "main",
      traceId: "c".repeat(32),
      durationMs: 100,
      toolCalls: 0,
      timestamp: now,
    };

    // Valid payload with contextEvents
    const okQueries: Array<{ sql: string; params?: readonly unknown[] }> = [];
    const okDeps = makeDeps(okQueries, true);
    const handler = makeTurnObservationHandler(okDeps);
    const okRes = makeRes();
    await handler(
      makeReq("POST", {
        ...base,
        contextEvents: [
          {
            eventId: "ctx-http-1",
            eventKind: "prompt_context_decision",
            decision: "full_inject",
            reason: "inputs_changed",
            changedSlots: ["SOUL", "TOOLS"],
            observedAt: now,
          },
        ],
      }),
      okRes.res,
      { hostUuid: "host-1", boundIp: "127.0.0.1" },
    );
    assert.equal(okRes.status, 200);
    assert.equal(okRes.json().ok, true);
    assert.equal(okQueries.length, 3);

    // Oversized body (>64 KiB) returns HTTP 413 PAYLOAD_TOO_LARGE (distinct from 400 INVALID_BODY)
    const oversizedRes = makeRes();
    const bigReq = new EventEmitter() as IncomingMessage & {
      method: string;
      headers: Record<string, string>;
      [Symbol.asyncIterator](): AsyncIterator<Buffer>;
    };
    bigReq.method = "POST";
    bigReq.headers = { authorization: TEST_AUTH_HEADER };
    const bigBuf = Buffer.alloc(65 * 1024, "a");
    bigReq[Symbol.asyncIterator] = async function* () { yield bigBuf; };
    await handler(bigReq, oversizedRes.res, { hostUuid: "host-1", boundIp: "127.0.0.1" });
    assert.equal(oversizedRes.status, 413);
    assert.equal((oversizedRes.json().error as { code?: string }).code, "PAYLOAD_TOO_LARGE");

    // >16 contextEvents -> 400
    const tooManyRes = makeRes();
    await handler(
      makeReq("POST", {
        ...base,
        contextEvents: Array.from({ length: 17 }, (_, i) => ({
          eventId: `ctx-over-${i}`,
          eventKind: "prompt_context_decision",
          observedAt: now,
        })),
      }),
      tooManyRes.res,
      { hostUuid: "host-1", boundIp: "127.0.0.1" },
    );
    assert.equal(tooManyRes.status, 400);

    // >32 changedSlots -> 400
    const tooManySlotsRes = makeRes();
    await handler(
      makeReq("POST", {
        ...base,
        contextEvents: [
          {
            eventId: "ctx-slots-over",
            eventKind: "prompt_context_decision",
            changedSlots: Array.from({ length: 33 }, (_, i) => `SLOT_${i}`),
            observedAt: now,
          },
        ],
      }),
      tooManySlotsRes.res,
      { hostUuid: "host-1", boundIp: "127.0.0.1" },
    );
    assert.equal(tooManySlotsRes.status, 400);

    // Negative beforeBytes -> 400
    const negRes = makeRes();
    await handler(
      makeReq("POST", {
        ...base,
        contextEvents: [
          {
            eventId: "ctx-neg",
            eventKind: "context_compacted",
            beforeBytes: -1,
            observedAt: now,
          },
        ],
      }),
      negRes.res,
      { hostUuid: "host-1", boundIp: "127.0.0.1" },
    );
    assert.equal(negRes.status, 400);

    // Legacy payload without contextEvents still returns 200
    const legacyRes = makeRes();
    await handler(makeReq("POST", base), legacyRes.res, { hostUuid: "host-1", boundIp: "127.0.0.1" });
    assert.equal(legacyRes.status, 200);
  });
});
