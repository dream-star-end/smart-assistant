import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Pool } from 'pg'

import {
  claimDueRecoveryJobs,
  forwardRecoveryUnderRootFence,
  markRecoveryContainerReceipt,
  pauseRecoveryForRefusal,
  pauseSilentRecoveryLineage,
  releaseRecoveryForTransportWait,
  settleRecoveryJobForTape,
} from '../dispatch/turnRecoveryStore.js'
import { _recoveryRefusalAction } from '../ws/userChatBridge.js'

function fakePool(
  route: (sql: string, params: unknown[]) => { rows?: unknown[]; rowCount?: number },
): Pool {
  return {
    async query(sql: string, params: unknown[] = []) {
      const result = route(sql, params)
      return {
        rows: result.rows ?? [],
        rowCount: result.rowCount ?? result.rows?.length ?? 0,
      }
    },
  } as unknown as Pool
}

describe('Master automatic recovery scheduler store', () => {
  test('claims a fenced semantic attempt without incrementing it', async () => {
    const pool = fakePool((sql) => {
      assert.match(sql, /UPDATE turn_recovery_jobs/)
      return {
        rows: [{
          job_id: 'job-1',
          user_id: '7',
          session_id: 'session-1',
          root_client_message_id: 'message-root',
          source_client_message_id: 'message-source',
          source_turn_key: 'a'.repeat(64),
          error_code: 'RUNNER_CRASHED',
          recovery_mode: 'checkpoint',
          semantic_recovery_attempt: 4,
          transport_wait_attempt: 9,
          request_json: { type: 'inbound.message' },
          lease_epoch: '12',
        }],
      }
    })
    const [job] = await claimDueRecoveryJobs(pool, {
      userId: 7n,
      ownerId: 'master-a',
      leaseMs: 120_000,
    })
    assert.equal(job?.semanticRecoveryAttempt, 4)
    assert.equal(job?.transportWaitAttempt, 9)
    assert.equal(job?.leaseEpoch, 12)
  })

  test('transport wait only advances its independent backoff counter', async () => {
    let params: unknown[] = []
    const pool = fakePool((sql, actual) => {
      assert.match(sql, /transport_wait_attempt=transport_wait_attempt\+1/)
      params = actual
      return { rowCount: 1 }
    })
    const released = await releaseRecoveryForTransportWait(pool, {
      jobId: 'job-1',
      leaseOwner: 'master-a',
      leaseEpoch: 12,
      transportWaitAttempt: 9,
    })
    assert.equal(released, true)
    assert.equal(params[0], 'job-1')
    assert.equal(params[2], 12)
    assert.equal(params[3], 300_000)
  })

  test('OCV5-391: a refused replay pauses its job under the same lease fence instead of re-queuing', async () => {
    let sql = ''
    let params: unknown[] = []
    const pool = fakePool((actual, p) => {
      sql = actual
      params = p
      return { rowCount: 1 }
    })
    const paused = await pauseRecoveryForRefusal(pool, { jobId: 'job-1', leaseOwner: 'master-a', leaseEpoch: 12 },
      'UNAUTHORIZED_MODEL')
    assert.equal(paused, true)
    assert.match(sql, /SET status='paused',pause_reason=\$4,terminal_outcome='interrupted'/)
    assert.match(sql, /WHERE job_id=\$1 AND status='leased' AND lease_owner=\$2 AND lease_epoch=\$3/)
    assert.doesNotMatch(sql, /transport_wait_attempt|status='queued'/)
    assert.deepEqual(params, ['job-1', 'master-a', 12, 'refused:UNAUTHORIZED_MODEL'])
    await pauseRecoveryForRefusal(pool, { jobId: 'job-1', leaseOwner: 'master-a', leaseEpoch: 12 },
      'recovery_conflict:source not latest/"x"')
    assert.equal(params[3], 'refused:recovery_conflict:source_not_latest__x_')
    const lost = await pauseRecoveryForRefusal(fakePool(() => ({ rowCount: 0 })),
      { jobId: 'job-1', leaseOwner: 'master-a', leaseEpoch: 12 }, 'UNAUTHORIZED_MODEL')
    assert.equal(lost, false, 'a lease another scheduler took over is left alone')
  })

  test('OCV5-391: policy refusals stop a recovery job, transient ones wait for the next attempt', () => {
    // Production: a 2026-08-09 job on the retired kimi-k3-ark re-queued every 5 min for 2 months.
    for (const code of ['UNAUTHORIZED_MODEL', 'MODEL_NOT_AVAILABLE', 'ERR_INSUFFICIENT_CREDITS',
      'UNRESOLVED_AGENT_MODEL', 'AGENT_NOT_FOUND', 'ERR_FRAME_TOO_BIG']) {
      assert.equal(_recoveryRefusalAction(code), 'pause', code)
    }
    for (const code of ['CURSOR_UNAVAILABLE', 'ZCODE_UNAVAILABLE', 'DISPATCH_PREPARATION_TIMEOUT',
      'DURABLE_DISPATCH_UNAVAILABLE', 'EXECUTION_OWNER_BUSY', 'ERR_BACKPRESSURE', 'ERR_INTERNAL']) {
      assert.equal(_recoveryRefusalAction(code), 'requeue', code)
    }
  })

  test('settleRecoveryJobForTape parses RETURNING terminal rows', async () => {
    const q = {
      async query(sql: string) {
        assert.match(sql, /RETURNING root_client_message_id, error_code, semantic_recovery_attempt, status, pause_reason/)
        return {
          rows: [{
            root_client_message_id: 'root-1',
            error_code: 'upstream_failed',
            semantic_recovery_attempt: '2',
            status: 'completed',
            pause_reason: null,
          }],
          rowCount: 1,
        }
      },
    }
    const rows = await settleRecoveryJobForTape(q as never, {
      userId: 7n,
      sessionId: 'session-1',
      clientMessageId: 'cm-recovery',
      outcome: 'completed',
    })
    assert.deepEqual(rows, [{
      rootClientMessageId: 'root-1',
      errorCode: 'upstream_failed',
      semanticAttempt: 2,
      status: 'completed',
      pauseReason: null,
    }])
  })

  test('pauseSilentRecoveryLineage RETURNING includes paused and cancelled descendants', async () => {
    const q = {
      async query(sql: string) {
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 }
        assert.match(sql, /RETURNING root_client_message_id, error_code, semantic_recovery_attempt, status, pause_reason/)
        return {
          rows: [
            {
              root_client_message_id: 'root-1',
              error_code: 'liveness_timeout',
              semantic_recovery_attempt: 1,
              status: 'paused',
              pause_reason: 'automatic_silent_no_progress',
            },
            {
              root_client_message_id: 'root-1',
              error_code: 'liveness_timeout',
              semantic_recovery_attempt: 2,
              status: 'cancelled',
              pause_reason: 'automatic_silent_no_progress',
            },
          ],
          rowCount: 2,
        }
      },
    }
    const rows = await pauseSilentRecoveryLineage(q as never, {
      userId: 7n,
      sessionId: 'session-1',
      rootClientMessageId: 'root-1',
      currentAttempt: 1,
      terminalOutcome: 'interrupted',
    })
    assert.equal(rows.length, 2)
    assert.equal(rows[0]?.status, 'paused')
    assert.equal(rows[1]?.status, 'cancelled')
    assert.equal(rows[0]?.pauseReason, 'automatic_silent_no_progress')
  })

  test('no-progress circuit breaker persists paused current attempt and cancels descendants', async () => {
    const sql: string[] = []
    const q = {
      async query(text: string) {
        sql.push(text)
        return { rows: [], rowCount: 1 }
      },
    }
    await pauseSilentRecoveryLineage(q as never, {
      userId: 7n,
      sessionId: 'session-1',
      rootClientMessageId: 'message-root',
      currentAttempt: 1,
      terminalOutcome: 'interrupted',
    })
    assert.match(sql[0]!, /pg_advisory_xact_lock/)
    assert.match(sql[2]!, /automatic_silent_no_progress/)
    assert.match(sql[2]!, /ELSE 'cancelled'/)
  })

  test('container receipt atomically accepts dispatch and commits the semantic attempt', async () => {
    const pool = fakePool((sql, params) => {
      assert.match(sql, /WITH accepted AS/)
      assert.match(sql, /status='accepted'/)
      assert.match(sql, /status='forwarded'/)
      assert.deepEqual(params, ['dispatch-1', 2, 5])
      return { rowCount: 1 }
    })
    assert.equal(await markRecoveryContainerReceipt(pool, {
      dispatchId: 'dispatch-1',
      dispatchAttemptNo: 2,
      expectedDispatchLeaseEpoch: 5,
    }), true)
  })

  test('physical recovery enqueue occurs only while the exact root fence is held', async () => {
    const events: string[] = []
    const client = {
      async query(sql: string) {
        const compact = sql.replace(/\s+/g, ' ').trim()
        events.push(compact)
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [], rowCount: 0 }
        }
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 }
        if (sql.includes('SELECT j.job_id')) return { rows: [{ job_id: 'job-1' }], rowCount: 1 }
        if (sql.includes("SET status='sent'")) return { rows: [], rowCount: 1 }
        throw new Error(`unexpected SQL: ${sql}`)
      },
      release() {},
    }
    const pool = { connect: async () => client } as unknown as Pool
    const accepted = await forwardRecoveryUnderRootFence(
      pool,
      {
        job: {
          jobId: 'job-1', userId: 7n, sessionId: 'session-1',
          rootClientMessageId: 'message-root', sourceClientMessageId: 'message-source',
          sourceTurnKey: 'a'.repeat(64), errorCode: 'upstream_timeout',
          recoveryMode: 'replay', semanticRecoveryAttempt: 1, transportWaitAttempt: 0,
          request: {}, leaseOwner: 'master-a', leaseEpoch: 2,
        },
        dispatchId: 'dispatch-1', dispatchAttemptNo: 1,
        dispatchOwner: 'connection-1', dispatchLeaseEpoch: 3,
      },
      () => {
        events.push('PHYSICAL_FORWARD')
        return true
      },
    )
    assert.equal(accepted, true)
    const forwardAt = events.indexOf('PHYSICAL_FORWARD')
    assert.ok(forwardAt > events.findIndex((event) => event.includes('SELECT j.job_id')))
    assert.ok(forwardAt < events.findIndex((event) => event.includes("SET status='sent'")))
    assert.equal(events.at(-1), 'COMMIT')
  })

  test('a Stop-visible recovery row never reaches physical forward', async () => {
    let forwarded = false
    const client = {
      async query(sql: string) {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 }
        if (sql.includes('SELECT j.job_id')) return { rows: [], rowCount: 0 }
        throw new Error(`unexpected SQL: ${sql}`)
      },
      release() {},
    }
    const pool = { connect: async () => client } as unknown as Pool
    const result = await forwardRecoveryUnderRootFence(
      pool,
      {
        job: {
          jobId: 'job-1', userId: 7n, sessionId: 'session-1',
          rootClientMessageId: 'message-root', sourceClientMessageId: 'message-source',
          sourceTurnKey: 'a'.repeat(64), errorCode: 'upstream_timeout',
          recoveryMode: 'replay', semanticRecoveryAttempt: 1, transportWaitAttempt: 0,
          request: {}, leaseOwner: 'master-a', leaseEpoch: 2,
        },
        dispatchId: 'dispatch-1', dispatchAttemptNo: 1,
        dispatchOwner: 'connection-1', dispatchLeaseEpoch: 3,
      },
      () => { forwarded = true; return true },
    )
    assert.equal(result, false)
    assert.equal(forwarded, false)
  })

  test('a send-unknown COMMIT failure never reports success and preserves the durable identity path', async () => {
    const events: string[] = []
    const client = {
      async query(sql: string) {
        events.push(sql)
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
        if (sql === 'COMMIT') throw new Error('commit acknowledgement lost')
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 }
        if (sql.includes('SELECT j.job_id')) return { rows: [{ job_id: 'job-1' }], rowCount: 1 }
        if (sql.includes("SET status='sent'")) return { rows: [], rowCount: 1 }
        throw new Error(`unexpected SQL: ${sql}`)
      },
      release() {},
    }
    const pool = { connect: async () => client } as unknown as Pool
    let physicalEnqueues = 0
    await assert.rejects(
      forwardRecoveryUnderRootFence(
        pool,
        {
          job: {
            jobId: 'job-1', userId: 7n, sessionId: 'session-1',
            rootClientMessageId: 'message-root', sourceClientMessageId: 'message-source',
            sourceTurnKey: 'a'.repeat(64), errorCode: 'model_authority_unavailable',
            recoveryMode: 'replay', semanticRecoveryAttempt: 1, transportWaitAttempt: 0,
            request: {}, leaseOwner: 'master-a', leaseEpoch: 2,
          },
          dispatchId: 'dispatch-stable', dispatchAttemptNo: 1,
          dispatchOwner: 'connection-1', dispatchLeaseEpoch: 3,
        },
        () => { physicalEnqueues += 1; return true },
      ),
      /commit acknowledgement lost/,
    )
    assert.equal(physicalEnqueues, 1)
    assert.equal(events.at(-1), 'ROLLBACK')
    // The PG integration test exercises compensation/takeover and proves the
    // same dispatch id + attempt are reused. Gateway inbox tests prove that a
    // duplicate of that pair returns a receipt without dispatching.
  })
})
