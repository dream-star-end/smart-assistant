/**
 * New-process recover worker for OCV5-188. Reads only FS + isolated PG.
 * argv: <outboxDir> <databaseUrl>
 */
import { createPool } from "../../db/index.js";
import { openCursorExternalApiOutbox } from "../../billing/cursorExternalApiOutbox.js";
import type { PricingCache } from "../../billing/pricing.js";

const directory = process.argv[2];
const databaseUrl = process.argv[3];
if (!directory || !databaseUrl) {
  process.stderr.write("usage: cursorExternalApiOutboxRecoverWorker <outboxDir> <databaseUrl>\n");
  process.exit(2);
}

const pricing = { get: () => null } as unknown as PricingCache;
const pool = createPool({
  connectionString: databaseUrl,
  max: 4,
  connectionTimeoutMillis: 3_000,
  statementTimeoutMs: 8_000,
});

const box = await openCursorExternalApiOutbox({ directory });
const result = await box.scanOnce({ pool, pricing });
process.stdout.write(`${JSON.stringify({
  consumed: result.consumed.map((c) => ({
    billingId: c.billingId,
    disposition: c.disposition,
    unlinked: c.unlinked,
    reason: c.reason ?? null,
    usageId: c.settled?.usageId?.toString() ?? null,
    ledgerId: c.settled?.ledgerId?.toString() ?? null,
    debited: c.settled?.debitedCredits?.toString() ?? null,
  })),
  observations: result.observations.map((o) => o.kind),
  scanned: result.scanned,
})}\n`);
await pool.end();
