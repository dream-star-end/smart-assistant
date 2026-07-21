import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const SCHEMA = 'oc_migration0178_test'
const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(here, '../db/migrations/0178_lossless_agent_group_null_guard.sql')

let pool: Pool
let pgAvailable = false

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

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
  await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public')
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await admin.query(`CREATE SCHEMA ${SCHEMA}`)
  await admin.end()
  pool = new Pool({ connectionString: TEST_DB_URL, max: 2, options: `-c search_path=${SCHEMA}` })
  await pool.query(`
    CREATE TABLE client_session_turn_tapes (
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tape_id TEXT NOT NULL,
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

    CREATE OR REPLACE FUNCTION oc_0151_canonicalize_billing_array(value JSONB)
    RETURNS JSONB LANGUAGE SQL IMMUTABLE AS $$
      SELECT COALESCE(
        jsonb_agg(
          (item - 'errorReason') ||
          CASE WHEN item->>'status'='error' THEN jsonb_build_object(
            'terminalCode',
            CASE
              WHEN item->>'terminalCode' IN ('USER_CANCELLED','CODEX_ERROR')
                THEN item->>'terminalCode'
              WHEN item->>'errorReason'='codex turn interrupted'
                THEN 'USER_CANCELLED'
              ELSE 'CODEX_ERROR'
            END
          ) ELSE '{}'::jsonb END
          ORDER BY ordinal
        ),
        '[]'::jsonb
      )
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(value)='array' THEN value ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS entries(item, ordinal)
    $$;

    CREATE OR REPLACE FUNCTION canonicalize_legacy_lossless_agent_group()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      RETURN NEW;
    END $$;
    CREATE TRIGGER trg_canonicalize_legacy_lossless_agent_group
    BEFORE INSERT OR UPDATE OF payload,role ON client_session_turn_tape_records
    FOR EACH ROW EXECUTE FUNCTION canonicalize_legacy_lossless_agent_group();
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

async function seedTape(tapeId: string): Promise<void> {
  await pool.query(
    `INSERT INTO client_session_turn_tapes(session_id,user_id,tape_id)
     VALUES ('session-0178','c:1',$1)`,
    [tapeId],
  )
  await pool.query(
    `INSERT INTO client_session_turn_tape_parts(session_id,user_id,tape_id,part_index,payload)
     VALUES ('session-0178','c:1',$1,0,convert_to('source','UTF8'))`,
    [tapeId],
  )
}

async function assertUnchangedInsert(tapeId: string, raw: string): Promise<void> {
  await seedTape(tapeId)
  const bytes = Buffer.from(raw, 'utf8')
  const inserted = (
    await pool.query<{ payload: Buffer; content_sha256: string }>(
      `INSERT INTO client_session_turn_tape_records(
         session_id,user_id,tape_id,msg_id,role,content_sha256,payload
       ) VALUES ('session-0178','c:1',$1,'group','agent-group',$2,$3)
       RETURNING payload,content_sha256`,
      [tapeId, sha256(bytes), bytes],
    )
  ).rows[0]!
  assert.deepEqual(inserted.payload, bytes)
  assert.equal(inserted.content_sha256, sha256(bytes))
  assert.equal(
    (
      await pool.query(
        `SELECT 1 FROM client_session_turn_tape_parts
        WHERE session_id='session-0178' AND user_id='c:1' AND tape_id=$1`,
        [tapeId],
      )
    ).rowCount,
    1,
  )
}

describe('0178_lossless_agent_group_null_guard', () => {
  for (const [name, raw] of [
    ['missing', '{ "status" : "ok", "runId" : "r1" }'],
    ['json-null', '{"engineBillings":null,"runId":"r2"}'],
    ['non-array', '{"engineBillings":{"unexpected":true},"runId":"r3"}'],
    ['empty-array', '{"engineBillings":[],"runId":"r4"}'],
  ] as const) {
    maybe(`keeps ${name} engineBillings bytes and source parts unchanged`, async () => {
      await assertUnchangedInsert(`tape-${name}`, raw)
    })
  }

  maybe(
    'keeps UPDATE bytes unchanged when role becomes agent-group without a billing array',
    async () => {
      const tapeId = 'tape-update-missing'
      await seedTape(tapeId)
      const original = Buffer.from('{"runId":"update","status":"ok"}', 'utf8')
      await pool.query(
        `INSERT INTO client_session_turn_tape_records(
         session_id,user_id,tape_id,msg_id,role,content_sha256,payload
       ) VALUES ('session-0178','c:1',$1,'group','assistant',$2,$3)`,
        [tapeId, sha256(original), original],
      )
      const updated = (
        await pool.query<{ payload: Buffer; content_sha256: string }>(
          `UPDATE client_session_turn_tape_records
            SET role='agent-group',payload=$2,content_sha256=$3
          WHERE session_id='session-0178' AND user_id='c:1' AND tape_id=$1
          RETURNING payload,content_sha256`,
          [tapeId, original, sha256(original)],
        )
      ).rows[0]!
      assert.deepEqual(updated.payload, original)
      assert.equal(updated.content_sha256, sha256(original))
      assert.equal(
        (
          await pool.query(
            `SELECT 1 FROM client_session_turn_tape_parts
          WHERE session_id='session-0178' AND user_id='c:1' AND tape_id=$1`,
            [tapeId],
          )
        ).rowCount,
        1,
      )
    },
  )

  for (const mode of ['insert', 'update'] as const) {
    maybe(`${mode} still scrubs a real legacy billing array and removes source parts`, async () => {
      const tapeId = `tape-legacy-${mode}`
      await seedTape(tapeId)
      const raw = Buffer.from(
        '{"engineBillings":[{"requestId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"error","errorReason":"DO_NOT_KEEP"}],"runId":"legacy"}',
        'utf8',
      )
      if (mode === 'insert') {
        await pool.query(
          `INSERT INTO client_session_turn_tape_records(
             session_id,user_id,tape_id,msg_id,role,content_sha256,payload
           ) VALUES ('session-0178','c:1',$1,'group','agent-group',$2,$3)`,
          [tapeId, sha256(raw), raw],
        )
      } else {
        await pool.query(
          `INSERT INTO client_session_turn_tape_records(
             session_id,user_id,tape_id,msg_id,role,content_sha256,payload
           ) VALUES ('session-0178','c:1',$1,'group','assistant',$2,$3)`,
          [tapeId, sha256(raw), raw],
        )
        await pool.query(
          `UPDATE client_session_turn_tape_records
              SET role='agent-group',payload=$2,content_sha256=$3
            WHERE session_id='session-0178' AND user_id='c:1' AND tape_id=$1`,
          [tapeId, raw, sha256(raw)],
        )
      }
      const row = (
        await pool.query<{
          body: Record<string, unknown>
          content_sha256: string
          actual_sha256: string
        }>(
          `SELECT convert_from(payload,'UTF8')::jsonb AS body,content_sha256,
                  encode(public.digest(payload,'sha256'),'hex') AS actual_sha256
             FROM client_session_turn_tape_records
            WHERE session_id='session-0178' AND user_id='c:1' AND tape_id=$1`,
          [tapeId],
        )
      ).rows[0]!
      const billings = row.body.engineBillings as Array<Record<string, unknown>>
      assert.equal(billings[0]!.terminalCode, 'CODEX_ERROR')
      assert.equal('errorReason' in billings[0]!, false)
      assert.equal(JSON.stringify(row.body).includes('DO_NOT_KEEP'), false)
      assert.equal(row.content_sha256, row.actual_sha256)
      assert.equal(
        (
          await pool.query(
            `SELECT 1 FROM client_session_turn_tape_parts
            WHERE session_id='session-0178' AND user_id='c:1' AND tape_id=$1`,
            [tapeId],
          )
        ).rowCount,
        0,
      )
    })
  }
})
