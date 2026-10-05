/** OCV5-313 one-shot: settle the one journal row an earlier operator release
 * left `inflight`.
 *
 * a50c01dc… (uid 3, account 20, round 46, continuation_unknown) carries
 * boxState operator_completed_released and the marker
 * boxOperatorCompletedRelease written on 2026-09-30 by operation
 * ocv5-296-r43-completed-release-v1 (keeper proof worker_complete; three model
 * responses nobody received: tool_use, tool_use, end_turn; financial
 * disposition unsettled_preserved_no_adjustment). The row was never billed and
 * has no usage record, but its journal state stayed `inflight`.
 *
 * This closes only that leaf the way an undelivered, unbilled round is always
 * settled (OCV5-300 rejected_stream, OCV5-306): state aborted, STREAM_FAILED,
 * final_credits 0, plus an audit marker. boxState, the release marker, usage,
 * ledger, the ancestors and updated_at are not changed. The marker is pinned
 * by the sha256 of its exact stored value, so any other row or any edited
 * evidence is refused. Dry-run unless --apply.
 *
 *   (set -a; . /etc/openclaude/commercial-v5-selfhost.env; set +a;
 *    OCV5_289_ACK_USER_ID=3 OCV5_289_ACK_ACCOUNT_ID=20 OCV5_289_TICKET=OCV5-<n> \
 *    OCV5_289_LEGACY_LEAF_CLOSE_ACK=1 npx tsx scripts/ocv5-289/boxLegacyReleasedLeafClose.ts [--apply])
 */
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";
import { requireBoxOperatorAccount } from "./boxOperatorAccount.js";

export const LEGACY_RELEASED_LEAF = {
  requestId: "a50c01dcc2307bb7698278d41029f345",
  uid: "3", accountId: "20",
  runNonce: "2547ebc7cbe3faf84b10262c",
  leaseEpoch: "690615927e3f4157edac9b4f65c9a0a3",
  /** sha256 of (ctx->'boxOperatorCompletedRelease')::text as stored. */
  markerSha256: "788b112be531ef9e094d56a3ee650c27c7c142dcf7008f61c06ce2ad871c4be5",
} as const;
export type LegacyReleasedLeaf = { readonly [K in keyof typeof LEGACY_RELEASED_LEAF]: string };

export class BoxLegacyLeafCloseError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxLegacyLeafCloseError"; }
}

export async function closeLegacyReleasedLeaf(
  pool: { connect(): Promise<Pick<PoolClient, "query" | "release">> },
  input: { ticket: string; apply: boolean; leaf?: LegacyReleasedLeaf }):
  Promise<{ requestId: string; action: "closed" | "would_close" }> {
  const leaf = input.leaf ?? LEGACY_RELEASED_LEAF;
  if (!/^OCV5-[0-9]{1,6}$/.test(input.ticket)) {
    throw new BoxLegacyLeafCloseError("BOX_LEGACY_LEAF_INPUT_INVALID");
  }
  const client = await pool.connect();
  let finished = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const peek = await client.query<{ session_id: string | null }>(
      `SELECT ctx->>'boxSessionId' AS session_id FROM request_finalize_journal
        WHERE request_id=$1 AND user_id=$2`, [leaf.requestId, leaf.uid]);
    const sessionId = peek.rows[0]?.session_id;
    if (peek.rowCount !== 1 || typeof sessionId !== "string"
      || !/^[A-Za-z0-9._:-]{1,256}$/.test(sessionId)) {
      throw new BoxLegacyLeafCloseError("BOX_LEGACY_LEAF_ROW_MISSING");
    }
    // Same keys, order and hash as the journal's own lock() helper.
    for (const key of [`box:account:${leaf.accountId}`,
      `box:session:${leaf.uid}:${sessionId}`].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [key]);
    }
    const account = await client.query<{ provider: string; status: string }>(
      "SELECT provider,status FROM claude_accounts WHERE id=$1 FOR SHARE", [leaf.accountId]);
    if (account.rowCount !== 1 || account.rows[0]?.provider !== "cursor"
      || account.rows[0]?.status !== "disabled") {
      throw new BoxLegacyLeafCloseError("BOX_LEGACY_LEAF_ACCOUNT_NOT_DISABLED");
    }
    const usage = await client.query(
      "SELECT 1 FROM usage_records WHERE request_id=$1 AND user_id=$2 LIMIT 1",
      [leaf.requestId, leaf.uid]);
    if (usage.rowCount) throw new BoxLegacyLeafCloseError("BOX_LEGACY_LEAF_USAGE_PRESENT");
    const changed = await client.query(
      `UPDATE request_finalize_journal
          SET state='aborted', failure_code='STREAM_FAILED', final_credits=0,
              ctx=ctx || jsonb_build_object('boxOperatorLeafSettle',jsonb_build_object(
                'v',1,'ticket',$8::text,'atMs',(EXTRACT(EPOCH FROM NOW())*1000)::bigint,
                'priorState','inflight','outcome','undelivered_unbilled'))
        WHERE request_id=$1 AND user_id=$2 AND state='inflight' AND final_credits IS NULL
          AND ctx->>'boxSessionId'=$3 AND ctx->>'boxAccountId'=$4
          AND ctx->>'boxRunNonce'=$5 AND ctx->>'boxLeaseEpoch'=$6
          AND ctx->>'boxInvocationRecovery'='v1'
          AND ctx->>'boxInvocationMode'='detached_tool'
          AND ctx->>'boxState'='operator_completed_released'
          AND NOT (ctx ? 'boxToolHandoff') AND NOT (ctx ? 'boxTerminalProof')
          AND NOT (ctx ? 'boxResumeRequestId') AND NOT (ctx ? 'settlementClaimId')
          AND NOT (ctx ? 'boxOperatorLeafSettle')
          AND encode(sha256(convert_to((ctx->'boxOperatorCompletedRelease')::text,'UTF8')),'hex')=$7`,
      [leaf.requestId, leaf.uid, sessionId, leaf.accountId, leaf.runNonce, leaf.leaseEpoch,
        leaf.markerSha256, input.ticket]);
    if (changed.rowCount !== 1) throw new BoxLegacyLeafCloseError("BOX_LEGACY_LEAF_FENCE_LOST");
    await client.query(input.apply ? "COMMIT" : "ROLLBACK");
    finished = true;
    return { requestId: leaf.requestId, action: input.apply ? "closed" : "would_close" };
  } finally {
    if (!finished) await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const ticket = process.env.OCV5_289_TICKET ?? "";
  if (process.argv.slice(2).some((arg) => arg !== "--apply")
    || process.getuid?.() !== 0 || getRuntimeChannel() !== "v5"
    || process.env.OCV5_289_LEGACY_LEAF_CLOSE_ACK !== "1"
    || process.env.OCV5_289_ACK_USER_ID !== LEGACY_RELEASED_LEAF.uid
    || requireBoxOperatorAccount("BOX_LEGACY_LEAF_ACK_REQUIRED").text
      !== LEGACY_RELEASED_LEAF.accountId) {
    throw new Error("BOX_LEGACY_LEAF_ACK_REQUIRED");
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("BOX_LEGACY_LEAF_DATABASE_MISSING");
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "openclaude_v5_selfhost") {
      throw new Error("BOX_LEGACY_LEAF_DATABASE_WRONG");
    }
    console.log(JSON.stringify(await closeLegacyReleasedLeaf(pool, { ticket, apply })));
  } finally { await pool.end(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.log(JSON.stringify({ action: "error", error: error instanceof Error
      && /^[A-Z0-9_]{1,64}$/.test(error.message) ? error.message : "BOX_LEGACY_LEAF_FAILED" }));
    process.exitCode = 1;
  });
}
