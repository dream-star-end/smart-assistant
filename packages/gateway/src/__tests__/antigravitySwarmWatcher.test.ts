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
  extractSwarmMentions,
  parseSwarmSlashCommand,
  reduceLiveFrames,
} from '@openclaude/protocol'
import {
  antigravitySessionBrainDir,
  cleanupAntigravityLaunch,
  projectAntigravityPlatform,
} from '../engine/antigravityPlatform.js'
import {
  AntigravitySwarmWatcher,
  buildDurableSwarmBoardInput,
  compactSwarmSnapshotForPersistence,
  formatSwarmWorkingDetail,
  parseMemberTranscriptTail,
  readAntigravitySwarmSnapshot,
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

test('BLOCKER 4: reduceLiveFrames fails closed to raw fallback on swarm_snapshot and bumps epoch', () => {
  assert.equal(LIVE_UNITS_REDUCER_EPOCH, '3')
  const folded = reduceLiveFrames([
    {
      recordId: 'r-7',
      streamKey: 's1:gen0',
      clientMessageId: 'cmid-1',
      payload: {
        type: 'outbound.message',
        frameSeq: 7,
        sessionKey: 'agent:main:webchat:dm:s1',
        blocks: [
          {
            kind: 'swarm_snapshot',
            blockId: 'agy-swarm-11111111-t0',
            snapshot: {
              swarmId: COORD_CONV,
              title: '运行中蜂群',
              phase: 'running',
              revision: 3,
              updatedAt: Date.now(),
              members: [],
              channels: [],
              posts: [],
              totalPosts: 0,
            },
          },
        ],
      },
    },
  ])
  assert.deepEqual(folded, { ok: false, degraded: 'fallback' })
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
