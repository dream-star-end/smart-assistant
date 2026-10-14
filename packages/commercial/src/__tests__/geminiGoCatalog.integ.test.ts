import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";
import { query } from "../db/queries.js";
import { getPool } from "../db/index.js";

const db = useDedicatedTestDatabase("gemini_go_423_test");
const productionSql = readFileSync(new URL("../../../../scripts/ocv5-423/catalog.sql", import.meta.url), "utf8");

test("selfhost catalog op is isolated, idempotent and reversibly hides only the new model", async (t) => {
  if (db.skipIfUnavailable(t)) return;
  await resetAndMigrateBefore("0145");
  await query("INSERT INTO users(id,email,password_hash,role) VALUES(3,'g4-test@example.invalid','test-hash','admin')");
  const before = (await query("SELECT jsonb_agg(to_jsonb(p) ORDER BY model_id) AS rows FROM model_pricing p")).rows[0]!.rows;
  // The real guard MUST reject our dedicated test DB. Only this fixture swaps
  // the known DB name after proving the unmodified production guard rejects it.
  await assert.rejects(() => query(productionSql), /selfhost-only/);
  const fixtureSql = productionSql.replace("current_database() <> 'openclaude_v5_selfhost'", "current_database() <> 'gemini_go_423_test'");
  await apply("on");
  async function apply(mode: string) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('openclaude.ocv5_423_enable',$1,true)",[mode]);
      await client.query(fixtureSql);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    finally {client.release();}
  }
  const enabled = await query(`SELECT c.engine,c.provider_id,c.state,c.context_window,p.enabled,p.visibility,
    p.input_per_mtok,p.output_per_mtok FROM model_catalog c JOIN model_pricing p USING(model_id)
    WHERE model_id='gemini-4-argon-contributor'`);
  assert.deepEqual(enabled.rows, [{ engine: "ccb", provider_id: "opencodego", state: "active", context_window: 1000000,
    enabled: true, visibility: "admin", input_per_mtok: "200", output_per_mtok: "1000" }]);
  const snapshot = (await query(`SELECT jsonb_build_object('c',to_jsonb(c),'p',to_jsonb(p)) AS row
    FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE c.model_id='gemini-4-argon-contributor'`)).rows[0]!.row;
  await apply("on");
  assert.deepEqual((await query(`SELECT jsonb_build_object('c',to_jsonb(c),'p',to_jsonb(p)) AS row
    FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE c.model_id='gemini-4-argon-contributor'`)).rows[0]!.row, snapshot);
  await apply("off");
  const disabled = await query(`SELECT c.state,p.enabled,p.visibility FROM model_catalog c JOIN model_pricing p USING(model_id)
    WHERE c.model_id='gemini-4-argon-contributor'`);
  assert.deepEqual(disabled.rows, [{ state: "disabled", enabled: false, visibility: "hidden" }]);
  await apply("on");
  const after = (await query("SELECT jsonb_agg(to_jsonb(p) ORDER BY model_id) AS rows FROM model_pricing p WHERE model_id<>'gemini-4-argon-contributor'")).rows[0]!.rows;
  assert.deepEqual(after, before);
});
