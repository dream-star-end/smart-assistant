import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import {
  MODEL_AUTHORITY_FIELD,
  REMOTE_DRIVER_BACKEND,
  parseAuthorityKeyring,
  type RemoteExecutionBackend,
} from "@openclaude/protocol";
import { ModelAuthorityConsumer } from "../../../../gateway/src/modelAuthority.js";
import { readAntigravityRouteAuthority } from "../../billing/antigravityRouteAuthority.js";
import {
  abandonAntigravityTurn,
  settleAntigravityTurnRecord,
} from "../../billing/antigravitySettle.js";
import { buildSelfhostCrossPoolBridgeHooks } from "../../bootstrap/chatBridgeBootstrap.js";
import { handleTurnDispatchReceipt } from "../turnDispatchReceipt.js";
import { bindAuthorityTurnDispatch } from "../../billing/verificationSponsorship.js";
import {
  CAPABILITY_SCHEMA_VERSION,
  ModelCatalogSnapshot,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
} from "../../billing/modelCatalog.js";
import type { PreCheckRedis } from "../../billing/preCheck.js";
import type { PricingCache } from "../../billing/pricing.js";
import {
  PgLogicalModelBindingStore,
  PgSessionAuthorityStateStore,
  extractPendingInstallMigration,
  type PgQueryResult,
  type PgTransactionClient,
  type PgTransactionPool,
} from "../../db/threeLayerStateStore.js";
import {
  createSelfhostCrossPoolFallbackSelector,
  createSelfhostReturnToRemoteGrantResolver,
} from "../../account-pool/remotePool/selfhostCrossPoolSelector.js";
import { AuthoritySigner } from "../authoritySigner.js";
import {
  createLocalFallbackWireTracker,
  prepareBridgeLocalFallbackTransport,
  type LocalFallbackActiveCodexTurnState,
  type LocalFallbackAntigravityRelayEntry,
  type LocalFallbackCodexTurnSnapshot,
} from "../userChatBridgeLocalFallbackTransport.js";
import {
  resolveRemotePoolBackendAndSeal,
  type LocalFallbackCommittedHandle,
} from "../userChatBridgeRemotePoolSeal.js";

interface SealPgState {
  pointers: Map<string, Record<string, unknown>>;
  migrations: Map<string, Record<string, unknown>>;
  bindings: Map<string, Record<string, unknown>>;
  failNextCommit: boolean;
  failCommitAfterWrite: boolean;
  clockMs: number;
}

function cloneState(s: SealPgState): SealPgState {
  const cloneMap = (m: Map<string, Record<string, unknown>>) =>
    new Map([...m.entries()].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  return {
    pointers: cloneMap(s.pointers),
    migrations: cloneMap(s.migrations),
    bindings: cloneMap(s.bindings),
    failNextCommit: s.failNextCommit,
    failCommitAfterWrite: s.failCommitAfterWrite,
    clockMs: s.clockMs,
  };
}

class InMemorySealPgPool implements PgTransactionPool {
  state: SealPgState = {
    pointers: new Map(),
    migrations: new Map(),
    bindings: new Map(),
    failNextCommit: false,
    failCommitAfterWrite: false,
    clockMs: Date.parse("2026-11-25T15:00:00.000Z"),
  };

  private nowIso(db: SealPgState): string {
    db.clockMs += 10;
    if (db !== this.state && db.clockMs > this.state.clockMs) {
      this.state.clockMs = db.clockMs;
    }
    return new Date(db.clockMs).toISOString();
  }

  async query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<PgQueryResult<R>> {
    return this.execOn(this.state, sql, params) as PgQueryResult<R>;
  }

  async connect(): Promise<PgTransactionClient> {
    let txState: SealPgState | null = null;
    let sawMigrationCommit = false;
    return {
      query: async <R extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: unknown[] = [],
      ): Promise<PgQueryResult<R>> => {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed === "BEGIN") {
          txState = cloneState(this.state);
          sawMigrationCommit = false;
          return { rows: [], rowCount: 0 };
        }
        if (trimmed === "COMMIT") {
          const shouldThrowAfterCommit = sawMigrationCommit && this.state.failCommitAfterWrite;
          if (txState) {
            this.state = txState;
            txState = null;
          }
          if (shouldThrowAfterCommit) {
            this.state.failCommitAfterWrite = false;
            throw new Error("MOCK_PG_COMMIT_ACK_LOST");
          }
          return { rows: [], rowCount: 0 };
        }
        if (trimmed === "ROLLBACK") {
          txState = null;
          sawMigrationCommit = false;
          return { rows: [], rowCount: 0 };
        }
        if (sql.replace(/\s+/g, " ").trim().startsWith("UPDATE session_placement_migrations SET state = 'committed'")) {
          sawMigrationCommit = true;
        }
        return this.execOn(txState ?? this.state, sql, params) as PgQueryResult<R>;
      },
      release: () => {
        txState = null;
      },
    };
  }

  private execOn(
    db: SealPgState,
    rawSql: string,
    params: unknown[],
  ): PgQueryResult<Record<string, unknown>> {
    const sql = rawSql.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT pg_advisory_xact_lock")) {
      return { rows: [{ pg_advisory_xact_lock: "" }], rowCount: 1 };
    }
    if (sql.includes("FROM session_engine_pointers") && sql.startsWith("SELECT")) {
      const row = db.pointers.get(`${params[0]}:${params[1]}`);
      return row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("INSERT INTO session_engine_pointers") && sql.includes("ON CONFLICT")) {
      const k = `${params[0]}:${params[1]}`;
      const now = this.nowIso(db);
      const prev = db.pointers.get(k);
      const row: Record<string, unknown> = {
        user_id: String(params[0]),
        session_key: String(params[1]),
        placement_epoch: prev ? prev.placement_epoch : 1,
        pool_kind: params[2],
        engine: params[3],
        native_session_id: params[4],
        operation_id: params[5],
        profile_id: params[6],
        capsule_id: params[7],
        history_json: JSON.parse(String(params[8])),
        rejected_ids_json: JSON.parse(String(params[9])),
        prompt_cache_meta_json: params[10] === null ? null : JSON.parse(String(params[10])),
        usage_baseline_json: params[11] === null ? null : JSON.parse(String(params[11])),
        history_context_version: params[12],
        promoted_from_history: params[13],
        migration_state: prev ? prev.migration_state : "active",
        active_migration_id: prev ? prev.active_migration_id : null,
        created_at: prev ? prev.created_at : now,
        updated_at: now,
      };
      db.pointers.set(k, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO session_engine_pointers")) {
      const k = `${params[0]}:${params[1]}`;
      const now = this.nowIso(db);
      const row: Record<string, unknown> = {
        user_id: String(params[0]),
        session_key: String(params[1]),
        placement_epoch: 1,
        pool_kind: params[2],
        engine: params[3],
        native_session_id: null,
        operation_id: params[4],
        profile_id: params[5],
        capsule_id: null,
        history_json: [],
        rejected_ids_json: [],
        prompt_cache_meta_json: null,
        usage_baseline_json: null,
        history_context_version: null,
        promoted_from_history: false,
        migration_state: "migrating",
        active_migration_id: params[6],
        created_at: now,
        updated_at: now,
      };
      db.pointers.set(k, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE session_engine_pointers SET migration_state = 'migrating'")) {
      const k = `${params[0]}:${params[1]}`;
      const row = db.pointers.get(k);
      if (!row || Number(row.placement_epoch) !== Number(params[2]) || row.migration_state !== "active") {
        return { rows: [], rowCount: 0 };
      }
      row.migration_state = "migrating";
      row.active_migration_id = params[3];
      row.updated_at = this.nowIso(db);
      return { rows: [{ placement_epoch: row.placement_epoch }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE session_engine_pointers SET placement_epoch = $3")) {
      if (this.state.failNextCommit) {
        this.state.failNextCommit = false;
        throw new Error("MOCK_PG_COMMIT_FAILURE");
      }
      const k = `${params[0]}:${params[1]}`;
      const row = db.pointers.get(k);
      if (!row || row.active_migration_id !== params[11] || row.migration_state !== "migrating") {
        return { rows: [], rowCount: 0 };
      }
      row.placement_epoch = Number(params[2]);
      row.migration_state = "active";
      row.active_migration_id = null;
      row.pool_kind = params[3];
      row.engine = params[4];
      if (params[12] === true) row.native_session_id = params[5];
      row.operation_id = params[6];
      row.profile_id = params[7];
      if (params[14] === true) {
        row.prompt_cache_meta_json = params[9] === null ? null : JSON.parse(String(params[9]));
      }
      row.updated_at = this.nowIso(db);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE session_engine_pointers SET prompt_cache_meta_json = $3")) {
      const k = `${params[0]}:${params[1]}`;
      const row = db.pointers.get(k);
      if (!row || Number(row.placement_epoch) !== Number(params[3])) {
        return { rows: [], rowCount: 0 };
      }
      row.prompt_cache_meta_json = params[2] === null ? null : JSON.parse(String(params[2]));
      row.updated_at = this.nowIso(db);
      return { rows: [{ placement_epoch: row.placement_epoch }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE session_engine_pointers SET migration_state = 'active'")) {
      const k = `${params[0]}:${params[1]}`;
      const row = db.pointers.get(k);
      if (!row || row.active_migration_id !== params[2] || row.migration_state !== "migrating") {
        return { rows: [], rowCount: 0 };
      }
      row.migration_state = "active";
      row.active_migration_id = null;
      row.updated_at = this.nowIso(db);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO session_placement_migrations")) {
      const now = this.nowIso(db);
      const row: Record<string, unknown> = {
        migration_id: String(params[0]),
        user_id: String(params[1]),
        session_key: String(params[2]),
        from_epoch: Number(params[3]),
        to_epoch: Number(params[4]),
        state: "migrating",
        from_placement_json: JSON.parse(String(params[5])),
        to_placement_json: JSON.parse(String(params[6])),
        capsule_ref_json: null,
        continuity_tier: null,
        reason: params[7],
        created_at: now,
        completed_at: null,
      };
      db.migrations.set(String(params[0]), row);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.includes("FROM session_placement_migrations") && sql.startsWith("SELECT")) {
      const row = db.migrations.get(String(params[0]));
      return row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("UPDATE session_placement_migrations SET state = 'committed'")) {
      if (this.state.failNextCommit) {
        this.state.failNextCommit = false;
        throw new Error("MOCK_PG_COMMIT_FAILURE");
      }
      const row = db.migrations.get(String(params[0]));
      if (!row || row.state !== "migrating") return { rows: [], rowCount: 0 };
      row.state = "committed";
      row.continuity_tier = params[1];
      row.capsule_ref_json = params[2] === null ? null : JSON.parse(String(params[2]));
      row.completed_at = this.nowIso(db);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE session_placement_migrations SET state = 'aborted'")) {
      const row = db.migrations.get(String(params[0]));
      if (!row || row.state !== "migrating") return { rows: [], rowCount: 0 };
      row.state = "aborted";
      row.reason = params[1];
      row.completed_at = this.nowIso(db);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO model_logical_pool_bindings")) {
      const key = `${params[0]}::${params[1]}::${params[2]}`;
      const row: Record<string, unknown> = {
        logical_model_id: String(params[0]),
        pool_kind: String(params[1]),
        driver_id: String(params[2]),
        canonical_model_id: String(params[3]),
        priority: Number(params[4]),
        capabilities_json: JSON.parse(String(params[5])),
        enabled: Boolean(params[6]),
      };
      db.bindings.set(key, row);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.includes("FROM model_logical_pool_bindings") && sql.startsWith("SELECT")) {
      const logicalModel = String(params[0]);
      const enabledOnly = sql.includes("AND enabled = TRUE");
      const rows = [...db.bindings.values()].filter(
        (r) => r.logical_model_id === logicalModel && (!enabledOnly || r.enabled === true),
      );
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("UPDATE model_logical_pool_bindings SET enabled = $4")) {
      const key = `${params[0]}::${params[1]}::${params[2]}`;
      const row = db.bindings.get(key);
      if (!row) return { rows: [], rowCount: 0 };
      row.enabled = Boolean(params[3]);
      return { rows: [{ binding_id: 1 }], rowCount: 1 };
    }
    if (sql.includes("FROM session_rolling_checkpoints") && sql.startsWith("SELECT")) {
      return { rows: [], rowCount: 0 };
    }
    if (
      sql.includes("FROM request_finalize_journal") ||
      sql.includes("FROM remote_agent_bindings")
    ) {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected SQL in InMemorySealPgPool: ${sql}`);
  }
}

function makeCatalog(): ModelCatalogSnapshot {
  const entries: ModelCatalogEntry[] = [
    {
      entryId: 1,
      modelId: "gpt-6.2-astra-remote",
      engine: "codex",
      providerId: "openai",
      upstreamModelId: "gpt-6.2-astra",
      contextWindow: 200_000,
      capabilityProfile: {
        supportsVision: true,
        reasoning: { supported: ["low", "medium", "high"], codexModelDefault: "medium" },
        ccb: { capabilityZero: false, supportsThinking: false },
      },
      capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
      state: "active",
      lockVersion: 1,
      placement: "remote_pool",
    },
    {
      entryId: 2,
      modelId: "gpt-6.2-astra",
      engine: "codex",
      providerId: "openai",
      upstreamModelId: "gpt-6.2-astra",
      contextWindow: 200_000,
      capabilityProfile: {
        supportsVision: true,
        reasoning: { supported: ["low", "medium", "high"], codexModelDefault: "medium" },
        ccb: { capabilityZero: false, supportsThinking: false },
      },
      capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
      state: "active",
      lockVersion: 1,
      placement: "local",
    },
    {
      entryId: 3,
      modelId: "antigravity-gemini-4-neon-remote",
      engine: "antigravity",
      providerId: "antigravity",
      upstreamModelId: "gemini-4-neon",
      contextWindow: 200_000,
      capabilityProfile: {
        supportsVision: true,
        reasoning: { supported: ["low", "medium", "high"], codexModelDefault: null },
        ccb: { capabilityZero: false, supportsThinking: false },
      },
      capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
      state: "active",
      lockVersion: 1,
      placement: "remote_pool",
    },
    {
      entryId: 4,
      modelId: "antigravity-gemini-4-neon",
      engine: "antigravity",
      providerId: "antigravity",
      upstreamModelId: "gemini-4-neon",
      contextWindow: 200_000,
      capabilityProfile: {
        supportsVision: true,
        reasoning: { supported: ["low", "medium", "high"], codexModelDefault: null },
        ccb: { capabilityZero: false, supportsThinking: false },
      },
      capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
      state: "active",
      lockVersion: 1,
      placement: "local",
    },
  ];
  const pricing = new Map<string, ModelCatalogPricing>();
  for (const e of entries) {
    pricing.set(e.modelId, {
      modelId: e.modelId,
      displayName: e.modelId,
      inputPerMtok: 100n,
      outputPerMtok: 200n,
      cacheReadPerMtok: 10n,
      cacheWritePerMtok: 25n,
      multiplier: "1",
      visibility: "public",
      sortOrder: 1,
      defaultEffort: "medium",
    });
  }
  return new ModelCatalogSnapshot({
    entries,
    aliases: new Map(),
    pricing,
    securityEpoch: 7n,
  });
}

function makeHarness(snapshot: ModelCatalogSnapshot, uid = 42, containerId = 99) {
  const signer = AuthoritySigner.createEphemeral();
  const consumer = new ModelAuthorityConsumer({
    keyring: parseAuthorityKeyring(signer.publicKeyringEnv()),
    uid,
    containerId,
    required: true,
  });
  const makeExec = (modelId: string) => {
    const desc = snapshot.resolve(modelId)!;
    return {
      canonicalModel: desc.canonicalModel,
      engine: desc.engine,
      placement: desc.placement === "remote_pool" ? ("remote_pool" as const) : ("local" as const),
      securityEpoch: Number(snapshot.securityEpoch),
      descriptor: {
        capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
        contextWindow: desc.contextWindow,
        supportsVision: desc.capabilityProfile.supportsVision,
        supportedEfforts: [...desc.capabilityProfile.reasoning.supported],
        capabilityProfile: JSON.parse(JSON.stringify(desc.capabilityProfile)),
      },
    };
  };
  const signExec = (
    exec: ReturnType<typeof makeExec>,
    billingRequestId?: string,
    authorityTurnId?: string,
    executionBackend?: RemoteExecutionBackend,
    poolMigration?: Parameters<AuthoritySigner["signBundle"]>[0]["poolMigration"],
  ) =>
    signer.signBundle({
      uid,
      containerId,
      connectionChallenge: "conn-seal-test-1",
      canonicalModel: exec.canonicalModel,
      engine: exec.engine,
      executionDescriptor: exec.descriptor,
      auxModels: [],
      ...(executionBackend ? { executionBackend } : {}),
      ...(poolMigration ? { poolMigration } : {}),
      ...(authorityTurnId ? { authorityTurnId } : {}),
      ...(billingRequestId ? { billingRequestId } : {}),
      executionRevision: "rev-seal-1",
      securityEpoch: exec.securityEpoch,
    }).bundle;
  return { consumer, makeExec, signExec };
}

describe("userChatBridgeRemotePoolSeal — Codex & Antigravity local fallback + compensation + return-to-remote", () => {
  it("Codex: remote unavailable -> prepares local route/journal before PG commit -> returns __oc_codex_route + valid signature -> recovers to remote with return grant", async () => {
    const pgPool = new InMemorySealPgPool();
    const authorityStore = new PgSessionAuthorityStateStore(pgPool);
    const snapshot = makeCatalog();
    const { consumer, makeExec, signExec } = makeHarness(snapshot);
    const uid = 42;
    const containerId = 99;
    const sessionKey = "agent:main:webchat:dm:codex-seal-loop";
    const reqId1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const reqId2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    await authorityStore.upsertEnginePointer({
      userId: uid,
      sessionKey,
      poolKind: "remote_pool",
      engine: "codex",
      nativeSessionId: "codex-remote-thread-1",
      operationId: "11111111-1111-4111-8111-111111111111",
      profileId: "prof-codex-1",
    });

    const fallbackSelector = createSelfhostCrossPoolFallbackSelector({
      pool: pgPool,
      catalogCache: { assertFresh: async () => snapshot },
      selfhost: true,
      authorityStore,
    });
    const returnResolver = createSelfhostReturnToRemoteGrantResolver({
      pool: pgPool,
      selfhost: true,
      authorityStore,
    });

    const events: string[] = [];
    let committedHandle: LocalFallbackCommittedHandle | null = null;
    let compensateCalls = 0;

    // Turn 2: remote unavailable -> local fallback for Codex
    const turn2 = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      exec: makeExec("gpt-6.2-astra-remote"),
      billingRequestId: reqId1,
      log: null,
      cc5BackendSelector: async () => {
        throw new Error("REMOTE_LANE_CAPACITY_EXHAUSTED");
      },
      crossPoolFallbackSelector: fallbackSelector,
      returnToRemoteGrantResolver: returnResolver,
      prepareLocalFallbackTransport: async ({ localExec, billingRequestId }) => {
        events.push(`prepare:${localExec.canonicalModel}`);
        // Must run BEFORE PG commits epoch 2
        const midPtr = await authorityStore.getEnginePointer(uid, sessionKey);
        assert.equal(midPtr?.placementEpoch, 1);
        assert.equal(midPtr?.migrationState, "migrating");
        return {
          billingRequestId,
          extraFrameFields: {
            requestId: billingRequestId,
            _creditBudget: "5000",
            __oc_codex_route: {
              baseUrl: "http://127.0.0.1:18789/codex-relay/tok-1",
              modelProvider: "openai",
              providerName: null,
              wireApi: "responses",
              preferredAuthMethod: "apikey",
              disableResponseStorage: true,
            },
          },
          compensate: async () => {
            compensateCalls += 1;
          },
        };
      },
      onLocalFallbackCommitted: (h) => {
        committedHandle = h;
      },
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    });

    assert.ok(turn2 !== null);
    assert.deepEqual(events, ["prepare:gpt-6.2-astra"]);
    assert.equal(compensateCalls, 0);
    assert.ok(committedHandle !== null);
    assert.equal(turn2.model, "gpt-6.2-astra");
    assert.equal(turn2.requestId, reqId1);
    assert.equal(turn2._creditBudget, "5000");
    assert.deepEqual((turn2.__oc_codex_route as Record<string, unknown>).modelProvider, "openai");

    const verifiedTurn2 = consumer.consume(turn2, { challenge: "conn-seal-test-1" });
    assert.equal(verifiedTurn2.canonicalModel, "gpt-6.2-astra");
    assert.equal(verifiedTurn2.engine, "codex");
    assert.equal(verifiedTurn2.billingRequestId, reqId1);
    assert.equal(verifiedTurn2.executionBackend, undefined);
    assert.equal(verifiedTurn2.poolMigration?.placementEpoch, 2);
    assert.equal(verifiedTurn2.poolMigration?.allowBackendTransition, true);

    const ptr2 = await authorityStore.getEnginePointer(uid, sessionKey);
    assert.equal(ptr2?.placementEpoch, 2);
    assert.equal(ptr2?.poolKind, "local_container");

    // Turn 2b: continued outage while already on local_container -> STILL prepares local Codex transport, no epoch bump
    let prep2bCalls = 0;
    const turn2b = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      exec: makeExec("gpt-6.2-astra-remote"),
      billingRequestId: reqId2,
      log: null,
      cc5BackendSelector: async () => {
        throw new Error("REMOTE_LANE_UNAVAILABLE");
      },
      crossPoolFallbackSelector: fallbackSelector,
      returnToRemoteGrantResolver: returnResolver,
      prepareLocalFallbackTransport: async ({ billingRequestId }) => {
        prep2bCalls += 1;
        return {
          billingRequestId,
          extraFrameFields: {
            requestId: billingRequestId,
            _creditBudget: "4800",
            __oc_codex_route: { kind: "official_oauth" },
          },
          compensate: () => {},
        };
      },
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    });
    assert.ok(turn2b !== null);
    assert.equal(prep2bCalls, 1);
    assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.placementEpoch, 2);
    assert.deepEqual(turn2b.__oc_codex_route, { kind: "official_oauth" });

    // Turn 3: remote pool recovers -> smooth return-to-remote migration grant (epoch 2 -> 3)
    const remoteCodexBackend: RemoteExecutionBackend = Object.freeze({
      kind: REMOTE_DRIVER_BACKEND,
      version: 4 as const,
      driverId: "codex",
      driverVersion: "5.0.0",
      engineId: "codex",
      authorityEngine: "codex" as const,
      sessionKey,
      operationId: "22222222-2222-4222-8222-222222222222",
      generation: "1",
      profileId: "prof-codex-1",
      authEpoch: "epoch-1",
    });
    const reqId3 = "cccccccccccccccccccccccccccccccc";
    const turn3 = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      exec: makeExec("gpt-6.2-astra-remote"),
      billingRequestId: reqId3,
      log: null,
      cc5BackendSelector: async () => remoteCodexBackend,
      crossPoolFallbackSelector: fallbackSelector,
      returnToRemoteGrantResolver: returnResolver,
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    });
    assert.ok(turn3 !== null);
    assert.equal(turn3.model, "gpt-6.2-astra-remote");
    const verifiedTurn3 = consumer.consume(
      { ...turn3, requestId: reqId3 },
      { challenge: "conn-seal-test-1" },
    );
    assert.equal(verifiedTurn3.executionBackend?.operationId, "22222222-2222-4222-8222-222222222222");
    assert.equal(verifiedTurn3.poolMigration?.placementEpoch, 3);
    assert.equal(verifiedTurn3.poolMigration?.allowBackendTransition, true);
    const ptr3 = await authorityStore.getEnginePointer(uid, sessionKey);
    assert.equal(ptr3?.placementEpoch, 3);
    assert.equal(ptr3?.poolKind, "remote_pool");
  });

  it("Antigravity: remote unavailable -> prepares local AGY route/budget before PG commit -> returns __oc_antigravity_route & _creditBudget -> recovers to remote", async () => {
    const pgPool = new InMemorySealPgPool();
    const authorityStore = new PgSessionAuthorityStateStore(pgPool);
    const snapshot = makeCatalog();
    const { consumer, makeExec, signExec } = makeHarness(snapshot);
    const uid = 42;
    const containerId = 99;
    const sessionKey = "agent:main:webchat:dm:agy-seal-loop";
    const reqId1 = "dddddddddddddddddddddddddddddddd";

    await authorityStore.upsertEnginePointer({
      userId: uid,
      sessionKey,
      poolKind: "remote_pool",
      engine: "antigravity",
      nativeSessionId: "agy-remote-1",
      operationId: "33333333-3333-4333-8333-333333333333",
      profileId: "prof-agy-1",
    });

    const fallbackSelector = createSelfhostCrossPoolFallbackSelector({
      pool: pgPool,
      catalogCache: { assertFresh: async () => snapshot },
      selfhost: true,
      authorityStore,
    });
    const returnResolver = createSelfhostReturnToRemoteGrantResolver({
      pool: pgPool,
      selfhost: true,
      authorityStore,
    });

    const turn2 = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      exec: makeExec("antigravity-gemini-4-neon-remote"),
      billingRequestId: reqId1,
      log: null,
      cc5BackendSelector: async () => {
        throw new Error("REMOTE_LANE_PROFILE_UNAVAILABLE");
      },
      crossPoolFallbackSelector: fallbackSelector,
      returnToRemoteGrantResolver: returnResolver,
      prepareLocalFallbackTransport: async ({ localExec, billingRequestId }) => {
        assert.equal(localExec.canonicalModel, "antigravity-gemini-4-neon");
        return {
          billingRequestId,
          extraFrameFields: {
            requestId: billingRequestId,
            _creditBudget: "9900",
            __oc_antigravity_route: {
              baseUrl: "http://127.0.0.1:18789/agy-relay/tok-agy-1",
              routeToken: "tok-agy-1",
              accessToken: "ya29.limited",
              accessTokenExpiresAt: "2026-11-25T16:00:00.000Z",
            },
          },
          compensate: () => {},
        };
      },
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    });

    assert.ok(turn2 !== null);
    assert.equal(turn2.model, "antigravity-gemini-4-neon");
    assert.equal(turn2._creditBudget, "9900");
    assert.equal(
      (turn2.__oc_antigravity_route as Record<string, unknown>).routeToken,
      "tok-agy-1",
    );
    const verified2 = consumer.consume(turn2, { challenge: "conn-seal-test-1" });
    assert.equal(verified2.engine, "antigravity");
    assert.equal(verified2.poolMigration?.placementEpoch, 2);
    assert.equal(verified2.poolMigration?.allowBackendTransition, true);

    // Return to remote
    const remoteAgyBackend: RemoteExecutionBackend = Object.freeze({
      kind: REMOTE_DRIVER_BACKEND,
      version: 4 as const,
      driverId: "antigravity",
      driverVersion: "5.0.0",
      engineId: "antigravity",
      authorityEngine: "antigravity" as const,
      sessionKey,
      operationId: "44444444-4444-4444-8444-444444444444",
      generation: "1",
      profileId: "prof-agy-1",
      authEpoch: "epoch-1",
    });
    const turn3 = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      exec: makeExec("antigravity-gemini-4-neon-remote"),
      billingRequestId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      log: null,
      cc5BackendSelector: async () => remoteAgyBackend,
      crossPoolFallbackSelector: fallbackSelector,
      returnToRemoteGrantResolver: returnResolver,
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    });
    assert.ok(turn3 !== null);
    const verified3 = consumer.consume(
      { ...turn3, requestId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
      { challenge: "conn-seal-test-1" },
    );
    assert.equal(verified3.poolMigration?.placementEpoch, 3);
    assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.poolKind, "remote_pool");
  });

  it("negative: missing prepareLocalFallbackTransport fails closed for Codex & Antigravity with zero PG mutations", async () => {
    const pgPool = new InMemorySealPgPool();
    const authorityStore = new PgSessionAuthorityStateStore(pgPool);
    const snapshot = makeCatalog();
    const { makeExec, signExec } = makeHarness(snapshot);
    const fallbackSelector = createSelfhostCrossPoolFallbackSelector({
      pool: pgPool,
      catalogCache: { assertFresh: async () => snapshot },
      selfhost: true,
      authorityStore,
    });

    for (const [engine, model] of [
      ["codex", "gpt-6.2-astra-remote"],
      ["antigravity", "antigravity-gemini-4-neon-remote"],
    ] as const) {
      const sessionKey = `agent:main:webchat:dm:missing-prep-${engine}`;
      await authorityStore.upsertEnginePointer({
        userId: 42,
        sessionKey,
        poolKind: "remote_pool",
        engine,
      });
      const rejectedCodes: string[] = [];
      const res = await resolveRemotePoolBackendAndSeal({
        uid: 42,
        containerId: 99,
        sessionKey,
        exec: makeExec(model),
        billingRequestId: "1234567890abcdef1234567890abcdef",
        log: null,
        cc5BackendSelector: async () => {
          throw new Error("REMOTE_LANE_UNAVAILABLE");
        },
        crossPoolFallbackSelector: fallbackSelector,
        resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
        readEpochAtSign: async () => snapshot.securityEpoch,
        signAuthorityBundle: signExec,
        reject: async (code) => {
          rejectedCodes.push(code);
          return null;
        },
      });
      assert.equal(res, null);
      assert.deepEqual(rejectedCodes, ["REMOTE_NATIVE_UNAVAILABLE"]);
      assert.equal((await authorityStore.getEnginePointer(42, sessionKey))?.placementEpoch, 1);
      assert.equal(pgPool.state.migrations.size, 0);
    }
  });

  it("negative: PG commit failure AND sign-boundary epoch drift after prepareLocalFallbackTransport each invoke compensate EXACTLY ONCE with zero leaked resources", async () => {
    const pgPool = new InMemorySealPgPool();
    const authorityStore = new PgSessionAuthorityStateStore(pgPool);
    const snapshot = makeCatalog();
    const { makeExec, signExec } = makeHarness(snapshot);
    const fallbackSelector = createSelfhostCrossPoolFallbackSelector({
      pool: pgPool,
      catalogCache: { assertFresh: async () => snapshot },
      selfhost: true,
      authorityStore,
    });

    // Case 1: PG commit throws after prepareLocalFallbackTransport succeeded
    const commitFailSession = "agent:main:webchat:dm:commit-fail-comp";
    await authorityStore.upsertEnginePointer({
      userId: 42,
      sessionKey: commitFailSession,
      poolKind: "remote_pool",
      engine: "codex",
    });
    pgPool.state.failNextCommit = true;
    const compReasons1: string[] = [];
    let committedCallbackCalled = false;
    const res1 = await resolveRemotePoolBackendAndSeal({
      uid: 42,
      containerId: 99,
      sessionKey: commitFailSession,
      exec: makeExec("gpt-6.2-astra-remote"),
      billingRequestId: "11112222333344445555666677778888",
      log: null,
      cc5BackendSelector: async () => {
        throw new Error("REMOTE_LANE_CAPACITY_EXHAUSTED");
      },
      crossPoolFallbackSelector: fallbackSelector,
      prepareLocalFallbackTransport: async ({ billingRequestId }) => ({
        billingRequestId,
        extraFrameFields: { requestId: billingRequestId, __oc_codex_route: { kind: "official_oauth" } },
        compensate: async (reason) => {
          compReasons1.push(reason);
        },
      }),
      onLocalFallbackCommitted: () => {
        committedCallbackCalled = true;
      },
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    });
    assert.equal(res1, null);
    assert.equal(committedCallbackCalled, false);
    assert.equal(compReasons1.length, 1, "compensate must be called EXACTLY ONCE on PG commit failure");
    assert.equal((await authorityStore.getEnginePointer(42, commitFailSession))?.placementEpoch, 1);
    assert.equal((await authorityStore.getEnginePointer(42, commitFailSession))?.migrationState, "active");

    // Case 2: Security epoch drifts DURING prepareLocalFallbackTransport
    const driftSession = "agent:main:webchat:dm:epoch-drift-comp";
    await authorityStore.upsertEnginePointer({
      userId: 42,
      sessionKey: driftSession,
      poolKind: "remote_pool",
      engine: "antigravity",
    });
    let currentEpoch = 7n;
    const compReasons2: string[] = [];
    const rejectCodes2: string[] = [];
    const res2 = await resolveRemotePoolBackendAndSeal({
      uid: 42,
      containerId: 99,
      sessionKey: driftSession,
      exec: makeExec("antigravity-gemini-4-neon-remote"),
      billingRequestId: "99998888777766665555444433332222",
      log: null,
      cc5BackendSelector: async () => {
        throw new Error("REMOTE_LANE_UNAVAILABLE");
      },
      crossPoolFallbackSelector: fallbackSelector,
      prepareLocalFallbackTransport: async ({ billingRequestId }) => {
        // Simulate admin bumping catalog security epoch during async route minting
        currentEpoch = 8n;
        return {
          billingRequestId,
          extraFrameFields: {
            requestId: billingRequestId,
            _creditBudget: "1000",
            __oc_antigravity_route: { routeToken: "tok-drift" },
          },
          compensate: async (reason) => {
            compReasons2.push(reason);
          },
        };
      },
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
      readEpochAtSign: async () => currentEpoch,
      signAuthorityBundle: signExec,
      reject: async (code) => {
        rejectCodes2.push(code);
        return null;
      },
    });
    assert.equal(res2, null);
    assert.deepEqual(rejectCodes2, ["MODEL_CONFIG_CHANGED_RETRY_TURN"]);
    assert.equal(compReasons2.length, 1, "compensate must be called EXACTLY ONCE on epoch drift");
    assert.equal(compReasons2[0], "sign_boundary_epoch_changed");
    assert.equal((await authorityStore.getEnginePointer(42, driftSession))?.placementEpoch, 1);
  });

  it("prepareBridgeLocalFallbackTransport: exercises real Codex journal/preCheck/route + AGY balance/turn/relay minting and idempotent compensation", async () => {
    const snapshot = makeCatalog();
    const codexExec = {
      canonicalModel: "gpt-6.2-astra",
      engine: "codex",
      placement: "local" as const,
      pricing: snapshot.billingPricingFor("gpt-6.2-astra")!,
      billingRevision: snapshot.billingRevision,
      executionRevision: snapshot.executionRevision,
      securityEpoch: Number(snapshot.securityEpoch),
    };

    const sqlLog: string[] = [];
    const mockPgPool = {
      query: async (sql: string) => {
        const norm = sql.replace(/\s+/g, " ").trim();
        sqlLog.push(norm);
        if (norm.includes("FROM agent_cost_overrides")) {
          return { rows: [], rowCount: 0 };
        }
        if (norm.includes("FROM verification_sponsorships")) {
          return { rows: [], rowCount: 0 };
        }
        if (norm.startsWith("INSERT INTO request_finalize_journal")) {
          return { rows: [{ request_id: "codex-req" }], rowCount: 1 };
        }
        if (norm.startsWith("UPDATE request_finalize_journal")) {
          return { rows: [{ request_id: "codex-req" }], rowCount: 1 };
        }
        if (norm.startsWith("INSERT INTO antigravity_turns")) {
          return { rows: [{ request_id: "agy-req" }], rowCount: 1 };
        }
        if (norm.startsWith("UPDATE antigravity_turns")) {
          return { rows: [{ request_id: "agy-req" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;

    let redisReleases = 0;
    const mockPreCheckRedis: PreCheckRedis = {
      atomicReserve: async ({ maxCost }) => ({
        ok: true,
        locked: maxCost,
        needed: maxCost,
      }),
      releaseReservation: async () => {
        redisReleases += 1;
        return true;
      },
    };

    const mockPricingCache = {
      get: (id: string) => snapshot.billingPricingFor(id),
    } as unknown as PricingCache;

    const activeCodexTurnsByPeer = new Map<string, LocalFallbackActiveCodexTurnState>();
    const inflightCodexTurns = new Map<string, LocalFallbackCodexTurnSnapshot>();
    const pendingAntigravityRelays = new Map<string, LocalFallbackAntigravityRelayEntry>();
    const expiredCodexTokens: string[] = [];
    const expiredAgyTokens: string[] = [];

    const codexPrepared = await prepareBridgeLocalFallbackTransport({
      localExec: codexExec,
      billingRequestId: "abcdef0123456789abcdef0123456789",
      authorityTurnId: "turn-codex-fb-1",
      uid: 42n,
      containerId: 99,
      peerId: "peer-1",
      clientMessageId: "cmid-1",
      promptQueueGrantId: null,
      agentId: "main",
      traceId: "trace-1",
      parsedCapture: { type: "inbound.message", content: { text: "hello" } },
      enrichedParsed: { type: "inbound.message", content: { text: "hello" } },
      dispatchRecord: undefined,
      recoveryJob: undefined,
      containerHasCodexSpeedTiers: false,
      codexBillingEnabled: true,
      sessionMaxMs: 60_000,
      pgPool: mockPgPool,
      preCheckRedis: mockPreCheckRedis,
      preCheckWithCostFn: async (redis, input) => {
        const res = await redis.atomicReserve({
          userId: input.userId,
          requestId: input.requestId,
          balance: 10000n,
          maxCost: input.maxCost,
          ttlSeconds: 300,
        });
        assert.equal(res.ok, true);
        return {
          maxCost: input.maxCost,
          balance: 10000n,
          reservation: { userId: String(input.userId), requestId: input.requestId },
          capped: false,
          originalMaxCost: input.maxCost,
        };
      },
      pricing: mockPricingCache,
      createCodexRoute: async () => ({
        kind: "api_relay",
        engine: "codex",
        token: "codex-tok-1",
        baseUrl: "http://127.0.0.1:18789/codex/codex-tok-1",
        modelProvider: "openai",
        groupId: "grp-1",
        credentialId: "cred-1",
      }),
      activeCodexTurnsByPeer,
      inflightCodexTurns,
      pendingAntigravityRelays,
      codexPeerKey: (p) => `peer:${p ?? "none"}`,
      isCurrentCodexTurnState: (s) => activeCodexTurnsByPeer.get(s.peerKey) === s,
      releaseCodexTurnState: (s) => {
        if (s.releaseTimer) clearTimeout(s.releaseTimer);
        if (s.apiRelayRouteToken) expiredCodexTokens.push(s.apiRelayRouteToken);
        activeCodexTurnsByPeer.delete(s.peerKey);
      },
      expireCodexRouteToken: (tok) => {
        if (tok) expiredCodexTokens.push(tok);
      },
      retryPendingGrokLeaseRelease: () => {},
      modelCheckerHandle: null,
      catalogSnapshot: snapshot,
      isCleaned: () => false,
      log: null,
    });

    assert.ok(codexPrepared !== null);
    assert.equal(codexPrepared.billingRequestId, "abcdef0123456789abcdef0123456789");
    assert.equal(codexPrepared.extraFrameFields.requestId, "abcdef0123456789abcdef0123456789");
    assert.equal(codexPrepared.extraFrameFields._creditBudget, "10000");
    assert.ok(codexPrepared.extraFrameFields.__oc_codex_route !== undefined);
    assert.equal(inflightCodexTurns.has("abcdef0123456789abcdef0123456789"), true);
    assert.equal(activeCodexTurnsByPeer.has("peer:peer-1"), true);

    // Compensate unwinds journal, preCheck, inflightCodexTurns, activeCodexTurnsByPeer & route token idempotently
    await codexPrepared.compensate("commit_failed");
    await codexPrepared.compensate("duplicate_call_must_noop");
    assert.equal(inflightCodexTurns.size, 0);
    assert.equal(activeCodexTurnsByPeer.size, 0);
    assert.deepEqual(expiredCodexTokens, ["codex-tok-1"]);
    assert.ok(redisReleases >= 1);
    assert.ok(sqlLog.some((s) => s.startsWith("UPDATE request_finalize_journal")));

    // Antigravity: zero balance fails closed
    const agyExec = {
      canonicalModel: "antigravity-gemini-4-neon",
      engine: "antigravity",
      placement: "local" as const,
      pricing: snapshot.billingPricingFor("antigravity-gemini-4-neon")!,
      billingRevision: snapshot.billingRevision,
      executionRevision: snapshot.executionRevision,
      securityEpoch: Number(snapshot.securityEpoch),
    };
    const agyZero = await prepareBridgeLocalFallbackTransport({
      localExec: agyExec,
      billingRequestId: "00001111222233334444555566667777",
      uid: 42n,
      containerId: 99,
      peerId: "peer-agy",
      clientMessageId: "cmid-agy",
      promptQueueGrantId: null,
      agentId: "main",
      traceId: "trace-agy",
      parsedCapture: { type: "inbound.message", content: { text: "hi" } },
      enrichedParsed: { type: "inbound.message", content: { text: "hi" } },
      dispatchRecord: undefined,
      recoveryJob: undefined,
      containerHasCodexSpeedTiers: false,
      codexBillingEnabled: true,
      sessionMaxMs: 60_000,
      pgPool: mockPgPool,
      pricing: mockPricingCache,
      admitAntigravityTurn: async () => {
        throw new Error("must_not_mint_when_balance_zero");
      },
      expireAntigravityRoute: (tok) => {
        expiredAgyTokens.push(tok);
      },
      readSpendableBalance: async () => 0n,
      activeCodexTurnsByPeer,
      inflightCodexTurns,
      pendingAntigravityRelays,
      codexPeerKey: (p) => `peer:${p ?? "none"}`,
      isCurrentCodexTurnState: () => true,
      releaseCodexTurnState: () => {},
      expireCodexRouteToken: () => {},
      retryPendingGrokLeaseRelease: () => {},
      modelCheckerHandle: null,
      catalogSnapshot: snapshot,
      isCleaned: () => false,
      log: null,
    });
    assert.equal(agyZero, null);

    // Antigravity positive + compensate
    const agyPrepared = await prepareBridgeLocalFallbackTransport({
      localExec: agyExec,
      billingRequestId: "00001111222233334444555566668888",
      uid: 42n,
      containerId: 99,
      peerId: "peer-agy",
      clientMessageId: "cmid-agy-2",
      promptQueueGrantId: null,
      agentId: "main",
      traceId: "trace-agy-2",
      parsedCapture: { type: "inbound.message", content: { text: "hi" } },
      enrichedParsed: { type: "inbound.message", content: { text: "hi" } },
      dispatchRecord: undefined,
      recoveryJob: undefined,
      containerHasCodexSpeedTiers: false,
      codexBillingEnabled: true,
      sessionMaxMs: 60_000,
      pgPool: mockPgPool,
      pricing: mockPricingCache,
      admitAntigravityTurn: async () => ({
        token: "agy-tok-1",
        baseUrl: "http://127.0.0.1:18789/agy/agy-tok-1",
        accessToken: "ya29.test",
        accessTokenExpiresAt: "2026-11-25T16:00:00.000Z",
        idToken: null,
      }),
      expireAntigravityRoute: (tok) => {
        expiredAgyTokens.push(tok);
      },
      readSpendableBalance: async () => 7500n,
      activeCodexTurnsByPeer,
      inflightCodexTurns,
      pendingAntigravityRelays,
      codexPeerKey: (p) => `peer:${p ?? "none"}`,
      isCurrentCodexTurnState: () => true,
      releaseCodexTurnState: () => {},
      expireCodexRouteToken: () => {},
      retryPendingGrokLeaseRelease: () => {},
      modelCheckerHandle: null,
      catalogSnapshot: snapshot,
      isCleaned: () => false,
      log: null,
    });
    assert.ok(agyPrepared !== null);
    assert.equal(agyPrepared.extraFrameFields._creditBudget, "7500");
    assert.equal(pendingAntigravityRelays.has("00001111222233334444555566668888"), true);
    await agyPrepared.compensate("commit_failed");
    await agyPrepared.compensate("duplicate_noop");
    assert.equal(pendingAntigravityRelays.size, 0);
    assert.deepEqual(expiredAgyTokens, ["agy-tok-1"]);
    assert.ok(sqlLog.some((s) => s.startsWith("UPDATE antigravity_turns")));
  });

  it("B2: durable AGY local fallback binds authority_turn_dispatches to final local canonicalModel so readAntigravityRouteAuthority returns active (remote denied) through settlement, and compensates if binding fails", async () => {
    const sealPool = new InMemorySealPgPool();
    const authorityStore = new PgSessionAuthorityStateStore(sealPool);
    const snapshot = makeCatalog();
    const { makeExec, signExec } = makeHarness(snapshot);
    const uid = 42;
    const containerId = 99;
    const sessionKey = "agent:main:webchat:dm:b2-agy-dispatch";
    const dispatchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const billingRequestId = "1234567890abcdef1234567890abcdef";
    const authorityTurnId = "fedcba0987654321fedcba0987654321";

    await authorityStore.upsertEnginePointer({
      userId: uid,
      sessionKey,
      poolKind: "remote_pool",
      engine: "antigravity",
      nativeSessionId: "agy-remote-prev",
    });

    // Faithful PG mock for turn_dispatches + authority_turn_dispatches + antigravity_turns + settle
    const agyTurns = new Map<string, { userId: string; modelId: string; status: string; traceId: string | null }>();
    const authBindings = new Map<string, { authorityTurnId: string; dispatchId: string; userId: string; sessionId: string; attemptNo: number; canonicalModel: string; dispatchModel: string | null; turnKey: string }>();
    const dispatchRow = {
      dispatch_id: dispatchId,
      user_id: String(uid),
      session_id: "sess-b2",
      model: "antigravity-gemini-4-neon-remote",
      attempt_no: 1,
      status: "admitted",
      owner_id: "owner-1",
      lease_epoch: "1",
      lease_until: new Date(Date.now() + 60_000),
      agent_container_id: String(containerId),
      runtime_kind: "docker",
      billing_request_id: billingRequestId,
      terminal_at: null,
      producer_fenced_at: null,
      client_message_id: "cmid-b2",
    };

    const billingPool = {
      connect: async () => ({
        query: async (sql: string, params: unknown[] = []) => billingPool.query(sql, params),
        release: () => {},
      }),
      query: async (rawSql: string, params: unknown[] = []) => {
        const sql = rawSql.replace(/\s+/g, " ").trim();
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (sql.includes("FROM antigravity_turns WHERE request_id = $1 AND user_id = $2")) {
          const row = agyTurns.get(String(params[0]));
          return row && row.userId === String(params[1])
            ? { rows: [{ status: row.status, model_id: row.modelId, trace_id: row.traceId }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("INSERT INTO antigravity_turns")) {
          if (!agyTurns.has(String(params[0]))) {
            agyTurns.set(String(params[0]), {
              userId: String(params[1]),
              modelId: String(params[2]),
              status: "pending",
              traceId: params[4] == null ? null : String(params[4]),
            });
          }
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("UPDATE antigravity_turns SET status = 'abandoned'")) {
          const row = agyTurns.get(String(params[0]));
          if (row && row.userId === String(params[1]) && row.status === "pending") {
            row.status = "abandoned";
          }
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("FROM turn_dispatches") && sql.includes("WHERE dispatch_id=$1")) {
          return String(params[0]) === dispatchId ? { rows: [{ ...dispatchRow }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO authority_turn_dispatches")) {
          const bound = {
            authorityTurnId: String(params[0]),
            userId: String(params[1]),
            dispatchModel: params[2] == null ? null : String(params[2]),
            canonicalModel: String(params[3]),
            sessionId: String(params[4]),
            dispatchId: String(params[5]),
            attemptNo: Number(params[6]),
            turnKey: "tk-b2",
          };
          if (!authBindings.has(bound.authorityTurnId)) {
            authBindings.set(bound.authorityTurnId, bound);
          }
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("FROM antigravity_turns t") && sql.includes("LEFT JOIN turn_dispatches d")) {
          const reqId = String(params[0]);
          const u = String(params[1]);
          const cid = Number(params[2]);
          const routeModelId = String(params[3]);
          const t = agyTurns.get(reqId);
          if (!t || t.userId !== u) return { rows: [], rowCount: 0 };
          if (t.status !== "pending" || t.modelId !== routeModelId) {
            return { rows: [{ authority: "denied" }], rowCount: 1 };
          }
          const matchingDispatch = dispatchRow.billing_request_id === reqId ? dispatchRow : null;
          if (matchingDispatch) {
            const bindingsForDispatch = [...authBindings.values()].filter(
              (b) => b.dispatchId === matchingDispatch.dispatch_id,
            );
            const authOk =
              matchingDispatch.user_id === u &&
              Number(matchingDispatch.agent_container_id) === cid &&
              (matchingDispatch.status === "admitted" || matchingDispatch.status === "accepted") &&
              (bindingsForDispatch.length === 0 ||
                bindingsForDispatch.some(
                  (a) =>
                    a.userId === u &&
                    a.attemptNo === matchingDispatch.attempt_no &&
                    a.canonicalModel === routeModelId,
                ));
            return { rows: [{ authority: authOk ? "active" : "denied" }], rowCount: 1 };
          }
          return { rows: [{ authority: "legacy" }], rowCount: 1 };
        }
        if (sql.includes("FROM authority_turn_dispatches") && sql.startsWith("SELECT")) {
          const matched = [...authBindings.values()].filter(
            (b) =>
              b.authorityTurnId === String(params[0]) ||
              (b.dispatchId === String(params[1]) && b.attemptNo === Number(params[2])),
          );
          return {
            rows: matched.map((b) => ({
              authority_turn_id: b.authorityTurnId,
              user_id: b.userId,
              dispatch_model: b.dispatchModel,
              canonical_model: b.canonicalModel,
              session_id: b.sessionId,
              dispatch_id: b.dispatchId,
              attempt_no: b.attemptNo,
            })),
            rowCount: matched.length,
          };
        }
        if (sql.startsWith("UPDATE antigravity_turns SET status = 'settling'")) {
          const row = agyTurns.get(String(params[0]));
          if (!row || row.userId !== String(params[1]) || row.status !== "pending") {
            return { rows: [], rowCount: 0 };
          }
          row.status = "settling";
          return { rows: [{ model_id: row.modelId, session_id: "sess-b2", trace_id: row.traceId, engine_status: String(params[2]) }], rowCount: 1 };
        }
        if (sql.includes("FROM antigravity_relay_usage")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FROM request_finalize_journal")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("UPDATE antigravity_turns SET status = $3")) {
          const row = agyTurns.get(String(params[0]));
          if (row && row.userId === String(params[1])) row.status = String(params[2]);
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO usage_records")) {
          return { rows: [{ id: "9001" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;

    const fallbackSelector = createSelfhostCrossPoolFallbackSelector({
      pool: sealPool,
      catalogCache: { assertFresh: async () => snapshot },
      selfhost: true,
      authorityStore,
    });
    const pendingRelays = new Map<string, LocalFallbackAntigravityRelayEntry>();
    const releasedInflight: string[] = [];
    const expiredTokens: string[] = [];
    let committedHandle: LocalFallbackCommittedHandle | null = null;

    // 1) Seal runs FIRST and falls back remote -> local
    const sealed = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      exec: makeExec("antigravity-gemini-4-neon-remote"),
      billingRequestId,
      authorityTurnId,
      log: null,
      cc5BackendSelector: async () => {
        throw new Error("REMOTE_LANE_UNAVAILABLE");
      },
      crossPoolFallbackSelector: fallbackSelector,
      prepareLocalFallbackTransport: (p) =>
        prepareBridgeLocalFallbackTransport({
          ...p,
          localExec: {
            ...p.localExec,
            pricing: snapshot.billingPricingFor(p.localExec.canonicalModel)!,
            billingRevision: snapshot.billingRevision,
            executionRevision: snapshot.executionRevision,
          },
          uid: BigInt(uid),
          containerId,
          peerId: "sess-b2",
          clientMessageId: "cmid-b2",
          promptQueueGrantId: null,
          agentId: "main",
          traceId: "trace-b2",
          parsedCapture: { type: "inbound.message", content: { text: "hi" } },
          enrichedParsed: { type: "inbound.message", model: "antigravity-gemini-4-neon-remote", content: { text: "hi" } },
          dispatchRecord: { dispatchId, billingRequestId, attemptNo: 1, clientMessageId: "cmid-b2" },
          recoveryJob: undefined,
          containerHasCodexSpeedTiers: false,
          codexBillingEnabled: true,
          sessionMaxMs: 60_000,
          pgPool: billingPool,
          pricing: { get: (id: string) => snapshot.billingPricingFor(id) } as unknown as PricingCache,
          admitAntigravityTurn: async () => ({
            token: "tok-b2-local",
            baseUrl: "http://127.0.0.1:18789/agy/tok-b2-local",
            accessToken: "ya29.b2",
            accessTokenExpiresAt: "2026-11-25T16:00:00.000Z",
            idToken: null,
          }),
          expireAntigravityRoute: (tok) => { expiredTokens.push(tok); },
          readSpendableBalance: async () => 5000n,
          releaseInflightFn: (reqId) => { releasedInflight.push(reqId); },
          activeCodexTurnsByPeer: new Map(),
          inflightCodexTurns: new Map(),
          pendingAntigravityRelays: pendingRelays,
          codexPeerKey: (peer) => `peer:${peer ?? "none"}`,
          isCurrentCodexTurnState: () => true,
          releaseCodexTurnState: () => {},
          expireCodexRouteToken: () => {},
          retryPendingGrokLeaseRelease: () => {},
          modelCheckerHandle: null,
          catalogSnapshot: snapshot,
          isCleaned: () => false,
          log: null,
        }),
      onLocalFallbackCommitted: (h) => { committedHandle = h; },
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    });
    assert.ok(sealed !== null);
    assert.equal(sealed.model, "antigravity-gemini-4-neon");
    assert.ok(committedHandle !== null);

    // 2) bindAuthorityTurnDispatch runs AFTER seal with final canonicalModel (local) while keeping dispatchModel (remote)
    await bindAuthorityTurnDispatch(billingPool, {
      authorityTurnId,
      dispatchId,
      userId: BigInt(uid),
      sessionId: "sess-b2",
      dispatchModel: "antigravity-gemini-4-neon-remote",
      canonicalModel: String(sealed.model),
      attemptNo: 1,
      ownerId: "owner-1",
      leaseEpoch: 1,
      agentContainerId: containerId,
      runtimeKind: "docker",
    });

    // 3) First relay auth check via real `readAntigravityRouteAuthority`:
    //    local model matches -> 'active'; stale remote model -> 'denied'!
    const localAuth = await readAntigravityRouteAuthority(billingPool, {
      token: "tok-b2-local",
      userId: BigInt(uid),
      containerId,
      requestId: billingRequestId,
      modelId: "antigravity-gemini-4-neon",
      accountId: 1n,
      budgetCredits: 5000n,
      expiresAt: Date.now() + 60_000,
      maxExpiresAt: Date.now() + 120_000,
    });
    assert.equal(localAuth, "active", "B2: local fallback route must authenticate as active");

    const staleRemoteAuth = await readAntigravityRouteAuthority(billingPool, {
      token: "tok-b2-local",
      userId: BigInt(uid),
      containerId,
      requestId: billingRequestId,
      modelId: "antigravity-gemini-4-neon-remote",
      accountId: 1n,
      budgetCredits: 5000n,
      expiresAt: Date.now() + 60_000,
      maxExpiresAt: Date.now() + 120_000,
    });
    assert.equal(staleRemoteAuth, "denied", "B2: stale remote model must be denied");

    // 4) Terminal settlement succeeds on the local turn record
    const settled = await settleAntigravityTurnRecord({
      pool: billingPool,
      pricing: { get: (id: string) => snapshot.billingPricingFor(id) } as unknown as PricingCache,
      requestId: billingRequestId,
      userId: BigInt(uid),
      engineStatus: "success",
      dispatchId,
      attemptNo: 1,
    });
    assert.ok(settled !== null);
    assert.equal(agyTurns.get(billingRequestId)?.status, "settled");
    assert.deepEqual(expiredTokens, []);
    assert.deepEqual(releasedInflight, []);
  });

  it("B3: bidirectional pendingInstallMigration re-delivery (even with non-null nativeSessionId), stop after markPlacementMigrationInstalled, and commit-ack-lost readback without mis-abort", async () => {
    const pgPool = new InMemorySealPgPool();
    const authorityStore = new PgSessionAuthorityStateStore(pgPool);
    const snapshot = makeCatalog();
    const { consumer, makeExec, signExec } = makeHarness(snapshot);
    const uid = 42;
    const containerId = 99;
    const sessionKey = "agent:main:webchat:dm:b3-bidir-redeliver";

    // Pre-existing session with non-null nativeSessionId and existing promptCacheMeta keys
    await authorityStore.upsertEnginePointer({
      userId: uid,
      sessionKey,
      poolKind: "remote_pool",
      engine: "codex",
      nativeSessionId: "native-codex-history-1",
      operationId: "11111111-1111-4111-8111-111111111111",
      profileId: "prof-codex-1",
      promptCacheMeta: { existingCacheKey: "keep-me" },
    });

    const fallbackSelector = createSelfhostCrossPoolFallbackSelector({
      pool: pgPool,
      catalogCache: { assertFresh: async () => snapshot },
      selfhost: true,
      authorityStore,
    });
    const returnResolver = createSelfhostReturnToRemoteGrantResolver({
      pool: pgPool,
      selfhost: true,
      authorityStore,
    });

    // ── Direction 1 (remote -> local) with COMMIT ACK LOST ──
    pgPool.state.failCommitAfterWrite = true;
    const fbFirst = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      exec: makeExec("gpt-6.2-astra-remote"),
      billingRequestId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      log: null,
      cc5BackendSelector: async () => {
        throw new Error("REMOTE_LANE_CAPACITY_EXHAUSTED");
      },
      crossPoolFallbackSelector: fallbackSelector,
      prepareLocalFallbackTransport: async ({ billingRequestId }) => ({
        billingRequestId,
        extraFrameFields: { requestId: billingRequestId, __oc_codex_route: { kind: "official_oauth" } },
        compensate: () => {},
      }),
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    });
    assert.ok(fbFirst !== null, "B3: commit-ack-lost after PG write must recover committed grant, never mis-abort");
    const verifiedFb1 = consumer.consume(fbFirst, { challenge: "conn-seal-test-1" });
    assert.equal(verifiedFb1.poolMigration?.placementEpoch, 2);
    const localMigId = verifiedFb1.poolMigration!.migrationId;
    const ptrAfterFb1 = await authorityStore.getEnginePointer(uid, sessionKey);
    assert.equal(ptrAfterFb1?.nativeSessionId, "native-codex-history-1");
    assert.equal(ptrAfterFb1?.promptCacheMeta?.existingCacheKey, "keep-me");
    assert.equal(extractPendingInstallMigration(ptrAfterFb1?.promptCacheMeta)?.migrationId, localMigId);

    // Simulate first frame dropped -> retry same session -> MUST re-deliver exact grant without bumping epoch
    const fbRetry = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      exec: makeExec("gpt-6.2-astra-remote"),
      billingRequestId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      log: null,
      cc5BackendSelector: async () => {
        throw new Error("REMOTE_LANE_CAPACITY_EXHAUSTED");
      },
      crossPoolFallbackSelector: fallbackSelector,
      prepareLocalFallbackTransport: async ({ billingRequestId }) => ({
        billingRequestId,
        extraFrameFields: { requestId: billingRequestId, __oc_codex_route: { kind: "official_oauth" } },
        compensate: () => {},
      }),
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    });
    assert.ok(fbRetry !== null);
    const verifiedFbRetry = consumer.consume(fbRetry, { challenge: "conn-seal-test-1" });
    assert.equal(verifiedFbRetry.poolMigration?.migrationId, localMigId);
    assert.equal(verifiedFbRetry.poolMigration?.placementEpoch, 2);
    assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.placementEpoch, 2);

    // Mark installed -> preserves existingCacheKey, clears pendingInstallMigration -> next turn omits grant!
    assert.equal(await authorityStore.markPlacementMigrationInstalled(uid, sessionKey, 2, localMigId), true);
    const ptrAfterLocalInstall = await authorityStore.getEnginePointer(uid, sessionKey);
    assert.equal(ptrAfterLocalInstall?.promptCacheMeta?.existingCacheKey, "keep-me");
    assert.equal(extractPendingInstallMigration(ptrAfterLocalInstall?.promptCacheMeta), null);

    const fbAfterInstall = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      exec: makeExec("gpt-6.2-astra-remote"),
      billingRequestId: "cccccccccccccccccccccccccccccccc",
      log: null,
      cc5BackendSelector: async () => {
        throw new Error("REMOTE_LANE_CAPACITY_EXHAUSTED");
      },
      crossPoolFallbackSelector: fallbackSelector,
      prepareLocalFallbackTransport: async ({ billingRequestId }) => ({
        billingRequestId,
        extraFrameFields: { requestId: billingRequestId, __oc_codex_route: { kind: "official_oauth" } },
        compensate: () => {},
      }),
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    });
    assert.ok(fbAfterInstall !== null);
    assert.equal(consumer.consume(fbAfterInstall, { challenge: "conn-seal-test-1" }).poolMigration, undefined);

    // ── Direction 2 (local -> remote) with COMMIT ACK LOST ──
    const remoteCodexBackend: RemoteExecutionBackend = Object.freeze({
      kind: REMOTE_DRIVER_BACKEND,
      version: 4 as const,
      driverId: "codex",
      driverVersion: "5.0.0",
      engineId: "codex",
      authorityEngine: "codex" as const,
      sessionKey,
      operationId: "22222222-2222-4222-8222-222222222222",
      generation: "1",
      profileId: "prof-codex-1",
      authEpoch: "epoch-1",
    });
    pgPool.state.failCommitAfterWrite = true;
    const retFirst = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      exec: makeExec("gpt-6.2-astra-remote"),
      billingRequestId: "dddddddddddddddddddddddddddddddd",
      log: null,
      cc5BackendSelector: async () => remoteCodexBackend,
      returnToRemoteGrantResolver: returnResolver,
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    });
    assert.ok(retFirst !== null, "B3: return-to-remote commit-ack-lost must recover committed grant, never mis-abort");
    const verifiedRet1 = consumer.consume(
      { ...retFirst, requestId: "dddddddddddddddddddddddddddddddd" },
      { challenge: "conn-seal-test-1" },
    );
    assert.equal(verifiedRet1.poolMigration?.placementEpoch, 3);
    const remoteMigId = verifiedRet1.poolMigration!.migrationId;

    // Drop first return frame -> retry while pointer is ALREADY remote_pool -> MUST re-deliver exact grant!
    const retRetry = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      exec: makeExec("gpt-6.2-astra-remote"),
      billingRequestId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      log: null,
      cc5BackendSelector: async () => remoteCodexBackend,
      returnToRemoteGrantResolver: returnResolver,
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    });
    assert.ok(retRetry !== null);
    const verifiedRetRetry = consumer.consume(
      { ...retRetry, requestId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
      { challenge: "conn-seal-test-1" },
    );
    assert.equal(verifiedRetRetry.poolMigration?.migrationId, remoteMigId);
    assert.equal(verifiedRetRetry.poolMigration?.placementEpoch, 3);
    assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.placementEpoch, 3);

    // Mark installed -> next return turn stops re-issuing grant!
    assert.equal(await authorityStore.markPlacementMigrationInstalled(uid, sessionKey, 3, remoteMigId), true);
    const retAfterInstall = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      exec: makeExec("gpt-6.2-astra-remote"),
      billingRequestId: "ffffffffffffffffffffffffffffffff",
      log: null,
      cc5BackendSelector: async () => remoteCodexBackend,
      returnToRemoteGrantResolver: returnResolver,
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    });
    assert.ok(retAfterInstall !== null);
    const verifiedRetAfter = consumer.consume(
      { ...retAfterInstall, requestId: "ffffffffffffffffffffffffffffffff" },
      { challenge: "conn-seal-test-1" },
    );
    assert.equal(verifiedRetAfter.poolMigration, undefined);
  });

  it("B4 + W3: wire-send outcomes (sync throw/false, async cb(err), preopen drop, wireSent/unknown) and AGY releaseInflight + recordAntigravityTurn ack-loss readback & replay guard", async () => {
    // 1) B4 wire tracker across all send states
    const makeTracked = () => {
      const compReasons: string[] = [];
      const forwardStates: boolean[] = [];
      let confirmed = 0;
      const handle: LocalFallbackCommittedHandle = {
        localEngine: "codex",
        billingRequestId: "req-b4",
        compensate: async (r) => {
          compReasons.push(r);
        },
        onForwarded: (f) => {
          forwardStates.push(f);
        },
      };
      const tracker = createLocalFallbackWireTracker({
        getHandle: () => handle,
        onWireConfirmed: () => {
          confirmed += 1;
        },
      });
      return { tracker, compReasons, forwardStates, getConfirmed: () => confirmed };
    };

    // State A: immediate sync failure / throw before forward
    const sA = makeTracked();
    await sA.tracker.onSyncForwardResult(false, "container_forward_rejected");
    await sA.tracker.onPreForwardAbort("duplicate_should_noop");
    assert.deepEqual(sA.compReasons, ["container_forward_rejected"]);
    assert.equal(sA.getConfirmed(), 0);

    // State B: send returned true synchronously, then deferred async cb(err) fails!
    const sB = makeTracked();
    await sB.tracker.onSyncForwardResult(true);
    assert.deepEqual(sB.compReasons, []);
    // Deferred completion fires with err (simulating deferContainerSendCompletionForTest / async ws.send cb(err))
    sB.tracker.onWireOutcome({ wireSent: false, reason: "container_send_error" });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(sB.compReasons, ["container_send_error"]);
    assert.equal(sB.tracker.isWireSent(), false);
    assert.equal(sB.getConfirmed(), 0);

    // State C: wireSent = true (cb(null)) -> NEVER compensates; subsequent error events are ignored
    const sC = makeTracked();
    await sC.tracker.onSyncForwardResult(true);
    sC.tracker.onWireOutcome({ wireSent: true, reason: "wire_sent" });
    sC.tracker.onWireOutcome({ wireSent: false, reason: "late_noise_ignored" });
    await sC.tracker.onPreForwardAbort("late_abort_ignored");
    assert.deepEqual(sC.compReasons, []);
    assert.equal(sC.tracker.isWireSent(), true);
    assert.equal(sC.getConfirmed(), 1);
    assert.deepEqual(sC.forwardStates, [true]);

    // State D: delivery unknown (send returned true, no cb ever fires) -> NEVER waives/compensates!
    const sD = makeTracked();
    await sD.tracker.onSyncForwardResult(true);
    assert.deepEqual(sD.compReasons, []);
    assert.equal(sD.getConfirmed(), 0);

    // 2) W3: AGY compensation releases inflight + handles recordAntigravityTurn ack-loss readback vs pre-existing replay!
    const snapshot = makeCatalog();
    const agyExec = {
      canonicalModel: "antigravity-gemini-4-neon",
      engine: "antigravity",
      placement: "local" as const,
      pricing: snapshot.billingPricingFor("antigravity-gemini-4-neon")!,
      billingRevision: snapshot.billingRevision,
      executionRevision: snapshot.executionRevision,
      securityEpoch: Number(snapshot.securityEpoch),
    };

    // Case W3-1: `recordAntigravityTurn` writes row to PG, THEN throws (ack lost) -> readback sees pending row owned by this trace -> abandons + releases inflight + expires route!
    const rowsW3 = new Map<string, { userId: string; modelId: string; status: string; traceId: string | null }>();
    const inflightReleasedW3: string[] = [];
    const expiredW3: string[] = [];
    const pgAckLost = {
      query: async (rawSql: string, params: unknown[] = []) => {
        const sql = rawSql.replace(/\s+/g, " ").trim();
        if (sql.includes("SELECT status, model_id, trace_id FROM antigravity_turns")) {
          const r = rowsW3.get(String(params[0]));
          return r && r.userId === String(params[1])
            ? { rows: [{ status: r.status, model_id: r.modelId, trace_id: r.traceId }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("INSERT INTO antigravity_turns")) {
          rowsW3.set(String(params[0]), {
            userId: String(params[1]),
            modelId: String(params[2]),
            status: "pending",
            traceId: params[4] == null ? null : String(params[4]),
          });
          throw new Error("PG_INSERT_ACK_LOST");
        }
        if (sql.startsWith("UPDATE antigravity_turns SET status = 'abandoned'")) {
          const r = rowsW3.get(String(params[0]));
          if (r && r.userId === String(params[1]) && r.status === "pending") {
            r.status = "abandoned";
          }
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;

    const reqAckLost = "55556666777788889999000011112222";
    const resAckLost = await prepareBridgeLocalFallbackTransport({
      localExec: agyExec,
      billingRequestId: reqAckLost,
      uid: 42n,
      containerId: 99,
      peerId: "peer-w3",
      clientMessageId: "cmid-w3",
      promptQueueGrantId: null,
      agentId: "main",
      traceId: "trace-w3-ack-lost",
      parsedCapture: { type: "inbound.message", content: { text: "hi" } },
      enrichedParsed: { type: "inbound.message", content: { text: "hi" } },
      dispatchRecord: undefined,
      recoveryJob: undefined,
      containerHasCodexSpeedTiers: false,
      codexBillingEnabled: true,
      sessionMaxMs: 60_000,
      pgPool: pgAckLost,
      pricing: { get: (id: string) => snapshot.billingPricingFor(id) } as unknown as PricingCache,
      admitAntigravityTurn: async () => ({
        token: "tok-w3-ack-lost",
        baseUrl: "http://127.0.0.1:18789/agy/tok-w3-ack-lost",
        accessToken: "ya29.w3",
        accessTokenExpiresAt: "2026-11-25T16:00:00.000Z",
        idToken: null,
      }),
      expireAntigravityRoute: (tok) => { expiredW3.push(tok); },
      readSpendableBalance: async () => 5000n,
      releaseInflightFn: (reqId) => { inflightReleasedW3.push(reqId); },
      activeCodexTurnsByPeer: new Map(),
      inflightCodexTurns: new Map(),
      pendingAntigravityRelays: new Map(),
      codexPeerKey: (p) => `peer:${p ?? "none"}`,
      isCurrentCodexTurnState: () => true,
      releaseCodexTurnState: () => {},
      expireCodexRouteToken: () => {},
      retryPendingGrokLeaseRelease: () => {},
      modelCheckerHandle: null,
      catalogSnapshot: snapshot,
      isCleaned: () => false,
      log: null,
    });
    assert.equal(resAckLost, null);
    assert.deepEqual(inflightReleasedW3, [reqAckLost], "W3: releaseInflight must be called on AGY compensation");
    assert.deepEqual(expiredW3, ["tok-w3-ack-lost"]);
    assert.equal(
      rowsW3.get(reqAckLost)?.status,
      "abandoned",
      "W3: landed pending row from ack-lost recordAntigravityTurn must be verified and abandoned",
    );

    // Case W3-2: Replay of pre-existing pending row -> compensate releases inflight & expires route WITHOUT abandoning pre-existing row!
    const reqReplay = "66667777888899990000111122223333";
    rowsW3.set(reqReplay, {
      userId: "42",
      modelId: "antigravity-gemini-4-neon",
      status: "pending",
      traceId: "trace-prior-attempt",
    });
    const pgReplay = {
      query: async (rawSql: string, params: unknown[] = []) => {
        const sql = rawSql.replace(/\s+/g, " ").trim();
        if (sql.includes("SELECT status, model_id, trace_id FROM antigravity_turns")) {
          const r = rowsW3.get(String(params[0]));
          return r && r.userId === String(params[1])
            ? { rows: [{ status: r.status, model_id: r.modelId, trace_id: r.traceId }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("INSERT INTO antigravity_turns")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("UPDATE antigravity_turns SET status = 'abandoned'")) {
          const r = rowsW3.get(String(params[0]));
          if (r) r.status = "abandoned";
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    const replayPrepared = await prepareBridgeLocalFallbackTransport({
      localExec: agyExec,
      billingRequestId: reqReplay,
      uid: 42n,
      containerId: 99,
      peerId: "peer-w3",
      clientMessageId: "cmid-w3-replay",
      promptQueueGrantId: null,
      agentId: "main",
      traceId: "trace-replay-attempt",
      parsedCapture: { type: "inbound.message", content: { text: "hi" } },
      enrichedParsed: { type: "inbound.message", content: { text: "hi" } },
      dispatchRecord: undefined,
      recoveryJob: undefined,
      containerHasCodexSpeedTiers: false,
      codexBillingEnabled: true,
      sessionMaxMs: 60_000,
      pgPool: pgReplay,
      pricing: { get: (id: string) => snapshot.billingPricingFor(id) } as unknown as PricingCache,
      admitAntigravityTurn: async () => ({
        token: "tok-w3-replay",
        baseUrl: "http://127.0.0.1:18789/agy/tok-w3-replay",
        accessToken: "ya29.w3r",
        accessTokenExpiresAt: "2026-11-25T16:00:00.000Z",
        idToken: null,
      }),
      expireAntigravityRoute: (tok) => { expiredW3.push(tok); },
      readSpendableBalance: async () => 5000n,
      releaseInflightFn: (reqId) => { inflightReleasedW3.push(reqId); },
      activeCodexTurnsByPeer: new Map(),
      inflightCodexTurns: new Map(),
      pendingAntigravityRelays: new Map(),
      codexPeerKey: (p) => `peer:${p ?? "none"}`,
      isCurrentCodexTurnState: () => true,
      releaseCodexTurnState: () => {},
      expireCodexRouteToken: () => {},
      retryPendingGrokLeaseRelease: () => {},
      modelCheckerHandle: null,
      catalogSnapshot: snapshot,
      isCleaned: () => false,
      log: null,
    });
    assert.ok(replayPrepared !== null);
    await replayPrepared.compensate("container_send_error");
    assert.deepEqual(inflightReleasedW3, [reqAckLost, reqReplay]);
    assert.deepEqual(expiredW3, ["tok-w3-ack-lost", "tok-w3-replay"]);
    assert.equal(
      rowsW3.get(reqReplay)?.status,
      "pending",
      "W3: pre-existing replay row must NOT be abandoned by a later attempt's compensation",
    );

    // Case W3-3: `abandonAntigravityTurn` with `expectedTraceId` enforces SQL trace_id ownership
    let observedTraceSql = "";
    let observedTraceParams: unknown[] = [];
    const pgTraceFence = {
      query: async (rawSql: string, params: unknown[] = []) => {
        observedTraceSql = rawSql.replace(/\s+/g, " ").trim();
        observedTraceParams = params;
        const r = rowsW3.get(String(params[0]));
        if (r && r.userId === String(params[1]) && r.traceId === String(params[2]) && r.status === "pending") {
          r.status = "abandoned";
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    await abandonAntigravityTurn(pgTraceFence, reqReplay, 42n, "trace-other-attempt");
    assert.ok(observedTraceSql.includes("AND trace_id = $3"));
    assert.equal(observedTraceParams[2], "trace-other-attempt");
    assert.equal(rowsW3.get(reqReplay)?.status, "pending", "W3: mismatched traceId must never abandon existing row");
  });

  it("B3+B4 R2-final: operationId mismatch blocks remote re-delivery; handleTurnDispatchReceipt clears pendingInstallMigration; recovery PG-post-handoff failure waits for wire callback", async () => {
    // 1) B4: Recovery task hands frame to WS (`handedOff: true`), then PG COMMIT fails (`accepted=false`),
    //    then late WS callback confirms `wireSent=true` -> MUST NOT compensate early or after wireSent!
    const recCompensations: string[] = [];
    const recHandle: LocalFallbackCommittedHandle = {
      localEngine: "codex",
      compensate: async (r) => { recCompensations.push(r); },
    };
    const recTracker = createLocalFallbackWireTracker({ getHandle: () => recHandle });
    recTracker.onWireOutcome({ wireSent: false, handedOff: true, reason: "transport_handoff" });
    await recTracker.onSyncForwardResult(false, "container_forward_rejected");
    await recTracker.onPreForwardAbort("local_fallback_not_forwarded");
    assert.deepEqual(
      recCompensations,
      [],
      "B4: PG failure after socket handoff must NOT trigger premature compensation",
    );
    recTracker.onWireOutcome({ wireSent: true, reason: "wire_sent" });
    await new Promise((r) => setImmediate(r));
    assert.equal(recTracker.isWireSent(), true);
    assert.deepEqual(recCompensations, [], "B4: late wireSent=true must keep zero compensations");

    // Control: handedOff=true, PG fails, then WS callback returns err (wireSent=false) -> compensates exactly once
    const recErrComp: string[] = [];
    const recErrTracker = createLocalFallbackWireTracker({
      getHandle: () => ({
        localEngine: "antigravity",
        compensate: async (r) => { recErrComp.push(r); },
      }),
    });
    recErrTracker.onWireOutcome({ wireSent: false, handedOff: true, reason: "transport_handoff" });
    await recErrTracker.onSyncForwardResult(false, "container_forward_rejected");
    assert.deepEqual(recErrComp, []);
    recErrTracker.onWireOutcome({ wireSent: false, reason: "container_send_error" });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(recErrComp, ["container_send_error"]);

    // 2) B3: Remote re-delivery rejects mismatched operationId AND real `handleTurnDispatchReceipt`
    //    acceptance clears `pendingInstallMigration` via `buildSelfhostCrossPoolBridgeHooks`.
    const pgPool = new InMemorySealPgPool();
    const snapshot = makeCatalog();
    const uid = 88;
    const sessionKey = "agent:main:webchat:dm:b3-r2-final";
    const store = new PgSessionAuthorityStateStore(pgPool);
    await store.upsertEnginePointer({
      userId: uid,
      sessionKey,
      poolKind: "local_container",
      engine: "codex",
      nativeSessionId: "local-codex-1",
    });
    const hooks = buildSelfhostCrossPoolBridgeHooks({
      isSelfhostV5: true,
      pool: pgPool,
      modelCatalogCache: {
        assertFresh: async () => snapshot,
      },
    });
    assert.ok(hooks.returnToRemoteGrantResolver);
    assert.ok(hooks.markPlacementMigrationInstalled);

    const makeCodexRemoteBackend = (operationId: string): RemoteExecutionBackend => ({
      kind: REMOTE_DRIVER_BACKEND,
      version: 4 as const,
      driverId: "codex",
      driverVersion: "5.0.0",
      engineId: "codex",
      authorityEngine: "codex" as const,
      sessionKey,
      operationId,
      generation: "1",
      profileId: "prof-codex-1",
      authEpoch: "epoch-1",
    });
    const origRemoteBackend = makeCodexRemoteBackend("op-orig-1");
    const firstGrant = await hooks.returnToRemoteGrantResolver!({
      uid,
      containerId: 7,
      sessionKey,
      canonicalModel: "gpt-6.2-astra-remote",
      engine: "codex",
      executionBackend: origRemoteBackend,
      expectedSecurityEpoch: Number(snapshot.securityEpoch),
    });
    assert.ok(firstGrant !== null);

    // Different remote operationId MUST NOT inherit the pending migration grant
    const otherRemoteBackend = makeCodexRemoteBackend("op-brand-new-2");
    const mismatchGrant = await hooks.returnToRemoteGrantResolver!({
      uid,
      containerId: 7,
      sessionKey,
      canonicalModel: "gpt-6.2-astra-remote",
      engine: "codex",
      executionBackend: otherRemoteBackend,
      expectedSecurityEpoch: Number(snapshot.securityEpoch),
    });
    assert.equal(mismatchGrant, null, "B3: new remote operationId must never inherit previous migration grant");

    // Same operationId still gets re-delivery before container receipt
    const retryGrant = await hooks.returnToRemoteGrantResolver!({
      uid,
      containerId: 7,
      sessionKey,
      canonicalModel: "gpt-6.2-astra-remote",
      engine: "codex",
      executionBackend: origRemoteBackend,
      expectedSecurityEpoch: Number(snapshot.securityEpoch),
    });
    assert.equal(retryGrant?.migrationId, firstGrant!.migrationId);

    // Real `handleTurnDispatchReceipt` container acceptance triggers `onDispatchAccepted` -> clears PG mark!
    const receiptPool = {
      query: async (rawSql: string) => {
        const sql = rawSql.replace(/\s+/g, " ").trim();
        if (sql.includes("UPDATE turn_dispatches")) {
          const now = new Date();
          return {
            rows: [{
              trace_id: "trace-b3",
              dispatch_id: "disp-b3-1",
              user_id: String(uid),
              session_id: "peer-b3",
              client_message_id: "11111111-1111-4111-8111-111111111111",
              agent_id: "main",
              model: "gpt-6.2-astra-remote",
              request_hash: "hash-b3",
              billing_request_id: "req-b3",
              attempt_no: 1,
              status: "accepted",
              outcome: null,
              failure_code: null,
              conflict_reason: null,
              resolution: null,
              resolved_at: null,
              client_notified: false,
              owner_id: "owner-1",
              lease_epoch: 1,
              lease_until: now,
              anchor_seq: null,
              admitted_at: now,
              accepted_at: now,
              terminal_at: null,
              last_attempt_at: now,
              visible_head: null,
              visible_at: null,
              producer_fenced_at: null,
              shutdown_ctx: null,
              agent_container_id: 7,
              runtime_kind: "docker",
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    let clearPromise: Promise<boolean> | null = null;
    const cmid = "11111111-1111-4111-8111-111111111111";
    const admittedMap = new Map([
      [
        cmid,
        {
          clientMessageId: cmid,
          sessionId: "peer-b3",
          dispatchId: "disp-b3-1",
          attemptNo: 1,
          leaseEpoch: 1,
          leaseOwnerId: "owner-1",
          pendingMigrationInstall: {
            sessionKey,
            placementEpoch: firstGrant!.placementEpoch,
            migrationId: firstGrant!.migrationId,
          },
        },
      ],
    ]);
    const handled = handleTurnDispatchReceipt(
      JSON.stringify({
        type: "outbound.control.turn_dispatch_receipt",
        clientMessageId: cmid,
        dispatchId: "disp-b3-1",
        attemptNo: 1,
        sessionId: "peer-b3",
        state: "running",
        outcome: null,
      }),
      {
        pool: receiptPool,
        uid: BigInt(uid),
        admittedDispatches: admittedMap,
        enrichmentDispatches: new Map(),
        claimEnrichmentTerminalization: () => true,
        acceptEnrichmentReceipt: () => true,
        dropAdmittedDispatch: (id) => { admittedMap.delete(id); },
        settleCronOriginClaim: () => {},
        hasCronOriginClaim: () => false,
        noteDispatchStreamFrame: () => {},
        onDispatchAccepted: (rec) => {
          if (rec.pendingMigrationInstall && hooks.markPlacementMigrationInstalled) {
            clearPromise = hooks.markPlacementMigrationInstalled({
              uid,
              ...rec.pendingMigrationInstall,
            });
          }
        },
        broadcast: () => {},
        warn: () => {},
      },
    );
    assert.equal(handled, true);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(clearPromise !== null, "B3: container dispatch receipt must trigger markPlacementMigrationInstalled");
    assert.equal(await clearPromise!, true);
    assert.equal(
      extractPendingInstallMigration((await store.getEnginePointer(uid, sessionKey))?.promptCacheMeta),
      null,
    );

    // After container receipt consumed the install mark, re-delivery stops immediately
    const postInstallGrant = await hooks.returnToRemoteGrantResolver!({
      uid,
      containerId: 7,
      sessionKey,
      canonicalModel: "gpt-6.2-astra-remote",
      engine: "codex",
      executionBackend: origRemoteBackend,
      expectedSecurityEpoch: Number(snapshot.securityEpoch),
    });
    assert.equal(postInstallGrant, null, "B3: re-delivery must stop once container receipt confirms install");
  });
});
