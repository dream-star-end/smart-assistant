/**
 * OCV5-305 operator step: let users choose Box Claude's thinking effort.
 *
 * Box Claude (box-api-claude-opus-5-5) was staged in OCV5-289 with
 * reasoning.supported = [], so the UI showed no effort selector and the client
 * never sent one. Since OCV5-305 the Box route maps every native Claude Code
 * effort (low, medium, high, xhigh, max) to the Box CLI's own `--effort`, so
 * the catalog may now declare them. Only reasoning.supported changes; engine,
 * provider, upstream model, context window and the ccb profile (capability
 * zero, no client thinking, box-native-v1 context owner) stay exactly as they
 * are — the Box CLI runs native adaptive thinking at the chosen effort.
 *
 * Must run FROM the live release that contains OCV5-305 (the Box ceiling must
 * already allow these efforts, or every Box request would fail closed), with
 * the egress env. Official path: modelCatalogOps.switchVersion (validation,
 * stored procedure, admin audit, catalog NOTIFY). Dry-run unless --apply.
 *   (set -a; . /etc/openclaude/commercial-v5-selfhost.env; set +a;
 *    node --import tsx scripts/ocv5-305/boxCatalogEffort.ts [--apply])
 */
import { isDeepStrictEqual } from "node:util";
import { realpathSync } from "node:fs";
import { switchVersion } from "../../packages/commercial/src/admin/modelCatalogOps.js";
import { closeModelCatalogAdminPool, getModelCatalogAdminPool } from "../../packages/commercial/src/db/modelCatalogAdmin.js";
import { BOX_ROUTE_EFFORTS, providerCapabilityCeiling } from "../../packages/commercial/src/http/proxy/upstream.js";
import { BOX_CLI_EFFORTS } from "../../packages/commercial/src/http/proxy/boxToolCatalog.js";

const MODEL = "box-api-claude-opus-5-5";
const LIVE = "/opt/openclaude/openclaude-v5-selfhost-live";
const BEFORE = { supports_vision: false, reasoning: { supported: [], codex_model_default: null },
  ccb: { context_owner: "box-native-v1", capability_zero: true, supports_thinking: false } };
const AFTER = { ...BEFORE, reasoning: { supported: [...BOX_CLI_EFFORTS], codex_model_default: null } };
const apply = process.argv.includes("--apply");

if (realpathSync(process.cwd()) !== realpathSync(LIVE)) throw new Error("RUN_FROM_LIVE_RELEASE");
const ceiling = providerCapabilityCeiling({ kind: "box", upstreamModel: "claude-opus-5-5" }).efforts ?? [];
if (!isDeepStrictEqual([...ceiling], [...BOX_CLI_EFFORTS]) || !isDeepStrictEqual([...BOX_ROUTE_EFFORTS], [...BOX_CLI_EFFORTS])) {
  throw new Error("LIVE_RELEASE_LACKS_OCV5_305_BOX_CEILING");
}
const pool = getModelCatalogAdminPool();
try {
  const rows = (await pool.query<{ entry_id: string; engine: string; provider_id: string | null;
    upstream_model_id: string | null; context_window: number | null; lock_version: number;
    capability_profile: unknown; capability_schema_version: number }>(
    `SELECT entry_id::text, engine, provider_id, upstream_model_id, context_window, lock_version,
            capability_profile, capability_schema_version
       FROM model_catalog WHERE model_id=$1 AND state='active'`, [MODEL])).rows;
  if (rows.length !== 1) throw new Error(`EXPECTED_ONE_ACTIVE_ROW got ${rows.length}`);
  const cur = rows[0]!;
  if (isDeepStrictEqual(cur.capability_profile, AFTER)) {
    console.log(JSON.stringify({ action: "already_applied", entry_id: cur.entry_id }));
  } else {
    if (!isDeepStrictEqual(cur.capability_profile, BEFORE)) {
      throw new Error(`UNEXPECTED_CURRENT_PROFILE ${JSON.stringify(cur.capability_profile)}`);
    }
    const input = { model_id: MODEL, engine: cur.engine, provider_id: cur.provider_id,
      upstream_model_id: cur.upstream_model_id, context_window: cur.context_window,
      capability_profile: AFTER, capability_schema_version: cur.capability_schema_version };
    if (!apply) {
      console.log(JSON.stringify({ action: "would_switch", from_entry: cur.entry_id, lock_version: cur.lock_version,
        engine: cur.engine, provider_id: cur.provider_id, upstream_model_id: cur.upstream_model_id,
        efforts: AFTER.reasoning.supported }));
    } else {
      const out = await switchVersion(input, cur.lock_version, { adminId: 3, userAgent: "ocv5-305-box-effort" });
      console.log(JSON.stringify({ action: "switched", from_entry: cur.entry_id, to_entry: out.entry_id,
        efforts: AFTER.reasoning.supported }));
    }
  }
} finally { await closeModelCatalogAdminPool(); }
