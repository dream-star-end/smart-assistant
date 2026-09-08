#!/usr/bin/env npx tsx
/**
 * On-demand read-only business health snapshot (OCV5-180 I3).
 *
 *   npx tsx scripts/ops/business-health.ts
 *   npx tsx scripts/ops/business-health.ts --timeout-ms 5000 --limit 50000
 *
 * Uses DATABASE_URL / COMMERCIAL_DATABASE_URL. Read-only (default_transaction_read_only).
 * Timeouts are reported as unknown, never as 0. Does not write, prune, settle, or deploy.
 */
import pg from "pg";
import { collectBusinessHealthSnapshot } from "../../packages/commercial/src/admin/businessHealth.ts";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const url = process.env.COMMERCIAL_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("COMMERCIAL_DATABASE_URL or DATABASE_URL required");
    process.exit(2);
  }
  const timeoutMs = Number(arg("--timeout-ms") ?? "5000");
  const limit = Number(arg("--limit") ?? "50000");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    console.error("--timeout-ms must be a positive number");
    process.exit(2);
  }
  if (!Number.isFinite(limit) || limit < 1) {
    console.error("--limit must be a positive number");
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    const snapshot = await collectBusinessHealthSnapshot(pool, {
      statementTimeoutMs: Math.floor(timeoutMs),
      streamLimit: Math.floor(limit),
    });
    console.log(JSON.stringify(snapshot, null, 2));
    const unknown =
      snapshot.tapeMaterialization.unknown ||
      snapshot.settlementHeld.unknown ||
      snapshot.cursorAuditSuccessWithoutUsage.unknown ||
      snapshot.liveFrames.unknown ||
      snapshot.retentionUnknown;
    process.exit(unknown ? 4 : 0);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
