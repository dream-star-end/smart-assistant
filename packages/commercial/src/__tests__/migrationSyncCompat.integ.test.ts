import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { getPool } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { resetTestSchemaForTest, useDedicatedTestDatabase } from "./helpers/db.js";

const commercial = existsSync(new URL("../db/migrations/0340_commercial_sync_compat.sql", import.meta.url));
const version = commercial ? "0340_commercial_sync_compat" : "0341_selfhost_sync_compat";
assert.ok(existsSync(new URL(`../db/migrations/${version}.sql`, import.meta.url)), "exact target compatibility migration is required");
assert.equal(existsSync(new URL(`../db/migrations/${commercial ? '0341_selfhost_sync_compat' : '0340_commercial_sync_compat'}.sql`, import.meta.url)), false, "never union divergent migration histories");
const db = useDedicatedTestDatabase(commercial ? "ocv5_763_commercial_sync_test" : "ocv5_763_selfhost_sync_test");
const migrations = fileURLToPath(new URL("../db/migrations/", import.meta.url));
const baseline = JSON.parse(await readFile(new URL(`./fixtures/${commercial ? "commercial" : "selfhost"}SyncBaseline.json`, import.meta.url), "utf8")) as {
  migrations: Record<string, string>;
  studioColumns?: Array<Record<string, unknown>>;
  columns: Array<{ table_name: string; column_name: string; ordinal_position: number; data_type: string; is_nullable: string; column_default: string | null }>;
};
const tables = commercial ? ["remote_agent_nodes", "remote_agent_profiles", "remote_model_offers", "remote_agent_bindings",
  "remote_native_threads", "remote_native_turns", "remote_driver_verification_runs", "system_action_receipts"] : [
  "studio_annotations", "studio_assets", "studio_blob_refs", "studio_blobs", "studio_charges", "studio_events",
  "studio_lines", "studio_music_catalog", "studio_projects", "studio_quota", "studio_quota_holds", "studio_shots",
  "studio_step_results", "studio_takes", "studio_tasks", "studio_user_tracks",
];
async function assertAdditions() {
  const p = getPool();
  for (const name of tables) {
    assert.equal((await p.query("SELECT to_regclass($1)::text AS name", [name])).rows[0].name, name);
    assert.equal((await p.query(`SELECT COUNT(*)::int AS n FROM ${name}`)).rows[0].n, 0, `${name}: migration must not import accounts or user data`);
  }
  const columns = (await p.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public'`)).rows.map(r => `${r.table_name}.${r.column_name}`);
  for (const key of commercial ? ["authority_turn_dispatches.turn_key", "turn_dispatches.turn_key", "refresh_tokens.client_ip",
    "model_catalog.placement", "model_catalog.pool_auto_disabled", "remote_agent_profiles.max_concurrent_lanes",
    "remote_agent_profiles.driver_id", "remote_agent_bindings.remote_protocol_version", "remote_native_turns.semantic_digest"] : ["muse_media_jobs.price_credits", "muse_media_jobs.cost_credits",
      "muse_media_jobs.debited_credits", "muse_media_jobs.price_snapshot", "muse_media_jobs.ledger_id"]) {
    assert.ok(columns.includes(key), key);
  }
}
async function strategySnapshot() {
  const p = getPool();
  const catalog = (await p.query(`SELECT ${commercial ? "to_jsonb(m) - 'placement' - 'pool_auto_disabled'" : "to_jsonb(m)"} AS row
    FROM model_catalog m ORDER BY entry_id`)).rows;
  const pricing = (await p.query("SELECT to_jsonb(p) AS row FROM model_pricing p ORDER BY model_id")).rows;
  const users = (await p.query("SELECT id::text,credits::text FROM users ORDER BY id")).rows;
  return { catalog, pricing, users };
}

test(`${version} empty database runs the real migration chain and creates only empty compatibility tables`, async (t) => {
  if (db.skipIfUnavailable(t)) return;
  // useDedicatedTestDatabase runs migrate.ts on a new template0 database, not a hand-built schema.
  assert.equal((await getPool().query("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")).rows[0].version, version);
  await assertAdditions();
  const again = await runMigrations();
  assert.equal(again.applied.length, 0, "runner re-entry must be idempotent");
});

test(`${version} upgrades the exact live target versions and schema without changing prices, balances or model state`, async (t) => {
  if (db.skipIfUnavailable(t)) return;
  const dir = await mkdtemp(path.join(tmpdir(), "ocv5-763-target-baseline-"));
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
      AND table_name = ANY($1::text[])
      ORDER BY table_name,ordinal_position`, [commercial
        ? ['authority_turn_dispatches','turn_dispatches','refresh_tokens','model_catalog']
        : ['credit_ledger','muse_media_jobs']])).rows;
    assert.deepEqual(shape, baseline.columns, "upgrade fixture must match the observed live affected-table schema");
    const before = await strategySnapshot();
    const result = await runMigrations();
    assert.deepEqual(result.applied, [version]);
    assert.deepEqual(await strategySnapshot(), before, "DDL must not change commercial policy or money");
    await assertAdditions();
    if (!commercial) {
      await assertSelfhostLegacyWriters();
      const studioShape = (await getPool().query(`SELECT table_name,column_name,ordinal_position,data_type,is_nullable,column_default
        FROM information_schema.columns WHERE table_schema='public' AND table_name = ANY($1::text[])
        ORDER BY table_name,ordinal_position`, [tables])).rows;
      assert.deepEqual(studioShape, baseline.studioColumns, "empty Studio schema matches the frozen commercial contract");
      return;
    }
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

async function assertSelfhostLegacyWriters() {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const uid = (await client.query("INSERT INTO users(email,password_hash,credits) VALUES ($1,'stub',1000) RETURNING id", [`sync-${randomUUID()}@test.local`])).rows[0].id;
    // Existing binaries omit every added billing field; no quote or charge is invented.
    const jobId = `mj_${randomUUID()}`;
    const job = (await client.query(`INSERT INTO muse_media_jobs(id,user_id,kind,prompt_sha256,prompt_preview,params,status)
      VALUES ($1,$2,'video',$3,'legacy','{}','queued') RETURNING price_credits,cost_credits,debited_credits,price_snapshot,ledger_id`,
      [jobId, uid, Buffer.alloc(32)])).rows[0];
    assert.deepEqual(Object.values(job), [null, null, null, null, null]);
    for (const reason of ['topup','chat','agent_chat','agent_subscription','refund','admin_adjust','promotion',
      'minimax_media','image_generation','subscription','subscription_expire','pack','muse_media','media_studio']) {
      await client.query("INSERT INTO credit_ledger(user_id,delta,balance_after,reason) VALUES ($1,0,1000,$2)", [uid, reason]);
    }
    await client.query("SAVEPOINT invalid_reason");
    await assert.rejects(client.query("INSERT INTO credit_ledger(user_id,delta,balance_after,reason) VALUES ($1,0,1000,'not_a_reason')", [uid]), { code: '23514' });
    await client.query("ROLLBACK TO SAVEPOINT invalid_reason");
    await client.query("SAVEPOINT unfinished_charge");
    await assert.rejects(client.query("UPDATE muse_media_jobs SET cost_credits=1 WHERE id=$1", [jobId]), { code: '23514' });
    await client.query("ROLLBACK TO SAVEPOINT unfinished_charge");
    await client.query("UPDATE muse_media_jobs SET status='succeeded',cost_credits=0 WHERE id=$1", [jobId]);
    assert.equal((await client.query("SELECT credits::text FROM users WHERE id=$1", [uid])).rows[0].credits, '1000');
  } finally { await client.query("ROLLBACK"); client.release(); }
}
