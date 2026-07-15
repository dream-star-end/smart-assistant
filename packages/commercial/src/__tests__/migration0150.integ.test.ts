import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const SCHEMA = 'oc_migration0150_test'
const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(here, '../db/migrations/0150_agent_tool_rollups.sql')

let pool: Pool
let sql = ''
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
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await admin.query(`CREATE SCHEMA ${SCHEMA}`)
  await admin.end()
  pool = new Pool({ connectionString: TEST_DB_URL, max: 2, options: `-c search_path=${SCHEMA}` })
  sql = await readFile(MIGRATION, 'utf8')

  await pool.query(`
    CREATE TABLE users (id BIGINT PRIMARY KEY);
    CREATE TABLE agent_audit (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, session_id TEXT NOT NULL,
      tool TEXT NOT NULL, input_meta JSONB NOT NULL DEFAULT '{}', input_hash TEXT,
      output_hash TEXT, duration_ms INTEGER, success BOOLEAN NOT NULL, error_msg TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE FUNCTION agent_audit_privacy_guard()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      NEW.input_meta := NEW.input_meta - 'input_preview';
      NEW.error_msg := NULL;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER agent_audit_privacy_guard_trigger
      BEFORE INSERT OR UPDATE ON agent_audit
      FOR EACH ROW EXECUTE FUNCTION agent_audit_privacy_guard();
    INSERT INTO users(id) VALUES (1);
    INSERT INTO agent_audit(
      user_id,session_id,tool,input_meta,duration_ms,success,created_at
    ) VALUES (
      1,'legacy-before-0150','Read','{}',3,false,
      TIMESTAMPTZ '2026-07-14 01:02:03+00'
    );
  `)
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

describe('0150_agent_tool_rollups', () => {
  maybe('backfills occurrence time and requires it for delayed-event windowing', async () => {
    const legacy = await pool.query<{ occurred_at: Date; created_at: Date }>(
      "SELECT occurred_at,created_at FROM agent_audit WHERE session_id='legacy-before-0150'",
    )
    assert.equal(legacy.rows[0].occurred_at.toISOString(), legacy.rows[0].created_at.toISOString())
    await pool.query(`
      INSERT INTO agent_audit(user_id,session_id,tool,input_meta,duration_ms,success)
      VALUES (1,'default-after-0150','Read','{}',4,false)
    `)
    const current = await pool.query<{ occurred_at: Date }>(
      "SELECT occurred_at FROM agent_audit WHERE session_id='default-after-0150'",
    )
    assert.ok(current.rows[0].occurred_at instanceof Date)
  })

  maybe('stores bounded aggregate counts and cascades them with their report', async () => {
    await pool.query(`
      INSERT INTO agent_tool_rollup_reports(
        report_id,user_id,container_id,reporter_run_id,sequence,
        window_started_at,window_ended_at
      ) VALUES (
        '11111111111111111111111111111111',1,101,
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,NOW() - INTERVAL '5 minutes',NOW()
      );
      INSERT INTO agent_tool_rollup_counts(
        report_id,agent_id,tool,outcome,error_class,failure_kind,call_count
      ) VALUES
        ('11111111111111111111111111111111','main','Bash','success','none','none',9),
        ('11111111111111111111111111111111','main','Bash','failure','process_exit','process_exit',2);
    `)

    const counts = await pool.query<{ outcome: string; call_count: number }>(
      `SELECT outcome,call_count
         FROM agent_tool_rollup_counts
        WHERE report_id='11111111111111111111111111111111'
        ORDER BY outcome`,
    )
    assert.deepEqual(counts.rows, [
      { outcome: 'failure', call_count: 2 },
      { outcome: 'success', call_count: 9 },
    ])

    await assert.rejects(
      pool.query(`
        INSERT INTO agent_tool_rollup_counts(
          report_id,agent_id,tool,outcome,error_class,failure_kind,call_count
        ) VALUES (
          '11111111111111111111111111111111','main','Read',
          'success','file_not_found','unknown',1
        )
      `),
      /agent_tool_rollup_outcome_shape/,
    )

    await pool.query(
      "DELETE FROM agent_tool_rollup_reports WHERE report_id='11111111111111111111111111111111'",
    )
    const remaining = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM agent_tool_rollup_counts WHERE report_id='11111111111111111111111111111111'",
    )
    assert.equal(remaining.rows[0].count, '0')
  })

  maybe('enforces one sequence per container reporter run', async () => {
    await pool.query(`
      INSERT INTO agent_tool_rollup_reports(
        report_id,user_id,container_id,reporter_run_id,sequence,
        window_started_at,window_ended_at
      ) VALUES (
        '22222222222222222222222222222222',1,202,
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',7,NOW() - INTERVAL '5 minutes',NOW()
      )
    `)
    await assert.rejects(
      pool.query(`
        INSERT INTO agent_tool_rollup_reports(
          report_id,user_id,container_id,reporter_run_id,sequence,
          window_started_at,window_ended_at
        ) VALUES (
          '33333333333333333333333333333333',1,202,
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',7,NOW() - INTERVAL '5 minutes',NOW()
        )
      `),
      /agent_tool_rollup_run_sequence_unique/,
    )
  })

  maybe('keeps schema-v3 metadata while removing raw failure content', async () => {
    await pool.query(`
      INSERT INTO agent_audit(
        user_id,session_id,tool,input_meta,input_hash,output_hash,duration_ms,success,error_msg
      ) VALUES (
        1,'session-v3','Bash',
        '{
          "event_id":"event-v3",
          "input_preview":"token=secret /private/path",
          "error_class":"process_exit",
          "failure_kind":"process_exit",
          "exit_code":2,
          "termination_reason":"exit_code"
        }',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        12,false,'raw stderr with token=secret'
      )
    `)

    const result = await pool.query<{
      input_meta: Record<string, unknown>
      error_msg: string | null
    }>("SELECT input_meta,error_msg FROM agent_audit WHERE session_id='session-v3'")
    assert.deepEqual(result.rows[0].input_meta, {
      event_id: 'event-v3',
      error_class: 'process_exit',
      failure_kind: 'process_exit',
      exit_code: 2,
      termination_reason: 'exit_code',
    })
    assert.equal(result.rows[0].error_msg, null)
  })
})
