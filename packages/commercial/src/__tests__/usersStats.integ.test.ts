import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { getFunnelStats } from '../admin/usersStats.js'
import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { resetTestSchemaForTest } from './helpers/db.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

let pgAvailable = false

async function probe(): Promise<boolean> {
  const pool = createPool({
    connectionString: TEST_DB_URL,
    max: 2,
    connectionTimeoutMillis: 1500,
  })
  try {
    await pool.query('SELECT 1')
    await pool.end()
    return true
  } catch {
    try {
      await pool.end()
    } catch {
      /* ignore */
    }
    return false
  }
}

before(async () => {
  pgAvailable = await probe()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 5 }))
  await resetTestSchemaForTest()
  await runMigrations()
})

after(async () => {
  if (!pgAvailable) return
  try {
    await resetTestSchemaForTest()
  } catch {
    /* ignore */
  }
  await closePool()
})

async function seedUser(input: {
  email: string
  daysAgo: number
  role?: 'user' | 'admin'
  trafficClass?: 'production_user' | 'e2e'
}): Promise<string> {
  const row = await query<{ id: string }>(
    `INSERT INTO users
       (email,password_hash,email_verified,role,status,signal_traffic_class,created_at,updated_at)
     VALUES ($1,'test-hash',TRUE,$2,'active',$3,
             (date_trunc('day',NOW() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')
               - ($4::int * INTERVAL '1 day') + INTERVAL '12 hours',
             NOW())
     RETURNING id::text AS id`,
    [input.email, input.role ?? 'user', input.trafficClass ?? 'production_user', input.daysAgo],
  )
  return row.rows[0].id
}

async function seedUsage(
  userId: string,
  requestId: string,
  status: 'success' | 'error',
  daysAgo: number,
): Promise<void> {
  await query(
    `INSERT INTO usage_records
       (user_id,mode,model,price_snapshot,cost_credits,request_id,status,created_at)
     VALUES ($1,'chat','gpt-5.6-sol','{}'::jsonb,0,$2,$3,
             (date_trunc('day',NOW() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')
               - ($4::int * INTERVAL '1 day') + INTERVAL '12 hours')`,
    [userId, requestId, status, daysAgo],
  )
}

describe('admin.getFunnelStats (integ)', () => {
  test('filters non-production users and separates attempts, success, exact and rolling retention', async (t) => {
    if (!pgAvailable) return t.skip('pg not running')

    const exactD1 = await seedUser({ email: 'funnel-d1@example.com', daysAgo: 10 })
    await seedUsage(exactD1, 'funnel-d1-success', 'success', 9)

    const exactD7 = await seedUser({ email: 'funnel-d7@example.com', daysAgo: 10 })
    await seedUsage(exactD7, 'funnel-d7-success', 'success', 3)

    const legacySameDay = await seedUser({ email: 'funnel-legacy@example.com', daysAgo: 5 })
    await seedUsage(legacySameDay, 'funnel-legacy-success', 'success', 5)

    const failedUsage = await seedUser({ email: 'funnel-error@example.com', daysAgo: 5 })
    await seedUsage(failedUsage, 'funnel-error', 'error', 4)

    const durableFailure = await seedUser({ email: 'funnel-dispatch@example.com', daysAgo: 0 })
    await query(
      `INSERT INTO turn_dispatches
         (dispatch_id,user_id,session_id,client_message_id,agent_id,model,request_hash,
          billing_request_id,status,outcome,failure_code,terminal_at)
       VALUES ('00000000-0000-4000-8000-000000000901',$1,'funnel-session','funnel-message',
               'main','gpt-5.6-sol',$2,'funnel-dispatch-billing','terminal','not_accepted',
               'insufficient_credits',NOW())`,
      [durableFailure, 'a'.repeat(64)],
    )

    await seedUser({ email: 'funnel-no-attempt@example.com', daysAgo: 1 })

    const admin = await seedUser({
      email: 'funnel-admin@example.com',
      daysAgo: 10,
      role: 'admin',
    })
    await seedUsage(admin, 'funnel-admin-success', 'success', 9)
    const e2e = await seedUser({
      email: 'v5-evals@claudeai.chat',
      daysAgo: 10,
      trafficClass: 'e2e',
    })
    await seedUsage(e2e, 'funnel-e2e-success', 'success', 9)

    assert.deepEqual(await getFunnelStats(30), {
      days: 30,
      cohort_total: 6,
      verified: 6,
      first_topup: 0,
      first_attempt: 5,
      first_success: 3,
      eligible_for_d1: 4,
      eligible_for_d7: 2,
      d1_retained: 1,
      d7_retained: 1,
      rolling_d1_7_retained: 2,
    })

    assert.deepEqual(await getFunnelStats(7), {
      days: 7,
      cohort_total: 4,
      verified: 4,
      first_topup: 0,
      first_attempt: 3,
      first_success: 1,
      eligible_for_d1: 2,
      eligible_for_d7: 0,
      d1_retained: 0,
      d7_retained: 0,
      rolling_d1_7_retained: 0,
    })
  })
})
