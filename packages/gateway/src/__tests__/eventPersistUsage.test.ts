/**
 * eventPersist writes exactly one usage_log row per turn.completed, including
 * abnormal terminalStatus values, and distinguishes duplicate vs hard failure.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/eventPersistUsage.test.ts
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createEvent } from '../eventBus.js'

const testHome = await mkdtemp(join(tmpdir(), 'oc-event-persist-usage-'))
process.env.OPENCLAUDE_HOME = testHome

const { persistTurnCompletedUsage } = await import('../eventPersist.js')
const { getSessionsDb, loadSessionUsage } = await import('@openclaude/storage')

function turnEvent(over: {
  sessionKey?: string
  turnIndex?: number
  terminalStatus?: 'completed' | 'error' | 'crashed' | 'aborted' | 'stopped' | 'timeout'
  durationMs?: number
  toolCalls?: number
  id?: string
}) {
  return createEvent('turn.completed', 'main', {
    sessionKey: over.sessionKey ?? 'agent:main:webchat:dm:persist-peer',
    turnIndex: over.turnIndex ?? 1,
    usage: { inputTokens: 11, outputTokens: 5, costUsd: 0.02, model: 'm' },
    toolCalls: over.toolCalls ?? 2,
    durationMs: over.durationMs ?? 4000,
    terminalStatus: over.terminalStatus ?? 'completed',
  })
}

describe('persistTurnCompletedUsage', () => {
  test('completed / crashed / stopped / timeout / abort / error each insert one row', async () => {
    const cases = [
      { sessionKey: 'agent:main:webchat:dm:p-complete', terminalStatus: 'completed' as const },
      { sessionKey: 'agent:main:webchat:dm:p-crash', terminalStatus: 'crashed' as const },
      { sessionKey: 'agent:main:webchat:dm:p-stop', terminalStatus: 'stopped' as const },
      { sessionKey: 'agent:main:webchat:dm:p-timeout', terminalStatus: 'timeout' as const },
      { sessionKey: 'agent:main:webchat:dm:p-abort', terminalStatus: 'aborted' as const },
      { sessionKey: 'agent:main:webchat:dm:p-error', terminalStatus: 'error' as const },
    ]
    for (const c of cases) await persistTurnCompletedUsage(turnEvent(c))
    await getSessionsDb()
    for (const c of cases) {
      const rows = await loadSessionUsage(c.sessionKey)
      assert.equal(rows.length, 1, c.sessionKey)
      assert.equal(rows[0]!.terminalStatus, c.terminalStatus)
      assert.equal(rows[0]!.toolCalls, 2)
      assert.equal(rows[0]!.durationMs, 4000)
    }
  })

  test('duplicate (session_id, turn_index) is ignored and does not add a second row', async () => {
    const sessionKey = 'agent:main:webchat:dm:p-dedup'
    await persistTurnCompletedUsage(turnEvent({ sessionKey, turnIndex: 3, durationMs: 100, toolCalls: 1 }))
    await persistTurnCompletedUsage(turnEvent({ sessionKey, turnIndex: 3, durationMs: 99999, toolCalls: 88 }))
    const rows = await loadSessionUsage(sessionKey)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.durationMs, 100)
    assert.equal(rows[0]!.toolCalls, 1)
  })
})
