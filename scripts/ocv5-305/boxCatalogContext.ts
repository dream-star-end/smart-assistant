/**
 * Operator step: the Box route's Claude Opus 5.5 runs at a 1,000,000-token window.
 *
 * box-api-claude-opus-5-5 was staged by scripts/ocv5-289/boxCatalogStage.ts with
 * context_window=200000, a number nobody measured. The Box CLI (2.1.288) reports
 * contextWindow 1000000 for claude-opus-5-5 under the plain model id (no [1m]
 * suffix, no beta header) and Box accepted a 324k-token prompt. The agent compacts
 * against this window, so compaction moves from ~167k to ~950k. Only
 * context_window changes; identity, profile, price and visibility stay.
 *
 * Modes: plan (default, read-only) | apply (200000 -> 1000000) | rollback (back).
 * Writes go through modelCatalogOps.switchVersion (full validation, stored
 * procedure, admin audit) with the current lock_version. Same selfhost boundary as
 * scripts/ocv5-305/boxCatalogEffort.ts. Run FROM the live release:
 *   (set -a; . /etc/openclaude/commercial-v5-selfhost.env; set +a;
 *    OCV5_CTX_ACK_USER_ID=3 OCV5_CTX_EXPECT_LIVE_SHA=<live sourceCommit> \
 *    [OCV5_CTX_CATALOG_WRITE_ACK=1] \
 *    node --import tsx scripts/ocv5-305/boxCatalogContext.ts [plan|apply|rollback])
 */
import { readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { switchVersion } from "../../packages/commercial/src/admin/modelCatalogOps.js";
import { loadConfig } from "../../packages/commercial/src/config.js";
import { closePool, getPool } from "../../packages/commercial/src/db/index.js";
import { assertModelCatalogAdminPoolConfigured, closeModelCatalogAdminPool,
  getModelCatalogAdminPool } from "../../packages/commercial/src/db/modelCatalogAdmin.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";
import { sameSelfhostCatalogEndpoint } from "../ocv5-289/boxCatalogBoundary.js";

const MODEL = "box-api-claude-opus-5-5";
const LIVE_LINK = "/opt/openclaude/openclaude-v5-selfhost-live";
const SMALL = 200_000;
const LARGE = 1_000_000;

function assertion(ok: boolean, code: string): asserts ok { if (!ok) throw new Error(code); }

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "plan";
  assertion(mode === "plan" || mode === "apply" || mode === "rollback", "BOX_CTX_MODE_INVALID");
  assertion(hostname() === "v3-dev-sg" && getRuntimeChannel() === "v5"
    && process.env.OCV5_CTX_ACK_USER_ID === "3", "BOX_CTX_SELFHOST_BOUNDARY_INVALID");
  const expectedSha = process.env.OCV5_CTX_EXPECT_LIVE_SHA ?? "";
  assertion(/^[a-f0-9]{40}$/.test(expectedSha), "BOX_CTX_EXPECT_LIVE_SHA_REQUIRED");
  if (mode !== "plan") assertion(process.env.OCV5_CTX_CATALOG_WRITE_ACK === "1", "BOX_CTX_WRITE_ACK_REQUIRED");
  const live = realpathSync(LIVE_LINK);
  assertion(live.startsWith("/opt/openclaude/openclaude-v5-selfhost-releases/rel-")
    && realpathSync(process.cwd()) === live, "BOX_CTX_RUN_FROM_LIVE_RELEASE");
  const complete = JSON.parse(readFileSync(`${live}/.complete`, "utf8")) as { sourceCommit?: unknown };
  assertion(complete.sourceCommit === expectedSha, "BOX_CTX_LIVE_SOURCE_MISMATCH");
  const cfg = loadConfig();
  assertion(!!cfg.MODEL_CATALOG_ADMIN_DATABASE_URL
    && sameSelfhostCatalogEndpoint(cfg.DATABASE_URL, cfg.MODEL_CATALOG_ADMIN_DATABASE_URL),
  "BOX_CTX_ADMIN_ENDPOINT_INVALID");
  const pool = getPool();
  try {
    await assertModelCatalogAdminPoolConfigured();
    const identitySql = `SELECT current_database() AS name, host(inet_server_addr()) AS addr, inet_server_port() AS port`;
    const [db, adminDb] = await Promise.all([
      pool.query<{ name: string; addr: string; port: number }>(identitySql),
      getModelCatalogAdminPool().query<{ name: string; addr: string; port: number }>(identitySql)]);
    assertion(db.rows.length === 1 && adminDb.rows.length === 1
      && db.rows[0]?.name === "openclaude_v5_selfhost" && db.rows[0]?.addr === "127.0.0.1"
      && db.rows[0]?.port === 5432 && isDeepStrictEqual(adminDb.rows[0], db.rows[0]), "BOX_CTX_DATABASE_INVALID");
    const rows = (await getModelCatalogAdminPool().query<{ entry_id: string; engine: string;
      provider_id: string | null; upstream_model_id: string | null; context_window: number | null;
      lock_version: number; capability_profile: unknown; capability_schema_version: number }>(
      `SELECT entry_id::text, engine, provider_id, upstream_model_id, context_window, lock_version,
              capability_profile, capability_schema_version
         FROM model_catalog WHERE model_id=$1 AND state='active'`, [MODEL])).rows;
    assertion(rows.length === 1, "BOX_CTX_ACTIVE_ROW_AMBIGUOUS");
    const cur = rows[0]!;
    assertion(cur.engine === "ccb" && cur.provider_id === "box_cli" && cur.upstream_model_id === "claude-opus-5-5",
      "BOX_CTX_ROW_IDENTITY_INVALID");
    assertion(cur.context_window === SMALL || cur.context_window === LARGE, "BOX_CTX_UNEXPECTED_CURRENT_WINDOW");
    const report = { entry_id: cur.entry_id, lock_version: cur.lock_version, context_window: cur.context_window };
    if (mode === "plan") { console.log(JSON.stringify({ action: "plan", ...report })); return; }
    const target = mode === "apply" ? LARGE : SMALL;
    if (cur.context_window === target) { console.log(JSON.stringify({ action: "already", mode, ...report })); return; }
    const out = await switchVersion({ model_id: MODEL, engine: cur.engine, provider_id: cur.provider_id,
      upstream_model_id: cur.upstream_model_id, context_window: target,
      capability_profile: cur.capability_profile, capability_schema_version: cur.capability_schema_version },
    cur.lock_version, { adminId: 3, userAgent: `ocv5-box-context-${mode}` });
    console.log(JSON.stringify({ action: "switched", mode, from_entry: cur.entry_id, to_entry: out.entry_id,
      context_window: target }));
  } finally { await Promise.allSettled([closePool(), closeModelCatalogAdminPool()]); }
}
await main();
