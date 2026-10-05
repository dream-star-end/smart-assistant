import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { getPool } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { query } from "../db/queries.js";
import { resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("commercial_new_models_0293_test");
const manifestPath = fileURLToPath(new URL("../../../../ops/ocv5-308/model-release-manifest.json", import.meta.url));
const sqlPath = fileURLToPath(new URL("../db/migrations/0293_commercial_new_models_prepare.sql", import.meta.url));
const manifest = JSON.parse(await readFile(manifestPath,"utf8")) as {new_models:Array<Record<string,any>>};
const specs = manifest.new_models;
const ids = specs.map(x=>x.model_id as string);
const keys = [...new Set(specs.map(x=>x.group_key as string))];
// Rows of later commercial migrations in the same chain (0294, 0295) are not "old" rows of this one.
const later = ["box-api-claude-opus-5-5", "box-api-claude-sonnet-5-5", "box-api-claude-haiku-4-5"];

async function oldSnapshot() {
  return (await query(
    "SELECT (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.entry_id) FROM model_catalog c WHERE NOT(c.model_id=ANY($1::text[]))) AS catalog,(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.model_id) FROM model_pricing p WHERE NOT(p.model_id=ANY($1::text[]))) AS pricing,(SELECT jsonb_agg(to_jsonb(gm) ORDER BY gm.group_id,gm.model_id) FROM account_group_models gm WHERE NOT(gm.model_id=ANY($2::text[]))) AS bindings",
    [[...ids,...later],keys])).rows[0];
}

async function assertPrepared() {
  assert.equal(specs.length,17);
  const rows = (await query(
    "SELECT c.*,to_jsonb(p) AS pricing FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE c.model_id=ANY($1::text[]) ORDER BY c.model_id",[ids])).rows;
  assert.deepEqual(rows.map(r=>r.model_id).sort(),[...ids].sort());
  for (const row of rows) {
    const spec = specs.find(s=>s.model_id===row.model_id)!;
    assert.equal(row.state,"staged");
    for(const k of ["engine","provider_id","upstream_model_id","context_window","capability_profile","capability_schema_version"]) assert.deepEqual(row[k],spec[k]);
    assert.equal(row.pricing.enabled,false);
    assert.equal(row.pricing.visibility,"public");
    assert.equal(row.pricing.min_plan_code,null);
    for(const k of ["display_name","input_per_mtok","output_per_mtok","cache_read_per_mtok","cache_write_per_mtok","multiplier","sort_order","default_effort"]) assert.deepEqual(row.pricing[k],spec[k]);
  }
  assert.equal((await query("SELECT 1 FROM model_visibility_grants WHERE model_id=ANY($1::text[])",[ids])).rowCount,0);
  const constraint = (await query<{expr:string}>("SELECT pg_get_expr(conbin,conrelid) AS expr FROM pg_constraint WHERE conrelid='cursor_external_usage_audit'::regclass AND conname='cursor_external_usage_audit_model_id_check'")).rows[0]!;
  const acceptance = await query<{model_id:string;accepted:boolean}>(
    "SELECT model_id,("+constraint.expr+") AS accepted FROM (SELECT DISTINCT model_id FROM model_catalog WHERE engine='cursor') q ORDER BY model_id");
  assert.ok(acceptance.rows.length>30);
  assert.ok(acceptance.rows.every(x=>x.accepted===true),JSON.stringify(acceptance.rows.filter(x=>!x.accepted)));
}

describe("0293 commercial prepare new models without activating or changing old models",()=>{
  test("normal full chain creates exact frozen public 17 but leaves every new entry staged/disabled",async t=>{
    if(db.skipIfUnavailable(t))return;
    await assertPrepared();
    const replay=await runMigrations();
    assert.deepEqual(replay.applied,[]);
  });

  test("upgrade preserves every old catalog/price/permission/binding and derives only local official groups", {timeout:180000},async t=>{
    if(db.skipIfUnavailable(t))return;
    await resetAndMigrateBefore("0293");
    // Production already disabled this twin via configuration; recreate that
    // real floor, not a fake ledger or a change in preparation SQL.
    await query("UPDATE model_catalog SET state='disabled' WHERE model_id='gpt-6-astra-1m' AND state='active'");
    const seeded = new Map<string,string>();
    for (const [provider,donor] of [["claude","claude-opus-5"],["cursor","cursor-grok-4.6-high"],["grok","grok-build"],["codex","gpt-5.6-sol"]]) {
      const group=(await query<{id:string}>("INSERT INTO account_groups(label,provider,kind,enabled) VALUES ($1,$2,'official_oauth',TRUE) RETURNING id::text",["OCV5-308 test "+provider,provider])).rows[0]!;
      seeded.set(provider,group.id);
      await query("INSERT INTO account_group_models(group_id,model_id) VALUES($1,$2)",[group.id,donor]);
      if(provider==="codex") await query("INSERT INTO account_group_models(group_id,model_id) VALUES($1,'gpt-5.6-luna')",[group.id]);
    }
    const before=await oldSnapshot();
    const result=await runMigrations();
    assert.deepEqual(result.applied,["0293_commercial_new_models_prepare","0294_commercial_box_api_model","0295_commercial_box_api_sonnet_haiku","0296_commercial_retire_minimax_m3_gpt56_sol","0297_commercial_minimax_refs_to_grok_build"]);
    assert.deepEqual(await oldSnapshot(),before);
    assert.equal((await query("SELECT 1 FROM model_pricing WHERE model_id='gpt-6-astra-1m' AND enabled IS TRUE")).rowCount,0);
    await assertPrepared();
    for(const [provider,groupId] of seeded) {
      const expected=[...new Set(specs.filter(s=>s.group_provider===provider).map(s=>s.group_key))].sort();
      const actual=(await query<{model_id:string}>("SELECT model_id FROM account_group_models WHERE group_id=$1 AND model_id=ANY($2::text[]) ORDER BY model_id",[groupId,keys])).rows.map(r=>r.model_id).sort();
      assert.deepEqual(actual,expected);
    }
    assert.equal(keys.length,15);
  });

  test("replaying preparation refuses preexisting targets and leaves the database unchanged",async t=>{
    if(db.skipIfUnavailable(t))return;
    const before=await oldSnapshot();
    const client=await getPool().connect();
    try {
      await client.query("BEGIN");
      await assert.rejects(client.query(await readFile(sqlPath,"utf8")),/refuses pre-existing new model rows/);
    }finally{await client.query("ROLLBACK");client.release();}
    assert.deepEqual(await oldSnapshot(),before);
    await assertPrepared();
  });
});
