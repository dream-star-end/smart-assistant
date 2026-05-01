/**
 * codex-auth-audit — read-only audit of per-container codex auth.json files.
 *
 * **Purpose**: before/after deploys that change the codex auth.json schema,
 * verify all `state='active' AND codex_account_id IS NOT NULL` containers
 * have a host-side auth.json that matches codex 0.125's external-token
 * schema (`auth_mode: chatgptAuthTokens`, JWT-shaped `id_token`, empty
 * `refresh_token`, non-empty `account_id`).
 *
 * **Read-only**: never writes any file or DB row. Output is text on
 * stdout/stderr. Exit code:
 *   0 — all bound containers checked have matching schema OR no auth.json
 *       on this host (cross-host container, out of scope)
 *   1 — at least one local bound container has mismatched schema OR a
 *       parse error
 *
 * **Cross-host scope**: only audits containers whose auth.json file
 * physically exists at `<codexContainerDir>/<row.id>/auth.json` on this
 * host. Cross-host containers (host_uuid != self) won't have a local
 * file — those are a known v3 limitation (codex GPT only available on
 * master host containers; see V3_CODEX_AUTH_RO_MOUNT comment in
 * v3supervisor.ts).
 *
 * **Run**:
 *   ssh commercial-v3 'set -a; . /etc/openclaude/commercial.env; set +a; \
 *     cd /opt/openclaude/openclaude && npx tsx \
 *     packages/commercial/scripts/codex-auth-audit.ts'
 *
 * The script does NOT load a config file directly — it relies on env
 * (DATABASE_URL etc.) being set, which is the same environment the
 * `openclaude` systemd unit runs under.
 */

import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

import { query } from "../src/db/queries.js";
import { closePool } from "../src/db/index.js";

const CODEX_CONTAINER_DIR =
  process.env.OC_V3_CODEX_CONTAINER_DIR || "/var/lib/openclaude-v3/codex-container-auth";

interface BoundContainerRow {
  id: string;
  codex_account_id: string;
}

interface AuditResult {
  containerId: string;
  accountId: string;
  status: "matched" | "mismatched" | "missing" | "parse_error";
  reason?: string;
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

async function auditOne(row: BoundContainerRow): Promise<AuditResult> {
  const filePath = join(CODEX_CONTAINER_DIR, row.id, "auth.json");
  if (!(await fileExists(filePath))) {
    return {
      containerId: row.id,
      accountId: row.codex_account_id,
      status: "missing",
      reason: "no local auth.json (cross-host or never written)",
    };
  }

  let body: string;
  try {
    body = await readFile(filePath, "utf8");
  } catch (err) {
    return {
      containerId: row.id,
      accountId: row.codex_account_id,
      status: "parse_error",
      reason: `read failed: ${(err as Error).message}`,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch (err) {
    return {
      containerId: row.id,
      accountId: row.codex_account_id,
      status: "parse_error",
      reason: `JSON parse failed: ${(err as Error).message}`,
    };
  }

  const tokens = (parsed.tokens ?? {}) as Record<string, unknown>;
  const checks = {
    auth_mode_ok: parsed.auth_mode === "chatgptAuthTokens",
    id_token_jwt: isJwtShape(tokens.id_token),
    id_token_eq_access: tokens.id_token === tokens.access_token,
    refresh_token_empty_str: tokens.refresh_token === "",
    account_id_nonempty: typeof tokens.account_id === "string" && (tokens.account_id as string).length > 0,
  };

  const allOk = Object.values(checks).every((v) => v === true);
  if (allOk) {
    return { containerId: row.id, accountId: row.codex_account_id, status: "matched" };
  }
  const fails = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  return {
    containerId: row.id,
    accountId: row.codex_account_id,
    status: "mismatched",
    reason: `failed: ${fails.join(",")}`,
  };
}

async function main(): Promise<void> {
  const res = await query<BoundContainerRow>(
    `SELECT id::text AS id, codex_account_id::text AS codex_account_id
       FROM agent_containers
      WHERE state = 'active'
        AND codex_account_id IS NOT NULL
      ORDER BY id`,
  );

  if (res.rows.length === 0) {
    console.log("audit: no active sticky-bound codex containers in DB; nothing to check");
    await closePool();
    return;
  }

  const results: AuditResult[] = [];
  for (const row of res.rows) {
    results.push(await auditOne(row));
  }

  const matched = results.filter((r) => r.status === "matched");
  const mismatched = results.filter((r) => r.status === "mismatched");
  const missing = results.filter((r) => r.status === "missing");
  const parseError = results.filter((r) => r.status === "parse_error");

  console.log(`audit: ${results.length} active sticky-bound containers checked`);
  console.log(`  matched:     ${matched.length}`);
  console.log(`  mismatched:  ${mismatched.length}`);
  console.log(`  missing:     ${missing.length} (cross-host or never written; OK)`);
  console.log(`  parse_error: ${parseError.length}`);

  for (const r of [...mismatched, ...parseError]) {
    console.log(`  - container=${r.containerId} account=${r.accountId} status=${r.status} ${r.reason ?? ""}`);
  }
  // 'missing' entries are NOT printed — common case for cross-host, would just spam.

  await closePool();

  if (mismatched.length > 0 || parseError.length > 0) {
    // Audit only — do NOT exit non-zero in pre-deploy mode (we expect
    // mismatches before the rewrite). Exit 0 always; consumers parse the
    // numbers from stdout.
    process.exitCode = 0;
  }
}

main().catch((err) => {
  console.error("audit: FATAL", err);
  process.exit(2);
});
