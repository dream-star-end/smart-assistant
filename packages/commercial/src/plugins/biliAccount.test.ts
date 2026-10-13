/**
 * OCV5-402 · official read-only Bilibili account Plugin (managed-browser). No Docker, no network:
 * contract pins / schemas, account-state limits, worker source branches (compiled from the pinned
 * source with a fake page), frame protocol, failure-code mapping, log sanitising, seed CLI parsing.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  biliAccountSmokeActionIds,
  parseBiliAccountSeedCliArgs,
  requireCleanLogin,
} from '../marketplace/seedBiliAccountPlugin.js'
import {
  BILI_ACCOUNT_BROKER_ROOT,
  BILI_ACCOUNT_LOGIN_ORIGINS,
  BILI_ACCOUNT_PLUGIN_CONTRACT,
  BILI_ACCOUNT_PLUGIN_SLUG,
  BILI_ACCOUNT_PLUGIN_VERSION,
  BILI_ACCOUNT_SEED_BROKER_ROOT,
  COMPILED_BILI_ACCOUNT_PLUGIN,
  classifyBiliAccountSetupPin,
  decodeBiliAccountWorkerFramesForTest,
  isOfficialBiliAccountPluginIdentity,
  resolveBiliAccountWorkerResources,
  validateBiliAccountState,
} from './biliAccount.js'
import {
  BILI_ACCOUNT_FAILURE_CODES,
  BILI_ACCOUNT_WORKER_PROTOCOL_FAILURE_CODES,
  mapBiliAccountWorkerProtocolFailure,
  sanitizeBiliAccountWorkerLogLine,
} from './biliAccountObservability.js'
import { BILI_ACCOUNT_WORKER_SOURCE } from './biliAccountWorkerSource.js'
import { validateRuntimePluginJson } from './contracts.js'
import { isPluginPassthroughErrorCode, resolvePluginErrorGuidance } from './pluginErrorGuidance.js'

function framed(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

const READY = { event: 'ready', runtime: 'bili-account-worker-v1', playwrightMcpVersion: '0.0.76' }

/** Compile the worker's pure helpers + actionRead from the pinned source (same code that ships). */
function workerHarness() {
  const src = BILI_ACCOUNT_WORKER_SOURCE
  const start = src.indexOf('function filteredState')
  const end = src.indexOf('async function finishAction')
  assert.ok(start > 0 && end > start)
  return new Function(
    `'use strict';
     const MAX_API_TEXT = 900 * 1024;
     const SUBTITLE_HOSTS = new Set(['aisubtitle.hdslb.com', 'i0.hdslb.com']);
     const RISK_CODES = new Set([-352, -412, -799]);
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
function fakePage(
  table: Record<string, { status?: number; body: unknown }>,
  seen: string[] = [],
  credentials: Record<string, string> = {},
) {
  return {
    async evaluate(_fn: unknown, input: { url: string; max: number; credentials: string }) {
      seen.push(input.url)
      credentials[input.url] = input.credentials
      const key = Object.keys(table).find((prefix) => input.url.startsWith(prefix))
      if (!key) return { status: 404, text: '', tooLarge: false }
      const hit = table[key]!
      return { status: hit.status ?? 200, text: JSON.stringify(hit.body), tooLarge: false }
    },
  }
}

const NAV_OK = {
  body: {
    code: 0,
    data: {
      isLogin: true,
      mid: 12345,
      uname: '测试账号',
      level_info: { current_level: 6 },
      vipStatus: 1,
    },
  },
}
const API = 'https://api.bilibili.com'

describe('official Bilibili account Plugin', () => {
  test('pins the current artifact; only the exact pin is setup-compatible', () => {
    assert.equal(BILI_ACCOUNT_PLUGIN_SLUG, 'bili-account')
    assert.equal(BILI_ACCOUNT_PLUGIN_VERSION, '1.0.0')
    assert.equal(COMPILED_BILI_ACCOUNT_PLUGIN.pluginType, 'managed-browser')
    assert.match(COMPILED_BILI_ACCOUNT_PLUGIN.artifactHash, /^[0-9a-f]{64}$/)
    const exact = {
      version: BILI_ACCOUNT_PLUGIN_VERSION,
      artifactHash: COMPILED_BILI_ACCOUNT_PLUGIN.artifactHash,
      execContractHash: COMPILED_BILI_ACCOUNT_PLUGIN.execContractHash,
    }
    assert.equal(classifyBiliAccountSetupPin(exact), 'current')
    assert.equal(classifyBiliAccountSetupPin({ ...exact, artifactHash: '0'.repeat(64) }), null)
    const identity = {
      slug: BILI_ACCOUNT_PLUGIN_SLUG,
      pluginType: 'managed-browser',
      artifactHash: exact.artifactHash,
      execContractHash: exact.execContractHash,
    }
    assert.equal(
      isOfficialBiliAccountPluginIdentity({ ...identity, reviewSource: 'platform' }),
      true,
    )
    assert.equal(isOfficialBiliAccountPluginIdentity({ ...identity, reviewSource: 'human' }), false)
  })

  test('read-only by construction: every action is read, network methods are GET only', () => {
    assert.ok(BILI_ACCOUNT_PLUGIN_CONTRACT.actions.every((action) => action.effect === 'read'))
    assert.deepEqual([...BILI_ACCOUNT_PLUGIN_CONTRACT.runtime.network.methods], ['GET'])
    assert.deepEqual(biliAccountSmokeActionIds().sort(), [
      'favorite_folders',
      'favorite_items',
      'history',
      'me',
      'subtitle',
    ])
  })

  test('state and network stay inside exact bilibili origins; only Secure cookies are accepted', () => {
    const origins = BILI_ACCOUNT_PLUGIN_CONTRACT.runtime.network.origins
    assert.ok(origins.includes('https://api.bilibili.com:443'))
    assert.ok(origins.every((origin) => /\.(bilibili|hdslb)\.com:443$/.test(origin)))
    assert.ok(!BILI_ACCOUNT_LOGIN_ORIGINS.some((origin) => /data\.bilibili|shuzilm/.test(origin)))
    const cookie = {
      name: 'SESSDATA',
      value: 'secret',
      domain: '.bilibili.com',
      path: '/',
      expires: -1,
      httpOnly: true,
      sameSite: 'Lax' as const,
    }
    assert.equal(
      validateBiliAccountState({ cookies: [{ ...cookie, secure: true }], origins: [] }).cookies[0]
        ?.name,
      'SESSDATA',
    )
    assert.throws(() =>
      validateBiliAccountState({ cookies: [{ ...cookie, secure: false }], origins: [] }),
    )
    assert.throws(() =>
      validateBiliAccountState({
        cookies: [{ ...cookie, secure: true, domain: '.example.com' }],
        origins: [],
      }),
    )
  })

  test('each action schema accepts a valid example and rejects extras', () => {
    const examples: Record<
      string,
      { params: Record<string, unknown>; result: Record<string, unknown> }
    > = {
      me: { params: {}, result: { mid: 1, uname: 'u', level: 6, vip: false } },
      favorite_folders: {
        params: {},
        result: { folders: [{ id: 1, title: '默认收藏夹', count: 3 }] },
      },
      favorite_items: {
        params: { folderId: 1, page: 1, pageSize: 20 },
        result: {
          hasMore: false,
          items: [
            {
              bvid: 'BV1xx411c7mD',
              title: 't',
              url: 'https://www.bilibili.com/video/BV1xx411c7mD',
              favAt: 1,
            },
          ],
        },
      },
      history: {
        params: { pageSize: 10 },
        result: {
          items: [
            {
              bvid: 'BV1xx411c7mD',
              title: 't',
              url: 'https://www.bilibili.com/video/BV1xx411c7mD',
              progressSec: -1,
            },
          ],
        },
      },
      subtitle: {
        params: { bvid: 'BV1xx411c7mD', page: 1, lang: 'ai-zh' },
        result: {
          bvid: 'BV1xx411c7mD',
          cid: 2,
          lang: 'ai-zh',
          available: [{ lang: 'ai-zh', label: '中文（自动生成）' }],
          lines: [{ from: 0.5, to: 2, text: '你好' }],
          truncated: false,
        },
      },
    }
    for (const action of BILI_ACCOUNT_PLUGIN_CONTRACT.actions) {
      const example = examples[action.id]
      assert.ok(example, `missing example for ${action.id}`)
      assert.doesNotThrow(
        () => validateRuntimePluginJson(action.params, example.params, 'params'),
        action.id,
      )
      assert.doesNotThrow(
        () => validateRuntimePluginJson(action.result, example.result, 'result'),
        action.id,
      )
      assert.throws(() =>
        validateRuntimePluginJson(action.params, { ...example.params, extra: 1 }, 'params'),
      )
    }
    const sub = BILI_ACCOUNT_PLUGIN_CONTRACT.actions.find((action) => action.id === 'subtitle')!
    assert.throws(() => validateRuntimePluginJson(sub.params, { bvid: '../../etc/pass' }, 'params'))
  })

  test('worker source: a branch per action, same-site in-page reads only, no Node request client', () => {
    for (const action of BILI_ACCOUNT_PLUGIN_CONTRACT.actions)
      assert.ok(BILI_ACCOUNT_WORKER_SOURCE.includes(`input.actionId === '${action.id}'`), action.id)
    // API reads carry the session; only the signed subtitle CDN file is fetched without cookies.
    assert.match(BILI_ACCOUNT_WORKER_SOURCE, /async function apiGet\(page, url, credentials = 'include'\)/)
    assert.deepEqual(BILI_ACCOUNT_WORKER_SOURCE.match(/'omit'/g), ["'omit'"])
    assert.match(BILI_ACCOUNT_WORKER_SOURCE, /apiGet\(page, subtitleUrl, 'omit'\)/)
    assert.match(BILI_ACCOUNT_WORKER_SOURCE, /robots\.txt/)
    assert.doesNotMatch(
      BILI_ACCOUNT_WORKER_SOURCE,
      /request\.newContext|APIRequestContext|playwright\.request/,
    )
    assert.doesNotMatch(BILI_ACCOUNT_WORKER_SOURCE, /method: '(POST|PUT|DELETE)'/)
    assert.ok(!BILI_ACCOUNT_WORKER_SOURCE.includes('${'), 'String.raw source must not interpolate')
  })
})

describe('bili-account worker behaviour (compiled from the pinned source)', () => {
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
          c('SESSDATA', '.bilibili.com'),
          c('bili_jct', '.bilibili.com', false),
          c('x', '.evil.example'),
        ],
        origins: [],
      },
      ['bilibili.com', 'www.bilibili.com'],
      ['https://www.bilibili.com'],
    )
    assert.deepEqual(
      state.cookies.map((row) => row.name),
      ['SESSDATA'],
    )
  })

  test('me / folders / items / history project the documented fields', async () => {
    const page = fakePage({
      [`${API}/x/web-interface/nav`]: NAV_OK,
      [`${API}/x/v3/fav/folder/created/list-all`]: {
        body: { code: 0, data: { list: [{ id: 7, title: '默认收藏夹', media_count: 2 }] } },
      },
      [`${API}/x/v3/fav/resource/list`]: {
        body: {
          code: 0,
          data: {
            info: { title: '默认收藏夹', media_count: 2 },
            has_more: false,
            medias: [
              {
                bvid: 'BV1xx411c7mD',
                title: '收藏 1',
                cover: '//i0.hdslb.com/a.jpg',
                upper: { name: 'UP' },
                cnt_info: { play: 10, danmaku: 2 },
                duration: 61,
                fav_time: 1760000000,
              },
              { bvid: 'nope', title: 'bad' },
            ],
          },
        },
      },
      [`${API}/x/web-interface/history/cursor`]: {
        body: {
          code: 0,
          data: {
            list: [
              {
                title: '看过',
                history: { bvid: 'BV1xx411c7mD' },
                author_name: 'UP',
                progress: -1,
                duration: 61,
                view_at: 1760000001,
              },
            ],
          },
        },
      },
    })
    assert.deepEqual(await worker.actionRead(page, { actionId: 'me' }), {
      mid: 12345,
      uname: '测试账号',
      level: 6,
      vip: true,
    })
    assert.deepEqual(await worker.actionRead(page, { actionId: 'favorite_folders' }), {
      folders: [{ id: 7, title: '默认收藏夹', count: 2 }],
    })
    const items = (await worker.actionRead(page, {
      actionId: 'favorite_items',
      params: { folderId: 7 },
    })) as { items: Array<Record<string, unknown>>; hasMore: boolean }
    assert.equal(items.items.length, 1)
    assert.deepEqual(items.items[0], {
      bvid: 'BV1xx411c7mD',
      title: '收藏 1',
      cover: 'https://i0.hdslb.com/a.jpg',
      author: 'UP',
      play: 10,
      danmaku: 2,
      durationSec: 61,
      favAt: 1760000000,
      url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    })
    const history = (await worker.actionRead(page, { actionId: 'history' })) as {
      items: Array<Record<string, unknown>>
    }
    assert.equal(history.items[0]?.progressSec, -1)
    for (const action of BILI_ACCOUNT_PLUGIN_CONTRACT.actions.filter((a) => a.id !== 'subtitle')) {
      const out = await worker.actionRead(page, {
        actionId: action.id,
        params: action.id === 'favorite_items' ? { folderId: 7 } : {},
      })
      assert.doesNotThrow(() => validateRuntimePluginJson(action.result, out, 'result'), action.id)
    }
  })

  test('subtitle: picks the requested language, reads the allow-listed subtitle CDN without cookies, caps lines', async () => {
    const seen: string[] = []
    const lines = Array.from({ length: 700 }, (_, i) => ({
      from: i,
      to: i + 1,
      content: `第${i}句`,
    }))
    const creds: Record<string, string> = {}
    const page = fakePage(
      {
        [`${API}/x/web-interface/nav`]: NAV_OK,
        [`${API}/x/player/pagelist`]: { body: { code: 0, data: [{ cid: 111 }, { cid: 222 }] } },
        [`${API}/x/player/v2`]: {
          body: {
            code: 0,
            data: {
              subtitle: {
                subtitles: [
                  {
                    lan: 'zh-CN',
                    lan_doc: '中文',
                    subtitle_url: '//aisubtitle.hdslb.com/bfs/a.json',
                  },
                  {
                    lan: 'ai-zh',
                    lan_doc: '中文（自动生成）',
                    subtitle_url: '//aisubtitle.hdslb.com/bfs/b.json',
                  },
                ],
              },
            },
          },
        },
        'https://aisubtitle.hdslb.com/bfs/b.json': { body: { body: lines } },
      },
      seen,
      creds,
    )
    const out = (await worker.actionRead(page, {
      actionId: 'subtitle',
      params: { bvid: 'BV1xx411c7mD', page: 2, lang: 'ai' },
    })) as Record<string, unknown>
    assert.equal(out.cid, 222)
    assert.equal(out.lang, 'ai-zh')
    assert.equal((out.lines as unknown[]).length, 600)
    assert.equal(out.truncated, true)
    assert.ok(seen.some((url) => url.startsWith(`${API}/x/player/v2?bvid=BV1xx411c7mD&cid=222`)))
    // hdslb serves subtitle files with `Access-Control-Allow-Origin: *`; a credentialed fetch is
    // blocked by the browser (live seed 2026-10-13 failed this way), so the CDN read omits cookies.
    assert.equal(creds['https://aisubtitle.hdslb.com/bfs/b.json'], 'omit')
    for (const [url, mode] of Object.entries(creds)) {
      if (url.startsWith(API)) assert.equal(mode, 'include', url)
    }
    const subtitle = BILI_ACCOUNT_PLUGIN_CONTRACT.actions.find((a) => a.id === 'subtitle')!
    assert.doesNotThrow(() => validateRuntimePluginJson(subtitle.result, out, 'result'))

    const evil = fakePage({
      [`${API}/x/web-interface/nav`]: NAV_OK,
      [`${API}/x/player/pagelist`]: { body: { code: 0, data: [{ cid: 1 }] } },
      [`${API}/x/player/v2`]: {
        body: {
          code: 0,
          data: {
            subtitle: { subtitles: [{ lan: 'zh', subtitle_url: 'https://evil.example/x.json' }] },
          },
        },
      },
    })
    await assert.rejects(
      worker.actionRead(evil, { actionId: 'subtitle', params: { bvid: 'BV1xx411c7mD' } }),
      /WORKER_FAILED/,
    )
  })

  test('logged out → LOGIN_EXPIRED; risk control (code or HTTP 412) → UPSTREAM_CHALLENGE; nothing retried', async () => {
    const seen: string[] = []
    await assert.rejects(
      worker.actionRead(
        fakePage({
          [`${API}/x/web-interface/nav`]: { body: { code: -101, data: { isLogin: false } } },
        }),
        { actionId: 'me' },
      ),
      /LOGIN_EXPIRED/,
    )
    await assert.rejects(
      worker.actionRead(
        fakePage(
          {
            [`${API}/x/web-interface/nav`]: NAV_OK,
            [`${API}/x/web-interface/history/cursor`]: { body: { code: -352 } },
          },
          seen,
        ),
        { actionId: 'history' },
      ),
      /UPSTREAM_CHALLENGE/,
    )
    assert.equal(seen.filter((url) => url.includes('history')).length, 1)
    await assert.rejects(
      worker.actionRead(fakePage({ [`${API}/x/web-interface/nav`]: { status: 412, body: {} } }), {
        actionId: 'me',
      }),
      /UPSTREAM_CHALLENGE/,
    )
  })
})

/** Compile proveSelf (login session proof) together with the helpers it uses, from the pinned source. */
function proveSelfHarness() {
  const src = BILI_ACCOUNT_WORKER_SOURCE
  const helpers = src.slice(src.indexOf('function failureCode'), src.indexOf('function emitStep'))
  const reads = src.slice(
    src.indexOf('function cleanText'),
    src.indexOf('async function actionRead'),
  )
  const prove = src.slice(
    src.indexOf('async function proveSelf'),
    src.indexOf('async function runLogin'),
  )
  assert.ok(helpers.length > 0 && reads.length > 0 && prove.length > 0)
  return new Function(
    `'use strict';
     const MAX_API_TEXT = 900 * 1024;
     const RISK_CODES = new Set([-352, -412, -799]);
     const FAILURE_CODES = new Set(['WORKER_FAILED', 'LOGIN_EXPIRED', 'UPSTREAM_CHALLENGE', 'LOGIN_STATE_UNSUPPORTED']);
     ${helpers}${reads}${prove}
     return { proveSelf };`,
  )() as { proveSelf(context: unknown): Promise<number | null> }
}

describe('bili-account login proof (Codex r1 P1)', () => {
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
    for (const nav of [{ body: { code: -352 } }, { status: 412, body: {} }]) {
      const seen: string[] = []
      await assert.rejects(
        proveSelf(contextWith({ [`${API}/x/web-interface/nav`]: nav }, seen)),
        /UPSTREAM_CHALLENGE/,
      )
      assert.equal(seen.length, 1)
    }
  })

  test('not logged in yet → null (keep waiting for the scan); logged in → mid', async () => {
    assert.equal(
      await proveSelf(
        contextWith({ [`${API}/x/web-interface/nav`]: { body: { code: -101 } } }, []),
      ),
      null,
    )
    assert.equal(
      await proveSelf(contextWith({ [`${API}/x/web-interface/nav`]: NAV_OK }, [])),
      12345,
    )
  })
})

describe('bili-account protocol, codes, logs, seed CLI', () => {
  test('seed only continues after a clean login worker exit (Codex r1 P1)', () => {
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

  test('frames: ready + terminal decode; write-fence frames are protocol errors', () => {
    assert.deepEqual(
      decodeBiliAccountWorkerFramesForTest(
        Buffer.concat([framed(READY), framed({ event: 'failed', code: 'LOGIN_EXPIRED' })]),
      ),
      ['ready', 'failed'],
    )
    for (const forbidden of [
      { event: 'prepared' },
      { event: 'not_dispatched', code: 'PRECONDITION_CHANGED' },
      { event: 'failed', code: 'WEIBO_WRITE_SEND' },
    ])
      assert.throws(() =>
        decodeBiliAccountWorkerFramesForTest(Buffer.concat([framed(READY), framed(forbidden)])),
      )
    assert.throws(() =>
      decodeBiliAccountWorkerFramesForTest(
        framed({ event: 'ready', runtime: 'weibo-worker-v1', playwrightMcpVersion: '0.0.76' }),
      ),
    )
  })

  test('worker codes map to stable runtime codes that the RPC passes through with guidance', () => {
    const mapped = BILI_ACCOUNT_WORKER_PROTOCOL_FAILURE_CODES.map(
      mapBiliAccountWorkerProtocolFailure,
    )
    assert.deepEqual(mapped, [
      'BILI_ACCOUNT_ACTION_FAILED',
      'LOGIN_EXPIRED_ACCOUNT',
      'BILI_ACCOUNT_UPSTREAM_CHALLENGE',
      'BILI_ACCOUNT_LOGIN_UNSUPPORTED',
    ])
    for (const code of BILI_ACCOUNT_FAILURE_CODES) {
      assert.ok(isPluginPassthroughErrorCode(code), code)
      assert.match(resolvePluginErrorGuidance({ code }).message, /B 站/)
    }
    assert.equal(
      resolvePluginErrorGuidance({ code: 'BILI_ACCOUNT_UPSTREAM_CHALLENGE' }).retrySafe,
      'no',
    )
  })

  test('host logs keep only allow-listed, non-secret fields', () => {
    assert.deepEqual(
      sanitizeBiliAccountWorkerLogLine(
        JSON.stringify({
          step: 'action.done',
          actionId: 'history',
          ok: true,
          ms: 12.4,
          cookie: 'SESSDATA=x',
          url: 'https://x?a=1',
        }),
      ),
      { step: 'action.done', actionId: 'history', ok: true, ms: 12 },
    )
    assert.equal(
      sanitizeBiliAccountWorkerLogLine(JSON.stringify({ step: 'SESSDATA=secret value' })),
      null,
    )
    assert.equal(sanitizeBiliAccountWorkerLogLine('not json'), null)
  })

  test('broker socket paths fit the 100-byte limit for master and seed roots', () => {
    const invocation = '00000000-0000-0000-0000-000000000000'
    for (const root of [BILI_ACCOUNT_BROKER_ROOT, BILI_ACCOUNT_SEED_BROKER_ROOT])
      assert.ok(Buffer.byteLength(`${root}/${invocation}/tls.sock`) <= 100, root)
  })

  test('worker resources stay within the Weibo envelope', () => {
    assert.deepEqual(resolveBiliAccountWorkerResources('action'), {
      memoryBytes: 768 * 1024 * 1024,
      memorySwapBytes: 768 * 1024 * 1024,
      pidsLimit: 128,
      shmSizeBytes: 64 * 1024 * 1024,
    })
  })

  test('seed CLI: advisory needs nothing; verify needs user + root-only QR path', () => {
    assert.deepEqual(parseBiliAccountSeedCliArgs(['--advisory-status']), {
      mode: 'advisory-status',
    })
    assert.deepEqual(
      parseBiliAccountSeedCliArgs(['--verify-and-seed-user=3', '--qr-out=/root/g402-bili-qr.png']),
      {
        mode: 'verify-and-seed',
        userId: 3,
        qrOut: '/root/g402-bili-qr.png',
        subtitleBvid: null,
      },
    )
    for (const bad of [
      [],
      ['--verify-and-seed-user=3'],
      ['--verify-and-seed-user=3', '--qr-out=/tmp/x.png'],
      ['--verify-and-seed-user=3', '--qr-out=/root/../x.png'],
      ['--seed-only'],
    ])
      assert.throws(() => parseBiliAccountSeedCliArgs(bad), JSON.stringify(bad))
  })
})
