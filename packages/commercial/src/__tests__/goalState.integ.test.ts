import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import {
  bumpGoalUsageSnapshotForTape,
  GoalStateError,
  GoalStateService,
} from '../goal/goalStateService.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const SCHEMA = 'oc_goal_state_test'
const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION = path.resolve(here, '../db/migrations/0159_goal_state.sql')

let pool: Pool
let pgAvailable = false
let migrationSql = ''

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
  pool = new Pool({ connectionString: TEST_DB_URL, max: 4, options: `-c search_path=${SCHEMA}` })
  await pool.query(`
    CREATE TABLE client_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      deleted_at TIMESTAMPTZ
    );
    CREATE TABLE client_session_turn_tapes (
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tape_id TEXT NOT NULL,
      turn_key TEXT NOT NULL,
      finalized_at BIGINT,
      PRIMARY KEY(session_id,user_id,tape_id)
    );
    CREATE TABLE turn_tape_cost_components (
      request_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      tape_id TEXT NOT NULL,
      cost_credits BIGINT NOT NULL,
      PRIMARY KEY(request_id,user_id)
    );
    CREATE TABLE usage_records (
      user_id BIGINT NOT NULL,
      request_id TEXT NOT NULL,
      input_tokens BIGINT NOT NULL DEFAULT 0,
      output_tokens BIGINT NOT NULL DEFAULT 0,
      cache_read_tokens BIGINT NOT NULL DEFAULT 0,
      cache_write_tokens BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id,request_id)
    );
    CREATE TABLE pending_usage_patches (
      request_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      cost_credits TEXT NOT NULL,
      turn_key TEXT,
      parent_turn_key TEXT,
      PRIMARY KEY(user_id,request_id)
    );
    INSERT INTO client_sessions(id,user_id) VALUES
      ('existing-session','c:1'),
      ('other-session','c:2');
    INSERT INTO client_session_turn_tapes(session_id,user_id,tape_id,turn_key,finalized_at)
      VALUES ('existing-session','c:1','legacy-tape','${'a'.repeat(64)}',1700000000000);
  `)
  migrationSql = await readFile(MIGRATION, 'utf8')
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

describe('0159 platform GoalState', () => {
  maybe('opens a populated schema and is idempotent', async () => {
    assert.match(migrationSql.split('\n', 1)[0], /^-- 0159_goal_state /)
    await pool.query(migrationSql)
    await pool.query(migrationSql)

    const legacy = await pool.query<{
      goal_id: string | null
      goal_state_revision: string | null
      goal_tokens_used: string
    }>(`SELECT goal_id::text,goal_state_revision::text,goal_tokens_used::text
          FROM client_session_turn_tapes WHERE tape_id='legacy-tape'`)
    assert.deepEqual(legacy.rows[0], {
      goal_id: null,
      goal_state_revision: null,
      goal_tokens_used: '0',
    })
  })

  maybe('enforces ownership, CAS and the durable state machine', async () => {
    const broadcasts: string[] = []
    const engineSyncs: string[] = []
    const service = new GoalStateService({
      pool,
      broadcast: (_uid, snapshot) => { broadcasts.push(`${snapshot.status}:${snapshot.stateRevision}`) },
      syncEngine: (_uid, snapshot) => { engineSyncs.push(`${snapshot.status}:${snapshot.stateRevision}`) },
    })

    await assert.rejects(
      service.get(1n, 'other-session'),
      (err: unknown) => err instanceof GoalStateError && err.code === 'NOT_FOUND',
    )
    const active = await service.set(1n, 'existing-session', {
      objective: '完成平台 GoalState',
      tokenBudget: 1_000,
      creditBudget: '500',
      expectedStateRevision: 0,
    })
    assert.equal(active.status, 'active')
    assert.equal(active.stateRevision, 1)

    await assert.rejects(
      service.pause(1n, 'existing-session', 99),
      (err: unknown) => err instanceof GoalStateError && err.code === 'CONFLICT',
    )
    const paused = await service.pause(1n, 'existing-session', 1)
    assert.equal(paused.status, 'paused')
    const resumed = await service.resume(1n, 'existing-session', paused.stateRevision)
    assert.equal(resumed.status, 'active')
    const completed = await service.complete(1n, 'existing-session', resumed.stateRevision)
    assert.equal(completed.status, 'completed')
    await assert.rejects(
      service.resume(1n, 'existing-session', completed.stateRevision),
      (err: unknown) => err instanceof GoalStateError && err.code === 'CONFLICT',
    )
    assert.deepEqual(broadcasts, ['active:1', 'paused:2', 'active:3', 'completed:4'])
    assert.deepEqual(engineSyncs, broadcasts)
  })

  maybe('aggregates existing turn truth once and keeps engine fields diagnostic-only', async () => {
    const usageBroadcasts: string[] = []
    const service = new GoalStateService({
      pool,
      broadcast: (_uid, snapshot) => {
        usageBroadcasts.push(`${snapshot.tokensUsed}:${snapshot.creditsUsed}:${snapshot.snapshotRevision}`)
      },
    })
    const goal = await service.get(1n, 'existing-session')
    assert.ok(goal)
    await pool.query(
      `UPDATE client_session_turn_tapes
          SET goal_id=$1,goal_state_revision=$2,goal_tokens_used=75
        WHERE session_id='existing-session' AND user_id='c:1' AND tape_id='legacy-tape'`,
      [goal.goalId, goal.stateRevision],
    )
    await pool.query(
      `INSERT INTO turn_tape_cost_components
         (request_id,session_id,user_id,tape_id,cost_credits)
       VALUES ('goal-root','existing-session','c:1','legacy-tape',12),
              ('goal-delegate','existing-session','c:1','legacy-tape',8)`,
    )
    await pool.query(
      `INSERT INTO usage_records
         (user_id,request_id,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens)
       VALUES (1,'goal-root',30,10,5,0),
              (1,'goal-delegate',20,10,10,5),
              (1,'goal-zero-debit',8,4,3,1)`,
    )
    await pool.query(
      `INSERT INTO pending_usage_patches
         (user_id,request_id,cost_credits,turn_key)
       VALUES ('c:1','goal-zero-debit','0',$1)`,
      ['a'.repeat(64)],
    )
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await bumpGoalUsageSnapshotForTape(client, 'existing-session', 'c:1', 'legacy-tape')
      await client.query('COMMIT')
    } finally {
      client.release()
    }

    const usage = await service.refreshUsage(1n, 'existing-session')
    assert.ok(usage)
    assert.equal(usage.tokensUsed, 106, 'billing usage truth includes component-less zero-debit/error usage')
    assert.equal(usage.creditsUsed, '20')
    assert.equal(usage.snapshotRevision, goal.snapshotRevision + 1)
    assert.deepEqual(usageBroadcasts, [`106:20:${goal.snapshotRevision + 1}`])

    const diagnostic = await service.updateEngineMetrics({
      uid: 1n,
      sessionId: 'existing-session',
      goalId: goal.goalId,
      stateRevision: goal.stateRevision,
      engineStatus: 'active',
      tokensUsed: 999,
      timeUsedSeconds: 33,
    })
    assert.ok(diagnostic)
    assert.equal(diagnostic.status, 'completed', 'engine status must not overwrite platform state')
    assert.equal(diagnostic.tokensUsed, 106, 'engine usage must not replace platform billing/tape truth')
    assert.equal(diagnostic.engineStatus, 'active')
    assert.equal(diagnostic.engineTokensUsed, 999)
  })

  maybe('rolls back without damaging the populated base tables', async () => {
    await pool.query(`
      DROP INDEX IF EXISTS idx_cstt_goal_usage;
      ALTER TABLE client_session_turn_tapes DROP CONSTRAINT IF EXISTS cstt_goal_tokens_used_chk;
      ALTER TABLE client_session_turn_tapes DROP CONSTRAINT IF EXISTS cstt_goal_revision_chk;
      ALTER TABLE client_session_turn_tapes DROP COLUMN IF EXISTS goal_tokens_used;
      ALTER TABLE client_session_turn_tapes DROP COLUMN IF EXISTS goal_state_revision;
      ALTER TABLE client_session_turn_tapes DROP COLUMN IF EXISTS goal_id;
      DROP TABLE IF EXISTS session_goals;
    `)
    const row = await pool.query<{ tape_id: string }>(
      `SELECT tape_id FROM client_session_turn_tapes WHERE tape_id='legacy-tape'`,
    )
    assert.equal(row.rows[0]?.tape_id, 'legacy-tape')
    const goalTable = await pool.query<{ name: string | null }>(
      `SELECT to_regclass('${SCHEMA}.session_goals')::text AS name`,
    )
    assert.equal(goalTable.rows[0]?.name, null)
  })
})
