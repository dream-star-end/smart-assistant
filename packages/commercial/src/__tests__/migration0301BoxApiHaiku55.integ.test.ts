import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { boxApiModelById } from "@openclaude/protocol";
import { normalizeVersionInput, validateVersionSemantics } from "../admin/modelCatalogOps.js";
import { getPool } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { query } from "../db/queries.js";
import { issueBoxNativeContextOwner } from "../http/proxy/boxNativeContextOwner.js";
import { resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("commercial_box_api_haiku55_0301_test");
const sqlPath = fileURLToPath(new URL("../db/migrations/0301_commercial_box_api_haiku_5_5.sql", import.meta.url));
const MODEL = "box-api-claude-haiku-5-5";
const UPSTREAM = "claude-haiku-5-5";
const metadataPath = fileURLToPath(new URL("../../../../deploy/v5/release-metadata.json", import.meta.url));

async function others() {
  return (await query(
    `SELECT (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.entry_id) FROM model_catalog c WHERE c.model_id<>$1) AS catalog,
            (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.model_id) FROM model_pricing p WHERE p.model_id<>$1) AS pricing,
            (SELECT jsonb_agg(to_jsonb(gm) ORDER BY gm.group_id,gm.model_id) FROM account_group_models gm) AS bindings`,
    [MODEL])).rows[0];
}

async function prepared() {
  const rows = (await query(
    "SELECT c.*,to_jsonb(p) AS pricing FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE c.model_id=$1", [MODEL])).rows;
  assert.equal(rows.length, 1);
  return rows[0]!;
}

describe("0301 prepares Claude Haiku 5.5 on the commercial Box model route without offering it", () => {
  test("release metadata requires 0301 right after 0299", async () => {
    const ids = (JSON.parse(await readFile(metadataPath, "utf8")) as { requiredMigrations: string[] }).requiredMigrations;
    assert.equal(ids[ids.indexOf("0299_commercial_box_claude_profiles") + 1], "0301_commercial_box_api_haiku_5_5");
    assert.equal(ids.includes("0300_box_claude_haiku_5_5"), false, "0300 is the selfhost file of this task");
  });

  test("the full chain leaves one staged entry with a disabled price the route can run with", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const row = await prepared();
    assert.equal(row.state, "staged");
    assert.deepEqual({ engine: row.engine, provider: row.provider_id, upstream: row.upstream_model_id, context: row.context_window },
      { engine: "ccb", provider: "box_cli", upstream: UPSTREAM, context: 1000000 });
    assert.equal(boxApiModelById(MODEL)?.upstreamModel, UPSTREAM);
    assert.equal(boxApiModelById(MODEL)?.supportsEffort, true);
    assert.equal(boxApiModelById(MODEL)?.maxOutputTokens, 128000);
    assert.deepEqual(row.capability_profile.reasoning.supported, ["low", "medium", "high", "xhigh", "max"]);
    // same capability profile as the Sonnet 5.5 row of the route
    const sonnet = (await query("SELECT capability_profile FROM model_catalog WHERE model_id='box-api-claude-sonnet-5-5' AND state='staged'")).rows[0]!;
    assert.deepEqual(row.capability_profile, sonnet.capability_profile);
    const p = row.pricing;
    assert.deepEqual([p.display_name, p.input_per_mtok, p.output_per_mtok, p.cache_read_per_mtok, p.cache_write_per_mtok,
      p.multiplier, p.enabled, p.sort_order, p.visibility, p.min_plan_code, p.default_effort, p.extra_system_prompt],
    ["Claude Haiku 5.5", 20, 100, 2, 25, 1, false, 18, "public", null, null, null]);
    assert.equal((await query("SELECT 1 FROM model_visibility_grants WHERE model_id=$1", [MODEL])).rowCount, 0);
    assert.equal((await query("SELECT 1 FROM account_group_models WHERE model_id=$1", [MODEL])).rowCount, 0);
    const version = normalizeVersionInput({ model_id: row.model_id, engine: row.engine, provider_id: row.provider_id,
      upstream_model_id: row.upstream_model_id, context_window: row.context_window,
      capability_profile: row.capability_profile, capability_schema_version: row.capability_schema_version });
    assert.deepEqual(validateVersionSemantics(version, true), []);
    assert.equal(issueBoxNativeContextOwner({ canonicalModel: row.model_id, providerId: row.provider_id,
      declared: row.capability_profile.ccb.context_owner, routeReady: true }), "box-native-v1");
    assert.deepEqual((await runMigrations()).applied, []);
  });

  test("the upgrade changes no other catalog, price or binding row", { timeout: 180000 }, async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0301");
    const before = await others();
    assert.equal((await query("SELECT 1 FROM model_catalog WHERE model_id=$1", [MODEL])).rowCount, 0);
    assert.deepEqual((await runMigrations()).applied, ["0301_commercial_box_api_haiku_5_5"]);
    assert.deepEqual(await others(), before);
    assert.equal((await prepared()).state, "staged");
  });

  test("a second run refuses the existing row and changes nothing", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const before = await others();
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await assert.rejects(client.query(await readFile(sqlPath, "utf8")), /0301 refuses a pre-existing/);
    } finally { await client.query("ROLLBACK"); client.release(); }
    assert.deepEqual(await others(), before);
    assert.equal((await prepared()).state, "staged");
  });

  test("the catalog activation function accepts the prepared entry and enables its price", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const row = await prepared();
    await query("SELECT fn_model_activate_entry($1::bigint,$2,NULL::bigint)", [String(row.entry_id), row.lock_version]);
    const active = await prepared();
    assert.equal(active.state, "active");
    assert.equal(active.pricing.enabled, true);
  });
});
