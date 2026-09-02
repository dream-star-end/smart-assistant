/**
 * INC-20260903-PENDING-PERMISSION-LOST — Master hello-time replay of durable
 * pending permission prompts (turn_permission_requests → browser frame).
 *
 * Run: npx tsx --test --test-force-exit packages/commercial/src/__tests__/pendingPermissionHelloReplay.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Pool } from 'pg'

import {
  HELLO_PENDING_PERMISSION_MAX_ROWS,
  pendingPermissionPromptToFrame,
  readPendingPermissionPrompts,
  type PendingPermissionPromptRow,
} from '../dispatch/turnControlStore.js'

const NOW = 1_760_000_000_000
const PEER_ID = 'webmtk6eghge4d8zo'
const SESSION_KEY = `agent:main:webchat:dm:${PEER_ID}`

function row(overrides: Partial<PendingPermissionPromptRow> = {}): PendingPermissionPromptRow {
  return {
    requestId: 'toolu_01',
    clientMessageId: 'm-mtk6eghg-7p-lxal',
    toolUseId: 'toolu_01',
    toolName: 'AskUserQuestion',
    input: { questions: [{ question: 'How to handle the 3 incidents?', options: [] }] },
    expiresAt: new Date(NOW + 60_000),
    ...overrides,
  }
}

describe('readPendingPermissionPrompts', () => {
  test('queries only pending, unexpired rows of the exact user+session, bounded', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const pool = {
      async query(sql: string, params: unknown[]) {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
        return {
          rows: [
            {
              request_id: 'toolu_01',
              client_message_id: 'm-mtk6eghg-7p-lxal',
              tool_use_id: 'toolu_01',
              tool_name: 'AskUserQuestion',
              input_json: { questions: [] },
              expires_at: new Date(NOW + 60_000),
            },
            {
              // jsonb may arrive as text depending on type parsers.
              request_id: 'ask-user:abc',
              client_message_id: null,
              tool_use_id: null,
              tool_name: 'AskUserQuestion',
              input_json: JSON.stringify({ questions: [{ question: 'q' }] }),
              expires_at: new Date(NOW + 120_000).toISOString(),
            },
            {
              // Corrupt input is skipped rather than throwing (hello must never fail).
              request_id: 'broken',
              client_message_id: null,
              tool_use_id: null,
              tool_name: 'Bash',
              input_json: '{not json',
              expires_at: new Date(NOW + 60_000),
            },
            {
              request_id: 'array-input',
              client_message_id: null,
              tool_use_id: null,
              tool_name: 'Bash',
              input_json: [1, 2],
              expires_at: new Date(NOW + 60_000),
            },
          ],
          rowCount: 4,
        }
      },
    } as unknown as Pool
    const rows = await readPendingPermissionPrompts(pool, { userId: 3n, sessionId: PEER_ID })
    assert.equal(calls.length, 1)
    const { sql, params } = calls[0]!
    assert.match(sql, /FROM turn_permission_requests/)
    assert.match(sql, /user_id=\$1 AND session_id=\$2 AND status='pending' AND expires_at>NOW\(\)/)
    assert.deepEqual(params, ['3', PEER_ID, HELLO_PENDING_PERMISSION_MAX_ROWS])
    assert.deepEqual(rows.map((r) => r.requestId), ['toolu_01', 'ask-user:abc'])
    assert.deepEqual(rows[1]!.input, { questions: [{ question: 'q' }] })
    assert.equal(rows[1]!.expiresAt.getTime(), NOW + 120_000)
  })

  test('clamps the limit into [1,64]', async () => {
    const seen: unknown[][] = []
    const pool = {
      async query(_sql: string, params: unknown[]) { seen.push(params); return { rows: [], rowCount: 0 } },
    } as unknown as Pool
    await readPendingPermissionPrompts(pool, { userId: 3n, sessionId: PEER_ID, limit: 0 })
    await readPendingPermissionPrompts(pool, { userId: 3n, sessionId: PEER_ID, limit: 10_000 })
    assert.equal(seen[0]![2], 1)
    assert.equal(seen[1]![2], 64)
  })
})

describe('pendingPermissionPromptToFrame', () => {
  test('rebuilds the original wire frame shape without a frameSeq', () => {
    const frame = pendingPermissionPromptToFrame(row(), { sessionKey: SESSION_KEY, peerId: PEER_ID }, NOW)
    assert.ok(frame)
    assert.equal(frame.type, 'outbound.permission_request')
    assert.equal(frame.sessionKey, SESSION_KEY)
    assert.equal(frame.channel, 'webchat')
    assert.deepEqual(frame.peer, { id: PEER_ID, kind: 'dm' })
    assert.equal(frame.requestId, 'toolu_01')
    assert.equal(frame.toolName, 'AskUserQuestion')
    assert.equal(frame.toolUseId, 'toolu_01')
    assert.equal(frame.clientMessageId, 'm-mtk6eghg-7p-lxal')
    assert.deepEqual(frame.inputJson, row().input)
    assert.equal(typeof frame.inputPreview, 'string')
    assert.equal(frame.expiresAt, NOW + 60_000)
    assert.equal(frame.ts, NOW)
    assert.equal('frameSeq' in frame, false, 'catch-up frames must not carry a ring seq')
    assert.equal('detachedAskUser' in frame, false)
  })

  test('drops expired rows and invalid clientMessageId, marks detached ask_user', () => {
    assert.equal(
      pendingPermissionPromptToFrame(row({ expiresAt: new Date(NOW) }), { sessionKey: SESSION_KEY, peerId: PEER_ID }, NOW),
      null,
    )
    const detached = pendingPermissionPromptToFrame(
      row({ requestId: 'ask-user:abc', clientMessageId: 'cm:user:legacy', toolUseId: null }),
      { sessionKey: SESSION_KEY, peerId: PEER_ID },
      NOW,
    )
    assert.ok(detached)
    assert.equal(detached.detachedAskUser, true)
    assert.equal('clientMessageId' in detached, false)
    assert.equal('toolUseId' in detached, false)
  })
})
