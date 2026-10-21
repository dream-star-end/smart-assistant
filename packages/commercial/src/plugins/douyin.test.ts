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
function fakePage(table: Record<string, { status?: number; body: unknown }>, seen: string[] = []) {
  return {
    async evaluate(_fn: unknown, input: { url: string; max: number }) {
      seen.push(input.url)
      const hit = table[input.url]
      if (!hit) return { status: 404, text: '', tooLarge: false }
      return { status: hit.status ?? 200, text: JSON.stringify(hit.body), tooLarge: false }
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

  test('this version is read-only: one `me` action, network methods are GET only', () => {
    assert.ok(DOUYIN_PLUGIN_CONTRACT.actions.every((action) => action.effect === 'read'))
    assert.deepEqual([...DOUYIN_PLUGIN_CONTRACT.runtime.network.methods], ['GET'])
    assert.deepEqual(douyinSmokeActionIds(), ['me'])
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
     return { challengeCode, pageChallenge, isMfaResponse, newQrTracker, qrOnResponse, qrNeedsKick, validCommand };`,
  )() as {
    challengeCode(text: string): string | null
    pageChallenge(context: unknown): Promise<string | null>
    isMfaResponse(data: unknown): boolean
    newQrTracker(): {
      pending: { png: string; expireAt: number } | null
      published: { png: string; expireAt: number } | null
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
    ): {
      publish: { png: string; expireAt: number } | null
      invalidate: boolean
      mfa: boolean
      status: string | null
    }
    qrNeedsKick(tracker: unknown, now: number, overlay: boolean): boolean
    validCommand(value: unknown): { cmd: string; code?: string }
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

  test('a code is published only after the page polled it and got `new` with ≥45s left (4.3.C)', () => {
    const t = L.newQrTracker()
    const now = 1_000_000
    const issued = L.qrOnResponse(
      t,
      GET_QR,
      200,
      { data: { qrcode: PNG_B64, expire_time: (now + 60_000) / 1000 } },
      now,
    )
    assert.equal(issued.publish, null)
    assert.equal(issued.invalidate, true)
    const polled = L.qrOnResponse(t, POLL, 200, { data: { status: 'new' } }, now + 1_500)
    assert.deepEqual(polled.publish, { png: PNG_B64, expireAt: now + 60_000 })
    // 下一次轮询不再重复发布同一个码。
    assert.equal(
      L.qrOnResponse(t, POLL, 200, { data: { status: 'new' } }, now + 3_000).publish,
      null,
    )
    // 页面没在轮询的码（剩余 <45 秒才被确认）不发布。
    const late = L.newQrTracker()
    L.qrOnResponse(
      late,
      GET_QR,
      200,
      { data: { qrcode: PNG_B64, expire_time: (now + 60_000) / 1000 } },
      now,
    )
    assert.equal(
      L.qrOnResponse(late, POLL, 200, { data: { status: 'new' } }, now + 20_000).publish,
      null,
    )
    // 过期应答自带新码：旧码立即作废，新码同样要等页面轮询。
    const rotated = L.qrOnResponse(
      t,
      POLL,
      200,
      { data: { status: 'expired', qrcode: PNG_B64, expire_time: (now + 120_000) / 1000 } },
      now + 60_500,
    )
    assert.equal(rotated.invalidate, true)
    assert.equal(t.published, null)
    // 502：作废已发布的码。
    L.qrOnResponse(t, POLL, 200, { data: { status: 'new' } }, now + 61_000)
    assert.ok(t.published)
    assert.equal(L.qrOnResponse(t, POLL, 502, null, now + 62_000).invalidate, true)
    assert.equal(t.published, null)
    // 非 PNG base64 不接受。
    const bad = L.newQrTracker()
    L.qrOnResponse(
      bad,
      GET_QR,
      200,
      { data: { qrcode: '<svg onload=1>'.repeat(20), expire_time: (now + 60_000) / 1000 } },
      now,
    )
    assert.equal(
      L.qrOnResponse(bad, POLL, 200, { data: { status: 'new' } }, now + 1_000).publish,
      null,
    )
  })

  test('MFA answers and scan states pass through the tracker', () => {
    const t = L.newQrTracker()
    assert.equal(L.qrOnResponse(t, POLL, 200, { data: { status: 'scanned' } }, 1).status, 'scanned')
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
    t.published = { png: PNG_B64, expireAt: 100_000 }
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
    // 码只在页面轮询过之后才发给 master（qr 帧带 expireAt）。
    assert.match(
      loop,
      /if \(out\.publish\) \{ writeFrame\(\{ event: 'qr', png: out\.publish\.png, expireAt: out\.publish\.expireAt \}\)/,
    )
    const verify = DOUYIN_WORKER_SOURCE.slice(
      DOUYIN_WORKER_SOURCE.indexOf('async function runVerification'),
      DOUYIN_WORKER_SOURCE.indexOf('async function runLogin'),
    )
    // 发短信以 send_code 成功为准；提交以 validate_code 为准；只在 master 命令后才动作。
    assert.match(verify, /flags\.sendCodeOkAt !== before/)
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
        ]),
      ),
      ['ready', 'qr', 'verification', 'sms_sent', 'sms_rejected', 'sms_resend_failed'],
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
    const sms = '--sms-code-file=/root/.g553-douyin-sms'
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
        smsCodeFile: '/root/.g553-douyin-sms',
      },
    )
    assert.deepEqual(
      parseDouyinSeedCliArgs(['--verify-only', '--qr-out=/root/g553-douyin-qr.png', sms]),
      {
        mode: 'verify-only',
        qrOut: '/root/g553-douyin-qr.png',
        smsCodeFile: '/root/.g553-douyin-sms',
      },
    )
    for (const bad of [
      [],
      ['--verify-and-seed-user=3'],
      ['--verify-and-seed-user=3', '--qr-out=/root/x.png'],
      ['--verify-and-seed-user=3', '--qr-out=/tmp/x.png', sms],
      ['--verify-and-seed-user=3', '--qr-out=/root/../x.png', sms],
      ['--verify-and-seed-user=3', '--qr-out=/root/x.png', '--sms-code-file=/tmp/code'],
      ['--verify-and-seed-user=3', '--qr-out=/root/x.png', '--sms-code-file=/root/x.png'],
      ['--verify-and-seed-user=3', '--qr-out=/root/x.png', sms, '--subtitle-bvid=BV1xx411c7mD'],
      ['--seed-only'],
    ])
      assert.throws(() => parseDouyinSeedCliArgs(bad), JSON.stringify(bad))
  })
})
