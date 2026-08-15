/**
 * insertUsageLog: distinguish inserted vs idempotent duplicate vs conflicting
 * duplicate, and migrate terminal_status onto an old usage_log table.
 *
 * Run: npx tsx --test packages/storage/src/__tests__/insertUsageLog.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import Database from 'better-sqlite3'

const testHome = await mkdtemp(join(tmpdir(), 'oc-insert-usage-'))
process.env.OPENCLAUDE_HOME = testHome

{
  const legacy = new Database(join(testHome, 'sessions.db'))
  legacy.exec(`
    CREATE TABLE usage_log (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      turn_index INTEGER NOT NULL,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_usage_log_dedup ON usage_log(session_id, turn_index);
  `)
  legacy.close()
}

const { getSessionsDb, insertUsageLog, loadSessionUsage } = await import('../sessionsDb.js')

function entry(over: Partial<{
  id: string
  sessionId: string
  turnIndex: number
  durationMs: number
  toolCalls: number
  inputTokens: number
  terminalStatus: 'completed' | 'crashed' | 'reconciled'
}> = {}) {
  return {
    id: over.id ?? 'u-1',
    sessionId: over.sessionId ?? 'sess-a',
    agentId: 'main',
    turnIndex: over.turnIndex ?? 1,
    model: 'm',
    inputTokens: over.inputTokens ?? 1,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    durationMs: over.durationMs ?? 10,
    toolCalls: over.toolCalls ?? 0,
    timestamp: 1,
    terminalStatus: over.terminalStatus ?? 'completed' as const,
  }
}

describe('insertUsageLog', () => {
  it('migrates terminal_status onto a legacy usage_log table', async () => {
    const db = await getSessionsDb()
    const cols = db.pragma('table_info(usage_log)') as Array<{ name: string }>
    assert.ok(cols.some((c) => c.name === 'terminal_status'))
  })

  it('inserts a new row and reports inserted', async () => {
    const result = await insertUsageLog(entry())
    assert.deepEqual(result, { status: 'inserted' })
    const rows = await loadSessionUsage('sess-a')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.terminalStatus, 'completed')
  })

  it('same session+turn is an idempotent duplicate', async () => {
    const result = await insertUsageLog(entry({ id: 'u-1-retry' }))
    assert.equal(result.status, 'duplicate')
    if (result.status === 'duplicate') assert.equal(result.conflict, false)
    const rows = await loadSessionUsage('sess-a')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.id, 'u-1')
  })

  it('same session+turn with different counters is a conflicting duplicate', async () => {
    const result = await insertUsageLog(entry({
      id: 'u-1-conflict',
      durationMs: 999,
      toolCalls: 50,
      inputTokens: 99,
    }))
    assert.equal(result.status, 'duplicate')
    if (result.status === 'duplicate') assert.equal(result.conflict, true)
    const rows = await loadSessionUsage('sess-a')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.durationMs, 10)
  })

  it('reconciled status is stored', async () => {
    const result = await insertUsageLog(entry({
      id: 'u-2',
      sessionId: 'sess-b',
      turnIndex: 2,
      terminalStatus: 'reconciled',
    }))
    assert.deepEqual(result, { status: 'inserted' })
    const rows = await loadSessionUsage('sess-b')
    assert.equal(rows[0]!.terminalStatus, 'reconciled')
  })
})
