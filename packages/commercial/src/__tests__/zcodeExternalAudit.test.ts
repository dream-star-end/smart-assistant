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
  closePendingZcodeAudits,
  closeZcodeAudit,
  insertPendingZcodeAudit,
  zcodeCleanupTerminal,
} from "../billing/zcodeExternalAudit.js";
import { parseCatalogResponse } from "@openclaude/gateway";

const REQUEST_ID = "a".repeat(32);

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

function fakePool(handler: (sql: string, params: unknown[]) => { rowCount?: number; rows?: unknown[] }): Pool {
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
      usage: { input_tokens: 3 },
    });
    assert.equal(closed, true);
    assert.match(calls[0]!.sql, /INSERT INTO zcode_external_usage_audit/);
    assert.match(calls[1]!.sql, /UPDATE zcode_external_usage_audit/);
    assert.doesNotMatch(calls.map((c) => c.sql).join("\n"), /cursor_external_usage_audit|settleCursor/);
    assert.deepEqual(calls[0]!.params, [REQUEST_ID, 4n, 88, "peer-1", ZCODE_AUDIT_MODEL_ID]);
    assert.equal(calls[1]!.params[1], "success");
  });

  test("cancel/exception closes leftover pending rows", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = fakePool((sql, params) => {
      calls.push({ sql, params });
      return { rowCount: 1, rows: [] };
    });
    const n = await closePendingZcodeAudits(pool, {
      userId: 4n,
      requestIds: [REQUEST_ID, "not-a-request"],
      terminalCode: zcodeCleanupTerminal("client_close"),
    });
    assert.equal(n, 1);
    assert.match(calls[0]!.sql, /UPDATE zcode_external_usage_audit/);
    assert.equal(calls[0]!.params[2], "USER_CANCELLED");
    assert.deepEqual(calls[0]!.params[1], [REQUEST_ID]);
    assert.equal(zcodeCleanupTerminal("container_error"), "ENGINE_ERROR");
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
  test("hosted ZCode has an independent admission/audit branch and does not reuse Cursor gates", async () => {
    const source = await readFile(new URL("../ws/userChatBridge.ts", import.meta.url), "utf8");
    const start = source.indexOf("if (isZcodeInboundFrame && containerId !== undefined)");
    const end = source.indexOf("if (\n        isCodexInboundFrame &&", start);
    assert.notEqual(start, -1, "missing independent ZCode inbound IIFE");
    const zcodeBranch = source.slice(start, end === -1 ? start + 2500 : end);
    assert.match(zcodeBranch, /isZcodeEngineModel\(modelCapture\)/);
    assert.match(zcodeBranch, /authorityExec\.engine !== 'zcode'/);
    assert.match(zcodeBranch, /insertPendingZcodeAudit/);
    assert.match(zcodeBranch, /ZCODE_UNAVAILABLE/);
    assert.doesNotMatch(zcodeBranch, /isCursorCredentialMember/);
    assert.doesNotMatch(zcodeBranch, /isCursorContainerOnSelfHost/);
    assert.doesNotMatch(zcodeBranch, /cursor_external_usage_audit/);
    assert.doesNotMatch(zcodeBranch, /settleCursorExternalUsage/);
    assert.match(source, /isZcodeModel\(authorityModelForFrame\)/);
    assert.match(source, /isCursorModel\(authorityModelForFrame\)/);
    assert.match(source, /closeZcodeAudit/);
    assert.match(source, /closePendingZcodeAudits/);
    assert.match(source, /external\.engine === 'zcode'/);
  });
});
