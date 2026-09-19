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

  test('strips system-injected guard/continuation text before current-fact classification', () => {
    const guard = `<oc-efficiency-guard>
平台效率护栏(本轮提醒,不是用户原话):
- 纠正: 不要轮询现网服务运行状态或线上 release。
</oc-efficiency-guard>`
    const transientRetry = '上一条消息因上游瞬时错误中断，请继续完成该任务。'
    const recoveryPrefix =
      '继续完成刚才因临时异常中断的任务。以本会话中已经生成并持久化的思考、工具结果和部分回答为依据，从断点继续。'
    const recoveryFull =
      '继续完成刚才因临时异常中断的任务。以本会话中已经生成并持久化的思考、工具结果和部分回答为依据，从断点继续。这是一条断点续接指令，不是重放原始请求：不要重新执行已经完成的步骤，不要重复已经输出的内容。若中断前有外部写操作或部署操作，先查询其当前可观察状态（如 release 指针、进程、日志、健康检查或目标资源）并据此继续。只有在无法通过查询区分成功或失败、且重复执行可能造成不可逆后果时，才明确说明具体无法确认的操作和风险，并仅询问完成任务所必需的决定；不要泛泛要求用户再说“继续”。'

    assert.equal(memory.stripSystemInjectedPrefix(`${guard}\n\n帮我解释这段代码`), '帮我解释这段代码')
    assert.equal(memory.classifyCurrentFactIntent(`${guard}\n\n帮我解释这段代码`).current, false)
    assert.deepEqual(memory.classifyCurrentFactIntent(`${guard}\n\n当前 healthz 状态`), {
      current: true,
      kind: 'runtime_status',
    })
    assert.deepEqual(memory.classifyCurrentFactIntent(`${guard}\n\nhealthz`), {
      current: true,
      kind: 'direct_status',
    })

    assert.deepEqual(memory.classifyCurrentFactIntent(transientRetry), { current: false, kind: null })
    assert.deepEqual(memory.classifyCurrentFactIntent(recoveryPrefix), { current: false, kind: null })
    assert.deepEqual(memory.classifyCurrentFactIntent(recoveryFull), { current: false, kind: null })
    assert.equal(memory.stripSystemInjectedPrefix(transientRetry), '')
    assert.equal(memory.stripSystemInjectedPrefix(recoveryPrefix), '')
    assert.equal(memory.stripSystemInjectedPrefix(recoveryFull), '')

    assert.equal(memory.classifyCurrentFactIntent(`${transientRetry}\n\n帮我解释这段代码`).current, false)
    assert.deepEqual(
      memory.classifyCurrentFactIntent(`${transientRetry}\n\n当前 healthz 状态`),
      memory.classifyCurrentFactIntent('当前 healthz 状态'),
    )
    assert.deepEqual(
      memory.classifyCurrentFactIntent(`${recoveryPrefix}\n\n当前 healthz 状态`),
      memory.classifyCurrentFactIntent('当前 healthz 状态'),
    )
    assert.deepEqual(
      memory.classifyCurrentFactIntent(`${recoveryFull}\n\n帮我解释这段代码`),
      { current: false, kind: null },
    )
    assert.deepEqual(
      memory.classifyCurrentFactIntent(`${recoveryFull}\n\n当前 healthz 状态`),
      memory.classifyCurrentFactIntent('当前 healthz 状态'),
    )
    assert.equal(memory.classifyCurrentFactIntent(`${guard}\n\n${transientRetry}`).current, false)
    assert.deepEqual(memory.RECOVERY_CONTINUATION_PREFIXES, [transientRetry, recoveryPrefix])
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
