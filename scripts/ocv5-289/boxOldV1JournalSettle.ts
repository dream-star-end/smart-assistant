/** One-time exact journal CAS after separately proven old-v1 remote cleanup.
 * No Box call, no model replay, no wallet/usage/ledger mutation or migration. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";

const REQUEST_ID = "2d83f86c132bbbf39ad93adc64426b09";
const NONCE = "23aa4f1a6e60b1d4efcdcaac";
const EPOCH = "4885d52ce7c1038d516e8bbbe247fe06";
const RUNTIME = "dbbd6c1dbc96f64b0a8a";
const RUN_HASH = "ad69e45fbd7da8b0080042ba598512b3bc44c0e3392298e30a6eba71d1f9b207";
const PROJECT_HASH = "8c449c837d310dd1fe42853fdf930db558652d9fbb2b9dc57f990961564468ed";
const PROOF = "/var/lib/openclaude/ocv5-289-box-operator/"
  + `old-v1-${NONCE}.cleaned.json`;

type JournalRow = { state: string; final_credits: string | null;
  ctx: Record<string, unknown> };
function requireExact(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
function loadProof(): string {
  const fd = openSync(PROOF, constants.O_RDONLY | constants.O_NOFOLLOW
    | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    requireExact(st.isFile() && st.uid === 0 && (st.mode & 0o777) === 0o600
      && st.nlink === 1 && st.size > 0 && st.size < 2048,
    "BOX_OLD_PROOF_FILE_INVALID");
    const raw = readFileSync(fd);
    requireExact(raw.length === st.size, "BOX_OLD_PROOF_FILE_CHANGED");
    const item = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    const cleanup = item.remoteCleanup as Record<string, unknown> | undefined;
    requireExact(item.v === 1 && item.requestId === REQUEST_ID
      && item.uid === "3" && item.accountId === "20"
      && item.runNonce === NONCE && item.leaseEpoch === EPOCH
      && item.runtimeHash === RUNTIME && item.runMetadataHash === RUN_HASH
      && item.projectMetadataHash === PROJECT_HASH
      && item.paidReplay === false && item.journalSettled === false
      && typeof item.observedAt === "string"
      && Number.isFinite(Date.parse(item.observedAt))
      && Date.now() - Date.parse(item.observedAt) >= 0
      && Date.now() - Date.parse(item.observedAt) < 6 * 60 * 60 * 1000
      && cleanup && cleanup.runNonce === NONCE
      && cleanup.runtimeHash === RUNTIME && cleanup.cleaned === true
      && cleanup.projectHistoryFilesRemoved === 1
      && cleanup.runFilesRemoved === 0,
    "BOX_OLD_PROOF_CONTENT_INVALID");
    return createHash("sha256").update(raw).digest("hex");
  } finally { closeSync(fd); }
}
function validateRow(row: JournalRow | undefined): { fingerprint: string;
  sessionId: string; turnKey: string } {
  requireExact(row && row.state === "inflight"
    && row.final_credits === null, "BOX_OLD_JOURNAL_STATE_CHANGED");
  const c = row.ctx;
  requireExact(c.model === "box-api-claude-opus-5-5"
    && c.boxInvocationRecovery === "v1"
    && c.boxInvocationMode === "detached_tool"
    && c.boxAccountId === "20" && c.boxRunNonce === NONCE
    && c.boxLeaseEpoch === EPOCH && c.boxState === "unknown"
    && c.boxUnknownPhase === "stage_transport_unknown"
    && typeof c.boxReplayFingerprint === "string"
    && /^[a-f0-9]{64}$/.test(c.boxReplayFingerprint)
    && typeof c.boxSessionId === "string"
    && /^[A-Za-z0-9._:-]{1,256}$/.test(c.boxSessionId)
    && typeof c.boxTurnKey === "string"
    && /^[a-f0-9]{64}$/.test(c.boxTurnKey)
    && c.billingPricing !== undefined && c.boxBillingContext !== undefined,
  "BOX_OLD_JOURNAL_IDENTITY_CHANGED");
  for (const forbidden of ["boxToolHandoff", "boxOwnerRequestId",
    "boxResumeRequestId", "boxTerminalProof", "boxUsage",
    "boxPrelaunchControl", "boxLaunchPermit", "boxOperatorRecovery",
    "boxBillingClaim", "boxCancelIntent", "boxRemoteCleanup",
    "boxHandoffRevision", "boxFinalizationClaim", "settlementClaimId"]) {
    requireExact(!Object.hasOwn(c, forbidden), "BOX_OLD_JOURNAL_EVIDENCE_CONFLICT");
  }
  return { fingerprint: c.boxReplayFingerprint as string,
    sessionId: c.boxSessionId as string, turnKey: c.boxTurnKey as string };
}
async function readRow(client: PoolClient): Promise<JournalRow | undefined> {
  const found = await client.query<JournalRow>(
    `SELECT state,final_credits::text AS final_credits,ctx
       FROM request_finalize_journal
      WHERE request_id=$1 AND user_id=3`, [REQUEST_ID]);
  requireExact(found.rowCount === 1, "BOX_OLD_JOURNAL_ROW_MISSING");
  return found.rows[0];
}

async function main(): Promise<void> {
  requireExact(process.getuid?.() === 0
    && process.env.OCV5_289_ACK_USER_ID === "3"
    && process.env.OCV5_289_ACK_ACCOUNT_ID === "20"
    && process.env.OCV5_289_OLD_V1_SETTLE_ACK === REQUEST_ID
    && getRuntimeChannel() === "v5",
  "BOX_OLD_SETTLE_ACK_REQUIRED");
  const proofHash = loadProof();
  const url = process.env.DATABASE_URL;
  requireExact(typeof url === "string" && url.length > 0,
    "BOX_OLD_SETTLE_DATABASE_MISSING");
  const pool = new Pool({ connectionString: url, max: 1 });
  let client: PoolClient;
  try { client = await pool.connect(); }
  catch (error) { await pool.end(); throw error; }
  let committed = false;
  let commitAttempted = false;
  try {
    const database = await client.query<{ current_database: string }>(
      "SELECT current_database()");
    requireExact(database.rows[0]?.current_database === "openclaude_v5_selfhost",
      "BOX_OLD_SETTLE_DATABASE_WRONG");
    const pricing = await client.query<{ enabled: boolean }>(
      "SELECT enabled FROM model_pricing WHERE model_id=$1",
      ["box-api-claude-opus-5-5"]);
    requireExact(pricing.rowCount === 1 && pricing.rows[0]?.enabled === false,
      "BOX_OLD_SETTLE_MODEL_NOT_DISABLED");
    const peek = validateRow(await readRow(client));
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const key of [
      "box:account:20", `box:fingerprint:${peek.fingerprint}`,
      `box:session:3:${peek.sessionId}`,
    ].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", [key]);
    }
    const locked = await client.query<JournalRow>(
      `SELECT state,final_credits::text AS final_credits,ctx
         FROM request_finalize_journal
        WHERE request_id=$1 AND user_id=3 FOR UPDATE`, [REQUEST_ID]);
    requireExact(locked.rowCount === 1, "BOX_OLD_SETTLE_LOCKED_ROW_MISSING");
    const after = validateRow(locked.rows[0]);
    requireExact(after.fingerprint === peek.fingerprint
      && after.sessionId === peek.sessionId && after.turnKey === peek.turnKey,
    "BOX_OLD_SETTLE_IDENTITY_DRIFT");
    const counts = await client.query<{ usage: string; ledger: string;
      perf_total: string; perf_error: string }>(`SELECT
        (SELECT COUNT(*)::text FROM usage_records
          WHERE request_id=$1 AND user_id=3) AS usage,
        (SELECT COUNT(*)::text FROM credit_ledger
          WHERE user_id=3 AND (
            (ref_type='usage_record'
              AND ref_id IN (SELECT id::text FROM usage_records
                WHERE request_id=$1 AND user_id=3))
            OR ref_id=$1 OR memo LIKE '%' || $1 || '%')) AS ledger,
        (SELECT COUNT(*)::text FROM turn_upstream_performance
          WHERE request_id=$1 AND user_id=3) AS perf_total,
        (SELECT COUNT(*)::text FROM turn_upstream_performance
          WHERE request_id=$1 AND user_id=3
            AND outcome='error' AND ttft_ms IS NULL) AS perf_error`, [REQUEST_ID]);
    requireExact(counts.rows[0]?.usage === "0"
      && counts.rows[0]?.ledger === "0"
      && counts.rows[0]?.perf_total === "1"
      && counts.rows[0]?.perf_error === "1",
    "BOX_OLD_SETTLE_FINANCIAL_EVIDENCE_CONFLICT");
    if (process.env.OCV5_289_OLD_V1_DRY_RUN === "1") {
      await client.query("ROLLBACK"); committed = true;
      process.stdout.write(JSON.stringify({ requestId: REQUEST_ID,
        dryRun: true, remoteProofVerified: true, exactRowVerified: true,
        modelDisabled: true, usageRows: 0, ledgerRows: 0,
        performanceErrorRows: 1, mutations: 0 }) + "\n");
      return;
    }
    const recovery = { v: 1, kind: "operator_prelaunch_cleanup",
      proofSha256: proofHash, runNonce: NONCE, leaseEpoch: EPOCH,
      runtimeHash: RUNTIME, remoteCleaned: true, paidDispatched: false };
    const changed = await client.query(
      `UPDATE request_finalize_journal
          SET state='aborted', failure_code='STREAM_FAILED',
              final_credits=0, updated_at=NOW(),
              ctx=ctx || $6::jsonb
        WHERE request_id=$1 AND user_id=3 AND state='inflight'
          AND final_credits IS NULL
          AND ctx->>'boxAccountId'='20'
          AND ctx->>'boxRunNonce'=$2 AND ctx->>'boxLeaseEpoch'=$3
          AND ctx->>'boxReplayFingerprint'=$4
          AND ctx->>'boxSessionId'=$5
          AND ctx->>'boxInvocationRecovery'='v1'
          AND ctx->>'boxInvocationMode'='detached_tool'
          AND ctx->>'boxState'='unknown'
          AND ctx->>'boxUnknownPhase'='stage_transport_unknown'
          AND NOT (ctx ? 'boxTerminalProof')
          AND NOT (ctx ? 'boxToolHandoff')
          AND NOT (ctx ? 'boxOperatorRecovery')`,
      [REQUEST_ID, NONCE, EPOCH, peek.fingerprint, peek.sessionId,
        JSON.stringify({ boxState: "prestart_stopped",
          boxOperatorRecovery: recovery })]);
    requireExact(changed.rowCount === 1, "BOX_OLD_SETTLE_CAS_LOST");
    commitAttempted = true;
    await client.query("COMMIT"); committed = true;
    process.stdout.write(JSON.stringify({ requestId: REQUEST_ID,
      state: "aborted", boxState: "prestart_stopped", finalCredits: 0,
      proofSha256: proofHash, usageRows: 0, ledgerRows: 0,
      remoteCleaned: true, paidReplay: false }) + "\n");
  } catch (error) {
    if (commitAttempted && !committed) {
      throw new Error("BOX_OLD_SETTLE_COMMIT_UNKNOWN", { cause: error });
    }
    throw error;
  } finally {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    client.release(); await pool.end();
  }
}
void main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
    ? error.message : "BOX_OLD_SETTLE_FAILED";
  process.stderr.write(code + "\n"); process.exitCode = 1;
});
