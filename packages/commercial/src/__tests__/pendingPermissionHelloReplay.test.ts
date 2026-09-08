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
  HELLO_PENDING_PERMISSION_MAX_SESSIONS,
  HELLO_PENDING_PERMISSION_MAX_TOTAL_ROWS,
  PERMISSION_PROMPT_LOOKUP_MAX_IDS,
  PERMISSION_PROMPT_SNAPSHOT_LIMIT,
  parsePermissionLookupIds,
  pendingPermissionPromptToFrame,
  readPendingPermissionPrompts,
  readPendingPermissionPromptsForSessions,
  readPermissionPromptSnapshot,
  readPermissionPromptsByRequestIds,
  selectHelloPermissionSessions,
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
    assert.match(sql, /FROM turn_permission_requests p/)
    assert.match(sql, /p\.user_id=\$1 AND p\.session_id=\$2 AND p\.status='pending' AND p\.expires_at>NOW\(\)/)
    assert.deepEqual(params, ['3', PEER_ID, HELLO_PENDING_PERMISSION_MAX_ROWS])
    assert.deepEqual(rows.map((r) => r.requestId), ['toolu_01', 'ask-user:abc'])
    assert.deepEqual(rows[1]!.input, { questions: [{ question: 'q' }] })
    assert.equal(rows[1]!.expiresAt.getTime(), NOW + 120_000)
  })

  test('INC-…-ZOMBIE: excludes prompts of turns the user already stopped, but never detached ask_user', async () => {
    let sql = ''
    const pool = {
      async query(text: string) { sql = text.replace(/\s+/g, ' ').trim(); return { rows: [], rowCount: 0 } },
    } as unknown as Pool
    await readPendingPermissionPrompts(pool, { userId: 3n, sessionId: PEER_ID })
    // Detached prompts and legacy rows without a turn are always replayed.
    assert.match(sql, /p\.request_id LIKE 'ask-user:%' OR p\.client_message_id IS NULL/)
    // A live (non-cancelled) durable Stop for the prompt's turn hides the row.
    assert.match(sql, /NOT EXISTS \( SELECT 1 FROM turn_control_requests c/)
    assert.match(sql, /c\.kind='stop' AND c\.status<>'cancelled'/)
    assert.match(sql, /c\.root_client_message_id=p\.client_message_id/)
    // A peer-wide Stop (null root) issued after the prompt was created also hides it.
    assert.match(sql, /c\.root_client_message_id IS NULL AND c\.created_at>=p\.created_at/)
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

describe('readPendingPermissionPromptsForSessions', () => {
  test('single SQL with = ANY($2::text[]), deduped sessions, rows grouped per session', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const pool = {
      async query(sql: string, params: unknown[]) {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
        return {
          rows: [
            {
              session_id: PEER_ID,
              request_id: 'toolu_01',
              client_message_id: 'm-mtk6eghg-7p-lxal',
              tool_use_id: 'toolu_01',
              tool_name: 'AskUserQuestion',
              input_json: { questions: [] },
              expires_at: new Date(NOW + 60_000),
            },
            {
              session_id: 'other-session',
              request_id: 'ask-user:abc',
              client_message_id: null,
              tool_use_id: null,
              tool_name: 'AskUserQuestion',
              input_json: JSON.stringify({ questions: [{ question: 'q' }] }),
              expires_at: new Date(NOW + 120_000).toISOString(),
            },
            {
              session_id: 'other-session',
              request_id: 'broken',
              client_message_id: null,
              tool_use_id: null,
              tool_name: 'Bash',
              input_json: '{not json',
              expires_at: new Date(NOW + 60_000),
            },
          ],
          rowCount: 3,
        }
      },
    } as unknown as Pool
    const grouped = await readPendingPermissionPromptsForSessions(pool, {
      userId: 3n,
      sessionIds: [PEER_ID, 'other-session', PEER_ID, ''],
    })
    assert.equal(calls.length, 1)
    const { sql, params } = calls[0]!
    assert.match(sql, /FROM turn_permission_requests p/)
    assert.match(sql, /p\.session_id = ANY\(\$2::text\[\]\)/)
    assert.match(sql, /p\.user_id=\$1 AND p\.session_id = ANY\(\$2::text\[\]\) AND p\.status='pending' AND p\.expires_at>NOW\(\)/)
    assert.match(sql, /NOT EXISTS \(\s*SELECT 1 FROM turn_control_requests c/)
    assert.deepEqual(params, ['3', [PEER_ID, 'other-session'], 16])
    assert.deepEqual([...grouped.keys()].sort(), ['other-session', PEER_ID])
    assert.deepEqual(grouped.get(PEER_ID)!.map((r) => r.requestId), ['toolu_01'])
    assert.deepEqual(grouped.get('other-session')!.map((r) => r.requestId), ['ask-user:abc'])
  })

  test('empty session list never queries the database', async () => {
    let queried = 0
    const pool = {
      async query() { queried += 1; return { rows: [], rowCount: 0 } },
    } as unknown as Pool
    const grouped = await readPendingPermissionPromptsForSessions(pool, { userId: 3n, sessionIds: [] })
    assert.equal(queried, 0)
    assert.equal(grouped.size, 0)
  })

  test('truncates sessions at HELLO_PENDING_PERMISSION_MAX_SESSIONS and clamps the total LIMIT', async () => {
    const seen: unknown[][] = []
    const pool = {
      async query(_sql: string, params: unknown[]) { seen.push(params); return { rows: [], rowCount: 0 } },
    } as unknown as Pool
    const many = Array.from({ length: HELLO_PENDING_PERMISSION_MAX_SESSIONS + 5 }, (_, i) => `s-${i}`)
    await readPendingPermissionPromptsForSessions(pool, { userId: 3n, sessionIds: many })
    assert.equal((seen[0]![1] as string[]).length, HELLO_PENDING_PERMISSION_MAX_SESSIONS)
    assert.equal(seen[0]![2], HELLO_PENDING_PERMISSION_MAX_TOTAL_ROWS)
  })
})

describe('readPermissionPromptSnapshot', () => {
  const REAL_NOW = Date.now()
  function snapshotRow(overrides: Record<string, unknown> = {}) {
    return {
      request_id: 'toolu_01',
      client_message_id: 'm-mtk6eghg-7p-lxal',
      tool_use_id: 'toolu_01',
      tool_name: 'AskUserQuestion',
      input_json: { questions: [] },
      response_json: null,
      status: 'pending',
      expires_at: new Date(REAL_NOW + 60_000),
      created_at: new Date(REAL_NOW - 60_000),
      updated_at: new Date(REAL_NOW - 30_000),
      ...overrides,
    }
  }

  test('does not filter by status and orders newest first', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const pool = {
      async query(sql: string, params: unknown[]) {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Pool
    await readPermissionPromptSnapshot(pool, { userId: 3n, sessionId: PEER_ID })
    const { sql, params } = calls[0]!
    assert.equal(calls.length, 1)
    assert.match(sql, /FROM turn_permission_requests/)
    assert.match(sql, /WHERE user_id=\$1 AND session_id=\$2/)
    assert.match(sql, /response_json,status/)
    assert.doesNotMatch(sql, /status\s*(=|IN|<>)/)
    assert.match(sql, /ORDER BY created_at DESC/)
    assert.match(sql, /LIMIT \$3/)
    assert.deepEqual(params, ['3', PEER_ID, PERMISSION_PROMPT_SNAPSHOT_LIMIT])
  })

  test('reports pending+expired rows as expired; keeps live pending rows pending with null response', async () => {
    const pool = {
      async query() {
        return {
          rows: [
            snapshotRow({ request_id: 'stale', expires_at: new Date(REAL_NOW - 1_000) }),
            snapshotRow({ request_id: 'db-expired', status: 'expired' }),
            snapshotRow({ request_id: 'live' }),
          ],
          rowCount: 3,
        }
      },
    } as unknown as Pool
    const snapshot = await readPermissionPromptSnapshot(pool, { userId: 3n, sessionId: PEER_ID })
    assert.deepEqual(snapshot.items.map((e) => e.status), ['expired', 'expired', 'pending'])
    assert.equal(snapshot.completeness, 'complete')
    assert.equal(snapshot.items[2]!.response, null)
    assert.deepEqual(snapshot.items[0]!.response, { behavior: 'deny', reason: null, answers: null })
  })

  test('marks truncated when the page is full, and maps responded as acceptance not execution', async () => {
    const pool = {
      async query() {
        return {
          rows: Array.from({ length: PERMISSION_PROMPT_SNAPSHOT_LIMIT }, (_, i) => snapshotRow({
            request_id: `r-${i}`,
            status: i === 0 ? 'responded' : 'pending',
            response_json: i === 0 ? { behavior: 'allow', reason: 'tab-a' } : null,
          })),
          rowCount: PERMISSION_PROMPT_SNAPSHOT_LIMIT,
        }
      },
    } as unknown as Pool
    const snapshot = await readPermissionPromptSnapshot(pool, { userId: 3n, sessionId: PEER_ID })
    assert.equal(snapshot.completeness, 'truncated')
    assert.equal(snapshot.items[0]!.status, 'responded')
    assert.equal(snapshot.items[0]!.response?.behavior, 'allow')
  })

  test('query failure yields unavailable rather than forging settled rows', async () => {
    const pool = {
      async query() { throw new Error('timeout') },
    } as unknown as Pool
    const snapshot = await readPermissionPromptSnapshot(pool, { userId: 3n, sessionId: PEER_ID })
    assert.deepEqual(snapshot, { items: [], completeness: 'unavailable', source: 'pg' })
  })
})

describe('readPermissionPromptsByRequestIds', () => {
  test('uses the primary key path and isolates by session', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const pool = {
      async query(sql: string, params: unknown[]) {
        calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Pool
    await readPermissionPromptsByRequestIds(pool, {
      userId: 3n,
      sessionId: PEER_ID,
      requestIds: ['a', 'a', 'b', ''],
    })
    const { sql, params } = calls[0]!
    assert.match(sql, /request_id = ANY\(\$2::text\[\]\)/)
    assert.match(sql, /session_id=\$3/)
    assert.deepEqual(params, ['3', ['a', 'b'], PEER_ID])
  })

  test('clamps lookup ids', async () => {
    const seen: unknown[][] = []
    const pool = {
      async query(_sql: string, params: unknown[]) { seen.push(params); return { rows: [], rowCount: 0 } },
    } as unknown as Pool
    const many = Array.from({ length: PERMISSION_PROMPT_LOOKUP_MAX_IDS + 4 }, (_, i) => `id-${i}`)
    await readPermissionPromptsByRequestIds(pool, { userId: 3n, sessionId: PEER_ID, requestIds: many })
    assert.equal((seen[0]![1] as string[]).length, PERMISSION_PROMPT_LOOKUP_MAX_IDS)
  })
})

describe('selectHelloPermissionSessions', () => {
  test('decouples from the live-catchup 8-session cap and prioritises in-flight', () => {
    const peers = Array.from({ length: 12 }, (_, i) => ({
      peerId: `s-${i}`,
      inFlight: i === 11,
    }))
    const selected = selectHelloPermissionSessions(peers, { maxSessions: 8 })
    assert.equal(selected.sessions[0]!.peerId, 's-11')
    assert.equal(selected.sessions.length, 8)
    assert.equal(selected.truncated, true)
    assert.equal(selected.omitted, 4)
    assert.equal(selected.scanned, 8)
  })

  test('does not silently drop session 9 when the cap is 32', () => {
    const peers = Array.from({ length: 9 }, (_, i) => ({ peerId: `s-${i}` }))
    const selected = selectHelloPermissionSessions(peers)
    assert.equal(selected.truncated, false)
    assert.equal(selected.sessions.length, 9)
    assert.ok(selected.sessions.some((s) => s.peerId === 's-8'))
  })
})

describe('parsePermissionLookupIds', () => {
  test('splits, trims, dedupes, and caps', () => {
    assert.deepEqual(parsePermissionLookupIds('a, a, b'), ['a', 'b'])
    assert.deepEqual(parsePermissionLookupIds(''), [])
    assert.equal(parsePermissionLookupIds(Array.from({ length: 20 }, (_, i) => `id${i}`).join(','))!.length, 16)
  })
})
