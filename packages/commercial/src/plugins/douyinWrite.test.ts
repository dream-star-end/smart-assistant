/**
 * OCV5-553 PR4 · 抖音写动作：契约、写入声明 / 每日上限、节奏与风控冷却、确认卡、错误码、宿主帧顺序、
 * 服务端快照，以及从签名源码编译出来的 worker 写流程（核对目标与媒体 → 派发围栏之前停下）。
 * 不起 Docker、不联网。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'

import { buildWriteDetail, buildWriteSummary } from '../connectors/service.js'
import { validateRuntimePluginJson } from './contracts.js'
import {
  DOUYIN_PLUGIN_CONTRACT,
  DOUYIN_PLUGIN_VERSION,
  DouyinRuntimeError,
  assertDouyinWorkerEventOrder,
} from './douyin.js'
import { mapDouyinWorkerProtocolFailure } from './douyinObservability.js'
import { DOUYIN_WORKER_SOURCE } from './douyinWorkerSource.js'
import {
  DOUYIN_WRITE_COOLDOWN_MS,
  DOUYIN_WRITE_PACING_MS,
  DouyinWriteGuardError,
  assertDouyinWriteAllowed,
  beijingClock,
  douyinPacingKind,
  readDouyinWriteGate,
  recordDouyinWriteDispatch,
  tripDouyinWriteCooldown,
} from './douyinWriteGuard.js'
import {
  DOUYIN_UNKNOWN_WRITE_NEXT_ACTION,
  isPluginPassthroughErrorCode,
  resolvePluginErrorGuidance,
} from './pluginErrorGuidance.js'
import { PluginRuntimeFacade, douyinTargetDigest } from './runtime.js'
import { writeDailyCapBucket } from './writeDailyCap.js'
import {
  managedPluginWriteDailyCap,
  managedPluginWritePolicy,
  managedPluginWritePreapprovalPolicy,
} from './writePolicy.js'

const WRITE_IDS = [
  'publish_video',
  'publish_images',
  'create_comment',
  'reply_comment',
  'set_comment_digg',
]
const SITE = 'https://creator.douyin.com'
const USER_INFO = `${SITE}/web/api/media/user/info/`
const WORK_LIST = `${SITE}/janus/douyin/creator/pc/work_list`
const COMMENT_LIST = `${SITE}/aweme/v1/creator/comment/list/`
const USER_INFO_OK = { body: { status_code: 0, user: { uid: '1', nickname: '测试' } } }
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function action(id: string) {
  const found = DOUYIN_PLUGIN_CONTRACT.actions.find((candidate) => candidate.id === id)
  assert.ok(found, id)
  return found
}

/** Fake Redis that runs the two guard scripts (GET pair / push-later) against a Map. */
function fakeRedis(opts: { fail?: boolean; reply?: unknown } = {}) {
  const store = new Map<string, string>()
  const calls: string[] = []
  return {
    store,
    calls,
    async eval(script: string, numKeys: number, ...args: Array<string | number>) {
      calls.push(script)
      if (opts.fail) throw new Error('down')
      if (opts.reply !== undefined) return opts.reply
      const keys = args.slice(0, numKeys).map(String)
      const argv = args.slice(numKeys)
      if (script.includes("redis.call('SET'")) {
        const current = Number(store.get(keys[0]!) ?? '0')
        const next = Number(argv[0])
        if (current >= next) return current
        store.set(keys[0]!, String(next))
        return next
      }
      return keys.map((key) => store.get(key) ?? '')
    },
  }
}

/** Worker write flow compiled from the pinned source with stubbed I/O. */
function writeHarness(files: Record<string, Buffer> = {}) {
  const src = DOUYIN_WORKER_SOURCE
  const start = src.indexOf('function filteredState')
  const end = src.indexOf('async function finishAction')
  const consts = ['MAX_API_TEXT', 'SITE', 'USER_INFO_URL', 'ACCOUNT_INFO_URL', 'WRITE_ACTIONS']
    .concat(['SNAPSHOT_MAX_PAGES', 'MEDIA_MAX_BYTES'])
    .map((name) => {
      const line = new RegExp(`^const ${name} = .*;$`, 'm').exec(src)?.[0]
      assert.ok(line, name)
      return line
    })
    .join('\n')
  const frames: unknown[] = []
  const terminals: unknown[] = []
  const factory = new Function(
    'io',
    `'use strict';
     ${consts}
     const { createHash } = io;
     const readFile = io.readFile;
     const writeFrame = (value) => io.frames.push(value);
     const readFrame = async () => ({ event: 'dispatch' });
     const writeTerminalAndExit = async (value) => { io.terminals.push(value); throw new Error('EXITED'); };
     const emitStep = () => {};
     ${src.slice(start, end)}
     return { actionWrite, douyinTargetDigest, WRITE_DISPATCHERS };`,
  )
  const worker = factory({
    createHash,
    frames,
    terminals,
    async readFile(path: string) {
      const name = path.replace(/^\/inputs\//, '')
      const hit = files[name]
      if (!hit) throw new Error('ENOENT')
      return Buffer.from(hit)
    },
  }) as {
    actionWrite(page: unknown, input: Record<string, unknown>): Promise<unknown>
    douyinTargetDigest(target: Record<string, unknown>): string
    WRITE_DISPATCHERS: Record<string, unknown>
  }
  return { worker, frames, terminals }
}

function fakePage(table: Record<string, { status?: number; body: unknown }>, seen: string[] = []) {
  return {
    async evaluate(_fn: unknown, input: { url: string }) {
      seen.push(input.url)
      const hit = table[input.url] ?? table[input.url.split('?')[0]!]
      if (!hit) return { status: 404, text: '', tooLarge: false }
      return { status: hit.status ?? 200, text: JSON.stringify(hit.body), tooLarge: false }
    },
    async waitForTimeout() {},
  }
}

const VIDEO = { aweme_id: '7400000000000000001', create_time: 1_760_000_000 }
const COMMENT = { cid: '7400000000000000101', text: '好看', create_time: 1_760_000_100 }

describe('douyin write contract and policy', () => {
  test('1.1.0 declares the five write actions; network stays GET-only (no write request is wired)', () => {
    assert.equal(DOUYIN_PLUGIN_VERSION, '1.1.0')
    assert.deepEqual(
      DOUYIN_PLUGIN_CONTRACT.actions.filter((a) => a.effect === 'write').map((a) => a.id),
      WRITE_IDS,
    )
    assert.deepEqual([...DOUYIN_PLUGIN_CONTRACT.runtime.network.methods], ['GET'])
  })

  test('write params: required fields, bounded text, server-owned fields have strict shapes', () => {
    const ok = (id: string, params: unknown) =>
      assert.doesNotThrow(() => validateRuntimePluginJson(action(id).params, params, 'params'), id)
    const bad = (id: string, params: unknown) =>
      assert.throws(() => validateRuntimePluginJson(action(id).params, params, 'params'), id)
    ok('publish_video', { video: 'uploads/a.mp4', caption: '#话题 @某人', visibility: 'private' })
    bad('publish_video', { caption: 'x' })
    bad('publish_video', { video: 'uploads/a.mp4', visibility: 'everyone' })
    bad('publish_video', { video: 'uploads/a.mp4', title: 'x'.repeat(31) })
    ok('publish_images', { images: ['uploads/a.png'] })
    bad('publish_images', { images: [] })
    bad('publish_images', { images: Array.from({ length: 21 }, (_, i) => `uploads/${i}.png`) })
    ok('create_comment', { awemeId: '1', text: '你好' })
    bad('create_comment', { awemeId: '1', text: '' })
    bad('create_comment', { awemeId: '1', text: 'x'.repeat(501) })
    bad('create_comment', { awemeId: 'abc', text: 'x' })
    ok('reply_comment', { awemeId: '1', cid: '2', text: 'x' })
    ok('set_comment_digg', { awemeId: '1', cid: '2', digg: false })
    bad('set_comment_digg', { awemeId: '1', cid: '2' })
    const digest = 'a'.repeat(64)
    ok('reply_comment', {
      awemeId: '1',
      cid: '2',
      text: 'x',
      snapshot: { awemeId: '1', cid: '2', digest },
    })
    bad('reply_comment', {
      awemeId: '1',
      cid: '2',
      text: 'x',
      snapshot: { awemeId: '1', cid: '2', digest, extra: 1 },
    })
    const sealed = {
      path: 'uploads/a.mp4',
      inputId: 'abc-1',
      filename: 'a.mp4',
      sizeBytes: 10,
      sha256: digest,
      mimeType: 'video/mp4',
      kind: 'file',
    }
    ok('publish_video', { video: 'uploads/a.mp4', mediaManifest: [sealed] })
    bad('publish_video', {
      video: 'uploads/a.mp4',
      mediaManifest: [{ ...sealed, mimeType: 'video/quicktime' }],
    })
    bad('publish_video', {
      video: 'uploads/a.mp4',
      mediaManifest: [{ ...sealed, sizeBytes: 50 * 1024 * 1024 + 1 }],
    })
    bad('publish_images', {
      images: ['uploads/a.gif'],
      mediaManifest: [{ ...sealed, mimeType: 'image/gif', kind: 'image' }],
    })
  })

  test('write policy v1 without preapproval; daily caps per design 4.4; other plugins unchanged', () => {
    const policy = managedPluginWritePolicy('douyin')
    assert.equal(policy?.version, 1)
    assert.match(policy!.disclaimerText, /违反或可能违反抖音用户协议/)
    assert.match(policy!.disclaimerText, /不提供免逐次确认/)
    assert.match(policy!.disclaimerText, /24 小时/)
    assert.equal(managedPluginWritePreapprovalPolicy('douyin'), null)
    const cap = managedPluginWriteDailyCap('douyin')!
    const capFor = (id: string) => cap.caps[writeDailyCapBucket(cap, id)]
    assert.deepEqual(WRITE_IDS.map(capFor), [3, 3, 20, 20, 30])
    assert.equal(
      writeDailyCapBucket(cap, 'create_comment'),
      writeDailyCapBucket(cap, 'reply_comment'),
    )
    for (const slug of ['weibo', 'zhihu', 'knowledge-planet', 'bili-account', 'literature-db'])
      assert.equal(managedPluginWriteDailyCap(slug), null, slug)
  })
})

describe('douyin write pacing and risk-control cooldown', () => {
  test('pacing kinds and intervals: publish 10 min, comment / reply 60 s, digg 20 s, ±30% jitter', async () => {
    assert.deepEqual(WRITE_IDS.map(douyinPacingKind), [
      'publish',
      'publish',
      'comment',
      'comment',
      'digg',
    ])
    assert.equal(douyinPacingKind('anything_else'), 'publish')
    const now = 1_760_000_000_000
    for (const [r, factor] of [
      [0, 0.7],
      [1, 1.3],
    ] as const) {
      const redis = fakeRedis()
      const until = await recordDouyinWriteDispatch({
        redis,
        connectionId: 'c1',
        actionId: 'reply_comment',
        now,
        random: () => r,
      })
      assert.equal(until, now + Math.round(DOUYIN_WRITE_PACING_MS.comment * factor))
      await assert.rejects(
        assertDouyinWriteAllowed({
          redis,
          connectionId: 'c1',
          actionId: 'create_comment',
          now: now + 1,
        }),
        (error: unknown) =>
          error instanceof DouyinWriteGuardError &&
          error.code === 'DOUYIN_PACING_WAIT' &&
          error.notBefore === until,
      )
      // 不同类别互不影响；同账号到点之后放行。
      await assertDouyinWriteAllowed({
        redis,
        connectionId: 'c1',
        actionId: 'set_comment_digg',
        now: now + 1,
      })
      await assertDouyinWriteAllowed({
        redis,
        connectionId: 'c1',
        actionId: 'reply_comment',
        now: until,
      })
      await assertDouyinWriteAllowed({
        redis,
        connectionId: 'c2',
        actionId: 'reply_comment',
        now: now + 1,
      })
    }
  })

  test('recording never moves the next allowed time earlier', async () => {
    const redis = fakeRedis()
    const now = 1_760_000_000_000
    const late = await recordDouyinWriteDispatch({
      redis,
      connectionId: 'c',
      actionId: 'publish_video',
      now,
      random: () => 1,
    })
    await recordDouyinWriteDispatch({
      redis,
      connectionId: 'c',
      actionId: 'publish_images',
      now: now + 1,
      random: () => 0,
    })
    assert.deepEqual(
      await readDouyinWriteGate({
        redis,
        connectionId: 'c',
        actionId: 'publish_video',
        now: now + 2,
      }),
      {
        notBefore: late,
        cooldownUntil: null,
      },
    )
  })

  test('cooldown: 24 h for every write of the account, checked before pacing', async () => {
    const redis = fakeRedis()
    const now = 1_760_000_000_000
    const until = await tripDouyinWriteCooldown({ redis, connectionId: 'c', now })
    assert.equal(until, now + DOUYIN_WRITE_COOLDOWN_MS)
    await recordDouyinWriteDispatch({ redis, connectionId: 'c', actionId: 'set_comment_digg', now })
    for (const id of WRITE_IDS)
      await assert.rejects(
        assertDouyinWriteAllowed({ redis, connectionId: 'c', actionId: id, now: now + 1 }),
        (error: unknown) =>
          error instanceof DouyinWriteGuardError && error.code === 'DOUYIN_WRITE_COOLDOWN',
      )
    await assertDouyinWriteAllowed({
      redis,
      connectionId: 'c',
      actionId: 'set_comment_digg',
      now: until,
    })
  })

  test('Redis missing, failing or answering garbage fails closed', async () => {
    const input = { connectionId: 'c', actionId: 'create_comment', now: 1 }
    for (const redis of [
      null,
      undefined,
      fakeRedis({ fail: true }),
      fakeRedis({ reply: 'x' }),
      fakeRedis({ reply: ['abc', ''] }),
    ]) {
      await assert.rejects(
        assertDouyinWriteAllowed({ ...input, redis }),
        (error: unknown) =>
          error instanceof DouyinWriteGuardError && error.code === 'RUNTIME_UNAVAILABLE',
      )
    }
    for (const redis of [null, fakeRedis({ fail: true }), fakeRedis({ reply: 'OK' })]) {
      await assert.rejects(recordDouyinWriteDispatch({ ...input, redis }), /RUNTIME_UNAVAILABLE/)
      await assert.rejects(tripDouyinWriteCooldown({ ...input, redis }), /RUNTIME_UNAVAILABLE/)
    }
  })

  test('Beijing clock for the confirmation card', () => {
    assert.equal(beijingClock(Date.UTC(2026, 9, 22, 1, 5)), '09:05')
    assert.equal(beijingClock(Date.UTC(2026, 9, 22, 16, 30)), '00:30')
  })
})

describe('douyin write confirmation card and error codes', () => {
  test('summaries name the action, target and full text, and always carry the risk line', () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      [
        'publish_video',
        { caption: '#春天 你好', title: '标题', visibility: 'friends', mediaManifest: [{}] },
        /发布视频，好友可见，标题「标题」：「#春天 你好」/,
      ],
      [
        'publish_images',
        { caption: 'x', mediaManifest: [{}, {}] },
        /发布图文（2 张图片），公开：「x」/,
      ],
      ['create_comment', { awemeId: '7', text: '评论' }, /作品 7 下评论：「评论」/],
      ['reply_comment', { awemeId: '7', cid: '9', text: '回复' }, /评论 9：「回复」/],
      ['set_comment_digg', { awemeId: '7', cid: '9', digg: false }, /评论 9 设置为未点赞/],
    ]
    for (const [id, params, re] of cases) {
      const summary = buildWriteSummary('douyin', id, params, '测试号')
      assert.match(summary, re, id)
      assert.match(summary, /用抖音\(测试号\)/)
      assert.match(summary, /可能触发抖音风控，严重时限制或封禁账号/)
    }
    const detail = buildWriteDetail('douyin', 'publish_video', {
      caption: 'c',
      mediaManifest: [
        {
          filename: 'a.mp4',
          sizeBytes: 3,
          sha256: 'abcdef0123456789',
          path: 'uploads/a.mp4',
          inputId: 'x',
        },
      ],
    })
    assert.deepEqual(detail.media, [{ filename: 'a.mp4', sizeBytes: 3, sha256Prefix: 'abcdef01' }])
    assert.equal(detail.kind, 'douyin_video')
  })

  test('new codes pass through with "not sent" guidance; unknown writes point at my_videos / video_comments', () => {
    for (const code of [
      'DOUYIN_PACING_WAIT',
      'DOUYIN_WRITE_COOLDOWN',
      'DOUYIN_WRITE_UNVERIFIED',
      'DOUYIN_MEDIA_INVALID',
    ]) {
      assert.ok(isPluginPassthroughErrorCode(code), code)
      const g = resolvePluginErrorGuidance({ code, provider: 'douyin', status: 'failed' })
      assert.equal(g.sideEffect, 'none', code)
      assert.match(g.nextAction, /本次未发送/, code)
    }
    assert.match(
      resolvePluginErrorGuidance({ code: 'DOUYIN_PACING_WAIT', provider: 'douyin' }).nextAction,
      /不要 sleep 后循环重试/,
    )
    for (const code of ['DOUYIN_WORKER_DEADLINE', 'TIMEOUT', 'LOGIN_EXPIRED_ACCOUNT']) {
      const g = resolvePluginErrorGuidance({ code, provider: 'douyin', status: 'unknown' })
      assert.equal(g.retrySafe, 'check_first', code)
      assert.ok(g.nextAction.endsWith(DOUYIN_UNKNOWN_WRITE_NEXT_ACTION), code)
    }
    // 其它插件的结果不明文案不变。
    assert.doesNotMatch(
      resolvePluginErrorGuidance({ code: 'TIMEOUT', provider: 'weibo', status: 'unknown' })
        .nextAction,
      /my_videos/,
    )
    assert.equal(mapDouyinWorkerProtocolFailure('WRITE_UNVERIFIED'), 'DOUYIN_WRITE_UNVERIFIED')
    assert.equal(mapDouyinWorkerProtocolFailure('MEDIA_INVALID'), 'DOUYIN_MEDIA_INVALID')
    assert.equal(new DouyinRuntimeError('PRECONDITION_CHANGED').dispatchProvenNotStarted, true)
    assert.equal(new DouyinRuntimeError('DOUYIN_WRITE_UNVERIFIED').dispatchProvenNotStarted, false)
  })
})

describe('douyin host frame order (dispatch fence)', () => {
  const ok = (kind: 'action' | 'login', frames: string[], writeCall: boolean) => {
    frames.forEach((event, index) =>
      assertDouyinWorkerEventOrder({ kind, prior: frames.slice(0, index), event, writeCall }),
    )
  }
  const bad = (kind: 'action' | 'login', frames: string[], writeCall: boolean) =>
    assert.throws(() => ok(kind, frames, writeCall), /PROTOCOL|Douyin|worker/, frames.join(','))

  test('write calls: prepared once, then completed; or not_dispatched / failed before prepared', () => {
    ok('action', ['ready', 'prepared', 'completed'], true)
    ok('action', ['ready', 'not_dispatched'], true)
    ok('action', ['ready', 'failed'], true)
    ok('action', ['ready', 'prepared', 'failed'], true)
    bad('action', ['ready', 'completed'], true)
    bad('action', ['ready', 'prepared', 'prepared'], true)
    bad('action', ['ready', 'not_dispatched', 'completed'], true)
  })

  test('reads and logins never carry write-fence frames', () => {
    ok('action', ['ready', 'completed'], false)
    bad('action', ['ready', 'prepared', 'completed'], false)
    bad('action', ['ready', 'not_dispatched'], false)
    bad('login', ['ready', 'prepared'], false)
    bad('login', ['ready', 'not_dispatched'], false)
    bad('action', ['ready', 'qr'], true)
    bad('action', ['completed'], false)
    bad('action', ['ready', 'ready'], false)
  })
})

describe('douyin worker write flow (compiled from the pinned source)', () => {
  test('target digests match the master snapshot digests byte for byte', () => {
    const { worker } = writeHarness()
    const video = { kind: 'video' as const, awemeId: '7', createTime: 1 }
    const comment = {
      kind: 'comment' as const,
      awemeId: '7',
      cid: '9',
      text: '好',
      createTime: null,
    }
    assert.equal(worker.douyinTargetDigest(video), douyinTargetDigest(video))
    assert.equal(worker.douyinTargetDigest(comment), douyinTargetDigest(comment))
    assert.notEqual(douyinTargetDigest(video), douyinTargetDigest({ ...video, createTime: 2 }))
  })

  test('no upstream write is wired: a matching target stops before `prepared` with WRITE_UNVERIFIED', async () => {
    const { worker, frames } = writeHarness()
    assert.deepEqual(Object.keys(worker.WRITE_DISPATCHERS), [])
    const videoDigest = douyinTargetDigest({
      kind: 'video',
      awemeId: VIDEO.aweme_id,
      createTime: VIDEO.create_time,
    })
    const seen: string[] = []
    const page = fakePage(
      {
        [USER_INFO]: USER_INFO_OK,
        [WORK_LIST]: { body: { status_code: 0, aweme_list: [VIDEO], has_more: false } },
      },
      seen,
    )
    await assert.rejects(
      worker.actionWrite(page, {
        actionId: 'create_comment',
        params: {
          awemeId: VIDEO.aweme_id,
          text: 'x',
          snapshot: { awemeId: VIDEO.aweme_id, digest: videoDigest },
        },
      }),
      /WRITE_UNVERIFIED/,
    )
    assert.deepEqual(frames, [])
    assert.ok(seen.every((url) => url.startsWith(SITE)))
    const commentDigest = douyinTargetDigest({
      kind: 'comment',
      awemeId: VIDEO.aweme_id,
      cid: COMMENT.cid,
      text: COMMENT.text,
      createTime: COMMENT.create_time,
    })
    for (const actionId of ['reply_comment', 'set_comment_digg'])
      await assert.rejects(
        worker.actionWrite(
          fakePage({
            [USER_INFO]: USER_INFO_OK,
            [COMMENT_LIST]: { body: { status_code: 0, comments: [COMMENT], has_more: 0 } },
          }),
          {
            actionId,
            params: {
              awemeId: VIDEO.aweme_id,
              cid: COMMENT.cid,
              text: 'x',
              digg: true,
              snapshot: { awemeId: VIDEO.aweme_id, cid: COMMENT.cid, digest: commentDigest },
            },
          },
        ),
        /WRITE_UNVERIFIED/,
        actionId,
      )
    assert.deepEqual(frames, [])
  })

  test('a changed or vanished target ends with not_dispatched (proven not sent)', async () => {
    const commentDigest = douyinTargetDigest({
      kind: 'comment',
      awemeId: VIDEO.aweme_id,
      cid: COMMENT.cid,
      text: COMMENT.text,
      createTime: COMMENT.create_time,
    })
    for (const comments of [[{ ...COMMENT, text: '改过' }], [], null]) {
      const { worker, frames, terminals } = writeHarness()
      await assert.rejects(
        worker.actionWrite(
          fakePage({
            [USER_INFO]: USER_INFO_OK,
            [COMMENT_LIST]: { body: { status_code: 0, comments, has_more: 0 } },
          }),
          {
            actionId: 'reply_comment',
            params: {
              awemeId: VIDEO.aweme_id,
              cid: COMMENT.cid,
              text: 'x',
              snapshot: { awemeId: VIDEO.aweme_id, cid: COMMENT.cid, digest: commentDigest },
            },
          },
        ),
        /EXITED/,
      )
      assert.deepEqual(terminals, [{ event: 'not_dispatched', code: 'PRECONDITION_CHANGED' }])
      assert.deepEqual(frames, [])
    }
  })

  test('a snapshot that does not belong to the params, or a logged-out session, never reaches the fence', async () => {
    const { worker, terminals } = writeHarness()
    await assert.rejects(
      worker.actionWrite(fakePage({ [USER_INFO]: USER_INFO_OK }), {
        actionId: 'reply_comment',
        params: {
          awemeId: '1',
          cid: '2',
          text: 'x',
          snapshot: { awemeId: '1', cid: '3', digest: 'a'.repeat(64) },
        },
      }),
      /WORKER_FAILED/,
    )
    await assert.rejects(
      worker.actionWrite(fakePage({ [USER_INFO]: { body: { status_code: 8 } } }), {
        actionId: 'create_comment',
        params: { awemeId: '1', text: 'x', snapshot: { awemeId: '1', digest: 'a'.repeat(64) } },
      }),
      /LOGIN_EXPIRED/,
    )
    assert.deepEqual(terminals, [])
  })

  test('staged media is checked (size, sha256, magic) before the fence', async () => {
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypisom'),
      Buffer.alloc(20, 1),
    ])
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(8, 2)])
    const notMp4 = Buffer.alloc(32, 3)
    const files = { v1: mp4, p1: png, x1: notMp4 }
    const item = (inputId: string, bytes: Buffer, kind: 'file' | 'image', mimeType: string) => ({
      path: 'uploads/f',
      inputId,
      filename: 'f',
      sizeBytes: bytes.length,
      sha256: sha(bytes),
      mimeType,
      kind,
    })
    const run = (actionId: string, manifest: unknown) =>
      writeHarness(files).worker.actionWrite(fakePage({ [USER_INFO]: USER_INFO_OK }), {
        actionId,
        params: { mediaManifest: manifest },
      })
    await assert.rejects(
      run('publish_video', [item('v1', mp4, 'file', 'video/mp4')]),
      /WRITE_UNVERIFIED/,
    )
    await assert.rejects(
      run('publish_images', [item('p1', png, 'image', 'image/png')]),
      /WRITE_UNVERIFIED/,
    )
    for (const [actionId, manifest] of [
      ['publish_video', [{ ...item('v1', mp4, 'file', 'video/mp4'), sha256: 'b'.repeat(64) }]],
      ['publish_video', [{ ...item('v1', mp4, 'file', 'video/mp4'), sizeBytes: mp4.length + 1 }]],
      ['publish_video', [item('x1', notMp4, 'file', 'video/mp4')]],
      ['publish_video', [item('missing', mp4, 'file', 'video/mp4')]],
      ['publish_video', [item('v1', mp4, 'image', 'video/mp4')]],
      ['publish_video', []],
      ['publish_images', [item('p1', png, 'image', 'image/jpeg')]],
      ['publish_images', [item('v1', mp4, 'file', 'video/mp4')]],
    ] as const)
      await assert.rejects(run(actionId, manifest), /MEDIA_INVALID/, JSON.stringify(manifest))
  })

  test('source: writes are dispatched only through awaitDispatch, and only after the checks', () => {
    const src = DOUYIN_WORKER_SOURCE
    const body = src.slice(
      src.indexOf('async function actionWrite'),
      src.indexOf('async function finishAction'),
    )
    const order = [
      'readSelf(page)',
      'verifyStagedMedia',
      'currentTargetDigest',
      "throw new Error('WRITE_UNVERIFIED')",
      'await awaitDispatch()',
      'dispatcher(page, params)',
    ]
    let at = -1
    for (const marker of order) {
      const next = body.indexOf(marker)
      assert.ok(next > at, marker)
      at = next
    }
    assert.equal(src.match(/writeFrame\(\{ event: 'prepared' \}\)/g)?.length, 1)
  })
})

describe('douyin server-side write snapshots (PluginRuntimeFacade.prepareDouyinWriteParams)', () => {
  type Prepare = (input: {
    userId: number
    targetId: string
    actionId: string
    params: Record<string, unknown>
  }) => Promise<Record<string, unknown>>
  function facadeWith(reads: Record<string, unknown[]>, media?: unknown) {
    const calls: Array<{ actionId: string; params: Record<string, unknown> }> = []
    const facade = Object.create(PluginRuntimeFacade.prototype) as Record<string, unknown>
    facade.opts = { knowledgePlanetMedia: media }
    facade.call = async (input: { actionId: string; params: Record<string, unknown> }) => {
      calls.push({ actionId: input.actionId, params: input.params })
      const queue = reads[input.actionId]
      assert.ok(queue && queue.length > 0, `unexpected read ${input.actionId}`)
      return queue.shift()
    }
    const prepare = (facade.prepareDouyinWriteParams as Prepare).bind(facade)
    return { prepare, calls }
  }
  const base = { userId: 247, targetId: '00000000-0000-0000-0000-000000000001' }

  test('the agent cannot supply snapshot or mediaManifest', async () => {
    const { prepare } = facadeWith({})
    for (const extra of [{ snapshot: {} }, { mediaManifest: [] }])
      await assert.rejects(
        prepare({
          ...base,
          actionId: 'create_comment',
          params: { awemeId: '1', text: 'x', ...extra },
        }),
        /server-owned/,
      )
  })

  test('create_comment snapshots an own work found within 3 pages; not found → BAD_REQUEST', async () => {
    const page = (items: unknown[], hasMore: boolean, cursor?: number) => ({
      items,
      hasMore,
      ...(cursor ? { cursor } : {}),
    })
    const { prepare, calls } = facadeWith({
      my_videos: [
        page([{ awemeId: '5' }], true, 100),
        page([{ awemeId: '7', createTime: 9 }], false),
      ],
    })
    const out = await prepare({
      ...base,
      actionId: 'create_comment',
      params: { awemeId: '7', text: 'x' },
    })
    assert.deepEqual(out.snapshot, {
      awemeId: '7',
      digest: douyinTargetDigest({ kind: 'video', awemeId: '7', createTime: 9 }),
    })
    assert.deepEqual(
      calls.map((c) => c.params),
      [{ count: 20 }, { count: 20, cursor: 100 }],
    )
    const missing = facadeWith({
      my_videos: [page([], true, 1), page([], true, 2), page([], true, 3)],
    })
    await assert.rejects(
      missing.prepare({ ...base, actionId: 'create_comment', params: { awemeId: '7', text: 'x' } }),
      /own-video snapshot is unavailable/,
    )
    assert.equal(missing.calls.length, 3)
  })

  test('reply / digg snapshot the comment text from video_comments of that work', async () => {
    const { prepare } = facadeWith({
      video_comments: [
        { awemeId: '7', items: [{ cid: '9', text: '原文', createTime: 3 }], hasMore: false },
      ],
    })
    const out = await prepare({
      ...base,
      actionId: 'set_comment_digg',
      params: { awemeId: '7', cid: '9', digg: true },
    })
    assert.deepEqual(out.snapshot, {
      awemeId: '7',
      cid: '9',
      digest: douyinTargetDigest({
        kind: 'comment',
        awemeId: '7',
        cid: '9',
        text: '原文',
        createTime: 3,
      }),
    })
    const other = facadeWith({
      video_comments: [{ awemeId: '8', items: [{ cid: '9', text: 'x' }], hasMore: false }],
    })
    await assert.rejects(
      other.prepare({
        ...base,
        actionId: 'reply_comment',
        params: { awemeId: '7', cid: '9', text: 'x' },
      }),
      /comment snapshot is unavailable/,
    )
  })

  test('publish needs the media runtime; without it nothing is sealed', async () => {
    const { prepare, calls } = facadeWith({})
    await assert.rejects(
      prepare({ ...base, actionId: 'publish_video', params: { video: 'uploads/a.mp4' } }),
      /media is unavailable/,
    )
    assert.equal(calls.length, 0)
  })
})
