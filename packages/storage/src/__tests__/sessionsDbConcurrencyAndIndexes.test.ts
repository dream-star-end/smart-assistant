/**
 * Regression tests for OCV5-863 T2 sessionsDb concurrency, exit-listener hygiene,
 * leading timestamp indexes, and on-demand orphan FTS pruning.
 *
 * Run: npx tsx --test packages/storage/src/__tests__/sessionsDbConcurrencyAndIndexes.test.ts
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

const home = await mkdtemp(join(tmpdir(), 'oc-sessionsdb-w2-'))
process.env.OPENCLAUDE_HOME = home

const { closeSessionsDb, getSessionsDb, insertEvent, insertUsageLog, pruneOrphanedSessionsFts } =
  await import('../sessionsDb.js')
const { paths } = await import('../paths.js')

after(async () => {
  await closeSessionsDb()
  await rm(home, { recursive: true, force: true })
})

describe('sessionsDb concurrency, cleanup & hot-path indexes', () => {
  it('single-flight getSessionsDb() returns one handle and avoids exit-listener leaks across close/reopen', async () => {
    await closeSessionsDb()
    const baseListeners = process.listenerCount('exit')

    const handles = await Promise.all([
      getSessionsDb(),
      getSessionsDb(),
      getSessionsDb(),
      getSessionsDb(),
    ])
    assert.ok(
      handles.every((h) => h === handles[0]),
      'concurrent cold calls must share one DB handle',
    )
    assert.equal(
      process.listenerCount('exit'),
      baseListeners + 1,
      'must register exactly one exit listener',
    )

    for (let i = 0; i < 4; i++) {
      await closeSessionsDb()
      assert.equal(
        process.listenerCount('exit'),
        baseListeners,
        'closeSessionsDb must unbind exit listener',
      )
      await getSessionsDb()
      assert.equal(
        process.listenerCount('exit'),
        baseListeners + 1,
        'reopen must not accumulate exit listeners',
      )
    }
  })

  it('clears _dbInitPromise on init error so subsequent open recovers cleanly', async () => {
    await closeSessionsDb()
    // Temporarily place a directory at the DB path so better-sqlite3 fails to open it.
    const originalPath = paths.sessionsDb
    const brokenPath = join(home, 'broken-db-as-dir')
    await mkdir(brokenPath, { recursive: true })
    const desc = Object.getOwnPropertyDescriptor(paths, 'sessionsDb')
    Object.defineProperty(paths, 'sessionsDb', {
      configurable: true,
      get: () => brokenPath,
    })
    try {
      await assert.rejects(() => getSessionsDb())
    } finally {
      if (desc) Object.defineProperty(paths, 'sessionsDb', desc)
      else
        Object.defineProperty(paths, 'sessionsDb', { configurable: true, get: () => originalPath })
    }

    const db = await getSessionsDb()
    assert.equal((db.prepare('SELECT 1 AS n').get() as { n: number }).n, 1)
  })

  it('creates leading timestamp indexes on event_log and usage_log used by retention deletes', async () => {
    const db = await getSessionsDb()
    const idxs = new Set(
      (
        db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{
          name: string
        }>
      ).map((r) => r.name),
    )
    assert.ok(idxs.has('idx_event_log_timestamp'), 'idx_event_log_timestamp must exist')
    assert.ok(idxs.has('idx_usage_log_timestamp'), 'idx_usage_log_timestamp must exist')

    await insertEvent({
      id: 'ev-1',
      type: 'test',
      timestamp: 100,
      agentId: 'main',
      sessionKey: 'sk',
      schemaVersion: 1,
      payload: '{}',
    })
    await insertUsageLog({
      id: 'u-1',
      sessionId: 'sk',
      agentId: 'main',
      turnIndex: 1,
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      durationMs: 1,
      toolCalls: 0,
      timestamp: 100,
    })

    const evPlan = db
      .prepare('EXPLAIN QUERY PLAN DELETE FROM event_log WHERE timestamp < ?')
      .all(50) as Array<{ detail: string }>
    const usPlan = db
      .prepare('EXPLAIN QUERY PLAN DELETE FROM usage_log WHERE timestamp < ?')
      .all(50) as Array<{ detail: string }>
    assert.ok(
      evPlan.some((r) => r.detail.includes('idx_event_log_timestamp')),
      `unexpected event_log plan: ${JSON.stringify(evPlan)}`,
    )
    assert.ok(
      usPlan.some((r) => r.detail.includes('idx_usage_log_timestamp')),
      `unexpected usage_log plan: ${JSON.stringify(usPlan)}`,
    )
  })

  it('does not scan/delete orphaned sessions_fts on startup, and prunes only via pruneOrphanedSessionsFts()', async () => {
    const db = await getSessionsDb()
    db.prepare(
      'INSERT INTO sessions_fts (session_id, turn_idx, role, content, content_fts) VALUES (?, ?, ?, ?, ?)',
    ).run('orphan-session-id', 1, 'user', 'hello orphan', 'hello orphan')

    // Reopen: startup must NOT run full-table orphan DELETE.
    await closeSessionsDb()
    const reopened = await getSessionsDb()
    const beforeCount = (
      reopened
        .prepare(`SELECT COUNT(*) AS n FROM sessions_fts WHERE session_id = 'orphan-session-id'`)
        .get() as { n: number }
    ).n
    assert.equal(beforeCount, 1, 'startup must leave orphaned FTS rows untouched')

    const removed = await pruneOrphanedSessionsFts()
    assert.ok(removed >= 1, 'explicit maintenance helper must prune orphaned FTS rows')
    const afterCount = (
      reopened
        .prepare(`SELECT COUNT(*) AS n FROM sessions_fts WHERE session_id = 'orphan-session-id'`)
        .get() as { n: number }
    ).n
    assert.equal(afterCount, 0)
  })
})
