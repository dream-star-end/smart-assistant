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
  readBoundedFileWithinRoot,
  readBoundedFileWithinRootAsync,
} from '../engine/antigravitySwarmTelemetry.js'
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

test('OCV5-887: >64KB transcript step, mid-turn GENERIC status, native string workspace, >2MB board totalPosts, and turnWorkerUsageDelta', async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-887-watcher-'))
  try {
    const { swarmDir } = await writeSwarmFixture(brainDir)
    // Native CLI writes `workspace` as a path string + `workspace_mode`
    await writeFile(
      path.join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'OCV5-887 验证',
        members: {
          coordinator: { conversation_id: COORD_CONV, role: 'coordinator', killed: false },
          parser: {
            conversation_id: WORKER_CONV,
            role: 'worker',
            killed: false,
            workspace: '/repo/.worktrees/parser',
            workspace_mode: 'branch',
          },
        },
      }),
    )

    // 1. Mid-turn truncated GENERIC step (without planner DONE in tail) stays working instead of false waiting
    const midTurnTail = parseMemberTranscriptTail(
      `${JSON.stringify({ step_index: 7, type: 'GENERIC', status: 'DONE', created_at: '2026-11-24T01:00:00Z' })}\n`,
    )
    assert.equal(midTurnTail.status, 'working')
    assert.equal(midTurnTail.stepCount, 8)

    // 2. >64KB (~120KB) single-line JSONL step in transcript.jsonl is read intact via adaptive 2MB tail
    const workerTranscript = path.join(brainDir, WORKER_CONV, '.system_generated', 'logs', 'transcript.jsonl')
    const hugeOutput = 'X'.repeat(120 * 1024)
    await writeFile(
      workerTranscript,
      `${[
        JSON.stringify({
          step_index: 0,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-24T01:00:00.000Z',
          usage: { input_tokens: 500, output_tokens: 100 },
        }),
        JSON.stringify({
          step_index: 12,
          type: 'ERROR_MESSAGE',
          status: 'ERROR',
          content: `fatal crash after big tool output: ${hugeOutput}`,
          created_at: '2026-11-24T02:00:10.000Z',
          usage: { input_tokens: 3000, output_tokens: 700, cache_read_input_tokens: 200 },
        }),
      ].join('\n')}\n`,
    )

    // 3. >2MB board.jsonl preserves monotonic totalPosts from headSeq
    const filler = '讨论板正文填充'.repeat(300)
    const boardLines: string[] = []
    let bytes = 0
    let seq = 1
    while (bytes < 2.2 * 1024 * 1024) {
      const line = `${JSON.stringify({ seq, agent: 'parser', channel: 'main', text: filler })}\n`
      boardLines.push(line)
      bytes += Buffer.byteLength(line, 'utf8')
      seq += 1
    }
    const expectedTotalPosts = seq - 1
    await writeFile(path.join(swarmDir, 'board.jsonl'), boardLines.join(''))

    const watcher = new AntigravitySwarmWatcher({
      brainDir,
      conversationId: COORD_CONV,
      pollMs: 60_000,
      seedBaselineOnStart: true,
      now: () => Date.parse('2026-11-24T02:00:01.000Z'),
      onSnapshot: () => {},
    })
    watcher.start()
    watcher.activateTurnSwarm()
    const finalSnap = watcher.stopAndReadFinal('completed')
    assert.ok(finalSnap)
    assert.equal(finalSnap.totalPosts, expectedTotalPosts)
    const parserMember = finalSnap.members.find((m) => m.name === 'parser')
    assert.ok(parserMember)
    assert.equal(parserMember.stepCount, 13, '120KB line must not reset stepCount to 0')
    assert.equal(parserMember.failed, true)
    assert.equal(parserMember.workspace, 'branch')
    assert.ok(parserMember.workspacePath?.endsWith('parser'))

    // Only step_index 12 fell inside turn window (>= 02:00:00Z), excluding prior-turn step_index 0 (01:00:00Z)!
    const delta = watcher.turnWorkerUsageDelta()
    assert.deepEqual(delta, { inputTokens: 3000, outputTokens: 700, cacheReadTokens: 200, thinkingTokens: 0 })
  } finally {
    await rm(brainDir, { recursive: true, force: true })
  }
})

test('OCV5-887 P2-05: bounded tail reads landing exactly on a line boundary preserve the first complete line (sync & async)', async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-p2-05-tail-'))
  try {
    const logDir = path.join(brainDir, WORKER_CONV, '.system_generated', 'logs')
    await mkdir(logDir, { recursive: true })
    const rel = [WORKER_CONV, '.system_generated', 'logs', 'transcript.jsonl'] as const

    // 1. Primary tail window: startOffset > 0 lands right after '\n' (exact start of line2)
    const line1 = `${JSON.stringify({ step_index: 1, tag: 'head', pad: 'A'.repeat(40) })}\n`
    const line2 = `${JSON.stringify({ step_index: 2, tag: 'boundary-first-line' })}\n`
    const line3 = `${JSON.stringify({ step_index: 3, tag: 'tail-last-line' })}\n`
    await writeFile(path.join(logDir, 'transcript.jsonl'), line1 + line2 + line3, 'utf8')

    const exactTailBytes = Buffer.byteLength(line2 + line3, 'utf8')
    const syncExact = readBoundedFileWithinRoot(brainDir, rel, exactTailBytes)
    const asyncExact = await readBoundedFileWithinRootAsync(brainDir, rel, exactTailBytes)
    assert.equal(syncExact, line2 + line3, 'sync tail landing on line start must preserve first complete line')
    assert.equal(asyncExact, line2 + line3, 'async tail landing on line start must preserve first complete line')

    // 2. Single complete tail line equal to exact maxBytes (previously returned '' by slicing past its trailing '\n')
    const exactSingleLineBytes = Buffer.byteLength(line3, 'utf8')
    const syncSingle = readBoundedFileWithinRoot(brainDir, rel, exactSingleLineBytes)
    const asyncSingle = await readBoundedFileWithinRootAsync(brainDir, rel, exactSingleLineBytes)
    assert.equal(syncSingle, line3, 'sync single-line exact tail must not drop the only line')
    assert.equal(asyncSingle, line3, 'async single-line exact tail must not drop the only line')

    // 3. Mid-line startOffset still drops the partial leading fragment cleanly
    const midLineBytes = exactTailBytes - 5
    const syncMid = readBoundedFileWithinRoot(brainDir, rel, midLineBytes)
    const asyncMid = await readBoundedFileWithinRootAsync(brainDir, rel, midLineBytes)
    assert.equal(syncMid, line3, 'sync mid-line slice must still drop partial leading line')
    assert.equal(asyncMid, line3, 'async mid-line slice must still drop partial leading line')

    // 4. Adaptive widerStart landing exactly on a line boundary preserves that single large line
    const hugeLine = `${JSON.stringify({ step_index: 9, tag: 'huge-exact', body: 'B'.repeat(200) })}\n`
    const prefixLine = `${JSON.stringify({ step_index: 8, tag: 'prefix' })}\n`
    await writeFile(path.join(logDir, 'transcript.jsonl'), prefixLine + hugeLine, 'utf8')
    const hugeBytes = Buffer.byteLength(hugeLine, 'utf8')
    const syncWider = readBoundedFileWithinRoot(brainDir, rel, 64, { maxAdaptiveBytes: hugeBytes })
    const asyncWider = await readBoundedFileWithinRootAsync(brainDir, rel, 64, { maxAdaptiveBytes: hugeBytes })
    assert.equal(syncWider, hugeLine, 'sync widerStart landing on line boundary must preserve line')
    assert.equal(asyncWider, hugeLine, 'async widerStart landing on line boundary must preserve line')
  } finally {
    await rm(brainDir, { recursive: true, force: true })
  }
})

test('OCV5-932 Defect #1A: native resolveActiveMemberStatus trusts transcript over stale wake_mode and falls back to wake_mode only when transcript is absent', async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-932-1a-'))
  try {
    const swarmDir = path.join(brainDir, COORD_CONV, '.system_generated', 'swarm')
    const activeMentionsLogs = path.join(brainDir, WORKER_CONV, '.system_generated', 'logs')
    const parkedWorkingLogs = path.join(brainDir, VERIFIER_CONV, '.system_generated', 'logs')
    await mkdir(swarmDir, { recursive: true })
    await mkdir(activeMentionsLogs, { recursive: true })
    await mkdir(parkedWorkingLogs, { recursive: true })

    await writeFile(
      path.join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'OCV5-932 状态真值',
        members: {
          coordinator: {
            conversation_id: COORD_CONV,
            role: 'coordinator',
            desired_state: 'RUNNING',
            phase: 'RUNNING',
            wake_mode: 'mentions',
            last_read_seq: 1,
            killed: false,
          },
          'bg-woken': {
            conversation_id: WORKER_CONV,
            role: 'worker',
            desired_state: 'RUNNING',
            phase: 'RUNNING',
            wake_mode: 'mentions',
            last_read_seq: 1,
            killed: false,
          },
          'rung-parked': {
            conversation_id: VERIFIER_CONV,
            role: 'verifier',
            desired_state: 'RUNNING',
            phase: 'RUNNING',
            wake_mode: 'working',
            last_read_seq: 1,
            killed: false,
          },
          'no-tx-anything': {
            conversation_id: OTHER_CONV,
            role: 'worker',
            desired_state: 'RUNNING',
            phase: 'RUNNING',
            wake_mode: 'anything',
            last_read_seq: 1,
            killed: false,
          },
        },
      }),
    )

    // bg-woken has wake_mode='mentions', yet its transcript is actively thinking (PLANNER_RESPONSE RUNNING)
    await writeFile(
      path.join(activeMentionsLogs, 'transcript.jsonl'),
      `${[
        JSON.stringify({ step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[swarm] #1' }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'RUNNING' }),
      ].join('\n')}\n`,
    )
    // rung-parked has wake_mode='working', yet its transcript ended cleanly (PLANNER_RESPONSE DONE tool_calls: [])
    await writeFile(
      path.join(parkedWorkingLogs, 'transcript.jsonl'),
      `${[
        JSON.stringify({ step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[swarm] #1' }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }),
      ].join('\n')}\n`,
    )

    const snap = readAntigravitySwarmSnapshot({
      brainDir,
      conversationId: COORD_CONV,
      phase: 'running',
      revision: 1,
      now: 10_000,
    })
    assert.ok(snap)

    const bgWoken = snap.members.find((m) => m.name === 'bg-woken')!
    assert.equal(bgWoken.status, 'working', 'active transcript must override stale wake_mode=mentions')
    assert.equal(bgWoken.activity, '思考与规划中…')
    assert.notEqual(bgWoken.waitingOnBoard, true)

    const rungParked = snap.members.find((m) => m.name === 'rung-parked')!
    assert.equal(rungParked.status, 'waiting', 'completed transcript must override stale wake_mode=working')
    assert.equal(rungParked.activity, '已完成本轮思考')
    assert.equal(rungParked.waitingOnBoard, true)

    // No transcript on disk -> falls back cleanly to wake_mode ('mentions' / 'anything' -> waiting)
    const coord = snap.members.find((m) => m.name === 'coordinator')!
    assert.equal(coord.status, 'waiting', 'missing transcript falls back to wake_mode=mentions -> waiting')
    const noTxAnything = snap.members.find((m) => m.name === 'no-tx-anything')!
    assert.equal(noTxAnything.status, 'waiting', 'missing transcript falls back to wake_mode=anything -> waiting')
  } finally {
    await rm(brainDir, { recursive: true, force: true })
  }
})

test('OCV5-932 Defect #1B: mid-turn SYSTEM_MESSAGE and cross-turn background task lifecycle (T2 four-quadrant matrix)', () => {
  const taskId1 = `${WORKER_CONV}/task-713`
  const taskId2 = `${WORKER_CONV}/task-714`

  // 1. Mid-turn efficiency Reminder SYSTEM_MESSAGE does NOT truncate turnStart or hide unfinished non-board tool
  const midTurnReminder = `${[
    JSON.stringify({
      step_index: 10,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
    }),
    JSON.stringify({
      step_index: 11,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: '<SYSTEM_MESSAGE>\nReminder: work efficiently.\n</SYSTEM_MESSAGE>',
    }),
  ].join('\n')}\n`
  const parsedReminder = parseMemberTranscriptTail(midTurnReminder)
  assert.equal(parsedReminder.status, 'working')
  assert.equal(parsedReminder.hasActiveNonWaitTool, true)
  assert.equal(parsedReminder.waitingOnBoard, false)
  assert.equal(parsedReminder.activity, '运行命令')

  // 2. Real b1-integrator background task lifecycle across Reminder, post_message, turn-end reply, still-running, manage_task RUNNING, and finish
  const bgStartSteps = [
    JSON.stringify({
      step_index: 20,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm run test:all' } }],
    }),
    JSON.stringify({
      step_index: 21,
      type: 'GENERIC',
      status: 'RUNNING',
      content: `Created At: 2026-11-28T16:00:00+08:00\nTool is running as a background task with task id: ${taskId1}\nTask Description: full suite`,
    }),
    JSON.stringify({
      step_index: 22,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: '<SYSTEM_MESSAGE>\nReminder: work efficiently.\n</SYSTEM_MESSAGE>',
    }),
    JSON.stringify({
      step_index: 23,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'post_message', args: { text: '[progress] 正在运行全量单测' } }],
    }),
    JSON.stringify({ step_index: 24, type: 'GENERIC', status: 'DONE', content: '{"seq":50}' }),
    JSON.stringify({ step_index: 25, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }),
  ]
  const parsedAcrossTurnEnd = parseMemberTranscriptTail(`${bgStartSteps.join('\n')}\n`)
  assert.equal(parsedAcrossTurnEnd.status, 'working')
  assert.equal(parsedAcrossTurnEnd.waitingOnBoard, false)
  assert.equal(parsedAcrossTurnEnd.hasActiveNonWaitTool, true)
  assert.equal(parsedAcrossTurnEnd.activity, '后台运行命令')

  // Still-running notification + manage_task Status: RUNNING + another turn-end reply -> MUST STAY WORKING!
  const bgStillRunningSteps = [
    ...bgStartSteps,
    JSON.stringify({
      step_index: 26,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-28T08:07:00Z sender=${taskId1} priority=MESSAGE_PRIORITY_HIGH content=Background command is still running after 420s:\n0 failed, 12 passed so far\n</SYSTEM_MESSAGE>`,
    }),
    JSON.stringify({
      step_index: 27,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'manage_task', args: { Action: 'status', TaskId: taskId1 } }],
    }),
    JSON.stringify({
      step_index: 28,
      type: 'GENERIC',
      status: 'DONE',
      content: `Created At: 2026-11-28T16:07:02+08:00\nCompleted At: 2026-11-28T16:07:02+08:00\nTask: ${taskId1}\nStatus: RUNNING\nElapsed: 422s`,
    }),
    JSON.stringify({ step_index: 29, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }),
  ]
  const parsedStillRunning = parseMemberTranscriptTail(`${bgStillRunningSteps.join('\n')}\n`)
  assert.equal(parsedStillRunning.status, 'working')
  assert.equal(parsedStillRunning.waitingOnBoard, false)
  assert.equal(parsedStillRunning.hasActiveNonWaitTool, true)
  assert.equal(parsedStillRunning.activity, '后台运行命令')

  // Completion notification arrives -> retires task-713, wakes member as working ('启动处理中…') until next planner settles
  const bgFinishedWake = [
    ...bgStillRunningSteps,
    JSON.stringify({
      step_index: 30,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-28T08:10:00Z sender=${taskId1} priority=MESSAGE_PRIORITY_HIGH content=Task id "${taskId1}" finished with result:\nCommand exited with code 0.\nBackground command is still running test passed\n</SYSTEM_MESSAGE>`,
    }),
  ]
  const parsedFinishedWake = parseMemberTranscriptTail(`${bgFinishedWake.join('\n')}\n`)
  assert.equal(parsedFinishedWake.status, 'working')
  assert.equal(parsedFinishedWake.activity, '启动处理中…')
  assert.notEqual(parsedFinishedWake.hasActiveNonWaitTool, true)

  // Member finishes post-completion turn -> cleanly transitions to waiting!
  const bgFinishedSettled = [
    ...bgFinishedWake,
    JSON.stringify({ step_index: 31, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }),
  ]
  const parsedSettled = parseMemberTranscriptTail(`${bgFinishedSettled.join('\n')}\n`)
  assert.equal(parsedSettled.status, 'waiting')
  assert.equal(parsedSettled.waitingOnBoard, true)
  assert.notEqual(parsedSettled.hasActiveNonWaitTool, true)

  // 3. T2 Quadrant 2: Two concurrent background tasks -> stays working until BOTH finish
  const twoTasksOneDone = [
    JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'run_command' }, { name: 'run_command' }],
    }),
    JSON.stringify({
      step_index: 1,
      type: 'GENERIC',
      status: 'RUNNING',
      content: `Tool is running as a background task with task id: ${taskId1}`,
    }),
    JSON.stringify({
      step_index: 2,
      type: 'GENERIC',
      status: 'RUNNING',
      content: `Tool is running as a background task with task id: ${taskId2}`,
    }),
    JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }),
    JSON.stringify({
      step_index: 4,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: `Task id "${taskId1}" finished with result: ok`,
    }),
    JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }),
  ]
  const parsedOneRemaining = parseMemberTranscriptTail(`${twoTasksOneDone.join('\n')}\n`)
  assert.equal(parsedOneRemaining.status, 'working', 'must stay working while task-714 is still running')
  assert.equal(parsedOneRemaining.hasActiveNonWaitTool, true)

  const bothTasksDone = [
    ...twoTasksOneDone,
    JSON.stringify({
      step_index: 6,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: `Task id "${taskId2}" finished with result: ok`,
    }),
    JSON.stringify({ step_index: 7, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }),
  ]
  const parsedBothDone = parseMemberTranscriptTail(`${bothTasksDone.join('\n')}\n`)
  assert.equal(parsedBothDone.status, 'waiting', 'once all concurrent background tasks finish, member parks')
  assert.equal(parsedBothDone.waitingOnBoard, true)

  // 4. T2 Quadrant 3: Bounded tail with orphan finish + out-of-order/duplicate RUNNING/still-running are idempotent
  const outOfOrderAndOrphan = [
    JSON.stringify({
      step_index: 100,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: `Task id "${taskId1}" finished with result: ok`,
    }),
    JSON.stringify({
      step_index: 101,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: `sender=${taskId1} content=Background command is still running after 60s:`,
    }),
    JSON.stringify({
      step_index: 102,
      type: 'GENERIC',
      status: 'RUNNING',
      content: `Tool is running as a background task with task id: ${taskId1}`,
    }),
    JSON.stringify({ step_index: 103, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }),
  ]
  const parsedOutOfOrder = parseMemberTranscriptTail(`${outOfOrderAndOrphan.join('\n')}\n`)
  assert.equal(parsedOutOfOrder.status, 'waiting', 'retired taskId must never resurrect on out-of-order RUNNING/still-running')
  assert.equal(parsedOutOfOrder.waitingOnBoard, true)

  // 5. T2 Quadrant 4: Server restart notice and manage_task kill / terminal Status cleanly release tasks
  const serverRestartCleared = [
    ...bgStartSteps,
    JSON.stringify({
      step_index: 26,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: '<SYSTEM_MESSAGE>\nAll your subagents and background tasks have been stopped due to server restart.\n</SYSTEM_MESSAGE>',
    }),
    JSON.stringify({ step_index: 27, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }),
  ]
  const parsedRestart = parseMemberTranscriptTail(`${serverRestartCleared.join('\n')}\n`)
  assert.equal(parsedRestart.status, 'waiting', 'server restart notice must clear all tracked background tasks')
  assert.equal(parsedRestart.waitingOnBoard, true)

  const manageTaskKilled = [
    ...bgStartSteps,
    JSON.stringify({
      step_index: 26,
      type: 'GENERIC',
      status: 'DONE',
      content: `Created At: 2026-11-28T16:12:00+08:00\nTask: ${taskId1}\nStatus: KILLED`,
    }),
    JSON.stringify({ step_index: 27, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }),
  ]
  const parsedKilled = parseMemberTranscriptTail(`${manageTaskKilled.join('\n')}\n`)
  assert.equal(parsedKilled.status, 'waiting', 'manage_task Status: KILLED must release tracked background task')
  assert.equal(parsedKilled.waitingOnBoard, true)

  // Explicit manage_task kill confirmation & sender=<taskId> terminal notice also release tracked task
  const killConfirmSteps = [
    ...bgStartSteps,
    JSON.stringify({
      step_index: 26,
      type: 'GENERIC',
      status: 'DONE',
      content: `Created At: 2026-11-28T16:12:00+08:00\nKilled task "${taskId1}".`,
    }),
    JSON.stringify({ step_index: 27, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }),
  ]
  assert.equal(parseMemberTranscriptTail(`${killConfirmSteps.join('\n')}\n`).status, 'waiting')

  const senderExitedSteps = [
    ...bgStartSteps,
    JSON.stringify({
      step_index: 26,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: `[Message] timestamp=2026-11-28T08:13:00Z sender=${taskId1} priority=MESSAGE_PRIORITY_HIGH content=Background command exited with code 1`,
    }),
    JSON.stringify({ step_index: 27, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }),
  ]
  assert.equal(parseMemberTranscriptTail(`${senderExitedSteps.join('\n')}\n`).status, 'waiting')

  // DoS safety: >64 background tasks stay bounded without throwing
  const floodSteps = Array.from({ length: 80 }, (_, idx) =>
    JSON.stringify({
      step_index: idx,
      type: 'GENERIC',
      status: 'RUNNING',
      content: `Tool is running as a background task with task id: ${WORKER_CONV}/task-${idx + 1}`,
    }),
  )
  floodSteps.push(JSON.stringify({ step_index: 81, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }))
  const parsedFlood = parseMemberTranscriptTail(`${floodSteps.join('\n')}\n`)
  assert.equal(parsedFlood.status, 'working')
  assert.equal(parsedFlood.activity, '后台运行命令')

  // Mixed [read_file, swarm_wait] batch that completed DONE followed by a waking SYSTEM_MESSAGE must mark working
  const mixedBatchThenWoken = [
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'read_file', arguments: { Path: '/tmp/a.ts' } }, { name: 'swarm_wait', arguments: { since: 4 } }],
    }),
    JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'file contents' }),
    JSON.stringify({ step_index: 3, type: 'GENERIC', status: 'DONE', content: 'parked' }),
    JSON.stringify({
      step_index: 4,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: '[Message] sender=system content=[swarm] new board message #8',
    }),
  ]
  const parsedWoken = parseMemberTranscriptTail(`${mixedBatchThenWoken.join('\n')}\n`)
  assert.equal(parsedWoken.status, 'working', 'SYSTEM_MESSAGE waking a member after mixed [read_file, swarm_wait] DONE batch must be working')
})

test('OCV5-932 R1 P1-1..P1-3: >256KiB tail scrollout, >64 live task overflow, duplicate DONE wait batch, and 17-segment SYSTEM_MESSAGE', async () => {
  const brainDir = await mkdtemp(path.join(tmpdir(), 'oc-swarm-932-r1-'))
  try {
    await writeSwarmFixture(brainDir)
    const swarmDir = path.join(brainDir, COORD_CONV, '.system_generated', 'swarm')
    await writeFile(
      path.join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'OCV5-932 R1 P1-1',
        members: {
          coordinator: { conversation_id: COORD_CONV, role: 'coordinator', phase: 'RUNNING', wake_mode: 'mentions', last_read_seq: 1, killed: false },
          parser: { conversation_id: WORKER_CONV, role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', last_read_seq: 1, killed: false },
        },
      }),
    )
    const workerTranscript = path.join(brainDir, WORKER_CONV, '.system_generated', 'logs', 'transcript.jsonl')
    const task71 = `${WORKER_CONV}/task-71`
    const fillerPayload = 'x'.repeat(4096)
    const largeLines: string[] = [
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'run long job' }),
      JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', arguments: { CommandLine: 'long' } }] }),
      JSON.stringify({ step_index: 3, type: 'GENERIC', status: 'RUNNING', content: `Created At: 2026-11-28T16:00:00+08:00\nTool is running as a background task with task id: ${task71}\nTask Description: long` }),
    ]
    let stepIdx = 4
    for (let i = 0; i < 70; i += 1) {
      largeLines.push(JSON.stringify({ step_index: stepIdx++, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', arguments: { Path: `/tmp/f${i}.ts` } }] }))
      largeLines.push(JSON.stringify({ step_index: stepIdx++, type: 'GENERIC', status: 'DONE', content: fillerPayload }))
    }
    largeLines.push(JSON.stringify({ step_index: stepIdx++, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [], content: 'waiting on task-71' }))
    const largeText = `${largeLines.join('\n')}\n`
    assert.ok(Buffer.byteLength(largeText, 'utf8') > 280 * 1024, 'fixture must exceed 256 KiB tail window')
    await writeFile(workerTranscript, largeText)

    // P1-1a: With real IncrementalTranscriptTelemetryCache, task-71 stays tracked past 256 KiB tail scrollout
    const cache = new IncrementalTranscriptTelemetryCache()
    let snap = readAntigravitySwarmSnapshot({ brainDir, conversationId: COORD_CONV, phase: 'running', revision: 1, telemetryCache: cache })!
    // Drain full file across ticks (simulating real watcher catchup)
    for (let rev = 2; rev <= 5 && cache.hasAnyBacklog(); rev += 1) {
      snap = readAntigravitySwarmSnapshot({ brainDir, conversationId: COORD_CONV, phase: 'running', revision: rev, telemetryCache: cache })!
    }
    const workerActive = snap.members.find((m) => m.name === 'parser')!
    assert.equal(workerActive.status, 'working', 'P1-1: unfinished task-71 outside 256 KiB tail must remain working with telemetryCache')
    assert.equal(workerActive.waitingOnBoard, false)

    // P1-1b: Stateless truncated read without telemetryCache marks telemetryPartial=true so SwarmStallMonitor refuses auto-kill
    const statelessSnap = readAntigravitySwarmSnapshot({ brainDir, conversationId: COORD_CONV, phase: 'running', revision: 6 })!
    const statelessWorker = statelessSnap.members.find((m) => m.name === 'parser')!
    assert.equal(statelessWorker.telemetryPartial, true, 'P1-1: truncated tail without telemetryCache must mark telemetryPartial=true')
    let statelessExhausted = 0
    const { SwarmStallMonitor } = await import('../engine/swarmStallMonitor.js')
    const guardMon = new SwarmStallMonitor({
      stallThresholdMs: 1_000,
      retryCooldownMs: 1_000,
      exhaustedGraceMs: 1_000,
      maxAlerts: 1,
      onStallExhausted: () => { statelessExhausted += 1 },
    })
    guardMon.evaluate(statelessSnap, 1_000)
    guardMon.evaluate({ ...statelessSnap, revision: 7 }, 3_000)
    guardMon.evaluate({ ...statelessSnap, revision: 8 }, 5_000)
    assert.equal(statelessExhausted, 0, 'P1-1: incomplete transcript evidence must block onStallExhausted')
    assert.equal(guardMon.isStallSuppressedAllParked(), false)

    // P1-1c: Positive control — once task-71 genuinely finishes, worker becomes waiting & deadlock reclaim resumes
    const finishedLine = JSON.stringify({
      step_index: stepIdx++,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: `[Message] timestamp=2026-11-28T08:15:00Z sender=${task71} priority=MESSAGE_PRIORITY_HIGH content=Task id "${task71}" finished with result: ok`,
    })
    const finalReplyLine = JSON.stringify({ step_index: stepIdx++, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [], content: 'done' })
    await writeFile(workerTranscript, `${largeText}${finishedLine}\n${finalReplyLine}\n`)
    const settledSnap = readAntigravitySwarmSnapshot({ brainDir, conversationId: COORD_CONV, phase: 'running', revision: 10, telemetryCache: cache, drainTelemetry: true })!
    const settledWorker = settledSnap.members.find((m) => m.name === 'parser')!
    assert.equal(settledWorker.status, 'waiting', 'P1-1 positive control: finished task-71 must restore waiting')
    assert.equal(settledWorker.telemetryPartial, undefined)
    let resumedExhausted = 0
    const resumeMon = new SwarmStallMonitor({
      stallThresholdMs: 1_000,
      retryCooldownMs: 1_000,
      exhaustedGraceMs: 1_000,
      maxAlerts: 1,
      onStallExhausted: () => { resumedExhausted += 1 },
    })
    resumeMon.evaluate(settledSnap, 1_000)
    resumeMon.evaluate({ ...settledSnap, revision: 11 }, 3_000)
    resumeMon.evaluate({ ...settledSnap, revision: 12 }, 5_000)
    assert.equal(resumedExhausted, 1, 'P1-1 positive control: genuine deadlock reclamation resumes after task completion')

    // P1-1d: Capacity boundary — 65 live tasks started, tasks 2..65 finished -> task-1 STILL alive (never evicted) -> working!
    const capSteps: string[] = []
    for (let i = 1; i <= 65; i += 1) {
      capSteps.push(JSON.stringify({
        step_index: i,
        type: 'GENERIC',
        status: 'RUNNING',
        content: `Tool is running as a background task with task id: ${WORKER_CONV}/task-${i}`,
      }))
    }
    for (let i = 2; i <= 65; i += 1) {
      capSteps.push(JSON.stringify({
        step_index: 100 + i,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: `[Message] sender=${WORKER_CONV}/task-${i} content=Task id "${WORKER_CONV}/task-${i}" finished with result: ok`,
      }))
    }
    capSteps.push(JSON.stringify({ step_index: 200, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }))
    const capParsed = parseMemberTranscriptTail(`${capSteps.join('\n')}\n`)
    assert.equal(capParsed.status, 'working', 'P1-1 capacity: finishing tasks 2..65 must NOT lose still-running task-1')
    assert.equal(capParsed.incompleteBgEvidence, true)
    // Server restart clears overflow + all active tasks cleanly
    capSteps.push(JSON.stringify({ step_index: 201, type: 'SYSTEM_MESSAGE', status: 'DONE', content: '<SYSTEM_MESSAGE>\nAll your subagents and background tasks have been stopped due to server restart.\n</SYSTEM_MESSAGE>' }))
    capSteps.push(JSON.stringify({ step_index: 202, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }))
    assert.equal(parseMemberTranscriptTail(`${capSteps.join('\n')}\n`).status, 'waiting')

    // R2 P1-B: 65 concurrent tasks with IncrementalTranscriptTelemetryCache —
    // finishing tasks 1..64 leaves overflowed task-65 alive (working, 0 reclaims);
    // finishing task-65 WITHOUT server restart proves 0 live tasks -> waiting & reclaimable!
    const cap65Lines: string[] = []
    for (let i = 1; i <= 65; i += 1) {
      cap65Lines.push(JSON.stringify({
        step_index: i,
        type: 'GENERIC',
        status: 'RUNNING',
        content: `Tool is running as a background task with task id: ${WORKER_CONV}/cap65-task-${i}`,
      }))
    }
    for (let i = 1; i <= 64; i += 1) {
      cap65Lines.push(JSON.stringify({
        step_index: 100 + i,
        type: 'SYSTEM_MESSAGE',
        status: 'DONE',
        content: `[Message] sender=${WORKER_CONV}/cap65-task-${i} content=Task id "${WORKER_CONV}/cap65-task-${i}" finished with result: ok`,
      }))
    }
    cap65Lines.push(JSON.stringify({ step_index: 200, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }))
    const capCache = new IncrementalTranscriptTelemetryCache()
    await writeFile(workerTranscript, `${cap65Lines.join('\n')}\n`)
    const cap64DoneSnap = readAntigravitySwarmSnapshot({
      brainDir, conversationId: COORD_CONV, phase: 'running', revision: 30, telemetryCache: capCache, drainTelemetry: true,
    })!
    const cap64Worker = cap64DoneSnap.members.find((m) => m.name === 'parser')!
    assert.equal(cap64Worker.status, 'working', 'P1-B: overflowed task-65 still running must stay working after 1..64 finish')
    let cap64Reclaimed = 0
    const cap64Mon = new SwarmStallMonitor({
      stallThresholdMs: 1_000, retryCooldownMs: 1_000, exhaustedGraceMs: 1_000, maxAlerts: 1,
      onStallExhausted: () => { cap64Reclaimed += 1 },
    })
    cap64Mon.evaluate(cap64DoneSnap, 1_000)
    cap64Mon.evaluate({ ...cap64DoneSnap, revision: 31 }, 3_000)
    cap64Mon.evaluate({ ...cap64DoneSnap, revision: 32 }, 5_000)
    assert.equal(cap64Reclaimed, 0, 'P1-B: must NOT reclaim while overflowed task-65 is still running')

    // Now finish task-65 (NO server restart) -> bounded reverse re-verification clears overflow!
    cap65Lines.push(JSON.stringify({
      step_index: 201,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: `[Message] sender=${WORKER_CONV}/cap65-task-65 content=Task id "${WORKER_CONV}/cap65-task-65" finished with result: ok`,
    }))
    cap65Lines.push(JSON.stringify({ step_index: 202, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }))
    await writeFile(workerTranscript, `${cap65Lines.join('\n')}\n`)
    const cap65DoneSnap = readAntigravitySwarmSnapshot({
      brainDir, conversationId: COORD_CONV, phase: 'running', revision: 33, telemetryCache: capCache, drainTelemetry: true,
    })!
    const cap65Worker = cap65DoneSnap.members.find((m) => m.name === 'parser')!
    assert.equal(cap65Worker.status, 'waiting', 'P1-B: finishing all 65 tasks without restart must recover waiting')
    assert.notEqual(cap65Worker.livenessEvidencePartial, true)
    let cap65Reclaimed = 0
    const cap65Mon = new SwarmStallMonitor({
      stallThresholdMs: 1_000, retryCooldownMs: 1_000, exhaustedGraceMs: 1_000, maxAlerts: 1,
      onStallExhausted: () => { cap65Reclaimed += 1 },
    })
    cap65Mon.evaluate(cap65DoneSnap, 1_000)
    cap65Mon.evaluate({ ...cap65DoneSnap, revision: 34 }, 3_000)
    cap65Mon.evaluate({ ...cap65DoneSnap, revision: 35 }, 5_000)
    assert.equal(cap65Reclaimed, 1, 'P1-B: after all 65 tasks finish, stalled swarm must be reclaimable')

    // R2 P1-C: 2.4 MiB oversized historical line poisons cumulative telemetryPartial=true,
    // blocks reclaim BEFORE restart, but recovers reclaim eligibility AFTER SERVER_RESTART!
    const hugeLine = JSON.stringify({
      step_index: 1,
      type: 'GENERIC',
      status: 'DONE',
      content: 'X'.repeat(2_400_000),
    })
    const postHugeReply = JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] })
    const restartLine = JSON.stringify({
      step_index: 3,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      content: '<SYSTEM_MESSAGE>\nAll your subagents and background tasks have been stopped due to server restart.\n</SYSTEM_MESSAGE>',
    })
    const postRestartReply = JSON.stringify({ step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] })

    const hugeCache = new IncrementalTranscriptTelemetryCache()
    await writeFile(workerTranscript, `${hugeLine}\n${postHugeReply}\n`)
    const preRestartSnap = readAntigravitySwarmSnapshot({
      brainDir, conversationId: COORD_CONV, phase: 'running', revision: 40, telemetryCache: hugeCache, drainTelemetry: true,
    })!
    const preRestartWorker = preRestartSnap.members.find((m) => m.name === 'parser')!
    assert.equal(preRestartWorker.telemetryPartial, true, 'P1-C: oversized line marks historical telemetryPartial=true')
    assert.equal(preRestartWorker.livenessEvidencePartial, true, 'P1-C: unverified gap before restart blocks liveness certainty')
    let preRestartReclaimed = 0
    const preRestartMon = new SwarmStallMonitor({
      stallThresholdMs: 1_000, retryCooldownMs: 1_000, exhaustedGraceMs: 1_000, maxAlerts: 1,
      onStallExhausted: () => { preRestartReclaimed += 1 },
    })
    preRestartMon.evaluate(preRestartSnap, 1_000)
    preRestartMon.evaluate({ ...preRestartSnap, revision: 41 }, 3_000)
    preRestartMon.evaluate({ ...preRestartSnap, revision: 42 }, 5_000)
    assert.equal(preRestartReclaimed, 0, 'P1-C: oversized gap with no server restart must still block reclaim')

    await writeFile(workerTranscript, `${hugeLine}\n${postHugeReply}\n${restartLine}\n${postRestartReply}\n`)
    const postRestartSnap = readAntigravitySwarmSnapshot({
      brainDir, conversationId: COORD_CONV, phase: 'running', revision: 43, telemetryCache: hugeCache, drainTelemetry: true,
    })!
    const postRestartWorker = postRestartSnap.members.find((m) => m.name === 'parser')!
    assert.equal(postRestartWorker.status, 'waiting')
    assert.equal(postRestartWorker.telemetryPartial, true, 'P1-C: historical token subtotal remains honestly partial')
    assert.equal(postRestartWorker.livenessEvidencePartial, false, 'P1-C: post-restart lifecycle evidence is complete')
    let postRestartReclaimed = 0
    const postRestartMon = new SwarmStallMonitor({
      stallThresholdMs: 1_000, retryCooldownMs: 1_000, exhaustedGraceMs: 1_000, maxAlerts: 1,
      onStallExhausted: () => { postRestartReclaimed += 1 },
    })
    postRestartMon.evaluate(postRestartSnap, 1_000)
    postRestartMon.evaluate({ ...postRestartSnap, revision: 44 }, 3_000)
    postRestartMon.evaluate({ ...postRestartSnap, revision: 45 }, 5_000)
    assert.equal(postRestartReclaimed, 1, 'P1-C: clean post-restart phase must restore reclaim eligibility')

    // R2 P1-A (1): Plannerless direct TOOL_CALL ACTIVE (cmd-a + swarm_wait), only swarm_wait DONE,
    // followed by reminder SYSTEM_MESSAGE + next planner swarm_wait -> cmd-a MUST stay active (working)!
    const plannerlessDirect = [
      JSON.stringify({ step_index: 1, type: 'TOOL_CALL', tool_call_id: 'cmd-a', tool_name: 'run_command', status: 'ACTIVE', arguments: { CommandLine: 'npm test' } }),
      JSON.stringify({ step_index: 2, type: 'TOOL_CALL', tool_call_id: 'wait-w', tool_name: 'swarm_wait', status: 'ACTIVE', arguments: { since: 1 } }),
      JSON.stringify({ step_index: 3, type: 'TOOL_RESULT', tool_call_id: 'wait-w', tool_name: 'swarm_wait', status: 'DONE', content: 'parked' }),
      JSON.stringify({ step_index: 4, type: 'SYSTEM_MESSAGE', status: 'DONE', content: '<SYSTEM_MESSAGE>\nReminder: work efficiently.\n</SYSTEM_MESSAGE>' }),
      JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', arguments: { since: 2 } }] }),
    ]
    await writeFile(workerTranscript, `${plannerlessDirect.join('\n')}\n`)
    const directSnap = readAntigravitySwarmSnapshot({
      brainDir, conversationId: COORD_CONV, phase: 'running', revision: 50,
    })!
    const directWorker = directSnap.members.find((m) => m.name === 'parser')!
    assert.equal(directWorker.status, 'working', 'P1-A: plannerless direct unfinished cmd-a must NOT be cut by reminder SYSTEM_MESSAGE')
    let directReclaimed = 0
    const directMon = new SwarmStallMonitor({
      stallThresholdMs: 1_000, retryCooldownMs: 1_000, exhaustedGraceMs: 1_000, maxAlerts: 1,
      onStallExhausted: () => { directReclaimed += 1 },
    })
    directMon.evaluate(directSnap, 1_000)
    directMon.evaluate({ ...directSnap, revision: 51 }, 3_000)
    directMon.evaluate({ ...directSnap, revision: 52 }, 5_000)
    assert.equal(directReclaimed, 0, 'P1-A: unfinished direct sibling cmd-a must block stall reclamation')

    // R2 P1-A (2): Reverse control — planner emits W, W transitions ACTIVE -> DONE (same id), then waking SYSTEM_MESSAGE -> working ('启动处理中…')!
    const activeToDoneWake = [
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ id: 'w-1', name: 'swarm_wait', arguments: { since: 1 } }] }),
      JSON.stringify({ step_index: 2, type: 'TOOL_CALL', tool_call_id: 'w-1', tool_name: 'swarm_wait', status: 'ACTIVE', arguments: { since: 1 } }),
      JSON.stringify({ step_index: 3, type: 'TOOL_RESULT', tool_call_id: 'w-1', tool_name: 'swarm_wait', status: 'DONE', content: 'woken' }),
      JSON.stringify({ step_index: 4, type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=system content=[swarm] new board message #9' }),
    ]
    const activeToDoneParsed = parseMemberTranscriptTail(`${activeToDoneWake.join('\n')}\n`)
    assert.equal(activeToDoneParsed.status, 'working', 'P1-A reverse control: same-ID ACTIVE->DONE settles W so wake SYSTEM_MESSAGE starts working turn')
    assert.equal(activeToDoneParsed.activity, '启动处理中…')

    // P1-2: Duplicate DONE for cmdB + anonymous DONE must NOT cut turn at mid-turn SYSTEM_MESSAGE while cmdA is still active
    const dupDoneSteps = [
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [
          { id: 'call-a', name: 'run_command', arguments: { CommandLine: 'cmd-a' } },
          { id: 'call-b', name: 'run_command', arguments: { CommandLine: 'cmd-b' } },
          { id: 'call-w', name: 'swarm_wait', arguments: { since: 1 } },
        ],
      }),
      JSON.stringify({ step_index: 2, type: 'TOOL_RESULT', tool_call_id: 'call-b', tool_name: 'run_command', status: 'DONE', content: 'b done' }),
      JSON.stringify({ step_index: 3, type: 'TOOL_RESULT', tool_call_id: 'call-b', tool_name: 'run_command', status: 'DONE', content: 'b done dup' }),
      JSON.stringify({ step_index: 4, type: 'GENERIC', status: 'DONE', content: 'parked' }),
      JSON.stringify({ step_index: 5, type: 'SYSTEM_MESSAGE', status: 'DONE', content: '<SYSTEM_MESSAGE>\nReminder: work efficiently.\n</SYSTEM_MESSAGE>' }),
      JSON.stringify({ step_index: 6, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', arguments: { since: 2 } }] }),
    ]
    const dupParsed = parseMemberTranscriptTail(`${dupDoneSteps.join('\n')}\n`)
    assert.equal(dupParsed.status, 'working', 'P1-2: duplicate DONE must NOT cut turn and drop unfinished sibling call-a')
    assert.equal(dupParsed.hasActiveNonWaitTool, true)

    // P1-2 positive control: all 3 calls genuinely DONE -> waking SYSTEM_MESSAGE cleanly starts new working turn
    const allDoneThenWake = [
      dupDoneSteps[0]!,
      JSON.stringify({ step_index: 2, type: 'TOOL_RESULT', tool_call_id: 'call-a', tool_name: 'run_command', status: 'DONE', content: 'a done' }),
      JSON.stringify({ step_index: 3, type: 'TOOL_RESULT', tool_call_id: 'call-b', tool_name: 'run_command', status: 'DONE', content: 'b done' }),
      JSON.stringify({ step_index: 4, type: 'TOOL_RESULT', tool_call_id: 'call-w', tool_name: 'swarm_wait', status: 'DONE', content: 'wait done' }),
      JSON.stringify({ step_index: 5, type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=system content=[swarm] new board message #9' }),
    ]
    const allDoneParsed = parseMemberTranscriptTail(`${allDoneThenWake.join('\n')}\n`)
    assert.equal(allDoneParsed.status, 'working', 'P1-2 positive control: waking SYSTEM_MESSAGE after truly settled wait batch starts working turn')
    assert.equal(allDoneParsed.activity, '启动处理中…')

    // P1-3: 17 task completions batched in a single SYSTEM_MESSAGE must NOT drop the 17th completion
    const batch17Steps: string[] = []
    const batch17Msgs: string[] = []
    for (let i = 1; i <= 17; i += 1) {
      const tid = `${WORKER_CONV}/task-${500 + i}`
      batch17Steps.push(JSON.stringify({ step_index: i, type: 'GENERIC', status: 'RUNNING', content: `Tool is running as a background task with task id: ${tid}` }))
      batch17Msgs.push(`[Message] timestamp=2026-11-28T08:20:00Z sender=${tid} priority=MESSAGE_PRIORITY_HIGH content=Task id "${tid}" finished with result: ok`)
    }
    batch17Steps.push(JSON.stringify({ step_index: 20, type: 'SYSTEM_MESSAGE', status: 'DONE', content: `<SYSTEM_MESSAGE>\n${batch17Msgs.join('\n')}\n</SYSTEM_MESSAGE>` }))
    batch17Steps.push(JSON.stringify({ step_index: 21, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [] }))
    const batch17Parsed = parseMemberTranscriptTail(`${batch17Steps.join('\n')}\n`)
    assert.equal(batch17Parsed.status, 'waiting', 'P1-3: all 17 batched finish notifications must be folded without dropping #17')
    assert.equal(batch17Parsed.waitingOnBoard, true)

    // Steward Blocker #1: Empty or unparseable tail MUST still merge incremental bg-task evidence
    // (preserving working for active tasks and livenessEvidencePartial=true to block onStallExhausted)
    const emptyTailActive = parseMemberTranscriptTail('', {
      incBgTasks: { activeIds: [`${WORKER_CONV}/task-901`], retiredIds: [], overflowed: false, sawServerRestart: false, evidenceIncomplete: true },
    })
    assert.equal(emptyTailActive.status, 'working', 'empty tail must preserve incremental active bg task')
    assert.equal(emptyTailActive.incompleteBgEvidence, true)
    const unparseableTailIncomplete = parseMemberTranscriptTail('{broken json\n', {
      incBgTasks: { activeIds: [], retiredIds: [], overflowed: false, sawServerRestart: false, evidenceIncomplete: true },
      tailTruncated: true,
    })
    assert.equal(unparseableTailIncomplete.incompleteBgEvidence, true, 'unparseable tail must preserve incompleteBgEvidence')
    // Verify through full readAntigravitySwarmSnapshot + SwarmStallMonitor (oversized trailing unparseable chunk -> empty tail -> 0 reclaims)
    await writeFile(workerTranscript, `${'x'.repeat(2_300_000)}`)
    const emptyTailCache = new IncrementalTranscriptTelemetryCache()
    const emptyTailSnap = readAntigravitySwarmSnapshot({
      brainDir, conversationId: COORD_CONV, phase: 'running', revision: 60, telemetryCache: emptyTailCache, drainTelemetry: true,
    })!
    const emptyTailWorker = emptyTailSnap.members.find((m) => m.name === 'parser')!
    assert.equal(emptyTailWorker.livenessEvidencePartial, true, 'unparseable/empty tail with incomplete inc evidence must NOT flip livenessEvidencePartial to false')
    let emptyTailReclaimed = 0
    const emptyTailMon = new SwarmStallMonitor({
      stallThresholdMs: 1_000, retryCooldownMs: 1_000, exhaustedGraceMs: 1_000, maxAlerts: 1,
      onStallExhausted: () => { emptyTailReclaimed += 1 },
    })
    emptyTailMon.evaluate(emptyTailSnap, 1_000)
    emptyTailMon.evaluate({ ...emptyTailSnap, revision: 61 }, 3_000)
    emptyTailMon.evaluate({ ...emptyTailSnap, revision: 62 }, 5_000)
    assert.equal(emptyTailReclaimed, 0, 'empty/unparseable tail with incomplete evidence must block onStallExhausted')

    // Steward Blocker #3: findTurnStartIndex MUST scale linearly O(N) on consecutive non-turn-ending SYSTEM_MESSAGE steps
    const { findTurnStartIndex } = await import('../engine/antigravitySwarmFormat.js')
    const measureTypeReads = (nSys: number): number => {
      let reads = 0
      const wrap = (obj: Record<string, unknown>) =>
        new Proxy(obj, {
          get(target, prop, receiver) {
            if (prop === 'type') reads += 1
            return Reflect.get(target, prop, receiver)
          },
        })
      const seq: Record<string, unknown>[] = [
        wrap({ step_index: 0, type: 'USER_INPUT', status: 'DONE' }),
        wrap({ step_index: 1, type: 'TOOL_CALL', tool_call_id: 'long-a', tool_name: 'run_command', status: 'ACTIVE' }),
        ...Array.from({ length: nSys }, (_, k) =>
          wrap({ step_index: 2 + k, type: 'SYSTEM_MESSAGE', status: 'DONE', content: `reminder ${k}` }),
        ),
      ]
      assert.equal(findTurnStartIndex(seq), 0)
      return reads
    }
    const r32 = measureTypeReads(32)
    const r64 = measureTypeReads(64)
    const r128 = measureTypeReads(128)
    assert.ok(r128 <= 200, `findTurnStartIndex must be O(N), got ${r128} type reads for N=128`)
    assert.ok(r128 - r64 <= (r64 - r32) * 2.5 + 4, `type reads must grow linearly (r32=${r32}, r64=${r64}, r128=${r128})`)

    // Steward R2 Blocker #1: ERROR_MESSAGE while background task is still active MUST keep failed/lastError
    // AND block onStallExhausted (0 before task finishes, 1 after task finishes)
    const errBgTaskId = `${WORKER_CONV}/task-err-bg-1`
    const errWithLiveBg = [
      JSON.stringify({ step_index: 1, type: 'GENERIC', status: 'RUNNING', content: `Tool is running as a background task with task id: ${errBgTaskId}` }),
      JSON.stringify({ step_index: 2, type: 'ERROR_MESSAGE', status: 'ERROR', content: 'quota exceeded' }),
    ]
    await writeFile(workerTranscript, `${errWithLiveBg.join('\n')}\n`)
    const errLiveSnap = readAntigravitySwarmSnapshot({
      brainDir, conversationId: COORD_CONV, phase: 'running', revision: 70,
    })!
    const errLiveWorker = errLiveSnap.members.find((m) => m.name === 'parser')!
    assert.equal(errLiveWorker.failed, true, 'ERROR_MESSAGE must still surface failed=true')
    assert.ok(errLiveWorker.lastError?.includes('quota exceeded'))
    assert.equal(errLiveWorker.livenessEvidencePartial, true, 'active bg task on ERROR_MESSAGE must set livenessEvidencePartial=true')
    let errLiveReclaimed = 0
    const errLiveMon = new SwarmStallMonitor({
      stallThresholdMs: 1_000, retryCooldownMs: 1_000, exhaustedGraceMs: 1_000, maxAlerts: 1,
      onStallExhausted: () => { errLiveReclaimed += 1 },
    })
    errLiveMon.evaluate(errLiveSnap, 1_000)
    errLiveMon.evaluate({ ...errLiveSnap, revision: 71 }, 3_000)
    errLiveMon.evaluate({ ...errLiveSnap, revision: 72 }, 5_000)
    assert.equal(errLiveReclaimed, 0, 'ERROR_MESSAGE with active bg task must NOT trigger onStallExhausted')

    // Positive control: once errBgTaskId terminates, onStallExhausted fires normally (1)
    const errAfterBgDone = [
      ...errWithLiveBg,
      JSON.stringify({ step_index: 3, type: 'SYSTEM_MESSAGE', status: 'DONE', content: `[Message] sender=${errBgTaskId} content=Task id "${errBgTaskId}" finished with result: ok` }),
      JSON.stringify({ step_index: 4, type: 'ERROR_MESSAGE', status: 'ERROR', content: 'quota exceeded' }),
    ]
    await writeFile(workerTranscript, `${errAfterBgDone.join('\n')}\n`)
    const errDoneSnap = readAntigravitySwarmSnapshot({
      brainDir, conversationId: COORD_CONV, phase: 'running', revision: 73,
    })!
    const errDoneWorker = errDoneSnap.members.find((m) => m.name === 'parser')!
    assert.equal(errDoneWorker.failed, true)
    assert.notEqual(errDoneWorker.livenessEvidencePartial, true)
    let errDoneReclaimed = 0
    const errDoneMon = new SwarmStallMonitor({
      stallThresholdMs: 1_000, retryCooldownMs: 1_000, exhaustedGraceMs: 1_000, maxAlerts: 1,
      onStallExhausted: () => { errDoneReclaimed += 1 },
    })
    errDoneMon.evaluate(errDoneSnap, 1_000)
    errDoneMon.evaluate({ ...errDoneSnap, revision: 74 }, 3_000)
    errDoneMon.evaluate({ ...errDoneSnap, revision: 75 }, 5_000)
    assert.equal(errDoneReclaimed, 1, 'after bg task finishes, errored stalled swarm must reclaim normally')

    // Steward R2 Blocker #2: O(N) indexed ID lookup in findTurnStartIndex for distinct-ID tool pairs
    // (both standalone and interleaved with SYSTEM_MESSAGEs)
    const measureToolPairOps = (nPairs: number, interleaveSys: boolean): number => {
      let propReads = 0
      const wrap = (obj: Record<string, unknown>) =>
        new Proxy(obj, {
          get(target, prop, receiver) {
            if (prop === 'type' || prop === 'tool_call_id' || prop === 'call_id' || prop === 'id') propReads += 1
            return Reflect.get(target, prop, receiver)
          },
        })
      const seq: Record<string, unknown>[] = [wrap({ step_index: 0, type: 'USER_INPUT', status: 'DONE' })]
      let idx = 1
      for (let k = 0; k < nPairs; k += 1) {
        seq.push(wrap({ step_index: idx++, type: 'TOOL_CALL', tool_call_id: `cid-${k}`, tool_name: 'run_command', status: 'ACTIVE' }))
        if (interleaveSys) seq.push(wrap({ step_index: idx++, type: 'SYSTEM_MESSAGE', status: 'DONE', content: `tick ${k}` }))
        seq.push(wrap({ step_index: idx++, type: 'TOOL_RESULT', tool_call_id: `cid-${k}`, tool_name: 'run_command', status: 'DONE', content: 'ok' }))
      }
      assert.equal(findTurnStartIndex(seq), 0)
      return propReads
    }
    const p32 = measureToolPairOps(32, false)
    const p64 = measureToolPairOps(64, false)
    const p128 = measureToolPairOps(128, false)
    assert.ok(p128 - p64 <= (p64 - p32) * 2.5 + 16, `tool-pair ops must scale linearly (p32=${p32}, p64=${p64}, p128=${p128})`)
    const i32 = measureToolPairOps(32, true)
    const i64 = measureToolPairOps(64, true)
    const i128 = measureToolPairOps(128, true)
    assert.ok(i128 - i64 <= (i64 - i32) * 2.5 + 16, `interleaved tool+sys ops must scale linearly (i32=${i32}, i64=${i64}, i128=${i128})`)

    // Steward R3 Blocker: internal candidate visit counts across ALL 3 paths
    // (direct ID, planner-no-ID -> direct-ID bind, and anonymous GENERIC DONE + final swarm_wait)
    const {
      resetTurnReductionCandidateVisitsForTests,
      getTurnReductionCandidateVisitsForTests,
    } = await import('../engine/antigravitySwarmFormat.js')
    const measurePlannerBindVisits = (nEpochs: number): number => {
      const seq: Record<string, unknown>[] = [{ step_index: 0, type: 'USER_INPUT', status: 'DONE' }]
      let si = 1
      for (let e = 0; e < nEpochs; e += 1) {
        seq.push({ step_index: si++, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', arguments: { CommandLine: `cmd-${e}` } }] })
        seq.push({ step_index: si++, type: 'TOOL_CALL', tool_call_id: `late-id-${e}`, tool_name: 'run_command', status: 'ACTIVE', arguments: { CommandLine: `cmd-${e}` } })
        seq.push({ step_index: si++, type: 'TOOL_RESULT', tool_call_id: `late-id-${e}`, tool_name: 'run_command', status: 'DONE', content: 'ok' })
      }
      resetTurnReductionCandidateVisitsForTests()
      assert.equal(findTurnStartIndex(seq), 0)
      return getTurnReductionCandidateVisitsForTests()
    }
    assert.equal(measurePlannerBindVisits(32), 32, 'planner-no-ID -> direct-ID bind must visit 1 candidate per epoch (N=32)')
    assert.equal(measurePlannerBindVisits(64), 64, 'planner-no-ID -> direct-ID bind must visit 1 candidate per epoch (N=64)')
    assert.equal(measurePlannerBindVisits(128), 128, 'planner-no-ID -> direct-ID bind must visit 1 candidate per epoch (N=128)')

    const measureAnonGenericVisits = (nEpochs: number): number => {
      const seq: Record<string, unknown>[] = [{ step_index: 0, type: 'USER_INPUT', status: 'DONE' }]
      let si = 1
      for (let e = 0; e < nEpochs; e += 1) {
        seq.push({ step_index: si++, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', arguments: { CommandLine: `anon-${e}` } }] })
        seq.push({ step_index: si++, type: 'GENERIC', status: 'DONE', content: `out-${e}` })
      }
      const waitSysIdx = si + 2
      seq.push({ step_index: si++, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', arguments: { since: 1 } }] })
      seq.push({ step_index: si++, type: 'GENERIC', status: 'DONE', content: 'parked' })
      seq.push({ step_index: si++, type: 'SYSTEM_MESSAGE', status: 'DONE', content: '[Message] sender=system content=[swarm] wake' })
      resetTurnReductionCandidateVisitsForTests()
      assert.equal(findTurnStartIndex(seq), waitSysIdx)
      return getTurnReductionCandidateVisitsForTests()
    }
    assert.ok(measureAnonGenericVisits(32) <= 40, 'anonymous GENERIC DONE epochs must settle in O(N) (N=32)')
    assert.ok(measureAnonGenericVisits(64) <= 72, 'anonymous GENERIC DONE epochs must settle in O(N) (N=64)')
    assert.ok(measureAnonGenericVisits(128) <= 140, 'anonymous GENERIC DONE epochs must settle in O(N) (N=128)')

    // Steward R4/R5 Blocker (1): unfinished parallel tool across 32/64/128 epochs of named-without-ID swarm_wait + SYSTEM_MESSAGE
    // must keep unfinished tool active with O(N) candidate visits AND zero historical set copies
    const {
      findActiveNonBoardToolInTurn,
      getTurnReductionMetricsForTests,
    } = await import('../engine/antigravitySwarmFormat.js')
    const measureUnfinishedWithNamedWaits = (nEpochs: number) => {
      const seq: Record<string, unknown>[] = [
        { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
        { step_index: 1, type: 'TOOL_CALL', tool_call_id: 'long-sibling', tool_name: 'run_command', status: 'ACTIVE', arguments: { CommandLine: 'sleep 999' } },
      ]
      let si = 2
      for (let e = 0; e < nEpochs; e += 1) {
        seq.push({ step_index: si++, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', arguments: { since: e + 1 } }] })
        seq.push({ step_index: si++, type: 'TOOL_RESULT', tool_name: 'swarm_wait', status: 'DONE', content: 'parked' })
        seq.push({ step_index: si++, type: 'SYSTEM_MESSAGE', status: 'DONE', content: `reminder ${e}` })
      }
      resetTurnReductionCandidateVisitsForTests()
      assert.equal(findTurnStartIndex(seq), 0, 'unfinished parallel tool must remain active across named swarm_wait + SYSTEM_MESSAGE epochs')
      return getTurnReductionMetricsForTests()
    }
    for (const [n, maxVisits] of [[32, 40], [64, 72], [128, 140]] as const) {
      const m = measureUnfinishedWithNamedWaits(n)
      assert.ok(m.candidateVisits <= maxVisits, `named fallback wait visits must be O(N) (N=${n}, got=${m.candidateVisits})`)
      assert.equal(m.setCopies, 0, `boundary snapshot must NEVER clone historical accounted set (N=${n})`)
      assert.equal(m.bucketWrites, n, `wait-only epochs must have at most 1 bucket write/epoch (N=${n})`)
    }
    // Also verify non-board pending fallback during SYSTEM_MESSAGE uses delta overlay with 0 historical set copies
    const measureNonBoardOverlaySnapshot = (nEpochs: number) => {
      const seq: Record<string, unknown>[] = [
        { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
        { step_index: 1, type: 'TOOL_CALL', tool_call_id: 'long-sibling', tool_name: 'run_command', status: 'ACTIVE', arguments: { CommandLine: 'sleep 999' } },
      ]
      let si = 2
      for (let e = 0; e < nEpochs; e += 1) {
        seq.push({ step_index: si++, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', arguments: { Path: `f${e}.ts` } }, { name: 'swarm_wait', arguments: { since: e + 1 } }] })
        seq.push({ step_index: si++, type: 'TOOL_RESULT', tool_name: 'read_file', status: 'DONE', content: 'ok' })
        seq.push({ step_index: si++, type: 'TOOL_RESULT', tool_name: 'swarm_wait', status: 'DONE', content: 'parked' })
        seq.push({ step_index: si++, type: 'SYSTEM_MESSAGE', status: 'DONE', content: `tick ${e}` })
      }
      resetTurnReductionCandidateVisitsForTests()
      assert.equal(findTurnStartIndex(seq), 0)
      return getTurnReductionMetricsForTests()
    }
    for (const n of [32, 64, 128] as const) {
      const m = measureNonBoardOverlaySnapshot(n)
      assert.ok(m.candidateVisits <= 3 * n + 8, `non-board overlay visits must scale linearly (N=${n}, got=${m.candidateVisits})`)
      assert.equal(m.setCopies, 0, `non-board overlay snapshot must do 0 historical set copies (N=${n})`)
    }

    // Steward R4/R5 Blocker (2): single planner batch with 32/64/128 same-name distinct-args OR ambiguous identical-args calls
    // must keep BOTH candidate visits and bucket writes strictly O(N) (zero tail shifting on ambiguity)
    const measureSameNameBatchLateIds = (nCalls: number, identicalArgs: boolean) => {
      const seq: Record<string, unknown>[] = [
        { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: Array.from({ length: nCalls }, (_, k) => ({
            name: 'run_command',
            arguments: { CommandLine: identicalArgs ? 'echo same' : `echo ${k}` },
          })),
        },
      ]
      let si = 2
      for (let k = 0; k < nCalls; k += 1) {
        const cmd = identicalArgs ? 'echo same' : `echo ${k}`
        seq.push({ step_index: si++, type: 'TOOL_CALL', tool_call_id: `batch-id-${k}`, tool_name: 'run_command', status: 'ACTIVE', arguments: { CommandLine: cmd } })
        seq.push({ step_index: si++, type: 'TOOL_RESULT', tool_call_id: `batch-id-${k}`, tool_name: 'run_command', status: 'DONE', content: 'ok' })
      }
      resetTurnReductionCandidateVisitsForTests()
      assert.equal(findTurnStartIndex(seq), 0)
      return getTurnReductionMetricsForTests()
    }
    for (const n of [32, 64, 128] as const) {
      const distinct = measureSameNameBatchLateIds(n, false)
      assert.equal(distinct.candidateVisits, n, `distinct-args batch visits must be 1*N (N=${n})`)
      assert.equal(distinct.bucketWrites, n, `distinct-args batch bucket writes must be 1*N (N=${n})`)
      const ambiguous = measureSameNameBatchLateIds(n, true)
      assert.equal(ambiguous.candidateVisits, 2 * n, `ambiguous identical-args batch visits must be 2*N (N=${n})`)
      assert.equal(ambiguous.bucketWrites, n, `ambiguous identical-args batch must NOT rewrite bucket tail (writes must be 1*N, N=${n})`)
    }

    // Steward R5 Blocker (boundaryIntegrity): ONE DONE credential with ID must NEVER settle two different calls across epochs.
    // Five-step out-of-order record: Epoch 1 call A (no ID) + DONE(cid-B, run_command) -> Epoch 2 call B (no ID) + TOOL_CALL ACTIVE(cid-B, args B)
    // must reassign cid-B to call B, keep call A active (working), and trigger 0 SwarmStallMonitor reclaims!
    const crossEpochOutOfOrderSteps: Record<string, unknown>[] = [
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', arguments: { CommandLine: 'cmd-A' } }] },
      { step_index: 2, type: 'TOOL_RESULT', tool_call_id: 'cid-B', tool_name: 'run_command', status: 'DONE', content: 'b done early' },
      { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', arguments: { CommandLine: 'cmd-B' } }] },
      { step_index: 4, type: 'TOOL_CALL', tool_call_id: 'cid-B', tool_name: 'run_command', status: 'ACTIVE', arguments: { CommandLine: 'cmd-B' } },
      { step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', arguments: { since: 1 } }] },
    ]
    const activeA = findActiveNonBoardToolInTurn(crossEpochOutOfOrderSteps, 4, [{ name: 'swarm_wait', arguments: { since: 1 } }])
    assert.deepEqual(activeA, { name: 'run_command', args: { CommandLine: 'cmd-A' } }, 'R5: single DONE(cid-B) must NOT settle both call A and call B')
    await writeFile(workerTranscript, `${crossEpochOutOfOrderSteps.map((s) => JSON.stringify(s)).join('\n')}\n`)
    const r5Snap = readAntigravitySwarmSnapshot({ brainDir, conversationId: COORD_CONV, phase: 'running', revision: 80 })!
    const r5Worker = r5Snap.members.find((m) => m.name === 'parser')!
    assert.equal(r5Worker.status, 'working', 'R5: watcher must classify worker as working while call A remains active')
    let r5Reclaimed = 0
    const r5Mon = new SwarmStallMonitor({
      stallThresholdMs: 1_000, retryCooldownMs: 1_000, exhaustedGraceMs: 1_000, maxAlerts: 1,
      onStallExhausted: () => { r5Reclaimed += 1 },
    })
    r5Mon.evaluate(r5Snap, 1_000)
    r5Mon.evaluate({ ...r5Snap, revision: 81 }, 3_000)
    r5Mon.evaluate({ ...r5Snap, revision: 82 }, 5_000)
    assert.equal(r5Reclaimed, 0, 'R5: single DONE(cid-B) must NOT trigger SwarmStallMonitor reclaim while call A is active')
    // Also verify direct-start variant (no planner call B in epoch 2, direct TOOL_CALL ACTIVE with cid-B)
    const crossEpochDirectSteps: Record<string, unknown>[] = [
      crossEpochOutOfOrderSteps[0]!,
      crossEpochOutOfOrderSteps[1]!,
      { step_index: 3, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', arguments: { since: 1 } }] },
      { step_index: 4, type: 'TOOL_CALL', tool_call_id: 'cid-B', tool_name: 'run_command', status: 'ACTIVE', arguments: { CommandLine: 'cmd-B' } },
    ]
    const activeADirect = findActiveNonBoardToolInTurn(crossEpochDirectSteps, 2, [{ name: 'swarm_wait', arguments: { since: 1 } }])
    assert.deepEqual(activeADirect, { name: 'run_command', args: { CommandLine: 'cmd-A' } }, 'R5 direct variant: call A must stay active when direct call B claims cid-B')
    // Positive control: once call A also receives its own DONE (in epoch 1), worker returns to waiting and reclaimable (1)
    const crossEpochBothDone = [
      { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ id: 'cid-A', name: 'run_command', arguments: { CommandLine: 'cmd-A' } }] },
      { step_index: 2, type: 'TOOL_RESULT', tool_call_id: 'cid-B', tool_name: 'run_command', status: 'DONE', content: 'b done early' },
      { step_index: 3, type: 'TOOL_RESULT', tool_call_id: 'cid-A', tool_name: 'run_command', status: 'DONE', content: 'a done' },
      { step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', arguments: { CommandLine: 'cmd-B' } }] },
      { step_index: 5, type: 'TOOL_CALL', tool_call_id: 'cid-B', tool_name: 'run_command', status: 'ACTIVE', arguments: { CommandLine: 'cmd-B' } },
      { step_index: 6, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', arguments: { since: 1 } }] },
    ]
    await writeFile(workerTranscript, `${crossEpochBothDone.map((s) => JSON.stringify(s)).join('\n')}\n`)
    const r5DoneSnap = readAntigravitySwarmSnapshot({ brainDir, conversationId: COORD_CONV, phase: 'running', revision: 83 })!
    assert.equal(r5DoneSnap.members.find((m) => m.name === 'parser')!.status, 'waiting', 'R5 positive control: settling both calls restores waiting')
    let r5DoneReclaimed = 0
    const r5DoneMon = new SwarmStallMonitor({
      stallThresholdMs: 1_000, retryCooldownMs: 1_000, exhaustedGraceMs: 1_000, maxAlerts: 1,
      onStallExhausted: () => { r5DoneReclaimed += 1 },
    })
    r5DoneMon.evaluate(r5DoneSnap, 1_000)
    r5DoneMon.evaluate({ ...r5DoneSnap, revision: 84 }, 3_000)
    r5DoneMon.evaluate({ ...r5DoneSnap, revision: 85 }, 5_000)
    assert.equal(r5DoneReclaimed, 1, 'R5 positive control: genuine deadlock reclaims once both calls settle')

    // Steward R6 Blocker (1) boundaryIntegrity: order-independent credential ownership when BOTH call A and call B
    // have independent DONEs in epoch 1 (both B->A and A->B permutations for unidentified AND identified A DONEs)
    const runOrderPermutation = async (
      firstDone: Record<string, unknown>, secondDone: Record<string, unknown>, revBase: number, label: string,
    ): Promise<void> => {
      const seq: Record<string, unknown>[] = [
        { step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', arguments: { Path: '/repo/a.ts' } }] },
        { ...firstDone, step_index: 2 },
        { ...secondDone, step_index: 3 },
        { step_index: 4, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', arguments: { Path: '/repo/b.ts' } }] },
        { step_index: 5, type: 'TOOL_CALL', tool_call_id: 'cid-B', tool_name: 'read_file', status: 'ACTIVE', arguments: { Path: '/repo/b.ts' } },
        { step_index: 6, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', arguments: { since: 1 } }] },
      ]
      assert.equal(findActiveNonBoardToolInTurn(seq, 5, [{ name: 'swarm_wait', arguments: { since: 1 } }]), null, `${label}: both calls must settle`)
      await writeFile(workerTranscript, `${seq.map((s) => JSON.stringify(s)).join('\n')}\n`)
      const snap = readAntigravitySwarmSnapshot({ brainDir, conversationId: COORD_CONV, phase: 'running', revision: revBase })!
      assert.equal(snap.members.find((m) => m.name === 'parser')!.status, 'waiting', `${label}: status must be waiting`)
      let reclaims = 0
      const mon = new SwarmStallMonitor({
        stallThresholdMs: 1_000, retryCooldownMs: 1_000, exhaustedGraceMs: 1_000, maxAlerts: 1,
        onStallExhausted: () => { reclaims += 1 },
      })
      mon.evaluate(snap, 1_000)
      mon.evaluate({ ...snap, revision: revBase + 1 }, 3_000)
      mon.evaluate({ ...snap, revision: revBase + 2 }, 5_000)
      assert.equal(reclaims, 1, `${label}: genuine deadlock must reclaim (1) regardless of DONE order`)
    }
    const doneB = { type: 'TOOL_RESULT', tool_call_id: 'cid-B', tool_name: 'read_file', status: 'DONE', content: 'b done' }
    const doneAUnid = { type: 'TOOL_RESULT', tool_name: 'read_file', status: 'DONE', content: 'a done' }
    const doneAId = { type: 'TOOL_RESULT', tool_call_id: 'cid-A', tool_name: 'read_file', status: 'DONE', content: 'a done' }
    await runOrderPermutation(doneB, doneAUnid, 90, 'R6 B->A(unid)')
    await runOrderPermutation(doneAUnid, doneB, 93, 'R6 A(unid)->B')
    await runOrderPermutation(doneB, doneAId, 96, 'R6 B->A(id)')
    await runOrderPermutation(doneAId, doneB, 99, 'R6 A(id)->B')

    // Steward R6 Blocker (2) complexityDrift: ID-only DONEs (no tool_name) across 32/64/128 swarm_wait + SYSTEM_MESSAGE epochs
    // must keep parallel tool active, STILL allow late exact-ID claim, and scale ID lookups strictly linearly O(N)
    const measureIdOnlyPendingLookups = (nEpochs: number) => {
      const seq: Record<string, unknown>[] = [
        { step_index: 0, type: 'USER_INPUT', status: 'DONE' },
        { step_index: 1, type: 'TOOL_CALL', tool_call_id: 'long-sibling', tool_name: 'run_command', status: 'ACTIVE', arguments: { CommandLine: 'sleep 999' } },
      ]
      let si = 2
      for (let e = 0; e < nEpochs; e += 1) {
        seq.push({ step_index: si++, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'swarm_wait', arguments: { since: e + 1 } }] })
        seq.push({ step_index: si++, type: 'TOOL_RESULT', tool_call_id: `id-only-${e}`, status: 'DONE', content: 'done' })
        seq.push({ step_index: si++, type: 'SYSTEM_MESSAGE', status: 'DONE', content: `tick ${e}` })
      }
      // Late exact-ID claim for id-only-0 must still succeed and leave only long-sibling active
      seq.push({ step_index: si++, type: 'TOOL_CALL', tool_call_id: 'id-only-0', tool_name: 'read_file', status: 'ACTIVE', arguments: { Path: '/repo/late.ts' } })
      resetTurnReductionCandidateVisitsForTests()
      assert.equal(findTurnStartIndex(seq), 0, `R6 id-only pending: parallel tool must remain active (N=${nEpochs})`)
      const active = findActiveNonBoardToolInTurn(seq, -1, [])
      assert.deepEqual(active, { name: 'run_command', args: { CommandLine: 'sleep 999' } }, `R6 id-only pending: late id-only-0 must claim and leave only long-sibling active (N=${nEpochs})`)
      return getTurnReductionMetricsForTests()
    }
    const idm32 = measureIdOnlyPendingLookups(32)
    const idm64 = measureIdOnlyPendingLookups(64)
    const idm128 = measureIdOnlyPendingLookups(128)
    assert.ok(idm128.idLookups <= 300, `R6 idLookups across findTurnStartIndex+findActive must be O(N), got ${idm128.idLookups}`)
    assert.ok(
      idm128.idLookups - idm64.idLookups <= (idm64.idLookups - idm32.idLookups) * 2.2 + 8,
      `R6 idLookups must scale linearly (32=${idm32.idLookups}, 64=${idm64.idLookups}, 128=${idm128.idLookups})`,
    )
    assert.equal(idm128.setCopies, 0)
  } finally {
    await rm(brainDir, { recursive: true, force: true })
  }
})
