import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Pool } from 'pg'

import {
  claimDueRecoveryJobs,
  forwardRecoveryUnderRootFence,
  markRecoveryContainerReceipt,
  pauseSilentRecoveryLineage,
  releaseRecoveryForTransportWait,
} from '../dispatch/turnRecoveryStore.js'

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
