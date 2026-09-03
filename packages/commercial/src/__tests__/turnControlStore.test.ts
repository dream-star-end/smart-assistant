import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Pool } from 'pg'

import {
  admitDurableControl,
  cancelPendingPermissionPromptsForTurn,
  claimDueTurnControls,
  DEFAULT_PERMISSION_TTL_MS,
  durableRetryDelayMs,
  MAX_PERMISSION_TTL_MS,
  resolvePermissionExpiresAt,
  settlePermissionPromptFromRuntime,
  settleStopControlsForTurn,
  TurnControlConflictError,
} from '../dispatch/turnControlStore.js'

function fakeTransactionalPool(
  route: (sql: string, params: unknown[]) => { rows?: unknown[]; rowCount?: number },
): { pool: Pool; calls: string[] } {
  const calls: string[] = []
  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push(sql.replace(/\s+/g, ' ').trim())
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      const result = route(sql, params)
      return { rows: result.rows ?? [], rowCount: result.rowCount ?? result.rows?.length ?? 0 }
    },
    release() {},
  }
  return {
    pool: {
      connect: async () => client,
      query: client.query.bind(client),
    } as unknown as Pool,
    calls,
  }
}

describe('Master durable turn controls', () => {
  test('Stop commit cancels the exact recovery root in the same transaction', async () => {
    const permissionCancels: unknown[][] = []
    const { pool, calls } = fakeTransactionalPool((sql, params) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1 }
      if (sql.includes('SELECT root_client_message_id FROM turn_recovery_jobs')) {
        return { rows: [{ root_client_message_id: 'message-1' }] }
      }
      if (sql.includes('INSERT INTO turn_control_requests')) {
        return { rows: [{ status: 'pending' }], rowCount: 1 }
      }
      if (sql.includes('SELECT status,dispatch_id,dispatch_attempt_no')) {
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('UPDATE turn_permission_requests p')) {
        permissionCancels.push(params)
        return { rowCount: 1 }
      }
      if (sql.includes('UPDATE turn_recovery_jobs')) return { rowCount: 2 }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    const result = await admitDurableControl(pool, {
      controlId: 'ctrl-stop-1',
      userId: 7n,
      sessionId: 'session-1',
      rootClientMessageId: 'message-1',
      kind: 'stop',
      payload: { type: 'inbound.control.stop', controlId: 'ctrl-stop-1' },
    })
    assert.deepEqual(result, { inserted: true, status: 'pending' })
    assert.equal(calls[0], 'BEGIN')
    assert.ok(calls[1]?.startsWith('SELECT pg_advisory_xact_lock'))
    assert.ok(calls[2]?.startsWith('SELECT root_client_message_id'))
    assert.ok(calls[3]?.startsWith('SELECT pg_advisory_xact_lock'))
    assert.ok(calls[4]?.startsWith('INSERT INTO turn_control_requests'))
    // INC-20260903-PENDING-PERMISSION-ZOMBIE: the pending prompts of the
    // stopped turn are closed inside the same Stop transaction.
    assert.ok(calls[5]?.startsWith('UPDATE turn_permission_requests p'))
    assert.ok(calls[6]?.startsWith('SELECT status,dispatch_id,dispatch_attempt_no'))
    assert.ok(calls[7]?.startsWith('UPDATE turn_recovery_jobs'))
    assert.equal(calls.at(-1), 'COMMIT')
    assert.equal(permissionCancels.length, 1)
    const [uid, sid, root, controlId, responseJson] = permissionCancels[0]!
    assert.deepEqual([uid, sid, root, controlId], ['7', 'session-1', 'message-1', 'ctrl-stop-1'])
    assert.deepEqual(JSON.parse(responseJson as string), {
      behavior: 'deny', settledBy: 'master', reason: 'user_stop',
    })
  })

  test('permission response cannot be admitted without a live durable request authority', async () => {
    const { pool, calls } = fakeTransactionalPool((sql) => {
      if (sql.includes('INSERT INTO turn_control_requests')) {
        return { rows: [{ status: 'pending' }], rowCount: 1 }
      }
      if (sql.includes('SELECT status FROM turn_permission_requests')) return { rowCount: 0 }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    await assert.rejects(
      admitDurableControl(pool, {
        controlId: 'ctrl-perm-1',
        userId: 7n,
        sessionId: 'session-1',
        kind: 'permission',
        requestId: 'permission-1',
        payload: { behavior: 'allow' },
      }),
      (error) => error instanceof TurnControlConflictError && error.code === 'PERMISSION_NOT_PENDING',
    )
    assert.equal(calls.at(-1), 'ROLLBACK')
  })

  test('Stop closes only pre-send admitted dispatches and leaves sent work to ordered runtime cancellation', async () => {
    const terminalized: unknown[][] = []
    const { pool } = fakeTransactionalPool((sql, params) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1 }
      if (sql.includes('SELECT root_client_message_id FROM turn_recovery_jobs')) return { rows: [] }
      if (sql.includes('INSERT INTO turn_control_requests')) {
        return { rows: [{ status: 'pending' }], rowCount: 1 }
      }
      if (sql.includes('SELECT status,dispatch_id,dispatch_attempt_no')) {
        return { rows: [
          { status: 'leased', dispatch_id: 'dispatch-pre', dispatch_attempt_no: 1 },
          { status: 'sent', dispatch_id: 'dispatch-sent', dispatch_attempt_no: 2 },
        ] }
      }
      if (sql.includes('UPDATE turn_permission_requests p')) return { rowCount: 0 }
      if (sql.includes('UPDATE turn_recovery_jobs')) return { rowCount: 2 }
      if (sql.includes('UPDATE turn_dispatches')) {
        terminalized.push(params)
        return { rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    await admitDurableControl(pool, {
      controlId: 'ctrl-stop-sent', userId: 7n, sessionId: 'session-1',
      rootClientMessageId: 'message-root', kind: 'stop', payload: {},
    })
    assert.deepEqual(terminalized, [['dispatch-pre', 1]])
  })

  test('final tape terminalizes the exact durable Stop for replay convergence', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = []
    const q = {
      async query(sql: string, params: unknown[]) {
        queries.push({ sql, params })
        return { rows: [], rowCount: 1 }
      },
    }
    assert.equal(await settleStopControlsForTurn(q as never, {
      userId: 7n, sessionId: 'session-1', clientMessageId: 'message-recovery-child',
    }), 1)
    assert.match(queries[0]!.sql, /status='terminal'/)
    assert.match(queries[0]!.sql, /request_json->>'clientMessageId'/)
    assert.deepEqual(queries[0]!.params, ['7', 'session-1', 'message-recovery-child'])
  })

  test('claim returns fenced delivery attempts and transport backoff never consumes semantic attempts', async () => {
    const { pool } = fakeTransactionalPool((sql) => {
      if (sql.includes('WITH due AS')) {
        return {
          rows: [{
            control_id: 'ctrl-stop-1',
            user_id: '7',
            session_id: 'session-1',
            root_client_message_id: 'message-1',
            kind: 'stop',
            request_id: null,
            payload_json: { type: 'inbound.control.stop' },
            lease_epoch: '3',
            delivery_attempt: 4,
          }],
        }
      }
      throw new Error(`unexpected SQL: ${sql}`)
    })
    const [claimed] = await claimDueTurnControls(pool, {
      userId: 7n,
      ownerId: 'master-a',
      leaseMs: 30_000,
    })
    assert.equal(claimed?.leaseEpoch, 3)
    assert.equal(claimed?.deliveryAttempt, 4)
    assert.equal(durableRetryDelayMs(1), 2_000)
    assert.equal(durableRetryDelayMs(20), 300_000)
    assert.equal(durableRetryDelayMs(1, 45_000), 45_000)
  })
})

describe('INC-20260903-PENDING-PERMISSION-ZOMBIE — durable prompt settlement', () => {
  function recordingQuery(rowCount = 1) {
    const queries: Array<{ sql: string; params: unknown[] }> = []
    const q = {
      async query(sql: string, params: unknown[]) {
        queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
        return { rows: [], rowCount }
      },
    }
    return { q: q as never, queries }
  }

  test('turn-scoped cancel closes only pending, non-detached rows of the lineage', async () => {
    const { q, queries } = recordingQuery(2)
    assert.equal(await cancelPendingPermissionPromptsForTurn(q, {
      userId: 7n, sessionId: 'session-1', clientMessageId: 'message-root', reason: 'turn_finalized',
    }), 2)
    const { sql, params } = queries[0]!
    assert.match(sql, /^UPDATE turn_permission_requests p SET status='cancelled'/)
    assert.match(sql, /p\.status='pending'/)
    assert.match(sql, /request_id NOT LIKE 'ask-user:%'/, 'detached ask_user must survive turn settlement')
    assert.match(sql, /\$3::text IS NULL OR p\.client_message_id=\$3/)
    // Recovery children of the root (and the root of a child) are covered the
    // same way settleStopControlsForTurn walks the lineage.
    assert.match(sql, /j\.root_client_message_id=\$3 AND j\.request_json->>'clientMessageId'=p\.client_message_id/)
    assert.match(sql, /j\.root_client_message_id=p\.client_message_id AND j\.request_json->>'clientMessageId'=\$3/)
    // Existing response metadata is never overwritten.
    assert.match(sql, /response_control_id=COALESCE\(p\.response_control_id,\$4\)/)
    assert.match(sql, /response_json=COALESCE\(p\.response_json,\$5::jsonb\)/)
    assert.deepEqual(params.slice(0, 4), ['7', 'session-1', 'message-root', null])
    assert.deepEqual(JSON.parse(params[4] as string), {
      behavior: 'deny', settledBy: 'master', reason: 'turn_finalized',
    })
  })

  test('legacy peer-wide Stop (null root) passes NULL so every turn prompt of the session closes', async () => {
    const { q, queries } = recordingQuery(0)
    assert.equal(await cancelPendingPermissionPromptsForTurn(q, {
      userId: 7n, sessionId: 'session-1', clientMessageId: null, reason: 'user_stop', controlId: 'ctrl-1',
    }), 0)
    assert.deepEqual(queries[0]!.params.slice(0, 4), ['7', 'session-1', null, 'ctrl-1'])
  })

  test('runtime allow settlement moves the exact row to responded and keeps answers', async () => {
    const { q, queries } = recordingQuery(1)
    assert.equal(await settlePermissionPromptFromRuntime(q, {
      userId: 7n, sessionId: 'webmtk6eghge4d8zo', requestId: 'toolu_01',
      behavior: 'allow', reason: 'remote', answers: { 'How?': 'B' },
    }), true)
    const { sql, params } = queries[0]!
    assert.match(sql, /^UPDATE turn_permission_requests SET status=\$4/)
    assert.match(sql, /WHERE user_id=\$1 AND request_id=\$2 AND session_id=\$3 AND status='pending'$/)
    assert.match(sql, /response_json=COALESCE\(response_json,\$5::jsonb\)/)
    assert.deepEqual(params.slice(0, 4), ['7', 'toolu_01', 'webmtk6eghge4d8zo', 'responded'])
    assert.deepEqual(JSON.parse(params[4] as string), {
      behavior: 'allow', settledBy: 'runtime', reason: 'remote', answers: { 'How?': 'B' },
    })
  })

  test('runtime deny settlement (disconnect/timeout/crashed/already_settled) cancels the row', async () => {
    for (const reason of ['disconnect', 'timeout', 'crashed', 'already_settled']) {
      const { q, queries } = recordingQuery(1)
      assert.equal(await settlePermissionPromptFromRuntime(q, {
        userId: 7n, sessionId: 'session-1', requestId: 'toolu_02', behavior: 'deny', reason,
      }), true)
      assert.equal(queries[0]!.params[3], 'cancelled')
      assert.deepEqual(JSON.parse(queries[0]!.params[4] as string), {
        behavior: 'deny', settledBy: 'runtime', reason,
      })
    }
  })

  test('runtime settlement of an already-closed row is a no-op and reports false', async () => {
    const { q } = recordingQuery(0)
    assert.equal(await settlePermissionPromptFromRuntime(q, {
      userId: 7n, sessionId: 'session-1', requestId: 'toolu_03', behavior: 'deny', reason: 'timeout',
    }), false)
  })
})

describe('resolvePermissionExpiresAt (detached ask_user TTL)', () => {
  const NOW = 1_720_000_000_000

  test('omitted expiresAt keeps the legacy 30-minute window', () => {
    assert.equal(resolvePermissionExpiresAt(undefined, NOW).getTime(), NOW + DEFAULT_PERMISSION_TTL_MS)
    assert.equal(DEFAULT_PERMISSION_TTL_MS, 30 * 60_000)
  })

  test('frame-carried 24h expiry is used instead of 30 minutes', () => {
    const expiresAt = NOW + 24 * 60 * 60_000
    assert.equal(resolvePermissionExpiresAt(expiresAt, NOW).getTime(), expiresAt)
    assert.equal(MAX_PERMISSION_TTL_MS, 24 * 60 * 60_000)
  })

  test('blocking Codex 12h expiry survives the Master normalization boundary', () => {
    const expiresAt = NOW + 12 * 60 * 60_000
    assert.equal(resolvePermissionExpiresAt(expiresAt, NOW).getTime(), expiresAt)
  })

  test('expiry further than 24h is capped', () => {
    assert.equal(
      resolvePermissionExpiresAt(NOW + 48 * 60 * 60_000, NOW).getTime(),
      NOW + MAX_PERMISSION_TTL_MS,
    )
  })

  test('past or non-numeric values fall back to 30 minutes', () => {
    assert.equal(resolvePermissionExpiresAt(NOW - 1, NOW).getTime(), NOW + DEFAULT_PERMISSION_TTL_MS)
    assert.equal(resolvePermissionExpiresAt('tomorrow', NOW).getTime(), NOW + DEFAULT_PERMISSION_TTL_MS)
  })
})
