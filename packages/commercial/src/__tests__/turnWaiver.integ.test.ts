import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import { settleUsageAndLedger } from '../billing/proxyBilling.js'
import { applyTurnWaiver } from '../billing/refund.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { resolveLegacyWaiverTurnKey } from '../http/internalTurnWaive.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
let pgAvailable = false

function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '')
  if (!name.endsWith('_test')) {
    throw new Error(`refusing to reset non-test database: ${name}`)
  }
}

async function cleanSchema(): Promise<void> {
  assertTestDatabase(TEST_DB_URL)
  await query('DROP SCHEMA IF EXISTS public CASCADE')
  await query('CREATE SCHEMA public')
  await query('GRANT ALL ON SCHEMA public TO public')
}

before(async () => {
  const probe = createPool({
    connectionString: TEST_DB_URL,
    max: 1,
    connectionTimeoutMillis: 1_500,
  })
  try {
    await probe.query('SELECT 1')
    pgAvailable = true
  } catch {
    if (REQUIRE_TEST_DB) throw new Error('REQUIRE_TEST_DB=1 but Postgres is unavailable')
  } finally {
    await probe.end().catch(() => {})
  }
  if (!pgAvailable) return
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await cleanSchema()
  await runMigrations()
})

after(async () => {
  if (!pgAvailable) return
  await cleanSchema().catch(() => {})
  await closePool()
})

beforeEach(async () => {
  if (!pgAvailable) return
  await query('TRUNCATE users RESTART IDENTITY CASCADE')
})

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (pgAvailable) return false
  t.skip('pg not running')
  return true
}

async function createUsers(wallet = 0n): Promise<{ adminId: bigint; userId: bigint }> {
  const admin = await query<{ id: string }>(
    `INSERT INTO users(email,password_hash,credits,role)
     VALUES ('waiver-admin@example.com','argon2$stub',0,'admin')
     RETURNING id::text AS id`,
  )
  const user = await query<{ id: string }>(
    `INSERT INTO users(email,password_hash,credits,role)
     VALUES ('waiver-user@example.com','argon2$stub',$1,'user')
     RETURNING id::text AS id`,
    [wallet.toString()],
  )
  return { adminId: BigInt(admin.rows[0]!.id), userId: BigInt(user.rows[0]!.id) }
}

describe('exact turn waiver + targeted inbox (integ)', () => {
  test('rolling old report resolves one timeout tape by exact engine session, never a billing window', async (t) => {
    if (skipIfNoPg(t)) return
    const { userId } = await createUsers()
    const now = Date.now()
    const turnKey = '8'.repeat(64)
    const tapeId = '7'.repeat(64)
    const clientSessionId = 'web-legacy-timeout'
    const engineSessionId = 'ccb-legacy-engine-1'
    const canonical = Buffer.from(JSON.stringify({
      sessionId: clientSessionId,
      agentId: 'main',
      agentSessionId: engineSessionId,
      turnIndex: 1,
      status: 'interrupted',
      turnKey,
      text: '',
      errorCode: 'IDLE_TIMEOUT',
      errorDetail: 'safe timeout',
      createdAt: now,
    }), 'utf8')
    await query(
      `INSERT INTO client_sessions(id,user_id,created_at,last_at,updated_at)
       VALUES ($1,$2,$3,$3,$3)`,
      [clientSessionId, `c:${userId.toString()}`, now],
    )
    await query(
      `INSERT INTO client_session_turn_tapes
         (session_id,user_id,tape_id,agent_id,turn_index,status,turn_key,
          tape_sha256,total_bytes,part_count,billing_anchor_id,created_at,finalized_at)
       VALUES ($1,$2,$3,'main',1,'interrupted',$4,$5,$6,1,'srv-legacy',$7,NULL)`,
      [
        clientSessionId,
        `c:${userId.toString()}`,
        tapeId,
        turnKey,
        '6'.repeat(64),
        canonical.length,
        now,
      ],
    )
    await query(
      `INSERT INTO client_session_turn_tape_parts
         (session_id,user_id,tape_id,part_index,part_sha256,payload,created_at)
       VALUES ($1,$2,$3,0,$4,$5,$6)`,
      [clientSessionId, `c:${userId.toString()}`, tapeId, '5'.repeat(64), canonical, now],
    )
    await query(
      `INSERT INTO client_session_turn_tape_records
         (session_id,user_id,tape_id,msg_id,ordinal,role,ts,content_sha256,payload)
       VALUES ($1,$2,$3,'srv-legacy',0,'assistant',$4,$5,$6)`,
      [
        clientSessionId,
        `c:${userId.toString()}`,
        tapeId,
        now,
        '4'.repeat(64),
        Buffer.from(JSON.stringify({
          id: 'srv-legacy',
          role: 'assistant',
          text: 'safe timeout',
          ts: now,
          _errorCode: 'IDLE_TIMEOUT',
        }), 'utf8'),
      ],
    )
    await query(
      `UPDATE client_session_turn_tapes SET finalized_at=$4
        WHERE session_id=$1 AND user_id=$2 AND tape_id=$3`,
      [clientSessionId, `c:${userId.toString()}`, tapeId, now],
    )

    assert.equal(await resolveLegacyWaiverTurnKey(getPool(), {
      userId,
      engineSessionId,
      sinceMs: now - 60_000,
      reason: 'idle_timeout',
      nowMs: now + 5_000,
    }), turnKey)
    assert.equal(await resolveLegacyWaiverTurnKey(getPool(), {
      userId,
      engineSessionId: 'ccb-different-engine',
      sinceMs: now - 60_000,
      reason: 'idle_timeout',
      nowMs: now + 5_000,
    }), null)
  })

  test('refunds only the exact 259-credit turn to original personal buckets and sends once', async (t) => {
    if (skipIfNoPg(t)) return
    const { adminId, userId } = await createUsers(80n)
    const turnKey = '9'.repeat(64)
    const otherTurnKey = 'a'.repeat(64)
    const sub = await query<{ id: string }>(
      `INSERT INTO user_subscriptions
         (user_id,plan_code,status,period_start,period_end,period_credits)
       VALUES ($1,'free','active',NOW(),NOW()+INTERVAL '1 day',50)
       RETURNING id::text AS id`,
      [userId.toString()],
    )
    const usage = await query<{ id: string }>(
      `INSERT INTO usage_records
         (user_id,mode,model,price_snapshot,cost_credits,request_id,status,
          turn_key,input_tokens,output_tokens)
       VALUES ($1,'chat','test','{}'::jsonb,259,'waive-root','success',$2,1,1)
       RETURNING id::text AS id`,
      [userId.toString(), turnKey],
    )
    const other = await query<{ id: string }>(
      `INSERT INTO usage_records
         (user_id,mode,model,price_snapshot,cost_credits,request_id,status,
          turn_key,input_tokens,output_tokens)
       VALUES ($1,'chat','test','{}'::jsonb,20,'other-turn','success',$2,1,1)
       RETURNING id::text AS id`,
      [userId.toString(), otherTurnKey],
    )
    // The current balances already include both the target turn's 259 debit
    // (100 period + 159 wallet) and an unrelated 20-credit wallet debit.
    await query(
      `INSERT INTO credit_ledger
         (user_id,delta,balance_after,reason,bucket,ref_type,ref_id,memo)
       VALUES
         ($1,-100,50,'chat','period','usage_record',$2,'target period'),
         ($1,-159,100,'chat','wallet','usage_record',$2,'target wallet'),
         ($1,-20,80,'chat','wallet','usage_record',$3,'other turn')`,
      [userId.toString(), usage.rows[0]!.id, other.rows[0]!.id],
    )

    const first = await applyTurnWaiver(getPool(), {
      userId,
      turnKey,
      reason: 'platform_authority_expired',
    })
    assert.equal(first.newlyApplied, true)
    assert.equal(first.refundedCredits, 259n)
    assert.equal(first.recordCount, 1)
    assert.equal(first.totalAfter, 389n)

    const balances = await query<{ wallet: string; period: string }>(
      `SELECT u.credits::text AS wallet,s.period_credits::text AS period
         FROM users u JOIN user_subscriptions s ON s.user_id=u.id
        WHERE u.id=$1 AND s.id=$2`,
      [userId.toString(), sub.rows[0]!.id],
    )
    assert.deepEqual(balances.rows, [{ wallet: '239', period: '150' }])
    const refundRows = await query<{ ref_id: string; bucket: string; delta: string }>(
      `SELECT ref_id,bucket,delta::text AS delta FROM credit_ledger
        WHERE user_id=$1 AND reason='refund' ORDER BY id`,
      [userId.toString()],
    )
    assert.deepEqual(refundRows.rows, [
      { ref_id: usage.rows[0]!.id, bucket: 'period', delta: '100' },
      { ref_id: usage.rows[0]!.id, bucket: 'wallet', delta: '159' },
    ])
    const inbox = await query<{
      audience: string
      user_id: string
      created_by: string
      notify_email: boolean
      title: string
      body_md: string
      source_type: string
    }>(
      `SELECT audience,user_id::text AS user_id,created_by::text AS created_by,
              notify_email,title,body_md,source_type
         FROM inbox_messages WHERE id=$1`,
      [first.inboxMessageId],
    )
    assert.equal(inbox.rows[0]!.audience, 'user')
    assert.equal(inbox.rows[0]!.user_id, userId.toString())
    assert.equal(inbox.rows[0]!.created_by, adminId.toString())
    assert.equal(inbox.rows[0]!.notify_email, false)
    assert.equal(inbox.rows[0]!.title, '本轮已自动免单')
    assert.match(inbox.rows[0]!.body_md, /退还 \*\*259 积分\*\*/)
    assert.equal(inbox.rows[0]!.source_type, 'turn_waive')

    const replay = await applyTurnWaiver(getPool(), {
      userId,
      turnKey,
      reason: 'platform_authority_expired',
    })
    assert.equal(replay.newlyApplied, false)
    assert.equal(replay.inboxMessageId, first.inboxMessageId)
    assert.equal(
      (
        await query<{ n: string }>(
          'SELECT COUNT(*)::text AS n FROM inbox_messages WHERE user_id=$1',
          [userId.toString()],
        )
      ).rows[0]!.n,
      '1',
    )
  })

  test('concurrent settlement and waiver always end free with one receipt', async (t) => {
    if (skipIfNoPg(t)) return
    const { userId } = await createUsers(1_000n)
    const turnKey = 'b'.repeat(64)
    const [waiver, settlement] = await Promise.all([
      applyTurnWaiver(getPool(), { userId, turnKey, reason: 'idle_timeout' }),
      settleUsageAndLedger(getPool(), {
        userId,
        accountId: null,
        requestId: 'race-settlement',
        model: 'test',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
        snapshotJson: '{}',
        costCredits: 300n,
        status: 'success',
        sessionId: 'ccb-race',
        turnKey,
      }),
    ])
    assert.equal(waiver.newlyApplied, true)
    assert.ok(settlement.debitedCredits === null || settlement.debitedCredits === 300n)
    const wallet = await query<{ credits: string }>(
      'SELECT credits::text AS credits FROM users WHERE id=$1',
      [userId.toString()],
    )
    assert.equal(wallet.rows[0]!.credits, '1000')
    const net = await query<{ total: string; receipts: string }>(
      `SELECT COALESCE(SUM(delta),0)::text AS total,
              (SELECT COUNT(*) FROM inbox_messages WHERE user_id=$1)::text AS receipts
         FROM credit_ledger WHERE user_id=$1`,
      [userId.toString()],
    )
    assert.deepEqual(net.rows, [{ total: '0', receipts: '1' }])
  })
})
