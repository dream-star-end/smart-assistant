import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { getPool } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { query } from "../db/queries.js";
import { migrationsDirBefore, resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("commercial_box_api_context_1m_0298_test");
const sqlPath = fileURLToPath(new URL("../db/migrations/0298_commercial_box_api_context_1m.sql", import.meta.url));
const OPUS = "box-api-claude-opus-5-5";
const SONNET = "box-api-claude-sonnet-5-5";
const HAIKU = "box-api-claude-haiku-4-5";
const BOX = [OPUS, SONNET, HAIKU];

async function snapshot() {
  return (await query(
    `SELECT (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.entry_id) FROM model_catalog c WHERE NOT(c.model_id=ANY($1::text[]))) AS catalog,
            (SELECT jsonb_agg(to_jsonb(p) - 'updated_at' - 'lock_version' ORDER BY p.model_id) FROM model_pricing p) AS pricing,
            (SELECT jsonb_agg(to_jsonb(gm) ORDER BY gm.group_id,gm.model_id) FROM account_group_models gm) AS bindings`,
    [BOX])).rows[0];
}
async function live(model: string) {
  const rows = (await query(
    "SELECT * FROM model_catalog WHERE model_id=$1 AND state IN ('staged','active','disabled')", [model])).rows;
  assert.equal(rows.length, 1, model);
  return rows[0]!;
}
async function entries(model: string) {
  return (await query("SELECT state, context_window FROM model_catalog WHERE model_id=$1 ORDER BY entry_id", [model])).rows;
}
async function activateAll() {
  for (const model of BOX) {
    const row = await live(model);
    await query("SELECT fn_model_activate_entry($1::bigint,$2,NULL::bigint)", [String(row.entry_id), row.lock_version]);
  }
}
const rollbackBlock = async () => {
  const block = /-- BEGIN TESTED MANUAL ROLLBACK 0298\n([\s\S]*?)-- END TESTED MANUAL ROLLBACK 0298/.exec(await readFile(sqlPath, "utf8"))![1]!;
  return block.split("\n").map((line) => line.replace(/^-- ?/, "")).join("\n");
};
const runSql = async () => query(await readFile(sqlPath, "utf8"));

describe("0298 sets the Box route's Opus 5.5 and Sonnet 5.5 to a 1M window and leaves Haiku at 200k", () => {
  test("the full chain ends with staged 1M rows for Opus and Sonnet, 200k for Haiku", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    assert.deepEqual(
      await Promise.all(BOX.map(async (m) => { const r = await live(m); return [m, r.state, r.context_window]; })),
      [[OPUS, "staged", 1000000], [SONNET, "staged", 1000000], [HAIKU, "staged", 200000]]);
    assert.deepEqual((await runMigrations()).applied, []);
  });

  test("on the state production has (active rows) it switches versions, keeps state and price, retires the old entry", { timeout: 240000 }, async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0298");
    await activateAll();
    const before = await snapshot();
    const priceBefore = (await query("SELECT to_jsonb(p) - 'updated_at' - 'lock_version' AS p FROM model_pricing p WHERE model_id=ANY($1::text[]) ORDER BY model_id", [BOX])).rows;
    const haikuBefore = await live(HAIKU);
    assert.deepEqual((await runMigrations()).applied, ["0298_commercial_box_api_context_1m"]);
    for (const model of [OPUS, SONNET]) {
      const now = await live(model);
      assert.equal(now.state, "active", model);
      assert.equal(now.context_window, 1000000, model);
      assert.deepEqual((await entries(model)).map((e) => e.state), ["retired", "active"], model);
      assert.equal((await entries(model))[0]!.context_window, 200000, model);
    }
    assert.deepEqual(await live(HAIKU), haikuBefore);
    assert.deepEqual((await query("SELECT to_jsonb(p) - 'updated_at' - 'lock_version' AS p FROM model_pricing p WHERE model_id=ANY($1::text[]) ORDER BY model_id", [BOX])).rows, priceBefore);
    assert.equal((await query("SELECT 1 FROM model_pricing WHERE model_id=ANY($1::text[]) AND NOT enabled", [BOX])).rowCount, 0);
    assert.deepEqual(await snapshot(), before);
    // a second run changes nothing
    const client = await getPool().connect();
    try { await client.query(await readFile(sqlPath, "utf8")); } finally { client.release(); }
    assert.deepEqual((await entries(OPUS)).map((e) => e.state), ["retired", "active"]);
  });

  test("a disabled row comes back staged: still unavailable", { timeout: 240000 }, async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0298");
    await activateAll();
    const row = await live(OPUS);
    await query("SELECT fn_model_disable_entry($1::bigint,$2,NULL::bigint)", [String(row.entry_id), row.lock_version]);
    await runMigrations();
    const now = await live(OPUS);
    assert.equal(now.state, "staged");
    assert.equal(now.context_window, 1000000);
    assert.equal((await query("SELECT enabled FROM model_pricing WHERE model_id=$1", [OPUS])).rows[0]!.enabled, false);
  });

  test("an unexpected window fails closed and changes nothing", { timeout: 240000 }, async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0298");
    await query("UPDATE model_catalog SET context_window=300000 WHERE model_id=$1", [SONNET]);
    await assert.rejects(runMigrations(), /unexpected context_window 300000/);
    assert.equal((await live(OPUS)).context_window, 200000);
    assert.equal((await live(SONNET)).context_window, 300000);
  });

  test("the rollback block puts 200000 back on active and on staged rows", { timeout: 240000 }, async (t) => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0298");
    await activateAll();
    await runMigrations();
    await query(await rollbackBlock());
    for (const model of [OPUS, SONNET]) {
      const now = await live(model);
      assert.equal(now.state, "active", model);
      assert.equal(now.context_window, 200000, model);
    }
    assert.equal((await live(HAIKU)).context_window, 200000);
    // staged rows (a fresh database)
    await resetAndMigrateBefore("0299");
    await query(await rollbackBlock());
    for (const model of [OPUS, SONNET]) assert.equal((await live(model)).context_window, 200000, model);
    await runSql();
    for (const model of [OPUS, SONNET]) assert.equal((await live(model)).context_window, 1000000, model);
  });
});
