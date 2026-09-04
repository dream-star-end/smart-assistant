import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
const REQUIRE_TEST_DB = process.env.CI === "true" || process.env.REQUIRE_TEST_DB === "1";
const SCHEMA = "oc_migration0255_test";
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, "../db/migrations/0255_desktop_kind_unique_index.sql");

let pool: Pool;
let pgAvailable = false;

before(async () => {
  const probe = new Pool({ connectionString: TEST_DB_URL, max: 1, connectionTimeoutMillis: 1500 });
  try {
    await probe.query("SELECT 1");
    pgAvailable = true;
  } catch {
    if (REQUIRE_TEST_DB) throw new Error("Postgres test fixture required");
  } finally {
    await probe.end().catch(() => undefined);
  }
  if (!pgAvailable) return;
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  await admin.end();
  pool = new Pool({ connectionString: TEST_DB_URL, max: 1, options: `-c search_path=${SCHEMA}` });
  await pool.query(`
    CREATE TABLE agent_containers (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      runtime_channel TEXT NOT NULL,
      runtime_kind TEXT NOT NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
});

after(async () => {
  if (!pgAvailable) return;
  await pool.end();
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
});

function maybe(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!pgAvailable) return t.skip("Postgres unavailable");
    await fn();
  });
}

async function run0255Sql(sql: string): Promise<void> {
  const doBlock = /DO \$\$[\s\S]*?END \$\$;/.exec(sql);
  const create = /CREATE UNIQUE INDEX CONCURRENTLY[\s\S]*?;/.exec(sql);
  if (!doBlock || !create) throw new Error("0255 sql shape changed");
  await pool.query(doBlock[0]);
  await pool.query(create[0]);
}

describe("0255_desktop_kind_unique_index fail-loud", () => {
  test("omits IF NOT EXISTS and preflights invalid indexes", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    assert.match(sql, /^-- no-transaction\b/m);
    assert.match(sql, /indisvalid=false/);
    assert.doesNotMatch(sql.replace(/^--.*$/gm, ""), /IF NOT EXISTS/);
  });

  maybe("invalid same-name index fails loud and is not recorded in the ledger", async () => {
    await pool.query(`
      INSERT INTO agent_containers(user_id, runtime_channel, runtime_kind, state) VALUES
        (1,'v5','desktop','active'),
        (1,'v5','desktop','active')
    `);
    await assert.rejects(
      pool.query(
        "CREATE UNIQUE INDEX CONCURRENTLY uniq_ac_user_channel_kind_active ON agent_containers (user_id, runtime_channel, runtime_kind) WHERE state = 'active'",
      ),
      /could not create unique index|duplicate key/,
    );
    const invalid = await pool.query<{ indisvalid: boolean }>(`
      SELECT i.indisvalid
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
       WHERE c.relnamespace=current_schema()::regnamespace
         AND c.relname='uniq_ac_user_channel_kind_active'
    `);
    assert.equal(invalid.rows[0]?.indisvalid, false);

    const sql = await readFile(MIGRATION, "utf8");
    await assert.rejects(() => run0255Sql(sql), /0255 fail-loud/);
    const ledger = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = '0255_desktop_kind_unique_index'",
    );
    assert.equal(ledger.rows.length, 0);

    await pool.query("DROP INDEX CONCURRENTLY uniq_ac_user_channel_kind_active");
    await pool.query("DELETE FROM agent_containers");
    await pool.query(`
      INSERT INTO agent_containers(user_id, runtime_channel, runtime_kind, state)
      VALUES (1,'v5','desktop','active')
    `);
    await run0255Sql(sql);
    const valid = await pool.query<{ indisvalid: boolean }>(`
      SELECT i.indisvalid
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
       WHERE c.relnamespace=current_schema()::regnamespace
         AND c.relname='uniq_ac_user_channel_kind_active'
    `);
    assert.equal(valid.rows[0]?.indisvalid, true);
    // Mirror migrate.ts no-transaction success path: ledger INSERT happens only
    // after every statement succeeds. Fail path above stays 0 rows; success is 1.
    await pool.query(
      "INSERT INTO schema_migrations(version) VALUES ($1)",
      ["0255_desktop_kind_unique_index"],
    );
    const successLedger = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = '0255_desktop_kind_unique_index'",
    );
    assert.equal(successLedger.rows.length, 1);
  });
});
