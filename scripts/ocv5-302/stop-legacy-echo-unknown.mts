/**
 * OCV5-302 operator recovery for Box tool chains wedged before the image
 * normalization shipped: the client published an over-limit image, the Box CLI
 * echoed its resized copy, and the strict echo bind left the chain open
 * (continuation_unknown / handoff) with the CLI waiting for a tool result that
 * can never arrive. The session then rejects new messages and the run holds an
 * account slot until its four-hour deadline.
 *
 * Exactly what the user's Stop button does (BoxUserStopCoordinator): record
 * the cancel intent, stop the original keeper by nonce/epoch, and close the
 * chain as failed_stopped from the keeper's own proof. No model call and no
 * new charge. Only the allowlisted rows (verified by a read-only probe of their
 * run dirs: published 1290x2796 PNG, CLI echo 923x2000) are accepted.
 *
 * Run on the egress host with the egress env (dry-run unless --apply):
 *   (set -a; . /etc/openclaude/commercial-v5-selfhost.env; set +a;
 *    node --import tsx scripts/ocv5-302/stop-legacy-echo-unknown.mts <requestId>... [--apply])
 */
import { Pool } from "pg";
import { createProductionBoxAccountResolver } from "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { BoxDurableJournal } from "../../packages/commercial/src/http/proxy/boxDurableJournal.js";
import { BoxUserStopCoordinator } from "../../packages/commercial/src/http/proxy/boxUserStopCoordinator.js";

const ALLOWED = new Map([
  ["91cdcc072d945de586fef5f397b067ab", { runNonce: "f34468e654bfc32d24464176",
    leaseEpoch: "d9171597132edef278e8af6e4d089408" }],
  ["7a496b9aa2f38d4824af404d3332e0e9", { runNonce: "0f5c1c76a01312dd7de912e1",
    leaseEpoch: "fa4a73b8412cf046d7514aa81e6ca08f" }],
]);
const apply = process.argv.includes("--apply");
const ids = process.argv.slice(2).filter((arg) => arg !== "--apply");
if (!ids.length || ids.some((id) => !ALLOWED.has(id))) {
  console.error("usage: stop-legacy-echo-unknown.mts <allowlisted requestId>... [--apply]");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required (egress env)");
const pool = new Pool({ connectionString: url, max: 2 });
const journal = new BoxDurableJournal(pool);
const resolver = createProductionBoxAccountResolver();
const coordinator = new BoxUserStopCoordinator({ journal, resolver });
let failures = 0;
try {
  for (const requestId of ids) {
    const want = ALLOWED.get(requestId)!;
    const found = await pool.query<{ user_id: string; state: string; ctx: Record<string, unknown> }>(
      "SELECT user_id::text, state, ctx FROM request_finalize_journal WHERE request_id=$1", [requestId]);
    const row = found.rows[0], ctx = row?.ctx ?? {};
    const reasons: string[] = [];
    if (!row) reasons.push("not_found");
    else {
      if (ctx.boxRunNonce !== want.runNonce || ctx.boxLeaseEpoch !== want.leaseEpoch) reasons.push("identity_mismatch");
      if (ctx.boxInvocationMode !== "detached_tool") reasons.push("not_detached_tool");
      if (!["unknown", "handoff"].includes(String(ctx.boxState))) reasons.push(`boxState=${String(ctx.boxState)}`);
    }
    if (reasons.length) { console.log(JSON.stringify({ requestId, action: "skip", reasons })); continue; }
    const identity = { requestId, uid: BigInt(row!.user_id), accountId: BigInt(String(ctx.boxAccountId)),
      runNonce: want.runNonce, leaseEpoch: want.leaseEpoch };
    if (!apply) {
      console.log(JSON.stringify({ requestId, action: "would_stop", state: row!.state, boxState: ctx.boxState }));
      continue;
    }
    const outcome = await coordinator.requestStop(identity);
    const after = (await pool.query<{ state: string; bs: string }>(
      "SELECT state, ctx->>'boxState' bs FROM request_finalize_journal WHERE request_id=$1", [requestId])).rows[0];
    if (outcome !== "stopped_proven") failures++;
    console.log(JSON.stringify({ requestId, action: "stop", outcome, after }));
  }
} finally { await pool.end(); }
process.exit(failures ? 1 : 0);
