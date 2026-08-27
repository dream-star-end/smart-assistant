/**
 * Origin-session cron must stamp the conversation model, not the process default.
 * Run: npx tsx --test packages/commercial/src/__tests__/cronOriginAdmitModel.test.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AdmitUserTurnInput, AdmitUserTurnResult } from "../db/pgSessionsBackend.js";
import {
  createUserChatBridge,
  resolveCronOriginAdmitModel,
  type CronOriginExecutor,
} from "../ws/userChatBridge.js";

describe("resolveCronOriginAdmitModel", () => {
  test("keeps a grok-build origin session on grok-build", () => {
    assert.equal(resolveCronOriginAdmitModel("grok-build"), "grok-build");
  });

  test("trims whitespace", () => {
    assert.equal(resolveCronOriginAdmitModel("  glm-5.3-zai  "), "glm-5.3-zai");
  });

  test("falls back when the session has no model", () => {
    assert.equal(resolveCronOriginAdmitModel(null), null);
    assert.equal(resolveCronOriginAdmitModel(undefined), null);
    assert.equal(resolveCronOriginAdmitModel(""), null);
    assert.equal(resolveCronOriginAdmitModel("   "), null);
  });

  test("rejects values that cannot be a dispatch model", () => {
    assert.equal(resolveCronOriginAdmitModel("bad model"), null);
    assert.equal(resolveCronOriginAdmitModel("a".repeat(65)), null);
    assert.equal(resolveCronOriginAdmitModel("glm/5.3"), null);
  });
});

function fakeAdmitted(input: AdmitUserTurnInput): AdmitUserTurnResult {
  const now = new Date();
  return {
    kind: "admitted",
    workspaceMode: "legacy",
    takeover: false,
    dispatch: {
      dispatchId: input.dispatchId,
      userId: input.uid,
      sessionId: input.sessionId,
      clientMessageId: input.clientMessageId,
      agentId: input.agentId,
      model: input.model,
      requestHash: input.requestHash,
      billingRequestId: input.billingRequestId,
      attemptNo: 1,
      status: "admitted",
      outcome: null,
      failureCode: null,
      conflictReason: null,
      resolution: null,
      resolvedAt: null,
      clientNotified: false,
      ownerId: input.ownerId,
      leaseEpoch: 1,
      leaseUntil: new Date(now.getTime() + 90_000),
      anchorSeq: 5n,
      admittedAt: now,
      acceptedAt: null,
      terminalAt: null,
      lastAttemptAt: now,
    },
  };
}

describe("injectCronOriginTurn stamps admit + inbound.model", () => {
  const uid = 3n;
  const input = {
    uid,
    sessionId: "webmtbs84bpm104yg",
    text: "⏰ 定时续跑\n核验",
    clientMessageId: "cron-origin-cron240ccc",
    agentId: "main",
  };

  function setup(opts: {
    queryImpl: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ model_id: string | null }> }>;
  }) {
    const admits: AdmitUserTurnInput[] = [];
    const frames: Array<{ type?: string; model?: string }> = [];
    const executor: CronOriginExecutor = ({ encoded }) => {
      frames.push(JSON.parse(encoded.toString("utf8")) as { type?: string; model?: string });
    };
    const pgPool = {
      query: async (sql: string, params: unknown[]) => opts.queryImpl(sql, params),
    };
    const bridge = createUserChatBridge({
      jwtSecret: "x".repeat(32),
      resolveContainerEndpoint: async () => ({ host: "127.0.0.1", port: 9 }),
      heartbeatIntervalMs: 0,
      pgPool: pgPool as never,
      preCheckRedis: {
        async atomicReserve() {
          return { ok: true as const, locked: 0n, needed: 0n };
        },
        async releaseReservation() {
          return true;
        },
      } as never,
      pricing: { get() { return null; } } as never,
      admitUserTurn: async (admitInput) => {
        admits.push(admitInput);
        return fakeAdmitted(admitInput);
      },
    });
    bridge._testRegisterCronOriginExecutor(uid.toString(), executor);
    return { bridge, admits, frames };
  }

  test("grok-build session stamps admitUserTurn.model and inbound.message.model", async () => {
    const { bridge, admits, frames } = setup({
      queryImpl: async (sql, params) => {
        assert.match(sql, /client_sessions/);
        assert.equal(params[0], input.sessionId);
        assert.equal(params[1], "c:3");
        return { rows: [{ model_id: "grok-build" }] };
      },
    });
    const result = await bridge.injectCronOriginTurn(input);
    assert.equal(result.kind, "injected");
    assert.equal(admits.length, 1);
    assert.equal(admits[0]!.model, "grok-build");
    assert.equal((admits[0]!.message as { _routing?: { model?: string } })._routing?.model, "grok-build");
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.type, "inbound.message");
    assert.equal(frames[0]!.model, "grok-build");
    await bridge.shutdown();
  });

  test("lookup failure falls back to model:null and still injects", async () => {
    const { bridge, admits, frames } = setup({
      queryImpl: async () => {
        throw new Error("pg down");
      },
    });
    const result = await bridge.injectCronOriginTurn(input);
    assert.equal(result.kind, "injected");
    assert.equal(admits.length, 1);
    assert.equal(admits[0]!.model, null);
    assert.equal(frames.length, 1);
    assert.equal(frames[0]!.type, "inbound.message");
    assert.equal(frames[0]!.model, undefined);
    await bridge.shutdown();
  });
});
