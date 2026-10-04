/**
 * OCV5-300 operator recovery for a Box first round left `unknown` before the
 * rejected-stream settlement existed (OCV5-299 era). Such a row pins its
 * session (next message: IDLE_HISTORY_PENDING -> "消息未开始处理") and one
 * account slot forever.
 *
 * Only the two allowlisted incident rows (ALLOWED_RUNS) are accepted. For each: require a detached_tool first round in
 * inflight/unknown (phase first_round_unknown), no tool handoff, no usage,
 * idle > 30 min, then read the original keeper's terminal proof from Box.
 * With --apply, settle it via BoxDurableJournal.markFirstRoundRejectedStream
 * (aborted, failed_stopped/rejected_stream, final_credits 0). No model call,
 * no stop, no billing. The gateway idle proof then reads `failed` and the
 * session's pending history lock clears on its next submit.
 *
 * Run on the egress host with the egress env:
 *   (set -a; . /etc/openclaude/commercial-v5-selfhost.env; set +a;
 *    node --import tsx scripts/ocv5-300/settle-rejected-unknown.mts <requestId>... [--apply])
 */
import { Pool } from "pg";
import { createProductionBoxAccountResolver } from "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { BoxDurableJournal } from "../../packages/commercial/src/http/proxy/boxDurableJournal.js";
import { readBoxTerminalProof } from "../../packages/commercial/src/http/proxy/boxTerminalProof.js";

// Exact incident rows only. Each was verified (read-only probe of the run's
// stdout.jsonl) to have been rejected locally with BOX_TOOL_ID_OR_NAME_INVALID
// (the model called a bare client tool name the CLI did not expose), so a
// zero-credit settle cannot hide a delivered, billable answer. Any other row
// must go through the normal unknown recovery path.
const ALLOWED_RUNS = new Map([
  ["fc4816836bbb2153efab4d64ff65f55c", "4aca2c130ee3282baed58609"],
  ["3265c64668ea6ca8e02f8b2b62feeacb", "72f52825153c3157af050330"],
]);
const apply = process.argv.includes("--apply");
const ids = process.argv.slice(2).filter((arg) => arg !== "--apply");
if (!ids.length || ids.some((id) => !ALLOWED_RUNS.has(id))) {
  console.error("usage: settle-rejected-unknown.mts <requestId>... [--apply]");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required (egress env)");
const pool = new Pool({ connectionString: url, max: 2 });
const journal = new BoxDurableJournal(pool);
const resolver = createProductionBoxAccountResolver();
let failures = 0;
try {
  for (const requestId of ids) {
    const found = await pool.query<{ user_id: string; state: string; ctx: Record<string, unknown>; idle_s: number }>(
      `SELECT user_id::text, state, ctx, EXTRACT(EPOCH FROM now()-updated_at)::int AS idle_s
         FROM request_finalize_journal WHERE request_id=$1`, [requestId]);
    const row = found.rows[0];
    const ctx = row?.ctx ?? {};
    const reasons: string[] = [];
    if (!row) reasons.push("not_found");
    else {
      if (row.state !== "inflight") reasons.push(`state=${row.state}`);
      if (ctx.boxState !== "unknown") reasons.push(`boxState=${String(ctx.boxState)}`);
      if (ctx.boxUnknownPhase !== "first_round_unknown") reasons.push(`phase=${String(ctx.boxUnknownPhase)}`);
      if (ctx.boxInvocationMode !== "detached_tool") reasons.push("not_detached_tool");
      if (ctx.boxToolHandoff !== undefined) reasons.push("has_handoff");
      if (ctx.boxRunNonce !== ALLOWED_RUNS.get(requestId)) reasons.push("run_nonce_mismatch");
      if (row.idle_s < 1800) reasons.push(`idle_s=${row.idle_s}`);
    }
    if (reasons.length) {
      console.log(JSON.stringify({ requestId, action: "skip", reasons }));
      continue;
    }
    const uid = BigInt(row!.user_id);
    const accountId = BigInt(String(ctx.boxAccountId));
    const runNonce = String(ctx.boxRunNonce), leaseEpoch = String(ctx.boxLeaseEpoch);
    const target = await resolver.resolve({ uid, sessionId: null, requestId: `ocv5-300-settle-${requestId}`,
      upstreamModel: "claude-opus-5-5", requiredAccountId: accountId, signal: new AbortController().signal });
    try {
      if (target.accountId !== accountId) throw new Error("ACCOUNT_MISMATCH");
      const proof = await readBoxTerminalProof({ target, expectedAccountId: accountId, runNonce, leaseEpoch });
      if (!apply) {
        console.log(JSON.stringify({ requestId, action: "would_settle", proofReason: proof.reason,
          session: ctx.boxSessionId }));
        continue;
      }
      await journal.markFirstRoundRejectedStream({ requestId, uid, leaseEpoch, proof });
      console.log(JSON.stringify({ requestId, action: "settled", proofReason: proof.reason,
        session: ctx.boxSessionId }));
    } catch (error) {
      failures++;
      console.log(JSON.stringify({ requestId, action: "error", error: (error as Error).message }));
    } finally {
      await Promise.resolve((target as { dispose?: () => unknown }).dispose?.()).catch(() => {});
    }
  }
} finally { await pool.end(); }
process.exit(failures ? 1 : 0);
