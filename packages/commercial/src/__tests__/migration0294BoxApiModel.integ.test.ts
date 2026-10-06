import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeVersionInput, validateVersionSemantics } from "../admin/modelCatalogOps.js";
import { getPool } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { query } from "../db/queries.js";
import { issueBoxNativeContextOwner } from "../http/proxy/boxNativeContextOwner.js";
import { migrationsDirBefore, resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("commercial_box_api_model_0294_test");
const sqlPath = fileURLToPath(new URL("../db/migrations/0294_commercial_box_api_model.sql", import.meta.url));
const MODEL = "box-api-claude-opus-5-5";
// Rows of the next commercial migration in the same chain (0295) are not "other" rows of this one.
const LATER = ["box-api-claude-sonnet-5-5", "box-api-claude-haiku-4-5"];

async function others() {
  return (await query(
    `SELECT (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.entry_id) FROM model_catalog c WHERE c.model_id<>$1 AND NOT(c.model_id=ANY($2::text[]))) AS catalog,
            (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.model_id) FROM model_pricing p WHERE p.model_id<>$1 AND NOT(p.model_id=ANY($2::text[]))) AS pricing,
            (SELECT jsonb_agg(to_jsonb(gm) ORDER BY gm.group_id,gm.model_id) FROM account_group_models gm) AS bindings`,
    [MODEL, LATER])).rows[0];
}

async function prepared() {
  const rows = (await query(
    "SELECT c.*,to_jsonb(p) AS pricing FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE c.model_id=$1", [MODEL])).rows;
  assert.equal(rows.length, 1);
  return rows[0]!;
}

describe("0294 prepares the commercial Box model route without offering it", () => {
  test("the full chain leaves one staged entry and a disabled price the route can run with", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const row = await prepared();
    assert.equal(row.state, "staged");
    assert.deepEqual({ engine: row.engine, provider: row.provider_id, upstream: row.upstream_model_id,
      context: row.context_window }, { engine: "ccb", provider: "box_cli", upstream: "claude-opus-5-5", context: 1000000 });
    // the price of the box-claude-opus-5-5 row this model replaces for commercial users (0293)
    const replaced = (await query("SELECT to_jsonb(p) AS pricing FROM model_pricing p WHERE model_id='box-claude-opus-5-5'")).rows[0]!.pricing;
    for (const key of ["display_name", "input_per_mtok", "output_per_mtok", "cache_read_per_mtok", "cache_write_per_mtok",
      "multiplier", "sort_order", "visibility", "min_plan_code", "default_effort"]) {
      assert.deepEqual(row.pricing[key], replaced[key], key);
    }
    assert.equal(row.pricing.enabled, false);
    assert.equal((await query("SELECT 1 FROM model_visibility_grants WHERE model_id=$1", [MODEL])).rowCount, 0);
    assert.equal((await query("SELECT 1 FROM account_group_models WHERE model_id=$1", [MODEL])).rowCount, 0);
    // what the product itself requires of this row: the activation checks, and the declaration the
    // signed descriptor needs before a container may keep its context in the Box
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
    await resetAndMigrateBefore("0294");
    const before = await others();
    assert.deepEqual((await runMigrations({ dir: await migrationsDirBefore("0298") })).applied, ["0294_commercial_box_api_model", "0295_commercial_box_api_sonnet_haiku", "0296_commercial_retire_minimax_m3_gpt56_sol", "0297_commercial_minimax_refs_to_grok_build"]);
    assert.deepEqual(await others(), before);
    assert.equal((await prepared()).state, "staged");
  });

  test("a second run refuses the existing row and changes nothing", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const before = await others();
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await assert.rejects(client.query(await readFile(sqlPath, "utf8")), /0294 refuses a pre-existing/);
    } finally { await client.query("ROLLBACK"); client.release(); }
    assert.deepEqual(await others(), before);
    assert.equal((await prepared()).state, "staged");
  });

  test("the catalog activation function accepts the prepared entry and enables its price", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const row = await prepared();
    // fn_model_activate_entry is the single activation authority the admin path calls
    await query("SELECT fn_model_activate_entry($1::bigint,$2,NULL::bigint)", [String(row.entry_id), row.lock_version]);
    const active = await prepared();
    assert.equal(active.state, "active");
    assert.equal(active.pricing.enabled, true);
  });
});
