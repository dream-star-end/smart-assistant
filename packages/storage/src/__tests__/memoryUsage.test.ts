import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

let closeSessionsDb: typeof import('../sessionsDb.js').closeSessionsDb
let getSessionsDb: typeof import('../sessionsDb.js').getSessionsDb
let memory: typeof import('../memoryUsage.js')

before(async () => {
  process.env.OPENCLAUDE_HOME = await mkdtemp(join(tmpdir(), 'memory-usage-'))
  ;({ closeSessionsDb, getSessionsDb } = await import('../sessionsDb.js'))
  memory = await import('../memoryUsage.js')
})

after(async () => {
  await closeSessionsDb()
})

describe('memory usage observability', () => {
  test('classifies current facts without treating historical questions as dynamic', () => {
    assert.deepEqual(memory.classifyCurrentFactIntent('当前服务是不是已经上线了'), {
      current: true,
      kind: 'runtime_status',
    })
    assert.equal(memory.classifyCurrentFactIntent('上次为什么这样设计').current, false)
    assert.equal(memory.classifyCurrentFactIntent('记得我的默认语言吗').current, false)
    assert.equal(
      memory.classifyCurrentFactIntent('what is the current runtime version?').current,
      true,
    )
  })

  test('records exact operations without persisting raw query or session key centrally', async () => {
    const sessionKey = 'agent:main:webchat:dm:memory-usage-test'
    await memory.beginMemoryTurnObservation({
      sessionKey,
      turnIndex: 1,
      agentId: 'main',
      userText: '现在部署的是哪个版本',
    })
    await memory.recordMemoryUsageEvent({
      eventId: 'event-1',
      agentId: 'main',
      sessionKey,
      turnIndex: 1,
      operation: 'core_search',
      memoryType: 'core',
      outcome: 'hit',
      retrievalMode: 'lexical',
      resultCount: 1,
      latencyMs: 12,
      query: '秘密项目当前版本',
      topMatchKey: '/memory/secret.md',
    })
    await memory.completeMemoryTurnObservation(sessionKey, 1)
    const pending = await memory.listPendingMemoryUsageEvents()
    assert.equal(pending.length, 1)
    assert.equal(pending[0]!.sessionKey, sessionKey)
    assert.match(pending[0]!.sessionHash ?? '', /^[0-9a-f]{64}$/)
    assert.match(pending[0]!.queryHash ?? '', /^[0-9a-f]{64}$/)
    assert.equal(pending[0]!.freshnessGap, true)
    const db = await getSessionsDb()
    const raw = db.prepare('SELECT query_hash,metadata_json FROM memory_usage_events').get() as {
      query_hash: string
      metadata_json: string
    }
    assert.doesNotMatch(JSON.stringify(raw), /秘密项目|secret\.md/)
    const dashboard = await memory.getMemoryUsageDashboard({ agentId: 'main', days: 30 })
    assert.equal(dashboard.totals.events, 1)
    assert.equal(dashboard.totals.freshnessGaps, 1)
    await memory.markMemoryUsageEventsReported(['event-1'])
    assert.equal((await memory.listPendingMemoryUsageEvents()).length, 0)
  })

  test('same-turn current evidence closes the freshness gap', async () => {
    const sessionKey = 'agent:main:webchat:dm:memory-evidence-test'
    await memory.beginMemoryTurnObservation({
      sessionKey,
      turnIndex: 2,
      agentId: 'main',
      userText: '当前运行版本是什么',
    })
    await memory.recordMemoryUsageEvent({
      eventId: 'event-2',
      agentId: 'main',
      sessionKey,
      turnIndex: 2,
      operation: 'core_search',
      memoryType: 'core',
      outcome: 'hit',
    })
    await memory.markMemoryTurnEvidence(sessionKey, 2)
    await memory.completeMemoryTurnObservation(sessionKey, 2)
    const dashboard = await memory.getMemoryUsageDashboard({ agentId: 'main', days: 30 })
    assert.equal(dashboard.totals.freshnessGaps, 1)
  })
})
