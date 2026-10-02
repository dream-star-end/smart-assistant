/**
 * Commercial 0283 history must be replayable AND upgrade the real operator
 * ledger without weakening migration integrity. Only dedicated test DBs.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { getPool } from "../db/index.js";
import { MigrationIntegrityError, runMigrations } from "../db/migrate.js";
import { query } from "../db/queries.js";
import { resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("models_0283_operator_history_test");
const migrationDir = fileURLToPath(new URL("../db/migrations/", import.meta.url));
const operatorPath = fileURLToPath(new URL("../../../../ops/ocv5-308/history/0283_cursor_gpt56_luna_sand.operator.sql", import.meta.url));
const version = "0283_cursor_gpt56_luna_sand";
const efforts = ["low", "medium", "high", "xhigh", "max"];
const ids = efforts.flatMap(e => ["cursor-gpt-5.6-luna-" + e, "cursor-gpt-5.6-luna-" + e + "-fast"]).sort();

async function family() {
  const result = await query<Record<string, unknown>>(
    "SELECT c.model_id,c.engine,c.provider_id,c.upstream_model_id,c.context_window,c.capability_profile,c.capability_schema_version,c.state,p.display_name,p.input_per_mtok::text,p.output_per_mtok::text,p.cache_read_per_mtok::text,p.cache_write_per_mtok::text,p.multiplier::text,p.enabled,p.visibility,p.min_plan_code,p.default_effort,p.extra_system_prompt,p.sort_order,p.lock_version FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE c.model_id LIKE 'cursor-gpt-5.6-luna-%' ORDER BY c.model_id"
  );
  return result.rows;
}

async function assertFamily() {
  const rows = await family();
  assert.deepEqual(rows.map(r => r.model_id), ids);
  const donor = (await query<Record<string, unknown>>("SELECT c.*,p.cache_write_per_mtok::text,p.extra_system_prompt FROM model_catalog c JOIN model_pricing p USING(model_id) WHERE model_id='cursor-gemini-3.8-flash-high' AND c.state='active'")).rows[0]!;
  const luna = (await query<Record<string, unknown>>("SELECT cache_write_per_mtok::text FROM model_pricing WHERE model_id='gpt-5.6-luna'")).rows[0]!;
  for (const r of rows) {
    assert.equal(r.engine, "cursor");
    assert.equal(r.upstream_model_id, String(r.model_id).slice(7));
    for (const k of ["provider_id", "context_window", "capability_profile", "capability_schema_version"]) assert.deepEqual(r[k], donor[k]);
    assert.equal(r.state, "active");
    assert.equal(r.enabled, true);
    assert.equal(r.visibility, "public");
    assert.equal(r.min_plan_code, null);
    assert.equal(r.default_effort, null);
    assert.equal(r.extra_system_prompt, donor.extra_system_prompt);
    assert.equal(r.sort_order, 10002);
    assert.equal(r.input_per_mtok, "74");
    assert.equal(r.output_per_mtok, "444");
    assert.equal(r.cache_read_per_mtok, "7");
    assert.equal(r.cache_write_per_mtok, luna.cache_write_per_mtok);
    assert.equal(Number(r.multiplier), String(r.model_id).endsWith("-fast") ? 2 : 1);
  }
  assert.equal((await query("SELECT 1 FROM model_visibility_grants WHERE model_id LIKE 'cursor-gpt-5.6-luna-%'")).rowCount, 0);
  assert.equal((await query("SELECT 1 FROM schema_migrations WHERE version=$1", [version])).rowCount, 1);
  return rows;
}

describe("commercial 0283 normal-runner historical representation", () => {
  test("empty dedicated DB full normal chain creates real Luna family and one ledger entry", async t => {
    if (db.skipIfUnavailable(t)) return;
    await assertFamily();
    const replay = await runMigrations();
    assert.deepEqual(replay.applied, []);
    assert.ok(replay.skipped.includes(version));
  });

  test("original operator applied DB: old directory rejects; new normal runner upgrades preserving family", { timeout: 180000 }, async t => {
    if (db.skipIfUnavailable(t)) return;
    await resetAndMigrateBefore("0283");
    await query("INSERT INTO users(id,email,email_verified,password_hash,role) VALUES (1,'operator-history@example.test',true,'test-fixture-only','admin')");
    const original = await readFile(operatorPath, "utf8");
    assert.equal(createHash("sha256").update(original).digest("hex"), "e4cc41f6b4853aab5000ab1aedf9ca8fda9f48d4a05082159e5d5d313a1bce45");
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(original);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally { client.release(); }
    const before = await assertFamily();
    const oldDir = await mkdtemp(path.join(tmpdir(), "oc-0283-old-dir-"));
    try {
      for (const f of await readdir(migrationDir)) if (f.endsWith(".sql") && f !== version + ".sql") await symlink(path.join(migrationDir, f), path.join(oldDir, f));
      await assert.rejects(runMigrations({dir: oldDir}), e => e instanceof MigrationIntegrityError && /applied migration\(s\) missing from dir: 0283_cursor_gpt56_luna_sand/.test(e.message));
      const result = await runMigrations();
      assert.ok(result.skipped.includes(version));
      assert.ok(result.applied.includes("0285_content_review_strikes"));
      assert.deepEqual(await assertFamily(), before);
      assert.equal((await query("SELECT 1 FROM admin_audit WHERE action='model_catalog.activate' AND target='cursor-gpt-5.6-luna-*'")).rowCount, 1);
    } finally { await rm(oldDir, {recursive:true,force:true}); }
  });

  test("normal representation rejects a drifted complete family without modifying it", async t => {
    if (db.skipIfUnavailable(t)) return;
    await runMigrations();
    await assertFamily();
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      assert.equal((await client.query("UPDATE model_pricing SET min_plan_code='lite' WHERE model_id='cursor-gpt-5.6-luna-low'")).rowCount, 1);
      const sql = await readFile(path.join(migrationDir,version+".sql"),"utf8");
      await assert.rejects(client.query(sql), /semantic drift/);
    } finally { await client.query("ROLLBACK"); client.release(); }
    await assertFamily();
  });
});
