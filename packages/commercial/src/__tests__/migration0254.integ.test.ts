import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const SCHEMA = 'oc_migration0254_test'
const here = path.dirname(fileURLToPath(import.meta.url))
const UP = path.resolve(here, '../db/migrations/0254_agent_audit_error_msg.sql')
const DOWN = path.resolve(here, '../db/compensations/0254_agent_audit_error_msg.down.sql')

let pool: Pool
let upSql = ''
let downSql = ''
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
  upSql = await readFile(UP, 'utf8')
  downSql = await readFile(DOWN, 'utf8')

  await pool.query(`
    CREATE TABLE schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE users (id BIGINT PRIMARY KEY);
    CREATE TABLE agent_audit (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, session_id TEXT NOT NULL,
      tool TEXT NOT NULL, input_meta JSONB NOT NULL DEFAULT '{}', input_hash TEXT,
      output_hash TEXT, duration_ms INTEGER, success BOOLEAN NOT NULL, error_msg TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE FUNCTION agent_audit_privacy_guard()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      NEW.input_meta := NEW.input_meta - 'input_preview';
      NEW.error_msg := NULL;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER trg_agent_audit_privacy_guard
      BEFORE INSERT OR UPDATE ON agent_audit
      FOR EACH ROW EXECUTE FUNCTION agent_audit_privacy_guard();
    CREATE TABLE agent_tool_rollup_reports (
      report_id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      container_id BIGINT NOT NULL,
      reporter_run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      window_started_at TIMESTAMPTZ NOT NULL,
      window_ended_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE agent_tool_rollup_counts (
      report_id TEXT NOT NULL REFERENCES agent_tool_rollup_reports(report_id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      outcome TEXT NOT NULL,
      error_class TEXT NOT NULL CHECK (error_class IN (
        'none', 'unknown_skill', 'command_not_found', 'not_executable',
        'file_not_found', 'permission_denied', 'edit_conflict', 'timeout',
        'cancelled', 'validation_error', 'rate_limited', 'service_unavailable',
        'network_error', 'process_exit', 'other'
      )),
      failure_kind TEXT NOT NULL,
      call_count INTEGER NOT NULL,
      PRIMARY KEY (report_id, agent_id, tool, outcome, error_class, failure_kind)
    );
    INSERT INTO users(id) VALUES (1);
  `)
  await pool.query(upSql)
  await pool.query(
    "INSERT INTO schema_migrations(version) VALUES ('0254_agent_audit_error_msg')",
  )
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

describe('0254_agent_audit_error_msg', () => {
  maybe('failed rows persist sentinel/allowlist error_msg and strip input_preview', async () => {
    await pool.query(`
      INSERT INTO agent_audit(user_id,session_id,tool,input_meta,duration_ms,success,error_msg)
      VALUES
        (1,'empty','Bash','{"event_id":"e1","input_preview":"secret"}',1,false,NULL),
        (1,'secret','Bash','{"event_id":"e2","input_preview":"x"}',1,false,'Authorization: Bearer abcdef'),
        (1,'allow','Bash','{"event_id":"e3"}',1,false,'command not found'),
        (1,'ok','Read','{"event_id":"e4","input_preview":"nope"}',1,true,NULL)
    `)
    const rows = await pool.query<{ session_id: string; error_msg: string | null; input_meta: Record<string, unknown> }>(
      "SELECT session_id,error_msg,input_meta FROM agent_audit WHERE session_id IN ('empty','secret','allow','ok') ORDER BY session_id",
    )
    const byId = Object.fromEntries(rows.rows.map((row) => [row.session_id, row]))
    assert.equal(byId.empty.error_msg, 'tool_failed:empty_output')
    assert.equal(byId.secret.error_msg, 'tool_failed:redacted_output')
    assert.equal(byId.allow.error_msg, 'command not found')
    assert.equal(byId.ok.error_msg, null)
    for (const row of rows.rows) {
      assert.equal('input_preview' in row.input_meta, false)
    }
    const def = await pool.query<{ def: string }>(
      "SELECT pg_get_functiondef('agent_audit_privacy_guard'::regproc) AS def",
    )
    assert.match(def.rows[0].def, /tool_failed:empty_output/)
    assert.match(def.rows[0].def, /char_length/)
    assert.equal(/NEW\.error_msg := NULL;/.test(def.rows[0].def), false)
  })

  maybe('CHECK accepts the three new classes, mixed batch, and rejects a fourth', async () => {
    await pool.query(`
      INSERT INTO agent_tool_rollup_reports(
        report_id,user_id,container_id,reporter_run_id,sequence,window_started_at,window_ended_at
      ) VALUES (
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,1,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',1,NOW(),NOW()
      )
    `)
    for (const errorClass of ['empty_output', 'task_not_found', 'task_dead']) {
      await pool.query(
        `INSERT INTO agent_tool_rollup_counts(
           report_id,agent_id,tool,outcome,error_class,failure_kind,call_count
         ) VALUES ($1,$2,$3,'failure',$4,'tool_error',1)`,
        ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'main', errorClass, errorClass],
      )
    }
    await pool.query(`
      INSERT INTO agent_tool_rollup_counts(
        report_id,agent_id,tool,outcome,error_class,failure_kind,call_count
      ) VALUES (
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','main','Bash','failure','command_not_found','process_exit',2
      )
    `)
    const check = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'agent_tool_rollup_counts'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%empty_output%'`,
    )
    assert.ok(check.rows[0], 'expanded error_class check should exist')
    assert.match(check.rows[0].def, /empty_output/)
    assert.match(check.rows[0].def, /task_not_found/)
    assert.match(check.rows[0].def, /task_dead/)
    assert.equal(check.rows[0].def.includes('invented_fourth'), false)

    await assert.rejects(
      pool.query(`
        INSERT INTO agent_tool_rollup_counts(
          report_id,agent_id,tool,outcome,error_class,failure_kind,call_count
        ) VALUES (
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','main','X','failure','invented_fourth','unknown',1
        )
      `),
      /error_class/,
    )
  })

  maybe('truncates allowlist text to 240 code points', async () => {
    const long = `command not found ${'😀'.repeat(300)}`
    await pool.query(
      `INSERT INTO agent_audit(user_id,session_id,tool,input_meta,duration_ms,success,error_msg)
       VALUES (1,'long','Bash','{}',1,false,$1)`,
      [long],
    )
    const row = await pool.query<{ n: number; error_msg: string }>(
      "SELECT char_length(error_msg) AS n, error_msg FROM agent_audit WHERE session_id='long'",
    )
    assert.ok(row.rows[0].n <= 240)
    assert.ok(row.rows[0].error_msg.length > 0)
  })

  maybe('down.sql restores NULL guard and refuses when a later migration exists', async () => {
    await pool.query("INSERT INTO schema_migrations(version) VALUES ('0255_later')")
    await assert.rejects(pool.query(downSql), /compensation refused/)
    await pool.query("DELETE FROM schema_migrations WHERE version='0255_later'")

    await pool.query(downSql)
    const def = await pool.query<{ def: string }>(
      "SELECT pg_get_functiondef('agent_audit_privacy_guard'::regproc) AS def",
    )
    assert.match(def.rows[0].def, /NEW\.error_msg := NULL;/)
    const check = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'agent_tool_rollup_counts'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%error_class%'`,
    )
    assert.ok(check.rows[0], 'restored error_class check should exist')
    assert.equal(check.rows[0].def.includes('empty_output'), false)
    const ledger = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE version='0254_agent_audit_error_msg'",
    )
    assert.equal(ledger.rowCount, 0)
    const leftover = await pool.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM agent_audit WHERE error_msg IS NOT NULL",
    )
    assert.equal(leftover.rows[0].n, '0')
  })
})
