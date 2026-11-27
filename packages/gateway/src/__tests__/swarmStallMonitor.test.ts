/**
 * Tests for OCV5-848 zero-token deterministic SwarmStallMonitor and its
 * end-to-end integration with AntigravitySwarmWatcher + injectSwarmDirective.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/swarmStallMonitor.test.ts
 */
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { extractSwarmMentions, type SwarmMemberSnapshot, type SwarmSnapshot } from '@openclaude/protocol'

import {
  AntigravitySwarmWatcher,
  normalizeSwarmToolName,
  parseMemberTranscriptTail,
  readAntigravitySwarmSnapshot,
} from '../engine/antigravitySwarmWatcher.js'
import {
  GATEWAY_STALL_MONITOR_AGENT,
  SwarmStallMonitor,
  isMemberEffectivelyWaiting,
  isSwarmMonitorAgentName,
  type SwarmStallAlert,
  type SwarmStallDiagnosticEvent,
} from '../engine/swarmStallMonitor.js'
import { injectSwarmDirective } from '../swarmCommand.js'

const CONV_ID = '11111111-2222-3333-4444-555555555555'
const WORKER_CONV_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

function makeMember(partial: Partial<SwarmMemberSnapshot> & Pick<SwarmMemberSnapshot, 'name' | 'role'>): SwarmMemberSnapshot {
  return {
    status: 'waiting',
    stepCount: 1,
    unreadCount: 0,
    ...partial,
  }
}

function makeSnapshot(partial?: Partial<SwarmSnapshot>): SwarmSnapshot {
  return {
    swarmId: CONV_ID,
    title: '测试蜂群',
    phase: 'running',
    revision: 1,
    updatedAt: 1_000,
    members: [
      makeMember({ name: 'coordinator', role: 'coordinator', status: 'waiting', lastPostSeq: 1 }),
      makeMember({ name: 'worker-a', role: 'worker', status: 'waiting', lastPostSeq: 0 }),
    ],
    channels: [{ name: 'main', memberCount: 2, postCount: 1 }],
    posts: [
      {
        seq: 1,
        agent: 'coordinator',
        channel: 'main',
        text: '@worker-a 请开始任务',
        mentions: ['worker-a'],
      },
    ],
    totalPosts: 1,
    ...partial,
  }
}

test('OCV5-848: idle/working checks produce zero alerts and [done] silences cross-stage until new work starts', () => {
  const mon = new SwarmStallMonitor({ stallThresholdMs: 180_000, retryCooldownMs: 540_000, maxAlerts: 3 })

  // 1. Worker actively working -> never alerts even after 30 minutes
  const workingSnap = makeSnapshot({
    members: [
      makeMember({ name: 'coordinator', role: 'coordinator', status: 'working', activity: '等待讨论板消息' }),
      makeMember({ name: 'worker-a', role: 'worker', status: 'working', activity: '运行命令' }),
    ],
  })
  assert.equal(mon.evaluate(workingSnap, 0), null)
  assert.equal(mon.evaluate(workingSnap, 1_800_000), null)

  // 2. Coordinator posts [done] -> waiting forever produces zero alerts
  const doneSnap = makeSnapshot({
    members: [
      makeMember({ name: 'coordinator', role: 'coordinator', status: 'waiting', lastPostSeq: 2 }),
      makeMember({ name: 'worker-a', role: 'worker', status: 'waiting', lastPostSeq: 1 }),
    ],
    posts: [
      { seq: 1, agent: 'worker-a', channel: 'main', text: '@coordinator 完成', mentions: ['coordinator'] },
      { seq: 2, agent: 'coordinator', channel: 'main', text: '[done] 第一阶段完成', mentions: [] },
    ],
    totalPosts: 2,
  })
  assert.equal(mon.evaluate(doneSnap, 1_801_000), null)
  assert.equal(mon.evaluate(doneSnap, 9_999_000), null)

  // 3. New stage begins after [done] (seq 3 > doneSeq 2) and stalls -> alerts cleanly for stage 2 only
  const stage2Snap = makeSnapshot({
    members: [
      makeMember({ name: 'coordinator', role: 'coordinator', status: 'working', activity: '等待讨论板消息', lastPostSeq: 3 }),
      makeMember({ name: 'worker-a', role: 'worker', status: 'waiting', lastPostSeq: 1 }),
    ],
    posts: [
      ...doneSnap.posts,
      { seq: 3, agent: 'coordinator', channel: 'main', text: '@worker-a 开始第二阶段', mentions: ['worker-a'] },
    ],
    totalPosts: 3,
  })
  // First observation seeds new progress timestamp at 10_000_000
  assert.equal(mon.evaluate(stage2Snap, 10_000_000), null)
  // Still under 3 min threshold -> null
  assert.equal(mon.evaluate(stage2Snap, 10_179_000), null)
  // Reaches 3 min -> detects unanswered mention in stage 2 (even though coordinator shows swarm_wait working)
  const alert = mon.evaluate(stage2Snap, 10_180_000)
  assert.ok(alert)
  assert.equal(alert.target, 'worker-a')
  assert.equal(alert.reason, 'unanswered_mention')
  assert.deepEqual(alert.citedSeqs, [3])
  assert.ok(alert.message.startsWith('@worker-a [stall]'))
})

test('OCV5-848: unanswered @mention escalates to coordinator after cooldown, ignores self-posts, and stops after maxAlerts', () => {
  const mon = new SwarmStallMonitor({ stallThresholdMs: 60_000, retryCooldownMs: 120_000, maxAlerts: 3 })
  const base = makeSnapshot()

  assert.equal(mon.evaluate(base, 0), null)
  // Attempt 1: direct re-ping to worker-a
  const a1 = mon.evaluate(base, 60_000)
  assert.ok(a1)
  assert.equal(a1.target, 'worker-a')
  assert.equal(a1.reason, 'unanswered_mention')
  assert.equal(a1.attempt, 1)

  // Injecting gateway-monitor's own post and bumping unreadCount must NOT reset stall backoff
  const afterSelfPost: SwarmSnapshot = {
    ...base,
    members: base.members.map((m) => ({ ...m, unreadCount: m.unreadCount + 1 })),
    posts: [
      ...base.posts,
      {
        seq: 2,
        agent: GATEWAY_STALL_MONITOR_AGENT,
        channel: 'main',
        text: a1.message,
        mentions: ['worker-a'],
      },
    ],
    totalPosts: 2,
  }
  // Inside cooldown -> null
  assert.equal(mon.evaluate(afterSelfPost, 120_000), null)

  // Attempt 2 after cooldown -> escalates to @coordinator without @mentioning worker-a
  const a2 = mon.evaluate(afterSelfPost, 180_000)
  assert.ok(a2)
  assert.equal(a2.target, 'coordinator')
  assert.equal(a2.reason, 'unanswered_mention_escalated')
  assert.equal(a2.attempt, 2)
  assert.ok(!a2.message.includes('@worker-a'), 'escalation must not @mention worker-a')
  assert.ok(a2.message.includes('`worker-a`'))

  // Attempt 3 after another cooldown
  const a3 = mon.evaluate(afterSelfPost, 300_000)
  assert.ok(a3)
  assert.equal(a3.attempt, 3)

  // Attempt 4 -> capped at maxAlerts=3 (silent)
  assert.equal(mon.evaluate(afterSelfPost, 900_000), null)

  // Genuine progress resets counter
  const resumed: SwarmSnapshot = {
    ...afterSelfPost,
    posts: [
      ...afterSelfPost.posts,
      { seq: 3, agent: 'worker-a', channel: 'main', text: '我回来了', mentions: [] },
    ],
    members: [
      makeMember({ name: 'coordinator', role: 'coordinator', status: 'waiting', lastPostSeq: 1, unreadCount: 2 }),
      makeMember({ name: 'worker-a', role: 'worker', status: 'waiting', lastPostSeq: 3, stepCount: 2 }),
    ],
    totalPosts: 3,
  }
  assert.equal(mon.evaluate(resumed, 910_000), null)
  const freshAlert = mon.evaluate(resumed, 970_000)
  assert.ok(freshAlert)
  assert.equal(freshAlert.attempt, 1)
  assert.equal(freshAlert.target, 'coordinator')
  assert.equal(freshAlert.reason, 'unclaimed_result')
  assert.deepEqual(freshAlert.citedSeqs, [3])
})

test('OCV5-848: diagnoses failed worker, non-main channel stall, and idle waiting fallback accurately', () => {
  // 1. Failed worker
  const m1 = new SwarmStallMonitor({ stallThresholdMs: 10_000 })
  const failedSnap = makeSnapshot({
    members: [
      makeMember({ name: 'coordinator', role: 'coordinator', status: 'waiting', lastPostSeq: 1 }),
      makeMember({ name: 'builder', role: 'worker', status: 'waiting', failed: true, lastError: 'quota exhausted' }),
    ],
  })
  assert.equal(m1.evaluate(failedSnap, 0), null)
  const a1 = m1.evaluate(failedSnap, 10_000)
  assert.ok(a1)
  assert.equal(a1.target, 'coordinator')
  assert.equal(a1.reason, 'member_failed')
  assert.ok(a1.message.includes('quota exhausted'))
  assert.ok(!a1.message.includes('@builder'))

  // 2. Non-main channel stall
  const m2 = new SwarmStallMonitor({ stallThresholdMs: 10_000 })
  const chSnap = makeSnapshot({
    members: [
      makeMember({ name: 'coordinator', role: 'coordinator', status: 'waiting', lastPostSeq: 2, unreadCount: 0 }),
      makeMember({ name: 'parser', role: 'worker', status: 'waiting', channels: ['parser'], lastPostSeq: 2 }),
    ],
    channels: [
      { name: 'main', memberCount: 2, postCount: 1 },
      { name: 'parser', memberCount: 1, postCount: 1 },
    ],
    posts: [
      { seq: 1, agent: 'coordinator', channel: 'main', text: 'start', mentions: [] },
      { seq: 2, agent: 'coordinator', channel: 'parser', text: 'status check', mentions: [] },
    ],
    totalPosts: 2,
  })
  assert.equal(m2.evaluate(chSnap, 0), null)
  const a2 = m2.evaluate(chSnap, 10_000)
  assert.ok(a2)
  assert.equal(a2.target, 'coordinator')
  assert.equal(a2.reason, 'channel_stalled')
  assert.ok(a2.message.includes('#parser'))

  // 3. Idle waiting fallback
  const m3 = new SwarmStallMonitor({ stallThresholdMs: 10_000 })
  const idleSnap = makeSnapshot({
    members: [
      makeMember({ name: 'coordinator', role: 'coordinator', status: 'waiting', lastPostSeq: 1, unreadCount: 0 }),
      makeMember({ name: 'worker-a', role: 'worker', status: 'waiting', lastPostSeq: 1 }),
    ],
    posts: [{ seq: 1, agent: 'coordinator', channel: 'main', text: '已确认开始', mentions: [] }],
  })
  assert.equal(m3.evaluate(idleSnap, 0), null)
  const a3 = m3.evaluate(idleSnap, 10_000)
  assert.ok(a3)
  assert.equal(a3.target, 'coordinator')
  assert.equal(a3.reason, 'idle_waiting')

  // Helper checks
  assert.equal(isSwarmMonitorAgentName('monitor'), true)
  assert.equal(isSwarmMonitorAgentName('monitor-2'), true)
  assert.equal(isSwarmMonitorAgentName(GATEWAY_STALL_MONITOR_AGENT), true)
  assert.equal(isSwarmMonitorAgentName('worker-a'), false)
  assert.equal(
    isMemberEffectivelyWaiting(makeMember({ name: 'coordinator', role: 'coordinator', status: 'working', activity: '等待讨论板消息' })),
    true,
  )
  assert.equal(
    isMemberEffectivelyWaiting(makeMember({ name: 'worker-a', role: 'worker', status: 'working', activity: '运行命令' })),
    false,
  )
})

test('OCV5-848: AntigravitySwarmWatcher triggers stall alert even when disk files stop changing and injects into board.jsonl without looping', async () => {
  const brainDir = mkdtempSync(join(tmpdir(), 'oc-swarm-stall-watcher-'))
  try {
    const swarmDir = join(brainDir, CONV_ID, '.system_generated', 'swarm')
    const coordLogs = join(brainDir, CONV_ID, '.system_generated', 'logs')
    const workerLogs = join(brainDir, WORKER_CONV_ID, '.system_generated', 'logs')
    mkdirSync(swarmDir, { recursive: true })
    mkdirSync(coordLogs, { recursive: true })
    mkdirSync(workerLogs, { recursive: true })

    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: '磁盘停滞闭环',
        members: {
          coordinator: {
            conversation_id: CONV_ID,
            role: 'coordinator',
            wake_mode: 'mentions',
            last_read_seq: 1,
            killed: false,
            channels: ['main'],
          },
          'worker-a': {
            conversation_id: WORKER_CONV_ID,
            role: 'worker',
            wake_mode: 'mentions',
            last_read_seq: 2,
            killed: false,
            channels: ['main'],
          },
        },
      }),
    )
    // Coordinator parked inside swarm_wait; worker finished and posted #2 without @coordinator
    writeFileSync(
      join(coordLogs, 'transcript.jsonl'),
      `${JSON.stringify({
        step_index: 0,
        type: 'PLANNER_RESPONSE',
        status: 'RUNNING',
        tool_calls: [{ name: 'swarm_wait', arguments: { since: 1 } }],
      })}\n`,
    )
    const workerTranscript = join(workerLogs, 'transcript.jsonl')
    const parkedStep = { step_index: 100, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }
    writeFileSync(workerTranscript, `${JSON.stringify({ ...parkedStep, created_at: new Date(970_000).toISOString() })}\n`)
    writeFileSync(
      join(swarmDir, 'board.jsonl'),
      [
        JSON.stringify({ seq: 1, agent: 'coordinator', channel: 'main', text: '@worker-a 做调研' }),
        JSON.stringify({ seq: 2, agent: 'worker-a', channel: 'main', text: '调研已完成，结果见报告。' }),
      ].join('\n') + '\n',
    )

    let fakeNow = 1_000_000
    const alerts: SwarmStallAlert[] = []
    const diagnostics: SwarmStallDiagnosticEvent[] = []
    const pendingWrites: Promise<unknown>[] = []
    const watcher = new AntigravitySwarmWatcher({
      brainDir,
      conversationId: CONV_ID,
      pollMs: 20,
      activityThrottleMs: 0,
      now: () => fakeNow,
      stallMonitor: {
        stallThresholdMs: 180_000, retryCooldownMs: 540_000, maxAlerts: 3,
        onDiagnostic: (event) => diagnostics.push(event),
      },
      onSnapshot: () => {},
      onStallDetected: (alert) => {
        alerts.push(alert)
        pendingWrites.push(
          injectSwarmDirective({
            brainDir,
            conversationId: CONV_ID,
            target: alert.target,
            message: alert.message,
            channel: alert.channel,
            sender: GATEWAY_STALL_MONITOR_AGENT,
            controlKind: 'stall',
            now: fakeNow,
          }).then((res) => {
            assert.equal(res.ok, true)
          }),
        )
      },
    })

    // 1. Initial start captures active snapshot; no alert yet
    watcher.start()
    assert.equal(alerts.length, 0)

    // 2. Timestamp-only progress is deduped on wire, but unchanged-disk polls
    // must continue from that exact sample rather than replay the older activity.
    fakeNow += 30_000
    appendFileSync(workerTranscript, `${JSON.stringify({ ...parkedStep, created_at: new Date(fakeNow).toISOString() })}\n`)
    watcher.kick()
    assert.equal(diagnostics.at(-1)?.kind, 'activity_postponed')
    fakeNow += 60_000
    for (let i = 0; i < 12 && diagnostics.at(-1)?.kind !== 'quiet_waiting'; i += 1) {
      await new Promise((r) => setTimeout(r, 25))
    }
    assert.equal(diagnostics.at(-1)?.idleMs, 60_000, 'quiet ticks must not roll telemetry backwards')
    fakeNow += 125_000
    for (let i = 0; i < 12 && alerts.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25))
    }
    await Promise.all(pendingWrites)

    assert.equal(alerts.length, 1, 'should fire stall alert even with unchanged disk statSig')
    assert.equal(alerts[0]!.target, 'coordinator')
    assert.equal(alerts[0]!.reason, 'unclaimed_result')

    // 3. Verify board.jsonl received the structured gateway-monitor stall post
    const boardLines = readFileSync(join(swarmDir, 'board.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    assert.equal(boardLines.length, 3)
    assert.equal(boardLines[2]!.agent, GATEWAY_STALL_MONITOR_AGENT)
    assert.deepEqual(boardLines[2]!.control, { kind: 'stall', target: 'coordinator' })

    // 4. Subsequent polls after reading our own stall post must NOT self-trigger within cooldown
    fakeNow += 60_000
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(alerts.length, 1)

    watcher.stop()

    // 5. Dormant baseline (seedBaselineOnStart=true, turn never activated) must produce 0 alerts
    const dormantAlerts: SwarmStallAlert[] = []
    let dormantNow = 2_000_000
    const dormantWatcher = new AntigravitySwarmWatcher({
      brainDir,
      conversationId: CONV_ID,
      pollMs: 20,
      seedBaselineOnStart: true,
      now: () => dormantNow,
      stallMonitor: { stallThresholdMs: 10_000 },
      onSnapshot: () => {},
      onStallDetected: (a) => dormantAlerts.push(a),
    })
    dormantWatcher.start()
    dormantNow += 600_000
    await new Promise((r) => setTimeout(r, 60))
    dormantWatcher.stop()
    assert.equal(dormantAlerts.length, 0)
  } finally {
    rmSync(brainDir, { recursive: true, force: true })
  }
})

test('OCV5-848 Blocker 1: repeated wake->stepCount++->re-park cycles without new business posts strictly cap at 3 alerts', () => {
  const mon = new SwarmStallMonitor({ stallThresholdMs: 180_000, retryCooldownMs: 540_000, maxAlerts: 3 })
  let step = 1
  let now = 0
  const buildSnap = (coordWorking: boolean, selfPosts: number): SwarmSnapshot => ({
    swarmId: CONV_ID,
    title: '反馈环止损测试',
    phase: 'running',
    revision: step,
    updatedAt: now,
    members: [
      makeMember({
        name: 'coordinator',
        role: 'coordinator',
        status: coordWorking ? 'working' : 'working',
        activity: coordWorking ? '思考与规划中…' : '等待讨论板消息',
        stepCount: step,
        unreadCount: selfPosts,
        lastPostSeq: 1,
      }),
      makeMember({ name: 'worker-a', role: 'worker', status: 'waiting', stepCount: 1, lastPostSeq: 1 }),
    ],
    channels: [{ name: 'main', memberCount: 2, postCount: 1 + selfPosts }],
    posts: [
      { seq: 1, agent: 'coordinator', channel: 'main', text: '任务开始', mentions: [] },
      ...Array.from({ length: selfPosts }, (_, idx) => ({
        seq: 2 + idx,
        agent: GATEWAY_STALL_MONITOR_AGENT,
        channel: 'main',
        text: '@coordinator [stall] 静默提醒',
        mentions: ['coordinator'],
      })),
    ],
    totalPosts: 1 + selfPosts,
  })

  // Seed initial state
  assert.equal(mon.evaluate(buildSnap(false, 0), now), null)

  const emitted: SwarmStallAlert[] = []
  // Simulate 5 stall cycles where every alert briefly wakes coordinator (working + stepCount++),
  // coordinator posts nothing and goes right back into swarm_wait.
  for (let cycle = 0; cycle < 5; cycle += 1) {
    // Advance enough for both stallThreshold (3m) and retryCooldown (9m)
    now += 600_000
    const alert = mon.evaluate(buildSnap(false, emitted.length), now)
    if (alert) {
      emitted.push(alert)
      // Coordinator briefly wakes, steps, then re-parks without posting any business message
      now += 2_000
      step += 1
      assert.equal(mon.evaluate(buildSnap(true, emitted.length), now), null)
      now += 2_000
      step += 1
      assert.equal(mon.evaluate(buildSnap(false, emitted.length), now), null)
      // 3 minutes later is STILL inside 9-minute retryCooldown -> must NOT fire early
      now += 180_000
      assert.equal(mon.evaluate(buildSnap(false, emitted.length), now), null)
    }
  }

  assert.equal(emitted.length, 3, 'must strictly cap at 3 alerts across 5 wake/re-park cycles')
  assert.deepEqual(
    emitted.map((a) => a.attempt),
    [1, 2, 3],
  )
})

test('OCV5-848 Blocker 2, 4, 5: healthy slow remote worker stays working (0 alerts), error text neutralizes @all, and post-[done] straggler does not re-arm', () => {
  // Blocker 2: RemoteSwarm `phase: RUNNING` + `TOOL_CALL ACTIVE` parses as working -> 0 alerts
  const brainDir = mkdtempSync(join(tmpdir(), 'oc-swarm-remote-slow-'))
  try {
    const swarmDir = join(brainDir, CONV_ID, '.system_generated', 'swarm')
    const workerLogs = join(brainDir, WORKER_CONV_ID, '.system_generated', 'logs')
    mkdirSync(swarmDir, { recursive: true })
    mkdirSync(workerLogs, { recursive: true })
    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: '远端慢工具测试',
        members: {
          coordinator: {
            conversation_id: CONV_ID,
            role: 'coordinator',
            phase: 'WAITING',
            wake_mode: 'mentions',
            last_read_seq: 1,
            killed: false,
            channels: ['main'],
          },
          'slow-worker': {
            conversation_id: WORKER_CONV_ID,
            role: 'worker',
            phase: 'RUNNING',
            wake_mode: 'mentions',
            last_read_seq: 1,
            killed: false,
            channels: ['main'],
          },
        },
      }),
    )
    writeFileSync(
      join(swarmDir, 'board.jsonl'),
      `${JSON.stringify({ seq: 1, agent: 'coordinator', channel: 'main', text: '@slow-worker 跑全量构建' })}\n`,
    )

    // Case A: before first transcript line is written, remote phase=RUNNING must still be working
    const snapNoTranscript = readAntigravitySwarmSnapshot({
      brainDir,
      conversationId: CONV_ID,
      phase: 'running',
      revision: 1,
      now: 1_000,
    })
    assert.ok(snapNoTranscript)
    assert.equal(snapNoTranscript.members.find((m) => m.name === 'slow-worker')?.status, 'working')
    assert.equal(snapNoTranscript.members.find((m) => m.name === 'coordinator')?.status, 'waiting')

    // Case B: remote TOOL_CALL ACTIVE with tool_calls[] parses as working with activity
    const activeToolLine = JSON.stringify({
      step_index: 1,
      type: 'TOOL_CALL',
      status: 'ACTIVE',
      tool_calls: [{ name: 'mcp_openclaude-memory_oc_bash', arguments: { command: 'npm test' } }],
    })
    writeFileSync(join(workerLogs, 'transcript.jsonl'), `${activeToolLine}\n`)
    const parsedTail = parseMemberTranscriptTail(`${activeToolLine}\n`)
    assert.equal(parsedTail.status, 'working')
    assert.equal(parsedTail.activity, '运行命令')

    const snapRunningTool = readAntigravitySwarmSnapshot({
      brainDir,
      conversationId: CONV_ID,
      phase: 'running',
      revision: 2,
      now: 2_000,
    })
    assert.ok(snapRunningTool)
    const mon = new SwarmStallMonitor({ stallThresholdMs: 180_000 })
    assert.equal(mon.evaluate(snapRunningTool, 0), null)
    // Even after 20 minutes of slow remote tool execution -> 0 alerts
    assert.equal(mon.evaluate(snapRunningTool, 1_200_000), null)
  } finally {
    rmSync(brainDir, { recursive: true, force: true })
  }

  // Blocker 4: quoted error containing @all / @worker-b / @#impl must NOT emit extra mentions
  const m4 = new SwarmStallMonitor({ stallThresholdMs: 10_000 })
  const badErrSnap = makeSnapshot({
    members: [
      makeMember({ name: 'coordinator', role: 'coordinator', status: 'waiting', lastPostSeq: 1 }),
      makeMember({
        name: 'builder',
        role: 'worker',
        status: 'waiting',
        failed: true,
        lastError: 'failed calling @all and @worker-b in @#impl package',
      }),
    ],
  })
  assert.equal(m4.evaluate(badErrSnap, 0), null)
  const errAlert = m4.evaluate(badErrSnap, 15_000)
  assert.ok(errAlert)
  assert.deepEqual(extractSwarmMentions(errAlert.message), ['coordinator'])

  // Blocker 5: late worker straggler post after coordinator [done] MUST NOT re-arm stall monitor
  const m5 = new SwarmStallMonitor({ stallThresholdMs: 10_000 })
  const doneSnap = makeSnapshot({
    members: [
      makeMember({ name: 'coordinator', role: 'coordinator', status: 'waiting', lastPostSeq: 2 }),
      makeMember({ name: 'worker-a', role: 'worker', status: 'waiting', lastPostSeq: 1 }),
    ],
    posts: [
      { seq: 1, agent: 'coordinator', channel: 'main', text: '@worker-a 做任务', mentions: ['worker-a'] },
      { seq: 2, agent: 'coordinator', channel: 'main', text: '[done] 收口完成', mentions: [] },
    ],
    totalPosts: 2,
  })
  assert.equal(m5.evaluate(doneSnap, 0), null)

  // Worker posts a late straggler reply after [done] -> must remain silent forever
  const stragglerSnap: SwarmSnapshot = {
    ...doneSnap,
    members: [
      makeMember({ name: 'coordinator', role: 'coordinator', status: 'waiting', lastPostSeq: 2, unreadCount: 1 }),
      makeMember({ name: 'worker-a', role: 'worker', status: 'waiting', lastPostSeq: 3 }),
    ],
    posts: [
      ...doneSnap.posts,
      { seq: 3, agent: 'worker-a', channel: 'main', text: '@coordinator 补发迟到结果', mentions: ['coordinator'] },
    ],
    totalPosts: 3,
  }
  assert.equal(m5.evaluate(stragglerSnap, 1_000), null)
  assert.equal(m5.evaluate(stragglerSnap, 600_000), null)

  // Explicit new stage started by coordinator -> re-arms monitor
  const newStageSnap: SwarmSnapshot = {
    ...stragglerSnap,
    members: [
      makeMember({ name: 'coordinator', role: 'coordinator', status: 'waiting', lastPostSeq: 4 }),
      makeMember({ name: 'worker-a', role: 'worker', status: 'waiting', lastPostSeq: 3 }),
    ],
    posts: [
      ...stragglerSnap.posts,
      { seq: 4, agent: 'coordinator', channel: 'main', text: '@worker-a 开启新阶段', mentions: ['worker-a'] },
    ],
    totalPosts: 4,
  }
  assert.equal(m5.evaluate(newStageSnap, 601_000), null)
  const stage2Alert = m5.evaluate(newStageSnap, 615_000)
  assert.ok(stage2Alert)
  assert.equal(stage2Alert.target, 'worker-a')
  assert.deepEqual(stage2Alert.citedSeqs, [4])
})

test('OCV5-852 P0-1/P1-4: DONE_PREFIX_RE accepts markdown bold & optional @all, emits throttled diagnostics, and catches native CLI 1.5.8 silent-park scenarios', () => {
  // 1. DONE_PREFIX_RE accepts **[done]**, **[done]:**, @all [done], @all **[done]** and rejects mid-prose / @worker
  for (const doneText of [
    '[done] 完成',
    '**[done]** 全部收口',
    '**[done]:** 全部收口',
    '@all [done] 阶段收尾',
    '@all **[done]** 全部完成',
  ]) {
    const mon = new SwarmStallMonitor({ stallThresholdMs: 10_000 })
    const snap = makeSnapshot({
      members: [
        makeMember({ name: 'coordinator', role: 'coordinator', status: 'waiting', lastPostSeq: 2 }),
        makeMember({ name: 'worker-a', role: 'worker', status: 'waiting', lastPostSeq: 1 }),
      ],
      posts: [
        { seq: 1, agent: 'worker-a', channel: 'main', text: '@coordinator done', mentions: ['coordinator'] },
        { seq: 2, agent: 'coordinator', channel: 'main', text: doneText, mentions: [] },
      ],
      totalPosts: 2,
    })
    assert.equal(mon.evaluate(snap, 0), null)
    assert.equal(mon.evaluate(snap, 300_000), null, `expected "${doneText}" to suppress stall alerts`)
  }

  for (const notDoneText of ['尚未 [done]，请继续', '@worker-a [done] 请确认']) {
    const mon = new SwarmStallMonitor({ stallThresholdMs: 10_000 })
    const snap = makeSnapshot({
      members: [
        makeMember({ name: 'coordinator', role: 'coordinator', status: 'waiting', lastPostSeq: 2 }),
        makeMember({ name: 'worker-a', role: 'worker', status: 'waiting', lastPostSeq: 1 }),
      ],
      posts: [
        { seq: 1, agent: 'worker-a', channel: 'main', text: '@coordinator 汇报', mentions: ['coordinator'] },
        { seq: 2, agent: 'coordinator', channel: 'main', text: notDoneText, mentions: [] },
      ],
      totalPosts: 2,
    })
    assert.equal(mon.evaluate(snap, 0), null)
    assert.ok(mon.evaluate(snap, 20_000), `expected "${notDoneText}" NOT to be treated as terminal [done]`)
  }

  // 2. Structured diagnostics: immediate transitions + throttled repetitive checks + observer crash isolation
  const diags: SwarmStallDiagnosticEvent[] = []
  let throwOnce = true
  const diagMon = new SwarmStallMonitor({
    stallThresholdMs: 180_000,
    diagnosticThrottleMs: 30_000,
    onDiagnostic: (ev) => {
      diags.push(ev)
      if (throwOnce) {
        throwOnce = false
        throw new Error('observer boom')
      }
    },
  })
  const busySnap = makeSnapshot({
    members: [
      makeMember({ name: 'coordinator', role: 'coordinator', status: 'waiting', lastPostSeq: 1 }),
      makeMember({ name: 'worker-a', role: 'worker', status: 'working', activity: '运行命令' }),
    ],
  })
  assert.equal(diagMon.evaluate(busySnap, 10_000), null)
  // Repetitive skipped_working within 30s throttle window is suppressed
  assert.equal(diagMon.evaluate(busySnap, 20_000), null)
  assert.equal(diags.filter((d) => d.kind === 'skipped_working').length, 1)
  // Past 30s throttle emits again
  assert.equal(diagMon.evaluate(busySnap, 45_000), null)
  assert.equal(diags.filter((d) => d.kind === 'skipped_working').length, 2)

  // Transition to quiet waiting emits immediately, then alert_emitted fires immediately at threshold
  const parkedSnap = makeSnapshot({
    members: [
      makeMember({ name: 'coordinator', role: 'coordinator', status: 'waiting', lastPostSeq: 1 }),
      makeMember({ name: 'worker-a', role: 'worker', status: 'working', activity: '已完成本轮思考' }),
    ],
  })
  assert.equal(isMemberEffectivelyWaiting(parkedSnap.members[1]!), true)
  assert.equal(diagMon.evaluate(parkedSnap, 50_000), null)
  assert.equal(diagMon.evaluate(parkedSnap, 100_000), null)
  const alert = diagMon.evaluate(parkedSnap, 235_000)
  assert.ok(alert)
  assert.ok(diags.some((d) => d.kind === 'alert_emitted' && d.target === alert.target))

  // 3. End-to-end native CLI 1.5.8 silent-park scenarios:
  //    [swarm_wait, post_message] + GENERIC DONE, 已完成本轮思考, and SYSTEM_MESSAGE wake -> re-park
  const brainDir = mkdtempSync(join(tmpdir(), 'oc-stall-852-e2e-'))
  try {
    const swarmDir = join(brainDir, CONV_ID, '.system_generated', 'swarm')
    const coordLogs = join(brainDir, CONV_ID, '.system_generated', 'logs')
    const workerLogs = join(brainDir, WORKER_CONV_ID, '.system_generated', 'logs')
    mkdirSync(swarmDir, { recursive: true })
    mkdirSync(coordLogs, { recursive: true })
    mkdirSync(workerLogs, { recursive: true })

    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'CLI 1.5.8 静默停泊验证',
        members: {
          coordinator: {
            conversation_id: CONV_ID,
            role: 'coordinator',
            desired_state: 'RUNNING',
            phase: 'RUNNING',
            wake_mode: 'mentions',
            last_read_seq: 1,
            last_nudged_seq: 1,
            killed: false,
          },
          'worker-a': {
            conversation_id: WORKER_CONV_ID,
            role: 'worker',
            desired_state: 'RUNNING',
            phase: 'RUNNING',
            wake_mode: 'working',
            last_read_seq: 1,
            last_nudged_seq: 1,
            killed: false,
          },
        },
      }),
    )
    writeFileSync(
      join(swarmDir, 'board.jsonl'),
      `${JSON.stringify({ seq: 1, agent: 'coordinator', channel: 'main', text: '@worker-a 请开工' })}\n`,
    )
    // Coordinator called [swarm_wait, post_message] (swarm_wait first!) + GENERIC DONE
    writeFileSync(
      join(coordLogs, 'transcript.jsonl'),
      `${[
        JSON.stringify({
          step_index: 0,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [
            { name: 'swarm_wait', args: { since: '1' } },
            { name: 'post_message', args: { text: '@worker-a 请开工' } },
          ],
        }),
        JSON.stringify({ step_index: 1, type: 'GENERIC', status: 'DONE', content: 'Waiting...' }),
        JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: '{"seq":1}' }),
      ].join('\n')}\n`,
    )
    // Worker woke on SYSTEM_MESSAGE and ended turn with 已完成本轮思考 without calling swarm_wait
    writeFileSync(
      join(workerLogs, 'transcript.jsonl'),
      `${[
        JSON.stringify({ step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[swarm] #1' }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }),
      ].join('\n')}\n`,
    )

    const snap = readAntigravitySwarmSnapshot({
      brainDir,
      conversationId: CONV_ID,
      phase: 'running',
      revision: 1,
      now: 1_000,
    })
    assert.ok(snap)
    assert.equal(snap.members.find((m) => m.name === 'coordinator')?.status, 'waiting')
    assert.equal(snap.members.find((m) => m.name === 'coordinator')?.activity, '等待讨论板消息')
    assert.equal(snap.members.find((m) => m.name === 'worker-a')?.activity, '已完成本轮思考')

    const e2eMon = new SwarmStallMonitor({ stallThresholdMs: 180_000 })
    assert.equal(e2eMon.evaluate(snap, 1_000), null)
    const e2eAlert = e2eMon.evaluate(snap, 185_000)
    assert.ok(e2eAlert, 'must catch silent park of [swarm_wait, post_message] + 已完成本轮思考')
    assert.equal(e2eAlert.target, 'worker-a')
    assert.equal(e2eAlert.reason, 'unanswered_mention')
  } finally {
    rmSync(brainDir, { recursive: true, force: true })
  }
})

test('OCV5-863: normalizeSwarmToolName strips mcp_openclaude-memory_ prefix and waitingOnBoard drives structured park detection', () => {
  assert.equal(normalizeSwarmToolName('mcp_openclaude-memory_swarm_wait'), 'swarm_wait')
  assert.equal(normalizeSwarmToolName('mcp_openclaude-memory_post_message'), 'post_message')
  assert.equal(normalizeSwarmToolName('mcp_openclaude-memory_read_board'), 'read_board')
  assert.equal(normalizeSwarmToolName('swarm_wait'), 'swarm_wait')

  const waitTail = parseMemberTranscriptTail(
    `${JSON.stringify({
      step_index: 1,
      type: 'TOOL_CALL',
      status: 'ACTIVE',
      tool_calls: [{ name: 'mcp_openclaude-memory_swarm_wait', arguments: { since: 3 } }],
    })}\n`,
  )
  assert.equal(waitTail.activity, '等待讨论板消息')
  assert.equal(waitTail.waitingOnBoard, true)

  const postTail = parseMemberTranscriptTail(
    `${JSON.stringify({
      step_index: 2,
      type: 'TOOL_CALL',
      status: 'ACTIVE',
      tool_calls: [{ name: 'mcp_openclaude-memory_post_message', arguments: { text: 'hi' } }],
    })}\n`,
  )
  assert.equal(postTail.activity, '发送讨论消息')
  assert.equal(postTail.waitingOnBoard, undefined)

  const readTail = parseMemberTranscriptTail(
    `${JSON.stringify({
      step_index: 3,
      type: 'TOOL_CALL',
      status: 'ACTIVE',
      tool_calls: [{ name: 'mcp_openclaude-memory_read_board', arguments: {} }],
    })}\n`,
  )
  assert.equal(readTail.activity, '查看讨论板')

  // Structured waitingOnBoard takes priority over localized activity text
  assert.equal(
    isMemberEffectivelyWaiting(
      makeMember({ name: 'w1', role: 'worker', status: 'working', activity: '自定义状态', waitingOnBoard: true }),
    ),
    true,
  )
  assert.equal(
    isMemberEffectivelyWaiting(
      makeMember({ name: 'w2', role: 'worker', status: 'working', activity: '等待讨论板消息', waitingOnBoard: false }),
    ),
    false,
  )
  // Legacy fallback when waitingOnBoard is omitted
  assert.equal(
    isMemberEffectivelyWaiting(
      makeMember({ name: 'w3', role: 'worker', status: 'working', activity: '等待讨论板消息' }),
    ),
    true,
  )
})

test('OCV5-887: stuck working member alerts coordinator after workingStallThresholdMs and rollbackAlert restores budget on lock failure', () => {
  const mon = new SwarmStallMonitor({
    stallThresholdMs: 60_000,
    workingStallThresholdMs: 120_000,
    retryCooldownMs: 180_000,
    maxAlerts: 3,
  })
  const frozenWorking = makeSnapshot({
    members: [
      makeMember({ name: 'coordinator', role: 'coordinator', status: 'working', activity: '等待讨论板消息', waitingOnBoard: true }),
      makeMember({ name: 'worker-a', role: 'worker', status: 'working', activity: '运行命令', stepCount: 4, toolCalls: 2 }),
    ],
  })
  assert.equal(mon.evaluate(frozenWorking, 0), null)
  // Quiet for 90s (< 120s workingStallThresholdMs) -> no alert yet
  assert.equal(mon.evaluate(frozenWorking, 90_000), null)
  // Frozen at exact same stepCount/toolCalls/activity for 120s -> alerts @coordinator
  const alert1 = mon.evaluate(frozenWorking, 120_000)
  assert.ok(alert1)
  assert.equal(alert1.reason, 'working_member_stalled')
  assert.equal(alert1.target, 'coordinator')
  assert.equal(alert1.attempt, 1)
  assert.ok(alert1.message.includes('`worker-a`'))
  assert.ok(!alert1.message.includes('@worker-a'))

  // Simulate board lock contention: rollbackAlert restores budget & removes false cooldown!
  mon.rollbackAlert(alert1)
  const retriedNextTick = mon.evaluate(frozenWorking, 125_000)
  assert.ok(retriedNextTick, 'rolled-back alert must retry on next tick without waiting 3m cooldown')
  assert.equal(retriedNextTick.attempt, 1)
})

test('OCV5-887 P2-09: rollbackAlert ignores stale callbacks from an earlier stageGeneration', () => {
  const mon = new SwarmStallMonitor({
    stallThresholdMs: 60_000,
    retryCooldownMs: 180_000,
    maxAlerts: 3,
  })
  const stage1 = makeSnapshot()
  assert.equal(mon.evaluate(stage1, 0), null)
  const staleAlert = mon.evaluate(stage1, 60_000)
  assert.ok(staleAlert)
  assert.equal(staleAlert.attempt, 1)

  // Genuine business progress advances stageGeneration and resets alert budget
  const stage2 = makeSnapshot({
    members: [
      makeMember({ name: 'coordinator', role: 'coordinator', status: 'waiting', lastPostSeq: 2 }),
      makeMember({ name: 'worker-a', role: 'worker', status: 'waiting', lastPostSeq: 1 }),
    ],
    posts: [
      ...stage1.posts,
      { seq: 2, agent: 'coordinator', channel: 'main', text: '@worker-a 第二阶段任务', mentions: ['worker-a'] },
    ],
    totalPosts: 2,
  })
  assert.equal(mon.evaluate(stage2, 70_000), null)
  const stage2Alert = mon.evaluate(stage2, 130_000)
  assert.ok(stage2Alert)
  assert.equal(stage2Alert.attempt, 1)
  assert.ok(stage2Alert.generation > staleAlert.generation)

  // Stale async failure callback from stage 1 MUST NOT roll back stage 2's alertCount or cooldown!
  mon.rollbackAlert(staleAlert)
  assert.equal(mon.evaluate(stage2, 135_000), null, 'stale rollback must not clear stage 2 cooldown')
  const stage2Next = mon.evaluate(stage2, 310_000)
  assert.ok(stage2Next)
  assert.equal(stage2Next.attempt, 2, 'stage 2 attempt must advance to 2, not revert to 1')

  // Same-generation rollback still works normally
  mon.rollbackAlert(stage2Next)
  const stage2Retried = mon.evaluate(stage2, 315_000)
  assert.ok(stage2Retried)
  assert.equal(stage2Retried.attempt, 2)
})

const VERIFIER_CONV_ID = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const NATIVE_COORD_TASK = { seq: 19, agent: 'coordinator', channel: 'main', text: '@worker-a 实现后交给验证员' }
const NATIVE_HANDOFF_PROGRESS = { seq: 20, agent: 'worker-a', channel: 'main', text: '正在整理变更，随后请 @verifier 验证' }
const NATIVE_HANDOFF_READY = { seq: 25, agent: 'worker-a', channel: 'main', text: '@verifier ready' }
const NATIVE_HANDOFF_ACK = { seq: 26, agent: 'verifier', channel: 'main', text: '@worker-a 已接手，正在验证' }
const NATIVE_HANDOFF_DONE = { seq: 30, agent: 'worker-a', channel: 'main', text: '@coordinator done，验证通过' }

function withNativeHandoff(run: (read: (
  posts: ReadonlyArray<typeof NATIVE_HANDOFF_READY>, verifyPass?: number, failure?: boolean, coordinatorWoke?: boolean,
) => SwarmSnapshot) => void): void {
  const brainDir = mkdtempSync(join(tmpdir(), 'oc-stall-916-'))
  const swarmDir = join(brainDir, CONV_ID, '.system_generated', 'swarm')
  let revision = 0
  function writeTranscript(id: string, steps: object[]) {
    const dir = join(brainDir, id, '.system_generated', 'logs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'transcript.jsonl'), `${steps.map((step, step_index) => JSON.stringify({ step_index, ...step })).join('\n')}\n`)
  }
  try {
    mkdirSync(swarmDir, { recursive: true })
    run((posts, verifyPass = 1, failure = false, coordinatorWoke = false) => {
      const final = posts.includes(NATIVE_HANDOFF_DONE)
      const member = (conversation_id: string, role: string, wake_mode: string, last_read_seq: number) => ({
        conversation_id, role, wake_mode, last_read_seq, last_nudged_seq: last_read_seq,
        desired_state: 'RUNNING', phase: 'RUNNING',
      })
      writeFileSync(join(swarmDir, 'members.json'), JSON.stringify({
        members: {
          coordinator: member(CONV_ID, 'coordinator', coordinatorWoke ? 'working' : 'mentions', final ? 30 : 19),
          'worker-a': member(WORKER_CONV_ID, 'worker', 'working', 25),
          verifier: member(VERIFIER_CONV_ID, 'verifier', 'working', 25),
        },
      }))
      writeFileSync(join(swarmDir, 'board.jsonl'), `${posts.map((post) => JSON.stringify(post)).join('\n')}\n`)
      const settledPlanner = { type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }
      writeTranscript(CONV_ID, [
        { type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', args: { since: '19', mentions_only: true } }] },
        { type: 'GENERIC', status: 'DONE', content: 'Waiting...' },
        ...(final ? [{ type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[swarm] #30' }] : []),
        ...(final && !coordinatorWoke ? [settledPlanner] : []),
      ])
      writeTranscript(WORKER_CONV_ID, [settledPlanner])
      writeTranscript(VERIFIER_CONV_ID, [
        { type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[swarm] #25' },
        ...Array.from({ length: verifyPass }, () => [
          { type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: {} }] },
          { type: 'GENERIC', status: 'DONE', content: 'verification command completed' },
        ]).flat(),
        failure ? { type: 'ERROR_MESSAGE', status: 'ERROR', content: 'verification failed' } : settledPlanner,
      ])
      const snap = readAntigravitySwarmSnapshot({ brainDir, conversationId: CONV_ID, phase: 'running', revision: ++revision })
      assert.ok(snap)
      return snap
    })
  } finally {
    rmSync(brainDir, { recursive: true, force: true })
  }
}

test('OCV5-916: native peer handoff survives parked planner tails and monitor posts, until real coordinator mention', () => {
  const mon = new SwarmStallMonitor({ stallThresholdMs: 180_000, workingStallThresholdMs: 2_400_000 })
  withNativeHandoff((read) => {
    const old = [NATIVE_COORD_TASK, NATIVE_HANDOFF_PROGRESS]
    const ready = [...old, NATIVE_HANDOFF_READY]
    const accepted = [...ready, NATIVE_HANDOFF_ACK]
    assert.equal(mon.evaluate(read(old), 0), null)
    assert.equal(mon.evaluate(read(ready), 20_000), null)
    const snap = read(accepted)
    const verifier = snap.members.find((m) => m.role === 'verifier')!
    assert.equal(verifier.status, 'working')
    assert.equal(verifier.waitingOnBoard, true, 'native DONE/no-tools planner looks parked')
    assert.ok(verifier.toolCalls)
    assert.equal(mon.evaluate(snap, 30_000), null)
    assert.equal(mon.evaluate(snap, 210_000), null, 'an accepted P2P request is not an unclaimed result or idle fallback')

    const afterMonitorPosts = [
      ...accepted,
      ...[27, 28, 29].map((seq) => ({ seq, agent: GATEWAY_STALL_MONITOR_AGENT, channel: 'main', text: '@coordinator [stall]' })),
    ]
    const progressed = read(afterMonitorPosts, 2)
    assert.ok(progressed.members.find((m) => m.role === 'verifier')!.stepCount > verifier.stepCount)
    assert.equal(mon.evaluate(progressed, 2_420_000), null, 'real transcript progress extends the observation window')
    assert.equal(mon.evaluate(snap, 2_430_000), null, 'a superseded disk snapshot cannot revive an old candidate or reset quiet')
    assert.equal(mon.evaluate(progressed, 2_600_000), null)

    const reportPosts = [...afterMonitorPosts, NATIVE_HANDOFF_DONE]
    const wake = read(reportPosts, 2, false, true)
    const coordinator = wake.members.find((m) => m.role === 'coordinator')!
    assert.equal(coordinator.status, 'working')
    assert.equal(isMemberEffectivelyWaiting(coordinator), false)
    assert.equal(mon.evaluate(wake, 2_610_000), null)
    assert.equal(mon.evaluate(wake, 2_790_000), null, 'a genuinely woken coordinator gets time to respond')

    const reported = read(reportPosts, 2)
    assert.equal(mon.evaluate(reported, 2_800_000), null)
    const alert = mon.evaluate(reported, 2_980_000)
    assert.equal(alert?.reason, 'unclaimed_result', 'a real direct coordinator mention requires follow-through even after being read')
    assert.deepEqual(alert?.citedSeqs, [30])
    assert.match(alert!.message, /已点名协调者但尚无回复/)

    const completed = read([...afterMonitorPosts, NATIVE_HANDOFF_DONE, {
      seq: 31, agent: 'coordinator', channel: 'main', text: '[done] 已收口',
    }])
    assert.equal(mon.evaluate(completed, 2_990_000), null)
    assert.equal(mon.evaluate(completed, 5_600_000), null)
  })
})

test('OCV5-916: sorted handoff evidence expires and preserves cooldown, budget, and genuine failures', () => {
  withNativeHandoff((read) => {
    // An older post discovered after the receipt must not become the head or defeat handoff evidence.
    const posts = [NATIVE_COORD_TASK, NATIVE_HANDOFF_READY, NATIVE_HANDOFF_ACK, NATIVE_HANDOFF_PROGRESS]
    const old = read(posts)
    const snap = read(posts, 2)
    const mon = new SwarmStallMonitor({
      stallThresholdMs: 10_000, workingStallThresholdMs: 40_000, retryCooldownMs: 20_000, maxAlerts: 2,
    })
    assert.equal(mon.evaluate(snap, 0), null)
    assert.equal(mon.evaluate(snap, 10_000), null)
    assert.equal(mon.evaluate(old, 39_999), null, 'replayed progress cannot restart the quiet clock')
    const expired = mon.evaluate(snap, 40_000)
    assert.equal(expired?.reason, 'idle_waiting')
    assert.deepEqual(expired?.citedSeqs, [26])
    assert.equal(mon.evaluate(snap, 59_999), null)
    assert.equal(mon.evaluate(snap, 60_000)?.attempt, 2)
    assert.equal(mon.evaluate(snap, 90_000), null)

    const failed = read(posts, 1, true)
    assert.equal(mon.evaluate(failed, 100_000), null)
    assert.equal(mon.evaluate(failed, 110_000)?.reason, 'member_failed')
  })
})

test('OCV5-916: no, older, and off-channel verifier replies are not receipt evidence', () => {
  withNativeHandoff((read) => {
    for (const reply of [
      [],
      [{ ...NATIVE_HANDOFF_ACK, seq: 24 }],
      [{ ...NATIVE_HANDOFF_ACK, channel: 'other' }],
    ]) {
      const mon = new SwarmStallMonitor({ stallThresholdMs: 10_000, workingStallThresholdMs: 40_000 })
      const snap = read([NATIVE_COORD_TASK, NATIVE_HANDOFF_READY, ...reply])
      assert.equal(mon.evaluate(snap, 0), null)
      const alert = mon.evaluate(snap, 10_000)
      assert.ok(alert)
      if (reply.length === 0 || reply[0]?.seq === 24) {
        assert.equal(alert.reason, 'unanswered_mention')
        assert.deepEqual(alert.citedSeqs, [25])
      } else {
        assert.equal(alert.reason, 'unanswered_mention')
        assert.deepEqual(alert.citedSeqs, [26])
      }
    }
    const mon = new SwarmStallMonitor({ stallThresholdMs: 10_000, workingStallThresholdMs: 40_000 })
    const snap = read([NATIVE_COORD_TASK, NATIVE_HANDOFF_READY, NATIVE_HANDOFF_ACK, {
      seq: 27, agent: 'worker-a', channel: 'main', text: '另一个任务已完成，产物在报告中。',
    }])
    assert.equal(mon.evaluate(snap, 0), null)
    const alert = mon.evaluate(snap, 10_000)
    assert.equal(alert?.reason, 'unclaimed_result')
    assert.deepEqual(alert?.citedSeqs, [27], 'new unaddressed results must not inherit older handoff coverage')
  })
})
