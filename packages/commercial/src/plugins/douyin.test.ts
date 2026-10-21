/**
 * OCV5-553 · official Douyin Plugin (managed-browser), QR login + read-only `me`. No Docker, no
 * network: contract pins / schemas, account-state limits, worker source branches (compiled from the
 * pinned source with a fake page), login stop rules, frame protocol, failure-code mapping, log
 * sanitising, seed CLI parsing.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  douyinSmokeActionIds,
  parseDouyinSeedCliArgs,
  requireCleanLogin,
} from '../marketplace/seedDouyinPlugin.js'
import { validateRuntimePluginJson } from './contracts.js'
import {
  COMPILED_DOUYIN_PLUGIN,
  DOUYIN_BROKER_ROOT,
  DOUYIN_LOGIN_ORIGINS,
  DOUYIN_PLUGIN_CONTRACT,
  DOUYIN_PLUGIN_SLUG,
  DOUYIN_PLUGIN_VERSION,
  DOUYIN_SEED_BROKER_ROOT,
  classifyDouyinSetupPin,
  decodeDouyinWorkerFramesForTest,
  isOfficialDouyinPluginIdentity,
  resolveDouyinWorkerResources,
  validateDouyinState,
} from './douyin.js'
import {
  DEFAULT_DOUYIN_WORKER_LOG_DIR,
  DOUYIN_FAILURE_CODES,
  DOUYIN_WORKER_PROTOCOL_FAILURE_CODES,
  mapDouyinWorkerProtocolFailure,
  sanitizeDouyinWorkerLogLine,
} from './douyinObservability.js'
import { DOUYIN_WORKER_SOURCE } from './douyinWorkerSource.js'
import { isPluginPassthroughErrorCode, resolvePluginErrorGuidance } from './pluginErrorGuidance.js'

function framed(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

const READY = { event: 'ready', runtime: 'douyin-worker-v1', playwrightMcpVersion: '0.0.76' }
const SITE = 'https://creator.douyin.com'
const USER_INFO = `${SITE}/web/api/media/user/info/`
const ACCOUNT_INFO = `${SITE}/passport/web/account/info/`
/** Constants the sliced worker functions read, taken from the shipped source (not re-typed). */
function sourceConsts(...names: string[]): string {
  return names
    .map((name) => {
      const line = new RegExp(`^const ${name} = .*;$`, 'm').exec(DOUYIN_WORKER_SOURCE)?.[0]
      assert.ok(line, name)
      return line
    })
    .join('\n')
}

/** Compile the worker's pure helpers + actionRead from the pinned source (same code that ships). */
function workerHarness() {
  const src = DOUYIN_WORKER_SOURCE
  const start = src.indexOf('function filteredState')
  const end = src.indexOf('async function finishAction')
  assert.ok(start > 0 && end > start)
  return new Function(
    `'use strict';
     ${sourceConsts('MAX_API_TEXT', 'SITE', 'USER_INFO_URL', 'ACCOUNT_INFO_URL')}
     const createHash = () => ({ update() { return { digest() { return 'x' } } } });
     ${src.slice(start, end)}
     return { filteredState, actionRead };`,
  )() as {
    filteredState(
      state: unknown,
      domains: string[],
      origins: string[],
    ): { cookies: Array<{ name: string; domain: string }>; origins: unknown[] }
    actionRead(
      page: unknown,
      input: { actionId: string; params?: Record<string, unknown> },
    ): Promise<unknown>
  }
}

/** Fake Playwright page: `evaluate(fn, { url })` answers from a URL → response table. */
/** Fake Playwright page: answers by URL (exact, or by path when the table key has no query); records pauses. */
function fakePage(
  table: Record<string, { status?: number; body: unknown }>,
  seen: string[] = [],
  pauses: number[] = [],
) {
  return {
    async evaluate(_fn: unknown, input: { url: string; max: number }) {
      seen.push(input.url)
      const hit = table[input.url] ?? table[input.url.split('?')[0]!]
      if (!hit) return { status: 404, text: '', tooLarge: false }
      return { status: hit.status ?? 200, text: JSON.stringify(hit.body), tooLarge: false }
    },
    async waitForTimeout(ms: number) {
      pauses.push(ms)
    },
  }
}

// 未登录时的真实应答（2026-10-21 未登录侦察 g553-recon-identity-unauth.json）。
const USER_INFO_LOGGED_OUT = { body: { status_code: 8, status_msg: '用户未登录', extra: {} } }
const ACCOUNT_INFO_LOGGED_OUT = {
  body: {
    message: 'error',
    data: { captcha: '', desc_url: '', description: '会话过期，请重新登录', error_code: 1 },
  },
}
// 登录后的应答形状尚未实测（要等测试号）；这里按创作者平台用户对象的常见字段构造。
const USER_INFO_OK = {
  body: {
    status_code: 0,
    user: {
      uid: '1234567890',
      sec_uid: 'MS4wLjABAAAA_test-Sec_uid',
      nickname: ' 测试\n账号 ',
      follower_count: 12,
      following_count: 3,
      aweme_count: 5,
      total_favorited: 99,
      avatar_thumb: { url_list: ['https://p3.douyinpic.com/a.jpeg'] },
    },
  },
}

describe('official Douyin Plugin', () => {
  test('pins the current artifact; only the exact pin is setup-compatible', () => {
    assert.equal(DOUYIN_PLUGIN_SLUG, 'douyin')
    assert.equal(DOUYIN_PLUGIN_VERSION, '1.0.0')
    assert.equal(COMPILED_DOUYIN_PLUGIN.pluginType, 'managed-browser')
    assert.match(COMPILED_DOUYIN_PLUGIN.artifactHash, /^[0-9a-f]{64}$/)
    const exact = {
      version: DOUYIN_PLUGIN_VERSION,
      artifactHash: COMPILED_DOUYIN_PLUGIN.artifactHash,
      execContractHash: COMPILED_DOUYIN_PLUGIN.execContractHash,
    }
    assert.equal(classifyDouyinSetupPin(exact), 'current')
    assert.equal(classifyDouyinSetupPin({ ...exact, artifactHash: '0'.repeat(64) }), null)
    const identity = {
      slug: DOUYIN_PLUGIN_SLUG,
      pluginType: 'managed-browser',
      artifactHash: exact.artifactHash,
      execContractHash: exact.execContractHash,
    }
    assert.equal(isOfficialDouyinPluginIdentity({ ...identity, reviewSource: 'platform' }), true)
    assert.equal(isOfficialDouyinPluginIdentity({ ...identity, reviewSource: 'human' }), false)
  })

  test('this version is read-only: me / my_videos / video_comments, network methods are GET only', () => {
    assert.ok(DOUYIN_PLUGIN_CONTRACT.actions.every((action) => action.effect === 'read'))
    assert.deepEqual([...DOUYIN_PLUGIN_CONTRACT.runtime.network.methods], ['GET'])
    assert.deepEqual(douyinSmokeActionIds(), ['me', 'my_videos', 'video_comments'])
  })

  test('my_videos / video_comments schemas accept documented results and reject extras / bad ids (PR3)', () => {
    const action = (id: string) => DOUYIN_PLUGIN_CONTRACT.actions.find((a) => a.id === id)!
    const videos = action('my_videos')
    assert.doesNotThrow(() =>
      validateRuntimePluginJson(videos.params, { count: 5, cursor: 1_760_000_000_000 }, 'params'),
    )
    assert.doesNotThrow(() => validateRuntimePluginJson(videos.params, {}, 'params'))
    for (const bad of [{ count: 0 }, { count: 21 }, { cursor: -1 }, { extra: 1 }])
      assert.throws(
        () => validateRuntimePluginJson(videos.params, bad, 'params'),
        JSON.stringify(bad),
      )
    const item = {
      awemeId: '7400000000000000001',
      url: 'https://www.douyin.com/video/7400000000000000001',
      playCount: 3,
      isPrivate: false,
    }
    assert.doesNotThrow(() =>
      validateRuntimePluginJson(
        videos.result,
        { items: [item], hasMore: false, cursor: 1, total: 1 },
        'result',
      ),
    )
    for (const bad of [{ ...item, awemeId: '74a' }, { ...item, extra: 1 }, { awemeId: '1' }])
      assert.throws(
        () => validateRuntimePluginJson(videos.result, { items: [bad], hasMore: false }, 'result'),
        JSON.stringify(bad),
      )
    const comments = action('video_comments')
    assert.doesNotThrow(() =>
      validateRuntimePluginJson(
        comments.params,
        { awemeId: '7400000000000000001', count: 10 },
        'params',
      ),
    )
    for (const bad of [{}, { awemeId: '../x' }, { awemeId: '1', extra: 1 }])
      assert.throws(
        () => validateRuntimePluginJson(comments.params, bad, 'params'),
        JSON.stringify(bad),
      )
    assert.doesNotThrow(() =>
      validateRuntimePluginJson(
        comments.result,
        { awemeId: '1', items: [{ cid: '9', text: '好', diggCount: 1 }], hasMore: true },
        'result',
      ),
    )
    assert.throws(() =>
      validateRuntimePluginJson(
        comments.result,
        { awemeId: '1', items: [{ cid: 'x', text: 't' }], hasMore: false },
        'result',
      ),
    )
  })

  test('state and network stay on douyin.com; telemetry is not allowed at login; only Secure cookies', () => {
    assert.deepEqual([...DOUYIN_PLUGIN_CONTRACT.runtime.network.origins], [`${SITE}:443`])
    assert.deepEqual(
      [...DOUYIN_PLUGIN_CONTRACT.runtime.accountState.cookieDomains],
      ['creator.douyin.com', 'douyin.com'],
    )
    assert.ok(DOUYIN_LOGIN_ORIGINS.includes(`${SITE}:443`))
    assert.ok(DOUYIN_LOGIN_ORIGINS.length <= 16)
    // 侦察时被拦也能出二维码的监控 / 上报来源，不能出现在登录白名单里。
    for (const host of [
      'mon.zijieapi.com',
      'mcs.snssdk.com',
      'security.zijieapi.com',
      'vcs.zijieapi.com',
      'lf3-short.ibytedapm.com',
      'abtestvm.bytedance.com',
      'www.douyin.com',
    ])
      assert.ok(!DOUYIN_LOGIN_ORIGINS.some((origin) => origin.includes(`//${host}:`)), host)
    assert.ok(DOUYIN_LOGIN_ORIGINS.every((origin) => /^https:\/\/[a-z0-9.-]+:443$/.test(origin)))
    const cookie = {
      name: 'sessionid_ss',
      value: 'secret',
      domain: '.douyin.com',
      path: '/',
      expires: -1,
      httpOnly: true,
      sameSite: 'None' as const,
    }
    assert.equal(
      validateDouyinState({ cookies: [{ ...cookie, secure: true }], origins: [] }).cookies[0]?.name,
      'sessionid_ss',
    )
    assert.throws(() =>
      validateDouyinState({ cookies: [{ ...cookie, secure: false }], origins: [] }),
    )
    assert.throws(() =>
      validateDouyinState({
        cookies: [{ ...cookie, secure: true, domain: '.example.com' }],
        origins: [],
      }),
    )
  })

  test('the `me` schema accepts the documented result and rejects extras / bad ids', () => {
    const me = DOUYIN_PLUGIN_CONTRACT.actions.find((action) => action.id === 'me')!
    assert.doesNotThrow(() => validateRuntimePluginJson(me.params, {}, 'params'))
    assert.throws(() => validateRuntimePluginJson(me.params, { extra: 1 }, 'params'))
    const ok = { nickname: 'n', uid: '123', secUid: 'MS4w_a-b', followerCount: 1 }
    assert.doesNotThrow(() => validateRuntimePluginJson(me.result, ok, 'result'))
    assert.doesNotThrow(() => validateRuntimePluginJson(me.result, { nickname: 'n' }, 'result'))
    for (const bad of [
      { ...ok, extra: 1 },
      { ...ok, uid: '12a' },
      { ...ok, secUid: '' },
      { uid: '1' },
    ])
      assert.throws(() => validateRuntimePluginJson(me.result, bad, 'result'), JSON.stringify(bad))
  })

  test('worker source: a branch per action, same-origin in-page GETs only, no Node request client', () => {
    for (const action of DOUYIN_PLUGIN_CONTRACT.actions)
      assert.ok(DOUYIN_WORKER_SOURCE.includes(`input.actionId === '${action.id}'`), action.id)
    assert.match(DOUYIN_WORKER_SOURCE, /credentials: 'include'/)
    assert.doesNotMatch(DOUYIN_WORKER_SOURCE, /'omit'/)
    assert.match(DOUYIN_WORKER_SOURCE, /robots\.txt/)
    assert.doesNotMatch(
      DOUYIN_WORKER_SOURCE,
      /request\.newContext|APIRequestContext|playwright\.request/,
    )
    assert.doesNotMatch(DOUYIN_WORKER_SOURCE, /method: '(POST|PUT|DELETE)'/)
    // Actions run with GET only; the login page needs POST / HEAD for its own passport calls.
    assert.match(
      DOUYIN_WORKER_SOURCE,
      /secureContext\(browser, input\.storageState, ACTION_ORIGINS, \['GET'\]\)/,
    )
    assert.ok(!DOUYIN_WORKER_SOURCE.includes('${'), 'String.raw source must not interpolate')
    // 官方二维码元素（侦察实测）：aria-label="二维码"；码本身取自接口应答，元素只用来点中心刷新。
    assert.match(DOUYIN_WORKER_SOURCE, /const QR_SELECTOR = 'img\[aria-label="二维码"\]';/)
    // 唯一的填写是把用户本人提交的短信验证码填进「请输入验证码」；唯一的鼠标操作是点二维码中心。
    // 没有键盘模拟、拖动（滑块）或逐字输入：系统不碰任何图形验证码。
    assert.equal((DOUYIN_WORKER_SOURCE.match(/\.fill\(/g) ?? []).length, 3)
    assert.match(
      DOUYIN_WORKER_SOURCE,
      /const input = login\.getByPlaceholder\('请输入验证码'\)\.last\(\);/,
    )
    assert.equal((DOUYIN_WORKER_SOURCE.match(/input\.fill\(/g) ?? []).length, 2)
    assert.deepEqual(DOUYIN_WORKER_SOURCE.match(/mouse\.[a-zA-Z]+\(/g), ['mouse.click('])
    assert.doesNotMatch(DOUYIN_WORKER_SOURCE, /\.type\(|keyboard\.|dragTo|\.press\(/)
    // 无头：有头才有的「Open xdg-open?」原生对话框不会出现；JS 对话框一律关掉（4.3.C）。
    assert.doesNotMatch(DOUYIN_WORKER_SOURCE, /headless: false/)
    assert.equal((DOUYIN_WORKER_SOURCE.match(/headless: true/g) ?? []).length, 2)
    assert.match(DOUYIN_WORKER_SOURCE, /page\.on\('dialog', \(dialog\) => \{ dialog\.dismiss\(\)/)
    // 被拦下的来源只记域名。
    assert.match(DOUYIN_WORKER_SOURCE, /emitStep\(\{ step: 'net\.blocked', host \}\)/)
    // 验证码用完即丢：worker 填完就清掉引用，命令帧缓冲区读完清零。
    assert.match(DOUYIN_WORKER_SOURCE, /command\.code = '';/)
    assert.match(DOUYIN_WORKER_SOURCE, /body\.fill\(0\);/)
  })
})

describe('douyin worker behaviour (compiled from the pinned source)', () => {
  const worker = workerHarness()

  test('filteredState keeps only Secure cookies of the signed domains', () => {
    const c = (name: string, domain: string, secure = true) => ({
      name,
      value: 'v',
      domain,
      path: '/',
      expires: -1,
      httpOnly: true,
      secure,
      sameSite: 'Lax',
    })
    const state = worker.filteredState(
      {
        cookies: [
          c('sessionid_ss', '.douyin.com'),
          c('csrf_session_id', 'creator.douyin.com'),
          c('s_v_web_id', 'creator.douyin.com', false),
          c('ttwid', '.www.douyin.com'),
          c('x', '.evil.example'),
        ],
        origins: [],
      },
      ['douyin.com', 'creator.douyin.com'],
      ['https://creator.douyin.com:443'],
    )
    assert.deepEqual(
      state.cookies.map((row) => row.name),
      ['sessionid_ss', 'csrf_session_id'],
    )
  })

  test('me projects the documented fields from the creator user-info endpoint', async () => {
    const seen: string[] = []
    const out = await worker.actionRead(fakePage({ [USER_INFO]: USER_INFO_OK }, seen), {
      actionId: 'me',
    })
    assert.deepEqual(out, {
      nickname: '测试 账号',
      uid: '1234567890',
      secUid: 'MS4wLjABAAAA_test-Sec_uid',
      followerCount: 12,
      followingCount: 3,
      awemeCount: 5,
      totalFavorited: 99,
    })
    assert.deepEqual(seen, [USER_INFO])
    const me = DOUYIN_PLUGIN_CONTRACT.actions.find((action) => action.id === 'me')!
    assert.doesNotThrow(() => validateRuntimePluginJson(me.result, out, 'result'))
  })

  test('falls back to passport account info when user-info has no usable user', async () => {
    const page = fakePage({
      [USER_INFO]: { body: { status_code: 0, user: {} } },
      [ACCOUNT_INFO]: {
        body: {
          message: 'success',
          data: { user_id: 987, sec_user_id: 'MS4w_x', screen_name: '昵称' },
        },
      },
    })
    assert.deepEqual(await worker.actionRead(page, { actionId: 'me' }), {
      nickname: '昵称',
      uid: '987',
      secUid: 'MS4w_x',
    })
  })

  test('ids are only returned when they have the expected shape', async () => {
    const out = await worker.actionRead(
      fakePage({
        [USER_INFO]: {
          body: { status_code: 0, user: { uid: '12a', sec_uid: 'a/b', nickname: 'n' } },
        },
        [ACCOUNT_INFO]: { body: { message: 'success', data: { user_id: 5, screen_name: 'n' } } },
      }),
      { actionId: 'me' },
    )
    // user-info 的两个 id 都不合格 → 退到 passport；secUid 不合格的值绝不原样返回。
    assert.deepEqual(out, { nickname: 'n', uid: '5' })
  })

  test('my_videos projects the live-test work_list fields; foreign covers dropped; one paced request', async () => {
    const seen: string[] = []
    const pauses: number[] = []
    const page = fakePage(
      {
        [USER_INFO]: USER_INFO_OK,
        [`${SITE}/janus/douyin/creator/pc/work_list`]: {
          body: {
            status_code: 0,
            has_more: true,
            max_cursor: 1_760_000_000_000,
            total: 12,
            aweme_list: [
              {
                aweme_id: '7400000000000000001',
                item_title: ' 标题 ',
                desc: '描述 #话题',
                create_time: 1_760_000_000,
                duration: 15_400,
                Cover: {
                  url_list: ['https://p3-sign.douyinpic.com/obj/x.jpeg?x-expires=1&sign=abc'],
                },
                statistics: {
                  play_count: 100,
                  digg_count: 7,
                  comment_count: 2,
                  share_count: 1,
                  collect_count: 3,
                },
                status: { is_private: false, in_reviewing: true },
              },
              {
                aweme_id: '7400000000000000002',
                is_pic_word: true,
                Cover: { url_list: ['https://evil.example/x.jpeg'] },
                statistics: {},
              },
              { aweme_id: 'not-digits' },
            ],
          },
        },
      },
      seen,
      pauses,
    )
    const out = (await worker.actionRead(page, {
      actionId: 'my_videos',
      params: { count: 5, cursor: 0 },
    })) as {
      items: Array<Record<string, unknown>>
    }
    assert.deepEqual(out, {
      items: [
        {
          awemeId: '7400000000000000001',
          title: '标题',
          desc: '描述 #话题',
          createTime: 1_760_000_000,
          durationSec: 15,
          cover: 'https://p3-sign.douyinpic.com/obj/x.jpeg?x-expires=1&sign=abc',
          playCount: 100,
          diggCount: 7,
          commentCount: 2,
          shareCount: 1,
          collectCount: 3,
          isPrivate: false,
          inReview: true,
          url: 'https://www.douyin.com/video/7400000000000000001',
        },
        {
          awemeId: '7400000000000000002',
          isImagePost: true,
          url: 'https://www.douyin.com/note/7400000000000000002',
        },
      ],
      hasMore: true,
      cursor: 1_760_000_000_000,
      total: 12,
    })
    assert.equal(seen.length, 2)
    assert.match(seen[1]!, /work_list\?status=0&count=5&max_cursor=0$/)
    assert.equal(pauses.length, 1)
    assert.ok(pauses[0]! >= 1_500 && pauses[0]! < 4_000)
    const action = DOUYIN_PLUGIN_CONTRACT.actions.find((a) => a.id === 'my_videos')!
    assert.doesNotThrow(() => validateRuntimePluginJson(action.result, out, 'result'))
  })

  test('video_comments reads the creator comment list for one own work; unknown shapes fail closed', async () => {
    const seen: string[] = []
    const page = fakePage(
      {
        [USER_INFO]: USER_INFO_OK,
        [`${SITE}/aweme/v1/creator/comment/list/`]: {
          body: {
            status_code: 0,
            has_more: 1,
            cursor: 20,
            total: 31,
            comments: [
              {
                cid: '7400000000000000101',
                text: ' 好看\n',
                create_time: 1_760_000_100,
                digg_count: 4,
                reply_comment_total: 1,
                user: { nickname: '路人' },
              },
              { cid: 'bad', text: 'x' },
              { cid: '7400000000000000102', text: '' },
            ],
          },
        },
      },
      seen,
    )
    const out = await worker.actionRead(page, {
      actionId: 'video_comments',
      params: { awemeId: '7400000000000000001' },
    })
    assert.deepEqual(out, {
      awemeId: '7400000000000000001',
      items: [
        {
          cid: '7400000000000000101',
          text: '好看',
          nickname: '路人',
          createTime: 1_760_000_100,
          diggCount: 4,
          replyCount: 1,
        },
      ],
      hasMore: true,
      cursor: 20,
      total: 31,
    })
    assert.match(seen[1]!, /comment\/list\/\?item_id=7400000000000000001&cursor=0&count=10$/)
    const action = DOUYIN_PLUGIN_CONTRACT.actions.find((a) => a.id === 'video_comments')!
    assert.doesNotThrow(() => validateRuntimePluginJson(action.result, out, 'result'))
    // 没有评论时 comments 可能是 null。
    assert.deepEqual(
      await worker.actionRead(
        fakePage({
          [USER_INFO]: USER_INFO_OK,
          [`${SITE}/aweme/v1/creator/comment/list/`]: { body: { status_code: 0, comments: null } },
        }),
        { actionId: 'video_comments', params: { awemeId: '1' } },
      ),
      { awemeId: '1', items: [], hasMore: false },
    )
    // 认不出的形状、坏 id、未登录。
    for (const [body, re] of [
      [{ status_code: 0, data: { comments: [] } }, /WORKER_FAILED/],
      [{ status_code: 8 }, /LOGIN_EXPIRED/],
      [{ status_code: 5 }, /WORKER_FAILED/],
    ] as const)
      await assert.rejects(
        worker.actionRead(
          fakePage({
            [USER_INFO]: USER_INFO_OK,
            [`${SITE}/aweme/v1/creator/comment/list/`]: { body },
          }),
          {
            actionId: 'video_comments',
            params: { awemeId: '1' },
          },
        ),
        re,
        JSON.stringify(body),
      )
    await assert.rejects(
      worker.actionRead(fakePage({ [USER_INFO]: USER_INFO_OK }), {
        actionId: 'video_comments',
        params: { awemeId: 'x' },
      }),
      /WORKER_FAILED/,
    )
    await assert.rejects(
      worker.actionRead(
        fakePage({
          [USER_INFO]: USER_INFO_OK,
          [`${SITE}/janus/douyin/creator/pc/work_list`]: { body: { status_code: 8 } },
        }),
        { actionId: 'my_videos' },
      ),
      /LOGIN_EXPIRED/,
    )
  })

  test('account/info 1011 after login (2026-10-22 live test) is "endpoint unavailable", never LOGIN_EXPIRED', async () => {
    const page = fakePage({
      [USER_INFO]: { body: { status_code: 0, user: {} } },
      [ACCOUNT_INFO]: {
        body: {
          message: 'error',
          data: { captcha: '', description: '用户不存在', error_code: 1011 },
        },
      },
    })
    await assert.rejects(worker.actionRead(page, { actionId: 'me' }), /WORKER_FAILED/)
  })

  test('logged out (real unauthenticated answers) → LOGIN_EXPIRED; 403 / 429 / captcha → UPSTREAM_CHALLENGE; nothing retried', async () => {
    await assert.rejects(
      worker.actionRead(fakePage({ [USER_INFO]: USER_INFO_LOGGED_OUT }), { actionId: 'me' }),
      /LOGIN_EXPIRED/,
    )
    await assert.rejects(
      worker.actionRead(
        fakePage({
          [USER_INFO]: { body: { status_code: 2 } },
          [ACCOUNT_INFO]: ACCOUNT_INFO_LOGGED_OUT,
        }),
        { actionId: 'me' },
      ),
      /LOGIN_EXPIRED/,
    )
    for (const status of [403, 429]) {
      const seen: string[] = []
      await assert.rejects(
        worker.actionRead(fakePage({ [USER_INFO]: { status, body: {} } }, seen), {
          actionId: 'me',
        }),
        /UPSTREAM_CHALLENGE/,
      )
      assert.equal(seen.length, 1)
    }
    await assert.rejects(
      worker.actionRead(
        fakePage({
          [USER_INFO]: { body: { status_code: 2 } },
          [ACCOUNT_INFO]: { body: { message: 'error', data: { captcha: 'abc', error_code: 2 } } },
        }),
        { actionId: 'me' },
      ),
      /UPSTREAM_CHALLENGE/,
    )
    await assert.rejects(
      worker.actionRead(fakePage({ [USER_INFO]: USER_INFO_OK }), { actionId: 'other' }),
      /WORKER_FAILED/,
    )
  })
})

/** Compile proveSelf (login session proof) together with the helpers it uses, from the pinned source. */
function proveSelfHarness() {
  const src = DOUYIN_WORKER_SOURCE
  const helpers = src.slice(src.indexOf('function failureCode'), src.indexOf('function emitStep'))
  const reads = src.slice(
    src.indexOf('function cleanText'),
    src.indexOf('async function actionRead'),
  )
  const prove = src.slice(
    src.indexOf('async function proveSelf'),
    src.indexOf('async function failLogin'),
  )
  assert.ok(helpers.length > 0 && reads.length > 0 && prove.length > 0)
  return new Function(
    `'use strict';
     ${sourceConsts('MAX_API_TEXT', 'SITE', 'USER_INFO_URL', 'ACCOUNT_INFO_URL', 'FAILURE_CODES')}
     ${helpers}${reads}${prove}
     return { proveSelf };`,
  )() as { proveSelf(context: unknown): Promise<Record<string, unknown> | null> }
}

describe('douyin login proof', () => {
  const { proveSelf } = proveSelfHarness()
  const contextWith = (
    table: Record<string, { status?: number; body: unknown }>,
    seen: string[],
  ) => ({
    async newPage() {
      return { ...fakePage(table, seen), async goto() {}, async close() {} }
    },
  })

  test('risk control during the login proof stops the login instead of re-probing', async () => {
    for (const status of [403, 429]) {
      const seen: string[] = []
      await assert.rejects(
        proveSelf(contextWith({ [USER_INFO]: { status, body: {} } }, seen)),
        /UPSTREAM_CHALLENGE/,
      )
      assert.equal(seen.length, 1)
    }
  })

  test('not logged in yet → null (keep waiting for the scan); logged in → identity', async () => {
    assert.equal(await proveSelf(contextWith({ [USER_INFO]: USER_INFO_LOGGED_OUT }, [])), null)
    assert.equal(
      (await proveSelf(contextWith({ [USER_INFO]: USER_INFO_OK }, [])))?.uid,
      '1234567890',
    )
  })
})

function loginHarness() {
  const src = DOUYIN_WORKER_SOURCE
  const pick = (from: string, to: string) => {
    const body = src.slice(src.indexOf(from), src.indexOf(to))
    assert.ok(body.length > 0, from)
    return body
  }
  return new Function(
    `'use strict';
     ${sourceConsts('CHALLENGE_TEXT', 'QR_MIN_PUBLISH_MS', 'QR_STALL_MS')}
     ${pick('async function pageText', 'const commands = [];')}
     return { challengeCode, pageChallenge, isMfaResponse, newQrTracker, qrOnResponse, qrNeedsKick, validCommand, requestQrToken, smsResponse };`,
  )() as {
    challengeCode(text: string): string | null
    pageChallenge(context: unknown): Promise<string | null>
    isMfaResponse(data: unknown): boolean
    newQrTracker(): {
      pending: { png: string; expireAt: number; token: string } | null
      published: { png: string; expireAt: number; token: string } | null
      lastPollAt: number
      lastGetQrAt: number
      status: string | null
    }
    qrOnResponse(
      tracker: unknown,
      path: string,
      http: number,
      json: unknown,
      now: number,
      requestToken?: string | null,
    ): {
      publish: { png: string; expireAt: number; token: string } | null
      invalidate: boolean
      mfa: boolean
      status: string | null
    }
    qrNeedsKick(tracker: unknown, now: number, overlay: boolean): boolean
    validCommand(value: unknown): { cmd: string; code?: string }
    requestQrToken(url: string, postData: string | null): string | null
    smsResponse(http: number, json: unknown): { ok: boolean; challenge: boolean }
  }
}

/** Fake Playwright page for the stop rules: the body text only. */
function textPage(text: string, closed = false) {
  return { isClosed: () => closed, locator: () => ({ innerText: async () => text }) }
}

const PNG_B64 = `iVBORw0KGgo${'A'.repeat(200)}`
const POLL = '/passport/web/check_qrconnect/'
const GET_QR = '/passport/web/get_qrcode/'

describe('douyin login: visible captcha still stops; verification is the owner SMS flow', () => {
  const L = loginHarness()
  // 侦察时二维码页的文字里含「扫码登录 / 验证码登录 / 密码登录」，都不能被当成风控信号。
  const LOGIN_PAGE = '扫码登录 验证码登录 密码登录 打开抖音APP 扫一扫登录'

  test('captcha / slider on any open page → UPSTREAM_CHALLENGE; the plain login page and the SMS dialog are not', async () => {
    assert.equal(L.challengeCode(LOGIN_PAGE), null)
    assert.equal(L.challengeCode(`${LOGIN_PAGE} 身份验证 接收短信验证码 验证码已发送`), null)
    for (const text of ['请完成下列验证后继续', '拖动下方滑块完成拼图', '按住左边按钮拖动'])
      assert.equal(L.challengeCode(`${LOGIN_PAGE} ${text}`), 'UPSTREAM_CHALLENGE', text)
    assert.equal(
      await L.pageChallenge({
        pages: () => [textPage(LOGIN_PAGE), textPage('拖动下方滑块完成拼图')],
      }),
      'UPSTREAM_CHALLENGE',
    )
    assert.equal(await L.pageChallenge({ pages: () => [textPage('拖动下方滑块', true)] }), null)
  })

  test('the MFA answer of check_qrconnect (live-test shape) is recognised; ordinary answers are not', () => {
    assert.equal(
      L.isMfaResponse({
        account_flow: 'xxxxxx',
        biz_params: {
          passport_mfa_retry_tag: '1',
          std_verify_flow_id: 'x',
          std_verify_type: 'sms',
        },
        common_params: { std_verify_flow_id: 'x' },
        error_code: 0,
      }),
      true,
    )
    for (const data of [
      { status: 'new' },
      { status: 'scanned', biz_params: { std_verify_type: 'x' } },
      {},
      null,
    ])
      assert.equal(L.isMfaResponse(data), false, JSON.stringify(data))
  })

  test('a code is published only after the page polled THAT code (by token) and got `new` with ≥45s left (4.3.C, Codex r1 P1)', () => {
    const t = L.newQrTracker()
    const now = 1_000_000
    const qr = (token: string, expireAt: number) => ({
      data: { qrcode: PNG_B64, expire_time: expireAt / 1000, token },
    })
    const issued = L.qrOnResponse(t, GET_QR, 200, qr('tokA', now + 60_000), now)
    assert.equal(issued.publish, null)
    assert.equal(issued.invalidate, true)
    // 带着别的 token（或拿不到 token）的 new 不发布。
    assert.equal(
      L.qrOnResponse(t, POLL, 200, { data: { status: 'new' } }, now + 1_000, 'other').publish,
      null,
    )
    assert.equal(
      L.qrOnResponse(t, POLL, 200, { data: { status: 'new' } }, now + 1_200, null).publish,
      null,
    )
    const polled = L.qrOnResponse(t, POLL, 200, { data: { status: 'new' } }, now + 1_500, 'tokA')
    assert.deepEqual(polled.publish, { png: PNG_B64, expireAt: now + 60_000, token: 'tokA' })
    assert.equal(
      L.qrOnResponse(t, POLL, 200, { data: { status: 'new' } }, now + 3_000, 'tokA').publish,
      null,
    )
    // 新码 B 来了：A 立即作废；A 的迟到 new 不会让 B 被发布。
    const rotated = L.qrOnResponse(
      t,
      POLL,
      200,
      { data: { status: 'expired', ...qr('tokB', now + 120_000).data } },
      now + 60_500,
      'tokA',
    )
    assert.equal(rotated.invalidate, true)
    assert.equal(t.published, null)
    assert.equal(
      L.qrOnResponse(t, POLL, 200, { data: { status: 'new' } }, now + 60_700, 'tokA').publish,
      null,
    )
    assert.ok(
      L.qrOnResponse(t, POLL, 200, { data: { status: 'new' } }, now + 61_000, 'tokB').publish,
    )
    // 502：作废已发布的码；没有码时不必通知。
    assert.equal(L.qrOnResponse(t, POLL, 502, null, now + 62_000, 'tokB').invalidate, true)
    assert.equal(t.published, null)
    assert.equal(L.qrOnResponse(t, POLL, 502, null, now + 63_000, 'tokB').invalidate, false)
    // 剩余 <45 秒才被确认：不发布。
    const late = L.newQrTracker()
    L.qrOnResponse(late, GET_QR, 200, qr('tokC', now + 60_000), now)
    assert.equal(
      L.qrOnResponse(late, POLL, 200, { data: { status: 'new' } }, now + 20_000, 'tokC').publish,
      null,
    )
    // 没有 token 或不是 PNG base64 的码不发布。
    for (const data of [
      { qrcode: PNG_B64, expire_time: (now + 60_000) / 1000 },
      { qrcode: '<svg onload=1>'.repeat(20), expire_time: (now + 60_000) / 1000, token: 'tokD' },
    ]) {
      const bad = L.newQrTracker()
      L.qrOnResponse(bad, GET_QR, 200, { data }, now)
      assert.equal(
        L.qrOnResponse(bad, POLL, 200, { data: { status: 'new' } }, now + 1_000, 'tokD').publish,
        null,
      )
    }
  })

  test('the poll token is read from the query string or the form / JSON body', () => {
    assert.equal(
      L.requestQrToken(
        'https://creator.douyin.com/passport/web/check_qrconnect/?token=abc_1-2&x=1',
        null,
      ),
      'abc_1-2',
    )
    assert.equal(
      L.requestQrToken(
        'https://creator.douyin.com/passport/web/check_qrconnect/',
        'token=tok9&aid=1',
      ),
      'tok9',
    )
    assert.equal(
      L.requestQrToken(
        'https://creator.douyin.com/passport/web/check_qrconnect/',
        '{"token":"tokJ"}',
      ),
      'tokJ',
    )
    assert.equal(
      L.requestQrToken(
        'https://creator.douyin.com/passport/web/check_qrconnect/?token=a%20b',
        null,
      ),
      null,
    )
    assert.equal(
      L.requestQrToken('https://creator.douyin.com/passport/web/check_qrconnect/', null),
      null,
    )
  })

  test('send_code / validate_code: 403, 429 or a captcha is risk control; only `success` is ok', () => {
    assert.deepEqual(L.smsResponse(200, { message: 'success', data: {} }), {
      ok: true,
      challenge: false,
    })
    assert.deepEqual(L.smsResponse(200, { message: 'error', data: { error_code: 7 } }), {
      ok: false,
      challenge: false,
    })
    for (const http of [403, 429])
      assert.deepEqual(L.smsResponse(http, null), { ok: false, challenge: true })
    assert.deepEqual(L.smsResponse(200, { message: 'error', data: { captcha: 'x' } }), {
      ok: false,
      challenge: true,
    })
  })

  test('MFA answers and scan states pass through the tracker', () => {
    const t = L.newQrTracker()
    assert.equal(
      L.qrOnResponse(t, POLL, 200, { data: { status: 'scanned' } }, 1, 'x').status,
      'scanned',
    )
    assert.equal(
      L.qrOnResponse(t, POLL, 200, { data: { biz_params: { std_verify_flow_id: 'x' } } }, 2).mfa,
      true,
    )
    assert.equal(
      L.qrOnResponse(
        t,
        POLL,
        200,
        { data: { status: 'confirmed', redirect_url: 'https://creator.douyin.com/' } },
        3,
      ).status,
      'confirmed',
    )
  })

  test('stall detection: expired overlay, published code 10s past expiry, or no poll for 10s', () => {
    const t = L.newQrTracker()
    assert.equal(L.qrNeedsKick(t, 0, false), false)
    assert.equal(L.qrNeedsKick(t, 0, true), true)
    t.published = { png: PNG_B64, expireAt: 100_000, token: 'tokA' }
    t.lastPollAt = 105_000
    assert.equal(L.qrNeedsKick(t, 109_000, false), false)
    assert.equal(L.qrNeedsKick(t, 110_001, false), true)
    t.published = null
    t.lastPollAt = 200_000
    assert.equal(L.qrNeedsKick(t, 209_000, false), false)
    assert.equal(L.qrNeedsKick(t, 210_001, false), true)
  })

  test('command frames: only the four commands; the code must be 4–8 digits and nothing else', () => {
    assert.deepEqual(L.validCommand({ cmd: 'send_sms' }), { cmd: 'send_sms' })
    assert.deepEqual(L.validCommand({ cmd: 'resend_sms' }), { cmd: 'resend_sms' })
    assert.deepEqual(L.validCommand({ cmd: 'abort' }), { cmd: 'abort' })
    assert.deepEqual(L.validCommand({ cmd: 'sms_code', code: '123456' }), {
      cmd: 'sms_code',
      code: '123456',
    })
    for (const bad of [
      { cmd: 'sms_code', code: '12a456' },
      { cmd: 'sms_code', code: '123' },
      { cmd: 'sms_code', code: 123456 },
      { cmd: 'sms_code', code: '123456', extra: 1 },
      { cmd: 'send_sms', code: '123456' },
      { cmd: 'click', x: 1 },
      [],
      null,
    ])
      assert.deepEqual(L.validCommand(bad), { cmd: 'invalid' }, JSON.stringify(bad))
  })

  test('the login loop: captcha checked every round and before saving; verification hands over to the SMS flow', () => {
    const loop = DOUYIN_WORKER_SOURCE.slice(DOUYIN_WORKER_SOURCE.indexOf('async function runLogin'))
    const checks = [...loop.matchAll(/await pageChallenge\(context\)/g)]
    assert.ok(checks.length >= 3)
    assert.ok(
      loop.indexOf('const late = await pageChallenge(context)') <
        loop.indexOf("event: 'authenticated'"),
    )
    assert.match(loop, /await runVerification\(login, flags, input\.deadlineMs\)/)
    // 码只在页面轮询过之后才发给 master（qr 帧带 expireAt）；作废立即通知 master。
    assert.match(
      loop,
      /if \(out\.publish\) \{ writeFrame\(\{ event: 'qr', png: out\.publish\.png, expireAt: out\.publish\.expireAt \}\)/,
    )
    assert.match(loop, /if \(out\.invalidate\) writeFrame\(\{ event: 'qr_invalid' \}\)/)
    assert.match(loop, /requestQrToken\(request\.url\(\), request\.postData\(\)\)/)
    const verify = DOUYIN_WORKER_SOURCE.slice(
      DOUYIN_WORKER_SOURCE.indexOf('async function runVerification'),
      DOUYIN_WORKER_SOURCE.indexOf('async function runLogin'),
    )
    // 发短信以 send_code 成功为准；提交以 validate_code 为准；只在 master 命令后才动作。
    assert.match(verify, /flags\.sendCode\.at !== before/)
    // 一次命令只点一次（一份额度一次发送）；风控立即停。
    assert.equal((verify.match(/await target\.click\(/g) ?? []).length, 1)
    assert.doesNotMatch(verify, /for \(let attempt/)
    assert.match(verify, /flags\.sendCode\.challenge\) await failLogin\('UPSTREAM_CHALLENGE'/)
    assert.match(verify, /flags\.validateChallenge\) await failLogin\('UPSTREAM_CHALLENGE'/)
    // 风控信号粘性：迟到的 403/429 也会让验证循环和主循环下一轮立即停止（Codex r2 P1）。
    assert.match(verify, /if \(flags\.challengeSeen\) await failLogin\('UPSTREAM_CHALLENGE'/)
    assert.match(loop, /if \(flags\.challengeSeen\) await failLogin\('UPSTREAM_CHALLENGE'/)
    assert.equal(
      (DOUYIN_WORKER_SOURCE.match(/if \(r\.challenge\) flags\.challengeSeen = true;/g) ?? [])
        .length,
      2,
    )
    assert.match(verify, /flags\.validateAt !== before && flags\.validateOk/)
    assert.match(verify, /const command = await nextCommand\(/)
    assert.doesNotMatch(verify, /emitStep\([^)]*code: command/)
  })
})

describe('douyin protocol, codes, logs, seed CLI', () => {
  test('seed only continues after a clean login worker exit', () => {
    const state = { cookies: [], origins: [] }
    assert.equal(requireCleanLogin({ state, failure: null, doneError: null }), state)
    assert.throws(
      () => requireCleanLogin({ state, failure: null, doneError: new Error('PROTOCOL') }),
      /did not finish cleanly/,
    )
    assert.throws(
      () => requireCleanLogin({ state: null, failure: 'LOGIN_EXPIRED', doneError: null }),
      /LOGIN_EXPIRED/,
    )
    assert.throws(
      () => requireCleanLogin({ state: null, failure: null, doneError: null }),
      /no state/,
    )
  })

  test('frames: ready + terminal decode; write-fence frames and unknown codes are protocol errors', () => {
    assert.deepEqual(
      decodeDouyinWorkerFramesForTest(
        Buffer.concat([framed(READY), framed({ event: 'failed', code: 'VERIFICATION_REQUIRED' })]),
      ),
      ['ready', 'failed'],
    )
    for (const forbidden of [
      { event: 'prepared' },
      { event: 'not_dispatched', code: 'PRECONDITION_CHANGED' },
      { event: 'failed', code: 'WEIBO_WRITE_SEND' },
    ])
      assert.throws(() =>
        decodeDouyinWorkerFramesForTest(Buffer.concat([framed(READY), framed(forbidden)])),
      )
    assert.throws(() =>
      decodeDouyinWorkerFramesForTest(
        framed({
          event: 'ready',
          runtime: 'bili-account-worker-v1',
          playwrightMcpVersion: '0.0.76',
        }),
      ),
    )
  })

  test('SMS verification frames (4.3.C) decode; malformed ones are protocol errors', () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64')
    assert.deepEqual(
      decodeDouyinWorkerFramesForTest(
        Buffer.concat([
          framed(READY),
          framed({ event: 'qr', png, expireAt: 1_792_605_099_000 }),
          framed({ event: 'verification', kind: 'sms_available' }),
          framed({ event: 'sms_sent', resendAfterSec: 60 }),
          framed({ event: 'sms_rejected' }),
          framed({ event: 'sms_resend_failed' }),
          framed({ event: 'qr_invalid' }),
        ]),
      ),
      [
        'ready',
        'qr',
        'verification',
        'sms_sent',
        'sms_rejected',
        'sms_resend_failed',
        'qr_invalid',
      ],
    )
    for (const bad of [
      { event: 'qr', png },
      { event: 'qr', png, expireAt: -1 },
      { event: 'verification', kind: 'face' },
      { event: 'verification', kind: 'sms_available', code: '123456' },
      { event: 'sms_sent', resendAfterSec: 9999 },
      { event: 'sms_rejected', code: '123456' },
    ])
      assert.throws(
        () => decodeDouyinWorkerFramesForTest(Buffer.concat([framed(READY), framed(bad)])),
        JSON.stringify(bad),
      )
  })

  test('worker codes map to stable runtime codes that the RPC passes through with Douyin guidance', () => {
    assert.deepEqual(DOUYIN_WORKER_PROTOCOL_FAILURE_CODES.map(mapDouyinWorkerProtocolFailure), [
      'DOUYIN_ACTION_FAILED',
      'LOGIN_EXPIRED_ACCOUNT',
      'DOUYIN_UPSTREAM_CHALLENGE',
      'DOUYIN_LOGIN_UNSUPPORTED',
      'DOUYIN_VERIFICATION_REQUIRED',
    ])
    for (const code of DOUYIN_FAILURE_CODES) {
      assert.ok(isPluginPassthroughErrorCode(code), code)
      const g = resolvePluginErrorGuidance({ code, provider: 'douyin' })
      assert.match(g.message, /抖音/, code)
      assert.doesNotMatch(`${g.message}${g.nextAction}`, /微博|B 站|知乎/, code)
    }
    for (const code of ['DOUYIN_UPSTREAM_CHALLENGE', 'DOUYIN_VERIFICATION_REQUIRED'])
      assert.equal(resolvePluginErrorGuidance({ code }).retrySafe, 'no', code)
    // 登录失效走平台通用码，文案按 provider 写抖音，引导重新扫码。
    const expired = resolvePluginErrorGuidance({
      code: 'LOGIN_EXPIRED_ACCOUNT',
      provider: 'douyin',
    })
    assert.equal(expired.requiresReauth, true)
    assert.match(expired.nextAction, /抖音/)
    assert.doesNotMatch(expired.nextAction, /微博/)
  })

  test('host logs keep only allow-listed, non-secret fields under the commercial log root', () => {
    assert.equal(DEFAULT_DOUYIN_WORKER_LOG_DIR, '/var/log/openclaude-v5/douyin-workers')
    assert.deepEqual(
      sanitizeDouyinWorkerLogLine(
        JSON.stringify({
          step: 'action.done',
          actionId: 'me',
          ok: true,
          ms: 12.4,
          cookie: 'sessionid=x',
          url: 'https://x?a=1',
        }),
      ),
      { step: 'action.done', actionId: 'me', ok: true, ms: 12 },
    )
    assert.equal(
      sanitizeDouyinWorkerLogLine(JSON.stringify({ step: 'sessionid=secret value' })),
      null,
    )
    assert.equal(sanitizeDouyinWorkerLogLine('not json'), null)
    // 被拦下的来源只有域名。
    assert.deepEqual(
      sanitizeDouyinWorkerLogLine(
        JSON.stringify({ step: 'net.blocked', host: 'lf-rc2.yhgfb-cn-static.com', path: '/x?y' }),
      ),
      { step: 'net.blocked', host: 'lf-rc2.yhgfb-cn-static.com' },
    )
  })

  test('broker socket paths fit the 100-byte limit for master and seed roots', () => {
    const invocation = '00000000-0000-0000-0000-000000000000'
    for (const root of [DOUYIN_BROKER_ROOT, DOUYIN_SEED_BROKER_ROOT])
      assert.ok(Buffer.byteLength(`${root}/${invocation}/tls.sock`) <= 100, root)
  })

  test('worker resources stay within the Weibo envelope', () => {
    assert.deepEqual(resolveDouyinWorkerResources('action'), {
      memoryBytes: 768 * 1024 * 1024,
      memorySwapBytes: 768 * 1024 * 1024,
      pidsLimit: 128,
      shmSizeBytes: 64 * 1024 * 1024,
    })
  })

  test('seed CLI: advisory needs nothing; verify needs user + root-only QR path + root-only SMS code file', () => {
    assert.deepEqual(parseDouyinSeedCliArgs(['--advisory-status']), { mode: 'advisory-status' })
    const sms = '--sms-code-fifo=/root/.g553-douyin-sms'
    assert.deepEqual(
      parseDouyinSeedCliArgs([
        '--verify-and-seed-user=247',
        '--qr-out=/root/g553-douyin-qr.png',
        sms,
      ]),
      {
        mode: 'verify-and-seed',
        userId: 247,
        qrOut: '/root/g553-douyin-qr.png',
        smsCodeFifo: '/root/.g553-douyin-sms',
      },
    )
    assert.deepEqual(
      parseDouyinSeedCliArgs(['--verify-only', '--qr-out=/root/g553-douyin-qr.png', sms]),
      {
        mode: 'verify-only',
        qrOut: '/root/g553-douyin-qr.png',
        smsCodeFifo: '/root/.g553-douyin-sms',
      },
    )
    for (const bad of [
      [],
      ['--verify-and-seed-user=3'],
      ['--verify-and-seed-user=3', '--qr-out=/root/x.png'],
      ['--verify-and-seed-user=3', '--qr-out=/tmp/x.png', sms],
      ['--verify-and-seed-user=3', '--qr-out=/root/../x.png', sms],
      ['--verify-and-seed-user=3', '--qr-out=/root/x.png', '--sms-code-fifo=/tmp/code'],
      ['--verify-and-seed-user=3', '--qr-out=/root/x.png', '--sms-code-fifo=/root/x.png'],
      ['--verify-and-seed-user=3', '--qr-out=/root/x.png', sms, '--subtitle-bvid=BV1xx411c7mD'],
      ['--verify-and-seed-user=3', '--qr-out=/root/x.png', '--sms-code-file=/root/.code'],
      ['--seed-only'],
    ])
      assert.throws(() => parseDouyinSeedCliArgs(bad), JSON.stringify(bad))
  })
})
