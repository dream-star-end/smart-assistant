/**
 * Antigravity native swarm watcher, session-scoped brain isolation, symlink
 * defense, baseline/empty-run guard, live-units fallback, UTF-8 byte-bounded
 * persistence, and tool output sanitization tests (OCV5-809).
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/antigravitySwarmWatcher.test.ts
 */
import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  LIVE_UNITS_REDUCER_EPOCH,
  SWARM_BOARD_TOOL_NAME,
  continueReduceLiveFrames,
  extractSwarmMentions,
  foldLiveUnitStateForCheckpoint,
  mergeSwarmSnapshots,
  mergeSwarmSnapshotsStrict,
  parseSwarmSlashCommand,
  reduceLiveFrames,
  serveLiveUnits,
  type SwarmSnapshot,
} from '@openclaude/protocol'
import {
  antigravitySessionBrainDir,
  cleanupAntigravityLaunch,
  projectAntigravityPlatform,
} from '../engine/antigravityPlatform.js'
import {
  AntigravitySwarmWatcher,
  IncrementalTranscriptTelemetryCache,
  buildDurableSwarmBoardInput,
  compactSwarmSnapshotForPersistence,
  formatSwarmWorkingDetail,
  getSwarmRealRootResolveCount,
  parseMemberTranscriptTail,
  readAntigravitySwarmSnapshot,
  resetSwarmRealRootCache,
  settleSwarmSnapshotTerminal,
} from '../engine/antigravitySwarmWatcher.js'
import {
  antigravityProductToolName,
  antigravityToolOutput,
  sanitizeSwarmToolOutput,
} from '../engine/antigravityToolNormalize.js'

const COORD_CONV = '11111111-1111-4111-8111-111111111111'
const WORKER_CONV = '22222222-2222-4222-8222-222222222222'
const VERIFIER_CONV = '33333333-3333-4333-8333-333333333333'
const OTHER_CONV = '44444444-4444-4444-8444-444444444444'

async function writeSwarmFixture(brainDir: string): Promise<{ swarmDir: string }> {
  const swarmDir = path.join(brainDir, COORD_CONV, '.system_generated', 'swarm')
  const workerLogDir = path.join(brainDir, WORKER_CONV, '.system_generated', 'logs')
  const verifierLogDir = path.join(brainDir, VERIFIER_CONV, '.system_generated', 'logs')
  await mkdir(swarmDir, { recursive: true })
  await mkdir(workerLogDir, { recursive: true })
  await mkdir(verifierLogDir, { recursive: true })

  await writeFile(
    path.join(swarmDir, 'members.json'),
    JSON.stringify({
      title: '解析器重构',
      channels: {
        parser: { topic: '词法与语法解析' },
      },
      members: {
        coordinator: {
          conversation_id: COORD_CONV,
          role: 'coordinator',
          model: 'gemini-4-neon-high',
          last_read_seq: 2,
          killed: false,
        },
        parser: {
          conversation_id: WORKER_CONV,
          role: 'worker',
          model: 'gemini-4-neon-high',
          channels: ['parser'],
          last_read_seq: 1,
          killed: false,
        },
        verifier: {
          conversation_id: VERIFIER_CONV,
          role: 'verifier',
          model: 'gemini-4-neon-high',
          wake_mode: 'mentions',
          last_read_seq: 2,
          killed: false,
        },
        retired: {
          role: 'worker',
          killed: true,
        },
      },
    }),
  )

  await writeFile(
    path.join(swarmDir, 'board.jsonl'),
    [
      JSON.stringify({
        seq: 1,
        agent: 'coordinator',
        channel: 'parser',
        text: '@parser 请先重构 src/parser.ts，完成后通知 @verifier',
        time: '2026-11-20T00:10:00.000Z',
      }),
      JSON.stringify({
        seq: 2,
        agent: 'parser',
        channel: 'parser',
        text: '@verifier 已完成 #1 的解析器改动，请复核单测。@#parser 进度已同步',
        time: '2026-11-20T00:12:00.000Z',
      }),
    ].join('\n') + '\n',
  )

  await writeFile(
    path.join(workerLogDir, 'transcript.jsonl'),
    [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T00:10:05.000Z' }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'RUNNING',
        tool_calls: [{ name: 'edit_file', arguments: { Path: '/repo/src/parser.ts' } }],
        created_at: '2026-11-20T00:11:30.000Z',
      }),
    ].join('\n') + '\n',
  )

  await writeFile(
    path.join(verifierLogDir, 'transcript.jsonl'),
    [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE' }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }),
    ].join('\n') + '\n',
  )

  return { swarmDir }
}

test('readAntigravitySwarmSnapshot reads members, transcripts, channels, mentions and unread counts', async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-watch-'))
  try {
    await writeSwarmFixture(brainDir)
    const snap = readAntigravitySwarmSnapshot({
      brainDir,
      conversationId: COORD_CONV,
      phase: 'running',
      revision: 1,
    })
    assert.ok(snap)
    assert.equal(snap.title, '解析器重构')
    assert.equal(snap.totalPosts, 2)
    assert.equal(snap.posts.length, 2)
    assert.deepEqual(snap.posts[0]?.mentions, ['parser', 'verifier'])
    assert.deepEqual(snap.posts[1]?.mentions, ['verifier', '#parser'])

    const parser = snap.members.find((m) => m.name === 'parser')
    assert.ok(parser)
    assert.equal(parser.status, 'working')
    assert.equal(parser.activity, '编辑 parser.ts')
    assert.equal(parser.stepCount, 2)
    assert.equal(parser.unreadCount, 1)

    const verifier = snap.members.find((m) => m.name === 'verifier')
    assert.ok(verifier)
    assert.equal(verifier.status, 'waiting')
    assert.equal(verifier.role, 'verifier')
    assert.equal(verifier.unreadCount, 0)

    const retired = snap.members.find((m) => m.name === 'retired')
    assert.ok(retired)
    assert.equal(retired.status, 'killed')

    const parserChannel = snap.channels.find((c) => c.name === 'parser')
    assert.ok(parserChannel)
    assert.equal(parserChannel.postCount, 2)
    assert.equal(parserChannel.topic, '词法与语法解析')

    assert.match(formatSwarmWorkingDetail(snap), /解析器重构/)
    assert.match(formatSwarmWorkingDetail(snap), /2 条讨论/)
  } finally {
    await rm(brainDir, { recursive: true, force: true })
  }
})

test('BLOCKER 1: seedBaselineOnStart ignores untouched historical boards until turn mutation or activateTurnSwarm', async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-baseline-'))
  try {
    const { swarmDir } = await writeSwarmFixture(brainDir)
    const emitted: Array<{ rev: number; totalPosts: number }> = []
    const watcher = new AntigravitySwarmWatcher({
      brainDir,
      conversationId: COORD_CONV,
      pollMs: 60_000,
      seedBaselineOnStart: true,
      onSnapshot: (snap) => emitted.push({ rev: snap.revision, totalPosts: snap.totalPosts }),
    })
    watcher.start()
    watcher.kick()
    assert.equal(emitted.length, 0, 'ordinary follow-up must not emit historical board')
    assert.equal(watcher.hasTurnActivity(), false)

    // Coordinator-only transcript advance (normal USER_INPUT on an ordinary follow-up)
    // must NOT reactivate or emit the historical swarm board.
    const coordLogDir = path.join(brainDir, COORD_CONV, '.system_generated', 'logs')
    await mkdir(coordLogDir, { recursive: true })
    await writeFile(
      path.join(coordLogDir, 'transcript.jsonl'),
      `${JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T01:00:00.000Z' })}\n`,
    )
    watcher.kick()
    assert.equal(emitted.length, 0, 'coordinator-only USER_INPUT must not emit historical board')
    assert.equal(watcher.hasTurnActivity(), false)
    assert.equal(watcher.stopAndReadFinal('completed'), null, 'untouched follow-up must not persist duplicate board')

    // Case 2: explicit swarm tool calls activateTurnSwarm -> immediately emits existing board
    const emitted2: Array<{ rev: number; totalPosts: number }> = []
    const watcher2 = new AntigravitySwarmWatcher({
      brainDir,
      conversationId: COORD_CONV,
      pollMs: 60_000,
      seedBaselineOnStart: true,
      onSnapshot: (snap) => emitted2.push({ rev: snap.revision, totalPosts: snap.totalPosts }),
    })
    watcher2.start()
    assert.equal(emitted2.length, 0)
    watcher2.activateTurnSwarm()
    assert.equal(emitted2.length, 1)
    assert.equal(watcher2.hasTurnActivity(), true)
    const settled2 = watcher2.stopAndReadFinal('completed')
    assert.ok(settled2)
    assert.equal(settled2.phase, 'completed')

    // Case 3: real disk change during resumed turn flips turnActive and emits
    const emitted3: Array<{ rev: number; totalPosts: number }> = []
    const watcher3 = new AntigravitySwarmWatcher({
      brainDir,
      conversationId: COORD_CONV,
      pollMs: 60_000,
      seedBaselineOnStart: true,
      onSnapshot: (snap) => emitted3.push({ rev: snap.revision, totalPosts: snap.totalPosts }),
    })
    watcher3.start()
    assert.equal(emitted3.length, 0)
    await writeFile(
      path.join(swarmDir, 'board.jsonl'),
      `${readFileSync(path.join(swarmDir, 'board.jsonl'), 'utf8')}${JSON.stringify({
        seq: 3,
        agent: 'coordinator',
        text: '[done] 新增汇报',
      })}\n`,
    )
    watcher3.kick()
    assert.equal(emitted3.length, 1)
    assert.equal(emitted3[0]?.totalPosts, 3)
    assert.equal(watcher3.hasTurnActivity(), true)
    const settled3 = watcher3.stopAndReadFinal('interrupted')
    assert.ok(settled3)
    assert.equal(settled3.phase, 'interrupted')
  } finally {
    await rm(brainDir, { recursive: true, force: true })
  }
})

test('BLOCKER 2: watcher rejects intermediate directory symlinks and isolates session brains', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'oc-swarm-boundary-'))
  const prevHome = process.env.OPENCLAUDE_HOME
  process.env.OPENCLAUDE_HOME = root
  try {
    // 1. Two distinct OpenClaude sessions receive distinct sessionBrainDirs
    const projA = projectAntigravityPlatform({
      credential: { accessToken: 'tok', accessTokenExpiresAt: '2026-12-01T00:00:00Z' },
      agentId: 'main',
      sessionKey: 'agent:main:webchat:dm:session-A',
      gatewayPort: 18789,
      gatewayToken: '',
      delegationDepth: 0,
    })
    const projB = projectAntigravityPlatform({
      credential: { accessToken: 'tok', accessTokenExpiresAt: '2026-12-01T00:00:00Z' },
      agentId: 'main',
      sessionKey: 'agent:main:webchat:dm:session-B',
      gatewayPort: 18789,
      gatewayToken: '',
      delegationDepth: 0,
    })
    assert.notEqual(projA.sessionBrainDir, projB.sessionBrainDir)
    await writeSwarmFixture(projA.sessionBrainDir)
    assert.ok(readAntigravitySwarmSnapshot({ brainDir: projA.sessionBrainDir, conversationId: COORD_CONV, phase: 'running', revision: 1 }))
    assert.equal(readAntigravitySwarmSnapshot({ brainDir: projB.sessionBrainDir, conversationId: COORD_CONV, phase: 'running', revision: 1 }), null)

    // 2. Intermediate symlink in B pointing at A's conversation dir is rejected
    symlinkSync(path.join(projA.sessionBrainDir, COORD_CONV), path.join(projB.sessionBrainDir, COORD_CONV))
    assert.equal(
      readAntigravitySwarmSnapshot({ brainDir: projB.sessionBrainDir, conversationId: COORD_CONV, phase: 'running', revision: 1 }),
      null,
      'symlinked coordinator dir must be rejected',
    )

    // 3. Symlinked member transcript dir inside A is ignored (transcript not leaked)
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-outside-'))
    const outsideLogs = path.join(outsideDir, '.system_generated', 'logs')
    await mkdir(outsideLogs, { recursive: true })
    await writeFile(
      path.join(outsideLogs, 'transcript.jsonl'),
      `${JSON.stringify({ step_index: 0, type: 'ERROR_MESSAGE', status: 'ERROR', content: 'SECRET_LEAK' })}\n`,
    )
    symlinkSync(outsideDir, path.join(projA.sessionBrainDir, OTHER_CONV))
    await writeFile(
      path.join(projA.sessionBrainDir, COORD_CONV, '.system_generated', 'swarm', 'members.json'),
      JSON.stringify({
        title: '边界验证',
        members: {
          escaped: { conversation_id: OTHER_CONV, role: 'worker', killed: false },
        },
      }),
    )
    const snapA = readAntigravitySwarmSnapshot({
      brainDir: projA.sessionBrainDir,
      conversationId: COORD_CONV,
      phase: 'running',
      revision: 2,
    })
    assert.ok(snapA)
    const escaped = snapA.members.find((m) => m.name === 'escaped')
    assert.ok(escaped)
    assert.equal(escaped.lastError, undefined, 'symlinked member dir transcript must not be read')
    assert.equal(escaped.stepCount, 0)

    // 4. Launch cleanup preserves sessionBrainDir across sequential turns
    const launchBrainA = path.join(projA.launchHome, '.gemini', 'antigravity-cli', 'brain')
    assert.equal(lstatSync(launchBrainA).isSymbolicLink(), true)
    cleanupAntigravityLaunch(projA)
    cleanupAntigravityLaunch(projB)
    assert.equal(existsSync(projA.launchHome), false)
    assert.equal(
      existsSync(
        path.join(
          antigravitySessionBrainDir(projA.root, 'agent:main:webchat:dm:session-A'),
          COORD_CONV,
          '.system_generated',
          'swarm',
          'members.json',
        ),
      ),
      true,
    )
    await rm(outsideDir, { recursive: true, force: true })
  } finally {
    if (prevHome === undefined) delete process.env.OPENCLAUDE_HOME
    else process.env.OPENCLAUDE_HOME = prevHome
    await rm(root, { recursive: true, force: true })
  }
})

test('OCV5-819 L2: reduceLiveFrames natively folds swarm_snapshot (full + delta) into a single latest-wins SwarmBoard unit and pins it in first pack', () => {
  assert.equal(LIVE_UNITS_REDUCER_EPOCH, '4')
  const baseSnap: SwarmSnapshot = {
    swarmId: COORD_CONV,
    title: '运行中蜂群',
    phase: 'running',
    revision: 1,
    updatedAt: 1000,
    postsMode: 'full',
    members: [
      { name: 'coordinator', role: 'coordinator', status: 'waiting', stepCount: 1, unreadCount: 0 },
      { name: 'parser', role: 'worker', status: 'working', workspace: 'share', stepCount: 2, unreadCount: 0 },
    ],
    channels: [{ name: 'main', memberCount: 2, postCount: 1 }],
    posts: [{ seq: 1, agent: 'coordinator', text: '任务开始', channel: 'main', mentions: [] }],
    totalPosts: 1,
  }
  const deltaSnap: SwarmSnapshot = {
    ...baseSnap,
    revision: 2,
    updatedAt: 2000,
    postsMode: 'delta',
    deltaBaseSeq: 1,
    posts: [{ seq: 2, agent: 'parser', text: '完成解析模块', channel: 'main', mentions: ['coordinator'] }],
    totalPosts: 2,
  }
  const staleSnap: SwarmSnapshot = {
    ...baseSnap,
    title: '旧标题不应覆盖',
    revision: 1,
  }
  const folded = reduceLiveFrames([
    {
      recordId: 'r-6',
      streamKey: 's1:gen0',
      clientMessageId: 'cmid-1',
      payload: {
        type: 'outbound.message',
        frameSeq: 6,
        sessionKey: 'agent:main:webchat:dm:s1',
        blocks: [{ kind: 'text', messageId: 'm-1', text: '正在协调' }],
      },
    },
    {
      recordId: 'r-7',
      streamKey: 's1:gen0',
      clientMessageId: 'cmid-1',
      payload: {
        type: 'outbound.message',
        frameSeq: 7,
        sessionKey: 'agent:main:webchat:dm:s1',
        blocks: [{ kind: 'swarm_snapshot', blockId: 'agy-swarm-11111111-t0', snapshot: baseSnap }],
      },
    },
    {
      recordId: 'r-8',
      streamKey: 's1:gen0',
      clientMessageId: 'cmid-1',
      payload: {
        type: 'outbound.message',
        frameSeq: 8,
        sessionKey: 'agent:main:webchat:dm:s1',
        blocks: [{ kind: 'text', messageId: 'm-1', text: '继续汇报' }],
      },
    },
  ])
  assert.equal(folded.ok, true)
  if (!folded.ok) throw new Error('expected ok')
  // Sideband swarm_snapshot must NOT split streaming text into two separate units
  const textUnits = folded.state.units.filter((u) => u.kind === 'text')
  assert.equal(textUnits.length, 1)
  assert.equal(textUnits[0]?.text, '正在协调继续汇报')

  // Continue reducing delta + stale frames incrementally (simulating checkpoint continuation)
  const checkpoint = foldLiveUnitStateForCheckpoint(folded.state)
  assert.ok(checkpoint)
  const continued = continueReduceLiveFrames(checkpoint.state, [
    {
      recordId: 'r-9',
      streamKey: 's1:gen0',
      clientMessageId: 'cmid-1',
      payload: {
        type: 'outbound.message',
        frameSeq: 9,
        sessionKey: 'agent:main:webchat:dm:s1',
        blocks: [{ kind: 'swarm_snapshot', blockId: 'agy-swarm-11111111-t0', snapshot: deltaSnap }],
      },
    },
    {
      recordId: 'r-10',
      streamKey: 's1:gen0',
      clientMessageId: 'cmid-1',
      payload: {
        type: 'outbound.message',
        frameSeq: 10,
        sessionKey: 'agent:main:webchat:dm:s1',
        blocks: [{ kind: 'swarm_snapshot', blockId: 'agy-swarm-11111111-t0', snapshot: staleSnap }],
      },
    },
  ])
  assert.equal(continued.ok, true)
  if (!continued.ok) throw new Error('expected continued ok')

  const swarmUnits = continued.state.units.filter((u) => u.toolName === SWARM_BOARD_TOOL_NAME)
  assert.equal(swarmUnits.length, 1, 'multiple swarm_snapshot frames must fold into 1 unit')
  const env = swarmUnits[0]!.inputJson as { snapshot: SwarmSnapshot }
  assert.equal(env.snapshot.revision, 2)
  assert.equal(env.snapshot.title, '运行中蜂群')
  assert.deepEqual(env.snapshot.posts.map((p) => p.seq), [1, 2])
  assert.equal(env.snapshot.postsMode, undefined, 'folded snapshot is normalized full')

  // First pack pins still-open SwarmBoard even when n=1
  const page = serveLiveUnits(
    continued.state,
    { streamClientMessageIds: ['cmid-1'], openDispatch: true, hasTapeProjection: false, tapeProjectionVersion: 0 },
    { n: 1 },
  )
  assert.equal(page.degraded, false)
  assert.ok(page.units.some((u) => u.toolName === SWARM_BOARD_TOOL_NAME))
  assert.equal(page.resume?.frameSeq, 10)
})

test('OCV5-819 L1: watcher emits delta posts, coalesces activity-only churn, ignores lastActiveAt jitter, and emits structural changes immediately', async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-delta-'))
  try {
    const { swarmDir } = await writeSwarmFixture(brainDir)
    const parserLogs = path.join(brainDir, WORKER_CONV, '.system_generated', 'logs')
    let fakeNow = 10_000
    const emitted: SwarmSnapshot[] = []
    const watcher = new AntigravitySwarmWatcher({
      brainDir,
      conversationId: COORD_CONV,
      pollMs: 60_000,
      activityThrottleMs: 2_500,
      fullKeyframeIntervalEmits: 5,
      now: () => fakeNow,
      onSnapshot: (snap) => emitted.push(snap),
    })

    // 1. First emission is always full keyframe with both existing posts.
    watcher.start()
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0]!.postsMode, 'full')
    assert.equal(emitted[0]!.posts.length, 2)

    // 2. Pure timestamp jitter (same step_index/activity, different created_at) emits nothing.
    fakeNow += 500
    await writeFile(
      path.join(parserLogs, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T00:00:00.000Z' }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'RUNNING',
          created_at: '2026-11-20T00:00:09.999Z',
          tool_calls: [{ name: 'edit_file', arguments: { Path: '/repo/src/parser.ts' } }],
        }),
      ].join('\n') + '\n',
    )
    watcher.kick()
    assert.equal(emitted.length, 1, 'lastActiveAt-only change must not emit')

    // 3. Activity-only change within activityThrottleMs is coalesced (not emitted immediately).
    fakeNow += 400
    await writeFile(
      path.join(parserLogs, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: '2026-11-20T00:00:00.000Z' }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          status: 'RUNNING',
          created_at: '2026-11-20T00:00:12.000Z',
          tool_calls: [{ name: 'read_file', arguments: { Path: '/repo/src/lexer.ts' } }],
        }),
      ].join('\n') + '\n',
    )
    watcher.kick()
    assert.equal(emitted.length, 1, 'activity-only update within throttle window must coalesce')

    // 4. Structural change (new board post) bypasses activity throttle with 0ms delay and sends delta posts!
    fakeNow += 200
    await writeFile(
      path.join(swarmDir, 'board.jsonl'),
      `${readFileSync(path.join(swarmDir, 'board.jsonl'), 'utf8')}${JSON.stringify({
        seq: 3,
        agent: 'parser',
        channel: 'parser',
        text: '新增第 3 条增量帖',
      })}\n`,
    )
    watcher.kick()
    assert.equal(emitted.length, 2, 'new board post must emit immediately')
    assert.equal(emitted[1]!.postsMode, 'delta')
    assert.equal(emitted[1]!.deltaBaseSeq, 2)
    assert.deepEqual(emitted[1]!.posts.map((p) => p.seq), [3])

    // 5. Activity-only change AFTER throttle window emits delta with empty posts[] (tiny payload).
    fakeNow += 3_000
    await writeFile(
      path.join(parserLogs, 'transcript.jsonl'),
      [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE' }),
        JSON.stringify({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          status: 'RUNNING',
          tool_calls: [{ name: 'write_file', arguments: { Path: '/repo/src/ast.ts' } }],
        }),
      ].join('\n') + '\n',
    )
    watcher.kick()
    assert.equal(emitted.length, 3)
    assert.equal(emitted[2]!.postsMode, 'delta')
    assert.equal(emitted[2]!.posts.length, 0, 'activity-only delta carries zero repeated posts')

    // Replaying all emitted wire snapshots through mergeSwarmSnapshots reconstructs full state losslessly.
    let reconstructed: SwarmSnapshot | null = null
    for (const frameSnap of emitted) {
      reconstructed = mergeSwarmSnapshots(reconstructed, frameSnap) ?? reconstructed
    }
    assert.ok(reconstructed)
    assert.deepEqual(reconstructed.posts.map((p) => p.seq), [1, 2, 3])
    assert.equal(reconstructed.totalPosts, 3)

    // Terminal snapshot is always full & clean.
    const finalSnap = watcher.stopAndReadFinal('completed')
    assert.ok(finalSnap)
    assert.equal(finalSnap.posts.length, 3)
    assert.equal(finalSnap.postsMode, undefined)
  } finally {
    await rm(brainDir, { recursive: true, force: true })
  }
})

test('OCV5-819 B7: missing delta base fails closed in mergeSwarmSnapshotsStrict & reduceLiveFrames, and quiet keyframe timer self-heals', async () => {
  const full1: SwarmSnapshot = {
    swarmId: COORD_CONV,
    title: '防缺帖测试',
    phase: 'running',
    revision: 1,
    updatedAt: 1000,
    postsMode: 'full',
    members: [],
    channels: [{ name: 'main', memberCount: 1, postCount: 1 }],
    posts: [{ seq: 1, agent: 'coordinator', text: '帖1', channel: 'main', mentions: [] }],
    totalPosts: 1,
  }
  // Delta 3 assumes post #2 was seen (deltaBaseSeq=2), but post #2 is missing!
  const gappedDelta3: SwarmSnapshot = {
    ...full1,
    revision: 3,
    updatedAt: 3000,
    postsMode: 'delta',
    deltaBaseSeq: 2,
    posts: [{ seq: 3, agent: 'parser', text: '帖3', channel: 'main', mentions: [] }],
    totalPosts: 3,
  }
  const strict = mergeSwarmSnapshotsStrict(full1, gappedDelta3)
  assert.deepEqual(strict, { ok: false, reason: 'missing_base' })
  assert.equal(mergeSwarmSnapshots(full1, gappedDelta3), null)

  // reduceLiveFrames MUST fail closed to fallback instead of certifying [1, 3] and minting resume!
  const reduced = reduceLiveFrames([
    {
      recordId: 'r-1',
      streamKey: 'dispatch:g1:1',
      clientMessageId: 'cm-1',
      payload: {
        type: 'outbound.message',
        frameSeq: 1,
        sessionKey: 'agent:main:webchat:dm:s1',
        blocks: [{ kind: 'swarm_snapshot', blockId: 'agy-swarm-11111111-t0', snapshot: full1 }],
      },
    },
    {
      recordId: 'r-2',
      streamKey: 'dispatch:g1:1',
      clientMessageId: 'cm-1',
      payload: {
        type: 'outbound.message',
        frameSeq: 2,
        sessionKey: 'agent:main:webchat:dm:s1',
        blocks: [{ kind: 'swarm_snapshot', blockId: 'agy-swarm-11111111-t0', snapshot: gappedDelta3 }],
      },
    },
  ])
  assert.deepEqual(reduced, { ok: false, degraded: 'fallback' })

  // Quiet keyframe timer emits one authoritative full keyframe after delta goes quiet
  const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-quiet-kf-'))
  try {
    const { swarmDir } = await writeSwarmFixture(brainDir)
    const emitted: SwarmSnapshot[] = []
    const watcher = new AntigravitySwarmWatcher({
      brainDir,
      conversationId: COORD_CONV,
      pollMs: 60_000,
      activityThrottleMs: 0,
      fullKeyframeIntervalEmits: 100,
      fullKeyframeIntervalMs: 40,
      onSnapshot: (snap) => emitted.push(snap),
    })
    watcher.start()
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0]!.postsMode, 'full')
    await writeFile(
      path.join(swarmDir, 'board.jsonl'),
      `${readFileSync(path.join(swarmDir, 'board.jsonl'), 'utf8')}${JSON.stringify({
        seq: 3,
        agent: 'parser',
        channel: 'parser',
        text: '静默前最后一条',
      })}\n`,
    )
    watcher.kick()
    assert.equal(emitted.length, 2)
    assert.equal(emitted[1]!.postsMode, 'delta')
    // Wait for quiet keyframe timer without any new disk writes
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(emitted.length, 3, 'quiet keyframe timer must emit one full self-heal snapshot')
    assert.equal(emitted[2]!.postsMode, 'full')
    assert.equal(emitted[2]!.posts.length, 3)
    watcher.stop()
  } finally {
    await rm(brainDir, { recursive: true, force: true })
  }
})

test('NON-BLOCKING 1 & BLOCKER 7: UTF-8 byte-bounded durable envelope + disk-free terminal settlement', () => {
  const bigPosts = Array.from({ length: 120 }, (_, i) => ({
    seq: i + 1,
    agent: i % 2 === 0 ? 'parser' : 'verifier',
    channel: 'main',
    text: `@coordinator 第 ${i + 1} 条全中文超长汇报：${'高密度汉字内容测试字节上限'.repeat(120)}`,
    mentions: ['coordinator'],
  }))
  const manyMembers = Array.from({ length: 32 }, (_, i) => ({
    name: `中文成员编号_${i}_${'长名'.repeat(10)}`,
    role: 'worker' as const,
    status: 'working' as const,
    stepCount: i + 1,
    unreadCount: 2,
    activity: '正在深度分析多模块并行架构并持续写入测试报告'.repeat(4),
    lastError: '中文错误摘要'.repeat(20),
  }))
  const snap = {
    swarmId: COORD_CONV,
    title: '超大型全中文重构蜂群标题'.repeat(6),
    phase: 'running' as const,
    revision: 99,
    updatedAt: Date.now(),
    members: manyMembers,
    channels: Array.from({ length: 24 }, (_, i) => ({
      name: `频道_${i}_${'主题'.repeat(4)}`,
      topic: '全中文讨论频道说明'.repeat(8),
      memberCount: 5,
      postCount: 10,
    })),
    posts: bigPosts,
    totalPosts: 120,
  }
  const settled = settleSwarmSnapshotTerminal(snap, 'interrupted')
  assert.equal(settled.phase, 'interrupted')
  assert.equal(settled.revision, 100)
  assert.ok(settled.members.every((m) => m.status === 'waiting'))

  const compact = compactSwarmSnapshotForPersistence(settled, 13_000)
  const envelope = buildDurableSwarmBoardInput(settled, 13_000)
  const utf8Bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8')
  assert.ok(utf8Bytes <= 13_000, `expected <= 13000 UTF-8 bytes, got ${utf8Bytes}`)
  assert.equal(compact.totalPosts, 120)
  assert.ok((compact.truncatedPosts ?? 0) > 0)
})

test('AntigravitySwarmWatcher deduplicates unchanged snapshots, reacts to new posts, and settles on stopAndReadFinal', async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-poll-'))
  try {
    const { swarmDir } = await writeSwarmFixture(brainDir)
    const emitted: Array<{ rev: number; totalPosts: number; phase: string }> = []
    const watcher = new AntigravitySwarmWatcher({
      brainDir,
      conversationId: COORD_CONV,
      pollMs: 60_000,
      onSnapshot: (snap) => {
        emitted.push({ rev: snap.revision, totalPosts: snap.totalPosts, phase: snap.phase })
      },
    })
    watcher.start()
    watcher.kick() // unchanged -> deduplicated
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0]?.rev, 1)

    await writeFile(
      path.join(swarmDir, 'board.jsonl'),
      `${readFileSync(path.join(swarmDir, 'board.jsonl'), 'utf8')}${JSON.stringify({
        seq: 3,
        agent: 'coordinator',
        text: '[done] 解析器重构完成',
      })}\n`,
    )
    watcher.kick()
    assert.equal(emitted.length, 2)
    assert.equal(emitted[1]?.totalPosts, 3)

    const finalSnap = watcher.stopAndReadFinal('completed')
    assert.ok(finalSnap)
    assert.equal(finalSnap.phase, 'completed')
    assert.ok(finalSnap.revision > emitted[1]!.rev)
    assert.ok(finalSnap.members.every((m) => m.status !== 'working'))
  } finally {
    await rm(brainDir, { recursive: true, force: true })
  }
})

test('swarm tool normalization strips local open_board URLs and parses /swarm slash commands', () => {
  assert.equal(antigravityProductToolName('swarm'), 'SwarmManage')
  assert.equal(antigravityProductToolName('post_message'), 'SwarmPost')
  assert.equal(antigravityProductToolName('read_board'), 'SwarmReadBoard')
  assert.equal(antigravityProductToolName('swarm_wait'), 'SwarmWait')
  assert.equal(antigravityProductToolName('read_file'), 'Read')
  assert.equal(antigravityProductToolName('edit_file'), 'Edit')

  const cleaned = antigravityToolOutput(
    JSON.stringify({ ok: true, name: 'parser', open_board: 'http://127.0.0.1:43210/board' }),
    'swarm',
  )
  assert.equal(cleaned.includes('open_board'), false)
  assert.equal(cleaned.includes('parser'), true)
  assert.equal(sanitizeSwarmToolOutput('ok\nopen_board: /swarm board\ndone'), 'ok\n\ndone')

  assert.deepEqual(parseSwarmSlashCommand('/swarm 重构路由模块'), { matched: true, task: '重构路由模块' })
  assert.deepEqual(parseSwarmSlashCommand('/swarm'), { matched: true, task: '' })
  assert.equal(parseSwarmSlashCommand('/swarming hello'), null)
  assert.deepEqual(extractSwarmMentions('hi @parser and @#ui, not a@b.com'), ['parser', '#ui'])

  const errSummary = parseMemberTranscriptTail(
    JSON.stringify({ step_index: 4, type: 'ERROR_MESSAGE', status: 'ERROR', content: 'quota exceeded' }),
  )
  assert.equal(errSummary.failed, true)
  assert.equal(errSummary.stepCount, 5)
})

test('incremental transcript telemetry accumulates elapsedMs, inputTokens, outputTokens and toolCalls across appends without re-reading earlier bytes', async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-telemetry-'))
  try {
    await writeSwarmFixture(brainDir)
    const workerLogPath = path.join(brainDir, WORKER_CONV, '.system_generated', 'logs', 'transcript.jsonl')

    // Write initial steps with usage + 2 tool calls
    const step0 = JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-20T00:10:00.000Z',
    })
    const step1 = JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      usage: { input_tokens: 1200, output_tokens: 340 },
      tool_calls: [
        { name: 'read_file', arguments: { Path: '/repo/a.ts' } },
        { name: 'edit_file', arguments: { Path: '/repo/a.ts' } },
      ],
      created_at: '2026-11-20T00:10:15.000Z',
    })
    await writeFile(workerLogPath, `${step0}\n${step1}\n`)

    const cache = new IncrementalTranscriptTelemetryCache()
    const snap1 = readAntigravitySwarmSnapshot({
      brainDir,
      conversationId: COORD_CONV,
      phase: 'running',
      revision: 1,
      now: Date.parse('2026-11-20T00:10:20.000Z'),
      telemetryCache: cache,
    })
    const parser1 = snap1?.members.find((m) => m.name === 'parser')
    assert.ok(parser1)
    assert.equal(parser1.inputTokens, 1200)
    assert.equal(parser1.outputTokens, 340)
    assert.equal(parser1.toolCalls, 2)
    assert.equal(parser1.elapsedMs, 20_000)

    // Append a second planner step with camelCase token_usage + 1 tool call
    const step2 = JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      token_usage: { promptTokens: 800, completionTokens: 210 },
      tool_calls: [{ name: 'run_command', arguments: { CommandLine: 'npm test' } }],
      created_at: '2026-11-20T00:10:45.000Z',
    })
    await writeFile(workerLogPath, `${step0}\n${step1}\n${step2}\n`)

    const snap2 = readAntigravitySwarmSnapshot({
      brainDir,
      conversationId: COORD_CONV,
      phase: 'running',
      revision: 2,
      now: Date.parse('2026-11-20T00:10:50.000Z'),
      telemetryCache: cache,
    })
    const parser2 = snap2?.members.find((m) => m.name === 'parser')
    assert.ok(parser2)
    assert.equal(parser2.inputTokens, 2000)
    assert.equal(parser2.outputTokens, 550)
    assert.equal(parser2.toolCalls, 3)
    assert.equal(parser2.elapsedMs, 50_000)

    // Verifier has no usage/toolCalls -> optional telemetry fields stay omitted (100% backwards-compatible)
    const verifier2 = snap2?.members.find((m) => m.name === 'verifier')
    assert.ok(verifier2)
    assert.equal(verifier2.inputTokens, undefined)
    assert.equal(verifier2.outputTokens, undefined)
    assert.equal(verifier2.toolCalls, undefined)
  } finally {
    await rm(brainDir, { recursive: true, force: true })
  }
})

test('B7: 4,000-line / ~442KB quiet transcript with multi-byte UTF-8 drains to exact 4,000 total (never stuck at partial 1,190/2,371) and marks partial during backlog', async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-b7-4000-'))
  try {
    await writeSwarmFixture(brainDir)
    const workerLogPath = path.join(brainDir, WORKER_CONV, '.system_generated', 'logs', 'transcript.jsonl')

    // Build 4,000 lines (~440KB+), including multi-byte CJK chars so 128KiB chunks cut mid-character
    const lines: string[] = []
    const baseMs = Date.parse('2026-11-20T00:00:00.000Z')
    for (let i = 0; i < 4000; i += 1) {
      lines.push(
        JSON.stringify({
          step_index: i,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: `中文遥测步-${i}`,
          usage: { input_tokens: 1, output_tokens: 2 },
          tool_calls: [{ name: 'read_file', arguments: { Path: `/repo/f${i}.ts` } }],
          created_at: new Date(baseMs + i * 1000).toISOString(),
        }),
      )
    }
    const payload = `${lines.join('\n')}\n`
    assert.ok(Buffer.byteLength(payload, 'utf8') > 400_000)
    await writeFile(workerLogPath, payload)

    const emitted: SwarmSnapshot[] = []
    const watcher = new AntigravitySwarmWatcher({
      brainDir,
      conversationId: COORD_CONV,
      pollMs: 60_000,
      activityThrottleMs: 0,
      onSnapshot: (snap) => emitted.push(snap),
    })

    // First tick scans 128KiB chunk → MUST honestly mark telemetryPartial=true while backlog remains
    watcher.start()
    assert.ok(emitted.length >= 1)
    const firstParser = emitted[0]!.members.find((m) => m.name === 'parser')!
    assert.ok((firstParser.inputTokens ?? 0) > 0 && (firstParser.inputTokens ?? 0) < 4000)
    assert.equal(firstParser.telemetryPartial, true)

    // Allow quiet-log backlog catch-up timers to advance even with ZERO file mtime changes
    await new Promise((r) => setTimeout(r, 150))

    // Terminal stopAndReadFinal drains remaining backlog to EOF and reports exact 4,000
    const finalSnap = watcher.stopAndReadFinal('completed')
    assert.ok(finalSnap)
    const finalParser = finalSnap.members.find((m) => m.name === 'parser')!
    assert.equal(finalParser.inputTokens, 4000)
    assert.equal(finalParser.outputTokens, 8000)
    assert.equal(finalParser.toolCalls, 4000)
    assert.equal(finalParser.telemetryPartial, undefined)
  } finally {
    await rm(brainDir, { recursive: true, force: true })
  }
})

test('B7: budget-capped telemetry scanner marks partial=true honestly and resets cleanly on file rotation', async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-b7-budget-'))
  try {
    await writeSwarmFixture(brainDir)
    const workerLogPath = path.join(brainDir, WORKER_CONV, '.system_generated', 'logs', 'transcript.jsonl')
    const chunk = Array.from({ length: 120 }, (_, i) =>
      JSON.stringify({
        step_index: i,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        usage: { input_tokens: 10 },
      }),
    ).join('\n') + '\n'
    await writeFile(workerLogPath, chunk)

    // Budget smaller than file size -> partial MUST stay true even when drainAll=true
    const tinyCache = new IncrementalTranscriptTelemetryCache(4096, 4096)
    const partialSnap = readAntigravitySwarmSnapshot({
      brainDir,
      conversationId: COORD_CONV,
      phase: 'completed',
      revision: 1,
      telemetryCache: tinyCache,
      drainTelemetry: true,
    })
    const pMember = partialSnap?.members.find((m) => m.name === 'parser')
    assert.equal(pMember?.telemetryPartial, true)
    assert.ok((pMember?.inputTokens ?? 0) < 1200)

    // Truncate/rotate file -> cursor resets cleanly to new smaller file
    await writeFile(
      workerLogPath,
      `${JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', status: 'DONE', usage: { input_tokens: 77 } })}\n`,
    )
    const afterRotate = readAntigravitySwarmSnapshot({
      brainDir,
      conversationId: COORD_CONV,
      phase: 'running',
      revision: 2,
      telemetryCache: tinyCache,
    })
    const rMember = afterRotate?.members.find((m) => m.name === 'parser')
    assert.equal(rMember?.inputTokens, 77)
    assert.equal(rMember?.telemetryPartial, undefined)
  } finally {
    await rm(brainDir, { recursive: true, force: true })
  }
})

test('B7: trailing half-written JSON at EOF marks telemetryPartial=true on both live and terminal drain; complete JSON without trailing newline does not false-positive', async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-b7-tail-'))
  try {
    await writeSwarmFixture(brainDir)
    const workerLogPath = path.join(brainDir, WORKER_CONV, '.system_generated', 'logs', 'transcript.jsonl')
    const line1 = JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      usage: { input_tokens: 7 },
    })

    // 1) Complete JSON without trailing newline -> partial MUST be false/undefined
    await writeFile(workerLogPath, line1)
    const cacheNoNl = new IncrementalTranscriptTelemetryCache()
    const snapNoNl = readAntigravitySwarmSnapshot({
      brainDir,
      conversationId: COORD_CONV,
      phase: 'completed',
      revision: 1,
      telemetryCache: cacheNoNl,
      drainTelemetry: true,
    })
    const mNoNl = snapNoNl?.members.find((m) => m.name === 'parser')
    assert.equal(mNoNl?.inputTokens, 7)
    assert.equal(mNoNl?.telemetryPartial, undefined)

    // 2) Complete 7-token line + half-written trailing JSON -> partial MUST be true on BOTH live scan and terminal drain!
    const halfLine = '{"step_index":1,"type":"PLANNER_RESPONSE","usage":{"input_tokens":'
    await writeFile(workerLogPath, `${line1}\n${halfLine}`)
    const cache = new IncrementalTranscriptTelemetryCache()
    const liveSnap = readAntigravitySwarmSnapshot({
      brainDir,
      conversationId: COORD_CONV,
      phase: 'running',
      revision: 2,
      telemetryCache: cache,
    })
    const liveMember = liveSnap?.members.find((m) => m.name === 'parser')
    assert.equal(liveMember?.inputTokens, 7)
    assert.equal(liveMember?.telemetryPartial, true)

    const termSnap = readAntigravitySwarmSnapshot({
      brainDir,
      conversationId: COORD_CONV,
      phase: 'completed',
      revision: 3,
      telemetryCache: cache,
      drainTelemetry: true,
    })
    const termMember = termSnap?.members.find((m) => m.name === 'parser')
    assert.equal(termMember?.inputTokens, 7)
    assert.equal(termMember?.telemetryPartial, true)

    // 3) Once writer finishes the half-written line -> subtotal advances to 12 and telemetryPartial clears!
    await writeFile(workerLogPath, `${line1}\n${halfLine}5}}\n`)
    const healedSnap = readAntigravitySwarmSnapshot({
      brainDir,
      conversationId: COORD_CONV,
      phase: 'completed',
      revision: 4,
      telemetryCache: cache,
      drainTelemetry: true,
    })
    const healedMember = healedSnap?.members.find((m) => m.name === 'parser')
    assert.equal(healedMember?.inputTokens, 12)
    assert.equal(healedMember?.telemetryPartial, undefined)
  } finally {
    await rm(brainDir, { recursive: true, force: true })
  }
})

test('OCV5-837: activity-only churn does not emit redundant full keyframes when no new posts arrived', async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-no-bloat-'))
  try {
    const { swarmDir } = await writeSwarmFixture(brainDir)
    const workerLog = path.join(brainDir, WORKER_CONV, '.system_generated', 'logs', 'transcript.jsonl')
    const emitted: SwarmSnapshot[] = []
    let fakeNow = 1_000_000
    const watcher = new AntigravitySwarmWatcher({
      brainDir,
      conversationId: COORD_CONV,
      pollMs: 60_000,
      activityThrottleMs: 0,
      fullKeyframeIntervalEmits: 2,
      fullKeyframeIntervalMs: 30,
      now: () => fakeNow,
      onSnapshot: (snap) => emitted.push(snap),
    })
    watcher.start()
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0]!.postsMode, 'full')

    // 4 activity-only transcript steps spanning well past fullKeyframeIntervalEmits (2) & Ms (30)
    // with ZERO new board posts -> must remain tiny deltas, zero redundant full frames!
    for (let step = 10; step < 14; step += 1) {
      fakeNow += 60_000
      await writeFile(
        workerLog,
        `${readFileSync(workerLog, 'utf8')}${JSON.stringify({
          step_index: step,
          type: 'PLANNER_RESPONSE',
          status: 'RUNNING',
          tool_calls: [{ name: 'read_file', arguments: { Path: `/tmp/f${step}.ts` } }],
        })}\n`,
      )
      watcher.kick()
    }
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(emitted.length, 5)
    for (let i = 1; i < emitted.length; i += 1) {
      assert.equal(emitted[i]!.postsMode, 'delta', `activity emission #${i} must stay delta`)
      assert.equal(emitted[i]!.posts.length, 0, `activity emission #${i} must not repeat posts`)
    }

    // Now a genuine new board post arrives -> emits delta (or full if due) and heals on quiet timer.
    fakeNow += 10
    await writeFile(
      path.join(swarmDir, 'board.jsonl'),
      `${readFileSync(path.join(swarmDir, 'board.jsonl'), 'utf8')}${JSON.stringify({
        seq: 3,
        agent: 'parser',
        channel: 'parser',
        text: '新增第 3 条真实讨论',
      })}\n`,
    )
    watcher.kick()
    assert.equal(emitted.length, 6)
    assert.equal(emitted[5]!.postsMode, 'full', 'new post after exceeded keyframe interval promotes to full keyframe')
    assert.equal(emitted[5]!.posts.length, 3)
    watcher.stop()
  } finally {
    await rm(brainDir, { recursive: true, force: true })
  }
})

test('OCV5-842: seedBaselineOnStart stays dormant when historical worker transcripts exceed 128KB telemetry chunk cap', async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-large-baseline-'))
  try {
    const { swarmDir } = await writeSwarmFixture(brainDir)
    const workerLog = path.join(brainDir, WORKER_CONV, '.system_generated', 'logs', 'transcript.jsonl')
    // Write ~300 KB of historical worker steps (> 128 KB MAX_TELEMETRY_DELTA_BYTES)
    // so incremental scanning previously left `hasAnyBacklog() === true` after captureBaseline()
    // and falsely flipped `turnActive = true` on the very next poll tick.
    const stepCount = 320
    const pad = 'x'.repeat(850)
    const lines: string[] = []
    for (let i = 0; i < stepCount; i += 1) {
      lines.push(
        JSON.stringify({
          step_index: i,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date(1_763_600_000_000 + i * 1_000).toISOString(),
          usage: { input_tokens: 100, output_tokens: 25 },
          tool_calls: [{ name: 'read_file', arguments: { Path: `/tmp/doc-${i}.md`, note: pad } }],
        }),
      )
    }
    await writeFile(workerLog, `${lines.join('\n')}\n`, 'utf8')
    assert.ok(Buffer.byteLength(readFileSync(workerLog, 'utf8'), 'utf8') > 256 * 1024)

    // 1. Ordinary follow-up turn with Swarm toggle OFF: must stay completely dormant
    // across multiple poll intervals + coordinator USER_INPUT append + explicit kick().
    const emitted: SwarmSnapshot[] = []
    const watcher = new AntigravitySwarmWatcher({
      brainDir,
      conversationId: COORD_CONV,
      pollMs: 25,
      activityThrottleMs: 0,
      seedBaselineOnStart: true,
      onSnapshot: (snap) => emitted.push(snap),
    })
    watcher.start()
    await new Promise((r) => setTimeout(r, 120))
    const coordLogDir = path.join(brainDir, COORD_CONV, '.system_generated', 'logs')
    await mkdir(coordLogDir, { recursive: true })
    await writeFile(
      path.join(coordLogDir, 'transcript.jsonl'),
      `${JSON.stringify({
        step_index: 99,
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-22T03:18:11.000Z',
      })}\n`,
      'utf8',
    )
    watcher.kick()
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(emitted.length, 0, 'dormant resumed turn with >128KB worker logs must never emit fake SwarmBoard')
    assert.equal(watcher.hasTurnActivity(), false)
    assert.equal(watcher.stopAndReadFinal('completed'), null)

    // 2. Explicit activateTurnSwarm() on the same >256KB fixture wakes immediately
    // and terminal stopAndReadFinal() still drains full historical telemetry accurately.
    const emittedActive: SwarmSnapshot[] = []
    const watcher2 = new AntigravitySwarmWatcher({
      brainDir,
      conversationId: COORD_CONV,
      pollMs: 60_000,
      activityThrottleMs: 0,
      seedBaselineOnStart: true,
      onSnapshot: (snap) => emittedActive.push(snap),
    })
    watcher2.start()
    assert.equal(emittedActive.length, 0)
    watcher2.activateTurnSwarm()
    assert.ok(emittedActive.length >= 1, 'activateTurnSwarm must emit immediately')
    assert.equal(watcher2.hasTurnActivity(), true)
    const settled2 = watcher2.stopAndReadFinal('completed')
    assert.ok(settled2)
    const workerMember2 = settled2.members.find((m) => m.name === 'parser')
    assert.ok(workerMember2)
    assert.equal(workerMember2.toolCalls, stepCount)
    assert.equal(workerMember2.inputTokens, stepCount * 100)
    assert.equal(workerMember2.outputTokens, stepCount * 25)

    // 3. Genuine board mutation on the >256KB fixture wakes the dormant watcher and
    // preserves full terminal telemetry drain.
    const emittedMutated: SwarmSnapshot[] = []
    const watcher3 = new AntigravitySwarmWatcher({
      brainDir,
      conversationId: COORD_CONV,
      pollMs: 60_000,
      activityThrottleMs: 0,
      seedBaselineOnStart: true,
      onSnapshot: (snap) => emittedMutated.push(snap),
    })
    watcher3.start()
    assert.equal(emittedMutated.length, 0)
    await writeFile(
      path.join(swarmDir, 'board.jsonl'),
      `${readFileSync(path.join(swarmDir, 'board.jsonl'), 'utf8')}${JSON.stringify({
        seq: 3,
        agent: 'coordinator',
        text: '@parser resume',
      })}\n`,
      'utf8',
    )
    watcher3.kick()
    assert.equal(emittedMutated.length, 1)
    assert.equal(emittedMutated[0]!.totalPosts, 3)
    assert.equal(watcher3.hasTurnActivity(), true)
    const settled3 = watcher3.stopAndReadFinal('completed')
    assert.ok(settled3)
    const workerMember3 = settled3.members.find((m) => m.name === 'parser')
    assert.equal(workerMember3?.toolCalls, stepCount)
  } finally {
    await rm(brainDir, { recursive: true, force: true })
  }
})

test('OCV5-852 P0-1: native CLI 1.5.8 vs Remote status semantics, SYSTEM_MESSAGE & [swarm_wait, post_message], object workspace sanitization, >120 posts aggregation, and cacheRead/thinking telemetry', async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-852-'))
  try {
    // 1. Native CLI 1.5.8 roster: sleeping members have phase=RUNNING + wake_mode=mentions/all -> waiting;
    //    active worker has wake_mode=working -> working.
    const swarmDir = path.join(brainDir, COORD_CONV, '.system_generated', 'swarm')
    const coordLogs = path.join(brainDir, COORD_CONV, '.system_generated', 'logs')
    const workerLogs = path.join(brainDir, WORKER_CONV, '.system_generated', 'logs')
    const verifierLogs = path.join(brainDir, VERIFIER_CONV, '.system_generated', 'logs')
    await mkdir(swarmDir, { recursive: true })
    await mkdir(coordLogs, { recursive: true })
    await mkdir(workerLogs, { recursive: true })
    await mkdir(verifierLogs, { recursive: true })

    await writeFile(
      path.join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'CLI 1.5.8 原生蜂群',
        members: {
          coordinator: {
            conversation_id: COORD_CONV,
            role: 'coordinator',
            desired_state: 'RUNNING',
            applied_model: 'gemini-4-neon-high',
            workspace_mode: 'inherit',
            phase: 'RUNNING',
            wake_mode: 'mentions',
            last_read_seq: 150,
            last_nudged_seq: 150,
            killed: false,
          },
          parser: {
            conversation_id: WORKER_CONV,
            role: 'worker',
            desired_state: 'RUNNING',
            workspace_mode: 'share',
            phase: 'RUNNING',
            wake_mode: 'working',
            last_read_seq: 149,
            last_nudged_seq: 149,
            killed: false,
          },
          verifier: {
            conversation_id: VERIFIER_CONV,
            role: 'verifier',
            desired_state: 'RUNNING',
            workspace_mode: 'inherit',
            phase: 'RUNNING',
            wake_mode: 'all',
            last_read_seq: 150,
            last_nudged_seq: 150,
            killed: false,
          },
        },
      }),
    )

    // Coordinator called [swarm_wait, post_message] (swarm_wait NOT last) followed by native GENERIC DONE (no tool_name)
    await writeFile(
      path.join(coordLogs, 'transcript.jsonl'),
      `${[
        JSON.stringify({
          step_index: 10,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          input_tokens: 4000,
          cache_read_tokens: 95_000,
          output_tokens: 500,
          thinking_tokens: 1_200,
          tool_calls: [
            { name: 'swarm_wait', args: { since: '149' } },
            { name: 'post_message', args: { text: '@parser 请继续' } },
          ],
          created_at: '2026-11-22T13:00:00Z',
        }),
        JSON.stringify({
          step_index: 11,
          type: 'GENERIC',
          status: 'DONE',
          content: 'Waiting for a message...',
          created_at: '2026-11-22T13:00:01Z',
        }),
        JSON.stringify({
          step_index: 12,
          type: 'GENERIC',
          status: 'DONE',
          content: '{"status":"posted","seq":150}',
          created_at: '2026-11-22T13:00:02Z',
        }),
      ].join('\n')}\n`,
    )

    // Native worker had an old ERROR, then woke on SYSTEM_MESSAGE (no USER_INPUT)
    await writeFile(
      path.join(workerLogs, 'transcript.jsonl'),
      `${[
        JSON.stringify({ step_index: 0, type: 'ERROR_MESSAGE', status: 'ERROR', content: 'old transient error' }),
        JSON.stringify({
          step_index: 1,
          type: 'SYSTEM_MESSAGE',
          status: 'DONE',
          content: '[swarm] new board message #150',
          created_at: '2026-11-22T13:01:00Z',
        }),
      ].join('\n')}\n`,
    )

    // Verifier transcript carries usage.cache_read_tokens + usage.thoughts_tokens
    await writeFile(
      path.join(verifierLogs, 'transcript.jsonl'),
      `${[
        JSON.stringify({ step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE' }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 33_000, thoughts_tokens: 850 },
          tool_calls: [],
        }),
      ].join('\n')}\n`,
    )

    // 150 posts (> SWARM_MAX_POSTS=120): verifier posted only at #5 in #audit, remaining 149 in main
    const boardLines: string[] = []
    for (let seq = 1; seq <= 150; seq += 1) {
      if (seq === 5) {
        boardLines.push(JSON.stringify({ seq, agent: 'verifier', channel: 'audit', text: '早期审计结果' }))
      } else {
        boardLines.push(JSON.stringify({ seq, agent: seq % 2 === 0 ? 'parser' : 'coordinator', channel: 'main', text: `msg #${seq}` }))
      }
    }
    await writeFile(path.join(swarmDir, 'board.jsonl'), `${boardLines.join('\n')}\n`)

    const cache = new IncrementalTranscriptTelemetryCache()
    const snap = readAntigravitySwarmSnapshot({
      brainDir,
      conversationId: COORD_CONV,
      phase: 'running',
      revision: 1,
      telemetryCache: cache,
      drainTelemetry: true,
    })
    assert.ok(snap)
    assert.equal(snap.totalPosts, 150)
    assert.equal(snap.posts.length, 120)
    assert.equal(snap.truncatedPosts, 30)

    const coord = snap.members.find((m) => m.name === 'coordinator')!
    assert.equal(coord.status, 'waiting', 'native CLI phase=RUNNING + wake_mode=mentions must be waiting')
    assert.equal(coord.activity, '等待讨论板消息', '[swarm_wait, post_message] + GENERIC DONE must parse as waiting for board')
    assert.equal(coord.workspace, 'inherit')
    assert.equal(coord.cacheReadTokens, 95_000)
    assert.equal(coord.thinkingTokens, 1_200)

    const parser = snap.members.find((m) => m.name === 'parser')!
    assert.equal(parser.status, 'working', 'native CLI wake_mode=working must stay working')
    assert.equal(parser.activity, '启动处理中…', 'SYSTEM_MESSAGE turn boundary must show startup activity and clear prior ERROR')
    assert.equal(Boolean(parser.failed), false)
    assert.equal(parser.workspace, 'share')

    const verifier = snap.members.find((m) => m.name === 'verifier')!
    assert.equal(verifier.status, 'waiting', 'native CLI phase=RUNNING + wake_mode=all must be waiting')
    assert.equal(verifier.lastPostSeq, 5, 'full-board aggregation must retain lastPostSeq from before the 120-post tail')
    assert.equal(verifier.cacheReadTokens, 33_000)
    assert.equal(verifier.thinkingTokens, 850)

    const auditCh = snap.channels.find((c) => c.name === 'audit')
    assert.equal(auditCh?.postCount, 1, 'full-board channel postCount must include posts outside the 120-post tail')
    const mainCh = snap.channels.find((c) => c.name === 'main')
    assert.equal(mainCh?.postCount, 149)

    // 2. RemoteSwarm roster with explicit runtime='remote' + object workspace { mode, branch, path }
    const remoteSwarmDir = path.join(brainDir, OTHER_CONV, '.system_generated', 'swarm')
    await mkdir(remoteSwarmDir, { recursive: true })
    await writeFile(
      path.join(remoteSwarmDir, 'members.json'),
      JSON.stringify({
        title: 'Remote 蜂群',
        runtime: 'remote',
        members: {
          coordinator: {
            conversation_id: OTHER_CONV,
            role: 'coordinator',
            phase: 'RUNNING',
            wake_mode: 'mentions',
            killed: false,
            workspace: { mode: 'inherit' },
          },
          'wt-worker': {
            conversation_id: WORKER_CONV,
            role: 'worker',
            phase: 'RUNNING',
            wake_mode: 'mentions',
            killed: false,
            workspace: {
              mode: 'share',
              branch: 'oc-swarm/wt-worker',
              path: '/home/agent/.openclaude/workspace/repo/.oc-swarm-worktrees/abc123/wt-worker',
            },
          },
          'abs-worker': {
            conversation_id: VERIFIER_CONV,
            role: 'worker',
            phase: 'WAITING',
            wake_mode: 'mentions',
            killed: false,
            workspace: {
              mode: 'branch',
              branch: 'feat/isolated',
              path: '/Users/alice/private/secret-repo/worktree-1',
            },
          },
        },
      }),
    )
    const remoteSnap = readAntigravitySwarmSnapshot({
      brainDir,
      conversationId: OTHER_CONV,
      phase: 'running',
      revision: 1,
    })
    assert.ok(remoteSnap)
    const wt = remoteSnap.members.find((m) => m.name === 'wt-worker')!
    assert.equal(wt.status, 'working', 'RemoteSwarm phase=RUNNING must remain working even with wake_mode=mentions')
    assert.equal(wt.workspace, 'share')
    assert.equal(wt.workspaceBranch, 'oc-swarm/wt-worker')
    assert.equal(wt.workspacePath, '.oc-swarm-worktrees/abc123/wt-worker')
    assert.ok(!wt.workspacePath?.includes('/home/agent'))

    const abs = remoteSnap.members.find((m) => m.name === 'abs-worker')!
    assert.equal(abs.status, 'waiting')
    assert.equal(abs.workspace, 'branch')
    assert.equal(abs.workspaceBranch, 'feat/isolated')
    assert.equal(abs.workspacePath, '…/secret-repo/worktree-1')
    assert.ok(!abs.workspacePath?.includes('/Users/alice'))
  } finally {
    await rm(brainDir, { recursive: true, force: true })
  }
})

test('W3 hot-path: caches resolved realRoot across reads and runs interval polls asynchronously with stop fencing', async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-w3-async-'))
  try {
    const { swarmDir } = await writeSwarmFixture(brainDir)
    resetSwarmRealRootCache()

    // Multiple reads under the same brainDir resolve realRoot only ONCE
    for (let i = 0; i < 3; i += 1) {
      const snap = readAntigravitySwarmSnapshot({
        brainDir,
        conversationId: COORD_CONV,
        phase: 'running',
        revision: i + 1,
      })
      assert.ok(snap)
      assert.equal(snap.totalPosts, 2)
    }
    assert.equal(getSwarmRealRootResolveCount(), 1, 'realRoot must be cached for unchanged brainDir inode')

    // High-frequency interval polling runs asynchronously and emits new board posts without manual kick()
    const emitted: SwarmSnapshot[] = []
    const watcher = new AntigravitySwarmWatcher({
      brainDir,
      conversationId: COORD_CONV,
      pollMs: 25,
      activityThrottleMs: 0,
      onSnapshot: (snap) => emitted.push(snap),
    })
    watcher.start()
    assert.equal(emitted.length, 1)

    await writeFile(
      path.join(swarmDir, 'board.jsonl'),
      `${readFileSync(path.join(swarmDir, 'board.jsonl'), 'utf8')}${JSON.stringify({
        seq: 3,
        agent: 'parser',
        channel: 'parser',
        text: '异步轮询捕获第 3 条消息',
      })}\n`,
    )

    const deadline = Date.now() + 1_000
    while (emitted.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15))
    }
    assert.equal(emitted.length, 2, 'async interval poll must detect and emit new post')
    assert.equal(emitted[1]!.totalPosts, 3)

    // After stop(), subsequent disk writes must never trigger late async emissions
    watcher.stop()
    await writeFile(
      path.join(swarmDir, 'board.jsonl'),
      `${readFileSync(path.join(swarmDir, 'board.jsonl'), 'utf8')}${JSON.stringify({
        seq: 4,
        agent: 'parser',
        channel: 'parser',
        text: 'stop 后不应再发射',
      })}\n`,
    )
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(emitted.length, 2, 'stopped watcher must not emit after stop()')
  } finally {
    await rm(brainDir, { recursive: true, force: true })
  }
})

test('W3 auditor R1 regressions: telemetry sync/async fence (no double count), dormant terminal capture, and strictly monotonic revisions', async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-w3-r1-'))
  try {
    const { swarmDir } = await writeSwarmFixture(brainDir)
    const transcriptPath = path.join(brainDir, WORKER_CONV, '.system_generated', 'logs', 'transcript.jsonl')

    // 1. P1 #4: Concurrent scanAsync() + sync scan() must never double-count the same 7-token line
    await writeFile(
      transcriptPath,
      `${JSON.stringify({ type: 'ASSISTANT', created_at: '2026-11-23T10:00:00Z', usage: { input_tokens: 7 } })}\n`,
    )
    const cache = new IncrementalTranscriptTelemetryCache()
    const asyncPromise = cache.scanAsync(brainDir, WORKER_CONV)
    const syncSnap = cache.scan(brainDir, WORKER_CONV)
    const asyncSnap = await asyncPromise
    assert.equal(syncSnap?.inputTokens, 7)
    assert.equal(asyncSnap?.inputTokens, 7)
    // Append 3 more tokens and drain -> total must be exact 10, never 14
    await writeFile(
      transcriptPath,
      `${readFileSync(transcriptPath, 'utf8')}${JSON.stringify({ type: 'ASSISTANT', created_at: '2026-11-23T10:00:01Z', usage: { input_tokens: 3 } })}\n`,
    )
    const finalTel = cache.scan(brainDir, WORKER_CONV, { drainAll: true })
    assert.equal(finalTel?.inputTokens, 10, 'sync+async concurrent scan must yield exact 10 tokens')

    // 2. P1 #5: Dormant resumed session whose board mutates before async poll finishes must still persist in stopAndReadFinal
    const dormantWatcher = new AntigravitySwarmWatcher({
      brainDir,
      conversationId: COORD_CONV,
      pollMs: 60_000, // won't fire before stopAndReadFinal
      seedBaselineOnStart: true,
      onSnapshot: () => {},
    })
    dormantWatcher.start()
    assert.equal(dormantWatcher.hasTurnActivity(), false)
    await writeFile(
      path.join(swarmDir, 'board.jsonl'),
      `${readFileSync(path.join(swarmDir, 'board.jsonl'), 'utf8')}${JSON.stringify({
        seq: 3,
        agent: 'parser',
        channel: 'parser',
        text: '恢复会话中的成员新帖子',
      })}\n`,
    )
    const terminal = dormantWatcher.stopAndReadFinal('completed')
    assert.ok(terminal, 'stopAndReadFinal must synchronously detect board mutation even if async poll had not run')
    assert.equal(terminal.phase, 'completed')
    assert.equal(terminal.totalPosts, 3)

    // 3. P1 #6: Throttled activity timer + async poll never reuse the same revision
    const revs: number[] = []
    let fakeNow = 10_000
    const revWatcher = new AntigravitySwarmWatcher({
      brainDir,
      conversationId: COORD_CONV,
      pollMs: 20,
      activityThrottleMs: 30,
      now: () => fakeNow,
      onSnapshot: (s) => revs.push(s.revision),
    })
    revWatcher.start()
    // Activity-only change scheduled on throttleTimer
    fakeNow += 5
    await writeFile(
      transcriptPath,
      `${readFileSync(transcriptPath, 'utf8')}${JSON.stringify({ type: 'ASSISTANT', created_at: '2026-11-23T10:00:02Z', usage: { input_tokens: 1 } })}\n`,
    )
    revWatcher.kick()
    // Structural change right as throttleTimer fires
    fakeNow += 40
    await writeFile(
      path.join(swarmDir, 'board.jsonl'),
      `${readFileSync(path.join(swarmDir, 'board.jsonl'), 'utf8')}${JSON.stringify({
        seq: 4,
        agent: 'parser',
        channel: 'parser',
        text: '版本严格递增',
      })}\n`,
    )
    await new Promise((r) => setTimeout(r, 90))
    revWatcher.stop()
    assert.ok(revs.length >= 2)
    for (let i = 1; i < revs.length; i += 1) {
      assert.ok(revs[i]! > revs[i - 1]!, `revisions must be strictly monotonic: ${JSON.stringify(revs)}`)
    }
  } finally {
    await rm(brainDir, { recursive: true, force: true })
  }
})
