/** Operator-only second phase for an already-staged selfhost Box model.
 * Must run FROM the verified live release after egress has both Box flags.
 * Does not launch/replay Box or run a database migration. */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { getAccount } from "../../packages/commercial/src/account-pool/store.js";
import { activateEntry } from "../../packages/commercial/src/admin/modelCatalogOps.js";
import { patchPricing } from "../../packages/commercial/src/admin/pricing.js";
import { loadConfig } from "../../packages/commercial/src/config.js";
import { getPool, closePool } from "../../packages/commercial/src/db/index.js";
import { assertModelCatalogAdminPoolConfigured,
  closeModelCatalogAdminPool, getModelCatalogAdminPool } from
  "../../packages/commercial/src/db/modelCatalogAdmin.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";
import { sameSelfhostCatalogEndpoint } from "./boxCatalogBoundary.js";

const MODEL = "box-api-claude-opus-5-5";
const SOURCE = "claude-opus-5-5";
const LIVE_LINK = "/opt/openclaude/openclaude-v5-selfhost-live";
type Entry = { entry_id: string; state: string; engine: string;
  provider_id: string; upstream_model_id: string; context_window: number;
  lock_version: number; capability_profile: Record<string, unknown> };
type Price = { model_id: string; enabled: boolean; visibility: string;
  input_per_mtok: string; output_per_mtok: string;
  cache_read_per_mtok: string; cache_write_per_mtok: string;
  multiplier: string };
const PRICE_SQL = `SELECT model_id,enabled,visibility,input_per_mtok::text,
  output_per_mtok::text,cache_read_per_mtok::text,cache_write_per_mtok::text,
  multiplier::text FROM model_pricing WHERE model_id=$1`;
function assertion(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
function egressUnit(): { pid: number; slot: string } {
  const running: Array<{ pid: number; slot: string }> = [];
  for (const slot of ["A", "B"] as const) {
    const raw = execFileSync("systemctl", ["show",
      `openclaude-v5-selfhost-egress@${slot}.service`,
      "-p", "ActiveState", "-p", "MainPID", "--no-pager"],
    { encoding: "utf8", timeout: 5000 });
    const active = /^ActiveState=(\S+)$/m.exec(raw)?.[1];
    const pid = Number(/^MainPID=([0-9]+)$/m.exec(raw)?.[1]);
    if (active === "active") {
      assertion(Number.isSafeInteger(pid) && pid > 1, "BOX_CATALOG_EGRESS_PID_INVALID");
      running.push({ pid, slot });
    }
  }
  assertion(running.length === 1, "BOX_CATALOG_EGRESS_SLOT_AMBIGUOUS");
  return running[0]!;
}
function liveEgressReady(expectedSha: string): { slot: string; sourceCommit: string } {
  const live = realpathSync(LIVE_LINK);
  assertion(live.startsWith("/opt/openclaude/openclaude-v5-selfhost-releases/rel-"),
    "BOX_CATALOG_LIVE_PATH_INVALID");
  const complete = JSON.parse(readFileSync(`${live}/.complete`, "utf8")) as
    { sourceCommit?: unknown };
  assertion(complete.sourceCommit === expectedSha
    && realpathSync(process.cwd()) === live,
  "BOX_CATALOG_LIVE_SOURCE_MISMATCH");
  const unit = egressUnit();
  assertion(realpathSync(`/proc/${unit.pid}/cwd`) === live,
    "BOX_CATALOG_EGRESS_SOURCE_MISMATCH");
  const env = readFileSync(`/proc/${unit.pid}/environ`).toString("utf8").split("\0");
  assertion(env.includes("OC_BOX_MODEL_API=1") && env.includes("OC_BOX_TOOL_BRIDGE=1"),
    "BOX_CATALOG_EGRESS_FLAGS_OFF");
  return { slot: unit.slot, sourceCommit: expectedSha };
}
async function main(): Promise<void> {
  const mode = process.argv[2] ?? "plan";
  assertion(mode === "plan" || mode === "activate", "BOX_CATALOG_MODE_INVALID");
  assertion(hostname() === "v3-dev-sg" && getRuntimeChannel() === "v5"
    && process.env.OCV5_289_ACK_ACCOUNT_ID === "20"
    && process.env.OCV5_289_ACK_USER_ID === "3",
  "BOX_CATALOG_SELFHOST_BOUNDARY_INVALID");
  const expectedSha = process.env.OCV5_289_EXPECT_LIVE_SHA ?? "";
  if (mode === "activate") assertion(process.env.OCV5_289_CATALOG_ACTIVATE_ACK === "1"
    && /^[a-f0-9]{40}$/.test(expectedSha), "BOX_CATALOG_ACTIVATE_ACK_REQUIRED");
  const cfg = loadConfig();
  assertion(!!cfg.MODEL_CATALOG_ADMIN_DATABASE_URL
    && sameSelfhostCatalogEndpoint(cfg.DATABASE_URL,
      cfg.MODEL_CATALOG_ADMIN_DATABASE_URL),
  "BOX_CATALOG_ADMIN_ENDPOINT_INVALID");
  const pool = getPool();
  try {
    await assertModelCatalogAdminPoolConfigured();
    const identitySql = `SELECT current_database() AS name,
      host(inet_server_addr()) AS addr, inet_server_port() AS port`;
    const [db, adminDb] = await Promise.all([
      pool.query<{ name: string; addr: string; port: number }>(identitySql),
      getModelCatalogAdminPool().query<{ name: string; addr: string; port: number }>(identitySql),
    ]);
    assertion(db.rows.length === 1 && adminDb.rows.length === 1
      && db.rows[0]?.name === "openclaude_v5_selfhost"
      && db.rows[0]?.addr === "127.0.0.1" && db.rows[0]?.port === 5432
      && isDeepStrictEqual(adminDb.rows[0], db.rows[0]),
    "BOX_CATALOG_DATABASE_INVALID");
    let entry = await pool.query<Entry>(
      `SELECT entry_id::text,state,engine,provider_id,upstream_model_id,
         context_window,lock_version,capability_profile
       FROM model_catalog WHERE model_id=$1 AND state IN ('staged','active','disabled')`,
      [MODEL]);
    let price = await pool.query<Price>(PRICE_SQL, [MODEL]);
    const source = await pool.query<Price>(PRICE_SQL, [SOURCE]);
    const row = entry.rows[0], cost = price.rows[0], baseline = source.rows[0];
    assertion(entry.rows.length === 1 && row
      && ["staged", "active"].includes(row.state)
      && row.engine === "ccb" && row.provider_id === "box_cli"
      && row.upstream_model_id === SOURCE && row.context_window === 200_000
      && isDeepStrictEqual(row.capability_profile, { supports_vision: false,
        reasoning: { supported: [], codex_model_default: null },
        ccb: { capability_zero: true, supports_thinking: false } })
      && price.rows.length === 1 && cost?.visibility === "admin"
      && source.rows.length === 1 && baseline?.enabled
      && ["input_per_mtok", "output_per_mtok", "cache_read_per_mtok",
        "cache_write_per_mtok", "multiplier"].every((key) =>
        String(cost[key as keyof Price]) === String(baseline[key as keyof Price])),
    "BOX_CATALOG_STAGE_EVIDENCE_INVALID");
    let live: { slot: string; sourceCommit: string } | null = null;
    if (mode === "activate") {
      live = liveEgressReady(expectedSha);
      const account = await getAccount("20");
      assertion(account?.provider === "cursor" && account.status === "active"
        && account.cursor_sand_enabled
        && account.cursor_credential_kind === "session"
        && account.cursor_sand_access_state === "SAND_ACCESS_STATE_GRANTED"
        && (!account.cooldown_until || account.cooldown_until.getTime() <= Date.now()),
      "BOX_CATALOG_ACCOUNT_INELIGIBLE");
      if (!cost.enabled) {
        assertion(row.state === "staged", "BOX_CATALOG_ACTIVE_PRICE_DISABLED");
        await patchPricing(MODEL, { enabled: true },
          { adminId: 3, userAgent: "ocv5-289-box-catalog-activate" });
      }
      if (row.state === "staged") {
        await activateEntry(row.entry_id, row.lock_version,
          { adminId: 3, userAgent: "ocv5-289-box-catalog-activate" });
      }
      entry = await pool.query<Entry>(
        `SELECT entry_id::text,state,engine,provider_id,upstream_model_id,
           context_window,lock_version,capability_profile
         FROM model_catalog WHERE model_id=$1 AND state='active'`, [MODEL]);
      price = await pool.query<Price>(PRICE_SQL, [MODEL]);
      assertion(entry.rows.length === 1 && price.rows.length === 1
        && price.rows[0]?.enabled && price.rows[0]?.visibility === "admin",
      "BOX_CATALOG_ACTIVATION_UNPROVEN");
    }
    process.stdout.write(JSON.stringify({ mode, model: MODEL,
      state: entry.rows[0]?.state, pricingEnabled: price.rows[0]?.enabled,
      visibility: price.rows[0]?.visibility,
      ...(live ? { egressSlot: live.slot, sourceCommit: live.sourceCommit } : {}),
      migrationRun: false, boxCall: false }) + "\n");
  } finally { await Promise.allSettled([closePool(), closeModelCatalogAdminPool()]); }
}
void main().then(() => process.exit(0), (error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.message)
    ? error.message : "BOX_CATALOG_ACTIVATE_FAILED";
  process.stderr.write(code + "\n"); process.exit(1);
});
