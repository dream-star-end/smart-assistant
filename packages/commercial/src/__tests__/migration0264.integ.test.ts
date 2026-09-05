/**
 * 0254–0257 desktop virtual container schema.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit packages/commercial/src/__tests__/migration0254.integ.test.ts'
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { query } from "../db/queries.js";
import { splitSqlStatements } from "../db/migrate.js";
import { resetAndMigrateBefore, useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("desktop_virtual_container_0254_test");
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../db/migrations");
const metadataPath = path.resolve(here, "../../../../deploy/v5/release-metadata.json");

const HASH32 = "00".repeat(32);

async function insertUser(email: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash) VALUES ($1, 'x') RETURNING id::text`,
    [email],
  );
  return r.rows[0]!.id;
}

describe("splitSqlStatements (0256 preflight + CONCURRENTLY)", () => {
  test("does not split dollar-quoted DO bodies and yields two 0256 statements", async () => {
    const sql = await readFile(
      path.join(migrationsDir, "0266_drop_user_channel_active.sql"),
      "utf8",
    );
    const stmts = splitSqlStatements(sql);
    assert.equal(stmts.length, 2);
    assert.match(stmts[0]!, /uniq_ac_user_channel_kind_active/);
    assert.match(stmts[0]!, /RAISE EXCEPTION/);
    assert.match(stmts[1]!, /DROP INDEX CONCURRENTLY IF EXISTS uniq_ac_user_channel_active/i);
    assert.doesNotMatch(stmts[1]!, /DO \$\$/);
  });

  test("0255 fail-loud preflight + CONCURRENTLY are two statements", async () => {
    const sql = await readFile(
      path.join(migrationsDir, "0265_desktop_kind_unique_index.sql"),
      "utf8",
    );
    const stmts = splitSqlStatements(sql);
    assert.equal(stmts.length, 2);
    assert.match(stmts[0]!, /indisvalid=false/);
    assert.match(stmts[0]!, /RAISE EXCEPTION/);
    assert.match(stmts[1]!, /CREATE UNIQUE INDEX CONCURRENTLY/i);
    assert.doesNotMatch(stmts[1]!, /IF NOT EXISTS/i);
  });
});

describe("0254–0257 desktop virtual container apply", () => {
  test("full migrate apply plus replay from before 0254", async (t) => {
    if (db.skipIfUnavailable(t)) return;

    const kindCol = await query<{ column_default: string | null; is_nullable: string }>(
      `SELECT column_default, is_nullable
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='agent_containers' AND column_name='runtime_kind'`,
    );
    assert.equal(kindCol.rows.length, 1);
    assert.equal(kindCol.rows[0]!.is_nullable, "NO");
    assert.match(kindCol.rows[0]!.column_default ?? "", /docker/);

    for (const col of ["issued_by_host_uuid", "session_secret_expires_at", "update_required"]) {
      const r = await query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM information_schema.columns
          WHERE table_schema='public' AND table_name='agent_containers' AND column_name=$1`,
        [col],
      );
      assert.equal(r.rows[0]!.n, "1", `missing agent_containers.${col}`);
    }

    const check = await query<{ consrc: string | null }>(
      `SELECT pg_get_constraintdef(oid) AS consrc
         FROM pg_constraint
        WHERE conname='agent_containers_runtime_kind_check'`,
    );
    assert.match(check.rows[0]?.consrc ?? "", /docker/);
    assert.match(check.rows[0]?.consrc ?? "", /desktop/);

    const tables = await query<{ relname: string }>(
      `SELECT relname FROM pg_class
        WHERE relname IN ('desktop_enrollments','desktop_devices','desktop_device_audit')
          AND relkind='r'
        ORDER BY relname`,
    );
    assert.deepEqual(
      tables.rows.map((r) => r.relname),
      ["desktop_device_audit", "desktop_devices", "desktop_enrollments"],
    );

    const liveIdx = await query<{ def: string }>(
      `SELECT pg_get_indexdef(indexrelid) AS def
         FROM pg_index
        WHERE indexrelid='desktop_devices_one_live_per_user'::regclass`,
    );
    assert.match(liveIdx.rows[0]?.def ?? "", /UNIQUE INDEX/);
    assert.match(liveIdx.rows[0]?.def ?? "", /revoked_at IS NULL/);

    const tableLevelPartial = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM pg_constraint
        WHERE conrelid='desktop_devices'::regclass
          AND contype='u'`,
    );
    assert.equal(tableLevelPartial.rows[0]!.n, "0", "B-05: no table-level UNIQUE on desktop_devices");

    const kindIdx = await query<{ def: string }>(
      `SELECT pg_get_indexdef(indexrelid) AS def
         FROM pg_index
        WHERE indexrelid='uniq_ac_user_channel_kind_active'::regclass`,
    );
    assert.match(kindIdx.rows[0]?.def ?? "", /runtime_kind/);
    assert.match(kindIdx.rows[0]?.def ?? "", /runtime_channel/);

    const oldIdx = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pg_class WHERE relname='uniq_ac_user_channel_active'`,
    );
    assert.equal(oldIdx.rows[0]!.n, "0", "0256 must drop uniq_ac_user_channel_active");

    const tdCols = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='turn_dispatches'
          AND column_name IN ('agent_container_id','runtime_kind')
        ORDER BY column_name`,
    );
    assert.deepEqual(
      tdCols.rows.map((r) => r.column_name),
      ["agent_container_id", "runtime_kind"],
    );

    const uid = await insertUser(`desk-0254-${Date.now()}@t.local`);
    const docker = await query<{ id: string; runtime_kind: string }>(
      `INSERT INTO agent_containers(user_id, secret_hash, state, runtime_channel)
       VALUES ($1, decode($2,'hex'), 'active', 'v3')
       RETURNING id::text AS id, runtime_kind`,
      [uid, HASH32],
    );
    assert.equal(docker.rows[0]!.runtime_kind, "docker");

    await query(
      `INSERT INTO agent_containers(user_id, secret_hash, state, runtime_channel, runtime_kind)
       VALUES ($1, decode($2,'hex'), 'active', 'v3', 'desktop')`,
      [uid, HASH32],
    );

    await assert.rejects(
      () =>
        query(
          `INSERT INTO agent_containers(user_id, secret_hash, state, runtime_channel, runtime_kind)
           VALUES ($1, decode($2,'hex'), 'active', 'v3', 'docker')`,
          [uid, HASH32],
        ),
      /uniq_ac_user_channel_kind_active|duplicate key/,
    );

    await assert.rejects(
      () =>
        query(
          `INSERT INTO agent_containers(user_id, secret_hash, state, runtime_channel, runtime_kind)
           VALUES ($1, decode($2,'hex'), 'active', 'v3', 'k8s')`,
          [uid, HASH32],
        ),
      /agent_containers_runtime_kind_check|violates check constraint/,
    );

    const cid = docker.rows[0]!.id;
    await query(
      `INSERT INTO desktop_devices(
         user_id, container_id, credential_hash, tls_client_fp,
         cert_serial, cert_expires_at
       ) VALUES (
         $1, $2, decode($3,'hex'), decode($3,'hex'),
         'serial-1', NOW() + INTERVAL '1 year'
       )`,
      [uid, cid, HASH32],
    );
    await assert.rejects(
      () =>
        query(
          `INSERT INTO desktop_devices(
             user_id, container_id, credential_hash, tls_client_fp,
             cert_serial, cert_expires_at
           ) VALUES (
             $1, $2, decode($3,'hex'), decode($3,'hex'),
             'serial-2', NOW() + INTERVAL '1 year'
           )`,
          [uid, cid, HASH32],
        ),
      /desktop_devices_one_live_per_user|duplicate key/,
    );
    await assert.rejects(
      () =>
        query(
          `INSERT INTO desktop_devices(
             user_id, container_id, credential_hash, tls_client_fp,
             cert_serial, cert_expires_at
           ) VALUES (
             $1, $2, decode('00','hex'), decode($3,'hex'),
             'serial-3', NOW() + INTERVAL '1 year'
           )`,
          [uid, cid, HASH32],
        ),
      /desktop_devices_credential_hash_len|check constraint/,
    );

    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      requiredMigrations: string[];
    };
    for (const v of [
      "0264_desktop_virtual_container",
      "0265_desktop_kind_unique_index",
      "0266_drop_user_channel_active",
      "0267_turn_dispatches_agent_container",
      "0268_desktop_session_secret_generation",
    ]) {
      assert.ok(metadata.requiredMigrations.includes(v), `requiredMigrations missing ${v}`);
    }

    await resetAndMigrateBefore("0254");

    const beforeKind = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM information_schema.columns
        WHERE table_schema='public' AND table_name='agent_containers' AND column_name='runtime_kind'`,
    );
    assert.equal(beforeKind.rows[0]!.n, "0");

    await query(
      await readFile(path.join(migrationsDir, "0264_desktop_virtual_container.sql"), "utf8"),
    );
    const afterKind = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM information_schema.columns
        WHERE table_schema='public' AND table_name='agent_containers' AND column_name='runtime_kind'`,
    );
    assert.equal(afterKind.rows[0]!.n, "1");

    const idxStmts = splitSqlStatements(
      await readFile(path.join(migrationsDir, "0265_desktop_kind_unique_index.sql"), "utf8"),
    );
    for (const stmt of idxStmts) await query(stmt);
    const idxValid = await query<{ indisvalid: boolean }>(
      `SELECT i.indisvalid
         FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname='uniq_ac_user_channel_kind_active'`,
    );
    assert.equal(idxValid.rows[0]?.indisvalid, true);

    const dropStmts = splitSqlStatements(
      await readFile(path.join(migrationsDir, "0266_drop_user_channel_active.sql"), "utf8"),
    );
    for (const stmt of dropStmts) await query(stmt);
    const oldIdxAfterDrop = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pg_class WHERE relname='uniq_ac_user_channel_active'`,
    );
    assert.equal(oldIdxAfterDrop.rows[0]!.n, "0");

    await query(
      await readFile(path.join(migrationsDir, "0267_turn_dispatches_agent_container.sql"), "utf8"),
    );
    const td = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM information_schema.columns
        WHERE table_schema='public' AND table_name='turn_dispatches' AND column_name='agent_container_id'`,
    );
    assert.equal(td.rows[0]!.n, "1");
  });
});
