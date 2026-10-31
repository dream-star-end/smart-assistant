import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { Pool } from "pg";

import { InMemoryPreCheckRedis } from "../billing/preCheck.js";
import { PricingCache } from "../billing/pricing.js";
import {
  __resetOpenTurnKeyMemory,
  attributeOpenTurn,
  costBroadcastParentSessionId,
  decideOpenTurnAttribution,
  delegateOpenTurnCtx,
  journalTurnKey,
  labelRoundFromOpenTurns,
  LOOKUP_SINGLE_OPEN_TURN_SQL,
  rememberOpenTurnKey,
  REMEMBER_OPEN_TURN_KEY_SQL,
  visionOpenTurnCtx,
  type OpenDispatchRow,
} from "../billing/openTurnAttribution.js";
import {
  __resetGrokVisionRateState,
  makeGrokRunner,
} from "../grok/visionProxy.js";
import {
  PUBLIC_VISION_AUTHZ,
  grokVisionSnapshot,
  grokVisionUpstreamPayload,
} from "./helpers/grokVisionFixtures.js";
import {
  createDelegateEngineBillingRuntime,
} from "../billing/delegateEngineBillingRuntime.js";
import { DELEGATE_ENGINE_BILLING_ADMIT_PATH } from "../http/internalDelegateEngineBilling.js";
import {
  CAPABILITY_SCHEMA_VERSION,
  ModelCatalogSnapshot,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
} from "../billing/modelCatalog.js";
import type { UserModelAuthz } from "../auth/userModelAuthz.js";

const TAPE = "7d4dc1149dff0a3c5ba4de4b68902d0d969e26974de2a26261a83554549ed004";
const SESSION = "webmvw6m0841sy727";
const DISPATCH = "2f2dbbdd-f8bd-4371-b3d5-80d290069442";
const TOOLS = [7n, 9n, 8n, 11n] as const;

function hit(over: Partial<OpenDispatchRow> = {}): OpenDispatchRow {
  return {
    dispatchId: DISPATCH,
    attemptNo: 1,
    sessionId: SESSION,
    turnKey: TAPE,
    ...over,
  };
}

describe("decideOpenTurnAttribution", () => {
  it("attributes exactly one keyed open turn", () => {
    const decision = decideOpenTurnAttribution([hit()]);
    assert.equal(decision.kind, "one");
    if (decision.kind !== "one") return;
    assert.deepEqual(decision.turn, {
      dispatchId: DISPATCH,
      attemptNo: 1,
      sessionId: SESSION,
      turnKey: TAPE,
    });
  });

  it("does not guess when there is no open turn", () => {
    assert.deepEqual(decideOpenTurnAttribution([]), { kind: "none", count: 0 });
  });

  it("does not guess when several open turns are visible", () => {
    const decision = decideOpenTurnAttribution([
      hit(),
      hit({ dispatchId: "11111111-1111-4111-8111-111111111111", turnKey: "a".repeat(64) }),
    ]);
    assert.deepEqual(decision, { kind: "many", count: 2 });
  });

  it("does not guess when the only open turn has no turn key", () => {
    assert.deepEqual(decideOpenTurnAttribution([hit({ turnKey: null })]), { kind: "unkeyed", count: 1 });
  });
});

describe("OCV5-704 replay: the round labels 132", () => {
  it("one open turn labels model 97 plus vision 7+9+8+11", () => {
    const round = labelRoundFromOpenTurns({
      openTurns: [hit()],
      modelCredits: 97n,
      toolCharges: TOOLS,
    });
    assert.equal(round.kind, "one");
    assert.equal(round.attributed, 35n);
    assert.equal(round.label, 132n);
    assert.equal(round.ledger, 132n);
  });

  it("zero or several open turns keep the label at 97 while the ledger stays 132", () => {
    for (const openTurns of [
      [],
      [hit(), hit({ dispatchId: "22222222-2222-4222-8222-222222222222" })],
      [hit({ turnKey: null })],
    ]) {
      const round = labelRoundFromOpenTurns({
        openTurns,
        modelCredits: 97n,
        toolCharges: TOOLS,
      });
      assert.equal(round.label, 97n);
      assert.equal(round.ledger, 132n);
      assert.notEqual(round.kind, "one");
    }
  });
});

describe("journal stamp", () => {
  it("vision keeps the charge in chat mode and only carries the client session for display", () => {
    const ctx = visionOpenTurnCtx({
      dispatchId: DISPATCH,
      attemptNo: 1,
      turnKey: TAPE,
      chatSessionId: SESSION,
    });
    assert.equal(ctx.turnKey, TAPE);
    assert.equal(ctx.chatSessionId, SESSION);
    assert.equal("parentSessionId" in ctx, false);
    assert.deepEqual(visionOpenTurnCtx({ openTurnAttribution: "none" }), {
      openTurnAttribution: "none",
    });
    assert.deepEqual(visionOpenTurnCtx(null), {});
  });

  it("delegate fills a missing parent turn and leaves a supplied parent turn alone", () => {
    const filled = delegateOpenTurnCtx({
      stamp: {
        dispatchId: DISPATCH,
        attemptNo: 4,
        turnKey: TAPE,
        chatSessionId: SESSION,
      },
    });
    assert.equal(filled.parentTurnKey, TAPE);
    assert.equal(filled.parentSessionId, SESSION);
    const supplied = delegateOpenTurnCtx({
      parentSessionId: "web-parent",
      parentTurnKey: "c".repeat(64),
      stamp: { openTurnAttribution: "many" },
    });
    assert.deepEqual(supplied, { parentSessionId: "web-parent", parentTurnKey: "c".repeat(64) });
    assert.equal(
      delegateOpenTurnCtx({ parentSessionId: "web-parent", stamp: { openTurnAttribution: "none" } })
        .openTurnAttribution,
      "none",
    );
  });

  it("fills turn key from the journal and does not treat chatSessionId as a billing parent", () => {
    assert.equal(journalTurnKey(null, TAPE), TAPE);
    assert.equal(journalTurnKey("ab", TAPE), TAPE);
    assert.equal(journalTurnKey(null, "nope"), null);
    assert.equal(costBroadcastParentSessionId(null, SESSION), SESSION);
    assert.equal(costBroadcastParentSessionId("web-parent", SESSION), "web-parent");
  });
});

describe("attributeOpenTurn", () => {
  function pool(rows: unknown[], fail = false): Pick<Pool, "query"> {
    return {
      async query(sql: string) {
        assert.match(String(sql), /turn_dispatches/);
        assert.equal(/\b(INSERT|UPDATE|DELETE)\b/i.test(String(sql)), false);
        if (fail) throw new Error("db down");
        return { rows } as never;
      },
    } as unknown as Pick<Pool, "query">;
  }

  it("logs none and many and does not stamp a failed lookup", async () => {
    const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const log = { warn(msg: string, fields?: Record<string, unknown>) { logs.push({ msg, fields }); } };
    assert.deepEqual(
      await attributeOpenTurn(pool([]), { userId: 1618n, containerId: 1524n }, log),
      { openTurnAttribution: "none" },
    );
    assert.deepEqual(
      await attributeOpenTurn(
        pool([
          { dispatch_id: DISPATCH, attempt_no: 1, session_id: SESSION, turn_key: TAPE },
          { dispatch_id: DISPATCH, attempt_no: 2, session_id: SESSION, turn_key: "b".repeat(64) },
        ]),
        { userId: 1618n, containerId: 1524n },
        log,
      ),
      { openTurnAttribution: "many" },
    );
    assert.equal(
      await attributeOpenTurn(pool([], true), { userId: 1618n, containerId: 1524n }, log),
      null,
    );
    assert.deepEqual(logs.map((line) => line.fields?.kind), ["none", "many", "lookup_failed"]);
    assert.match(LOOKUP_SINGLE_OPEN_TURN_SQL, /LIMIT 2/);
  });

  it("returns the single open turn", async () => {
    const stamp = await attributeOpenTurn(
      pool([{ dispatch_id: DISPATCH, attempt_no: "1", session_id: SESSION, turn_key: TAPE }]),
      { userId: 1618n, containerId: 1524n },
    );
    assert.deepEqual(stamp, {
      dispatchId: DISPATCH,
      attemptNo: 1,
      turnKey: TAPE,
      chatSessionId: SESSION,
    });
  });
});

describe("rememberOpenTurnKey", () => {
  beforeEach(() => __resetOpenTurnKeyMemory());

  it("writes the key once and never touches a balance", async () => {
    const calls: string[] = [];
    const pool: Pick<Pool, "query"> = {
      async query(sql: string) {
        calls.push(String(sql));
        return { rows: [], rowCount: 1 } as never;
      },
    } as unknown as Pick<Pool, "query">;
    await rememberOpenTurnKey(pool, { dispatchId: DISPATCH, userId: 1618n, turnKey: TAPE });
    await rememberOpenTurnKey(pool, { dispatchId: DISPATCH, userId: 1618n, turnKey: "c".repeat(64) });
    await rememberOpenTurnKey(pool, { dispatchId: DISPATCH, userId: 1618n, turnKey: "not-a-key" });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /turn_key IS NULL/);
    assert.equal(calls[0], REMEMBER_OPEN_TURN_KEY_SQL);
    assert.equal(/credit_ledger|users/i.test(calls[0]!), false);
  });
});

describe("vision admit wiring", () => {
  beforeEach(() => __resetGrokVisionRateState());

  function runner(stamp: Awaited<ReturnType<typeof attributeOpenTurn>>, capture: (ctx: any) => void) {
    return makeGrokRunner({
      getPool: () => ({}) as Pool,
      preCheckRedis: new InMemoryPreCheckRedis(),
      pricing: new PricingCache(),
      catalog: { assertFresh: async () => grokVisionSnapshot() },
      loadUserModelAuthz: async () => PUBLIC_VISION_AUTHZ,
      pickAccountId: async () => 24n,
      freshToken: async () => Buffer.alloc(16),
      requestFn: async () => ({
        statusCode: 200,
        body: { text: async () => JSON.stringify(grokVisionUpstreamPayload()) },
      }),
      preCheckWithCostFn: (async (_r: unknown, input: any) => ({
        maxCost: input.maxCost,
        balance: 1000n,
        capped: false,
        originalMaxCost: input.maxCost,
        reservation: { userId: String(input.userId), requestId: input.requestId },
      })) as any,
      attributeOpenTurnFn: async () => stamp,
      broadcastToUser: () => {},
      startInflightJournalFn: (async (_p: unknown, ctx: any) => {
        capture(ctx);
        return true;
      }) as any,
      settleDurableCodexBillingFn: (async () => "committed") as any,
      abortInflightJournalFn: (async () => true) as any,
      releasePreCheckFn: (async () => {}) as any,
      readJournalForTakeoverFn: (async () => null) as any,
    });
  }

  it("stamps the single open turn onto the vision journal and not a billing parent", async () => {
    let ctx: any = null;
    const run = runner(
      { dispatchId: DISPATCH, attemptNo: 2, turnKey: TAPE, chatSessionId: SESSION },
      (next) => { ctx = next; },
    );
    await run({ userId: 1618n, containerId: 1524n, requestId: "vision-one", prompt: "look" });
    assert.equal(ctx.dispatchId, DISPATCH);
    assert.equal(ctx.attemptNo, 2);
    assert.equal(ctx.ctxJson.turnKey, TAPE);
    assert.equal(ctx.ctxJson.chatSessionId, SESSION);
    assert.equal(ctx.ctxJson.parentSessionId, undefined);
    assert.equal(ctx.ctxJson.openTurnAttribution, undefined);
  });

  it("stamps an intentional skip and leaves a failed lookup unstamped", async () => {
    let skipped: any = null;
    await runner({ openTurnAttribution: "many" }, (next) => { skipped = next; })({
      userId: 1618n,
      containerId: 1524n,
      requestId: "vision-many",
      prompt: "look",
    });
    assert.equal(skipped.ctxJson.openTurnAttribution, "many");
    assert.equal(skipped.dispatchId, undefined);
    let failed: any = null;
    const run = makeGrokRunner({
      getPool: () => ({ async query() { throw new Error("db down"); } }) as unknown as Pool,
      preCheckRedis: new InMemoryPreCheckRedis(),
      pricing: new PricingCache(),
      catalog: { assertFresh: async () => grokVisionSnapshot() },
      loadUserModelAuthz: async () => PUBLIC_VISION_AUTHZ,
      pickAccountId: async () => 24n,
      freshToken: async () => Buffer.alloc(16),
      requestFn: async () => ({
        statusCode: 200,
        body: { text: async () => JSON.stringify(grokVisionUpstreamPayload()) },
      }),
      preCheckWithCostFn: (async (_r: unknown, input: any) => ({
        maxCost: input.maxCost,
        balance: 1000n,
        capped: false,
        originalMaxCost: input.maxCost,
        reservation: { userId: String(input.userId), requestId: input.requestId },
      })) as any,
      startInflightJournalFn: (async (_p: unknown, ctx: any) => {
        failed = ctx;
        return true;
      }) as any,
      settleDurableCodexBillingFn: (async () => "committed") as any,
      abortInflightJournalFn: (async () => true) as any,
      releasePreCheckFn: (async () => {}) as any,
      readJournalForTakeoverFn: (async () => null) as any,
    });
    await run({ userId: 1618n, containerId: 1524n, requestId: "vision-fail", prompt: "look" });
    assert.equal(failed.ctxJson.turnKey, undefined);
    assert.equal(failed.ctxJson.openTurnAttribution, undefined);
  });
});

describe("delegate admit wiring", () => {
  function snapshot(): ModelCatalogSnapshot {
    const entry = (entryId: number, modelId: string, engine: "codex" | "grok"): ModelCatalogEntry => ({
      entryId,
      modelId,
      engine,
      providerId: engine,
      upstreamModelId: null,
      contextWindow: 128_000,
      capabilityProfile: {
        supportsVision: false,
        reasoning: { supported: ["medium"], codexModelDefault: null },
        ccb: { capabilityZero: false, supportsThinking: false },
      },
      capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
      state: "active",
      lockVersion: 1,
    });
    const price = (modelId: string): ModelCatalogPricing => ({
      modelId,
      displayName: modelId,
      inputPerMtok: 1000n,
      outputPerMtok: 5000n,
      cacheReadPerMtok: 100n,
      cacheWritePerMtok: 500n,
      multiplier: "1.000",
      visibility: "public",
      sortOrder: 0,
      defaultEffort: null,
    });
    return new ModelCatalogSnapshot({
      entries: [entry(1, "grok-build", "grok"), entry(2, "gpt-5.6-sol", "codex")],
      aliases: new Map(),
      pricing: new Map([
        ["grok-build", price("grok-build")],
        ["gpt-5.6-sol", price("gpt-5.6-sol")],
      ]),
      securityEpoch: 7n,
    });
  }

  const authz: UserModelAuthz = {
    role: "user",
    grantedModelIds: new Set(),
    deniedModelIds: new Set(),
    userPlanTier: null,
    orgPlanCode: null,
  };

  it("asks for the open turn only when the body has no parent turn key", async () => {
    let lookups = 0;
    let ctx: any = null;
    const runtime = createDelegateEngineBillingRuntime({
      getPool: () => ({ async query() { return { rows: [], rowCount: 0 }; } }) as any,
      preCheckRedis: {} as any,
      pricing: { get() { return undefined; } } as any,
      catalog: { assertFresh: async () => snapshot() },
      loadUserModelAuthz: async () => authz,
      newRequestId: () => "ab".repeat(16),
      preCheckWithCostFn: (async (_r: unknown, input: any) => ({
        maxCost: input.maxCost,
        reservation: { userId: "42", requestId: input.requestId },
      })) as any,
      startInflightJournalFn: (async (_p: unknown, next: any) => {
        ctx = next;
        return true;
      }) as any,
      getAgentCostMultiplierFn: async () => "1.000",
      attributeOpenTurnFn: async () => {
        lookups += 1;
        return { dispatchId: DISPATCH, attemptNo: 3, turnKey: TAPE, chatSessionId: SESSION };
      },
    });
    await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
      identity: { userId: 42, containerId: 7 },
      body: {
        model: "grok-build",
        engine: "grok",
        agentId: "auditor",
        delegateAgentId: "auditor",
        sessionKey: "agent:auditor:delegate:main:1",
      },
    });
    assert.equal(lookups, 1);
    assert.equal(ctx.dispatchId, DISPATCH);
    assert.equal(ctx.ctxJson.parentTurnKey, TAPE);
    assert.equal(ctx.ctxJson.parentSessionId, SESSION);
    ctx = null;
    await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
      identity: { userId: 42, containerId: 7 },
      body: {
        model: "grok-build",
        engine: "grok",
        agentId: "auditor",
        delegateAgentId: "auditor",
        sessionKey: "agent:auditor:delegate:main:1",
        parentTurnKey: "d".repeat(64),
        parentSessionId: "web-parent",
      },
    });
    assert.equal(lookups, 1);
    assert.equal(ctx.ctxJson.parentTurnKey, "d".repeat(64));
    assert.equal(ctx.ctxJson.parentSessionId, "web-parent");
    assert.equal(ctx.ctxJson.openTurnAttribution, undefined);
    assert.equal(ctx.dispatchId, undefined);
  });
});
