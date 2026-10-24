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

const { getSessionsDb, insertUsageLog, loadSessionUsage, loadSessionUsageModels } = await import('../sessionsDb.js')

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

describe('bounded actual session models', () => {
  it('returns all recorded models in one indexed batch, with no defaults or unrelated sessions', async () => {
    const db = await getSessionsDb()
    const add = db.prepare(`INSERT INTO usage_log (id,session_id,agent_id,turn_index,model,timestamp) VALUES (?,?, 'main',?,?,?)`)
    add.run('models-a1', 'models-a', 1, 'actual-a', 10)
    add.run('models-a2', 'models-a', 2, 'actual-b', 20)
    add.run('models-a3', 'models-a', 3, 'actual-a', 30)
    add.run('models-b1', 'models-b', 1, 'actual-c', 5)
    add.run('models-b2', 'models-b', 2, null, 6)
    add.run('models-b3', 'models-b', 3, 'auto', 7)
    add.run('models-b4', 'models-b', 4, '', 8)
    add.run('models-other', 'models-unrelated', 1, 'must-not-return', 1)
    const models = await loadSessionUsageModels(['models-b', 'models-a', 'models-a', 'models-empty'])
    assert.deepEqual({ ...models }, { 'models-a': ['actual-a', 'actual-b'], 'models-b': ['actual-c'] })
    assert.equal(models['models-unrelated'], undefined)
    assert.deepEqual({ ...await loadSessionUsageModels([]) }, {})
    assert.deepEqual({ ...await loadSessionUsageModels(Array.from({ length: 200 }, (_, i) => `absent-${i}`)) }, {})
    await assert.rejects(loadSessionUsageModels(Array.from({ length: 201 }, (_, i) => `absent-${i}`)), RangeError)
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT session_id,model,MIN(timestamp) FROM usage_log WHERE session_id IN (?,?) AND model IS NOT NULL AND model<>'' AND model<>'auto' GROUP BY session_id,model ORDER BY session_id,MIN(timestamp),model`).all('models-a','models-b') as Array<{ detail: string }>
    assert.ok(plan.some((row) => /SEARCH usage_log USING INDEX/.test(row.detail)), JSON.stringify(plan))
  })
})
