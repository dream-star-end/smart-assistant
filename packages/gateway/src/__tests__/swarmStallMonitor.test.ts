/**
 * Tests for OCV5-848 zero-token deterministic SwarmStallMonitor and its
 * end-to-end integration with AntigravitySwarmWatcher + injectSwarmDirective.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/swarmStallMonitor.test.ts
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { extractSwarmMentions, type SwarmMemberSnapshot, type SwarmSnapshot } from '@openclaude/protocol'

import { AntigravitySwarmWatcher, parseMemberTranscriptTail, readAntigravitySwarmSnapshot } from '../engine/antigravitySwarmWatcher.js'
import {
  GATEWAY_STALL_MONITOR_AGENT,
  SwarmStallMonitor,
  isMemberEffectivelyWaiting,
  isSwarmMonitorAgentName,
  type SwarmStallAlert,
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
    writeFileSync(
      join(workerLogs, 'transcript.jsonl'),
      `${JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] })}\n`,
    )
    writeFileSync(
      join(swarmDir, 'board.jsonl'),
      [
        JSON.stringify({ seq: 1, agent: 'coordinator', channel: 'main', text: '@worker-a 做调研' }),
        JSON.stringify({ seq: 2, agent: 'worker-a', channel: 'main', text: '调研已完成，结果见报告。' }),
      ].join('\n') + '\n',
    )

    let fakeNow = 1_000_000
    const alerts: SwarmStallAlert[] = []
    const watcher = new AntigravitySwarmWatcher({
      brainDir,
      conversationId: CONV_ID,
      pollMs: 20,
      activityThrottleMs: 0,
      now: () => fakeNow,
      stallMonitor: { stallThresholdMs: 180_000, retryCooldownMs: 540_000, maxAlerts: 3 },
      onSnapshot: () => {},
      onStallDetected: (alert) => {
        alerts.push(alert)
        const res = injectSwarmDirective({
          brainDir,
          conversationId: CONV_ID,
          target: alert.target,
          message: alert.message,
          channel: alert.channel,
          sender: GATEWAY_STALL_MONITOR_AGENT,
          controlKind: 'stall',
          now: fakeNow,
        })
        assert.equal(res.ok, true)
      },
    })

    // 1. Initial start captures active snapshot; no alert yet
    watcher.start()
    assert.equal(alerts.length, 0)

    // 2. Advance virtual clock past 3 min while disk statSignature stays completely unchanged
    fakeNow += 185_000
    await new Promise((r) => setTimeout(r, 60))

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
