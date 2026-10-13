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

  test('dashboard separates unverified index visibility, write sources, and unavailable delivery', async () => {
    const agentId = 'metric-calibration'
    const sessionKey = 'agent:metric-calibration:webchat:dm:mixed'
    const db = await getSessionsDb()
    const now = Date.now()
    const insert = db.prepare(`
      INSERT INTO memory_usage_events(
        event_id,timestamp,agent_id,session_key,turn_index,operation,memory_type,outcome,
        policy_reason,result_count,latency_ms,metadata_json,freshness_gap
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `)
    const rows: Array<[string, string, string, string, string | null, string | null]> = [
      ['idx-visibility', 'index_injected', 'system', 'success', 'turn_visibility', null],
      ['idx-bare', 'index_injected', 'system', 'success', null, '{}'],
      ['search-hit', 'core_search', 'core', 'hit', null, '{}'],
      ['native-read', 'core_read', 'core', 'success', 'native_read_tool', null],
      ['ui-save', 'core_write', 'core', 'success', 'ui', null],
      ['dream-write', 'auto_add', 'core', 'success', 'auto_dream', null],
      ['unknown-source', 'core_update', 'core', 'success', 'not_a_known_writer', null],
      ['snap-shared', 'core_write', 'core', 'success', 'turn_snapshot', 'ambiguous'],
      ['snap-unknown', 'core_delete', 'core', 'success', 'turn_snapshot', 'unknown'],
      ['snap-legacy', 'core_write', 'core', 'success', 'turn_snapshot', null],
      ['bare-profile', 'profile_write', 'profile', 'success', null, '{}'],
      ['ui-failed', 'core_write', 'core', 'error', 'ui', null],
      ['archival-miss', 'archival_search', 'archival', 'no_match', null, '{}'],
    ]
    db.transaction(() => {
      rows.forEach((row, index) => {
        const [eventId, operation, memoryType, outcome, source, attribution] = row
        let metadata = '{}'
        if (source === 'turn_visibility') metadata = JSON.stringify({ source: 'turn_visibility' })
        else if (source === 'native_read_tool') metadata = JSON.stringify({ source: 'native_read_tool' })
        else if (source === 'ui') metadata = JSON.stringify({ source: 'ui' })
        else if (source === 'auto_dream') metadata = JSON.stringify({ source: 'auto_dream' })
        else if (source === 'not_a_known_writer') metadata = JSON.stringify({ source: 'not_a_known_writer' })
        else if (source === 'turn_snapshot' && attribution === 'ambiguous') {
          metadata = JSON.stringify({ source: 'turn_snapshot', shared: true, attribution: 'ambiguous' })
        } else if (source === 'turn_snapshot' && attribution === 'unknown') {
          metadata = JSON.stringify({ source: 'turn_snapshot', attribution: 'unknown' })
        } else if (source === 'turn_snapshot') metadata = JSON.stringify({ source: 'turn_snapshot' })
        insert.run(
          eventId,
          now - index,
          agentId,
          sessionKey,
          3,
          operation,
          memoryType,
          outcome,
          null,
          operation === 'core_search' ? 1 : null,
          5,
          metadata,
          null,
        )
      })
      db.prepare(`
        INSERT INTO memory_turn_context(
          session_key,turn_index,agent_id,current_fact_intent,intent_kind,
          evidence_seen,memory_used,soft_reminder_active,freshness_gap,created_at,completed_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(sessionKey, 3, agentId, 1, 'runtime_status', 0, 1, 1, 1, now, now)
    })()

    const snapshotEvents = () =>
      JSON.stringify(
        db
          .prepare(
            `SELECT event_id,timestamp,agent_id,session_key,turn_index,operation,memory_type,outcome,
                    policy_reason,retrieval_mode,result_count,latency_ms,query_hash,query_chars,
                    top_match_hash,metadata_json,freshness_gap,reported_at
               FROM memory_usage_events WHERE agent_id=? ORDER BY event_id`,
          )
          .all(agentId),
      )
    const snapshotTurns = () =>
      JSON.stringify(
        db
          .prepare(`SELECT * FROM memory_turn_context WHERE agent_id=? ORDER BY turn_index`)
          .all(agentId),
      )
    const beforeEvents = snapshotEvents()
    const beforeTurns = snapshotTurns()
    const dashboard = await memory.getMemoryUsageDashboard({ agentId, days: 30 })
    assert.equal(snapshotEvents(), beforeEvents)
    assert.equal(snapshotTurns(), beforeTurns)

    assert.equal(
      dashboard.byOperation.some((row) => row.operation === 'index_injected'),
      false,
    )
    const searchEvents = dashboard.byOperation
      .filter((row) =>
        ['core_search', 'session_search', 'archival_search'].includes(row.operation),
      )
      .reduce((sum, row) => sum + row.events, 0)
    assert.equal(searchEvents, 2)
    assert.equal(
      dashboard.byOperation.some((row) =>
        ['core_write', 'core_update', 'core_delete', 'profile_write', 'auto_add'].includes(
          row.operation,
        ),
      ),
      false,
    )
    assert.equal(dashboard.legacyUnverifiedIndexVisibility, 2)
    assert.equal(dashboard.indexDelivery?.status, 'unavailable')
    assert.equal(dashboard.indexDelivery?.reason, 'missing_engine_acceptance_receipt')
    assert.equal('count' in (dashboard.indexDelivery ?? {}), false)
    assert.equal(JSON.stringify(dashboard.indexDelivery).includes('0'), false)
    assert.equal(dashboard.writeSources.uiUserSaves, 1)
    assert.equal(dashboard.writeSources.autoDreamWrites, 1)
    assert.equal(dashboard.writeSources.unattributedWrites, 5)
    assert.equal(dashboard.totals.confirmedOperations, 5)
    assert.equal(dashboard.totals.events, 13)
    assert.equal(dashboard.totals.hits, 1)
    assert.equal(dashboard.totals.noMatch, 1)
    assert.equal(dashboard.totals.errors, 1)
    assert.equal(dashboard.totals.sessions, 1)
    assert.equal(dashboard.totals.freshnessGaps, 1)
    assert.equal(dashboard.freshnessSignal.kind, 'mixed_shadow')
    assert.equal(dashboard.freshnessSignal.provesUsage, false)
    assert.equal(dashboard.freshnessSignal.provesDelivery, false)
    assert.equal(dashboard.freshnessSignal.provesWrongAnswer, false)
    assert.equal(dashboard.recentSessions.length, 1)
    const recent = dashboard.recentSessions[0]!
    assert.equal(recent.sessionKey, sessionKey)
    assert.equal(recent.events, 5)
    assert.equal(recent.searches, 2)
    assert.equal(recent.uiUserSaves, 1)
    assert.equal(recent.autoDreamWrites, 1)
    assert.equal(recent.unattributedWrites, 5)
    assert.equal('writes' in recent, false)
    assert.equal(JSON.stringify(dashboard).includes('RAW_QUERY_SENTINEL'), false)
    assert.equal(JSON.stringify(dashboard).includes('slug-body'), false)
  })
})
