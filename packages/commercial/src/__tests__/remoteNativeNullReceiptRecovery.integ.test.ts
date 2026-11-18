/**
 * Real PG integration tests for OCV5-770: recovering dead/crashed cc5-native-v1
 * remote billing journal rows whose ctx.remoteNative.receipt remained null.
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import {
  recoverRemoteNativeTurnBilling,
  REMOTE_NATIVE_BILLING_RECOVERY_VERSION,
} from '../billing/remoteNativeTurnBilling.js'
import type { PreCheckRedis, ReservationHandle } from '../billing/preCheck.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { createLogger } from '../logging/logger.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const logger = createLogger({ out: () => undefined })

const OPERATION_ID = '87225e4f-5144-44df-be7a-fdb0d64aa031'
const RUN_ID = '22222222-2222-4222-8222-222222222222'
const DISPATCH_ID = '8eb663a8-7028-49a5-8156-15d1599d5249'
const REQUEST_ID = '4c66023137bb6946593616ce95e7163d'
const AUTHORITY_TURN_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
const TURN_KEY = 'a'.repeat(64)
const DOCKER_ID = 'b'.repeat(64)
const SESSION_KEY = 'agent:main:webchat:dm:test_chat_770'
const MODEL = 'claude-opus-5-5-remote'
const UPSTREAM = 'claude-opus-5-5'

let pgAvailable = false

function assertTestDatabase(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, '')
  if (!dbName.endsWith('_test')) {
    throw new Error(`refusing to reset non-test database: ${dbName} (must end with _test)`)
  }
}

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 })
  try {
    await p.query('SELECT 1')
    await p.end()
    return true
  } catch {
    try {
      await p.end()
    } catch {
      /* ignore */
    }
    return false
  }
}

before(async () => {
  pgAvailable = await probe()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required (REQUIRE_TEST_DB=1)')
    return
  }
  assertTestDatabase(TEST_DB_URL)
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await query('DROP SCHEMA IF EXISTS public CASCADE')
  await query('CREATE SCHEMA public')
  await query('GRANT ALL ON SCHEMA public TO public')
  await runMigrations()
})

after(async () => {
  if (pgAvailable) {
    try {
      await closePool()
    } catch {
      /* ignore */
    }
  }
})

beforeEach(async () => {
  if (!pgAvailable) return
  await query(
    'TRUNCATE TABLE request_finalize_journal, usage_records, credit_ledger, turn_dispatches, remote_agent_bindings, remote_agent_profiles, remote_agent_nodes, agent_containers, users RESTART IDENTITY CASCADE',
  )
})

function skipIfNoPg(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not running')
    return true
  }
  return false
}

function makeFakeRedis() {
  const released: ReservationHandle[] = []
  const redis: PreCheckRedis = {
    async atomicReserve() {
      throw new Error('unexpected reserve')
    },
    async releaseReservation(handle) {
      released.push({ userId: String(handle.userId), requestId: handle.requestId })
      return true
    },
  }
  return { redis, released }
}

function makeCc5Context(
  uid: string,
  containerId: string,
  opts: {
    hostStartAttempted?: boolean
    input?: { sequence: number; inputSha256: string } | null
    receipt?: Record<string, unknown> | null
  } = {},
) {
  return {
    v: 1,
    scope: {
      uid,
      containerDbId: containerId,
      dockerId: DOCKER_ID,
      operationId: OPERATION_ID,
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      canonicalModel: MODEL,
      backendKind: 'cc5-interactive-v1',
      expiresAt: Date.now() + 24 * 3600_000,
      upstreamModel: UPSTREAM,
    },
    requestId: REQUEST_ID,
    turnKey: TURN_KEY,
    authorityTurnId: AUTHORITY_TURN_ID,
    dispatchId: DISPATCH_ID,
    attemptNo: 1,
    sessionId: SESSION_KEY,
    pricing: {
      v: 1,
      modelId: MODEL,
      displayName: MODEL,
      inputPerMtok: '600',
      outputPerMtok: '3000',
      cacheReadPerMtok: '60',
      cacheWritePerMtok: '750',
      multiplier: '1.00',
    },
    billingRevision: 'rev-1',
    authority: {
      kind: 'bridge_signed',
      executionRevision: 'exec-1',
      projectionRevision: null,
      securityEpoch: '5',
    },
    hostStartAttempted: opts.hostStartAttempted ?? true,
    input: opts.input === undefined ? { sequence: 1, inputSha256: 'd'.repeat(64) } : opts.input,
    receipt: opts.receipt ?? null,
    reserved: true,
    reservedCredits: '100',
  }
}

async function seedIncidentTopology(opts: {
  containerState: 'active' | 'vanished'
  containerAgeMs?: number
  bindingState?: 'running' | 'released'
  bindingExpiresOffsetMs?: number
  dispatchStatus?: 'admitted' | 'accepted' | 'terminal'
  dispatchOutcome?: 'completed' | 'crashed' | 'not_accepted' | 'executed_error' | 'interrupted' | null
  dispatchFailureCode?: string | null
  terminalAgeMs?: number
  journalAgeMs?: number
  hostStartAttempted?: boolean
  input?: { sequence: number; inputSha256: string } | null
  receipt?: Record<string, unknown> | null
}) {
  const userRow = (
    await query<{ id: string }>(
      "INSERT INTO users(email, password_hash, credits, role) VALUES ('u770@example.com', 'argon2$stub', 100000, 'user') RETURNING id::text AS id",
    )
  ).rows[0]
  const uid = userRow.id

  const containerRow = (
    await query<{ id: string }>(
      `INSERT INTO agent_containers(
         user_id, secret_hash, docker_id, docker_name, workspace_volume, home_volume, image,
         status, state, runtime_kind, updated_at
       ) VALUES (
         $1, decode($2, 'hex'), $3, 'oc-c-770', 'ws-vol', 'home-vol', 'oc:latest',
         'running', $4, 'docker', NOW() - ($5::bigint * INTERVAL '1 millisecond')
       ) RETURNING id::text AS id`,
      [uid, 'aa'.repeat(32), DOCKER_ID.slice(0, 12), opts.containerState, String(opts.containerAgeMs ?? 0)],
    )
  ).rows[0]
  const containerId = containerRow.id

  const nodeId = (
    await query<{ id: string }>(
      `INSERT INTO remote_agent_nodes(label, ssh_host, ssh_user, host_key_fp, key_id, controller_sha256, status)
       VALUES ('node-770', '10.0.0.10', 'agent', 'fp-1', 'key-1', '0', 'active')
       RETURNING id::text AS id`,
    )
  ).rows[0].id

  const profileId = (
    await query<{ id: string }>(
      `INSERT INTO remote_agent_profiles(node_id, engine, profile_name, account_fingerprint, status)
       VALUES ($1, 'cc', 'prof-1', 'acct-770', 'active')
       RETURNING id::text AS id`,
      [nodeId],
    )
  ).rows[0].id

  await query(
    `INSERT INTO remote_agent_bindings(
       operation_id, run_id, uid, container_db_id, docker_id, session_key,
       node_id, profile_id, canonical_model_id, engine, backend_kind, state, expires_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, 'cc', 'cc5-interactive-v1', $10, NOW() + ($11::bigint * INTERVAL '1 millisecond')
     )`,
    [
      OPERATION_ID,
      RUN_ID,
      uid,
      containerId,
      DOCKER_ID,
      SESSION_KEY,
      nodeId,
      profileId,
      MODEL,
      opts.bindingState ?? 'running',
      String(opts.bindingExpiresOffsetMs ?? 24 * 3600_000),
    ],
  )

  const dStatus = opts.dispatchStatus ?? 'terminal'
  const dOutcome = dStatus === 'terminal' ? (opts.dispatchOutcome ?? 'crashed') : null
  await query(
    `INSERT INTO turn_dispatches(
       dispatch_id, user_id, session_id, client_message_id, agent_id, model,
       request_hash, billing_request_id, agent_container_id, attempt_no,
       status, outcome, failure_code, terminal_at
     ) VALUES (
       $1, $2, $3, 'msg-1', 'main', $4,
       $5, $6, $7, 1,
       $8, $9, $10,
       CASE WHEN $8 = 'terminal' THEN NOW() - ($11::bigint * INTERVAL '1 millisecond') ELSE NULL END
     )`,
    [
      DISPATCH_ID,
      uid,
      SESSION_KEY,
      MODEL,
      'e'.repeat(64),
      REQUEST_ID,
      containerId,
      dStatus,
      dOutcome,
      opts.dispatchFailureCode ?? (dOutcome === 'crashed' ? 'RUNNER_CRASHED' : null),
      String(opts.terminalAgeMs ?? 0),
    ],
  )

  const ctx = makeCc5Context(uid, containerId, {
    hostStartAttempted: opts.hostStartAttempted,
    input: opts.input,
    receipt: opts.receipt,
  })

  await query(
    `INSERT INTO request_finalize_journal(
       request_id, user_id, container_id, state, ctx, precheck_credits,
       dispatch_id, attempt_no, created_at, updated_at
     ) VALUES (
       $1, $2, $3, 'inflight', $4::jsonb, 100,
       $5, 1,
       NOW() - ($6::bigint * INTERVAL '1 millisecond'),
       NOW() - ($6::bigint * INTERVAL '1 millisecond')
     )`,
    [
      REQUEST_ID,
      uid,
      containerId,
      JSON.stringify({
        remoteNativeBillingRecovery: REMOTE_NATIVE_BILLING_RECOVERY_VERSION,
        remoteNative: ctx,
      }),
      DISPATCH_ID,
      String(opts.journalAgeMs ?? 3600_000),
    ],
  )

  return { uid, containerId, ctx }
}

async function countDrainUnsettled(): Promise<number> {
  const res = await query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt
       FROM request_finalize_journal
      WHERE ctx ? 'remoteNativeBillingRecovery'
        AND state IN ('inflight', 'finalizing')`,
  )
  return Number(res.rows[0]?.cnt ?? '0')
}

describe('OCV5-770: cc5-native-v1 null-receipt billing recovery', () => {
  test('closes isomorphic crashed incident (terminal/crashed + vanished + binding running) and unblocks drainGate', async (t) => {
    if (skipIfNoPg(t)) return
    const { uid } = await seedIncidentTopology({
      containerState: 'vanished',
      bindingState: 'running',
      bindingExpiresOffsetMs: 24 * 3600_000,
      dispatchStatus: 'terminal',
      dispatchOutcome: 'crashed',
      dispatchFailureCode: 'RUNNER_CRASHED',
      hostStartAttempted: true,
    })
    assert.equal(await countDrainUnsettled(), 1)

    const { redis, released } = makeFakeRedis()
    const res = await recoverRemoteNativeTurnBilling({ pool: getPool(), preCheckRedis: redis, log: logger })
    assert.deepEqual(res, { proven: 1, pending: 0 })
    assert.equal(await countDrainUnsettled(), 0)
    assert.deepEqual(released, [{ userId: uid, requestId: REQUEST_ID }])

    const row = (
      await query<{ state: string; final_credits: string | null; failure_code: string | null; error_msg: string | null }>(
        'SELECT state, final_credits::text, failure_code, error_msg FROM request_finalize_journal WHERE request_id=$1',
        [REQUEST_ID],
      )
    ).rows[0]
    assert.deepEqual(row, {
      state: 'aborted',
      final_credits: '0',
      failure_code: 'INTERNAL_ERROR',
      error_msg: 'remote_native_cc5_terminal_null_receipt',
    })
  })

  test('closes hostStartAttempted=true & input=null crash, and active-container terminal crash after grace', async (t) => {
    if (skipIfNoPg(t)) return
    // Variant A: hostStartAttempted=true, input=null, terminal/crashed, vanished
    await seedIncidentTopology({
      containerState: 'vanished',
      dispatchStatus: 'terminal',
      dispatchOutcome: 'crashed',
      hostStartAttempted: true,
      input: null,
    })
    const { redis: r1, released: rel1 } = makeFakeRedis()
    assert.deepEqual(await recoverRemoteNativeTurnBilling({ pool: getPool(), preCheckRedis: r1, log: logger }), {
      proven: 1,
      pending: 0,
    })
    assert.equal(rel1.length, 1)

    await query(
      'TRUNCATE TABLE request_finalize_journal, turn_dispatches, remote_agent_bindings, remote_agent_profiles, remote_agent_nodes, agent_containers, users RESTART IDENTITY CASCADE',
    )

    // Variant B: container still active, binding running, dispatch terminal/crashed older than 60s grace
    await seedIncidentTopology({
      containerState: 'active',
      bindingState: 'running',
      dispatchStatus: 'terminal',
      dispatchOutcome: 'crashed',
      terminalAgeMs: 120_000,
    })
    const { redis: r2, released: rel2 } = makeFakeRedis()
    assert.deepEqual(await recoverRemoteNativeTurnBilling({ pool: getPool(), preCheckRedis: r2, log: logger }), {
      proven: 1,
      pending: 0,
    })
    assert.equal(rel2.length, 1)
    assert.equal(await countDrainUnsettled(), 0)
  })

  test('never closes an active long-running cc5-native-v1 turn with null receipt', async (t) => {
    if (skipIfNoPg(t)) return
    await seedIncidentTopology({
      containerState: 'active',
      bindingState: 'running',
      bindingExpiresOffsetMs: 24 * 3600_000,
      dispatchStatus: 'accepted',
      journalAgeMs: 2 * 3600_000, // 2h active long turn
      hostStartAttempted: true,
    })

    const { redis, released } = makeFakeRedis()
    const res = await recoverRemoteNativeTurnBilling({ pool: getPool(), preCheckRedis: redis, log: logger })
    assert.deepEqual(res, { proven: 0, pending: 1 })
    assert.equal(released.length, 0)
    assert.equal(await countDrainUnsettled(), 1)

    const row = (
      await query<{ state: string }>('SELECT state FROM request_finalize_journal WHERE request_id=$1', [REQUEST_ID])
    ).rows[0]
    assert.equal(row.state, 'inflight')
  })

  test('does not prematurely close active-container crashed turn inside 60s grace window, then closes past 60s', async (t) => {
    if (skipIfNoPg(t)) return
    await seedIncidentTopology({
      containerState: 'active',
      bindingState: 'running',
      dispatchStatus: 'terminal',
      dispatchOutcome: 'crashed',
      terminalAgeMs: 5_000,
    })

    const { redis, released } = makeFakeRedis()
    const beforeGrace = await recoverRemoteNativeTurnBilling({ pool: getPool(), preCheckRedis: redis, log: logger })
    assert.deepEqual(beforeGrace, { proven: 0, pending: 1 })
    assert.equal(released.length, 0)
    assert.equal(await countDrainUnsettled(), 1)

    await query(
      `UPDATE turn_dispatches SET terminal_at = NOW() - INTERVAL '120 seconds' WHERE dispatch_id = $1`,
      [DISPATCH_ID],
    )
    const afterGrace = await recoverRemoteNativeTurnBilling({ pool: getPool(), preCheckRedis: redis, log: logger })
    assert.deepEqual(afterGrace, { proven: 1, pending: 0 })
    assert.equal(released.length, 1)
    assert.equal(await countDrainUnsettled(), 0)
  })

  test('never closes terminal completed turn with null receipt even past 60s grace or vanished container', async (t) => {
    if (skipIfNoPg(t)) return
    // Active container + completed outcome past 60s grace -> MUST stay inflight (fail-closed)
    await seedIncidentTopology({
      containerState: 'active',
      bindingState: 'running',
      dispatchStatus: 'terminal',
      dispatchOutcome: 'completed',
      terminalAgeMs: 120_000,
    })

    const { redis, released } = makeFakeRedis()
    assert.deepEqual(await recoverRemoteNativeTurnBilling({ pool: getPool(), preCheckRedis: redis, log: logger }), {
      proven: 0,
      pending: 1,
    })
    assert.equal(released.length, 0)
    assert.equal(await countDrainUnsettled(), 1)

    // Vanished container + released binding + stale timestamps, still outcome='completed' -> MUST stay inflight
    await query(
      `UPDATE agent_containers SET state='vanished', updated_at = NOW() - INTERVAL '10 minutes'`,
    )
    await query(
      `UPDATE remote_agent_bindings SET state='released', updated_at = NOW() - INTERVAL '10 minutes' WHERE operation_id = $1`,
      [OPERATION_ID],
    )
    assert.deepEqual(await recoverRemoteNativeTurnBilling({ pool: getPool(), preCheckRedis: redis, log: logger }), {
      proven: 0,
      pending: 1,
    })
    assert.equal(released.length, 0)
    assert.equal(await countDrainUnsettled(), 1)
  })

  test('CAS refuses to overwrite when usage_records already settled', async (t) => {
    if (skipIfNoPg(t)) return
    const { uid } = await seedIncidentTopology({
      containerState: 'vanished',
      dispatchStatus: 'terminal',
      dispatchOutcome: 'crashed',
    })
    await query(
      `INSERT INTO usage_records(user_id, mode, model, price_snapshot, cost_credits, request_id, status, ledger_id)
       VALUES ($1, 'chat', $2, '{}'::jsonb, 42, $3, 'success', NULL)`,
      [uid, MODEL, REQUEST_ID],
    )

    const { redis, released } = makeFakeRedis()
    const res = await recoverRemoteNativeTurnBilling({ pool: getPool(), preCheckRedis: redis, log: logger })
    assert.deepEqual(res, { proven: 0, pending: 1 })
    assert.equal(released.length, 0)

    const row = (
      await query<{ state: string }>('SELECT state FROM request_finalize_journal WHERE request_id=$1', [REQUEST_ID])
    ).rows[0]
    assert.equal(row.state, 'inflight')
  })

  test('CAS loses cleanly if concurrent late receipt commits between scan and null-abort', async (t) => {
    if (skipIfNoPg(t)) return
    const { uid, containerId } = await seedIncidentTopology({
      containerState: 'vanished',
      dispatchStatus: 'terminal',
      dispatchOutcome: 'crashed',
    })

    const lateReceipt = {
      version: 2,
      authorityTurnId: AUTHORITY_TURN_ID,
      turnKey: TURN_KEY,
      backendKind: 'cc5-interactive-v1',
      uid,
      containerDbId: containerId,
      dockerId: DOCKER_ID,
      operationId: OPERATION_ID,
      runId: RUN_ID,
      sessionKey: SESSION_KEY,
      nativeSessionId: '33333333-3333-4333-8333-333333333333',
      canonicalModel: MODEL,
      upstreamModel: UPSTREAM,
      resultSha256: 'c'.repeat(64),
      status: 'success',
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }

    const realPool = getPool()
    let injected = false
    const racePool = {
      async query(sql: string, values?: unknown[]) {
        if (!injected && sql.includes('remote-native:null-receipt-abort')) {
          injected = true
          // Simulate concurrent Cc5Relay financeTurn.terminal() writing real receipt before abort SQL runs.
          await realPool.query(
            `UPDATE request_finalize_journal
                SET ctx = jsonb_set(ctx, '{remoteNative,receipt}', $2::jsonb)
              WHERE request_id = $1`,
            [REQUEST_ID, JSON.stringify(lateReceipt)],
          )
        }
        return realPool.query(sql, values)
      },
    } as typeof realPool

    const { redis, released } = makeFakeRedis()
    const first = await recoverRemoteNativeTurnBilling({ pool: racePool, preCheckRedis: redis, log: logger })
    assert.deepEqual(first, { proven: 0, pending: 1 })
    assert.equal(released.length, 0)

    // Verify receipt survived intact and journal was NOT aborted.
    const row = (
      await query<{ state: string; receipt: Record<string, unknown> | null }>(
        `SELECT state, ctx#>'{remoteNative,receipt}' AS receipt FROM request_finalize_journal WHERE request_id=$1`,
        [REQUEST_ID],
      )
    ).rows[0]
    assert.equal(row.state, 'inflight')
    assert.equal((row.receipt as { resultSha256?: string } | null)?.resultSha256, 'c'.repeat(64))

    // Next recovery pass settles the late receipt normally using real settleUsageAndLedger instead of aborting.
    const second = await recoverRemoteNativeTurnBilling({ pool: realPool, preCheckRedis: redis, log: logger })
    assert.deepEqual(second, { proven: 1, pending: 0 })
    assert.equal(released.length, 1)

    const committed = (
      await query<{ state: string; final_credits: string | null }>(
        'SELECT state, final_credits::text FROM request_finalize_journal WHERE request_id=$1',
        [REQUEST_ID],
      )
    ).rows[0]
    assert.equal(committed.state, 'committed')
    const usageCount = (
      await query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM usage_records WHERE request_id=$1', [REQUEST_ID])
    ).rows[0]
    assert.equal(Number(usageCount.cnt), 1)
  })
})
