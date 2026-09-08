#!/usr/bin/env npx tsx
/**
 * On-demand read-only business health snapshot (OCV5-180 I3).
 *
 *   npx tsx scripts/ops/business-health.ts
 *   npx tsx scripts/ops/business-health.ts --timeout-ms 5000 --limit 50000
 *
 * Uses DATABASE_URL / COMMERCIAL_DATABASE_URL. Read-only (BEGIN READ ONLY).
 * Timeouts are reported as unknown, never as 0. Does not write, prune, settle, or deploy.
 * process.exitCode is set only after pool.end so a bounded run cannot skip cleanup.
 */
import { pathToFileURL } from "node:url";
import pg from "pg";
import { collectBusinessHealthSnapshot } from "../../packages/commercial/src/admin/businessHealth.ts";

function argFrom(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

export async function runBusinessHealthCli(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const url = (env.COMMERCIAL_DATABASE_URL || env.DATABASE_URL || "").trim();
  if (!url) {
    console.error("COMMERCIAL_DATABASE_URL or DATABASE_URL required");
    return 2;
  }
  const timeoutMs = Number(argFrom(argv, "--timeout-ms") ?? "5000");
  const limit = Number(argFrom(argv, "--limit") ?? "50000");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    console.error("--timeout-ms must be a positive number");
    return 2;
  }
  if (!Number.isFinite(limit) || limit < 1) {
    console.error("--limit must be a positive number");
    return 2;
  }
  const boundedMs = Math.floor(timeoutMs);
  const pool = new pg.Pool({
    connectionString: url,
    max: 2,
    connectionTimeoutMillis: boundedMs,
    idleTimeoutMillis: Math.max(1000, boundedMs),
    allowExitOnIdle: true,
  });
  let exitCode = 1;
  try {
    const snapshot = await Promise.race([
      collectBusinessHealthSnapshot(pool, {
        statementTimeoutMs: boundedMs,
        streamLimit: Math.floor(limit),
      }),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("business-health CLI deadline exceeded")),
          boundedMs + 100,
        );
      }),
    ]);
    console.log(JSON.stringify(snapshot, null, 2));
    const unknown =
      snapshot.tapeMaterialization.unknown ||
      snapshot.settlementHeld.unknown ||
      snapshot.cursorAuditSuccessWithoutUsage.unknown ||
      snapshot.liveFrames.unknown ||
      snapshot.retentionUnknown;
    exitCode = unknown ? 4 : 0;
  } catch (err) {
    console.error(err);
    exitCode = 1;
  } finally {
    try {
      await Promise.race([
        pool.end(),
        new Promise<void>((resolve) => {
          setTimeout(resolve, Math.max(250, boundedMs));
        }),
      ]);
    } catch {
      /* ignore */
    }
  }
  return exitCode;
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void runBusinessHealthCli().then(
    (code) => {
      process.exitCode = code;
      process.exit(code);
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
      process.exit(1);
    },
  );
}
