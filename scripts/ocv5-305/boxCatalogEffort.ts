/**
 * OCV5-305 operator step: let users choose Box Claude's thinking effort.
 *
 * Box Claude (box-api-claude-opus-5-5) was staged in OCV5-289 with
 * reasoning.supported = [], so the UI showed no effort selector and the client
 * never sent one. Since OCV5-305 the Box route maps every native Claude Code
 * effort (low, medium, high, xhigh, max) to the Box CLI's own `--effort`, so
 * the catalog may declare them. Only reasoning.supported changes; engine,
 * provider, upstream model, context window and the ccb profile (capability
 * zero, no client thinking, box-native-v1 context owner) stay exactly as they
 * are — the Box CLI runs native adaptive thinking at the chosen effort.
 *
 * Modes: plan (default, read-only) | apply (BEFORE -> AFTER) | rollback
 * (AFTER -> BEFORE). Both writes use modelCatalogOps.switchVersion (full
 * validation, stored procedure, admin audit, catalog NOTIFY) with the current
 * lock_version, and require the exact opposite profile. Selfhost boundary is
 * the same as scripts/ocv5-289/boxCatalogActivate.ts. Run FROM the live
 * release with the egress env:
 *   (set -a; . /etc/openclaude/commercial-v5-selfhost.env; set +a;
 *    OCV5_305_ACK_USER_ID=3 OCV5_305_EXPECT_LIVE_SHA=<live sourceCommit> \
 *    [OCV5_305_CATALOG_WRITE_ACK=1] \
 *    node --import tsx scripts/ocv5-305/boxCatalogEffort.ts [plan|apply|rollback])
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { switchVersion } from "../../packages/commercial/src/admin/modelCatalogOps.js";
import { loadConfig } from "../../packages/commercial/src/config.js";
import { closePool, getPool } from "../../packages/commercial/src/db/index.js";
import { assertModelCatalogAdminPoolConfigured, closeModelCatalogAdminPool,
  getModelCatalogAdminPool } from "../../packages/commercial/src/db/modelCatalogAdmin.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";
import { BOX_ROUTE_EFFORTS, providerCapabilityCeiling } from "../../packages/commercial/src/http/proxy/upstream.js";
import { BOX_CLI_EFFORTS } from "../../packages/commercial/src/http/proxy/boxToolCatalog.js";
import { sameSelfhostCatalogEndpoint } from "../ocv5-289/boxCatalogBoundary.js";

const MODEL = "box-api-claude-opus-5-5";
const LIVE_LINK = "/opt/openclaude/openclaude-v5-selfhost-live";
const BEFORE = { supports_vision: false, reasoning: { supported: [], codex_model_default: null },
  ccb: { context_owner: "box-native-v1", capability_zero: true, supports_thinking: false } };
const AFTER = { ...BEFORE, reasoning: { supported: [...BOX_CLI_EFFORTS], codex_model_default: null } };

function assertion(ok: boolean, code: string): asserts ok { if (!ok) throw new Error(code); }

function egressPid(): number {
  const running: number[] = [];
  for (const slot of ["A", "B"]) {
    const raw = execFileSync("systemctl", ["show", `openclaude-v5-selfhost-egress@${slot}.service`,
      "-p", "ActiveState", "-p", "MainPID", "--no-pager"], { encoding: "utf8", timeout: 5000 });
    const pid = Number(/^MainPID=([0-9]+)$/m.exec(raw)?.[1]);
    if (/^ActiveState=active$/m.test(raw)) {
      assertion(Number.isSafeInteger(pid) && pid > 1, "BOX_EFFORT_EGRESS_PID_INVALID");
      running.push(pid);
    }
  }
  assertion(running.length === 1, "BOX_EFFORT_EGRESS_SLOT_AMBIGUOUS");
  return running[0]!;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "plan";
  assertion(mode === "plan" || mode === "apply" || mode === "rollback", "BOX_EFFORT_MODE_INVALID");
  assertion(hostname() === "v3-dev-sg" && getRuntimeChannel() === "v5"
    && process.env.OCV5_305_ACK_USER_ID === "3", "BOX_EFFORT_SELFHOST_BOUNDARY_INVALID");
  const expectedSha = process.env.OCV5_305_EXPECT_LIVE_SHA ?? "";
  assertion(/^[a-f0-9]{40}$/.test(expectedSha), "BOX_EFFORT_EXPECT_LIVE_SHA_REQUIRED");
  if (mode !== "plan") assertion(process.env.OCV5_305_CATALOG_WRITE_ACK === "1", "BOX_EFFORT_WRITE_ACK_REQUIRED");
  const live = realpathSync(LIVE_LINK);
  assertion(live.startsWith("/opt/openclaude/openclaude-v5-selfhost-releases/rel-")
    && realpathSync(process.cwd()) === live, "BOX_EFFORT_RUN_FROM_LIVE_RELEASE");
  const complete = JSON.parse(readFileSync(`${live}/.complete`, "utf8")) as { sourceCommit?: unknown };
  assertion(complete.sourceCommit === expectedSha, "BOX_EFFORT_LIVE_SOURCE_MISMATCH");
  assertion(realpathSync(`/proc/${egressPid()}/cwd`) === live, "BOX_EFFORT_EGRESS_SOURCE_MISMATCH");
  // The serving release must already map these efforts, or a catalog that
  // declares them would make the proxy fail every Box request closed.
  const ceiling = providerCapabilityCeiling({ kind: "box", upstreamModel: "claude-opus-5-5" }).efforts ?? [];
  assertion(isDeepStrictEqual([...ceiling], [...BOX_CLI_EFFORTS])
    && isDeepStrictEqual([...BOX_ROUTE_EFFORTS], [...BOX_CLI_EFFORTS]), "BOX_EFFORT_LIVE_CEILING_MISSING");
  const cfg = loadConfig();
  assertion(!!cfg.MODEL_CATALOG_ADMIN_DATABASE_URL
    && sameSelfhostCatalogEndpoint(cfg.DATABASE_URL, cfg.MODEL_CATALOG_ADMIN_DATABASE_URL),
  "BOX_EFFORT_ADMIN_ENDPOINT_INVALID");
  const pool = getPool();
  try {
    await assertModelCatalogAdminPoolConfigured();
    const identitySql = `SELECT current_database() AS name, host(inet_server_addr()) AS addr, inet_server_port() AS port`;
    const [db, adminDb] = await Promise.all([
      pool.query<{ name: string; addr: string; port: number }>(identitySql),
      getModelCatalogAdminPool().query<{ name: string; addr: string; port: number }>(identitySql)]);
    assertion(db.rows.length === 1 && adminDb.rows.length === 1
      && db.rows[0]?.name === "openclaude_v5_selfhost" && db.rows[0]?.addr === "127.0.0.1"
      && db.rows[0]?.port === 5432 && isDeepStrictEqual(adminDb.rows[0], db.rows[0]), "BOX_EFFORT_DATABASE_INVALID");
    const rows = (await getModelCatalogAdminPool().query<{ entry_id: string; engine: string;
      provider_id: string | null; upstream_model_id: string | null; context_window: number | null;
      lock_version: number; capability_profile: unknown; capability_schema_version: number }>(
      `SELECT entry_id::text, engine, provider_id, upstream_model_id, context_window, lock_version,
              capability_profile, capability_schema_version
         FROM model_catalog WHERE model_id=$1 AND state='active'`, [MODEL])).rows;
    assertion(rows.length === 1, "BOX_EFFORT_ACTIVE_ROW_AMBIGUOUS");
    const cur = rows[0]!;
    assertion(cur.engine === "ccb" && cur.provider_id === "box_cli" && cur.upstream_model_id === "claude-opus-5-5",
      "BOX_EFFORT_ROW_IDENTITY_INVALID");
    const isBefore = isDeepStrictEqual(cur.capability_profile, BEFORE);
    const isAfter = isDeepStrictEqual(cur.capability_profile, AFTER);
    assertion(isBefore || isAfter, "BOX_EFFORT_UNEXPECTED_CURRENT_PROFILE");
    const report = { entry_id: cur.entry_id, lock_version: cur.lock_version, current: isAfter ? "after" : "before" };
    if (mode === "plan") { console.log(JSON.stringify({ action: "plan", ...report })); return; }
    const target = mode === "apply" ? AFTER : BEFORE;
    if ((mode === "apply" && isAfter) || (mode === "rollback" && isBefore)) {
      console.log(JSON.stringify({ action: "already", mode, ...report })); return;
    }
    const out = await switchVersion({ model_id: MODEL, engine: cur.engine, provider_id: cur.provider_id,
      upstream_model_id: cur.upstream_model_id, context_window: cur.context_window,
      capability_profile: target, capability_schema_version: cur.capability_schema_version },
    cur.lock_version, { adminId: 3, userAgent: `ocv5-305-box-effort-${mode}` });
    console.log(JSON.stringify({ action: "switched", mode, from_entry: cur.entry_id, to_entry: out.entry_id,
      efforts: target.reasoning.supported }));
  } finally { await Promise.allSettled([closePool(), closeModelCatalogAdminPool()]); }
}
await main();
