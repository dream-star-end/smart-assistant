/**
 * ZCode audit-only helper + catalog/authority classification tripwires.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/zcodeExternalAudit.test.ts
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import type { Pool } from "pg";

import {
  ModelCatalogSnapshot,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
} from "../billing/modelCatalog.js";
import {
  ZCODE_AUDIT_MODEL_ID,
  abortInsertedZcodeAudit,
  applyZcodeFinalizeOutcome,
  closePendingZcodeAudits,
  closeZcodeAudit,
  closeZcodeAuditWithRetry,
  insertPendingZcodeAudit,
  reconcileStaleZcodeAudits,
  rememberZcodePending,
  zcodeAdmissionAbortTerminal,
  zcodeCleanupTerminal,
} from "../billing/zcodeExternalAudit.js";
import { parseCatalogResponse } from "@openclaude/gateway";

const REQUEST_ID = "a".repeat(32);
const instantClock = { sleep: async () => {} };

function entry(
  over: Partial<ModelCatalogEntry> & Pick<ModelCatalogEntry, "entryId" | "modelId">,
): ModelCatalogEntry {
  return {
    engine: "ccb",
    providerId: "ark",
    upstreamModelId: null,
    contextWindow: 128_000,
    capabilityProfile: {
      supportsVision: false,
      reasoning: { supported: [], codexModelDefault: null },
      ccb: { capabilityZero: false, supportsThinking: false },
    },
    capabilitySchemaVersion: 1,
    state: "active",
    lockVersion: 0,
    ...over,
  };
}

function price(modelId: string, over: Partial<ModelCatalogPricing> = {}): ModelCatalogPricing {
  return {
    modelId,
    displayName: modelId,
    inputPerMtok: 0n,
    outputPerMtok: 0n,
    cacheReadPerMtok: 0n,
    cacheWritePerMtok: 0n,
    multiplier: "1.000",
    visibility: "public",
    sortOrder: 1,
    defaultEffort: null,
    ...over,
  };
}

function enabledZcodeSnapshot(): ModelCatalogSnapshot {
  return new ModelCatalogSnapshot({
    entries: [
      entry({
        entryId: 9,
        modelId: ZCODE_AUDIT_MODEL_ID,
        engine: "zcode",
        providerId: "zcode",
        upstreamModelId: "zai/glm-5.1",
        state: "active",
      }),
      entry({ entryId: 2, modelId: "cursor-auto", engine: "cursor", providerId: "cursor" }),
    ],
    aliases: new Map(),
    pricing: new Map([
      [ZCODE_AUDIT_MODEL_ID, price(ZCODE_AUDIT_MODEL_ID)],
      ["cursor-auto", price("cursor-auto")],
    ]),
    securityEpoch: 5n,
  });
}

function fakePool(handler: (sql: string, params: unknown[]) => { rowCount?: number; rows?: unknown[] } | Promise<{ rowCount?: number; rows?: unknown[] }>): Pool {
  return {
    query: async (sql: string, params: unknown[]) => handler(sql, params),
  } as unknown as Pool;
}

describe("zcode external audit helpers", () => {
  test("enabled fixture is zcode (not cursor) and still external-billing", () => {
    const snap = enabledZcodeSnapshot();
    assert.equal(snap.isZcodeModel(ZCODE_AUDIT_MODEL_ID), true);
    assert.equal(snap.isCursorModel(ZCODE_AUDIT_MODEL_ID), false);
    assert.equal(snap.isExternalBillingModel(ZCODE_AUDIT_MODEL_ID), true);
    assert.equal(snap.isCursorModel("cursor-auto"), true);
    assert.equal(snap.isZcodeModel("cursor-auto"), false);
    assert.equal(snap.isRoutable(ZCODE_AUDIT_MODEL_ID), true);
  });

  test("disabled catalog row is not zcode-inbound and is not routable", () => {
    const snap = new ModelCatalogSnapshot({
      entries: [
        entry({
          entryId: 9,
          modelId: ZCODE_AUDIT_MODEL_ID,
          engine: "zcode",
          providerId: "zcode",
          upstreamModelId: "zai/glm-5.1",
          state: "disabled",
        }),
      ],
      aliases: new Map(),
      pricing: new Map([[ZCODE_AUDIT_MODEL_ID, price(ZCODE_AUDIT_MODEL_ID, { visibility: "hidden" })]]),
      securityEpoch: 5n,
    });
    assert.equal(snap.isZcodeModel(ZCODE_AUDIT_MODEL_ID), false);
    assert.equal(snap.isRoutable(ZCODE_AUDIT_MODEL_ID), false);
  });

  test("enabled wire row is accepted by the gateway runtime catalog parser", () => {
    const snap = enabledZcodeSnapshot();
    const row = snap.listForUser({
      uid: 1,
      role: "user",
      grantedModelIds: new Set(),
      deniedModelIds: new Set(),
      userPlanTier: null,
      orgPlanCode: null,
    }).find((item) => item.modelId === ZCODE_AUDIT_MODEL_ID);
    assert.equal(row?.engine, "zcode");
    const view = parseCatalogResponse({
      models: [{
        model_id: row!.modelId,
        display_name: row!.displayName,
        engine: row!.engine,
        provider_id: row!.providerId,
        context_window: row!.contextWindow,
        supported_efforts: [...row!.supportedEfforts],
        supports_vision: row!.supportsVision,
        capability_zero: row!.capabilityZero,
        supports_thinking: row!.supportsThinking,
        default_effort: row!.defaultEffort,
        available: true,
      }],
      projection_revision: "proj-zcode",
      security_epoch: "5",
      aliases: {},
    });
    assert.equal(view.models[0]?.engine, "zcode");
    assert.equal(view.models[0]?.modelId, ZCODE_AUDIT_MODEL_ID);
  });

  test("insert pending then close to a terminal status", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = fakePool((sql, params) => {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [] };
    });
    await insertPendingZcodeAudit(pool, {
      requestId: REQUEST_ID,
      userId: 4n,
      containerId: 88,
      sessionId: "peer-1",
      modelId: ZCODE_AUDIT_MODEL_ID,
    });
    const closed = await closeZcodeAudit(pool, {
      requestId: REQUEST_ID,
      userId: 4n,
      status: "success",
      terminalCode: null,
      durationMs: 12,
      usage: { inputTokens: 3 },
    });
    assert.equal(closed, "closed");
    assert.match(calls[0]!.sql, /INSERT INTO zcode_external_usage_audit/);
    assert.match(calls[1]!.sql, /UPDATE zcode_external_usage_audit/);
    assert.match(calls[1]!.sql, /status='pending'/);
    assert.doesNotMatch(calls.map((c) => c.sql).join("\n"), /cursor_external_usage_audit|settleCursor/);
    assert.deepEqual(calls[0]!.params, [REQUEST_ID, 4n, 88, "peer-1", ZCODE_AUDIT_MODEL_ID]);
    assert.equal(calls[1]!.params[1], "success");
  });

  test("seal null / frame too big / send throw abort pending immediately", async () => {
    for (const step of ["seal_rejected", "frame_too_big", "send_failed"] as const) {
      const pending = new Set<string>();
      rememberZcodePending(pending, REQUEST_ID);
      let updates = 0;
      const pool = fakePool((sql) => {
        if (sql.includes("UPDATE")) {
          updates += 1;
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      });
      const outcome = await abortInsertedZcodeAudit(pool, {
        requestId: REQUEST_ID,
        userId: 4n,
        pending,
        terminalCode: zcodeAdmissionAbortTerminal(step),
        clock: instantClock,
      });
      assert.equal(outcome, "closed", step);
      assert.equal(updates, 1, step);
      assert.equal(pending.has(REQUEST_ID), false, step);
    }
  });

  test("terminal UPDATE first failure then retry success only then drops the id", async () => {
    const pending = new Set<string>([REQUEST_ID]);
    let updates = 0;
    const pool = fakePool((sql) => {
      if (!sql.includes("UPDATE")) return { rowCount: 0, rows: [] };
      updates += 1;
      if (updates === 1) throw new Error("db down");
      return { rowCount: 1, rows: [] };
    });
    const first = await closeZcodeAudit(pool, {
      requestId: REQUEST_ID,
      userId: 4n,
      status: "success",
      terminalCode: null,
      durationMs: 4,
      usage: null,
    }).catch(() => "failed" as const);
    assert.equal(first, "failed");
    assert.equal(pending.has(REQUEST_ID), true);

    const outcome = await closeZcodeAuditWithRetry(pool, {
      requestId: REQUEST_ID,
      userId: 4n,
      status: "success",
      terminalCode: null,
      durationMs: 4,
      usage: null,
    }, instantClock);
    applyZcodeFinalizeOutcome(pending, REQUEST_ID, outcome);
    assert.equal(outcome, "closed");
    assert.equal(pending.has(REQUEST_ID), false);
    assert.ok(updates >= 2);
  });

  test("cleanup does not clear ids when the first DB close fails", async () => {
    const pending = new Set<string>([REQUEST_ID]);
    let updates = 0;
    const pool = fakePool((sql) => {
      if (!sql.includes("UPDATE")) return { rowCount: 0, rows: [{ status: "pending", user_id: 4n }] };
      updates += 1;
      if (updates === 1) throw new Error("db down");
      return { rowCount: 1, rows: [] };
    });
    const closed = await closePendingZcodeAudits(pool, {
      userId: 4n,
      requestIds: [...pending],
      terminalCode: zcodeCleanupTerminal("container_error"),
      pending,
      clock: instantClock,
    });
    assert.deepEqual(closed, [REQUEST_ID]);
    assert.equal(pending.has(REQUEST_ID), false);
    assert.ok(updates >= 2);
  });

  test("duplicate terminal is fail-closed idempotent and unknown stays pending", async () => {
    const pending = new Set<string>([REQUEST_ID]);
    const dupPool = fakePool((sql) => {
      if (sql.includes("UPDATE")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ status: "success", user_id: 4n }] };
    });
    const dup = await closeZcodeAudit(dupPool, {
      requestId: REQUEST_ID,
      userId: 4n,
      status: "success",
      terminalCode: null,
      durationMs: 1,
      usage: null,
    });
    applyZcodeFinalizeOutcome(pending, REQUEST_ID, dup);
    assert.equal(dup, "already_terminal");
    assert.equal(pending.has(REQUEST_ID), false);

    const unknownPending = new Set<string>([REQUEST_ID]);
    const unknownPool = fakePool((sql) => {
      if (sql.includes("UPDATE")) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    const unknown = await closeZcodeAudit(unknownPool, {
      requestId: REQUEST_ID,
      userId: 4n,
      status: "error",
      terminalCode: "ENGINE_ERROR",
      durationMs: 0,
      usage: null,
    });
    applyZcodeFinalizeOutcome(unknownPending, REQUEST_ID, unknown);
    assert.equal(unknown, "unknown");
    assert.equal(unknownPending.has(REQUEST_ID), true);
  });

  test("stale pending recovery uses created_at and only marks failed audit", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = fakePool((sql, params) => {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [{ request_id: REQUEST_ID }] };
    });
    const closed = await reconcileStaleZcodeAudits(pool, { staleAfterMs: 1_800_000, limit: 20 });
    assert.deepEqual(closed, [REQUEST_ID]);
    assert.match(calls[0]!.sql, /created_at < NOW\(\)/);
    assert.match(calls[0]!.sql, /status='pending'/);
    assert.match(calls[0]!.sql, /ENGINE_ERROR/);
    assert.doesNotMatch(calls[0]!.sql, /settleCursor|credits/);
  });

  test("rejects a non-allowlisted model id before touching SQL", async () => {
    let queried = 0;
    const pool = fakePool(() => {
      queried += 1;
      return { rowCount: 0, rows: [] };
    });
    await assert.rejects(
      () => insertPendingZcodeAudit(pool, {
        requestId: REQUEST_ID,
        userId: 1,
        containerId: 1,
        sessionId: null,
        modelId: "cursor-auto",
      }),
      /experimental allowlist/,
    );
    assert.equal(queried, 0);
  });
});

describe("ZCode bridge source tripwire", () => {
  test("hosted ZCode has an independent admission/audit branch and does not leak pending", async () => {
    const source = await readFile(new URL("../ws/userChatBridge.ts", import.meta.url), "utf8");
    const start = source.indexOf("if (isZcodeInboundFrame && containerId !== undefined)");
    const end = source.indexOf("if (\n        isCodexInboundFrame &&", start);
    assert.notEqual(start, -1, "missing independent ZCode inbound IIFE");
    const zcodeBranch = source.slice(start, end === -1 ? start + 3500 : end);
    assert.match(zcodeBranch, /isZcodeEngineModel\(modelCapture\)/);
    assert.match(zcodeBranch, /authorityExec\.engine !== 'zcode'/);
    assert.match(zcodeBranch, /insertPendingZcodeAudit/);
    assert.match(zcodeBranch, /abortInsertedZcodeAudit/);
    assert.match(zcodeBranch, /seal_rejected|zcode_authority_seal_rejected/);
    assert.match(zcodeBranch, /ERR_FRAME_TOO_BIG/);
    assert.match(zcodeBranch, /ZCODE_UNAVAILABLE/);
    assert.doesNotMatch(zcodeBranch, /isCursorCredentialMember/);
    assert.doesNotMatch(zcodeBranch, /isCursorContainerOnSelfHost/);
    assert.doesNotMatch(zcodeBranch, /cursor_external_usage_audit/);
    assert.doesNotMatch(zcodeBranch, /settleCursorExternalUsage/);
    assert.match(source, /isZcodeModel\(authorityModelForFrame\)/);
    assert.match(source, /isCursorModel\(authorityModelForFrame\)/);
    assert.match(source, /closeZcodeAuditWithRetry/);
    assert.match(source, /applyZcodeFinalizeOutcome/);
    assert.match(source, /reconcileStaleZcodeAudits/);
    assert.match(source, /external\.engine === 'zcode'/);
    assert.doesNotMatch(source, /pendingZcodeRequestIds\.delete\(requestId\)/);
    assert.doesNotMatch(
      source.slice(source.indexOf("if (deps.pgPool && pendingZcodeRequestIds.size > 0)")),
      /pendingZcodeRequestIds\.clear\(\)/,
    );
  });
});
