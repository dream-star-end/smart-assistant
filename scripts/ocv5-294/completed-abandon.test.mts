/** Real PostgreSQL tests for the OCV5-294 operator.
 * Business tables are TEMP (or a throwaway schema for the two-session resume
 * race) inside openclaude_test on loopback 55432. Production is not written.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import {
  ABANDON_STATE, PINNED_SOURCE_COMMIT, REQUIRED_AUTHORIZATION, advisoryKeys,
  applyRun, loadRelease, manifestFromEvidence, productionResolveArgs,
  readPinnedProductionProof, type ProofShape, type RunManifest,
} from "./completed-abandon.mts";

const RELEASE = process.env.OC_OCV5_294_RELEASE
  ?? "/opt/openclaude/openclaude-v5-selfhost-releases/rel-817c69409-20260928-163445";
const VOLUME = process.env.OC_OCV5_294_GENERATED
  ?? "/var/lib/docker/volumes/oc-v5-data-u3/_data/generated";

function client() {
  return new Client({
    host: "/var/run/postgresql", port: 55432, database: "openclaude_test", user: "postgres",
  });
}

async function withTemp<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = client();
  await db.connect();
  try {
    const info = await db.query("SELECT current_database() AS db, current_setting('port') AS port");
    assert.equal(info.rows[0].db, "openclaude_test");
    assert.equal(String(info.rows[0].port), "55432");
    await db.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint,
      state text NOT NULL, ctx jsonb NOT NULL,
      precheck_credits bigint, final_credits bigint, ledger_id bigint, usage_id bigint,
      updated_at timestamptz NOT NULL DEFAULT now())`);
    await db.query(`CREATE TEMP TABLE usage_records (
      id bigint PRIMARY KEY, request_id text NOT NULL, user_id bigint NOT NULL,
      input_tokens int NOT NULL, output_tokens int NOT NULL,
      cache_read_tokens int NOT NULL, cache_write_tokens int NOT NULL,
      cost_credits bigint NOT NULL, ledger_id bigint NOT NULL)`);
    await db.query(`CREATE TEMP TABLE credit_ledger (
      id bigint PRIMARY KEY, delta bigint NOT NULL)`);
    await db.query(`CREATE TEMP TABLE wallets (id bigint PRIMARY KEY, balance bigint NOT NULL)`);
    await db.query(`CREATE OR REPLACE FUNCTION pg_temp.forbid_wallet() RETURNS trigger AS $fn$
      BEGIN RAISE EXCEPTION 'wallet write forbidden'; END $fn$ LANGUAGE plpgsql`);
    await db.query("INSERT INTO wallets(id, balance) VALUES (1, 100)");
    await db.query(`CREATE TRIGGER wallets_no_write BEFORE INSERT OR UPDATE OR DELETE ON wallets
      FOR EACH ROW EXECUTE FUNCTION pg_temp.forbid_wallet()`);
    await db.query("SET search_path TO pg_temp");
    const resolved = await db.query<{ nspname: string }>(
      `SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid = 'request_finalize_journal'::regclass`);
    assert.ok(resolved.rows[0]?.nspname.startsWith("pg_temp"), resolved.rows[0]?.nspname);
    assert.equal((await db.query("SHOW search_path")).rows[0].search_path, "pg_temp");
    return await fn(db);
  } finally { await db.end(); }
}

function guard(db: Client) {
  return {
    async query(sql: string, params?: unknown[]) {
      if (/\b(insert|update|delete)\b/i.test(sql)
        && /\b(usage_records|credit_ledger|wallets)\b/i.test(sql)) {
        throw new Error(`financial write forbidden: ${sql.slice(0, 80)}`);
      }
      return db.query(sql, params);
    },
  };
}

function journalPool(db: Client) {
  const guarded = guard(db);
  return {
    connect: async () => ({ query: guarded.query.bind(guarded), release() {} }),
    query: guarded.query.bind(guarded),
  };
}

const basis = {
  model: "box-api-claude-opus-5-5",
  boxInvocationRecovery: "v1",
  boxInvocationMode: "detached_tool",
  billingPricing: { v: 1, modelId: "box-api-claude-opus-5-5", displayName: "Opus",
    inputPerMtok: "1", outputPerMtok: "1", cacheReadPerMtok: "1", cacheWritePerMtok: "1",
    multiplier: "1" },
  boxBillingContext: { v: 1, sessionId: "session-synthetic", mode: "chat",
    parentSessionId: null, delegateAgentId: null, turnKey: "a".repeat(64),
    parentTurnKey: null, authority: null, dispatchId: null, attemptNo: null,
    verificationSponsorship: null, apiKeyId: null },
};

function proofFor(nonce: string, epoch: string, cliPid = 101): ProofShape {
  return { cliPid, keeperPid: 100, leaseEpoch: epoch, reason: "worker_complete", revision: 1, runNonce: nonce };
}

function tag(suffix: string): number {
  let value = 0;
  for (const char of suffix) value = (value * 33 + char.charCodeAt(0)) % 200000;
  return value + 1;
}

function pair(suffix: string, opts?: { intent?: boolean; brokenRevision?: boolean; containerId?: string }) {
  const nonce = randomBytes(12).toString("hex");
  const epoch = randomBytes(16).toString("hex");
  const root = `root${suffix}`.slice(0, 32);
  const leaf = `leaf${suffix}`.slice(0, 32);
  const revision = "11111111-1111-4111-8111-111111111111";
  const intent = opts?.intent ? { v: 1, atMs: 1790606954153, reason: "user_cancel", requestId: leaf } : undefined;
  const run: RunManifest = {
    nonce, epoch, rootRequestId: root, leafRequestId: leaf, uid: "3", accountId: "20",
    containerId: opts?.containerId ?? "9001",
    sessionId: `session-${suffix}`, turnKey: "ab".repeat(32),
    model: "box-api-claude-opus-5-5",
    catalogHash: "cd".repeat(32), runnerHash: "ef".repeat(32),
    reuseCancelIntent: opts?.intent === true,
    settled: [
      { requestId: root, inputTokens: 2, outputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 4,
        costCredits: "5", ledgerId: String(500000 + tag(suffix)), ledgerDelta: "-5" },
      { requestId: leaf, inputTokens: 2, outputTokens: 11, cacheReadTokens: 5, cacheWriteTokens: 6,
        costCredits: "4", ledgerId: String(800000 + tag(suffix)), ledgerDelta: "-4" },
    ],
    unsettledStopReasons: ["tool_use", "end_turn"],
  };
  const common = {
    ...basis,
    boxBillingContext: { ...basis.boxBillingContext, sessionId: run.sessionId, turnKey: run.turnKey },
    boxAccountId: "20", boxRunNonce: nonce, boxLeaseEpoch: epoch, boxSessionId: run.sessionId,
    boxTurnKey: run.turnKey, boxCatalogHash: run.catalogHash, boxDetachedRunnerHash: run.runnerHash,
    ...(intent ? { boxCancelIntent: intent } : {}),
  };
  const rootCtx = {
    ...common, boxState: "resuming", boxLaunchPermit: true,
    boxReplayFingerprint: "11".repeat(32), boxFallbackAlias: "22".repeat(32),
    boxRequestHash: "33".repeat(32), boxContextHash: "44".repeat(32),
    boxHandoffRevision: "22222222-2222-4222-8222-222222222222",
    boxResumeRequestId: leaf, boxResumeRevision: revision,
    boxResumeResultHashes: [{ modelToolUseId: "toolu_A", contentHash: "55".repeat(32), isError: false }],
    boxToolHandoff: { version: 1, roundNo: 1, usage: { inputTokens: 2, outputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 4 } },
    boxReplayMessage: { version: 1, uid: "3", requestId: root, runNonce: nonce, leaseEpoch: epoch, roundNo: 1, bytes: 10, sha256: "66".repeat(32) },
    boxNativeSessionId: "12345678-1234-4123-8123-123456789abc",
    boxNativeCliCwd: `/tmp/ocv5-289-run-${nonce}`,
  };
  const leafCtx = {
    ...common, boxState: "handoff",
    boxReplayFingerprint: "77".repeat(32), boxFallbackAlias: "88".repeat(32),
    boxRequestHash: "99".repeat(32), boxContextHash: "aa".repeat(32),
    boxHandoffRevision: "33333333-3333-4333-8333-333333333333",
    boxOwnerRequestId: root,
    boxParentResumeRevision: opts?.brokenRevision ? "44444444-4444-4444-8444-444444444444" : revision,
    boxRoundNo: 2, boxResumeSpoolOffset: 100,
    boxToolHandoff: { version: 1, roundNo: 2, usage: { inputTokens: 2, outputTokens: 11, cacheReadTokens: 5, cacheWriteTokens: 6 } },
    boxReplayMessage: { version: 1, uid: "3", requestId: leaf, runNonce: nonce, leaseEpoch: epoch, roundNo: 2, bytes: 12, sha256: "bb".repeat(32) },
    boxNativeSessionId: rootCtx.boxNativeSessionId, boxNativeCliCwd: rootCtx.boxNativeCliCwd,
  };
  return { run, rootCtx, leafCtx, proof: proofFor(nonce, epoch) };
}

async function insertPair(db: Client, made: ReturnType<typeof pair>) {
  for (const [id, ctx, credits, ledger, usage] of [
    [made.run.rootRequestId, made.rootCtx, "5", "501", "801"],
    [made.run.leafRequestId, made.leafCtx, "4", "502", "802"],
  ] as const) {
    await db.query(
      `INSERT INTO request_finalize_journal(request_id, user_id, container_id, state, ctx,
         precheck_credits, final_credits, ledger_id, usage_id)
       VALUES ($1, 3, $2, 'committed', $3::jsonb, 100, $4, $5, $6)`,
      [id, made.run.containerId, JSON.stringify(ctx), credits, ledger, usage]);
  }
  for (const leg of made.run.settled) {
    await db.query(
      `INSERT INTO usage_records(id, request_id, user_id, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_credits, ledger_id)
       VALUES ($1, $2, 3, $3, $4, $5, $6, $7, $8)`,
      [Number(leg.ledgerId) + 100000, leg.requestId, leg.inputTokens,
        leg.outputTokens, leg.cacheReadTokens, leg.cacheWriteTokens, leg.costCredits, leg.ledgerId]);
    await db.query("INSERT INTO credit_ledger(id, delta) VALUES ($1, $2)",
      [leg.ledgerId, leg.ledgerDelta]);
  }
}

const approvalFor = (run: RunManifest) => ({
  approvedSha: PINNED_SOURCE_COMMIT,
  operationId: "ocv5-294-0123456789abcdef",
  nonces: [run.nonce],
});

function manifestOf(made: ReturnType<typeof pair>) {
  return {
    sourceCommit: PINNED_SOURCE_COMMIT,
    authorization: { v: 1 as const, statement: REQUIRED_AUTHORIZATION, ticket: "OCV5-294" as const },
    runs: [made.run],
    proofs: { [made.run.nonce]: made.proof },
  };
}

async function snapshot(db: Client) {
  const rows = await db.query("SELECT request_id, state, precheck_credits::text, final_credits::text, ledger_id::text, usage_id::text, ctx->>'boxState' AS box_state, md5(ctx::text) AS ctx_hash, updated_at FROM request_finalize_journal ORDER BY request_id");
  const usage = await db.query("SELECT md5(row(usage_records)::text) AS hash FROM usage_records ORDER BY id");
  const ledger = await db.query("SELECT md5(row(credit_ledger)::text) AS hash FROM credit_ledger ORDER BY id");
  const wallet = await db.query("SELECT balance::text FROM wallets");
  return { rows: rows.rows, usage: usage.rows, ledger: ledger.rows, wallet: wallet.rows };
}

test("pinned release parses worker_complete proofs and builds the private manifest", async () => {
  const loaded = await loadRelease(RELEASE);
  assert.ok(loaded.href.journal.includes("rel-817c69409-20260928-163445/packages/commercial/src/http/proxy/boxDurableJournal.ts"));
  assert.ok(loaded.href.proof.includes("boxTerminalProof.ts"));
  const proofDoc = JSON.parse(readFileSync(join(VOLUME, "ocv5-295-existing-box-proof-read.json"), "utf8"));
  const accounting = JSON.parse(readFileSync(join(VOLUME, "ocv5-295-old-spool-accounting.json"), "utf8"));
  for (const remote of proofDoc.remote) {
    const parsed = loaded.mod.parseBoxTerminalProof(`${JSON.stringify(remote.proof)}\n`, {
      runNonce: remote.proof.runNonce, leaseEpoch: remote.proof.leaseEpoch,
    });
    assert.equal(parsed.reason, "worker_complete");
    assert.equal(parsed.revision, 1);
  }
  const manifest = manifestFromEvidence(proofDoc, accounting);
  assert.equal(manifest.sourceCommit, PINNED_SOURCE_COMMIT);
  assert.deepEqual(manifest.runs.map((run) => run.reuseCancelIntent), [false, true]);
  assert.deepEqual(manifest.runs.map((run) => run.settled.map((leg) => leg.costCredits)), [["5", "4"], ["23", "7"]]);
  assert.deepEqual(manifest.runs.map((run) => run.settled.map((leg) => leg.ledgerDelta)), [["-5", "-4"], ["-23", "-7"]]);
  assert.ok(manifest.runs.every((run) => run.unsettledStopReasons[0] === "tool_use"
    && run.unsettledStopReasons[1] === "end_turn"));
});

test("positive abandon, lost response, and financial preservation", async () => {
  await withTemp(async (db) => {
    const made = pair("pos", { intent: true });
    await insertPair(db, made);
    const before = await snapshot(db);
    const journal = new (await loadRelease()).mod.BoxDurableJournal(journalPool(db));
    let intentCalls = 0;
    const first = await applyRun(guard(db), "pg_temp", manifestOf(made), made.run, approvalFor(made.run), {
      freshProof: made.proof,
      journal: { recordUserCancelIntent: async () => { intentCalls += 1; } },
    });
    assert.equal(intentCalls, 0);
    assert.equal(first.status, "applied");
    const stamped = await db.query("SELECT updated_at FROM request_finalize_journal ORDER BY request_id");
    const after = await db.query<{ box_state: string; live_handoff: boolean; live_native: boolean;
      fingerprint: string; pre: string; final: string }>(
      `SELECT ctx->>'boxState' AS box_state, (ctx ? 'boxToolHandoff') AS live_handoff,
         (ctx ? 'boxNativeSessionId') AS live_native, ctx->>'boxReplayFingerprint' AS fingerprint,
         precheck_credits::text AS pre, final_credits::text AS final,
         state, ctx->'boxOperatorAudit'->>'operationId' AS op
       FROM request_finalize_journal ORDER BY request_id`);
    assert.equal(after.rows.length, 2);
    assert.ok(after.rows.every((row) => row.box_state === ABANDON_STATE && row.live_handoff === false
      && row.live_native === false && row.pre === "100"));
    const again = await applyRun(guard(db), "pg_temp", manifestOf(made), made.run, approvalFor(made.run), {
      freshProof: made.proof,
    });
    assert.equal(again.status, "already_applied");
    const stamps = await db.query("SELECT updated_at FROM request_finalize_journal ORDER BY request_id");
    const mid = await snapshot(db);
    assert.deepEqual(stamps.rows, stamped.rows);
    assert.deepEqual(mid.usage, before.usage);
    assert.deepEqual(mid.ledger, before.ledger);
    assert.deepEqual(mid.wallet, before.wallet);
    const cleanup = await journal.listRemoteCleanupCandidates(10);
    assert.equal(cleanup.some((item) => item.runNonce === made.run.nonce), false);
    const probes = await journal.listStoppedFailureProbeCandidates(10);
    assert.equal(probes.some((item) => item.runNonce === made.run.nonce), false);
  });
});

test("second-row CAS failure rolls the whole run back", async () => {
  await withTemp(async (db) => {
    const made = pair("roll", { intent: true });
    await insertPair(db, made);
    const before = await snapshot(db);
    await assert.rejects(() => applyRun(guard(db), "pg_temp", manifestOf(made), made.run, approvalFor(made.run), {
      freshProof: made.proof,
      afterFirstUpdate: async () => {
        await db.query("UPDATE request_finalize_journal SET ctx = ctx || '{\"tamper\":true}'::jsonb WHERE request_id = $1",
          [made.run.rootRequestId]);
      },
    }), (error: unknown) => error instanceof Error && "code" in error && error.code === "CAS_LOST");
    assert.deepEqual(await snapshot(db), before);
  });
});

test("wrong identity, proof, revision, and a new successor are rejected", async () => {
  await withTemp(async (db) => {
    const made = pair("bad", { intent: true });
    await insertPair(db, made);
    const before = await snapshot(db);
    const manifest = manifestOf(made);
    const cases: Array<() => Promise<unknown>> = [
      () => applyRun(guard(db), "pg_temp", manifest, { ...made.run, uid: "4" }, approvalFor(made.run), { freshProof: made.proof }),
      () => applyRun(guard(db), "pg_temp", manifest, { ...made.run, accountId: "21" }, approvalFor(made.run), { freshProof: made.proof }),
      () => applyRun(guard(db), "pg_temp", manifest, { ...made.run, nonce: "a".repeat(24) }, approvalFor({ ...made.run, nonce: "a".repeat(24) }), { freshProof: proofFor("a".repeat(24), made.run.epoch) }),
      () => applyRun(guard(db), "pg_temp", manifest, { ...made.run, epoch: "b".repeat(32) }, approvalFor(made.run), { freshProof: proofFor(made.run.nonce, "b".repeat(32)) }),
      () => applyRun(guard(db), "pg_temp", manifest, made.run, approvalFor(made.run), { freshProof: { ...made.proof, cliPid: 404 } }),
    ];
    for (const attempt of cases) {
      await assert.rejects(attempt);
      assert.deepEqual(await snapshot(db), before);
    }
    const broken = pair("rev", { intent: true, brokenRevision: true });
    await insertPair(db, broken);
    const brokenBefore = await snapshot(db);
    await assert.rejects(() => applyRun(guard(db), "pg_temp", manifestOf(broken), broken.run, approvalFor(broken.run), { freshProof: broken.proof }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "CHAIN_MISMATCH");
    assert.deepEqual(await snapshot(db), brokenBefore);
    await db.query(
      `INSERT INTO request_finalize_journal(request_id, user_id, container_id, state, ctx, precheck_credits)
       VALUES ('successor-row', 3, 9001, 'committed', $1::jsonb, 1)`,
      [JSON.stringify({ ...made.rootCtx, boxState: "linked", boxOwnerRequestId: made.run.leafRequestId })]);
    await assert.rejects(() => applyRun(guard(db), "pg_temp", manifest, made.run, approvalFor(made.run), { freshProof: made.proof }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "SUCCESSOR_PRESENT");
    const still = await db.query("SELECT ctx->>'boxState' AS box_state FROM request_finalize_journal WHERE request_id = $1", [made.run.rootRequestId]);
    assert.equal(still.rows[0].box_state, "resuming");
  });
});

test("missing approval does not open a write, and resolver stays pinned", async () => {
  const args = productionResolveArgs({ uid: 3n, accountId: 20n, nonce: "a".repeat(24) }, new AbortController().signal);
  assert.equal(args.allowWakeIfHibernated, false);
  assert.equal(args.requiredAccountId, 20n);
  assert.equal("containerId" in args, false);
  const proof = proofFor("c".repeat(24), "d".repeat(32));
  let seen = false;
  const parsed = await readPinnedProductionProof({ nonce: proof.runNonce, epoch: proof.leaseEpoch }, {
    resolve: async (input) => {
      seen = input.allowWakeIfHibernated === false && input.requiredAccountId === 20n;
      return { accountId: 20n, exec: { async run() { return { stdout: `${JSON.stringify(proof)}\n` }; } } };
    },
  });
  assert.equal(seen, true);
  assert.equal(parsed.reason, "worker_complete");
  await withTemp(async (db) => {
    const made = pair("gate", { intent: true });
    await insertPair(db, made);
    const before = await snapshot(db);
    await assert.rejects(() => applyRun(guard(db), "pg_temp", manifestOf(made), made.run, {
      approvedSha: "0".repeat(40), operationId: approvalFor(made.run).operationId, nonces: [made.run.nonce],
    }, { freshProof: made.proof }));
    assert.deepEqual(await snapshot(db), before);
  });
});

test("805-style intent is recorded by the real journal, then capacity is released", async () => {
  await withTemp(async (db) => {
    const made = pair("intent", { intent: false });
    await insertPair(db, made);
    const loaded = await loadRelease();
    const journal = new loaded.mod.BoxDurableJournal(journalPool(db));
    const result = await applyRun(guard(db), "pg_temp", manifestOf(made), made.run, approvalFor(made.run), {
      freshProof: made.proof, journal,
    });
    assert.equal(result.status, "applied");
    const intents = await db.query("SELECT ctx->'boxCancelIntent'->>'requestId' AS request_id, ctx->>'boxState' AS box_state, ctx->'boxCancelIntent'->>'atMs' AS at_ms FROM request_finalize_journal ORDER BY request_id");
    assert.ok(intents.rows.every((row) => row.request_id === made.run.leafRequestId && row.box_state === ABANDON_STATE));
    await journal.recordUserCancelIntent({
      requestId: made.run.leafRequestId, uid: 3n, accountId: 20n,
      runNonce: made.run.nonce, leaseEpoch: made.run.epoch,
    });
    const reread = await db.query("SELECT ctx->>'boxState' AS box_state, ctx->'boxCancelIntent'->>'atMs' AS at_ms FROM request_finalize_journal ORDER BY request_id");
    assert.deepEqual(reread.rows, intents.rows.map((row) => ({ box_state: row.box_state, at_ms: row.at_ms })));
  });
});

test("old replay and fallback cannot start a paid call; a new request can admit", async () => {
  await withTemp(async (db) => {
    const loaded = await loadRelease();
    const fingerprintMod = await import(pathToFileURL(join(RELEASE, "packages/commercial/src/http/proxy/boxCallFingerprint.ts")).href);
    const suffix = randomBytes(4).toString("hex");
    const sessionId = `session-${suffix}`;
    const turnKey = "a".repeat(64);
    const body = { model: "box-api-claude-opus-5-5", max_tokens: 100_000, stream: true,
      metadata: { user_id: JSON.stringify({ oc_turn_key: turnKey, session_id: sessionId }) },
      messages: [{ role: "user", content: "synthetic abandon replay" }] };
    const fingerprint = fingerprintMod.deriveBoxCallFingerprint(3n, body);
    const alias = fingerprintMod.deriveBoxFallbackAlias(3n, body);
    const made = pair(`adm${suffix}`, { intent: true });
    made.run.sessionId = sessionId;
    made.run.turnKey = turnKey;
    made.rootCtx.boxSessionId = sessionId;
    made.rootCtx.boxTurnKey = turnKey;
    made.rootCtx.boxReplayFingerprint = fingerprint.replayFingerprint;
    made.rootCtx.boxFallbackAlias = alias;
    made.rootCtx.boxRequestHash = fingerprint.requestHash;
    made.leafCtx.boxSessionId = sessionId;
    made.leafCtx.boxTurnKey = turnKey;
    await insertPair(db, made);
    const journal = new loaded.mod.BoxDurableJournal(journalPool(db));
    await applyRun(guard(db), "pg_temp", manifestOf(made), made.run, approvalFor(made.run), { freshProof: made.proof });
    await assert.rejects(() => journal.findReplayIdentity({ uid: 3n, canonicalModel: body.model, canonicalBody: body }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "BOX_REPLAY_EVIDENCE_INVALID");
    await db.query(`INSERT INTO request_finalize_journal(request_id, user_id, state, ctx)
      VALUES ('new-same', 3, 'inflight', $1::jsonb), ('new-alias', 3, 'inflight', $1::jsonb)`, [JSON.stringify({
        ...basis, boxBillingContext: { ...basis.boxBillingContext, sessionId, turnKey },
      })]);
    await assert.rejects(() => journal.admit({
      requestId: "new-same", uid: 3n, accountId: 20n, model: body.model,
      fingerprint, canonicalBody: body,
      runNonce: "e".repeat(24), leaseEpoch: "f".repeat(32), invocationMode: "text",
    }), (error: unknown) => error instanceof Error && "code" in error && error.code === "BOX_CALL_AMBIGUOUS");
    const sameAlias = { ...body, max_tokens: 120_000 };
    await assert.rejects(() => journal.admit({
      requestId: "new-alias", uid: 3n, accountId: 20n, model: body.model,
      fingerprint: fingerprintMod.deriveBoxCallFingerprint(3n, sameAlias), canonicalBody: sameAlias,
      runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32), invocationMode: "text",
    }), (error: unknown) => error instanceof Error && "code" in error && error.code === "BOX_CALL_AMBIGUOUS");
    const freshSession = `session-new-${suffix}`;
    const freshTurn = "b".repeat(64);
    const freshBody = { ...body, metadata: { user_id: JSON.stringify({ oc_turn_key: freshTurn, session_id: freshSession }) },
      messages: [{ role: "user", content: "synthetic new request" }] };
    await db.query(`INSERT INTO request_finalize_journal(request_id, user_id, state, ctx)
      VALUES ('new-ok', 3, 'inflight', $1::jsonb)`, [JSON.stringify({
        ...basis, boxBillingContext: { ...basis.boxBillingContext, sessionId: freshSession, turnKey: freshTurn },
      })]);
    await journal.admit({
      requestId: "new-ok", uid: 3n, accountId: 20n, model: body.model,
      fingerprint: fingerprintMod.deriveBoxCallFingerprint(3n, freshBody), canonicalBody: freshBody,
      runNonce: "1".repeat(24), leaseEpoch: "2".repeat(32), invocationMode: "text",
    });
    const admitted = await db.query("SELECT ctx->>'boxState' AS box_state FROM request_finalize_journal WHERE request_id = 'new-ok'");
    assert.equal(admitted.rows[0].box_state, "reserved");
    const usageCount = await db.query("SELECT count(*)::int AS n FROM usage_records");
    assert.equal(usageCount.rows[0].n, 2);
  });
});

test("concurrent resume of one handoff admits exactly one caller", async () => {
  const admin = client();
  await admin.connect();
  const schema = `ocv5_294_${randomBytes(4).toString("hex")}`;
  const a = client();
  const b = client();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`CREATE TABLE ${schema}.request_finalize_journal (
      request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint,
      state text NOT NULL, ctx jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      precheck_credits bigint, final_credits bigint, ledger_id bigint, usage_id bigint)`);
    await admin.query(`CREATE TABLE ${schema}.usage_records (
      id bigint PRIMARY KEY, request_id text NOT NULL, user_id bigint NOT NULL)`);
    await a.connect();
    await b.connect();
    await a.query(`SET search_path TO ${schema}`);
    await b.query(`SET search_path TO ${schema}`);
    const resolved = await a.query<{ nspname: string }>(
      `SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.oid = 'request_finalize_journal'::regclass`);
    assert.equal(resolved.rows[0]?.nspname, schema);
    const loaded = await loadRelease();
    const fp = await import(pathToFileURL(join(RELEASE, "packages/commercial/src/http/proxy/boxCallFingerprint.ts")).href);
    const catalogMod = await import(pathToFileURL(join(RELEASE, "packages/commercial/src/http/proxy/boxToolCatalog.ts")).href);
    const suffix = randomBytes(3).toString("hex");
    const sessionId = `session-${suffix}`;
    const turnKey = "a".repeat(64);
    const toolDeclarations = [{ name: "local_echo", description: "local-only",
      input_schema: { type: "object", properties: { value: { type: "string" } } } }];
    const firstBody = { model: "box-api-claude-opus-5-5", max_tokens: 128, stream: true,
      tools: toolDeclarations,
      metadata: { user_id: JSON.stringify({ oc_turn_key: turnKey, session_id: sessionId }) },
      messages: [{ role: "user", content: "synthetic first prompt" }] };
    const catalogHash = catalogMod.compileBoxToolCatalog(toolDeclarations).bindingSha256;
    const ownerId = `owner-${suffix}`;
    const billing = { ...basis, boxBillingContext: { ...basis.boxBillingContext, sessionId, turnKey } };
    await a.query(`INSERT INTO request_finalize_journal(request_id, user_id, state, ctx) VALUES ($1, 3, 'inflight', $2::jsonb)`,
      [ownerId, JSON.stringify(billing)]);
    const setup = new loaded.mod.BoxDurableJournal({
      connect: async () => ({ query: a.query.bind(a), release() {} }),
      query: a.query.bind(a),
    });
    const admitted = {
      requestId: ownerId, uid: 3n, accountId: 20n, model: firstBody.model,
      invocationMode: "detached_tool" as const,
      contextHash: fp.deriveBoxContextHash(firstBody),
      detachedRunnerHash: "f".repeat(64), catalogHash,
      fingerprint: { ...fp.deriveBoxCallFingerprint(3n, firstBody), replayFingerprint: "9".repeat(64) },
      runNonce: "3".repeat(24), leaseEpoch: "4".repeat(32),
      nativeStart: { sessionId: "12345678-1234-4123-8123-123456789abc", cliCwd: `/tmp/ocv5-289-run-${"3".repeat(24)}` },
    };
    await setup.admit(admitted);
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
    const resumeBody = { ...firstBody, messages: [...firstBody.messages,
      { role: "assistant", content: [assistant[0], assistant[1], ...toolUses.map((use) => ({
        type: "tool_use", id: use.id, name: use.clientName, input: use.input }))] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_B", content: "second" },
        { type: "tool_result", tool_use_id: "toolu_A", content: "first" },
      ] }] };
    for (const id of [`race-a-${suffix}`, `race-b-${suffix}`]) {
      await a.query(`INSERT INTO request_finalize_journal(request_id, user_id, state, ctx) VALUES ($1, 3, 'inflight', $2::jsonb)`,
        [id, JSON.stringify(billing)]);
    }
    const queue = [a, b];
    const raced = new loaded.mod.BoxDurableJournal({
      connect: async () => {
        const next = queue.shift();
        if (!next) throw new Error("no client");
        return { query: next.query.bind(next), release() { queue.push(next); } };
      },
      query: a.query.bind(a),
    });
    const attempts = await Promise.allSettled([`race-a-${suffix}`, `race-b-${suffix}`].map((requestId) =>
      raced.claimToolResume({ requestId, uid: 3n, canonicalModel: firstBody.model, canonicalBody: resumeBody })));
    const won = attempts.filter((item) => item.status === "fulfilled");
    const lost = attempts.filter((item) => item.status === "rejected");
    assert.equal(won.length, 1);
    assert.equal(lost.length, 1);
    const owner = await a.query("SELECT ctx->>'boxState' AS box_state FROM request_finalize_journal WHERE request_id = $1", [ownerId]);
    assert.equal(owner.rows[0].box_state, "resuming");
    const linked = await a.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE ctx->>'boxState' = 'linked'");
    assert.equal(linked.rows[0].n, 1);
    const usage = await a.query("SELECT count(*)::int AS n FROM usage_records");
    assert.equal(usage.rows[0].n, 0);
  } finally {
    await a.end().catch(() => {});
    await b.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test("advisory lock order is account, sorted fingerprint, then session", () => {
  const keys = advisoryKeys({ accountId: "20", fingerprints: ["bb".repeat(32), "aa".repeat(32)], uid: "3", sessionId: "session-z" });
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(keys[0], "box:account:20");
  assert.ok(keys[1]!.includes("aa"));
  assert.ok(keys.at(-1)!.startsWith("box:session:"));
  assert.equal(randomUUID().length, 36);
});
