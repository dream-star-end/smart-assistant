/** Real PostgreSQL tests for the OCV5-295 e682 operator.
 * Business tables live in pg_temp, or in a dropped ocv5_295_* schema when two
 * sessions must see the same rows. Never public. Production is not written.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  ABANDON_STATE, CONTRAST_CLOCK_GAP_MS, CONTRAST_LEAF_REQUEST_ID, EXPECTED_MANIFEST_SHA256,
  EXPECTED_SCRIPT_SHA256, PINNED_JOURNAL_SHA256,
  PINNED_RELEASE_REALPATH, PINNED_SOURCE_COMMIT, REQUIRED_AUTHORIZATION, TARGET_NONCE,
  advisoryKeys, applyRun, canonicalJson, contrastDigest, loadPrivateManifest, loadRelease,
  nestTransaction, productionResolveArgs, readPinnedProductionProof, sha256, verifyPins,
  type ApplyApproval, type ProofShape, type ReleaseManifest, type RunManifest,
} from "./e682-completed-release.mts";

const RELEASE = PINNED_RELEASE_REALPATH;
const MANIFEST = "/var/lib/docker/volumes/oc-v5-data-u3/_data/generated/ocv5-295-e682-prod-identity-contrast-v2.json";
const RECONCILER = join(RELEASE, "packages/commercial/src/billing/finalizeJournalReconciler.ts");
const SCRIPT = new URL("./e682-completed-release.mts", import.meta.url);

type Db = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
  end: () => Promise<void>;
};

async function pgClient(): Promise<Db> {
  const href = pathToFileURL(join(RELEASE, "node_modules/pg/lib/index.js")).href;
  const loaded = await import(href) as { Client?: new (config: Record<string, unknown>) => Db & { connect: () => Promise<void> };
    default?: { Client: new (config: Record<string, unknown>) => Db & { connect: () => Promise<void> } } };
  const Client = loaded.Client ?? loaded.default?.Client;
  if (!Client) throw new Error("PG_CLIENT_MISSING");
  const db = new Client({
    host: "/var/run/postgresql", port: 55432, database: "openclaude_test",
    user: process.env.OC_OCV5_295_PGUSER ?? "root",
  });
  await db.connect();
  return db;
}

async function createBusiness(db: Db) {
  await db.query(`CREATE TEMP TABLE request_finalize_journal (
    request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint,
    state text NOT NULL, ctx jsonb NOT NULL, dispatch_id text,
    precheck_credits bigint, final_credits bigint, ledger_id bigint, usage_id bigint,
    error_msg text, failure_code text, updated_at timestamptz NOT NULL DEFAULT now())`);
  await db.query(`CREATE TEMP TABLE usage_records (
    id bigint PRIMARY KEY, request_id text NOT NULL, user_id bigint NOT NULL,
    input_tokens int NOT NULL, output_tokens int NOT NULL,
    cache_read_tokens int NOT NULL, cache_write_tokens int NOT NULL,
    cost_credits bigint NOT NULL, ledger_id bigint NOT NULL)`);
  await db.query(`CREATE TEMP TABLE credit_ledger (id bigint PRIMARY KEY, delta bigint NOT NULL)`);
  await db.query(`CREATE TEMP TABLE wallets (id bigint PRIMARY KEY, balance bigint NOT NULL)`);
  await db.query(`CREATE TEMP TABLE turn_dispatches (
    dispatch_id text PRIMARY KEY, status text, lease_until timestamptz)`);
  await db.query(`CREATE OR REPLACE FUNCTION pg_temp.forbid_wallet() RETURNS trigger AS $fn$
    BEGIN RAISE EXCEPTION 'wallet write forbidden'; END $fn$ LANGUAGE plpgsql`);
  await db.query("INSERT INTO wallets(id, balance) VALUES (1, 100)");
  await db.query(`CREATE TRIGGER wallets_no_write BEFORE INSERT OR UPDATE OR DELETE ON wallets
    FOR EACH ROW EXECUTE FUNCTION pg_temp.forbid_wallet()`);
  await db.query("SET search_path TO pg_temp");
}

async function assertOwnSchema(db: Db, expectedPrefix: string) {
  const resolved = await db.query(
    `SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = to_regclass('request_finalize_journal')`);
  assert.equal(resolved.rows.length, 1);
  assert.ok(String(resolved.rows[0].nspname).startsWith(expectedPrefix), resolved.rows[0].nspname);
  assert.notEqual(resolved.rows[0].nspname, "public");
  const named = await db.query("SELECT to_regclass($1) AS rel", [`${resolved.rows[0].nspname}.request_finalize_journal`]);
  assert.ok(named.rows[0].rel);
}

async function withTemp<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = await pgClient();
  try {
    const info = await db.query("SELECT current_database() AS db, current_setting('port') AS port");
    assert.equal(info.rows[0].db, "openclaude_test");
    assert.equal(String(info.rows[0].port), "55432");
    await createBusiness(db);
    await assertOwnSchema(db, "pg_temp");
    return await fn(db);
  } finally { await db.end(); }
}

function codeOf(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "";
}

const basis = {
  model: "box-api-claude-opus-5-5",
  boxInvocationRecovery: "v1",
  boxInvocationMode: "detached_tool",
  billingPricing: { v: 1, modelId: "box-api-claude-opus-5-5", displayName: "Opus",
    inputPerMtok: "1", outputPerMtok: "1", cacheReadPerMtok: "1", cacheWritePerMtok: "1", multiplier: "1" },
};

function proofFor(nonce: string, epoch: string): ProofShape {
  return { cliPid: 297203, keeperPid: 297201, leaseEpoch: epoch, reason: "worker_complete", revision: 1, runNonce: nonce };
}

function makeRun(suffix: string) {
  const nonce = randomBytes(12).toString("hex");
  const epoch = randomBytes(16).toString("hex");
  const requestId = randomBytes(16).toString("hex");
  const ledgerId = String(700_000_000 + Number(randomBytes(3).readUIntBE(0, 3) % 1_000_000));
  const usageId = String(800_000_000 + Number(randomBytes(3).readUIntBE(0, 3) % 1_000_000));
  const sessionId = `session-${suffix}`;
  const turnKey = "ab".repeat(32);
  const ctx = {
    ...basis,
    boxBillingContext: { v: 1, sessionId, mode: "chat", parentSessionId: null, delegateAgentId: null,
      turnKey, parentTurnKey: null, authority: null, dispatchId: null, attemptNo: null,
      verificationSponsorship: null, apiKeyId: null },
    boxAccountId: "20", boxRunNonce: nonce, boxLeaseEpoch: epoch, boxSessionId: sessionId,
    boxTurnKey: turnKey, boxCatalogHash: "cd".repeat(32), boxDetachedRunnerHash: "ef".repeat(32),
    boxState: "handoff", boxLaunchPermit: true,
    boxReplayFingerprint: "11".repeat(32), boxFallbackAlias: "22".repeat(32),
    boxRequestHash: "33".repeat(32), boxContextHash: "44".repeat(32),
    boxHandoffRevision: "95cc997f-61ae-4109-8572-57b32fe794fe",
    boxToolHandoff: { version: 1, roundNo: 1, messageId: "msg_settled",
      usage: { inputTokens: 2, outputTokens: 236, cacheReadTokens: 0, cacheWriteTokens: 26075 } },
    boxReplayMessage: { version: 1, uid: "3", requestId, runNonce: nonce, leaseEpoch: epoch,
      roundNo: 1, bytes: 10, sha256: "66".repeat(32) },
    boxNativeSessionId: "12345678-1234-4123-8123-123456789abc",
    boxNativeCliCwd: `/tmp/ocv5-289-run-${nonce}`,
  };
  const run: RunManifest = {
    uid: "3", accountId: "20", nonce, epoch, requestId, containerId: "534",
    sessionId, turnKey, model: "box-api-claude-opus-5-5",
    catalogHash: ctx.boxCatalogHash, runnerHash: ctx.boxDetachedRunnerHash,
    replayFingerprint: ctx.boxReplayFingerprint, fallbackAlias: ctx.boxFallbackAlias,
    handoffRevision: ctx.boxHandoffRevision, handoffRound: 1,
    originalCtxSha256: sha256(canonicalJson(ctx)),
    financial: { precheckCredits: "514", finalCredits: "22", ledgerId, usageId },
    settled: { inputTokens: 2, outputTokens: 236, cacheReadTokens: 0, cacheWriteTokens: 26075,
      costCredits: "22", ledgerId, ledgerDelta: "-22" },
    unsettled: { stopReason: "end_turn", preserved: true, backfill: false },
    spool: { bytes: 107804, sha256: "00ca303216b3883acfdf6159fc6f9712f5b9136228a566104add08709dad2e6e" },
    reuseCancelIntent: false,
  };
  return { run, ctx, proof: proofFor(nonce, epoch) };
}

async function insertTarget(db: Db, made: ReturnType<typeof makeRun>) {
  await db.query(
    `INSERT INTO request_finalize_journal(request_id, user_id, container_id, state, ctx,
       precheck_credits, final_credits, ledger_id, usage_id)
     VALUES ($1, 3, $2, 'committed', $3::jsonb, $4, $5, $6, $7)`,
    [made.run.requestId, made.run.containerId, JSON.stringify(made.ctx),
      made.run.financial.precheckCredits, made.run.financial.finalCredits,
      made.run.financial.ledgerId, made.run.financial.usageId]);
  await db.query(
    `INSERT INTO usage_records(id, request_id, user_id, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, cost_credits, ledger_id)
     VALUES ($1, $2, 3, $3, $4, $5, $6, $7, $8)`,
    [made.run.financial.usageId, made.run.requestId, made.run.settled.inputTokens,
      made.run.settled.outputTokens, made.run.settled.cacheReadTokens,
      made.run.settled.cacheWriteTokens, made.run.settled.costCredits, made.run.settled.ledgerId]);
  await db.query("INSERT INTO credit_ledger(id, delta) VALUES ($1, $2)",
    [made.run.settled.ledgerId, made.run.settled.ledgerDelta]);
}

async function insertContrast(db: Db, count: number) {
  const nonce = randomBytes(12).toString("hex");
  for (let i = 0; i < count; i += 1) {
    const id = `c${String(i).padStart(4, "0")}${randomBytes(4).toString("hex")}`;
    await db.query(
      `INSERT INTO request_finalize_journal(request_id, user_id, container_id, state, ctx,
         precheck_credits, final_credits, ledger_id, usage_id)
       VALUES ($1, 3, 1, 'committed', $2::jsonb, 1, 1, $3, $4)`,
      [id, JSON.stringify({ boxRunNonce: nonce, boxAccountId: "20", boxState: "terminal", n: i }),
        300000 + i, 400000 + i]);
    await db.query(
      `INSERT INTO usage_records(id, request_id, user_id, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_credits, ledger_id)
       VALUES ($1, $2, 3, 1, 1, 0, 0, 1, $3)`,
      [400000 + i, id, 300000 + i]);
    await db.query("INSERT INTO credit_ledger(id, delta) VALUES ($1, -1)", [300000 + i]);
  }
  return nonce;
}

async function manifestOf(db: Db, schema: "pg_temp" | `ocv5_295_${string}`, made: ReturnType<typeof makeRun>, contrastNonce: string, contrastCount: number): Promise<ReleaseManifest> {
  return {
    v: 1,
    sourceCommit: PINNED_SOURCE_COMMIT,
    releaseRealpath: PINNED_RELEASE_REALPATH,
    journalSha256: PINNED_JOURNAL_SHA256,
    authorization: { v: 1, statement: REQUIRED_AUTHORIZATION, ticket: "OCV5-295" },
    run: made.run,
    contrast: { nonce: contrastNonce, rowCount: contrastCount, sha256: await contrastDigest(db, schema, "3", contrastNonce) },
    proof: made.proof,
  };
}

const approvalFor = (run: RunManifest): ApplyApproval => ({
  approvedSha: PINNED_SOURCE_COMMIT,
  operationId: "ocv5-295-0123456789abcdef",
  nonce: run.nonce,
});

async function finance(db: Db) {
  const usage = await db.query("SELECT md5(string_agg(row(usage_records)::text, ',' ORDER BY id)) AS hash FROM usage_records");
  const ledger = await db.query("SELECT md5(string_agg(row(credit_ledger)::text, ',' ORDER BY id)) AS hash FROM credit_ledger");
  const wallet = await db.query("SELECT balance::text FROM wallets");
  return { usage: usage.rows, ledger: ledger.rows, wallet: wallet.rows };
}

test("pins match the ae5 release, script, and private manifest", async () => {
  verifyPins();
  assert.equal(EXPECTED_SCRIPT_SHA256.length, 64);
  const manifest = loadPrivateManifest(MANIFEST);
  assert.equal(manifest.run.nonce, TARGET_NONCE);
  assert.equal(manifest.run.requestId, "ed263edbf8dd0f8ff393adc20935d95f");
  assert.equal(manifest.run.containerId, "534");
  assert.equal(manifest.contrast.rowCount, 46);
  assert.equal(manifest.contrast.leafRequestId, CONTRAST_LEAF_REQUEST_ID);
  assert.equal(manifest.contrast.historicalAggregateSha256, "729cfefb106000bd79a92994697b750583a4b9f4ad4e8fa4d21322584f64b599");
  assert.equal(manifest.contrast.clockFloor?.boxStopProbeAfterMs! - manifest.contrast.clockFloor?.boxStopProbeLastAttemptMs!, CONTRAST_CLOCK_GAP_MS);
  assert.equal(manifest.contrast.rows?.length, 46);
  assert.equal(manifest.proof.reason, "worker_complete");
  assert.equal(manifest.proof.cliPid, 297203);
  assert.equal(manifest.proof.keeperPid, 297201);
  assert.equal(manifest.proof.revision, 1);
  assert.equal(manifest.run.financial.finalCredits, "22");
  assert.equal(manifest.run.settled.ledgerDelta, "-22");
  assert.equal(manifest.run.spool.bytes, 107804);
  assert.equal(Object.hasOwn(manifest.run.originalCtx ?? {}, "durableBillingRecovery"), false);
  const loaded = await loadRelease();
  assert.ok(loaded.href.journalHref.includes("rel-ae5e6cfaa-20260929-071146"));
  assert.equal(createHash("sha256").update(readFileSync(MANIFEST)).digest("hex"), EXPECTED_MANIFEST_SHA256);
});

test("positive single row, 45-row contrast, finance, and operation id", { timeout: 120_000 }, async () => {
  await withTemp(async (db) => {
    const made = makeRun("pos");
    const contrastNonce = await insertContrast(db, 45);
    await insertTarget(db, made);
    const manifest = await manifestOf(db, "pg_temp", made, contrastNonce, 45);
    const before = await finance(db);
    let receipts = 0;
    const first = await applyRun(db, "pg_temp", manifest, approvalFor(made.run), {
      freshProof: made.proof,
      writeReceipt: () => { receipts += 1; },
    });
    assert.equal(first.status, "applied");
    assert.equal(receipts, 1);
    const row = await db.query<{ box: string; state: string; live: boolean; fp: string; pre: string; fin: string; op: string }>(
      `SELECT state, ctx->>'boxState' AS box, (ctx ? 'boxToolHandoff') AS live,
         ctx->>'boxReplayFingerprint' AS fp, precheck_credits::text AS pre, final_credits::text AS fin,
         ctx->'boxOperatorAudit'->>'operationId' AS op
       FROM request_finalize_journal WHERE request_id = $1`, [made.run.requestId]);
    assert.equal(row.rows[0].state, "committed");
    assert.equal(row.rows[0].box, ABANDON_STATE);
    assert.equal(row.rows[0].live, false);
    assert.equal(row.rows[0].fp, made.run.replayFingerprint);
    assert.equal(row.rows[0].pre, "514");
    assert.equal(row.rows[0].fin, "22");
    assert.equal(row.rows[0].op, approvalFor(made.run).operationId);
    const stamped = await db.query("SELECT updated_at FROM request_finalize_journal WHERE request_id = $1", [made.run.requestId]);
    const again = await applyRun(db, "pg_temp", manifest, approvalFor(made.run), { freshProof: made.proof });
    assert.equal(again.status, "already_applied");
    const restamp = await db.query("SELECT updated_at FROM request_finalize_journal WHERE request_id = $1", [made.run.requestId]);
    assert.deepEqual(restamp.rows, stamped.rows);
    await assert.rejects(() => applyRun(db, "pg_temp", manifest, {
      ...approvalFor(made.run), operationId: "ocv5-295-ffffffffffffffff",
    }, { freshProof: made.proof }), (error: unknown) => codeOf(error) === "OPID_MISMATCH");
    assert.deepEqual(await finance(db), before);
    assert.equal((await contrastDigest(db, "pg_temp", "3", contrastNonce)), manifest.contrast.sha256);
    const loaded = await loadRelease();
    const journal = new loaded.mod.BoxDurableJournal({
      connect: async () => ({ query: db.query.bind(db), release() {} }),
      query: db.query.bind(db),
    });
    const cleanup = await journal.listRemoteCleanupCandidates(10);
    assert.equal(cleanup.some((item: { runNonce?: string }) => item.runNonce === made.run.nonce), false);
    const probes = await journal.listStoppedFailureProbeCandidates(10);
    assert.equal(probes.some((item: { runNonce?: string }) => item.runNonce === made.run.nonce), false);
    const native = await journal.listNativeGcCandidates(10);
    assert.equal(native.some((item: { requestId?: string }) => item.requestId === made.run.requestId), false);
  });
});

test("wrong identity, proof, revision, reverse reference, and successor write nothing", { timeout: 120_000 }, async () => {
  await withTemp(async (db) => {
    const made = makeRun("bad");
    const contrastNonce = await insertContrast(db, 45);
    await insertTarget(db, made);
    const manifest = await manifestOf(db, "pg_temp", made, contrastNonce, 45);
    const before = await db.query("SELECT request_id, state, md5(ctx::text) AS ctx, updated_at FROM request_finalize_journal ORDER BY request_id");
    const cases: Array<() => Promise<unknown>> = [
      () => applyRun(db, "pg_temp", manifest, approvalFor(made.run), { freshProof: { ...made.proof, cliPid: 1 } }),
      () => applyRun(db, "pg_temp", { ...manifest, run: { ...made.run, containerId: "999" } }, approvalFor(made.run), { freshProof: made.proof }),
      () => applyRun(db, "pg_temp", { ...manifest, run: { ...made.run, handoffRevision: randomUUID() } }, approvalFor(made.run), { freshProof: made.proof }),
      () => applyRun(db, "pg_temp", { ...manifest, run: { ...made.run, originalCtxSha256: "ab".repeat(32) } }, approvalFor(made.run), { freshProof: made.proof }),
    ];
    for (const attempt of cases) {
      await assert.rejects(attempt);
      assert.deepEqual((await db.query("SELECT request_id, state, md5(ctx::text) AS ctx, updated_at FROM request_finalize_journal ORDER BY request_id")).rows, before.rows);
    }
    await db.query(
      `INSERT INTO request_finalize_journal(request_id, user_id, container_id, state, ctx)
       VALUES ('reverse-row', 3, 1, 'committed', $1::jsonb)`,
      [JSON.stringify({ boxOwnerRequestId: made.run.requestId, boxState: "linked", boxRunNonce: "aa".repeat(12) })]);
    await assert.rejects(() => applyRun(db, "pg_temp", manifest, approvalFor(made.run), { freshProof: made.proof }),
      (error: unknown) => codeOf(error) === "SUCCESSOR_PRESENT");
    const intent = await db.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE ctx ? 'boxCancelIntent'");
    assert.equal(intent.rows[0].n, 0);
    await db.query("DELETE FROM request_finalize_journal WHERE request_id = 'reverse-row'");
    await db.query(
      `INSERT INTO request_finalize_journal(request_id, user_id, container_id, state, ctx)
       VALUES ('successor-row', 3, 534, 'committed', $1::jsonb)`,
      [JSON.stringify({ ...made.ctx, boxState: "linked", boxOwnerRequestId: made.run.requestId })]);
    await assert.rejects(() => applyRun(db, "pg_temp", manifest, approvalFor(made.run), { freshProof: made.proof }),
      (error: unknown) => codeOf(error) === "SUCCESSOR_PRESENT");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE ctx ? 'boxCancelIntent'")).rows[0].n, 0);
    const dual = makeRun("dual");
    dual.ctx.durableBillingRecovery = "lossless_turn_tape_v2";
    dual.run.originalCtxSha256 = sha256(canonicalJson(dual.ctx));
    await insertTarget(db, dual);
    const dualManifest = await manifestOf(db, "pg_temp", dual, contrastNonce, 45);
    await assert.rejects(() => applyRun(db, "pg_temp", dualManifest, approvalFor(dual.run), { freshProof: dual.proof }),
      (error: unknown) => codeOf(error) === "DURABLE_MARKER");
    assert.equal((await db.query("SELECT ctx ? 'durableBillingRecovery' AS marked FROM request_finalize_journal WHERE request_id=$1", [dual.run.requestId])).rows[0].marked, true);
  });
});

test("CAS rollback removes the intent; commit response is not success", { timeout: 120_000 }, async () => {
  await withTemp(async (db) => {
    const made = makeRun("cas");
    const contrastNonce = await insertContrast(db, 1);
    await insertTarget(db, made);
    const manifest = await manifestOf(db, "pg_temp", made, contrastNonce, 1);
    const before = await db.query("SELECT md5(ctx::text) AS ctx FROM request_finalize_journal WHERE request_id=$1", [made.run.requestId]);
    let receipts = 0;
    await assert.rejects(() => applyRun(db, "pg_temp", manifest, approvalFor(made.run), {
      freshProof: made.proof,
      beforeCas: async () => {
        await db.query("UPDATE request_finalize_journal SET ctx = ctx || '{\"tamper\":true}'::jsonb WHERE request_id=$1", [made.run.requestId]);
      },
      writeReceipt: () => { receipts += 1; },
    }), (error: unknown) => codeOf(error) === "CAS_LOST");
    assert.equal(receipts, 0);
    assert.deepEqual((await db.query("SELECT md5(ctx::text) AS ctx FROM request_finalize_journal WHERE request_id=$1", [made.run.requestId])).rows, before.rows);
  });
});

test("transaction adapter keeps the outer lock and rejects unknown statements", { timeout: 60_000 }, async () => {
  const outer = await pgClient();
  const other = await pgClient();
  try {
    await outer.query("BEGIN");
    const nested = nestTransaction(outer);
    await nested.query("BEGIN");
    await nested.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", ["box:session:3:ocv5-295-adapter"]);
    await nested.query("COMMIT");
    await other.query("SET lock_timeout = '300ms'");
    await assert.rejects(() => other.query("SELECT pg_advisory_lock(hashtextextended($1::text, 0))", ["box:session:3:ocv5-295-adapter"]));
    await assert.rejects(() => nested.query("START TRANSACTION"), (error: unknown) => codeOf(error) === "TX_ADAPTER_FAIL_CLOSED");
    const held = await outer.query(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND granted AND pid=pg_backend_pid()");
    assert.ok(held.rows[0].n >= 1);
    await outer.query("ROLLBACK");
  } finally {
    await other.end();
    await outer.end();
  }
});

test("resolver fence rejects wake and container impersonation", async () => {
  const args = productionResolveArgs(new AbortController().signal);
  assert.equal(args.allowWakeIfHibernated, false);
  assert.equal(args.requiredAccountId, 20n);
  assert.equal("containerId" in args, false);
  const proof = proofFor(TARGET_NONCE, "576099aacf2ed8fc91080de887ef5769");
  const parsed = await readPinnedProductionProof(proof.leaseEpoch, {
    resolve: async (input) => {
      assert.equal(input.allowWakeIfHibernated, false);
      assert.equal(input.requiredAccountId, 20n);
      return { accountId: 20n, exec: { async run() { return { stdout: `${JSON.stringify(proof)}\n` }; } } };
    },
  });
  assert.equal(parsed.reason, "worker_complete");
  assert.equal(parsed.cliPid, 297203);
});

test("advisory lock order is account, fingerprint, then session", () => {
  const keys = advisoryKeys({ accountId: "20", fingerprints: ["bb".repeat(32), "aa".repeat(32)], uid: "3", sessionId: "session-z" });
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(keys[0], "box:account:20");
  assert.ok(keys[1]!.includes("aa"));
  assert.ok(keys.at(-1)!.startsWith("box:session:"));
});

async function withSchema<T>(fn: (schema: string, admin: Db) => Promise<T>): Promise<T> {
  const admin = await pgClient();
  const schema = `ocv5_295_${randomBytes(4).toString("hex")}`;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint,
      state text NOT NULL, ctx jsonb NOT NULL, dispatch_id text,
      precheck_credits bigint, final_credits bigint, ledger_id bigint, usage_id bigint,
      error_msg text, failure_code text, updated_at timestamptz NOT NULL DEFAULT now())`);
    await admin.query(`CREATE TABLE ${schema}.usage_records (
      id bigint PRIMARY KEY, request_id text NOT NULL, user_id bigint NOT NULL,
      input_tokens int NOT NULL DEFAULT 0, output_tokens int NOT NULL DEFAULT 0,
      cache_read_tokens int NOT NULL DEFAULT 0, cache_write_tokens int NOT NULL DEFAULT 0,
      cost_credits bigint NOT NULL DEFAULT 0, ledger_id bigint)`);
    await admin.query(`CREATE TABLE ${schema}.credit_ledger (id bigint PRIMARY KEY, delta bigint NOT NULL)`);
    await admin.query(`CREATE TABLE ${schema}.turn_dispatches (
      dispatch_id text PRIMARY KEY, status text, lease_until timestamptz)`);
    return await fn(schema, admin);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

test("commit lost-response is verified by an independent read; a failed commit rolls back", { timeout: 120_000 }, async () => {
  await withSchema(async (schema, admin) => {
    const a = await pgClient();
    const reader = await pgClient();
    try {
      await a.query(`SET search_path TO ${schema}`);
      await reader.query(`SET search_path TO ${schema}`);
      await assertOwnSchema(a, schema);
      const made = makeRun("commit");
      const contrastNonce = await insertContrast(a, 1);
      await insertTarget(a, made);
      const manifest = await manifestOf(a, schema as `ocv5_295_${string}`, made, contrastNonce, 1);
      let commitCalls = 0;
      const wrapped = {
        async query(sql: string, params?: unknown[]) {
          if (sql === "COMMIT") {
            commitCalls += 1;
            await a.query("COMMIT");
            throw new Error("response lost");
          }
          return a.query(sql, params);
        },
      };
      const lost = await applyRun(wrapped, schema as "pg_temp", manifest, approvalFor(made.run), {
        freshProof: made.proof,
        readIndependently: async () => (await reader.query(
          `SELECT request_id, user_id::text, container_id::text, state,
             precheck_credits::text, final_credits::text, ledger_id::text, usage_id::text, ctx
           FROM request_finalize_journal WHERE ctx->>'boxRunNonce' = $1`, [made.run.nonce])).rows,
      });
      assert.equal(lost.verifiedAfterCommitError, true);
      assert.equal(lost.status, "already_applied");
      assert.equal((await reader.query("SELECT ctx->>'boxState' AS box FROM request_finalize_journal WHERE request_id=$1", [made.run.requestId])).rows[0].box, ABANDON_STATE);
      const made2 = makeRun("nocommit");
      await insertTarget(a, made2);
      const manifest2 = await manifestOf(a, schema as `ocv5_295_${string}`, made2, contrastNonce, 1);
      const wrapped2 = {
        async query(sql: string, params?: unknown[]) {
          if (sql === "COMMIT") throw new Error("not sent");
          return a.query(sql, params);
        },
      };
      await assert.rejects(() => applyRun(wrapped2, schema as "pg_temp", manifest2, approvalFor(made2.run), {
        freshProof: made2.proof,
        readIndependently: async () => (await reader.query(
          `SELECT request_id, user_id::text, container_id::text, state,
             precheck_credits::text, final_credits::text, ledger_id::text, usage_id::text, ctx
           FROM request_finalize_journal WHERE ctx->>'boxRunNonce' = $1`, [made2.run.nonce])).rows,
      }), (error: unknown) => codeOf(error) === "COMMIT_UNCONFIRMED");
      assert.equal((await reader.query("SELECT ctx->>'boxState' AS box, ctx ? 'boxCancelIntent' AS intent FROM request_finalize_journal WHERE request_id=$1", [made2.run.requestId])).rows[0].box, "handoff");
      assert.equal((await reader.query("SELECT ctx ? 'boxCancelIntent' AS intent FROM request_finalize_journal WHERE request_id=$1", [made2.run.requestId])).rows[0].intent, false);
      assert.ok(commitCalls >= 1);
    } finally {
      await a.end();
      await reader.end();
    }
  });
});

test("resume and abandon race: first winner is exclusive and does not deadlock", { timeout: 180_000 }, async () => {
  await withSchema(async (schema) => {
    const a = await pgClient();
    const b = await pgClient();
    try {
      await a.query(`SET search_path TO ${schema}`);
      await b.query(`SET search_path TO ${schema}`);
      await b.query("SET lock_timeout = '4s'");
      await assertOwnSchema(a, schema);
      const loaded = await loadRelease();
      const fp = await import(pathToFileURL(join(RELEASE, "packages/commercial/src/http/proxy/boxCallFingerprint.ts")).href);
      const catalogMod = await import(pathToFileURL(join(RELEASE, "packages/commercial/src/http/proxy/boxToolCatalog.ts")).href);
      const replayMod = await import(pathToFileURL(join(RELEASE, "packages/commercial/src/http/proxy/boxReplayCompleted.ts")).href);
      async function buildHandoff(tag: string) {
        const suffix = `${tag}${randomBytes(2).toString("hex")}`;
        const sessionId = `session-${suffix}`;
        const turnKey = "a".repeat(64);
        const toolDeclarations = [{ name: "local_echo", description: "local-only",
          input_schema: { type: "object", properties: { value: { type: "string" } } } }];
        const firstBody = { model: "box-api-claude-opus-5-5", max_tokens: 128, stream: true,
          tools: toolDeclarations,
          metadata: { user_id: JSON.stringify({ oc_turn_key: turnKey, session_id: sessionId }) },
          messages: [{ role: "user", content: `synthetic ${suffix}` }] };
        const catalogHash = catalogMod.compileBoxToolCatalog(toolDeclarations).bindingSha256;
        const ownerId = `owner${suffix}`.slice(0, 32);
        const nonce = randomBytes(12).toString("hex");
        const epoch = randomBytes(16).toString("hex");
        const billing = { ...basis, boxBillingContext: { v: 1, sessionId, mode: "chat", parentSessionId: null,
          delegateAgentId: null, turnKey, parentTurnKey: null, authority: null, dispatchId: null,
          attemptNo: null, verificationSponsorship: null, apiKeyId: null } };
        await a.query(`INSERT INTO request_finalize_journal(request_id, user_id, state, ctx) VALUES ($1, 3, 'inflight', $2::jsonb)`,
          [ownerId, JSON.stringify(billing)]);
        const setup = new loaded.mod.BoxDurableJournal({
          connect: async () => ({ query: a.query.bind(a), release() {} }),
          query: a.query.bind(a),
        });
        const ledgerId = String(810_000_000 + Number(randomBytes(2).readUInt16BE(0)));
        const usageId = String(910_000_000 + Number(randomBytes(2).readUInt16BE(0)));
        const admitted = {
          requestId: ownerId, uid: 3n, accountId: 20n, model: firstBody.model,
          invocationMode: "detached_tool" as const,
          contextHash: fp.deriveBoxContextHash(firstBody),
          detachedRunnerHash: "f".repeat(64), catalogHash,
          fingerprint: fp.deriveBoxCallFingerprint(3n, firstBody),
          runNonce: nonce, leaseEpoch: epoch,
          nativeStart: { sessionId: "12345678-1234-4123-8123-123456789abc", cliCwd: `/tmp/ocv5-289-run-${nonce}` },
        };
        await setup.admit({ ...admitted, canonicalBody: firstBody });
        await setup.markRunning(admitted);
        const toolUses = [
          { id: "toolu_A", boxName: "mcp__ocbridge__t0", clientName: "local_echo", input: { value: "one" } },
          { id: "toolu_B", boxName: "mcp__ocbridge__t0", clientName: "local_echo", input: { value: "two" } },
        ];
        const assistant = [
          { type: "thinking", thinking: "synthetic", signature: "synthetic-signature" },
          { type: "text", text: "Box said A before calling tools" },
          ...toolUses.map((use) => ({ type: "tool_use", id: use.id, name: use.clientName, input: use.input, caller: { type: "provider_only" } })),
        ];
        await setup.recordToolHandoff({
          ...admitted,
          candidate: { messageId: "msg_box_tool_1", toolUses,
            assistantContentHash: fp.hashBoxAssistantContent(assistant),
            assistantEchoHash: fp.hashBoxAssistantEchoContent(assistant),
            assistantNoCallerHash: fp.hashBoxAssistantNoCallerContent(assistant),
            inputTokens: 7, outputTokens: 11, cacheReadTokens: 2, cacheWriteTokens: 0 },
          spoolOffset: 1234, detachedRunnerHash: "f".repeat(64), catalogHash,
          verifiedPendingToolUseIds: ["toolu_A"],
        });
        await a.query(
          `UPDATE request_finalize_journal SET state='committed', container_id=534,
             precheck_credits=514, final_credits=22, ledger_id=$2, usage_id=$3
           WHERE request_id=$1`, [ownerId, ledgerId, usageId]);
        await a.query(`INSERT INTO usage_records(id, request_id, user_id, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cost_credits, ledger_id)
          VALUES ($2, $1, 3, 2, 236, 0, 26075, 22, $3)`, [ownerId, usageId, ledgerId]);
        await a.query("INSERT INTO credit_ledger(id, delta) VALUES ($1, -22)", [ledgerId]);
        await a.query(`UPDATE request_finalize_journal SET ctx = ctx || $2::jsonb
          WHERE request_id=$1 AND NOT (ctx ? 'boxReplayMessage')`,
          [ownerId, JSON.stringify({ boxReplayMessage: { version: 1, uid: "3", requestId: ownerId,
            runNonce: nonce, leaseEpoch: epoch, roundNo: 1, bytes: 16, sha256: "66".repeat(32) } })]);
        const stored = await a.query("SELECT ctx FROM request_finalize_journal WHERE request_id=$1", [ownerId]);
        const ctx = stored.rows[0].ctx;
        const run: RunManifest = {
          uid: "3", accountId: "20", nonce, epoch, requestId: ownerId, containerId: "534",
          sessionId, turnKey, model: "box-api-claude-opus-5-5",
          catalogHash: String(ctx.boxCatalogHash), runnerHash: String(ctx.boxDetachedRunnerHash),
          replayFingerprint: String(ctx.boxReplayFingerprint), fallbackAlias: String(ctx.boxFallbackAlias),
          handoffRevision: String(ctx.boxHandoffRevision),
          handoffRound: Number(ctx.boxToolHandoff.roundNo),
          originalCtxSha256: sha256(canonicalJson(ctx)),
          financial: { precheckCredits: "514", finalCredits: "22", ledgerId, usageId },
          settled: { inputTokens: 2, outputTokens: 236, cacheReadTokens: 0, cacheWriteTokens: 26075,
            costCredits: "22", ledgerId, ledgerDelta: "-22" },
          unsettled: { stopReason: "end_turn", preserved: true, backfill: false },
          spool: { bytes: 107804, sha256: "ab".repeat(32) },
          reuseCancelIntent: false,
        };
        const resumeBody = { ...firstBody, messages: [...firstBody.messages,
          { role: "assistant", content: [assistant[0], assistant[1], ...toolUses.map((use) => ({
            type: "tool_use", id: use.id, name: use.clientName, input: use.input }))] },
          { role: "user", content: [
            { type: "tool_result", tool_use_id: "toolu_B", content: "second" },
            { type: "tool_result", tool_use_id: "toolu_A", content: "first" },
          ] }] };
        return { run, ctx, firstBody, resumeBody, ownerId, suffix, nonce };
      }
      const contrastNonce = await insertContrast(a, 45);
      const winner = await buildHandoff("win");
      const childId = `race${winner.suffix}`.slice(0, 32);
      await a.query(`INSERT INTO request_finalize_journal(request_id, user_id, state, ctx) VALUES ($1, 3, 'inflight', $2::jsonb)`,
        [childId, JSON.stringify({ ...basis, boxBillingContext: { v: 1, sessionId: winner.run.sessionId, mode: "chat",
          turnKey: winner.run.turnKey, parentSessionId: null, delegateAgentId: null, parentTurnKey: null,
          authority: null, dispatchId: null, attemptNo: null, verificationSponsorship: null, apiKeyId: null } })]);
      const resumeJournal = new loaded.mod.BoxDurableJournal({
        connect: async () => ({ query: b.query.bind(b), release() {} }),
        query: b.query.bind(b),
      });
      await resumeJournal.claimToolResume({
        requestId: childId, uid: 3n, canonicalModel: winner.firstBody.model, canonicalBody: winner.resumeBody,
      });
      const manifest = {
        v: 1 as const, sourceCommit: PINNED_SOURCE_COMMIT, releaseRealpath: PINNED_RELEASE_REALPATH,
        journalSha256: PINNED_JOURNAL_SHA256,
        authorization: { v: 1 as const, statement: REQUIRED_AUTHORIZATION, ticket: "OCV5-295" as const },
        run: winner.run,
        contrast: { nonce: contrastNonce, rowCount: 45, sha256: await contrastDigest(a, schema as "pg_temp", "3", contrastNonce) },
        proof: proofFor(winner.nonce, winner.run.epoch),
      };
      await assert.rejects(() => applyRun(a, schema as "pg_temp", manifest, approvalFor(winner.run), { freshProof: manifest.proof }),
        (error: unknown) => codeOf(error) === "SUCCESSOR_PRESENT");
      assert.equal((await a.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE ctx ? 'boxCancelIntent'")).rows[0].n, 0);
      await a.query(`UPDATE request_finalize_journal SET ctx = jsonb_set(ctx, '{boxState}', '"terminal"')
        WHERE ctx->>'boxRunNonce' = $1`, [winner.nonce]);

      const second = await buildHandoff("abd");
      const manifest2 = {
        ...manifest, run: second.run, proof: proofFor(second.nonce, second.run.epoch),
      };
      const child2 = `kid${second.suffix}`.slice(0, 32);
      await a.query(`INSERT INTO request_finalize_journal(request_id, user_id, state, ctx) VALUES ($1, 3, 'inflight', $2::jsonb)`,
        [child2, JSON.stringify({ ...basis, boxBillingContext: { v: 1, sessionId: second.run.sessionId, mode: "chat",
          turnKey: second.run.turnKey, parentSessionId: null, delegateAgentId: null, parentTurnKey: null,
          authority: null, dispatchId: null, attemptNo: null, verificationSponsorship: null, apiKeyId: null } })]);
      const occupiedNonce = randomBytes(12).toString("hex");
      await a.query(`INSERT INTO request_finalize_journal(request_id, user_id, state, ctx) VALUES ('occupied-run', 3, 'committed', $1::jsonb)`,
        [JSON.stringify({ boxState: "handoff", boxAccountId: "20", boxRunNonce: occupiedNonce,
          boxLeaseEpoch: "c".repeat(32), boxSessionId: "session-occupied" })]);
      const freshSession = `session-new-${second.suffix}`;
      const freshTurn = "b".repeat(64);
      const freshBody = { ...second.firstBody, metadata: { user_id: JSON.stringify({ oc_turn_key: freshTurn, session_id: freshSession }) },
        messages: [{ role: "user", content: "synthetic new request" }] };
      await a.query(`INSERT INTO request_finalize_journal(request_id, user_id, state, ctx) VALUES ('fresh-ok', 3, 'inflight', $1::jsonb)`,
        [JSON.stringify({ ...basis, boxBillingContext: { v: 1, sessionId: freshSession, mode: "chat", turnKey: freshTurn,
          parentSessionId: null, delegateAgentId: null, parentTurnKey: null, authority: null, dispatchId: null,
          attemptNo: null, verificationSponsorship: null, apiKeyId: null } })]);
      const capped = new loaded.mod.BoxDurableJournal({
        connect: async () => ({ query: a.query.bind(a), release() {} }), query: a.query.bind(a),
      }, () => 2);
      await assert.rejects(() => capped.admit({
        requestId: "fresh-ok", uid: 3n, accountId: 20n, model: freshBody.model,
        fingerprint: fp.deriveBoxCallFingerprint(3n, freshBody), canonicalBody: freshBody,
        runNonce: "1".repeat(24), leaseEpoch: "2".repeat(32), invocationMode: "text",
      }), (error: unknown) => codeOf(error) === "BOX_CAPACITY_HELD");
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
      let seenLock = false;
      const abandon = applyRun(a, schema as "pg_temp", manifest2, approvalFor(second.run), {
        freshProof: manifest2.proof,
        afterIntent: async () => {
          seenLock = true;
          await b.query("SET lock_timeout = '300ms'");
          await assert.rejects(() => b.query("SELECT pg_advisory_lock(hashtextextended($1::text, 0))",
            [`box:session:3:${second.run.sessionId}`]));
          releaseGate();
        },
      });
      const result = await abandon;
      assert.equal(seenLock, true);
      assert.equal(result.status, "applied");
      await assert.rejects(() => resumeJournal.claimToolResume({
        requestId: child2, uid: 3n, canonicalModel: second.firstBody.model, canonicalBody: second.resumeBody,
      }));
      assert.equal((await a.query("SELECT ctx->>'boxState' AS box FROM request_finalize_journal WHERE request_id=$1", [second.run.requestId])).rows[0].box, ABANDON_STATE);
      assert.equal((await a.query("SELECT ctx->>'boxState' AS box FROM request_finalize_journal WHERE request_id=$1", [child2])).rows[0].box ?? null, null);
      let reads = 0;
      await assert.rejects(() => replayMod.findCompletedBoxReplay({
        uid: 3n, canonicalModel: second.firstBody.model, canonicalBody: second.firstBody, upstreamModel: "claude-opus-5-5",
      }, {
        journal: new loaded.mod.BoxDurableJournal({
          connect: async () => ({ query: a.query.bind(a), release() {} }), query: a.query.bind(a),
        }),
        readMessage: async () => { reads += 1; return null; },
      }), (error: unknown) => codeOf(error) === "BOX_REPLAY_EVIDENCE_INVALID");
      const aliasBody = { ...second.firstBody, stream: false };
      await assert.rejects(() => replayMod.findCompletedBoxReplay({
        uid: 3n, canonicalModel: aliasBody.model, canonicalBody: aliasBody, upstreamModel: "claude-opus-5-5",
      }, {
        journal: new loaded.mod.BoxDurableJournal({
          connect: async () => ({ query: a.query.bind(a), release() {} }), query: a.query.bind(a),
        }),
        readMessage: async () => { reads += 1; return null; },
      }), (error: unknown) => codeOf(error) === "BOX_REPLAY_EVIDENCE_INVALID");
      assert.equal(reads, 0);
      const usageBefore = await a.query("SELECT count(*)::int AS n FROM usage_records");
      await capped.admit({
        requestId: "fresh-ok", uid: 3n, accountId: 20n, model: freshBody.model,
        fingerprint: fp.deriveBoxCallFingerprint(3n, freshBody), canonicalBody: freshBody,
        runNonce: "1".repeat(24), leaseEpoch: "2".repeat(32), invocationMode: "text",
      });
      assert.equal((await a.query("SELECT ctx->>'boxState' AS box FROM request_finalize_journal WHERE request_id='fresh-ok'")).rows[0].box, "reserved");
      assert.equal((await a.query("SELECT count(*)::int AS n FROM usage_records")).rows[0].n, usageBefore.rows[0].n);
      void gate;
    } finally {
      await a.end();
      await b.end();
    }
  });
});

test("pinned reconciler SQL and native GC leave the abandoned row alone", { timeout: 120_000 }, async () => {
  await withTemp(async (db) => {
    const made = makeRun("gc");
    const contrastNonce = await insertContrast(db, 1);
    await insertTarget(db, made);
    const manifest = await manifestOf(db, "pg_temp", made, contrastNonce, 1);
    await applyRun(db, "pg_temp", manifest, approvalFor(made.run), { freshProof: made.proof });
    await db.query("UPDATE request_finalize_journal SET updated_at = NOW() - INTERVAL '100 days' WHERE request_id=$1", [made.run.requestId]);
    await db.query(
      `INSERT INTO request_finalize_journal(request_id, user_id, state, ctx, updated_at)
       VALUES ('legacy-inflight', 3, 'inflight', '{"model":"legacy"}'::jsonb, NOW() - INTERVAL '2 days'),
              ('legacy-old', 3, 'committed', '{"model":"legacy"}'::jsonb, NOW() - INTERVAL '100 days')`);
    const src = readFileSync(RECONCILER, "utf8");
    const sql = [...src.matchAll(/`([^`]*request_finalize_journal[^`]*)`/g)].map((match) => match[1].trim());
    const statements = sql.filter((item) => /^(UPDATE request_finalize_journal rfj|DELETE FROM request_finalize_journal)\b/.test(item));
    assert.equal(statements.length, 6);
    assert.ok(src.includes("COALESCE(rfj.ctx->>'boxInvocationRecovery', '') <> 'v1'"));
    assert.ok(src.includes("durableBillingRecovery"));
    const version = "lossless_turn_tape_v2";
    const params = [
      ["0"],
      ["0", version],
      ["0", version, "not-our-waiver"],
      ["0", 50, version],
      [String(30 * 24 * 3_600_000), 50, version],
      [String(90 * 24 * 3_600_000), 50, version],
    ];
    for (let i = 0; i < statements.length && i < params.length; i += 1) {
      await db.query(statements[i], params[i]);
    }
    const target = await db.query("SELECT state, ctx->>'boxState' AS box, final_credits::text AS fin FROM request_finalize_journal WHERE request_id=$1", [made.run.requestId]);
    assert.equal(target.rows[0].state, "committed");
    assert.equal(target.rows[0].box, ABANDON_STATE);
    assert.equal(target.rows[0].fin, "22");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE request_id='legacy-inflight' AND state='inflight'")).rows[0].n, 0);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE request_id='legacy-old'")).rows[0].n, 0);
    const loaded = await loadRelease();
    const journal = new loaded.mod.BoxDurableJournal({
      connect: async () => ({ query: db.query.bind(db), release() {} }), query: db.query.bind(db),
    });
    assert.equal((await journal.listNativeGcCandidates(10)).some((item: { requestId: string }) => item.requestId === made.run.requestId), false);
    assert.equal(await journal.claimNativeGc({
      requestId: made.run.requestId, uid: 3n, accountId: 20n, sessionId: made.run.sessionId,
      pointer: { accountId: "20", cliCwd: made.ctx.boxNativeCliCwd, nativeSessionId: made.ctx.boxNativeSessionId,
        expiresAtMs: 1, upstreamModel: "claude-opus-5-5" },
    }), false);
  });
});

const HISTORICAL_AGGREGATE = "729cfefb106000bd79a92994697b750583a4b9f4ad4e8fa4d21322584f64b599";

async function seedContrast(db: Db, schema: "pg_temp" | `ocv5_295_${string}`, clocks = { last: 1790674483965, after: 1790674603965 }) {
  const made = makeRun("clk");
  const contrastNonce = randomBytes(12).toString("hex");
  const epoch = randomBytes(16).toString("hex");
  const sessionId = "session-watch";
  const leafCtx = {
    boxAccountId: "20", boxRunNonce: contrastNonce, boxLeaseEpoch: epoch, boxSessionId: sessionId,
    boxTurnKey: "cd".repeat(32), boxState: "unknown",
    boxStopProbeLastAttemptMs: clocks.last, boxStopProbeAfterMs: clocks.after,
  };
  await db.query(
    `INSERT INTO request_finalize_journal(request_id, user_id, container_id, state, ctx)
     VALUES ($1, 3, 77, 'inflight', $2::jsonb)`,
    [CONTRAST_LEAF_REQUEST_ID, JSON.stringify(leafCtx)]);
  for (let i = 0; i < 45; i += 1) {
    await db.query(
      `INSERT INTO request_finalize_journal(request_id, user_id, container_id, state, ctx, precheck_credits, final_credits)
       VALUES ($1, 3, 77, 'committed', $2::jsonb, 3, 4)`,
      [randomBytes(16).toString("hex"), JSON.stringify({
        boxAccountId: "20", boxRunNonce: contrastNonce, boxLeaseEpoch: epoch, boxSessionId: sessionId,
        boxTurnKey: "cd".repeat(32), boxState: "terminal", n: i,
      })]);
  }
  await insertTarget(db, made);
  const found = await db.query(
    `SELECT request_id, user_id::text AS user_id, container_id::text AS container_id, state,
            precheck_credits::text AS pre, final_credits::text AS fin, ledger_id::text AS led,
            usage_id::text AS use, ctx
       FROM request_finalize_journal WHERE ctx->>'boxRunNonce' = $1 ORDER BY request_id`,
    [contrastNonce]);
  const rows = found.rows.map((row) => {
    const ctx = { ...row.ctx };
    if (row.request_id === CONTRAST_LEAF_REQUEST_ID) {
      delete ctx.boxStopProbeAfterMs;
      delete ctx.boxStopProbeLastAttemptMs;
    }
    return {
      requestId: row.request_id, userId: row.user_id, containerId: row.container_id, state: row.state,
      pre: row.pre, fin: row.fin, led: row.led, use: row.use,
      epoch: row.ctx.boxLeaseEpoch, sessionId: row.ctx.boxSessionId, turnKey: row.ctx.boxTurnKey ?? null,
      owner: row.ctx.boxOwnerRequestId ?? null, resume: row.ctx.boxResumeRequestId ?? null,
      boxState: row.ctx.boxState, businessCtxSha256: sha256(canonicalJson(ctx)),
    };
  });
  const manifest = await manifestOf(db, schema, made, contrastNonce, 46);
  manifest.contrast = {
    nonce: contrastNonce, rowCount: 46, leafRequestId: CONTRAST_LEAF_REQUEST_ID,
    clockKeys: ["boxStopProbeAfterMs", "boxStopProbeLastAttemptMs"], clockGapMs: CONTRAST_CLOCK_GAP_MS,
    historicalAggregateSha256: HISTORICAL_AGGREGATE,
    clockFloor: { boxStopProbeAfterMs: clocks.after, boxStopProbeLastAttemptMs: clocks.last },
    rows,
  };
  return { made, manifest, contrastNonce };
}

test("contrast clock tail allows only the witnessed leaf pair to move", { timeout: 120_000 }, async () => {
  await withTemp(async (db) => {
    const seeded = await seedContrast(db, "pg_temp");
    const before = await db.query("SELECT md5(ctx::text) AS ctx FROM request_finalize_journal WHERE request_id=$1", [seeded.made.run.requestId]);
    await db.query(
      `UPDATE request_finalize_journal SET ctx = ctx || jsonb_build_object(
         'boxStopProbeLastAttemptMs', $2::bigint, 'boxStopProbeAfterMs', $3::bigint)
       WHERE request_id = $1`,
      [CONTRAST_LEAF_REQUEST_ID, 1790674483965 + 120_000, 1790674603965 + 120_000]);
    const applied = await applyRun(db, "pg_temp", seeded.manifest, approvalFor(seeded.made.run), { freshProof: seeded.made.proof });
    assert.equal(applied.status, "applied");
    assert.equal((await db.query("SELECT ctx->>'boxState' AS box FROM request_finalize_journal WHERE request_id=$1", [seeded.made.run.requestId])).rows[0].box, ABANDON_STATE);
    const leaf = await db.query("SELECT ctx->>'boxStopProbeLastAttemptMs' AS last FROM request_finalize_journal WHERE request_id=$1", [CONTRAST_LEAF_REQUEST_ID]);
    assert.equal(leaf.rows[0].last, String(1790674483965 + 120_000));
    const frozen = await db.query(
      "SELECT count(*)::int AS n FROM request_finalize_journal WHERE ctx->>'boxRunNonce'=$1 AND request_id <> $2 AND final_credits::text <> '4'",
      [seeded.manifest.contrast.nonce, CONTRAST_LEAF_REQUEST_ID]);
    assert.equal(frozen.rows[0].n, 0);
    void before;
  });
  const rejects: Array<(db: Db, nonce: string) => Promise<void>> = [
    async (db) => { await db.query("UPDATE request_finalize_journal SET ctx = ctx || '{\"n\":99}'::jsonb WHERE request_id=$1", [CONTRAST_LEAF_REQUEST_ID]); },
    async (db, nonce) => { await db.query("UPDATE request_finalize_journal SET final_credits = 9 WHERE ctx->>'boxRunNonce'=$1 AND request_id <> $2", [nonce, CONTRAST_LEAF_REQUEST_ID]); },
    async (db) => { await db.query("UPDATE request_finalize_journal SET state='aborted' WHERE request_id=$1", [CONTRAST_LEAF_REQUEST_ID]); },
    async (db, nonce) => { await db.query("UPDATE request_finalize_journal SET ctx = ctx || jsonb_build_object('boxStopProbeLastAttemptMs', 1, 'boxStopProbeAfterMs', 2) WHERE ctx->>'boxRunNonce'=$1 AND request_id <> $2", [nonce, CONTRAST_LEAF_REQUEST_ID]); },
    async (db) => { await db.query("UPDATE request_finalize_journal SET ctx = ctx - 'boxStopProbeAfterMs' WHERE request_id=$1", [CONTRAST_LEAF_REQUEST_ID]); },
    async (db) => { await db.query("UPDATE request_finalize_journal SET ctx = jsonb_set(ctx, '{boxStopProbeLastAttemptMs}', '\"1790674483965\"') WHERE request_id=$1", [CONTRAST_LEAF_REQUEST_ID]); },
    async (db) => { await db.query("UPDATE request_finalize_journal SET ctx = ctx || jsonb_build_object('boxStopProbeLastAttemptMs', $2::bigint, 'boxStopProbeAfterMs', $3::bigint) WHERE request_id=$1", [CONTRAST_LEAF_REQUEST_ID, 1790674483965 - 120_000, 1790674603965 - 120_000]); },
    async (db) => { await db.query("UPDATE request_finalize_journal SET ctx = ctx || jsonb_build_object('boxStopProbeLastAttemptMs', $2::bigint, 'boxStopProbeAfterMs', $3::bigint) WHERE request_id=$1", [CONTRAST_LEAF_REQUEST_ID, 1790674483965 + 10, 1790674603965 + 9]); },
  ];
  for (const mutate of rejects) {
    await withTemp(async (db) => {
      const seeded = await seedContrast(db, "pg_temp");
      await mutate(db, seeded.manifest.contrast.nonce);
      await assert.rejects(() => applyRun(db, "pg_temp", seeded.manifest, approvalFor(seeded.made.run), { freshProof: seeded.made.proof }),
        (error: unknown) => codeOf(error) === "CONTRAST_CHANGED");
      assert.equal((await db.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE ctx ? 'boxCancelIntent'")).rows[0].n, 0);
    });
  }
});

test("contrast set, reverse edge, and in-transaction probe wait", { timeout: 120_000 }, async () => {
  await withTemp(async (db) => {
    const seeded = await seedContrast(db, "pg_temp");
    await db.query(
      `INSERT INTO request_finalize_journal(request_id, user_id, container_id, state, ctx)
       VALUES ('extra-row', 3, 77, 'inflight', $1::jsonb)`,
      [JSON.stringify({ boxAccountId: "20", boxRunNonce: seeded.manifest.contrast.nonce, boxState: "unknown",
        boxLeaseEpoch: "ab".repeat(16), boxSessionId: "session-watch" })]);
    await assert.rejects(() => applyRun(db, "pg_temp", seeded.manifest, approvalFor(seeded.made.run), { freshProof: seeded.made.proof }),
      (error: unknown) => codeOf(error) === "CONTRAST_CHANGED");
    await db.query("DELETE FROM request_finalize_journal WHERE request_id='extra-row'");
    await db.query("DELETE FROM request_finalize_journal WHERE request_id=$1", [CONTRAST_LEAF_REQUEST_ID]);
    await assert.rejects(() => applyRun(db, "pg_temp", seeded.manifest, approvalFor(seeded.made.run), { freshProof: seeded.made.proof }),
      (error: unknown) => codeOf(error) === "CONTRAST_CHANGED");
  });
  await withTemp(async (db) => {
    const seeded = await seedContrast(db, "pg_temp");
    await db.query(
      `INSERT INTO request_finalize_journal(request_id, user_id, container_id, state, ctx)
       VALUES ('outside-child', 3, 77, 'committed', $1::jsonb)`,
      [JSON.stringify({ boxAccountId: "20", boxRunNonce: "ee".repeat(12), boxOwnerRequestId: CONTRAST_LEAF_REQUEST_ID, boxState: "linked" })]);
    await assert.rejects(() => applyRun(db, "pg_temp", seeded.manifest, approvalFor(seeded.made.run), { freshProof: seeded.made.proof }),
      (error: unknown) => codeOf(error) === "SUCCESSOR_PRESENT");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE ctx ? 'boxCancelIntent'")).rows[0].n, 0);
  });
  await withSchema(async (schema) => {
    const a = await pgClient();
    const b = await pgClient();
    try {
      await a.query(`SET search_path TO ${schema}`);
      await b.query(`SET search_path TO ${schema}`);
      await b.query("SET lock_timeout = '400ms'");
      const seeded = await seedContrast(a, schema as `ocv5_295_${string}`);
      let held = false;
      const result = await applyRun(a, schema as "pg_temp", seeded.manifest, approvalFor(seeded.made.run), {
        freshProof: seeded.made.proof,
        afterIntent: async () => {
          held = true;
          await assert.rejects(() => b.query(
            `UPDATE request_finalize_journal SET ctx = ctx || jsonb_build_object(
               'boxStopProbeLastAttemptMs', $2::bigint, 'boxStopProbeAfterMs', $3::bigint) WHERE request_id=$1`,
            [CONTRAST_LEAF_REQUEST_ID, 1790674483965 + 240_000, 1790674603965 + 240_000]));
          const during = await a.query("SELECT ctx->>'boxStopProbeLastAttemptMs' AS last FROM request_finalize_journal WHERE request_id=$1", [CONTRAST_LEAF_REQUEST_ID]);
          assert.equal(during.rows[0].last, "1790674483965");
        },
      });
      assert.equal(held, true);
      assert.equal(result.status, "applied");
      assert.equal((await a.query("SELECT ctx->>'boxStopProbeLastAttemptMs' AS last FROM request_finalize_journal WHERE request_id=$1", [CONTRAST_LEAF_REQUEST_ID])).rows[0].last, "1790674483965");
    } finally {
      await a.end();
      await b.end();
    }
  });
});

function pinnedTarget(advance: boolean) {
  const made = makeRun("pin");
  const nonce = TARGET_NONCE;
  const epoch = "576099aacf2ed8fc91080de887ef5769";
  const requestId = "ed263edbf8dd0f8ff393adc20935d95f";
  const sessionId = "c1bc63cb-09bb-44ea-a48a-575a533c3940";
  const turnKey = "c25fbc11ede9e1667ccbf9af1481342c24a33207a2eed783d2d87f9f731ac5eb";
  const historical = { boxStopProbeLastAttemptMs: 1790674363970, boxStopProbeAfterMs: 1790674483970 };
  const approved = {
    ...made.ctx,
    boxRunNonce: nonce, boxLeaseEpoch: epoch, boxSessionId: sessionId, boxTurnKey: turnKey,
    boxBillingContext: { ...made.ctx.boxBillingContext, sessionId, turnKey },
    boxReplayMessage: { ...made.ctx.boxReplayMessage, requestId, runNonce: nonce, leaseEpoch: epoch },
    boxNativeCliCwd: `/tmp/ocv5-289-run-${nonce}`,
    ...historical,
  };
  const live = advance ? {
    ...approved,
    boxStopProbeLastAttemptMs: historical.boxStopProbeAfterMs,
    boxStopProbeAfterMs: historical.boxStopProbeAfterMs + CONTRAST_CLOCK_GAP_MS,
  } : approved;
  made.ctx = live;
  made.run = {
    ...made.run, nonce, epoch, requestId, sessionId, turnKey, containerId: "534",
    originalCtx: approved, originalCtxSha256: sha256(canonicalJson(approved)),
  };
  made.proof = proofFor(nonce, epoch);
  return made;
}

test("e682 target clocks may advance once before release and then stay fixed", { timeout: 120_000 }, async () => {
  await withTemp(async (db) => {
    const made = pinnedTarget(true);
    const contrastNonce = await insertContrast(db, 1);
    await insertTarget(db, made);
    const manifest = await manifestOf(db, "pg_temp", made, contrastNonce, 1);
    manifest.run = made.run;
    const applied = await applyRun(db, "pg_temp", manifest, approvalFor(made.run), { freshProof: made.proof });
    assert.equal(applied.status, "applied");
    const audit = await db.query<{ actual: string; approved: string; last: string; after: string }>(
      `SELECT ctx->'boxOperatorAudit'->>'actualBeforeCtxSha256' AS actual,
              ctx->'boxOperatorAudit'->>'approvedOriginalCtxSha256' AS approved,
              ctx->'boxOperatorAudit'->'actualBeforeClocks'->>'boxStopProbeLastAttemptMs' AS last,
              ctx->'boxOperatorAudit'->'actualBeforeClocks'->>'boxStopProbeAfterMs' AS after
         FROM request_finalize_journal WHERE request_id = $1`, [made.run.requestId]);
    assert.equal(audit.rows[0].approved, made.run.originalCtxSha256);
    assert.notEqual(audit.rows[0].actual, made.run.originalCtxSha256);
    assert.equal(audit.rows[0].actual, sha256(canonicalJson(made.ctx)));
    assert.equal(audit.rows[0].last, String(made.ctx.boxStopProbeLastAttemptMs));
    assert.equal(audit.rows[0].after, String(made.ctx.boxStopProbeAfterMs));
    const again = await applyRun(db, "pg_temp", manifest, approvalFor(made.run), { freshProof: made.proof });
    assert.equal(again.status, "already_applied");
    await db.query(
      `UPDATE request_finalize_journal SET ctx = ctx || jsonb_build_object(
         'boxStopProbeLastAttemptMs', $2::bigint, 'boxStopProbeAfterMs', $3::bigint) WHERE request_id=$1`,
      [made.run.requestId, Number(made.ctx.boxStopProbeLastAttemptMs) + CONTRAST_CLOCK_GAP_MS,
        Number(made.ctx.boxStopProbeAfterMs) + CONTRAST_CLOCK_GAP_MS]);
    await assert.rejects(() => applyRun(db, "pg_temp", manifest, approvalFor(made.run), { freshProof: made.proof }));
    await assert.rejects(() => applyRun(db, "pg_temp", manifest, {
      ...approvalFor(made.run), operationId: "ocv5-295-ffffffffffffffff",
    }, { freshProof: made.proof }));
  });
  const bad: Array<(db: Db, requestId: string) => Promise<void>> = [
    async (db, requestId) => { await db.query("UPDATE request_finalize_journal SET ctx = ctx || '{\"extra\":1}'::jsonb WHERE request_id=$1", [requestId]); },
    async (db, requestId) => { await db.query("UPDATE request_finalize_journal SET final_credits = 1 WHERE request_id=$1", [requestId]); },
    async (db, requestId) => { await db.query("UPDATE request_finalize_journal SET ctx = ctx - 'boxStopProbeAfterMs' WHERE request_id=$1", [requestId]); },
    async (db, requestId) => { await db.query("UPDATE request_finalize_journal SET ctx = jsonb_set(ctx, '{boxStopProbeLastAttemptMs}', '\"1790674363970\"') WHERE request_id=$1", [requestId]); },
    async (db, requestId) => { await db.query("UPDATE request_finalize_journal SET ctx = ctx || jsonb_build_object('boxStopProbeLastAttemptMs', $2::bigint, 'boxStopProbeAfterMs', $3::bigint) WHERE request_id=$1", [requestId, 1790674363970 + 1, 1790674483970 + 1]); },
  ];
  for (const mutate of bad) {
    await withTemp(async (db) => {
      const made = pinnedTarget(true);
      const contrastNonce = await insertContrast(db, 1);
      await insertTarget(db, made);
      await mutate(db, made.run.requestId);
      const manifest = await manifestOf(db, "pg_temp", made, contrastNonce, 1);
      manifest.run = made.run;
      await assert.rejects(() => applyRun(db, "pg_temp", manifest, approvalFor(made.run), { freshProof: made.proof }),
        (error: unknown) => codeOf(error) === "IDENTITY_MISMATCH" || codeOf(error) === "ACCOUNTING_MISMATCH");
      assert.equal((await db.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE ctx ? 'boxCancelIntent'")).rows[0].n, 0);
    });
  }
});

test("e682 commit check uses the actual before hash, and a later probe does not write", { timeout: 120_000 }, async () => {
  await withSchema(async (schema) => {
    const a = await pgClient();
    const reader = await pgClient();
    try {
      await a.query(`SET search_path TO ${schema}`);
      await reader.query(`SET search_path TO ${schema}`);
      const made = pinnedTarget(true);
      const contrastNonce = await insertContrast(a, 1);
      await insertTarget(a, made);
      const manifest = await manifestOf(a, schema as `ocv5_295_${string}`, made, contrastNonce, 1);
      manifest.run = made.run;
      const wrapped = {
        async query(sql: string, params?: unknown[]) {
          if (sql === "COMMIT") {
            await a.query("COMMIT");
            throw new Error("response lost");
          }
          return a.query(sql, params);
        },
      };
      const lost = await applyRun(wrapped, schema as "pg_temp", manifest, approvalFor(made.run), {
        freshProof: made.proof,
        readIndependently: async () => (await reader.query(
          `SELECT request_id, user_id::text, container_id::text, state,
             precheck_credits::text, final_credits::text, ledger_id::text, usage_id::text, ctx
           FROM request_finalize_journal WHERE ctx->>'boxRunNonce' = $1`, [made.run.nonce])).rows,
      });
      assert.equal(lost.verifiedAfterCommitError, true);
      assert.equal(lost.status, "already_applied");
      const loaded = await loadRelease();
      const journal = new loaded.mod.BoxDurableJournal({
        connect: async () => ({ query: reader.query.bind(reader), release() {} }),
        query: reader.query.bind(reader),
      });
      const probed = await journal.claimStoppedFailureProbe({
        requestId: made.run.requestId, uid: 3n, accountId: 20n,
        runNonce: made.run.nonce, leaseEpoch: made.run.epoch, linked: false,
      });
      assert.equal(probed, false);
      const clocks = await reader.query(
        "SELECT ctx->>'boxStopProbeLastAttemptMs' AS last FROM request_finalize_journal WHERE request_id=$1",
        [made.run.requestId]);
      assert.equal(clocks.rows[0].last, String(made.ctx.boxStopProbeLastAttemptMs));
    } finally {
      await a.end();
      await reader.end();
    }
  });
});

test("spectator clock must be due, and a same-nonce other account is in the set", { timeout: 120_000 }, async () => {
  const floor = { last: 1790674483965, after: 1790674603965 };
  await withTemp(async (db) => {
    const seeded = await seedContrast(db, "pg_temp", floor);
    await db.query(
      `UPDATE request_finalize_journal SET ctx = ctx || jsonb_build_object(
         'boxStopProbeLastAttemptMs', $2::bigint, 'boxStopProbeAfterMs', $3::bigint)
       WHERE request_id = $1`,
      [CONTRAST_LEAF_REQUEST_ID, floor.last + 1, floor.after + 1]);
    await assert.rejects(() => applyRun(db, "pg_temp", seeded.manifest, approvalFor(seeded.made.run), { freshProof: seeded.made.proof }),
      (error: unknown) => codeOf(error) === "CONTRAST_CHANGED");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE ctx ? 'boxCancelIntent'")).rows[0].n, 0);
  });
  await withTemp(async (db) => {
    const seeded = await seedContrast(db, "pg_temp", floor);
    await db.query(
      `UPDATE request_finalize_journal SET ctx = ctx || jsonb_build_object(
         'boxStopProbeLastAttemptMs', $2::bigint, 'boxStopProbeAfterMs', $3::bigint)
       WHERE request_id = $1`,
      [CONTRAST_LEAF_REQUEST_ID, floor.after, floor.after + CONTRAST_CLOCK_GAP_MS]);
    const applied = await applyRun(db, "pg_temp", seeded.manifest, approvalFor(seeded.made.run), { freshProof: seeded.made.proof });
    assert.equal(applied.status, "applied");
    assert.equal((await db.query("SELECT ctx->>'boxStopProbeLastAttemptMs' AS last FROM request_finalize_journal WHERE request_id=$1", [CONTRAST_LEAF_REQUEST_ID])).rows[0].last, String(floor.after));
  });
  await withTemp(async (db) => {
    const seeded = await seedContrast(db, "pg_temp", floor);
    await db.query(
      `INSERT INTO request_finalize_journal(request_id, user_id, container_id, state, ctx)
       VALUES ('acct-21-extra', 3, 77, 'committed', $1::jsonb)`,
      [JSON.stringify({ boxAccountId: "21", boxRunNonce: seeded.manifest.contrast.nonce, boxState: "terminal",
        boxLeaseEpoch: "ab".repeat(16), boxSessionId: "session-other" })]);
    await assert.rejects(() => applyRun(db, "pg_temp", seeded.manifest, approvalFor(seeded.made.run), { freshProof: seeded.made.proof }),
      (error: unknown) => codeOf(error) === "CONTRAST_CHANGED");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE ctx ? 'boxCancelIntent'")).rows[0].n, 0);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE request_id='acct-21-extra'")).rows[0].n, 1);
  });
});

test("dry-run does not apply; unconfirmed apply exits 2", { timeout: 120_000 }, async () => {
  const tsx = join(RELEASE, "node_modules/.bin/tsx");
  const dry = spawnSync(tsx, [SCRIPT.pathname], { encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /REVIEW_REQUIRED dry-run only/);
  assert.doesNotMatch(dry.stdout, /"status":"applied"/);
  const apply = spawnSync(tsx, [SCRIPT.pathname, "--mode", "apply", "--manifest", MANIFEST,
    "--approved-sha", PINNED_SOURCE_COMMIT, "--operation-id", "ocv5-295-0123456789abcdef"], { encoding: "utf8" });
  assert.equal(apply.status, 2, apply.stderr);
  assert.match(`${apply.stdout}\n${apply.stderr}`, /REVIEW_REQUIRED|APPROVAL_REQUIRED/);
  assert.doesNotMatch(`${apply.stdout}\n${apply.stderr}`, /production write confirmed|postgres:\/\//);
});
