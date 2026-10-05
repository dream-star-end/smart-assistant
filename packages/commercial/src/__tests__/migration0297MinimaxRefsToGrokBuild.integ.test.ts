import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../db/migrate.js";
import { query } from "../db/queries.js";
import { PLATFORM_SEED_AGENT_MODEL_IDS } from "../marketplace/seedPlatformAgents.js";
import { migrationsDirBefore, resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("commercial_minimax_refs_to_grok_build_0297_test");
const NAME = "0297_commercial_minimax_refs_to_grok_build";
const sqlFile = (name: string) => fileURLToPath(new URL(`../db/migrations/${name}.sql`, import.meta.url));
const SQL_0296 = sqlFile("0296_commercial_retire_minimax_m3_gpt56_sol");
const SQL_0297 = sqlFile(NAME);
const GROK_REQ = "grok-build:official_seed_agent";

// rows are sorted in JS (code point order): ORDER BY on text follows the database collation, which differs between hosts
const requirements = async () => (await query<{ pair: string }>(
  "SELECT model_id || ':' || requirement AS pair FROM model_runtime_requirements")).rows.map((r) => r.pair).sort();
const normalize = async () => (await query<{ row: string }>(
  `SELECT subject_kind || '|' || old_model_id || '|' || new_model_id || '|' || rewritten || '|' || COALESCE(skipped_reason,'-') AS row
     FROM fn_0296_normalize_retired_model_refs()`)).rows.map((r) => r.row).sort();
const prefs = async () => Object.fromEntries((await query<{ email: string; m: string; theme: string }>(
  `SELECT u.email, p.prefs->>'default_model' AS m, p.prefs->>'theme' AS theme
     FROM user_preferences p JOIN users u ON u.id=p.user_id`)).rows.map((r) => [r.email, `${r.m}/${r.theme}`]));
const sessions = async () => Object.fromEntries((await query<{ id: string; model_id: string; updated_at: string }>(
  "SELECT id, model_id, updated_at::text FROM client_sessions")).rows.map((r) => [r.id, `${r.model_id}@${r.updated_at}`]));
const sessionModels = async () => Object.fromEntries(Object.entries(await sessions()).map(([id, v]) => [id, v.split("@")[0]]));
const ledger = async () => (await query<{ row: string }>(
  `SELECT subject_kind || '|' || CASE WHEN subject_kind='user_preferences'
            THEN (SELECT email FROM users u WHERE u.id::text = s.subject_key) ELSE subject_key END
          || '|' || original_model_id || '|' || COALESCE(replacement_model_id,'-') AS row
     FROM model_0296_transition_snapshots s`)).rows.map((r) => r.row).sort();
const catalog = async () => (await query(
  `SELECT (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.entry_id) FROM model_catalog c) AS catalog,
          (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.model_id) FROM model_pricing p) AS pricing,
          (SELECT value #>> '{}' FROM system_settings WHERE key='auto_dream_model') AS auto_dream`)).rows[0];
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
const rollbackBlock = async () => {
  const block = /-- BEGIN MANUAL ROLLBACK 0297[^\n]*\n(?:--[^\n]*\n){2}([\s\S]*?)-- END MANUAL ROLLBACK 0297/.exec(await readFile(SQL_0297, "utf8"))![1]!;
  return block.split("\n").map((line) => line.replace(/^-- ?/, "")).join("\n");
};

/**
 * The state production was in before 0297: 0296 applied, gpt-6.1-sol activated by the admin, users and
 * sessions rewritten by 0296, both retired models disabled. grokSelectable=false leaves grok-build as the
 * chain has it.
 */
async function productionLikeBefore0297(opts: { grokSelectable: boolean }) {
  await resetAndMigrateBefore("0296");
  const staged = (await query<{ entry_id: string; lock_version: number }>(
    "SELECT entry_id::text, lock_version FROM model_catalog WHERE model_id='gpt-6.1-sol' AND state='staged'")).rows[0]!;
  await query("SELECT fn_model_activate_entry($1::bigint,$2,NULL::bigint)", [staged.entry_id, staged.lock_version]);
  if (opts.grokSelectable) await makeGrokSelectable();
  const mm = await user("minimax@example.test", "MiniMax-M3");
  const touched = await user("touched@example.test", "MiniMax-M3");
  const own = await user("own-flash@example.test", "deepseek-v4-flash");
  const sol = await user("sol@example.test", "gpt-5.6-sol");
  await session("live-mm", mm, "MiniMax-M3");
  await session("used-mm", mm, "MiniMax-M3");
  await session("deleted-mm", mm, "MiniMax-M3", true);
  await session("own-flash", own, "deepseek-v4-flash");
  await session("live-sol", sol, "gpt-5.6-sol");
  assert.deepEqual((await runMigrations({ dir: await migrationsDirBefore("0297") })).applied,
    ["0296_commercial_retire_minimax_m3_gpt56_sol"]);
  for (const model of ["MiniMax-M3", "gpt-5.6-sol"]) await disable(model);
  // after 0296: one user changes another preference, one session gets a turn; both stay on the model 0296 gave them
  await query("UPDATE user_preferences SET prefs = jsonb_set(prefs,'{theme}','\"light\"'), updated_at = clock_timestamp() WHERE user_id=$1", [touched]);
  await query("UPDATE client_sessions SET updated_at = updated_at + 5000, message_count = 2 WHERE id='used-mm'");
  return { mm, touched, own, sol };
}
/** Production's grok-build: active, priced, public, no plan gate. */
async function makeGrokSelectable() {
  await query("UPDATE model_pricing SET enabled = TRUE, visibility = 'public', min_plan_code = NULL WHERE model_id='grok-build'");
  const row = (await query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM model_catalog c JOIN model_pricing p USING (model_id)
                     WHERE c.model_id='grok-build' AND c.state='active' AND p.enabled AND p.visibility='public'
                       AND p.min_plan_code IS NULL) AS ok`)).rows[0]!;
  assert.equal(row.ok, true, "grok-build must be selectable for this case");
}

describe("0297 points what used to name MiniMax-M3 at grok-build", () => {
  test("the seed agents' models and the requirement the full chain ends with agree", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    assert.ok(PLATFORM_SEED_AGENT_MODEL_IDS.includes("grok-build"), PLATFORM_SEED_AGENT_MODEL_IDS.join());
    assert.ok(!PLATFORM_SEED_AGENT_MODEL_IDS.includes("MiniMax-M3"));
    const req = await requirements();
    assert.ok(req.includes(GROK_REQ) && req.includes("deepseek-v4-flash:official_seed_agent"), req.join());
    assert.deepEqual((await runMigrations()).applied, []);
  });

  test("the upgrade moves only what 0296 put on deepseek-v4-flash and nobody touched since", { timeout: 180000 }, async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await productionLikeBefore0297({ grokSelectable: true });
    assert.deepEqual(await prefs(), {
      "minimax@example.test": "deepseek-v4-flash/dark", "touched@example.test": "deepseek-v4-flash/light",
      "own-flash@example.test": "deepseek-v4-flash/dark", "sol@example.test": "gpt-6.1-sol/dark" });
    assert.ok(!(await requirements()).includes(GROK_REQ));
    const before = await catalog();
    const sessionsBefore = await sessions();

    assert.deepEqual((await runMigrations()).applied, [NAME]);

    // no catalog or pricing row changes, and auto-dream stays where 0296 put it
    assert.deepEqual(await catalog(), before);
    assert.equal(before.auto_dream, "deepseek-v4-flash");
    assert.deepEqual(await prefs(), {
      "minimax@example.test": "grok-build/dark", "touched@example.test": "deepseek-v4-flash/light",
      "own-flash@example.test": "deepseek-v4-flash/dark", "sol@example.test": "gpt-6.1-sol/dark" });
    const after = await sessions();
    assert.match(after["live-mm"]!, /^grok-build@/);
    // a moved live session gets a newer updated_at so clients pick the change up
    assert.ok(Number(after["live-mm"]!.split("@")[1]) > Number(sessionsBefore["live-mm"]!.split("@")[1]));
    for (const id of ["used-mm", "deleted-mm", "own-flash", "live-sol"]) assert.equal(after[id], sessionsBefore[id], id);
    assert.deepEqual(await ledger(), [
      "client_sessions|live-mm|MiniMax-M3|grok-build",
      "client_sessions|live-sol|gpt-5.6-sol|gpt-6.1-sol",
      "client_sessions|used-mm|MiniMax-M3|deepseek-v4-flash",
      "runtime_requirement|default_codex_engine|gpt-5.6-sol|gpt-6-astra",
      "runtime_requirement|official_seed_agent|MiniMax-M3|grok-build",
      "system_setting|auto_dream_model|MiniMax-M3|deepseek-v4-flash",
      "user_preferences|minimax@example.test|MiniMax-M3|grok-build",
      "user_preferences|sol@example.test|gpt-5.6-sol|gpt-6.1-sol",
      "user_preferences|touched@example.test|MiniMax-M3|deepseek-v4-flash",
    ]);
    const req = await requirements();
    assert.ok(req.includes(GROK_REQ) && req.includes("deepseek-v4-flash:official_seed_agent"), req.join());
    // the guard now protects grok-build like any other required model
    await assert.rejects(disable("grok-build"), /required runtime models must remain active and priced: grok-build:official_seed_agent/);

    // a second application changes nothing
    const settled = [await prefs(), await sessions(), await requirements(), await ledger()];
    await query(await readFile(SQL_0297, "utf8"));
    assert.deepEqual([await prefs(), await sessions(), await requirements(), await ledger()], settled);

    // a stale client that still sends MiniMax-M3 is fenced to grok-build; gpt-5.6-sol still goes to gpt-6.1-sol
    const stale = await user("stale@example.test", "MiniMax-M3");
    await session("stale-mm", stale, "MiniMax-M3");
    await session("stale-sol", stale, "gpt-5.6-sol");
    await query("UPDATE client_sessions SET model_id='MiniMax-M3', updated_at=updated_at+1 WHERE id='own-flash'");
    assert.equal((await prefs())["stale@example.test"], "grok-build/dark");
    assert.deepEqual(await sessionModels(), { "live-mm": "grok-build", "used-mm": "deepseek-v4-flash", "deleted-mm": "MiniMax-M3",
      "own-flash": "grok-build", "live-sol": "gpt-6.1-sol", "stale-mm": "grok-build", "stale-sol": "gpt-6.1-sol" });
    assert.deepEqual(await normalize(), [
      "client_sessions|MiniMax-M3|grok-build|0|-",
      "client_sessions|gpt-5.6-sol|gpt-6.1-sol|0|-",
      "user_preferences|MiniMax-M3|grok-build|0|-",
      "user_preferences|gpt-5.6-sol|gpt-6.1-sol|0|-",
    ]);
  });

  test("while users cannot pick grok-build nothing of theirs is moved and the function says so", { timeout: 180000 }, async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await productionLikeBefore0297({ grokSelectable: false });
    await query("UPDATE model_pricing SET visibility = 'admin' WHERE model_id='grok-build'");
    const before = [await prefs(), await sessions(), (await ledger()).filter((r) => !r.startsWith("runtime_requirement"))];
    assert.deepEqual((await runMigrations()).applied, [NAME]);
    assert.deepEqual([await prefs(), await sessions(), (await ledger()).filter((r) => !r.startsWith("runtime_requirement"))], before);
    assert.deepEqual((await normalize()).filter((r) => r.includes("MiniMax-M3")), [
      "client_sessions|MiniMax-M3|grok-build|0|replacement_not_selectable",
      "user_preferences|MiniMax-M3|grok-build|0|replacement_not_selectable",
    ]);
    // the fence leaves a MiniMax-M3 write alone rather than send it to a model the user cannot pick
    const stale = await user("stale@example.test", "MiniMax-M3");
    assert.equal((await prefs())["stale@example.test"], "MiniMax-M3/dark");
    void stale;
  });

  test("the manual rollback in the header, then 0296 again, gives back the state 0296 left", { timeout: 180000 }, async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await productionLikeBefore0297({ grokSelectable: true });
    const before = { prefs: await prefs(), sessions: await sessionModels(), requirements: await requirements(), ledger: await ledger() };
    assert.deepEqual((await runMigrations()).applied, [NAME]);
    assert.notDeepEqual(await prefs(), before.prefs);

    await query(await rollbackBlock());
    await query(await readFile(SQL_0296, "utf8"));

    assert.deepEqual({ prefs: await prefs(), sessions: await sessionModels(), requirements: await requirements(), ledger: await ledger() }, before);
    // the 0296 bodies are back: a stale MiniMax-M3 write goes to deepseek-v4-flash again
    const stale = await user("stale@example.test", "MiniMax-M3");
    assert.equal((await prefs())["stale@example.test"], "deepseek-v4-flash/dark");
    void stale;
  });

  test("after 0297 the 0296 rollback still restores the pre-0296 values", { timeout: 180000 }, async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await productionLikeBefore0297({ grokSelectable: true });
    assert.deepEqual((await runMigrations()).applied, [NAME]);
    const sql = await readFile(SQL_0296, "utf8");
    const block = /-- BEGIN MANUAL ROLLBACK 0296[^\n]*\n([\s\S]*?)-- END MANUAL ROLLBACK 0296/.exec(sql)![1]!;
    await query(block.split("\n").map((line) => line.replace(/^-- ?/, "")).join("\n"));
    const p = await prefs();
    assert.equal(p["minimax@example.test"], "MiniMax-M3/dark");
    assert.equal(p["sol@example.test"], "gpt-5.6-sol/dark");
    // touched after 0296: the 0296 rollback leaves it, as it did before 0297
    assert.equal(p["touched@example.test"], "deepseek-v4-flash/light");
    const s = await sessionModels();
    assert.equal(s["live-mm"], "MiniMax-M3");
    assert.equal(s["live-sol"], "gpt-5.6-sol");
    const req = await requirements();
    assert.ok(!req.includes(GROK_REQ) && req.includes("MiniMax-M3:official_seed_agent"), req.join());
  });
});
