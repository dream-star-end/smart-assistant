/**
 * 0274 desktop_tunnel_owners schema.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit --test-concurrency=1 --test-timeout=180000 \
 *    packages/commercial/src/__tests__/migration0274.integ.test.ts'
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { query } from "../db/queries.js";
import { splitSqlStatements } from "../db/migrate.js";
import { useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("desktop_owners_0274_test");
const here = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.resolve(here, "../db/migrations/0274_desktop_tunnel_owners.sql");

describe("0274 desktop_tunnel_owners", () => {
  test("SQL is fail-loud: no IF NOT EXISTS on CREATE TABLE, has preflight", async () => {
    const sql = await readFile(sqlPath, "utf8");
    assert.match(sql, /order-dependency:\s*none/);
    assert.match(sql, /RAISE EXCEPTION '0274 fail-loud/);
    assert.doesNotMatch(sql, /CREATE TABLE IF NOT EXISTS desktop_tunnel_owners/i);
    const stmts = splitSqlStatements(sql);
    assert.ok(stmts.length >= 2, `expected preflight + DDL, got ${stmts.length}`);
  });

  test("table, PK, instance index, and owned_elsewhere audit event apply", async (t) => {
    if (db.skipIfUnavailable(t)) return;

    const tbl = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM information_schema.tables
        WHERE table_schema='public' AND table_name='desktop_tunnel_owners'`,
    );
    assert.equal(tbl.rows[0]!.n, "1");

    const cols = await query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name='desktop_tunnel_owners'
        ORDER BY ordinal_position`,
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const col of [
      "agent_container_id", "instance_id", "instance_addr",
      "attached_at", "last_heartbeat_at", "generation", "owner_epoch",
    ]) {
      assert.ok(names.includes(col), `missing ${col}`);
    }
    assert.equal(cols.rows.find((r) => r.column_name === "agent_container_id")?.is_nullable, "NO");

    const pk = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM pg_constraint
        WHERE conrelid = 'desktop_tunnel_owners'::regclass AND contype = 'p'`,
    );
    assert.equal(pk.rows[0]!.n, "1");

    const idx = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = 'desktop_tunnel_owners_instance_id'`,
    );
    assert.equal(idx.rows[0]!.n, "1");

    const u = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash) VALUES ($1,'x') RETURNING id::text`,
      [`own-0274-${Date.now()}@t.local`],
    );
    const uid = u.rows[0]!.id;
    await query(
      `INSERT INTO desktop_device_audit(user_id, event, extra)
       VALUES ($1,'desktop_owned_elsewhere','{}'::jsonb)`,
      [uid],
    );
    await assert.rejects(
      () => query(
        `INSERT INTO desktop_device_audit(user_id, event, extra)
         VALUES ($1,'not_a_real_event','{}'::jsonb)`,
        [uid],
      ),
      /desktop_device_audit_event_check|violates check constraint/i,
    );
  });
});
