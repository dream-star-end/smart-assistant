/** Operator close of Box stop-probe rows pinned to a disabled account (see
 * boxUnreachableClose.ts, OCV5-312). Dry-run unless --apply. No Box call, no
 * model call, no billing change; the account row is only read.
 *
 * Each run is named exactly as <requestId>:<runNonce>; the account, the user
 * and the ticket come from the environment, nothing is built in.
 *
 * --expire (OCV5-313) gives rows a real terminal state instead: it calls the
 * journal's markRunExpiredUnproven for each named leaf (expired_unproven, the
 * waiting ancestors included), also for a leaf an earlier run of this tool
 * left in operator_unreachable_closed.
 *
 * Run on the egress host as root with the service env:
 *   (set -a; . /etc/openclaude/commercial-v5-selfhost.env; set +a;
 *    OCV5_289_ACK_USER_ID=3 OCV5_289_ACK_ACCOUNT_ID=<id> OCV5_289_TICKET=OCV5-<n> \
 *    OCV5_289_UNREACHABLE_CLOSE_ACK=1 npx tsx scripts/ocv5-289/boxOperatorCloseUnreachable.ts \
 *      <requestId>:<runNonce>... [--expire] [--apply])
 */
import { Pool } from "pg";
import { BoxDurableJournal, BoxDurableJournalError } from
  "../../packages/commercial/src/http/proxy/boxDurableJournal.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";
import { requireBoxOperatorAccount } from "./boxOperatorAccount.js";
import { BoxUnreachableCloseError, closeUnreachableBoxRows } from "./boxUnreachableClose.js";

const FLAGS = new Set(["--apply", "--expire"]);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply"), expire = args.includes("--expire");
  const runs = args.filter((arg) => !FLAGS.has(arg)).map((arg) => {
    const match = /^([A-Za-z0-9_-]{1,64}):([a-f0-9]{24})$/.exec(arg);
    if (!match) throw new Error("BOX_UNREACHABLE_USAGE");
    return { requestId: match[1]!, runNonce: match[2]! };
  });
  if (!runs.length || runs.length > 8
    || new Set(runs.map((run) => run.requestId)).size !== runs.length) {
    throw new Error("BOX_UNREACHABLE_USAGE");
  }
  const ticket = process.env.OCV5_289_TICKET ?? "";
  if (process.getuid?.() !== 0 || getRuntimeChannel() !== "v5"
    || process.env.OCV5_289_UNREACHABLE_CLOSE_ACK !== "1"
    || process.env.OCV5_289_ACK_USER_ID !== "3" || !/^OCV5-[0-9]{1,6}$/.test(ticket)) {
    throw new Error("BOX_UNREACHABLE_ACK_REQUIRED");
  }
  const account = requireBoxOperatorAccount("BOX_UNREACHABLE_ACK_REQUIRED");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("BOX_UNREACHABLE_DATABASE_MISSING");
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "openclaude_v5_selfhost") {
      throw new Error("BOX_UNREACHABLE_DATABASE_WRONG");
    }
    if (!expire) {
      const results = await closeUnreachableBoxRows(pool, { uid: 3n, accountId: account.id,
        runs, ticket, apply });
      for (const result of results) console.log(JSON.stringify(result));
      return;
    }
    const status = await pool.query<{ provider: string; status: string }>(
      "SELECT provider,status FROM claude_accounts WHERE id=$1", [account.text]);
    if (status.rows[0]?.provider !== "cursor" || status.rows[0]?.status !== "disabled") {
      throw new Error("BOX_UNREACHABLE_ACCOUNT_NOT_DISABLED");
    }
    const journal = new BoxDurableJournal(pool);
    for (const run of runs) {
      // The lease epoch is read, never typed: the operator's fence is the nonce.
      const row = await pool.query<{ epoch: string | null }>(
        `SELECT ctx->>'boxLeaseEpoch' AS epoch FROM request_finalize_journal
          WHERE request_id=$1 AND user_id=3 AND ctx->>'boxRunNonce'=$2
            AND ctx->>'boxAccountId'=$3`, [run.requestId, run.runNonce, account.text]);
      const leaseEpoch = row.rows[0]?.epoch;
      if (row.rowCount !== 1 || typeof leaseEpoch !== "string"
        || !/^[a-f0-9]{32}$/.test(leaseEpoch)) {
        throw new BoxUnreachableCloseError("BOX_UNREACHABLE_ROW_MISSING", run.requestId);
      }
      let result;
      try {
        result = await journal.markRunExpiredUnproven({ requestId: run.requestId, uid: 3n,
          accountId: account.id, runNonce: run.runNonce, leaseEpoch, cause: "operator",
          operatorClosed: true, apply });
      } catch (error) {
        if (error instanceof BoxDurableJournalError) {
          throw new BoxUnreachableCloseError(error.code, run.requestId);
        }
        throw error;
      }
      console.log(JSON.stringify({ requestId: run.requestId, ...result }));
    }
  } finally { await pool.end(); }
}

main().catch((error: unknown) => {
  console.log(JSON.stringify(error instanceof BoxUnreachableCloseError
    ? { action: "error", error: error.code, requestId: error.requestId }
    : { action: "error", error: error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
      ? error.message : "BOX_UNREACHABLE_FAILED" }));
  process.exitCode = 1;
});
