/**
 * codex-auth-rewrite — post-deploy rewriter for per-container codex
 * auth.json files when the schema has changed.
 *
 * **What it does**:
 *   1. Re-query DB for all `state='active' AND codex_account_id IS NOT NULL`
 *      containers on this host (`host_uuid = self OR IS NULL`). Cross-host
 *      rows are filtered out by query — codex per-container auth.json is a
 *      master-host-only feature (V3_CODEX_AUTH_RO_MOUNT comment in
 *      v3supervisor.ts), so cross-host rows are out of scope.
 *   2. For each local row:
 *      a. If host-side `<codexContainerDir>/<row.id>/auth.json` doesn't
 *         exist → FAILURE (the row is local and SHOULD have a file;
 *         provisioning bug or external delete).
 *      b. Parse + assert codex 0.125 schema (auth_mode=chatgptAuthTokens,
 *         id_token JWT-shaped, id_token === access_token, refresh_token === '',
 *         account_id non-empty). Match → log `id=X already-matches` and skip.
 *      c. Mismatch → look up live token via `getCodexTokenSnapshot`, write
 *         a new auth.json via `writeCodexContainerAuthFile` (the production
 *         code path; same schema the new code produces for fresh
 *         provisions). Then `docker exec <internal_id> pkill -x codex`
 *         (best effort) so any in-process codex re-spawns and reads the new
 *         file. `pkill -x codex` matches against the kernel-truncated
 *         /proc/<pid>/comm and reliably catches all codex command shapes
 *         (`codex mcp-server`, `codex app-server --listen stdio://`, plain
 *         `codex …`) regardless of argv. (Codex MCP/app-server processes
 *         cache the token in memory at startup and don't re-read the file —
 *         see gateway/codexAuthSync.ts header.)
 *
 * **Concurrency / G2 race**:
 * The G2 refresh actor and this script can run concurrently on the same
 * row. Both call `writeCodexContainerAuthFile` which produces identical
 * schema; the worst case is double-write, content equivalent. We do a
 * narrow `SELECT ... FOR UPDATE NOWAIT` per-row to serialize with G2 — if
 * NOWAIT fails, we retry up to 3× with linear backoff (0/2s/4s). If all
 * three retries hit the lock, the row is reported as FAILURE so ops can
 * investigate (a stuck refresh actor needs human eyes; G2 alone won't kill
 * the in-container codex process).
 *
 * **Safety**: the existing 1326 (boss's hot-patched container) is expected
 * to already have matching schema — the script will log `already-matches`
 * and not kill its codex process, preserving boss's working session.
 *
 * **Run**:
 *   ssh commercial-v3 'set -a; . /etc/openclaude/commercial.env; set +a; \
 *     cd /opt/openclaude/openclaude && npx tsx \
 *     packages/commercial/scripts/codex-auth-rewrite.ts'
 *
 * Exit code:
 *   0 — every local sticky-bound container is in matching schema state
 *       (rewritten or already-matches).
 *   1 — at least one local container is in a non-success terminal state:
 *       write_failed, rewritten_kill_error, skipped_no_token,
 *       skipped_lock_busy (after retries), or skipped_no_local_file. Other
 *       rows still attempted; per-row breakdown is printed.
 */

import { execFile as execFileCb } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { writeCodexContainerAuthFile } from "../src/codex-auth/codexAuthFile.js";
import { getCodexTokenSnapshot } from "../src/account-pool/store.js";
import { getSelfHost } from "../src/compute-pool/queries.js";
import { closePool } from "../src/db/index.js";
import { query, tx } from "../src/db/queries.js";
import { V3_AGENT_GID, V3_AGENT_UID } from "../src/agent-sandbox/constants.js";
import { zeroBuffer } from "../src/crypto/keys.js";

const execFile = promisify(execFileCb);

const CODEX_CONTAINER_DIR =
  process.env.OC_V3_CODEX_CONTAINER_DIR || "/var/lib/openclaude-v3/codex-container-auth";

interface RowFromInitialQuery {
  id: string;
  codex_account_id: string;
  container_internal_id: string | null;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function isJwtShape(s: unknown): boolean {
  if (typeof s !== "string") return false;
  const parts = s.split(".");
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length > 0);
}

function schemaMatches(parsed: Record<string, unknown>): boolean {
  const tokens = (parsed.tokens ?? {}) as Record<string, unknown>;
  return (
    parsed.auth_mode === "chatgptAuthTokens" &&
    isJwtShape(tokens.id_token) &&
    tokens.id_token === tokens.access_token &&
    tokens.refresh_token === "" &&
    typeof tokens.account_id === "string" &&
    (tokens.account_id as string).length > 0
  );
}

async function killCodexInContainer(internalId: string): Promise<"killed" | "not_running" | "error"> {
  // The container image is minimal (no pkill / pgrep / ps), so we walk
  // /proc directly with a POSIX shell snippet and use the `kill` builtin
  // (always available). Codex runs under several command forms (legacy
  // `codex mcp-server`, current `codex app-server --listen stdio://`,
  // plain CLI), but the kernel-truncated `/proc/<pid>/comm` value is just
  // `codex` for all of them — exact match on comm is reliable and won't
  // hit unrelated `codex-foo` siblings.
  //
  // Output: "<count>" on stdout. count==0 → no codex was running (fine —
  // codex re-spawns per-turn from the rewritten file). count>0 → killed.
  // We don't use the script's exit code; we read stdout and decide.
  const script =
    'k=0; for d in /proc/[0-9]*; do ' +
    'c=$(cat "$d/comm" 2>/dev/null) || continue; ' +
    '[ "$c" = "codex" ] || continue; ' +
    'pid=${d##*/}; ' +
    'kill -9 "$pid" 2>/dev/null && k=$((k+1)); ' +
    'done; echo "$k"';
  try {
    const { stdout } = await execFile("docker", [
      "exec",
      internalId,
      "sh",
      "-c",
      script,
    ]);
    const trimmed = stdout.trim();
    if (!/^\d+$/.test(trimmed)) return "error";
    const n = parseInt(trimmed, 10);
    return n > 0 ? "killed" : "not_running";
  } catch {
    // docker exec itself failed (container gone / daemon issue). The
    // auth.json rewrite already succeeded; treat this as a real error so
    // ops investigates whether the container should be reaped.
    return "error";
  }
}

interface RewriteOutcome {
  containerId: string;
  accountId: string;
  result:
    | "skipped_no_local_file"
    | "skipped_already_matches"
    | "skipped_no_token"
    | "skipped_lock_busy"
    | "rewritten_killed"
    | "rewritten_not_running"
    | "rewritten_kill_error"
    | "write_failed";
  detail?: string;
}

async function rewriteOne(row: RowFromInitialQuery): Promise<RewriteOutcome> {
  const filePath = join(CODEX_CONTAINER_DIR, row.id, "auth.json");
  if (!(await fileExists(filePath))) {
    return { containerId: row.id, accountId: row.codex_account_id, result: "skipped_no_local_file" };
  }

  // Best-effort schema check first — if it already matches, no work to do.
  try {
    const body = await readFile(filePath, "utf8");
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (schemaMatches(parsed)) {
      return { containerId: row.id, accountId: row.codex_account_id, result: "skipped_already_matches" };
    }
  } catch {
    // parse error → falls through to rewrite path (we'll overwrite the bad file).
  }

  // Take FOR UPDATE NOWAIT lock on the row to serialize with G2 refresh
  // actor. G2's refresh tx writes auth.json under the same lock; we want
  // either G2 or us to do the write, never both interleaving the same
  // file. NOWAIT means we skip rather than block on contention.
  const result = await tx(async (client) => {
    const lockRes = await client.query(
      `SELECT id, codex_account_id, container_internal_id
         FROM agent_containers
        WHERE id = $1
          AND state = 'active'
          AND codex_account_id IS NOT NULL
        FOR UPDATE NOWAIT`,
      [row.id],
    ).catch((err: unknown) => {
      const e = err as { code?: string };
      if (e.code === "55P03") return null; // lock_not_available
      throw err;
    });

    if (lockRes === null) {
      return {
        containerId: row.id,
        accountId: row.codex_account_id,
        result: "skipped_lock_busy" as const,
      };
    }
    if (lockRes.rows.length === 0) {
      // State changed under us (e.g., container removed) — skip silently.
      return {
        containerId: row.id,
        accountId: row.codex_account_id,
        result: "skipped_no_local_file" as const,
        detail: "state changed under lock",
      };
    }

    const live = lockRes.rows[0] as RowFromInitialQuery;

    // Re-confirm file still exists (defense against unlink between outer
    // check and lock).
    if (!(await fileExists(filePath))) {
      return {
        containerId: row.id,
        accountId: row.codex_account_id,
        result: "skipped_no_local_file" as const,
      };
    }

    const snap = await getCodexTokenSnapshot(live.codex_account_id);
    if (!snap || !snap.token) {
      return {
        containerId: row.id,
        accountId: row.codex_account_id,
        result: "skipped_no_token" as const,
        detail: "account row missing or token decrypt failed",
      };
    }

    try {
      await writeCodexContainerAuthFile({
        rootDir: CODEX_CONTAINER_DIR,
        containerId: row.id,
        containerUid: V3_AGENT_UID,
        containerGid: V3_AGENT_GID,
        auth: {
          accessToken: snap.token.toString("utf8"),
          lastRefreshIso: new Date().toISOString(),
        },
      });
    } catch (err) {
      return {
        containerId: row.id,
        accountId: row.codex_account_id,
        result: "write_failed" as const,
        detail: (err as Error).message,
      };
    } finally {
      if (snap.token) zeroBuffer(snap.token);
      if (snap.refresh) zeroBuffer(snap.refresh);
    }

    if (!live.container_internal_id) {
      // No docker id known — file rewritten but we can't kill the in-container
      // codex. Treat as not_running (next codex spawn picks up new file).
      return {
        containerId: row.id,
        accountId: row.codex_account_id,
        result: "rewritten_not_running" as const,
        detail: "container_internal_id is NULL",
      };
    }

    const killOutcome = await killCodexInContainer(live.container_internal_id);
    return {
      containerId: row.id,
      accountId: row.codex_account_id,
      result:
        killOutcome === "killed"
          ? ("rewritten_killed" as const)
          : killOutcome === "not_running"
            ? ("rewritten_not_running" as const)
            : ("rewritten_kill_error" as const),
    };
  });

  return result;
}

async function rewriteOneWithRetry(row: RowFromInitialQuery): Promise<RewriteOutcome> {
  // G2 refresh actor holds the FOR UPDATE lock for the duration of one
  // refresh round-trip — typically <1s but can be longer under contention.
  // Three retries × 2s linear backoff is enough headroom without making a
  // post-deploy script hang for minutes if something is genuinely wedged.
  const RETRY_DELAYS_MS = [0, 2000, 4000];
  let last: RewriteOutcome | null = null;
  for (const delay of RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    last = await rewriteOne(row);
    if (last.result !== "skipped_lock_busy") return last;
  }
  return last as RewriteOutcome;
}

async function main(): Promise<void> {
  // Restrict to containers physically on this host. Codex per-container
  // auth.json is a master-host-only feature (V3_CODEX_AUTH_RO_MOUNT comment
  // in v3supervisor.ts), so cross-host rows have no local file by design.
  // host_uuid IS NULL covers legacy single-host MVP rows that pre-date the
  // multi-host migration; treat them as local.
  const selfHost = await getSelfHost();
  const res = await query<RowFromInitialQuery>(
    `SELECT id::text AS id,
            codex_account_id::text AS codex_account_id,
            container_internal_id
       FROM agent_containers
      WHERE state = 'active'
        AND codex_account_id IS NOT NULL
        AND (host_uuid = $1 OR host_uuid IS NULL)
      ORDER BY id`,
    [selfHost.id],
  );

  if (res.rows.length === 0) {
    console.log("rewrite: no active sticky-bound codex containers on this host; nothing to do");
    await closePool();
    return;
  }

  const outcomes: RewriteOutcome[] = [];
  for (const row of res.rows) {
    const o = await rewriteOneWithRetry(row);
    outcomes.push(o);
    console.log(
      `  - container=${o.containerId} account=${o.accountId} result=${o.result}${o.detail ? ` (${o.detail})` : ""}`,
    );
  }

  // Failure taxonomy:
  // - write_failed / rewritten_kill_error: file write succeeded but kill or
  //   write itself failed → container likely broken.
  // - skipped_no_token: account row missing or decrypt failed → schema
  //   mismatch persists, container will keep returning 401.
  // - skipped_lock_busy: lock held by G2 across all 3 retries → likely a
  //   stuck refresh actor; manual investigation.
  // - skipped_no_local_file: local query (filtered by host_uuid) means the
  //   file SHOULD exist; missing means provisioning never wrote it. Failure.
  const failed = outcomes.filter(
    (o) =>
      o.result === "write_failed" ||
      o.result === "rewritten_kill_error" ||
      o.result === "skipped_no_token" ||
      o.result === "skipped_lock_busy" ||
      o.result === "skipped_no_local_file",
  );
  const rewritten = outcomes.filter(
    (o) =>
      o.result === "rewritten_killed" ||
      o.result === "rewritten_not_running" ||
      o.result === "rewritten_kill_error",
  );
  const matched = outcomes.filter((o) => o.result === "skipped_already_matches");

  console.log("");
  console.log(`rewrite: ${outcomes.length} local-host sticky-bound containers processed`);
  console.log(`  rewritten:           ${rewritten.length}`);
  console.log(`  already-matches:     ${matched.length} (no-op)`);
  console.log(`  failed:              ${failed.length}`);
  if (failed.length > 0) {
    console.log("  failure breakdown:");
    for (const o of failed) {
      console.log(`    - ${o.containerId} (${o.result}${o.detail ? `: ${o.detail}` : ""})`);
    }
  }

  await closePool();

  if (failed.length > 0) {
    console.error(
      `rewrite: ${failed.length} containers FAILED — investigate before declaring deploy successful`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("rewrite: FATAL", err);
  process.exit(2);
});
