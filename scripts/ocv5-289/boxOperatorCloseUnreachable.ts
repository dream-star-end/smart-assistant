/** OCV5-312 one-shot: close the four stop-probe rows left pinned to disabled
 * Box account 20 (see boxUnreachableClose.ts). Dry-run unless --apply. No Box
 * call, no model call, no billing change; the account row is only read.
 *
 * Run on the egress host as root with the service env:
 *   (set -a; . /etc/openclaude/commercial-v5-selfhost.env; set +a;
 *    OCV5_289_ACK_USER_ID=3 OCV5_289_ACK_ACCOUNT_ID=20 OCV5_289_UNREACHABLE_CLOSE_ACK=1 \
 *    npx tsx scripts/ocv5-289/boxOperatorCloseUnreachable.ts <requestId>... [--apply])
 */
import { Pool } from "pg";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";
import { requireBoxOperatorAccount } from "./boxOperatorAccount.js";
import { BoxUnreachableCloseError, closeUnreachableBoxRows } from "./boxUnreachableClose.js";

const TICKET = "OCV5-312";
const ACCOUNT_ID = 20n;
// Exact incident rows only (request id -> run nonce). Each was read from the
// journal while account 20 was disabled and SAND_ACCESS_STATE_PAYMENT_REQUIRED,
// with box_stop_probe_pending BOX_ACCOUNT_UNAVAILABLE logged every two minutes.
const ALLOWED_RUNS = new Map([
  ["0146534cb5c59afaf8bbc000e9c7d24d", "a204cfa4e7ad8b68831f06c3"],
  ["1febf6d7fd2813eb6fb9a92cee131acc", "106a97faf5db41667f1b0c7a"],
  ["a4c35ef63f6bb692e8303b52031a117f", "3db30823ad725ec80e3fe342"],
  ["cf3408adfc47c2f03080c601b3e1de84", "bd9d9223282a385088edf203"],
]);

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const ids = process.argv.slice(2).filter((arg) => arg !== "--apply");
  if (!ids.length || new Set(ids).size !== ids.length
    || ids.some((id) => !ALLOWED_RUNS.has(id))) {
    throw new Error("BOX_UNREACHABLE_USAGE");
  }
  if (process.getuid?.() !== 0 || getRuntimeChannel() !== "v5"
    || process.env.OCV5_289_UNREACHABLE_CLOSE_ACK !== "1"
    || process.env.OCV5_289_ACK_USER_ID !== "3"
    || requireBoxOperatorAccount("BOX_UNREACHABLE_ACK_REQUIRED").id !== ACCOUNT_ID) {
    throw new Error("BOX_UNREACHABLE_ACK_REQUIRED");
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("BOX_UNREACHABLE_DATABASE_MISSING");
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    if (database.rows[0]?.current_database !== "openclaude_v5_selfhost") {
      throw new Error("BOX_UNREACHABLE_DATABASE_WRONG");
    }
    const results = await closeUnreachableBoxRows(pool, { uid: 3n, accountId: ACCOUNT_ID,
      runs: ids.map((requestId) => ({ requestId, runNonce: ALLOWED_RUNS.get(requestId)! })),
      ticket: TICKET, apply });
    for (const result of results) console.log(JSON.stringify(result));
  } finally { await pool.end(); }
}

main().catch((error: unknown) => {
  console.log(JSON.stringify(error instanceof BoxUnreachableCloseError
    ? { action: "error", error: error.code, requestId: error.requestId }
    : { action: "error", error: error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
      ? error.message : "BOX_UNREACHABLE_FAILED" }));
  process.exitCode = 1;
});
