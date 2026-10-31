#!/usr/bin/env npx tsx
/**
 * OCV5-704 daily read-only reconciliation.
 *
 *   npx tsx scripts/ops/turn-label-ledger-reconcile.ts
 *   npx tsx scripts/ops/turn-label-ledger-reconcile.ts --since 2026-10-30T00:00:00+08:00 --until 2026-10-31T00:00:00+08:00
 *
 * Default window is the last 24 hours. Uses DATABASE_URL / COMMERCIAL_DATABASE_URL.
 * BEGIN READ ONLY. Does not change accounts, balances, or historical rows.
 *
 * Exit 0 when chat ledger debits equal turn labels plus explicit non-turn skips.
 * Exit 1 when they differ. Exit 2 when the window or the connection is unusable.
 *
 * Rows from before the attribution stamp have neither a label nor a skip mark.
 * A window that still contains them alarms until they age out. No backfill.
 */
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  TURN_LABEL_LEDGER_RECONCILE_SQL,
  TURN_LABEL_LEDGER_RECONCILE_USERS_SQL,
  reconcileWindow,
  redactDbUrl,
  turnLabelLedgerGap,
} from "../../packages/commercial/src/billing/turnLabelLedgerReconcile.ts";

export async function runTurnLabelLedgerReconcileCli(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<number> {
  const window = reconcileWindow(argv, now);
  if ("error" in window) {
    console.error(window.error);
    return 2;
  }
  const url = (env.COMMERCIAL_DATABASE_URL || env.DATABASE_URL || "").trim();
  if (!url) {
    console.error("COMMERCIAL_DATABASE_URL or DATABASE_URL required");
    return 2;
  }
  const timeoutMs = Number(argFrom(argv, "--timeout-ms") ?? "30000");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    console.error("--timeout-ms must be a positive number");
    return 2;
  }
  const boundedMs = Math.floor(timeoutMs);
  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: boundedMs,
    idleTimeoutMillis: Math.max(1000, boundedMs),
    allowExitOnIdle: true,
  });
  let exitCode = 2;
  const client = await pool.connect().catch((err: unknown) => {
    console.error(redactDbUrl(err instanceof Error ? err.message : String(err)));
    return null;
  });
  if (!client) {
    await pool.end().catch(() => {});
    return 2;
  }
  try {
    await client.query(`SELECT set_config('statement_timeout', $1, false)`, [String(boundedMs)]);
    await client.query("BEGIN READ ONLY");
    const totals = await client.query<{
      ledger_chat_debit: string;
      labeled: string;
      known_non_turn: string;
    }>(TURN_LABEL_LEDGER_RECONCILE_SQL, [window.since.toISOString(), window.until.toISOString()]);
    const row = totals.rows[0];
    if (!row) throw new Error("reconcile returned no row");
    const ledgerChatDebit = BigInt(row.ledger_chat_debit);
    const labeled = BigInt(row.labeled);
    const knownNonTurn = BigInt(row.known_non_turn);
    const gap = turnLabelLedgerGap({ ledgerChatDebit, labeled, knownNonTurn });
    const report: Record<string, unknown> = {
      since: window.since.toISOString(),
      until: window.until.toISOString(),
      ledgerChatDebit: ledgerChatDebit.toString(),
      labeled: labeled.toString(),
      knownNonTurn: knownNonTurn.toString(),
      gap: gap.toString(),
    };
    if (gap !== 0n) {
      const users = await client.query<{ user_id: string; gap: string }>(
        TURN_LABEL_LEDGER_RECONCILE_USERS_SQL,
        [window.since.toISOString(), window.until.toISOString()],
      );
      report.users = users.rows.map((user) => ({ userId: user.user_id, gap: user.gap }));
    }
    console.log(JSON.stringify(report));
    await client.query("COMMIT");
    exitCode = gap === 0n ? 0 : 1;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(redactDbUrl(err instanceof Error ? err.message : String(err)));
    exitCode = 2;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
  return exitCode;
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void runTurnLabelLedgerReconcileCli().then(
    (code) => {
      process.exitCode = code;
      process.exit(code);
    },
    (err) => {
      console.error(redactDbUrl(err instanceof Error ? err.message : String(err)));
      process.exitCode = 2;
      process.exit(2);
    },
  );
}
