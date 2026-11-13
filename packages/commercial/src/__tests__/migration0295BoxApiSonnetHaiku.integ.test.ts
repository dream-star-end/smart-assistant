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
import { migrationsDirBefore, resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("commercial_box_api_sonnet_haiku_0295_test");
const sqlPath = fileURLToPath(new URL("../db/migrations/0295_commercial_box_api_sonnet_haiku.sql", import.meta.url));
// model -> [upstream, efforts, the commercial box-claude row whose price it takes, display name, window after 0298]
const MODELS: Record<string, { upstream: string; efforts: string[]; replaces: string; display: string; context: number }> = {
  "box-api-claude-sonnet-5-5": { upstream: "claude-sonnet-5-5", efforts: ["low", "medium", "high", "xhigh", "max"],
    replaces: "box-claude-sonnet-5", display: "Claude Sonnet 5.5", context: 1000000 },
  "box-api-claude-haiku-4-5": { upstream: "claude-haiku-4-5-20251001", efforts: [],
    replaces: "box-claude-haiku-4-5", display: "Claude Haiku 4.5", context: 200000 },
};
const IDS = Object.keys(MODELS);

async function others() {
  return (await query(
    `SELECT (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.entry_id) FROM model_catalog c WHERE NOT(c.model_id=ANY($1::text[]))) AS catalog,
            (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.model_id) FROM model_pricing p WHERE NOT(p.model_id=ANY($1::text[]))) AS pricing,
            (SELECT jsonb_agg(to_jsonb(gm) ORDER BY gm.group_id,gm.model_id) FROM account_group_models gm) AS bindings`,
    [IDS])).rows[0];
}

async function prepared(model: string) {
  const rows = (await query(
    "SELECT c.*,to_jsonb(p) AS pricing FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE c.model_id=$1", [model])).rows;
  assert.equal(rows.length, 1, model);
  return rows[0]!;
}

describe("0295 prepares Sonnet 5.5 and Haiku 4.5 on the commercial Box model route without offering them", () => {
  test("the full chain leaves two staged entries with disabled prices the route can run with", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    for (const [model, want] of Object.entries(MODELS)) {
      const row = await prepared(model);
      assert.equal(row.state, "staged", model);
      assert.deepEqual({ engine: row.engine, provider: row.provider_id, upstream: row.upstream_model_id,
        context: row.context_window }, { engine: "ccb", provider: "box_cli", upstream: want.upstream, context: want.context }, model);
      // the id pair is one the product's route table lists
      assert.equal(boxApiModelById(model)?.upstreamModel, want.upstream, model);
      assert.deepEqual(row.capability_profile.reasoning.supported, want.efforts, model);
      assert.equal(boxApiModelById(model)?.supportsEffort, want.efforts.length > 0, model);
      // the price of the box-claude row this model replaces for commercial users (0293)
      const replaced = (await query("SELECT to_jsonb(p) AS pricing FROM model_pricing p WHERE model_id=$1", [want.replaces])).rows[0]!.pricing;
      for (const key of ["input_per_mtok", "output_per_mtok", "cache_read_per_mtok", "cache_write_per_mtok",
        "multiplier", "sort_order", "visibility", "min_plan_code", "default_effort"]) {
        assert.deepEqual(row.pricing[key], replaced[key], `${model} ${key}`);
      }
      assert.equal(row.pricing.display_name, want.display, model);
      assert.equal(row.pricing.enabled, false, model);
      assert.equal((await query("SELECT 1 FROM model_visibility_grants WHERE model_id=$1", [model])).rowCount, 0, model);
      assert.equal((await query("SELECT 1 FROM account_group_models WHERE model_id=$1", [model])).rowCount, 0, model);
      const version = normalizeVersionInput({ model_id: row.model_id, engine: row.engine, provider_id: row.provider_id,
        upstream_model_id: row.upstream_model_id, context_window: row.context_window,
        capability_profile: row.capability_profile, capability_schema_version: row.capability_schema_version });
      assert.deepEqual(validateVersionSemantics(version, true), [], model);
      assert.equal(issueBoxNativeContextOwner({ canonicalModel: row.model_id, providerId: row.provider_id,
        declared: row.capability_profile.ccb.context_owner, routeReady: true }), "box-native-v1", model);
    }
    assert.deepEqual((await runMigrations()).applied, []);
  });

  test("the upgrade changes no other catalog, price or binding row", { timeout: 180000 }, async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0295");
    const before = await others();
    assert.equal((await query("SELECT 1 FROM model_catalog WHERE model_id=ANY($1::text[])", [IDS])).rowCount, 0);
    assert.deepEqual((await runMigrations({ dir: await migrationsDirBefore("0298") })).applied, ["0295_commercial_box_api_sonnet_haiku", "0296_commercial_retire_minimax_m3_gpt56_sol", "0297_commercial_minimax_refs_to_grok_build"]);
    assert.deepEqual(await others(), before);
    for (const model of IDS) assert.equal((await prepared(model)).state, "staged", model);
  });

  test("a second run refuses the existing rows and changes nothing", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const before = await others();
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await assert.rejects(client.query(await readFile(sqlPath, "utf8")), /0295 refuses a pre-existing/);
    } finally { await client.query("ROLLBACK"); client.release(); }
    assert.deepEqual(await others(), before);
    for (const model of IDS) assert.equal((await prepared(model)).state, "staged", model);
  });

  test("the catalog activation function accepts each prepared entry and enables its price", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    for (const model of IDS) {
      const row = await prepared(model);
      // fn_model_activate_entry is the single activation authority the admin path calls
      await query("SELECT fn_model_activate_entry($1::bigint,$2,NULL::bigint)", [String(row.entry_id), row.lock_version]);
      const active = await prepared(model);
      assert.equal(active.state, "active", model);
      assert.equal(active.pricing.enabled, true, model);
    }
  });
});
