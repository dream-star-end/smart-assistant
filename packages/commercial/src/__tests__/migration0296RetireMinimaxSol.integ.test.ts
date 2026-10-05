import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_CODEX_ENGINE_MODEL } from "@openclaude/protocol";
import { DEFAULT_AUTO_DREAM_MODEL } from "../billing/autoDreamModels.js";
import { runMigrations } from "../db/migrate.js";
import { query } from "../db/queries.js";
import { PLATFORM_SEED_MODEL_IDS } from "../http/internalModelCatalog.js";
import { resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("commercial_retire_minimax_sol_0296_test");
const NAME = "0296_commercial_retire_minimax_m3_gpt56_sol";
const sqlPath = fileURLToPath(new URL(`../db/migrations/${NAME}.sql`, import.meta.url));
const OLD = ["MiniMax-M3", "gpt-5.6-sol"];

const requirements = async () => (await query<{ pair: string }>(
  "SELECT model_id || ':' || requirement AS pair FROM model_runtime_requirements ORDER BY 1")).rows.map((r) => r.pair);
const autoDream = async () => (await query<{ v: string }>(
  "SELECT value #>> '{}' AS v FROM system_settings WHERE key='auto_dream_model'")).rows[0]?.v;
const prefs = async () => Object.fromEntries((await query<{ email: string; m: string; theme: string }>(
  `SELECT u.email, p.prefs->>'default_model' AS m, p.prefs->>'theme' AS theme
     FROM user_preferences p JOIN users u ON u.id=p.user_id ORDER BY 1`)).rows.map((r) => [r.email, `${r.m}/${r.theme}`]));
const sessions = async () => Object.fromEntries((await query<{ id: string; model_id: string; updated_at: string }>(
  "SELECT id, model_id, updated_at::text FROM client_sessions ORDER BY 1")).rows.map((r) => [r.id, `${r.model_id}@${r.updated_at}`]));
const snapshots = async () => (await query<{ row: string }>(
  `SELECT subject_kind || '|' || subject_key || '|' || original_model_id || '|' || COALESCE(replacement_model_id,'-') AS row
     FROM model_0296_transition_snapshots WHERE subject_kind IN ('runtime_requirement','system_setting') ORDER BY 1`)).rows.map((r) => r.row);
// every catalog and pricing row, to show the migration itself takes nothing offline
const catalog = async () => (await query(
  `SELECT (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.entry_id) FROM model_catalog c) AS catalog,
          (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.model_id) FROM model_pricing p) AS pricing,
          (SELECT jsonb_agg(to_jsonb(g) ORDER BY g.model_id, g.user_id) FROM model_visibility_grants g) AS grants,
          (SELECT jsonb_agg(to_jsonb(gm) ORDER BY gm.group_id, gm.model_id) FROM account_group_models gm) AS bindings`)).rows[0];
const active = async (model: string) => (await query<{ entry_id: string; lock_version: number }>(
  "SELECT entry_id::text, lock_version FROM model_catalog WHERE model_id=$1 AND state='active'", [model])).rows[0]!;
// fn_model_disable_entry is what the admin "disable" action calls; the 0144 guard fires at commit
const disable = async (model: string) => {
  const row = await active(model);
  await query("SELECT fn_model_disable_entry($1::bigint,$2,NULL::bigint)", [row.entry_id, row.lock_version]);
};
const user = async (email: string, defaultModel: string) => {
  const id = (await query<{ id: string }>(
    "INSERT INTO users(email,password_hash,role) VALUES ($1,'x','user') RETURNING id::text AS id", [email])).rows[0]!.id;
  await query("INSERT INTO user_preferences(user_id,prefs) VALUES ($1,jsonb_build_object('theme','dark','default_model',$2::text))",
    [id, defaultModel]);
  return id;
};
const session = (id: string, userId: string, model: string, deleted = false) => query(
  `INSERT INTO client_sessions(id,user_id,agent_id,title,pinned,created_at,last_at,messages,message_count,
     updated_at,deleted_at,next_seq,archived_through_seq,archived_count,model_id)
   VALUES ($1,$2,'main','test',0,1000,1000,'[]',0,1000,$3,1,0,0,$4)`, [id, userId, deleted ? 2000 : null, model]);
async function seedUsers() {
  const sol = await user("sol@example.test", "gpt-5.6-sol");
  const mm = await user("minimax@example.test", "MiniMax-M3");
  const other = await user("other@example.test", "glm-5.3");
  await session("live-sol", sol, "gpt-5.6-sol");
  await session("live-mm", mm, "MiniMax-M3");
  await session("deleted-sol", sol, "gpt-5.6-sol", true);
  await session("live-other", other, "glm-5.3");
}

describe("0296 moves the platform's own needs off MiniMax-M3 and gpt-5.6-sol", () => {
  test("the full chain: requirements and the auto-dream setting match what the code now names", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const req = await requirements();
    assert.ok(req.includes(`${DEFAULT_CODEX_ENGINE_MODEL}:default_codex_engine`), req.join());
    assert.deepEqual(req.filter((r) => OLD.some((m) => r.startsWith(`${m}:`))), []);
    assert.equal(await autoDream(), DEFAULT_AUTO_DREAM_MODEL);
    assert.deepEqual(await snapshots(), [
      "runtime_requirement|default_codex_engine|gpt-5.6-sol|gpt-6-astra",
      "runtime_requirement|official_seed_agent|MiniMax-M3|-",
      "system_setting|auto_dream_model|MiniMax-M3|deepseek-v4-flash",
    ]);
    // the models the release itself needs are not the two being retired
    assert.deepEqual(PLATFORM_SEED_MODEL_IDS.filter((m) => OLD.includes(m)), []);
    assert.deepEqual((await runMigrations()).applied, []);
  });

  test("the upgrade rewrites defaults and live sessions, leaves the catalog alone, and only then can both models be disabled",
    { timeout: 180000 }, async (t) => {
      if (db.skipIfUnavailable(t)) return;
      await resetAndMigrateBefore("0296");
      // production has gpt-6.1-sol active (admin activation after 0293); the chain leaves it staged
      const staged = (await query<{ entry_id: string; lock_version: number }>(
        "SELECT entry_id::text, lock_version FROM model_catalog WHERE model_id='gpt-6.1-sol' AND state='staged'")).rows[0]!;
      await query("SELECT fn_model_activate_entry($1::bigint,$2,NULL::bigint)", [staged.entry_id, staged.lock_version]);
      await seedUsers();
      // before 0296 the guard refuses each of the two
      for (const model of OLD) await assert.rejects(disable(model), /required runtime models must remain active and priced/, model);
      const before = await catalog();

      assert.deepEqual((await runMigrations()).applied, [NAME]);

      assert.deepEqual(await catalog(), before);
      assert.deepEqual(await prefs(), {
        "minimax@example.test": "deepseek-v4-flash/dark",
        "other@example.test": "glm-5.3/dark",
        "sol@example.test": "gpt-6.1-sol/dark",
      });
      const after = await sessions();
      assert.match(after["live-sol"]!, /^gpt-6\.1-sol@/);
      assert.match(after["live-mm"]!, /^deepseek-v4-flash@/);
      // a rewritten live session gets a newer updated_at so clients pick the change up
      assert.ok(Number(after["live-sol"]!.split("@")[1]) > 1000 && Number(after["live-mm"]!.split("@")[1]) > 1000);
      assert.equal(after["deleted-sol"], "gpt-5.6-sol@1000");
      assert.equal(after["live-other"], "glm-5.3@1000");
      assert.equal(await autoDream(), "deepseek-v4-flash");
      const req = await requirements();
      assert.ok(req.includes("gpt-6-astra:default_codex_engine") && req.includes("deepseek-v4-flash:official_seed_agent"), req.join());
      assert.deepEqual(req.filter((r) => OLD.some((m) => r.startsWith(`${m}:`))), []);

      // a second application changes nothing
      const settled = [await prefs(), await sessions(), await requirements(), await autoDream()];
      await query(await readFile(sqlPath, "utf8"));
      assert.deepEqual([await prefs(), await sessions(), await requirements(), await autoDream()], settled);

      // the guard itself is unchanged: it still refuses a model that carries a requirement
      await assert.rejects(disable("gpt-6-astra"), /required runtime models must remain active and priced: gpt-6-astra:default_codex_engine/);
      for (const model of OLD) {
        await disable(model);
        assert.equal((await query("SELECT 1 FROM model_catalog WHERE model_id=$1 AND state='active'", [model])).rowCount, 0, model);
      }
    });

  test("a replacement users cannot pick yet leaves their default and sessions as they are", { timeout: 180000 }, async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0296"); // gpt-6.1-sol is only staged here
    await seedUsers();
    assert.deepEqual((await runMigrations()).applied, [NAME]);
    assert.equal((await prefs())["sol@example.test"], "gpt-5.6-sol/dark");
    assert.equal((await sessions())["live-sol"], "gpt-5.6-sol@1000");
    assert.equal((await prefs())["minimax@example.test"], "deepseek-v4-flash/dark");
  });

  test("the manual rollback in the migration header restores every recorded value", { timeout: 180000 }, async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0296");
    const staged = (await query<{ entry_id: string; lock_version: number }>(
      "SELECT entry_id::text, lock_version FROM model_catalog WHERE model_id='gpt-6.1-sol' AND state='staged'")).rows[0]!;
    await query("SELECT fn_model_activate_entry($1::bigint,$2,NULL::bigint)", [staged.entry_id, staged.lock_version]);
    await seedUsers();
    const before = { prefs: await prefs(), requirements: await requirements(), autoDream: await autoDream() };
    assert.deepEqual((await runMigrations()).applied, [NAME]);
    const sql = await readFile(sqlPath, "utf8");
    const block = /-- BEGIN MANUAL ROLLBACK 0296[^\n]*\n([\s\S]*?)-- END MANUAL ROLLBACK 0296/.exec(sql)![1]!;
    await query(block.split("\n").map((line) => line.replace(/^-- ?/, "")).join("\n"));
    assert.deepEqual({ prefs: await prefs(), requirements: await requirements(), autoDream: await autoDream() }, before);
    const after = await sessions();
    assert.match(after["live-sol"]!, /^gpt-5\.6-sol@/);
    assert.match(after["live-mm"]!, /^MiniMax-M3@/);
    assert.equal(after["deleted-sol"], "gpt-5.6-sol@1000");
  });
});
