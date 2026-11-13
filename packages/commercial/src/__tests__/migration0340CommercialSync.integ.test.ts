import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { getPool } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { resetTestSchemaForTest, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("ocv5_763_commercial_sync_test");
const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
const version = "0340_commercial_sync_compat";
const baseline = JSON.parse(await readFile(new URL("./fixtures/commercialSyncBaseline.json", import.meta.url), "utf8")) as {
  migrations: Record<string, string>;
  columns: Array<{ table_name: string; column_name: string; ordinal_position: number; data_type: string; is_nullable: string; column_default: string | null }>;
};
const tables = ["remote_agent_nodes", "remote_agent_profiles", "remote_model_offers", "remote_agent_bindings",
  "remote_native_threads", "remote_native_turns", "remote_driver_verification_runs", "system_action_receipts"];
async function assertAdditions() {
  const p = getPool();
  for (const name of tables) {
    assert.equal((await p.query("SELECT to_regclass($1)::text AS name", [name])).rows[0].name, name);
    assert.equal((await p.query(`SELECT COUNT(*)::int AS n FROM ${name}`)).rows[0].n, 0, `${name}: migration must not import accounts or user data`);
  }
  const columns = (await p.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public'`)).rows.map(r => `${r.table_name}.${r.column_name}`);
  for (const key of ["authority_turn_dispatches.turn_key", "turn_dispatches.turn_key", "refresh_tokens.client_ip",
    "model_catalog.placement", "model_catalog.pool_auto_disabled", "remote_agent_profiles.max_concurrent_lanes",
    "remote_agent_profiles.driver_id", "remote_agent_bindings.remote_protocol_version", "remote_native_turns.semantic_digest"]) {
    assert.ok(columns.includes(key), key);
  }
}
async function strategySnapshot() {
  const p = getPool();
  const catalog = (await p.query(`SELECT to_jsonb(m) - 'placement' - 'pool_auto_disabled' AS row
    FROM model_catalog m ORDER BY entry_id`)).rows;
  const pricing = (await p.query("SELECT to_jsonb(p) AS row FROM model_pricing p ORDER BY model_id")).rows;
  const users = (await p.query("SELECT id::text,credits::text FROM users ORDER BY id")).rows;
  return { catalog, pricing, users };
}

test("0340 empty database runs the real migration chain and creates only empty compatibility tables", async (t) => {
  if (db.skipIfUnavailable(t)) return;
  // useDedicatedTestDatabase runs migrate.ts on a new template0 database, not a hand-built schema.
  assert.equal((await getPool().query("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")).rows[0].version, version);
  await assertAdditions();
  const again = await runMigrations();
  assert.equal(again.applied.length, 0, "runner re-entry must be idempotent");
});

test("0340 upgrades the exact live commercial versions and schema without changing prices, balances or model state", async (t) => {
  if (db.skipIfUnavailable(t)) return;
  const dir = await mkdtemp(path.join(tmpdir(), "ocv5-763-commercial-baseline-"));
  try {
    const expected = Object.keys(baseline.migrations).sort();
    const files = (await readdir(migrations)).filter(f => f.endsWith(".sql")).sort();
    assert.deepEqual(files.map(f => f.slice(0, -4)), [...expected, version]);
    for (const v of expected) {
      const data = await readFile(path.join(migrations, `${v}.sql`));
      const blob = createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
      assert.equal(blob, baseline.migrations[v], `${v}: applied SQL bytes must stay immutable`);
      await copyFile(path.join(migrations, `${v}.sql`), path.join(dir, `${v}.sql`));
    }
    await resetTestSchemaForTest();
    await runMigrations({ dir });
    const applied = (await getPool().query("SELECT version FROM schema_migrations ORDER BY version")).rows.map(r => r.version);
    assert.deepEqual(applied, expected, "real runner must establish the exact production version set");
    const shape = (await getPool().query(`SELECT table_name,column_name,ordinal_position,data_type,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema='public'
      AND table_name IN ('authority_turn_dispatches','turn_dispatches','refresh_tokens','model_catalog')
      ORDER BY table_name,ordinal_position`)).rows;
    assert.deepEqual(shape, baseline.columns, "upgrade fixture must match the observed live affected-table schema");
    const before = await strategySnapshot();
    const result = await runMigrations();
    assert.deepEqual(result.applied, [version]);
    assert.deepEqual(await strategySnapshot(), before, "DDL must not change commercial policy or money");
    await assertAdditions();
    const defaults = await getPool().query("SELECT COUNT(*)::int AS n FROM model_catalog WHERE placement <> 'local' OR pool_auto_disabled");
    assert.equal(defaults.rows[0].n, 0);
    // Real CAS/state guards remain active after replacing the two function bodies.
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query("SELECT entry_id,lock_version FROM model_catalog WHERE state='active' ORDER BY entry_id LIMIT 1")).rows[0];
      assert.ok(row, "baseline has active catalog entries");
      await client.query("SAVEPOINT invalid_cas");
      await assert.rejects(client.query("SELECT fn_model_disable_entry($1,$2,NULL)", [row.entry_id, row.lock_version + 100]), { code: "40001" });
      await client.query("ROLLBACK TO SAVEPOINT invalid_cas");
      await client.query("SELECT fn_model_disable_entry($1,$2,NULL)", [row.entry_id, row.lock_version]);
      const disabled = (await client.query("SELECT state,lock_version,pool_auto_disabled FROM model_catalog WHERE entry_id=$1", [row.entry_id])).rows[0];
      assert.equal(disabled.state, "disabled");
      assert.equal(disabled.pool_auto_disabled, false);
      await client.query("SELECT fn_model_activate_entry($1,$2,NULL)", [row.entry_id, disabled.lock_version]);
      assert.equal((await client.query("SELECT state FROM model_catalog WHERE entry_id=$1", [row.entry_id])).rows[0].state, "active");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
