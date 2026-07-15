import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { startGithubWorkspaceSweeper } from '../github/sessionWorkspaces.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const SCHEMA = 'oc_migration0151_test'
const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(here, '../db/migrations/0151_product_friction_events.sql')

let pool: Pool
let pgAvailable = false

before(async () => {
  const probe = new Pool({ connectionString: TEST_DB_URL, max: 1, connectionTimeoutMillis: 1500 })
  try {
    await probe.query('SELECT 1')
    pgAvailable = true
  } catch {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
  } finally {
    await probe.end().catch(() => undefined)
  }
  if (!pgAvailable) return

  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 })
  await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await admin.query(`CREATE SCHEMA ${SCHEMA}`)
  await admin.end()
  pool = new Pool({ connectionString: TEST_DB_URL, max: 2, options: `-c search_path=${SCHEMA}` })

  await pool.query(`
    CREATE TABLE users (id BIGINT PRIMARY KEY);
    CREATE TABLE usage_records (
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL,
      output_tokens BIGINT NOT NULL DEFAULT 0,
      price_snapshot JSONB NOT NULL DEFAULT '{}'
    );
    CREATE TABLE request_finalize_journal (
      request_id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      state TEXT NOT NULL,
      ctx JSONB NOT NULL DEFAULT '{}',
      usage_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE image_generation_usage_records (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      request_id TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE TABLE client_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      deleted_at TIMESTAMPTZ
    );
    CREATE TABLE github_session_workspaces (
      user_id BIGINT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      selection_version INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE client_session_turn_tapes (
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tape_id TEXT NOT NULL,
      engine_billings JSONB NOT NULL DEFAULT '[]',
      finalized_at BIGINT,
      PRIMARY KEY(session_id,user_id,tape_id)
    );
    CREATE TABLE client_session_turn_tape_parts (
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tape_id TEXT NOT NULL,
      part_index INTEGER NOT NULL,
      payload BYTEA NOT NULL,
      PRIMARY KEY(session_id,user_id,tape_id,part_index)
    );
    CREATE TABLE client_session_turn_tape_records (
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tape_id TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      payload BYTEA NOT NULL,
      PRIMARY KEY(session_id,user_id,tape_id,msg_id)
    );

    INSERT INTO users(id) VALUES (1);
    INSERT INTO image_generation_usage_records(user_id,request_id,status,error_code,completed_at)
    VALUES
      (1,'legacy-success','success',NULL,NOW()),
      (1,'legacy-relay','failed','relay_failed',NOW()),
      (1,'legacy-precheck','failed','precheck_failed',NOW()),
      (1,'legacy-route','failed','route_unavailable',NOW()),
      (1,'legacy-invalid','failed','invalid_request',NOW());

    INSERT INTO usage_records(status,output_tokens,price_snapshot) VALUES
      ('success',0,'{}'),
      ('success',3,'{"codex_status":"error","codex_error_reason":"codex turn interrupted"}'),
      ('success',2,'{"codex_status":"error","codex_error_reason":"raw provider secret detail"}'),
      ('success',0,'{}');
    INSERT INTO request_finalize_journal(request_id,user_id,state,ctx,usage_id)
    VALUES
      ('legacy-zero-output',1,'committed','{"model":"qwen3.7-max"}',1),
      ('legacy-user-stop',1,'committed','{"model":"gpt-5.6"}',2),
      ('legacy-codex-error',1,'committed','{"model":"gpt-5.6"}',3);
    INSERT INTO client_sessions(id,user_id,deleted_at) VALUES
      ('github-deleted-before-migration','c:1',NOW()),
      ('github-active-before-migration','c:1',NULL);
    INSERT INTO github_session_workspaces(user_id,session_id,status,updated_at) VALUES
      (1,'github-deleted-before-migration','ready',NOW()),
      (1,'github-active-before-migration','ready',NOW());
    INSERT INTO client_sessions(id,user_id,deleted_at)
    VALUES ('legacy-raw-tape','c:1',NULL);
    INSERT INTO client_session_turn_tapes(session_id,user_id,tape_id,engine_billings,finalized_at)
    VALUES (
      'legacy-raw-tape','c:1','tape-1',
      '[{"requestId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"error","errorReason":"DO_NOT_KEEP tape provider secret"}]',
      1783944000000
    );
    INSERT INTO client_session_turn_tape_parts(session_id,user_id,tape_id,part_index,payload)
    VALUES (
      'legacy-raw-tape','c:1','tape-1',0,
      convert_to('{"engineBilling":{"status":"error","errorReason":"DO_NOT_KEEP tape provider secret"}}','UTF8')
    );
    INSERT INTO client_session_turn_tape_records(
      session_id,user_id,tape_id,msg_id,role,content_sha256,payload
    ) VALUES (
      'legacy-raw-tape','c:1','tape-1','agent-group-1','agent-group',repeat('0',64),
      convert_to('{"engineBillings":[{"requestId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"error","errorReason":"DO_NOT_KEEP tape provider secret"}]}','UTF8')
    );
  `)

  const sql = await readFile(MIGRATION, 'utf8')
  await pool.query(sql)
  await pool.query(sql)
})

after(async () => {
  if (!pgAvailable) return
  await pool.end()
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 })
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await admin.end()
})

function maybe(name: string, fn: () => Promise<void>): void {
  test(name, async (t) => {
    if (!pgAvailable) return t.skip('Postgres unavailable')
    await fn()
  })
}

describe('0151_product_friction_events', () => {
  maybe('backfills only terminal rows that prove an upstream image fetch', async () => {
    const journeys = await pool.query<{ request_id: string; attempt_count: number }>(
      `SELECT request_id,attempt_count FROM image_generation_usage_records ORDER BY request_id`,
    )
    assert.deepEqual(journeys.rows, [
      { request_id: 'legacy-invalid', attempt_count: 0 },
      { request_id: 'legacy-precheck', attempt_count: 0 },
      { request_id: 'legacy-relay', attempt_count: 1 },
      { request_id: 'legacy-route', attempt_count: 0 },
      { request_id: 'legacy-success', attempt_count: 1 },
    ])
    const attempts = await pool.query<{ request_id: string; outcome: string; error_code: string | null }>(
      `SELECT u.request_id,a.outcome,a.error_code
         FROM image_generation_attempts a
         JOIN image_generation_usage_records u ON u.id=a.usage_id
        ORDER BY u.request_id`,
    )
    assert.deepEqual(attempts.rows, [
      { request_id: 'legacy-relay', outcome: 'failed', error_code: 'IMAGE_RELAY_FAILED' },
      { request_id: 'legacy-success', outcome: 'succeeded', error_code: null },
    ])
  })

  maybe('normalizes historical model terminal evidence without retaining raw text', async () => {
    const rows = await pool.query<{ id: string; price_snapshot: Record<string, string> }>(
      `SELECT id::text AS id,price_snapshot FROM usage_records ORDER BY id`,
    )
    assert.equal(rows.rows[0].price_snapshot.waived, 'no_output')
    assert.equal(rows.rows[0].price_snapshot.waiver_source, '0151_legacy_zero_output')
    assert.equal(rows.rows[1].price_snapshot.codex_terminal_code, 'USER_CANCELLED')
    assert.equal(rows.rows[2].price_snapshot.codex_terminal_code, 'CODEX_ERROR')
    assert.equal(JSON.stringify(rows.rows).includes('codex_error_reason'), false)
    assert.equal(JSON.stringify(rows.rows).includes('raw provider secret detail'), false)
    assert.equal(rows.rows[3].price_snapshot.waived, undefined, 'orphan zero-output row is not request truth')
  })

  maybe('canonicalizes Codex terminal snapshots written by the old runtime after migration', async () => {
    const inserted = await pool.query<{ price_snapshot: Record<string, string> }>(
      `INSERT INTO usage_records(status,output_tokens,price_snapshot) VALUES
         ('success',1,'{"codex_status":"error","codex_error_reason":"codex turn interrupted"}'),
         ('success',1,'{"codex_status":"error","codex_error_reason":"late raw failure"}')
       RETURNING price_snapshot`,
    )
    assert.deepEqual(inserted.rows.map((row) => row.price_snapshot.codex_terminal_code), [
      'USER_CANCELLED', 'CODEX_ERROR',
    ])
    assert.equal(JSON.stringify(inserted.rows).includes('codex_error_reason'), false)
    assert.equal(JSON.stringify(inserted.rows).includes('late raw failure'), false)
  })

  maybe('scrubs legacy raw Codex reasons from finalized lossless tape storage', async () => {
    const tape = await pool.query<{ engine_billings: Array<Record<string, unknown>> }>(
      `SELECT engine_billings FROM client_session_turn_tapes
        WHERE session_id='legacy-raw-tape' AND user_id='c:1' AND tape_id='tape-1'`,
    )
    assert.equal(tape.rows[0]!.engine_billings[0]!.terminalCode, 'CODEX_ERROR')
    assert.equal(JSON.stringify(tape.rows).includes('errorReason'), false)
    assert.equal(JSON.stringify(tape.rows).includes('DO_NOT_KEEP'), false)

    const record = await pool.query<{ body: Record<string, unknown>; content_sha256: string; actual_sha256: string }>(
      `SELECT convert_from(payload,'UTF8')::jsonb AS body,content_sha256,
              encode(public.digest(payload,'sha256'),'hex') AS actual_sha256
         FROM client_session_turn_tape_records
        WHERE session_id='legacy-raw-tape' AND user_id='c:1' AND tape_id='tape-1'`,
    )
    const body = record.rows[0]!.body as { engineBillings: Array<Record<string, unknown>> }
    assert.equal(body.engineBillings[0]!.terminalCode, 'CODEX_ERROR')
    assert.equal(JSON.stringify(body).includes('errorReason'), false)
    assert.equal(JSON.stringify(body).includes('DO_NOT_KEEP'), false)
    assert.equal(record.rows[0]!.content_sha256, record.rows[0]!.actual_sha256)

    const parts = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM client_session_turn_tape_parts
        WHERE session_id='legacy-raw-tape' AND user_id='c:1' AND tape_id='tape-1'`,
    )
    assert.equal(parts.rows[0]!.count, '0')
  })

  maybe('canonicalizes a pre-0151 writer that finalizes after migration commit', async () => {
    await pool.query(`
      BEGIN;
      INSERT INTO client_session_turn_tapes(session_id,user_id,tape_id,engine_billings,finalized_at)
      VALUES ('rolling-raw-tape','c:1','tape-late','[]',NULL);
      INSERT INTO client_session_turn_tape_parts(session_id,user_id,tape_id,part_index,payload)
      VALUES (
        'rolling-raw-tape','c:1','tape-late',0,
        convert_to('{"engineBillings":[{"status":"error","errorReason":"DO_NOT_KEEP rolling secret"}]}','UTF8')
      );
      INSERT INTO client_session_turn_tape_records(
        session_id,user_id,tape_id,msg_id,role,content_sha256,payload
      ) VALUES (
        'rolling-raw-tape','c:1','tape-late','agent-group-late','agent-group',repeat('0',64),
        convert_to('{"engineBillings":[{"requestId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","status":"error","errorReason":"DO_NOT_KEEP rolling secret"}]}','UTF8')
      );
      UPDATE client_session_turn_tapes
         SET engine_billings='[{"requestId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","status":"error","errorReason":"DO_NOT_KEEP rolling secret"}]',
             finalized_at=1784116800000
       WHERE session_id='rolling-raw-tape' AND user_id='c:1' AND tape_id='tape-late';
      COMMIT;
    `)

    // A delayed old upload retry after finalize is acknowledged by the
    // BEFORE trigger but cannot recreate the privacy-purged source bytes.
    await pool.query(`
      INSERT INTO client_session_turn_tape_parts(session_id,user_id,tape_id,part_index,payload)
      VALUES (
        'rolling-raw-tape','c:1','tape-late',0,
        convert_to('{"errorReason":"DO_NOT_KEEP retry secret"}','UTF8')
      )
    `)

    const tape = await pool.query<{ engine_billings: Array<Record<string, unknown>> }>(
      `SELECT engine_billings FROM client_session_turn_tapes
        WHERE session_id='rolling-raw-tape' AND user_id='c:1' AND tape_id='tape-late'`,
    )
    assert.equal(tape.rows[0]!.engine_billings[0]!.terminalCode, 'CODEX_ERROR')
    assert.equal(JSON.stringify(tape.rows).includes('errorReason'), false)
    assert.equal(JSON.stringify(tape.rows).includes('DO_NOT_KEEP'), false)

    const record = await pool.query<{ body: Record<string, unknown>; content_sha256: string; actual_sha256: string }>(
      `SELECT convert_from(payload,'UTF8')::jsonb AS body,content_sha256,
              encode(public.digest(payload,'sha256'),'hex') AS actual_sha256
         FROM client_session_turn_tape_records
        WHERE session_id='rolling-raw-tape' AND user_id='c:1' AND tape_id='tape-late'`,
    )
    const body = record.rows[0]!.body as { engineBillings: Array<Record<string, unknown>> }
    assert.equal(body.engineBillings[0]!.terminalCode, 'CODEX_ERROR')
    assert.equal(JSON.stringify(body).includes('errorReason'), false)
    assert.equal(JSON.stringify(body).includes('DO_NOT_KEEP'), false)
    assert.equal(record.rows[0]!.content_sha256, record.rows[0]!.actual_sha256)

    const parts = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM client_session_turn_tape_parts
        WHERE session_id='rolling-raw-tape' AND user_id='c:1' AND tape_id='tape-late'`,
    )
    assert.equal(parts.rows[0]!.count, '0')
  })

  maybe('clears GitHub workspaces through the canonical c:<uid> session namespace', async () => {
    const backfill = await pool.query<{ session_id: string; status: string; error_code: string | null }>(
      `SELECT session_id,status,error_code FROM github_session_workspaces ORDER BY session_id`,
    )
    assert.deepEqual(backfill.rows, [
      { session_id: 'github-active-before-migration', status: 'ready', error_code: null },
      { session_id: 'github-deleted-before-migration', status: 'cleared', error_code: 'session_deleted' },
    ])

    await pool.query(`
      INSERT INTO client_sessions(id,user_id,deleted_at)
      VALUES ('github-trigger-after-migration','c:1',NULL);
      INSERT INTO github_session_workspaces(user_id,session_id,status,updated_at)
      VALUES (1,'github-trigger-after-migration','ready',NOW());
      UPDATE client_sessions SET deleted_at=NOW()
       WHERE id='github-trigger-after-migration' AND user_id='c:1';
    `)
    const triggered = await pool.query<{ status: string; error_code: string | null }>(
      `SELECT status,error_code FROM github_session_workspaces
        WHERE session_id='github-trigger-after-migration'`,
    )
    assert.deepEqual(triggered.rows, [{ status: 'cleared', error_code: 'session_deleted' }])
  })

  maybe('GitHub sweeper translates numeric workspace owners to canonical commercial session ids', async () => {
    await pool.query(`
      INSERT INTO client_sessions(id,user_id,deleted_at)
      VALUES ('github-sweeper-canonical','c:1',NOW());
      INSERT INTO github_session_workspaces(user_id,session_id,status,updated_at)
      VALUES (1,'github-sweeper-canonical','ready',NOW());
    `)
    const sweeper = startGithubWorkspaceSweeper(pool, 60_000, async (refs) => {
      assert.deepEqual(refs, [
        { sessionId: 'github-active-before-migration', userId: 'c:1' },
        { sessionId: 'github-sweeper-canonical', userId: 'c:1' },
      ])
      return await Promise.all(refs.map(async (ref) => {
        const row = await pool.query<{ deleted_at: Date | null }>(
          `SELECT deleted_at FROM client_sessions WHERE id=$1 AND user_id=$2`,
          [ref.sessionId, ref.userId],
        )
        return {
          ...ref,
          state: row.rows[0]?.deleted_at
            ? 'deleted' as const
            : row.rows[0]
              ? 'active' as const
              : 'missing' as const,
        }
      }))
    })
    try {
      assert.deepEqual(await sweeper.runNow(), { timedOut: 0, orphaned: 1 })
    } finally {
      sweeper.stop()
    }
    const cleared = await pool.query<{ status: string; error_code: string | null }>(
      `SELECT status,error_code FROM github_session_workspaces
        WHERE session_id='github-sweeper-canonical'`,
    )
    assert.deepEqual(cleared.rows, [{ status: 'cleared', error_code: 'session_deleted' }])
  })

  maybe('rolling old writer trigger keeps preflight at zero and captures proven fetches', async () => {
    await pool.query(`
      INSERT INTO image_generation_usage_records(user_id,request_id,status,error_code)
      VALUES
        (1,'rolling-invalid','reserved',NULL),
        (1,'rolling-success','reserved',NULL),
        (1,'rolling-relay','reserved',NULL);
      UPDATE image_generation_usage_records SET status='failed',error_code='invalid_request'
       WHERE request_id='rolling-invalid';
      UPDATE image_generation_usage_records SET status='success',completed_at=NOW()
       WHERE request_id='rolling-success';
      UPDATE image_generation_usage_records SET status='failed',error_code='relay_failed',completed_at=NOW()
       WHERE request_id='rolling-relay';
    `)
    const rows = await pool.query<{ request_id: string; attempt_count: number }>(
      `SELECT request_id,attempt_count FROM image_generation_usage_records
        WHERE request_id LIKE 'rolling-%' ORDER BY request_id`,
    )
    assert.deepEqual(rows.rows, [
      { request_id: 'rolling-invalid', attempt_count: 0 },
      { request_id: 'rolling-relay', attempt_count: 1 },
      { request_id: 'rolling-success', attempt_count: 1 },
    ])
  })
})
