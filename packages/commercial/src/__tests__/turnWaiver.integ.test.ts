import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { createHash } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { settleUsageAndLedger } from '../billing/proxyBilling.js'
import { applyTurnWaiver, ensurePendingTurnWaiver } from '../billing/refund.js'
import { lockTurnBillingKeys } from '../billing/turnLock.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { makeTurnWaiveHandler, resolveLegacyWaiverTurnKey } from '../http/internalTurnWaive.js'
import { createPgSessionsBackend } from '../db/pgSessionsBackend.js'
import type { DurableCodexBilling, TurnWaiveReason } from '@openclaude/protocol'

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

async function createTurnSession(
  userId: bigint,
  sessionId: string,
  turnKey: string,
  updatedAt: number,
): Promise<void> {
  const userKey = `c:${userId.toString()}`
  await query(
    `INSERT INTO client_sessions(id,user_id,created_at,last_at,updated_at)
     VALUES ($1,$2,$3,$3,$3)`,
    [sessionId, userKey, updatedAt],
  )
  await query(
    `INSERT INTO client_session_turn_tapes
       (session_id,user_id,tape_id,agent_id,turn_index,status,turn_key,
        tape_sha256,total_bytes,part_count,billing_anchor_id,created_at,finalized_at)
     VALUES ($1,$2,$3,'main',1,'completed',$3,$3,0,1,'srv-waiver',$4,$4)`,
    [sessionId, userKey, turnKey, updatedAt],
  )
}

/** Use the real multipart/finalizer path, including Phase A before parts. */
async function longTaskTape(userId: bigint, key: string, options: {
  reason?: TurnWaiveReason; text?: string; tools?: unknown[]; engineBilling?: Omit<DurableCodexBilling, 'turnKey'>
} = {}) {
  const sessionId = `longtask-${key.slice(0, 12)}`
  const userKey = `c:${userId}`
  const createdAt = Date.now()
  await query(`INSERT INTO client_sessions(id,user_id,created_at,last_at,updated_at)
    VALUES ($1,$2,$3,$3,$3)`, [sessionId, userKey, createdAt])
  const canonical = Buffer.from(JSON.stringify({ sessionId, agentId: 'main', turnIndex: 1,
    status: 'crashed', turnKey: key, text: options.text ?? '', createdAt,
    waiveReason: options.reason ?? 'platform_authority_expired',
    errorCode: options.reason === 'turn_limit' ? 'TURN_LIMIT' : 'MODEL_AUTHORITY_EXPIRED',
    errorDetail: '任务暂时中断', tools: options.tools ?? [],
    ...(options.engineBilling ? { requestId: options.engineBilling.requestId,
      engineBilling: { ...options.engineBilling, turnKey: key } } : {}),
  }))
  const digest = createHash('sha256').update(canonical).digest('hex')
  const base = { protocolVersion: 2 as const, sessionId, agentId: 'main', turnIndex: 1,
    status: 'crashed' as const, turnKey: key, tapeId: digest, tapeSha256: digest,
    totalBytes: canonical.length, partCount: 1, createdAt,
    waiveReason: options.reason ?? 'platform_authority_expired' }
  const backend = createPgSessionsBackend(getPool(), { expectedGeneration: 1 })
  const finalize = { ...base, action: 'finalize' as const }
  return { sessionId, tapeId: digest, backend, finalize,
    async headerOnly() { return backend.finalizeLosslessTurnTape(userKey, finalize, { materialize: false }) },
    async complete() {
      await backend.stageLosslessTurnTapePart(userKey, { ...base, action: 'part', partIndex: 0,
        partSha256: digest, data: canonical.toString('base64') }, canonical)
      const result = await backend.finalizeLosslessTurnTape(userKey, finalize)
      if (options.engineBilling) {
        const stored = (await query<{ engine_billings: unknown }>(
          'SELECT engine_billings FROM client_session_turn_tapes WHERE session_id=$1 AND tape_id=$2',
          [sessionId, digest])).rows[0]!
        assert.deepEqual(stored.engine_billings, [{ ...options.engineBilling, turnKey: key }])
      }
      return result
    },
  }
}

function longTaskSettle(userId: bigint, turnKey: string, requestId: string, costCredits: bigint, output = 1) {
  return settleUsageAndLedger(getPool(), { userId, accountId: null, requestId, model: 'test',
    usage: { input_tokens: 1, output_tokens: output, cache_read_tokens: 0, cache_write_tokens: 0 },
    snapshotJson: '{}', costCredits, status: 'success', sessionId: 'ccb-longtask', turnKey })
}

async function longTaskReconciliation(userId: bigint, scenario: string) {
  const row = (await query<{ credits: string; usage_cost: string; debits: string; refunds: string; waivers: string; receipts: string }>(
    `SELECT u.credits::text AS credits,
       (SELECT COALESCE(SUM(cost_credits),0)::text FROM usage_records WHERE user_id=u.id) AS usage_cost,
       (SELECT COALESCE(-SUM(delta),0)::text FROM credit_ledger WHERE user_id=u.id AND delta<0) AS debits,
       (SELECT COALESCE(SUM(delta),0)::text FROM credit_ledger WHERE user_id=u.id AND reason='refund') AS refunds,
       (SELECT COUNT(*)::text FROM turn_waivers WHERE user_id=u.id) AS waivers,
       (SELECT COUNT(*)::text FROM inbox_messages WHERE user_id=u.id AND source_type='turn_waive') AS receipts
     FROM users u WHERE u.id=$1`, [userId.toString()])).rows[0]!
  assert.equal(1000n - BigInt(row.credits), BigInt(row.debits) - BigInt(row.refunds))
  const proof = { scenario, initialCredits: '1000', ...row }
  console.log(`LONGTASK_RECONCILIATION ${JSON.stringify(proof)}`)
  if (process.env.OC_LONGTASK_RECONCILIATION_PATH) {
    await appendFile(process.env.OC_LONGTASK_RECONCILIATION_PATH, `${JSON.stringify(proof)}\n`)
  }
  return row
}

async function longTaskWaiveRequest(userId: bigint, body: Record<string, unknown>) {
  const secret = 'a'.repeat(64)
  const broadcasts: unknown[] = []
  const handler = makeTurnWaiveHandler({ pgPool: getPool(), identityRepo: {
    async findActiveByHostAndBoundIp(host, ip) {
      return { id: 7, user_id: Number(userId), bound_ip: ip, host_uuid: host,
        secret_hash: createHash('sha256').update(Buffer.from(secret, 'hex')).digest() }
    },
  }, broadcastToUser(_uid, payload) { broadcasts.push(payload) } })
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  req.method = 'POST'; req.headers = { authorization: `Bearer oc-v3.7.${secret}` }
  let payload = ''
  const res = { statusCode: 200, headersSent: false, setHeader() { /* This response probe captures only status and JSON. */ },
    end(value: string) { payload += value } } as unknown as ServerResponse
  await handler(req, res, { hostUuid: 'test-host', boundIp: '172.30.0.5' })
  return { status: res.statusCode, body: JSON.parse(payload), broadcasts }
}

describe('long task zero-output proof and accounting (integ)', () => {
  test('waive endpoint ignores forged output/user flags and defers unknown tenant evidence', async (t) => {
    if (skipIfNoPg(t)) return
    const { userId } = await createUsers(1000n)
    const key = '8a'.repeat(32)
    const tape = await longTaskTape(userId, key, { text: '已持久化正文' })
    await tape.complete()
    const denied = await longTaskWaiveRequest(userId, { turnKey: key,
      reason: 'platform_authority_expired', hasOutput: false, zeroOutput: true })
    assert.equal(denied.status, 409)
    assert.equal(denied.body.error.code, 'TURN_WAIVER_INELIGIBLE')
    assert.deepEqual(denied.broadcasts, [])
    const other = (await query<{ id: string }>(`INSERT INTO users(email,password_hash,credits,role)
      VALUES ('waiver-other@example.com','argon2$stub',1000,'user') RETURNING id::text AS id`)).rows[0]!
    const unowned = await longTaskWaiveRequest(BigInt(other.id), { turnKey: key,
      reason: 'platform_authority_expired', userId: userId.toString(), hasOutput: false })
    assert.equal(unowned.status, 503)
    assert.deepEqual(unowned.broadcasts, [])
    const proof = await longTaskReconciliation(userId, 'endpoint-server-proof-tenant-bound')
    assert.equal(proof.waivers, '0'); assert.equal(proof.receipts, '0')
  })
  test('paid retained output denies waiver and later settlement/replay stays paid', async (t) => {
    if (skipIfNoPg(t)) return
    const { userId } = await createUsers(1000n)
    const key = '1a'.repeat(32)
    const tape = await longTaskTape(userId, key, { text: '已完成的前半部分' })
    await longTaskSettle(userId, key, 'paid-a', 17n)
    await longTaskSettle(userId, key, 'paid-b', 23n)
    assert.equal((await tape.complete()).applied, 'finalized')
    assert.equal((await applyTurnWaiver(getPool(), { userId, turnKey: key, reason: 'platform_authority_expired' })).disposition, 'denied')
    await longTaskSettle(userId, key, 'late-paid', 31n)
    await longTaskSettle(userId, key, 'late-paid', 31n)
    assert.deepEqual(await longTaskReconciliation(userId, 'paid-retained-and-late-replay'),
      { credits: '929', usage_cost: '71', debits: '71', refunds: '0', waivers: '0', receipts: '0' })
  })
  test('Phase A header cannot fence or zero a late charge; completed tool is output', async (t) => {
    if (skipIfNoPg(t)) return
    const { userId } = await createUsers(1000n)
    const key = '2a'.repeat(32)
    const tape = await longTaskTape(userId, key, { tools: [{ blockId: 'done', toolName: 'Read',
      inputJson: {}, output: '', completed: true }] })
    await tape.headerOnly()
    assert.equal((await applyTurnWaiver(getPool(), { userId, turnKey: key, reason: 'platform_authority_expired' })).disposition, 'deferred')
    await longTaskSettle(userId, key, 'header-late', 31n, 0)
    assert.equal((await tape.complete()).applied, 'finalized')
    assert.equal((await applyTurnWaiver(getPool(), { userId, turnKey: key, reason: 'platform_authority_expired' })).disposition, 'denied')
    const proof = await longTaskReconciliation(userId, 'header-deferred-tool-output')
    assert.equal(proof.credits, '969'); assert.equal(proof.waivers, '0'); assert.equal(proof.refunds, '0')
    const jobs = await query<{ kind: string; status: string }>(`SELECT kind,status FROM turn_tape_settlement_jobs
      WHERE user_id=$1 AND tape_id=$2`, [`c:${userId}`, tape.tapeId])
    assert.ok(jobs.rows.some((job) => job.kind === 'waiver' && job.status === 'queued'))
  })
  test('r1: positive canonical engine usage denies before and after its billing job', async (t) => {
    if (skipIfNoPg(t)) return
    const { userId } = await createUsers(1000n)
    for (const [index, reason] of ['turn_limit', 'platform_authority_expired'].entries()) {
      for (const before of [false, true]) {
        const key = `${index + 3}${before ? 'b' : 'a'}`.repeat(32)
        const requestId = createHash('sha256').update(`canonical-positive-${index}-${before}`).digest('hex').slice(0, 32)
        const tape = await longTaskTape(userId, key, { reason: reason as TurnWaiveReason,
          engineBilling: { requestId, engineSessionId: `oceng-${'c'.repeat(48)}`,
            status: 'error', terminalCode: 'CODEX_ERROR', durationMs: 10, usage: { input_tokens: 10, output_tokens: 100 } } })
        if (before) await longTaskSettle(userId, key, requestId, 59n, 100)
        assert.equal((await tape.complete()).applied, 'finalized')
        assert.equal((await applyTurnWaiver(getPool(), { userId, turnKey: key, reason: reason as TurnWaiveReason })).disposition, 'denied')
        if (!before) await longTaskSettle(userId, key, requestId, 59n, 100)
      }
    }
    const proof = await longTaskReconciliation(userId, 'canonical-positive-order-independent')
    assert.equal(proof.credits, '764'); assert.equal(proof.usage_cost, '236'); assert.equal(proof.waivers, '0')
  })
  test('unknown pending engine usage defers, then actual positive settlement denies', async (t) => {
    if (skipIfNoPg(t)) return
    const { userId } = await createUsers(1000n)
    const key = '5a'.repeat(32)
    const tape = await longTaskTape(userId, key, { engineBilling: { requestId: '5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b',
      engineSessionId: `oceng-${'d'.repeat(48)}`, status: 'error', terminalCode: 'CODEX_ERROR', durationMs: 10 } })
    await tape.complete()
    assert.equal((await applyTurnWaiver(getPool(), { userId, turnKey: key, reason: 'platform_authority_expired' })).disposition, 'deferred')
    await longTaskSettle(userId, key, '5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b', 13n, 5)
    assert.equal((await applyTurnWaiver(getPool(), { userId, turnKey: key, reason: 'platform_authority_expired' })).disposition, 'denied')
    const proof = await longTaskReconciliation(userId, 'unknown-billing-deferred-then-paid')
    assert.equal(proof.credits, '987'); assert.equal(proof.waivers, '0')
  })
  test('billing_failed placeholder cannot prove a pending engine request had zero output', async (t) => {
    if (skipIfNoPg(t)) return
    const { userId } = await createUsers(1000n)
    const key = '9a'.repeat(32)
    const tape = await longTaskTape(userId, key, { engineBilling: { requestId: '9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b',
      engineSessionId: `oceng-${'e'.repeat(48)}`, status: 'error', terminalCode: 'CODEX_ERROR', durationMs: 10 } })
    await query(`INSERT INTO usage_records(user_id,mode,model,price_snapshot,cost_credits,request_id,status,turn_key)
      VALUES ($1,'chat','test','{}'::jsonb,0,'9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b','billing_failed',$2)`, [userId.toString(), key])
    await tape.complete()
    assert.equal((await applyTurnWaiver(getPool(), { userId, turnKey: key,
      reason: 'platform_authority_expired' })).disposition, 'deferred')
    const proof = await longTaskReconciliation(userId, 'billing-failed-is-not-final-zero-proof')
    assert.equal(proof.credits, '1000'); assert.equal(proof.waivers, '0'); assert.equal(proof.receipts, '0')
  })
  test('proven zero output fences late settlement and refunds once, including replay', async (t) => {
    if (skipIfNoPg(t)) return
    const { userId } = await createUsers(1000n)
    const key = '6a'.repeat(32)
    const tape = await longTaskTape(userId, key)
    await longTaskSettle(userId, key, 'zero-before', 31n, 0)
    await tape.complete()
    const first = await applyTurnWaiver(getPool(), { userId, turnKey: key, reason: 'platform_authority_expired' })
    assert.equal(first.newlyApplied, true)
    assert.equal(first.refundedCredits, 31n)
    await longTaskSettle(userId, key, 'zero-late', 19n, 0)
    const replay = await applyTurnWaiver(getPool(), { userId, turnKey: key, reason: 'platform_authority_expired' })
    assert.equal(replay.inboxMessageId, first.inboxMessageId)
    const proof = await longTaskReconciliation(userId, 'zero-output-late-settlement-once')
    assert.equal(proof.credits, '1000'); assert.equal(proof.refunds, '31'); assert.equal(proof.receipts, '1')
  })
  test('historical applied authority waiver keeps its receipt and is never recaptured', async (t) => {
    if (skipIfNoPg(t)) return
    const { userId } = await createUsers(1000n)
    const key = '7a'.repeat(32)
    const tape = await longTaskTape(userId, key, { reason: 'idle_timeout', text: '历史已保留内容' })
    await longTaskSettle(userId, key, 'historic-paid', 41n)
    await tape.complete()
    const original = await applyTurnWaiver(getPool(), { userId, turnKey: key, reason: 'idle_timeout' })
    // Seed the already-applied historical policy; this is isolated test data.
    await query(`UPDATE turn_waivers SET reason='platform_authority_expired' WHERE user_id=$1 AND turn_key=$2`, [userId.toString(), key])
    const replay = await applyTurnWaiver(getPool(), { userId, turnKey: key, reason: 'platform_authority_expired' })
    assert.equal(replay.waiverId, original.waiverId); assert.equal(replay.inboxMessageId, original.inboxMessageId)
    assert.equal(replay.refundedCredits, original.refundedCredits); assert.equal(replay.newlyApplied, false)
    const proof = await longTaskReconciliation(userId, 'historical-waiver-preserved')
    assert.equal(proof.credits, '1000'); assert.equal(proof.refunds, '41'); assert.equal(proof.receipts, '1')
  })
})

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

  test('historical pending waiver refunds only the exact 259-credit turn to original personal buckets and sends once', async (t) => {
    if (skipIfNoPg(t)) return
    const { adminId, userId } = await createUsers(80n)
    const turnKey = '9'.repeat(64)
    const otherTurnKey = 'a'.repeat(64)
    const sessionId = 'web-waiver-version'
    // Historical pending waivers remain promises even when the old policy
    // admitted a turn with output. This isolated fixture predates this fix.
    await query(`INSERT INTO turn_waivers(user_id,turn_key,reason,status)
      VALUES ($1,$2,'platform_authority_expired','pending')`, [userId.toString(), turnKey])
    await createTurnSession(userId, sessionId, turnKey, 100)
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
    const firstSessionVersion = (
      await query<{ updated_at: string; history_revision: string }>(
        'SELECT updated_at::text AS updated_at,history_revision::text AS history_revision FROM client_sessions WHERE id=$1',
        [sessionId],
      )
    ).rows[0]!
    const firstVersion = BigInt(firstSessionVersion.updated_at)
    assert.ok(firstVersion > 100n)
    assert.equal(firstSessionVersion.history_revision, '1')

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
        await query<{ updated_at: string; history_revision: string }>(
          'SELECT updated_at::text AS updated_at,history_revision::text AS history_revision FROM client_sessions WHERE id=$1',
          [sessionId],
        )
      ).rows[0]!.updated_at,
      firstVersion.toString(),
    )
    assert.equal(
      (
        await query<{ history_revision: string }>(
          'SELECT history_revision::text AS history_revision FROM client_sessions WHERE id=$1',
          [sessionId],
        )
      ).rows[0]!.history_revision,
      '1',
    )
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

  test('waits for the finalizer turn lock, then commits refund, receipt and session version together', async (t) => {
    if (skipIfNoPg(t)) return
    const { userId } = await createUsers(700n)
    const turnKey = 'c'.repeat(64)
    const sessionId = 'web-waiver-lock-order'
    await createTurnSession(userId, sessionId, turnKey, 500)
    const usage = await query<{ id: string }>(
      `INSERT INTO usage_records
         (user_id,mode,model,price_snapshot,cost_credits,request_id,status,
          turn_key,input_tokens,output_tokens)
       VALUES ($1,'chat','test','{}'::jsonb,41,'waive-lock-order','success',$2,1,1)
       RETURNING id::text AS id`,
      [userId.toString(), turnKey],
    )
    await query(
      `INSERT INTO credit_ledger
         (user_id,delta,balance_after,reason,bucket,ref_type,ref_id,memo)
       VALUES ($1,-41,700,'chat','wallet','usage_record',$2,'target wallet')`,
      [userId.toString(), usage.rows[0]!.id],
    )

    const holder = await getPool().connect()
    let holderOpen = false
    let waitingObserved = false
    let applying: ReturnType<typeof applyTurnWaiver> | undefined
    let result: Awaited<ReturnType<typeof applyTurnWaiver>> | undefined
    try {
      await holder.query('BEGIN')
      holderOpen = true
      await lockTurnBillingKeys(holder, userId, [turnKey])
      const holderLock = await holder.query<{
        pid: number
        classid: string
        objid: string
        objsubid: number
      }>(
        `SELECT pid,classid::text AS classid,objid::text AS objid,objsubid
           FROM pg_locks
          WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted=TRUE`,
      )
      assert.equal(holderLock.rowCount, 1)
      const targetLock = holderLock.rows[0]!
      applying = applyTurnWaiver(getPool(), { userId, turnKey, reason: 'idle_timeout' })
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline) {
        const locks = await query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM pg_locks
            WHERE locktype='advisory' AND granted=FALSE
              AND classid::text=$1 AND objid::text=$2 AND objsubid=$3
              AND pid<>$4`,
          [targetLock.classid, targetLock.objid, targetLock.objsubid, targetLock.pid],
        )
        if (BigInt(locks.rows[0]!.n) > 0n) {
          waitingObserved = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      await holder.query('COMMIT')
      holderOpen = false
      result = await applying
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => {})
      holder.release()
      await applying?.catch(() => {})
    }

    assert.equal(waitingObserved, true)
    assert.ok(result)
    assert.equal(result.newlyApplied, true)
    assert.equal(result.refundedCredits, 41n)
    const state = await query<{
      credits: string
      updated_at: string
      waiver_status: string
      refunded_credits: string
      receipts: string
    }>(
      `SELECT u.credits::text AS credits,
              s.updated_at::text AS updated_at,
              w.status AS waiver_status,
              w.refunded_credits::text AS refunded_credits,
              (SELECT COUNT(*) FROM inbox_messages i
                WHERE i.user_id=u.id AND i.source_type='turn_waive')::text AS receipts
         FROM users u
         JOIN client_sessions s ON s.user_id=('c:' || u.id::text)
         JOIN turn_waivers w ON w.user_id=u.id AND w.turn_key=$2
        WHERE u.id=$1 AND s.id=$3`,
      [userId.toString(), turnKey, sessionId],
    )
    assert.equal(state.rows[0]!.credits, '741')
    assert.ok(BigInt(state.rows[0]!.updated_at) > 500n)
    assert.equal(state.rows[0]!.waiver_status, 'applied')
    assert.equal(state.rows[0]!.refunded_credits, '41')
    assert.equal(state.rows[0]!.receipts, '1')

    const versionAfter = state.rows[0]!.updated_at
    const replay = await applyTurnWaiver(getPool(), { userId, turnKey, reason: 'idle_timeout' })
    assert.equal(replay.newlyApplied, false)
    const replayState = await query<{ credits: string; updated_at: string; receipts: string }>(
      `SELECT u.credits::text AS credits,s.updated_at::text AS updated_at,
              (SELECT COUNT(*) FROM inbox_messages i
                WHERE i.user_id=u.id AND i.source_type='turn_waive')::text AS receipts
         FROM users u JOIN client_sessions s ON s.user_id=('c:' || u.id::text)
        WHERE u.id=$1 AND s.id=$2`,
      [userId.toString(), sessionId],
    )
    assert.deepEqual(replayState.rows, [{ credits: '741', updated_at: versionAfter, receipts: '1' }])
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

  test('OCV5-529: settlement after a waiver reports the settled zero, also on the idempotent replay', async (t) => {
    if (skipIfNoPg(t)) return
    const { userId } = await createUsers(1_000n)
    const turnKey = 'c'.repeat(64)
    await applyTurnWaiver(getPool(), { userId, turnKey, reason: 'idle_timeout' })
    const args = {
      userId,
      accountId: null,
      requestId: 'waived-after-epoch-bump',
      model: 'test',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 },
      snapshotJson: '{}',
      costCredits: 4n,
      status: 'success' as const,
      sessionId: 'ccb-529',
      turnKey,
    }
    const first = await settleUsageAndLedger(getPool(), args)
    // the journal finalizer records settledCostCredits; it must be the waived 0, not the 4 passed in
    assert.equal(first.settledCostCredits, 0n)
    assert.equal(first.ledgerId, null)
    const replay = await settleUsageAndLedger(getPool(), args)
    assert.equal(replay.commitDisposition, 'existing')
    assert.equal(replay.settledCostCredits, 0n)
    const usage = await query<{ cost_credits: string }>(
      'SELECT cost_credits::text AS cost_credits FROM usage_records WHERE user_id=$1 AND request_id=$2',
      [userId.toString(), args.requestId],
    )
    assert.deepEqual(usage.rows, [{ cost_credits: '0' }])

    const charged = await settleUsageAndLedger(getPool(), { ...args, requestId: 'not-waived', turnKey: 'd'.repeat(64) })
    assert.equal(charged.settledCostCredits, 4n)
  })

  test('one automatic-recovery lineage shares one receipt and later positive refund updates it', async (t) => {
    if (skipIfNoPg(t)) return
    const { userId } = await createUsers(1_000n)
    const sessionId = 'web-waiver-lineage'
    const userKey = `c:${userId.toString()}`
    const rootClientMessageId = 'm-waiver-root'
    const recoveryClientMessageId = 'm-recover-waiver-root'
    const rootTurnKey = 'c'.repeat(64)
    const recoveryTurnKey = 'd'.repeat(64)
    const now = Date.now()
    const messages = [
      { id: rootClientMessageId, role: 'user', text: 'fix it', ts: now },
      {
        id: recoveryClientMessageId,
        role: 'user',
        text: '↻ 自动从断点继续',
        ts: now + 1,
        _automaticRecovery: true,
        _automaticRecoveryRootClientMessageId: rootClientMessageId,
        _automaticRecoveryAttempt: 1,
      },
    ]
    await query(
      `INSERT INTO client_sessions(id,user_id,created_at,last_at,updated_at,messages,message_count)
       VALUES ($1,$2,$3,$3,$3,$4,2)`,
      [sessionId, userKey, now, JSON.stringify(messages)],
    )
    for (const [index, turnKey, clientMessageId] of [
      [1, rootTurnKey, rootClientMessageId],
      [2, recoveryTurnKey, recoveryClientMessageId],
    ] as const) {
      await query(
        `INSERT INTO client_session_turn_tapes
           (session_id,user_id,tape_id,agent_id,turn_index,status,turn_key,
            tape_sha256,total_bytes,part_count,billing_anchor_id,created_at,finalized_at,
            client_message_id)
         VALUES ($1,$2,$3,'main',$4,'interrupted',$3,$3,0,1,$5,$6,$6,$5)`,
        [sessionId, userKey, turnKey, index, clientMessageId, now + index],
      )
    }

    const first = await applyTurnWaiver(getPool(), {
      userId,
      turnKey: rootTurnKey,
      reason: 'idle_timeout',
    })
    assert.equal(first.refundedCredits, 0n)

    await settleUsageAndLedger(getPool(), {
      userId,
      accountId: null,
      requestId: 'waiver-lineage-positive',
      model: 'test',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
      snapshotJson: '{}',
      costCredits: 30n,
      status: 'success',
      sessionId: 'engine-waiver-lineage',
      turnKey: recoveryTurnKey,
    })
    const second = await applyTurnWaiver(getPool(), {
      userId,
      turnKey: recoveryTurnKey,
      reason: 'idle_timeout',
    })
    assert.equal(second.refundedCredits, 30n)
    assert.equal(second.inboxMessageId, first.inboxMessageId)

    const receipt = await query<{ n: string; body_md: string }>(
      `SELECT COUNT(*)::text AS n,MIN(body_md) AS body_md
         FROM inbox_messages WHERE user_id=$1 AND source_type='turn_waive'`,
      [userId.toString()],
    )
    assert.equal(receipt.rows[0]!.n, '1')
    assert.match(receipt.rows[0]!.body_md, /累计退还 \*\*30 积分\*\*/)
    const waivers = await query<{ distinct_receipts: string }>(
      `SELECT COUNT(DISTINCT inbox_message_id)::text AS distinct_receipts
         FROM turn_waivers WHERE user_id=$1`,
      [userId.toString()],
    )
    assert.equal(waivers.rows[0]!.distinct_receipts, '1')
  })

  // P2b T4 (docs/ARCH_P2B_FUND_ENTRY_GATES.md F4): a parent-key waiver and a child-key waiver both
  // match the same delegate usage row (turn_key = child, parent_turn_key = parent) but take
  // different turn-billing locks. The usage may be refunded at most once.
  // F4 was confirmed by this test before the per-user waiver lock (200 refunded for a 100 debit).
  test('P2b T4: concurrent parent-key and child-key waivers refund one delegate usage at most once', async (t) => {
    if (skipIfNoPg(t)) return
    const { userId } = await createUsers(1_000n)
    for (let i = 0; i < 8; i++) {
      const parentTurnKey = `${i}`.padStart(2, '0').repeat(32)
      const childTurnKey = `c${i}`.repeat(32)
      const usage = await query<{ id: string }>(
        `INSERT INTO usage_records
           (user_id,mode,model,price_snapshot,cost_credits,request_id,status,
            turn_key,parent_turn_key,input_tokens,output_tokens)
         VALUES ($1,'chat','test','{}'::jsonb,100,$2,'success',$3,$4,1,1)
         RETURNING id::text AS id`,
        [userId.toString(), `p2b-t4-${i}`, childTurnKey, parentTurnKey],
      )
      await query(
        `INSERT INTO credit_ledger (user_id,delta,balance_after,reason,bucket,ref_type,ref_id,memo)
         VALUES ($1,-100,900,'chat','wallet','usage_record',$2,'p2b t4 debit')`,
        [userId.toString(), usage.rows[0]!.id],
      )
      await query('UPDATE users SET credits=credits-100 WHERE id=$1', [userId.toString()])
      // Same order as the waive route (http/internalTurnWaive.ts): the pending fence commits
      // first, then applyTurnWaiver runs. Both fences exist before the two applies race.
      await ensurePendingTurnWaiver(getPool(), { userId, turnKey: parentTurnKey, reason: 'idle_timeout' })
      await ensurePendingTurnWaiver(getPool(), { userId, turnKey: childTurnKey, reason: 'idle_timeout' })
      const settled = await Promise.allSettled([
        applyTurnWaiver(getPool(), { userId, turnKey: parentTurnKey, reason: 'idle_timeout' }),
        applyTurnWaiver(getPool(), { userId, turnKey: childTurnKey, reason: 'idle_timeout' }),
      ])
      for (const r of settled) if (r.status === 'rejected') throw r.reason
      const refunded = await query<{ total: string }>(
        `SELECT COALESCE(SUM(delta),0)::text AS total FROM credit_ledger
          WHERE user_id=$1 AND reason='refund' AND ref_type='usage_record' AND ref_id=$2`,
        [userId.toString(), usage.rows[0]!.id],
      )
      assert.equal(refunded.rows[0]!.total, '100', `iteration ${i}: usage refunded exactly once`)
    }
    const wallet = await query<{ credits: string }>('SELECT credits::text AS credits FROM users WHERE id=$1', [userId.toString()])
    assert.equal(wallet.rows[0]!.credits, '1000')
  })
})
