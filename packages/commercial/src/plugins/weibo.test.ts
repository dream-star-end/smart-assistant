import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { describe, test } from 'node:test'

import { chromium } from 'playwright-core'

import { RuntimePluginContractError, validateRuntimePluginJson } from './contracts.js'
import {
  COMPILED_WEIBO_PLUGIN,
  WEIBO_DRIVER_VERSION,
  WEIBO_LAUNCHER_VERSION,
  WEIBO_LOGIN_ORIGINS,
  WEIBO_PLUGIN_CONTRACT,
  WEIBO_PLUGIN_SLUG,
  WEIBO_PLUGIN_VERSION,
  WEIBO_SETUP_COMPATIBLE_PREDECESSORS,
  classifyWeiboSetupPin,
  decodeWeiboWorkerFramesForTest,
  isOfficialWeiboPluginIdentity,
  resolveWeiboWorkerResources,
  validateWeiboAccountState,
} from './weibo.js'
import { WEIBO_WORKER_SOURCE } from './weiboWorkerSource.js'
import { managedPluginWritePolicy, managedPluginWritePreapprovalPolicy } from './writePolicy.js'

function framed(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

function uploadedImageLocator(events: string[]) {
  return {
    count: async () => (events.includes('upload') ? 1 : 0),
    nth: () => ({
      isVisible: async () => true,
      getAttribute: async () => 'blob:https://weibo.com/preview',
    }),
  }
}

function compileWorkerPostHarness(overrides: Record<string, unknown>): {
  writeAction(page: unknown, input: unknown): Promise<unknown>
  awaitNewestOwnPost(
    page: unknown,
    selfId: string,
    text: string,
    beforeIds: Set<string>,
  ): Promise<unknown>
  activatePostSend(send: unknown): Promise<unknown>
  awaitPostSendReady(page: unknown, timeout: number, editor?: unknown): Promise<unknown>
} {
  const start = WEIBO_WORKER_SOURCE.indexOf('async function newestOwnPost')
  const end = WEIBO_WORKER_SOURCE.indexOf('async function finishAction', start)
  assert.ok(start >= 0 && end > start)
  const bound: Record<string, unknown> = {
    emitStep() {},
    visible: async (node: { isVisible?: () => Promise<boolean> } | null) => {
      if (!node) return false
      if (typeof node.isVisible === 'function') return await node.isVisible().catch(() => false)
      return true
    },
    ...overrides,
  }
  const names = Object.keys(bound)
  return new Function(
    ...names,
    `'use strict'; ${WEIBO_WORKER_SOURCE.slice(start, end)}; return { writeAction, awaitNewestOwnPost, activatePostSend, awaitPostSendReady };`,
  )(...names.map((name) => bound[name])) as ReturnType<typeof compileWorkerPostHarness>
}

function compileWorkerPostTextHarness(): {
  cleanPostText(value: unknown, max: number): string
} {
  const start = WEIBO_WORKER_SOURCE.indexOf('function cleanText')
  const end = WEIBO_WORKER_SOURCE.indexOf('function countFrom', start)
  assert.ok(start >= 0 && end > start)
  return new Function(
    `'use strict'; ${WEIBO_WORKER_SOURCE.slice(start, end)}; return { cleanPostText };`,
  )() as ReturnType<typeof compileWorkerPostTextHarness>
}

function compileWorkerChallengeHarness(writeTerminalAndExit: (event: unknown) => Promise<void>): {
  assertNoChallenge(page: {
    locator(selector: string): { innerText(): Promise<string> }
    url(): string
  }): Promise<void>
} {
  const riskStart = WEIBO_WORKER_SOURCE.indexOf('const RISK_TEXT')
  const riskEnd = WEIBO_WORKER_SOURCE.indexOf('let terminal', riskStart)
  const bodyStart = WEIBO_WORKER_SOURCE.indexOf('async function bodyText')
  const bodyEnd = WEIBO_WORKER_SOURCE.indexOf('async function isLoginVisible', bodyStart)
  assert.ok(riskStart >= 0 && riskEnd > riskStart && bodyStart >= 0 && bodyEnd > bodyStart)
  return new Function(
    'writeTerminalAndExit',
    'cleanText',
    `'use strict'; ${WEIBO_WORKER_SOURCE.slice(riskStart, riskEnd)}
      ${WEIBO_WORKER_SOURCE.slice(bodyStart, bodyEnd)}
      return { assertNoChallenge };`,
  )(writeTerminalAndExit, (value: unknown, max: number) =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max),
  ) as ReturnType<typeof compileWorkerChallengeHarness>
}

function compileWorkerProjectPostHarness(): {
  projectPost(card: unknown, selfId: string): Promise<{ text: string }>
} {
  const start = WEIBO_WORKER_SOURCE.indexOf('async function projectPost')
  const end = WEIBO_WORKER_SOURCE.indexOf('async function collectPosts', start)
  assert.ok(start >= 0 && end > start)
  const { cleanPostText } = compileWorkerPostTextHarness()
  return new Function(
    'cleanPostText',
    'digest',
    'countFrom',
    `'use strict'; ${WEIBO_WORKER_SOURCE.slice(start, end)}; return { projectPost };`,
  )(
    cleanPostText,
    (value: unknown) => JSON.stringify(value),
    () => 0,
  ) as ReturnType<typeof compileWorkerProjectPostHarness>
}

function compileWorkerMessageReadHarness(overrides: Record<string, unknown>): {
  collectMessageThreads(page: unknown, count: number): Promise<unknown>
  actionRead(page: unknown, input: unknown): Promise<unknown>
} {
  const messageStart = WEIBO_WORKER_SOURCE.indexOf('function isMessagePageEmptyResponse')
  const messageEnd = WEIBO_WORKER_SOURCE.indexOf(
    'async function prepareMessageComposer',
    messageStart,
  )
  const actionStart = WEIBO_WORKER_SOURCE.indexOf('async function actionRead')
  const actionEnd = WEIBO_WORKER_SOURCE.indexOf('async function newestOwnPost', actionStart)
  assert.ok(
    messageStart >= 0 && messageEnd > messageStart && actionStart >= 0 && actionEnd > actionStart,
  )
  const names = Object.keys(overrides)
  return new Function(
    ...names,
    `'use strict'; ${WEIBO_WORKER_SOURCE.slice(messageStart, messageEnd)}
      ${WEIBO_WORKER_SOURCE.slice(actionStart, actionEnd)}
      return { collectMessageThreads, actionRead };`,
  )(...names.map((name) => overrides[name])) as ReturnType<typeof compileWorkerMessageReadHarness>
}

describe('official Weibo Plugin', () => {
  test('does not mistake standard SMS login labels for a challenge', async () => {
    const events: unknown[] = []
    const { assertNoChallenge } = compileWorkerChallengeHarness(async (event) => {
      events.push(event)
    })
    const page = (text: string, url = 'https://passport.weibo.com/sso/signin') => ({
      locator: (selector: string) => {
        assert.equal(selector, 'body')
        return { innerText: async () => text }
      },
      url: () => url,
    })

    await assertNoChallenge(
      page('扫描二维码登录 打开微博手机APP 验证码登录 +86 获取验证码 登录/注册'),
    )
    assert.deepEqual(events, [])

    await assertNoChallenge(page('请输入图形验证码以完成安全验证'))
    assert.deepEqual(events, [{ event: 'failed', code: 'UPSTREAM_FAILED' }])
    events.length = 0

    await assertNoChallenge(page('验证码'))
    assert.deepEqual(events, [{ event: 'failed', code: 'UPSTREAM_FAILED' }])
    events.length = 0

    await assertNoChallenge(page('登录', 'https://passport.weibo.com/challenge'))
    assert.deepEqual(events, [{ event: 'failed', code: 'UPSTREAM_FAILED' }])
  })

  test('gives action Chromium enough memory while preserving worker-specific limits', () => {
    assert.deepEqual(resolveWeiboWorkerResources('action'), {
      memoryBytes: 768 * 1024 * 1024,
      memorySwapBytes: 768 * 1024 * 1024,
      pidsLimit: 128,
      shmSizeBytes: 64 * 1024 * 1024,
    })
    assert.deepEqual(resolveWeiboWorkerResources('login'), {
      memoryBytes: 768 * 1024 * 1024,
      memorySwapBytes: 768 * 1024 * 1024,
      pidsLimit: 256,
      shmSizeBytes: 256 * 1024 * 1024,
    })
  })

  test('pins the current artifact and only the exact production predecessor', () => {
    assert.equal(WEIBO_PLUGIN_VERSION, '1.6.30')
    assert.equal(WEIBO_DRIVER_VERSION, WEIBO_PLUGIN_VERSION)
    assert.equal(WEIBO_LAUNCHER_VERSION, WEIBO_PLUGIN_VERSION)
    assert.deepEqual(WEIBO_SETUP_COMPATIBLE_PREDECESSORS, [
      {
        version: '1.6.14',
        artifactHash: 'add60919dfd77461526ae543be1d17d70b6ab866bfff6a4bc988eacf8d1631e4',
        execContractHash: 'fb30fd3d06fa10b3ffff9eb2b25dd644ee2a9454f8c12fd55bd7d05b2188359c',
      },
    ])
    assert.equal(
      classifyWeiboSetupPin({
        version: WEIBO_PLUGIN_VERSION,
        artifactHash: COMPILED_WEIBO_PLUGIN.artifactHash,
        execContractHash: COMPILED_WEIBO_PLUGIN.execContractHash,
      }),
      'current',
    )
    assert.equal(
      classifyWeiboSetupPin(WEIBO_SETUP_COMPATIBLE_PREDECESSORS[0]),
      'compatible-predecessor',
    )
    assert.equal(
      classifyWeiboSetupPin({
        version: WEIBO_PLUGIN_VERSION,
        artifactHash: '0'.repeat(64),
        execContractHash: COMPILED_WEIBO_PLUGIN.execContractHash,
      }),
      null,
    )
    assert.equal(
      classifyWeiboSetupPin({
        ...WEIBO_SETUP_COMPATIBLE_PREDECESSORS[0],
        version: '1.1.0',
      }),
      null,
    )
    assert.equal(
      classifyWeiboSetupPin({
        ...WEIBO_SETUP_COMPATIBLE_PREDECESSORS[0],
        execContractHash: '0'.repeat(64),
      }),
      null,
    )
  })

  test('official badge requires platform provenance and both exact hashes', () => {
    const exact = {
      slug: WEIBO_PLUGIN_SLUG,
      pluginType: 'managed-browser',
      artifactHash: COMPILED_WEIBO_PLUGIN.artifactHash,
      execContractHash: COMPILED_WEIBO_PLUGIN.execContractHash,
    }
    assert.equal(isOfficialWeiboPluginIdentity({ ...exact, reviewSource: 'platform' }), true)
    assert.equal(isOfficialWeiboPluginIdentity({ ...exact, reviewSource: 'human' }), false)
    assert.equal(
      isOfficialWeiboPluginIdentity({
        ...exact,
        execContractHash: '0'.repeat(64),
        reviewSource: 'platform',
      }),
      false,
    )
  })

  test('exposes bounded common reads and default-confirmed writes with independent preapproval', () => {
    assert.deepEqual(
      WEIBO_PLUGIN_CONTRACT.actions.map((action) => action.id),
      [
        'get_self',
        'get_user',
        'list_home_posts',
        'list_user_posts',
        'get_post',
        'list_comments',
        'search_posts',
        'get_unread_counts',
        'list_notifications',
        'list_message_threads',
        'get_message_thread',
        'list_followers',
        'list_following',
        'search_users',
        'list_favorites',
        'list_liked_posts',
        'list_hot_searches',
        'create_post',
        'edit_post',
        'delete_post',
        'create_comment',
        'reply_comment',
        'delete_comment',
        'repost_post',
        'set_post_like',
        'set_following',
        'send_message',
        'set_post_favorite',
        'set_comment_like',
      ],
    )
    assert.equal(
      WEIBO_PLUGIN_CONTRACT.actions.filter((action) => action.effect === 'read').length,
      17,
    )
    assert.equal(
      WEIBO_PLUGIN_CONTRACT.actions.filter((action) => action.effect === 'write').length,
      12,
    )
    for (const action of WEIBO_PLUGIN_CONTRACT.actions.filter(
      (candidate) => candidate.effect === 'write',
    ))
      assert.match(action.description, /逐次确认/)
    const writePolicy = managedPluginWritePolicy(WEIBO_PLUGIN_SLUG)
    assert.equal(writePolicy?.version, 3)
    assert.match(writePolicy?.disclaimerText ?? '', /默认每一次写操作仍须.*确认卡/)
    assert.match(writePolicy?.disclaimerText ?? '', /独立的账号级高风险声明/)
    const preapprovalPolicy = managedPluginWritePreapprovalPolicy(WEIBO_PLUGIN_SLUG)
    assert.equal(preapprovalPolicy?.version, 2)
    assert.match(preapprovalPolicy?.disclaimerText ?? '', /发布文字或图片微博/)
    assert.match(preapprovalPolicy?.disclaimerText ?? '', /删除不可撤销/)
    assert.match(preapprovalPolicy?.disclaimerText ?? '', /点赞.*关注/)
    assert.match(preapprovalPolicy?.disclaimerText ?? '', /发送私信/)
    assert.match(preapprovalPolicy?.disclaimerText ?? '', /收藏/)
    assert.match(preapprovalPolicy?.disclaimerText ?? '', /派发围栏/)
  })

  test('keeps account state and browser network inside exact signed origins', () => {
    assert.equal(WEIBO_PLUGIN_CONTRACT.runtime.network.origins.length, 15)
    assert.ok(WEIBO_PLUGIN_CONTRACT.runtime.network.origins.includes('https://wx4.sinaimg.cn:443'))
    assert.ok(WEIBO_LOGIN_ORIGINS.length <= 16)
    assert.ok(WEIBO_LOGIN_ORIGINS.includes('https://v2.qr.weibo.cn:443'))
    assert.ok(
      WEIBO_PLUGIN_CONTRACT.runtime.accountState.cookieDomains.includes('login.sina.com.cn'),
    )
    const state = validateWeiboAccountState({
      cookies: [
        {
          name: 'SUB',
          value: 'secret',
          domain: '.weibo.com',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
        {
          name: 'ALF',
          value: 'secret',
          domain: '.login.sina.com.cn',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'None',
        },
      ],
      origins: [{ origin: 'https://weibo.com', localStorage: [] }],
    })
    assert.equal(state.cookies.length, 2)
    assert.throws(
      () =>
        validateWeiboAccountState({
          cookies: [
            {
              ...state.cookies[0],
              domain: '.example.com',
            },
          ],
          origins: [],
        }),
      /outside the signed Plugin contract/,
    )
  })

  test('worker is syntax-valid and DOM-only with an explicit dispatch fence', () => {
    const path = `/tmp/weibo-worker-test-${process.pid}.mjs`
    writeFileSync(path, WEIBO_WORKER_SOURCE, { mode: 0o600 })
    try {
      const checked = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })
      assert.equal(checked.status, 0, checked.stderr)
    } finally {
      rmSync(path, { force: true })
    }
    assert.doesNotMatch(WEIBO_WORKER_SOURCE, /\{\s*chromium\s*,\s*request\s*\}/)
    assert.doesNotMatch(WEIBO_WORKER_SOURCE, /context\.request|response\.body|response\.json/)
    assert.doesNotMatch(WEIBO_WORKER_SOURCE, /api\.weibo|\/ajax\/|mblog\/|statuses\//)
    assert.match(WEIBO_WORKER_SOURCE, /page\.goto/)
    assert.match(WEIBO_WORKER_SOURCE, /locator\(/)
    assert.match(WEIBO_WORKER_SOURCE, /event: 'prepared'/)
    assert.match(WEIBO_WORKER_SOURCE, /command\.event !== 'dispatch'/)
    assert.match(WEIBO_WORKER_SOURCE, /await writeTerminalAndExit\(\{ event: 'failed'/)
    assert.match(WEIBO_WORKER_SOURCE, /--disable-http2/)
    assert.match(WEIBO_WORKER_SOURCE, /const QR_REFRESH_MS = 8_000/)
    assert.equal(WEIBO_WORKER_SOURCE.match(/Date\.now\(\) \+ QR_REFRESH_MS/g)?.length, 2)
    assert.match(WEIBO_WORKER_SOURCE, /attempt < 80 && !valid/)
    assert.match(WEIBO_WORKER_SOURCE, /!beforeIds\.has\(post\.id\)/)
    assert.match(WEIBO_WORKER_SOURCE, /RISK_TEXT/)
    assert.match(WEIBO_WORKER_SOURCE, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/)
    assert.match(WEIBO_WORKER_SOURCE, /ERR_\(\?:EMPTY_RESPONSE\|CONNECTION_RESET/)
    assert.doesNotMatch(WEIBO_WORKER_SOURCE, /findPostCard\([^\n]+\) \|\| page\.locator/)
    assert.match(WEIBO_WORKER_SOURCE, /\.wbpro-scroller-item > \.wbpro-list > \.item1/)
    assert.match(WEIBO_WORKER_SOURCE, /parentCommentId: parentCommentId \|\| null/)
    assert.match(WEIBO_WORKER_SOURCE, /counts\.get\(entry\.comment\.id\) === 1/)
    assert.match(WEIBO_WORKER_SOURCE, /i\.woo-font--comment\[title="评论"\]/)
    assert.match(WEIBO_WORKER_SOURCE, /i\[title="删除"\]/)
    assert.match(WEIBO_WORKER_SOURCE, /cookie\.secure !== true/)
    assert.match(WEIBO_WORKER_SOURCE, /localStorage: \[\]/)
    assert.match(WEIBO_WORKER_SOURCE, /seenOrigins\.has\(canonical\)/)
    assert.match(WEIBO_WORKER_SOURCE, /m\.weibo\.cn\/search\?containerid=/)
    assert.match(WEIBO_WORKER_SOURCE, /detailAvailable: false/)
    assert.match(
      WEIBO_WORKER_SOURCE,
      /\['search_posts', 'search_users'\]\.includes\(input\.actionId\) \? null : await ensureSelfId/,
    )
    assert.doesNotMatch(WEIBO_WORKER_SOURCE, /__react|reactProps|webpackChunk/)
    assert.doesNotMatch(WEIBO_WORKER_SOURCE, /__vue__|context\.request|page\.request/)
    assert.match(WEIBO_WORKER_SOURCE, /\.lite-msg-list/)
    assert.match(WEIBO_WORKER_SOURCE, /a\[href\*="\/u\/"\]/)
    assert.match(WEIBO_WORKER_SOURCE, /\.card-user-b/)
    assert.match(WEIBO_WORKER_SOURCE, /\.lite-bubble-time,\.lite-bubble-list/)
    assert.match(WEIBO_WORKER_SOURCE, /\.lite-page-editor textarea:not\(\.shadow\)/)
    assert.match(WEIBO_WORKER_SOURCE, /current\.pathname !== '\/message\/chat'/)
    assert.match(
      WEIBO_WORKER_SOURCE,
      /await awaitDispatch\(\);\n {4}const fresh = await prepareMessageComposer/,
    )
    assert.ok(
      WEIBO_WORKER_SOURCE.indexOf('await awaitDispatch();') <
        WEIBO_WORKER_SOURCE.indexOf('liveInput.setInputFiles(files);'),
      'media must not be uploaded before the parent dispatch fence is armed',
    )
    const createPostStart = WEIBO_WORKER_SOURCE.indexOf("if (input.actionId === 'create_post')")
    const createPostEnd = WEIBO_WORKER_SOURCE.indexOf(
      "if (input.actionId === 'set_following')",
      createPostStart,
    )
    const createPostSource = WEIBO_WORKER_SOURCE.slice(createPostStart, createPostEnd)
    assert.doesNotMatch(createPostSource, /force:\s*true|\.evaluate\([^)]*\.click|keyboard\./)
    assert.match(createPostSource, /expectedText.length > 2000/)
    assert.match(createPostSource, /openLongTextComposer/)
    assert.match(createPostSource, /provePostImageControl\(page, editor\)/)
    assert.match(createPostSource, /preparePostImageChooser\(page, freshEditor, files\)/)
    assert.ok(
      createPostSource.indexOf('provePostImageControl(page, editor)')
        < createPostSource.indexOf('await awaitDispatch()'),
    )
    assert.ok(
      createPostSource.indexOf('previewBeforeCount')
        < createPostSource.indexOf('await awaitDispatch()'),
      'preview baselines must be captured before dispatch and the native chooser click',
    )
    assert.ok(
      createPostSource.indexOf('previewBeforeCount')
        < createPostSource.indexOf('preparePostImageChooser(page, freshEditor, files)'),
      'preview baselines must be captured before the native chooser click',
    )
    assert.match(WEIBO_WORKER_SOURCE, /chooser.setFiles\(files\)/)
    assert.match(WEIBO_WORKER_SOURCE, /armFileChooser\(page, image, files\)/)
    assert.ok(
      createPostSource.indexOf('await awaitDispatch()')
        < createPostSource.indexOf('preparePostImageChooser(page, freshEditor, files)'),
    )
    const chooserPrep = createPostSource.indexOf('preparePostImageChooser(page, freshEditor, files)')
    const chooserSetFiles = createPostSource.indexOf('imageChooser.setFiles(files)')
    assert.ok(chooserPrep >= 0 && chooserSetFiles > chooserPrep)
    assert.equal(
      createPostSource.slice(chooserPrep, chooserSetFiles).includes('composerScope'),
      false,
      'setFiles must run before any locator work while a native dialog may be open',
    )
    assert.match(WEIBO_WORKER_SOURCE, /uniqueImageFileInput/)
    assert.match(WEIBO_WORKER_SOURCE, /const scopedInput = await uniqueImageFileInput\(scope\)/)
    assert.match(WEIBO_WORKER_SOURCE, /const liveInput = await uniqueImageFileInput\(scope\)/)
    assert.match(WEIBO_WORKER_SOURCE, /imageToolControl/)
    assert.match(WEIBO_WORKER_SOURCE, /uniqueVisibleClickable/)
    assert.match(WEIBO_WORKER_SOURCE, /wbpro-iconbed/)
    assert.match(WEIBO_WORKER_SOURCE, /normalize-space\(\)="发送"/)
    assert.match(WEIBO_WORKER_SOURCE, /@title="图片" or @aria-label="图片"/)
    assert.match(WEIBO_WORKER_SOURCE, /woo-font--image/)
    assert.match(WEIBO_WORKER_SOURCE, /woo-font--picture/)
    assert.match(WEIBO_WORKER_SOURCE, /imageTitleHits/)
    assert.match(WEIBO_WORKER_SOURCE, /clickableImageToolFromInput/)
    assert.match(WEIBO_WORKER_SOURCE, /uniqueExactText/)
    assert.match(WEIBO_WORKER_SOURCE, /exactTextNearInput/)
    assert.match(WEIBO_WORKER_SOURCE, /uniqueOrNearestImageText/)
    assert.match(WEIBO_WORKER_SOURCE, /clickableExactTextControls/)
    assert.match(WEIBO_WORKER_SOURCE, /provePostImageControl/)
    assert.match(WEIBO_WORKER_SOURCE, /containsBox/)
    assert.match(WEIBO_WORKER_SOURCE, /nodeDelay/)
    assert.match(WEIBO_WORKER_SOURCE, /armFileChooser/)
    assert.match(WEIBO_WORKER_SOURCE, /timedOut/)
    assert.match(WEIBO_WORKER_SOURCE, /clearTimeout\(timer\)/)
    assert.match(WEIBO_WORKER_SOURCE, /finishArmed\('native'/)
    assert.match(WEIBO_WORKER_SOURCE, /emitChooser\('existing'\)/)
    assert.match(WEIBO_WORKER_SOURCE, /if \(scopedInput\) \{\n    emitChooser\('existing'\)/)
    assert.doesNotMatch(WEIBO_WORKER_SOURCE, /picupload\.weibo\.com/)
    assert.doesNotMatch(WEIBO_WORKER_SOURCE, /ajax\/statuses\/update/)
    assert.match(WEIBO_WORKER_SOURCE, /smallVisibleAncestor/)
    assert.match(WEIBO_WORKER_SOURCE, /imageTextHits/)
    assert.match(WEIBO_WORKER_SOURCE, /imageControlHits/)
    assert.match(WEIBO_WORKER_SOURCE, /force: true/)
    assert.match(WEIBO_WORKER_SOURCE, /clickable.click\(\{ timeout: 5_000, force: true, noWaitAfter: true \}\)/)
    assert.match(WEIBO_WORKER_SOURCE, /countImageFileInputs/)
    assert.match(WEIBO_WORKER_SOURCE, /step: 'media.chooser'/)
    assert.match(WEIBO_WORKER_SOURCE, /step: 'media.upload'/)
    assert.match(WEIBO_WORKER_SOURCE, /exactMenuItem\(scope, '图片'\)/)
    assert.match(WEIBO_WORKER_SOURCE, /exactMenuItem\(scope, '本地上传'\)/)
    assert.match(WEIBO_WORKER_SOURCE, /exactMenuItem\(scope, '发送'\)/)
    assert.match(WEIBO_WORKER_SOURCE, /awaitComposerMediaReady/)
    assert.match(WEIBO_WORKER_SOURCE, /collectVisibleImageSrcs/)
    assert.match(createPostSource, /90_000, previewBefore/)
    assert.ok(
      createPostSource.indexOf('previewBeforeCount') <
        createPostSource.indexOf('liveInput.setInputFiles(files)'),
      'preview count/delete baselines must be captured before setFiles',
    )
    assert.match(createPostSource, /throw new Error\('media-upload'\)/)
    assert.ok(
      createPostSource.indexOf("throw new Error('media-upload')") <
        createPostSource.indexOf('awaitComposerMediaReady'),
      'empty file input must fail closed before waiting for preview',
    )
    assert.match(WEIBO_WORKER_SOURCE, /awaitComposerCleared/)
    assert.match(
      createPostSource,
      /awaitPostSendReady\(page, manifest.length \? 90_000 : 30_000, freshEditor\)/,
    )
    assert.ok(
      createPostSource.indexOf('awaitComposerMediaReady') <
        createPostSource.indexOf(
          'awaitPostSendReady(page, manifest.length ? 90_000 : 30_000, freshEditor)',
        ),
      'preview must be ready before send',
    )
    assert.match(WEIBO_WORKER_SOURCE, /setInputFiles/)
    assert.match(WEIBO_WORKER_SOURCE, /exactMenuItem\(page, '长文'\)/)
    assert.doesNotMatch(createPostSource, /cleanText\([^,]+, 2000\)/)
    assert.match(WEIBO_WORKER_SOURCE, /send\.click\(\{ timeout: 10_000, noWaitAfter: true \}\)/)
  })

  test('message reads expose exact empty-response degradation without weakening sends', async () => {
    const emptyResponse = new Error(
      'page.goto: net::ERR_EMPTY_RESPONSE at https://m.weibo.cn/message',
    )
    const messageReads = compileWorkerMessageReadHarness({
      gotoMessagePage: async () => {
        throw emptyResponse
      },
      ensureSelfId: async () => '12345',
      collectMessageThread: async () => {
        throw emptyResponse
      },
    })

    assert.deepEqual(await messageReads.collectMessageThreads({}, 5), {
      threads: [],
      complete: false,
      degradedReason: 'upstream_message_page_empty_response',
    })
    assert.deepEqual(
      await messageReads.actionRead(
        {},
        { actionId: 'get_message_thread', params: { userId: '67890', count: 5 } },
      ),
      {
        messages: [],
        complete: false,
        degradedReason: 'upstream_message_page_empty_response',
      },
    )

    const events: string[] = []
    const writes = compileWorkerPostHarness({
      ensureSelfId: async () => '12345',
      collectMessageThread: async () => {
        throw emptyResponse
      },
      prepareMessageComposer: async () => {
        events.push('prepare')
        return { recipient: '', send: { click: async () => events.push('click') } }
      },
      awaitDispatch: async () => events.push('dispatch'),
      assertNoChallenge: async () => {},
      cleanText: (value: unknown) => String(value).trim(),
    })
    await assert.rejects(
      writes.writeAction(
        {},
        { actionId: 'send_message', params: { userId: '67890', text: 'hello' } },
      ),
      /ERR_EMPTY_RESPONSE/,
    )
    assert.deepEqual(events, [])
  })

  test('message reads keep non-empty-response failures fail-closed', async () => {
    const failure = new Error('page.goto: net::ERR_CONNECTION_RESET')
    const messageReads = compileWorkerMessageReadHarness({
      gotoMessagePage: async () => {
        throw failure
      },
      ensureSelfId: async () => '12345',
      collectMessageThread: async () => {
        throw failure
      },
    })

    await assert.rejects(messageReads.collectMessageThreads({}, 5), /ERR_CONNECTION_RESET/)
    await assert.rejects(
      messageReads.actionRead(
        {},
        { actionId: 'get_message_thread', params: { userId: '67890', count: 5 } },
      ),
      /ERR_CONNECTION_RESET/,
    )

    const suffixedFailure = new Error('page.goto: net::ERR_EMPTY_RESPONSE_SUFFIX')
    const suffixed = compileWorkerMessageReadHarness({
      gotoMessagePage: async () => {
        throw suffixedFailure
      },
      ensureSelfId: async () => '12345',
      collectMessageThread: async () => {
        throw suffixedFailure
      },
    })
    await assert.rejects(suffixed.collectMessageThreads({}, 5), /ERR_EMPTY_RESPONSE_SUFFIX/)
    await assert.rejects(
      suffixed.actionRead(
        {},
        { actionId: 'get_message_thread', params: { userId: '67890', count: 5 } },
      ),
      /ERR_EMPTY_RESPONSE_SUFFIX/,
    )
  })

  test('create_post proves pointer actionability before dispatch and clicks exactly once', async () => {
    const events: string[] = []
    let collectCount = 0
    const { cleanPostText } = compileWorkerPostTextHarness()
    const textarea = {
      fill: async () => events.push('fill'),
      inputValue: async () => 'hello',
    }
    const send = {
      isDisabled: async () => false,
      click: async (options: { trial?: boolean; timeout: number; noWaitAfter?: boolean }) => {
        events.push(options.trial ? `trial:${options.timeout}` : 'click')
      },
    }
    const harness = compileWorkerPostHarness({
      ensureSelfId: async () => '12345',
      gotoAuthenticated: async () => events.push('goto'),
      collectPosts: async () => {
        collectCount += 1
        events.push('collect')
        return collectCount === 1
          ? []
          : [
              {
                id: 'new-post',
                owned: true,
                text: cleanPostText('hello \u200B\u200B\u200B', 20_000),
              },
            ]
      },
      uniqueVisible: async () => textarea,
      assertNoChallenge: async () => events.push('challenge'),
      awaitDispatch: async () => events.push('dispatch'),
      exactMenuItem: async () => send,
      cleanText: (value: unknown) => String(value).trim(),
      readFile: async () => Buffer.from('unused'),
    })
    const page = {
      locator: () => ({}),
      waitForTimeout: async (ms: number) => events.push(`wait:${ms}`),
    }

    const result = await harness.writeAction(page, {
      actionId: 'create_post',
      params: { text: 'hello', mediaManifest: [] },
    })

    assert.deepEqual(result, { post: { id: 'new-post', owned: true, text: 'hello' } })
    assert.equal(events.filter((event) => event === 'click').length, 1)
    assert.ok(events.indexOf('trial:250') < events.indexOf('dispatch'))
    assert.ok(events.indexOf('dispatch') < events.indexOf('trial:10000'))
    assert.ok(events.indexOf('trial:10000') < events.indexOf('click'))
  })

  test('post text removes only the exact terminal Weibo DOM marker', () => {
    const { cleanPostText } = compileWorkerPostTextHarness()
    assert.equal(cleanPostText('hello', 20_000), 'hello')
    assert.equal(cleanPostText('hel\u200Blo', 20_000), 'hel\u200Blo')
    assert.equal(cleanPostText('hello \u200B\u200B\u200B', 20_000), 'hello')
    assert.equal(cleanPostText('hello\u200B\u200B\u200B', 20_000), 'hello\u200B\u200B\u200B')
    assert.equal(cleanPostText('hello \u200B\u200B', 20_000), 'hello \u200B\u200B')
  })

  test('desktop post projection removes the terminal Weibo DOM marker', async () => {
    const { projectPost } = compileWorkerProjectPostHarness()
    const post = await projectPost(
      {
        evaluate: async () => ({
          id: 'R9JtO5slV',
          userId: '5171571710',
          authorName: 'OpenClaude',
          text: 'Hello World 2026 \u200B\u200B\u200B',
          createdAt: '2026-07-21 19:18',
          url: 'https://weibo.com/5171571710/R9JtO5slV',
          liked: false,
          likeText: '',
          commentText: '',
          repostText: '',
          images: [],
        }),
      },
      '5171571710',
    )
    assert.equal(post.text, 'Hello World 2026')
  })

  test('create_post never dispatches or clicks when pre-dispatch trial fails', async () => {
    const events: string[] = []
    const textarea = { fill: async () => {}, inputValue: async () => 'hello' }
    const send = {
      isDisabled: async () => false,
      click: async (options: { trial?: boolean }) => {
        events.push(options.trial ? 'trial' : 'click')
        if (options.trial) throw new Error('not actionable')
      },
    }
    const harness = compileWorkerPostHarness({
      ensureSelfId: async () => '12345',
      gotoAuthenticated: async () => {},
      collectPosts: async () => [],
      uniqueVisible: async () => textarea,
      assertNoChallenge: async () => {},
      awaitDispatch: async () => events.push('dispatch'),
      exactMenuItem: async () => send,
      cleanText: (value: unknown) => String(value).trim(),
      readFile: async () => Buffer.from('unused'),
    })

    await assert.rejects(
      harness.writeAction(
        { locator: () => ({}), waitForTimeout: async () => {} },
        { actionId: 'create_post', params: { text: 'hello', mediaManifest: [] } },
      ),
      /send/,
    )
    assert.ok(events.length > 0)
    assert.ok(events.every((event) => event === 'trial'))
  })

  test('create_post resolves an ambiguous click from delayed read-only observation', async () => {
    let collectCount = 0
    let realClicks = 0
    const textarea = { fill: async () => {}, inputValue: async () => 'hello' }
    const send = {
      isDisabled: async () => false,
      click: async (options: { trial?: boolean }) => {
        if (!options.trial) {
          realClicks += 1
          throw Object.assign(new Error('click timeout'), { name: 'TimeoutError' })
        }
      },
    }
    const harness = compileWorkerPostHarness({
      ensureSelfId: async () => '12345',
      gotoAuthenticated: async () => {},
      collectPosts: async () => {
        collectCount += 1
        return collectCount < 4 ? [] : [{ id: 'late-post', owned: true, text: 'hello' }]
      },
      uniqueVisible: async () => textarea,
      assertNoChallenge: async () => {},
      awaitDispatch: async () => {},
      exactMenuItem: async () => send,
      cleanText: (value: unknown) => String(value).trim(),
      readFile: async () => Buffer.from('unused'),
    })

    const result = await harness.writeAction(
      { locator: () => ({}), waitForTimeout: async () => {} },
      { actionId: 'create_post', params: { text: 'hello', mediaManifest: [] } },
    )
    assert.deepEqual(result, { post: { id: 'late-post', owned: true, text: 'hello' } })
    assert.equal(realClicks, 1)
    assert.equal(collectCount, 4)
  })

  test('create_post refuses duplicate observations and keeps media behind dispatch', async () => {
    const events: string[] = []
    let collectCount = 0
    let realClicks = 0
    const textarea = {
      fill: async () => {},
      inputValue: async () => (events.includes('click') ? '' : 'hello'),
    }
    const send = {
      isDisabled: async () => false,
      click: async (options: { trial?: boolean }) => {
        if (!options.trial) {
          realClicks += 1
          events.push('click')
        }
      },
    }
    const imageTrigger = {
      click: async (options: { trial?: boolean }) =>
        events.push(options.trial ? 'image-trial' : 'image-click'),
    }
    const chooserElement = {
      evaluate: async () => 1,
    }
    const imageChooser = {
      setFiles: async () => events.push('upload'),
      element: () => chooserElement,
    }
    const harness = compileWorkerPostHarness({
      ensureSelfId: async () => '12345',
      gotoAuthenticated: async () => {},
      collectPosts: async () => {
        collectCount += 1
        return collectCount === 1
          ? []
          : [
              { id: 'duplicate-a', owned: true, text: 'hello' },
              { id: 'duplicate-b', owned: true, text: 'hello' },
            ]
      },
      uniqueVisible: async () => textarea,
      assertNoChallenge: async () => {},
      awaitDispatch: async () => events.push('dispatch'),
      exactMenuItem: async (_page: unknown, text: string) =>
        text === '图片' ? imageTrigger : send,
      cleanText: (value: unknown) => String(value).trim(),
      readFile: async () => Buffer.from('image'),
    })
    const page = {
      locator: (selector: string) => (selector === 'img' ? uploadedImageLocator(events) : {}),
      waitForEvent: async () => imageChooser,
      waitForTimeout: async () => {},
    }

    await assert.rejects(
      harness.writeAction(page, {
        actionId: 'create_post',
        params: {
          text: 'hello',
          mediaManifest: [{ inputId: 'asset-1', filename: 'image.png', mimeType: 'image/png' }],
        },
      }),
      /result/,
    )
    assert.equal(realClicks, 1)
    assert.equal(collectCount, 9)
    assert.ok(events.indexOf('dispatch') < events.indexOf('image-click'))
    assert.ok(events.indexOf('dispatch') < events.indexOf('upload'))
    assert.ok(events.indexOf('upload') < events.indexOf('click'))
  })

  test('create_post with media never dispatches when the composer image chooser is absent', async () => {
    const events: string[] = []
    const textarea = { fill: async () => {}, inputValue: async () => 'hello' }
    const harness = compileWorkerPostHarness({
      ensureSelfId: async () => '12345',
      gotoAuthenticated: async () => {},
      collectPosts: async () => [],
      uniqueVisible: async () => textarea,
      assertNoChallenge: async () => {},
      awaitDispatch: async () => events.push('dispatch'),
      exactMenuItem: async () => null,
      cleanText: (value: unknown) => String(value).trim(),
      readFile: async () => Buffer.from('unused'),
    })

    await assert.rejects(
      harness.writeAction(
        { locator: () => ({}), waitForTimeout: async () => {} },
        {
          actionId: 'create_post',
          params: {
            text: 'hello',
            mediaManifest: [{ inputId: 'asset-1', filename: 'image.png', mimeType: 'image/png' }],
          },
        },
      ),
      /media/,
    )
    assert.deepEqual(events, [])
  })

  test('create_post does not dispatch a page-level file input outside composer scope', async () => {
    const events: string[] = []
    const empty = { count: async () => 0, nth: () => ({}) }
    const textarea = {
      fill: async () => {},
      inputValue: async () => 'hello',
      locator: (selector: string) => {
        if (String(selector).includes('发送')) return { count: async () => 1, locator: () => empty }
        return empty
      },
    }
    const harness = compileWorkerPostHarness({
      ensureSelfId: async () => '12345',
      gotoAuthenticated: async () => {},
      collectPosts: async () => [],
      uniqueVisible: async () => textarea,
      assertNoChallenge: async () => {},
      awaitDispatch: async () => events.push('dispatch'),
      exactMenuItem: async () => null,
      cleanText: (value: unknown) => String(value).trim(),
      readFile: async () => Buffer.from('unused'),
    })
    const page = {
      locator: (selector: string) => {
        if (selector === 'input[type="file"]') {
          return {
            count: async () => 1,
            nth: () => ({
              evaluate: async (
                fn: (node: { isConnected: boolean; files: { length: number } }) => unknown,
              ) => fn({ isConnected: true, files: { length: 0 } }),
              getAttribute: async () => 'image/*',
              setInputFiles: async () => events.push('upload'),
            }),
          }
        }
        return empty
      },
      waitForEvent: async () => null,
      waitForTimeout: async () => {},
    }

    await assert.rejects(
      harness.writeAction(page, {
        actionId: 'create_post',
        params: {
          text: 'hello',
          mediaManifest: [{ inputId: 'asset-1', filename: 'image.png', mimeType: 'image/png' }],
        },
      }),
      /media/,
    )
    assert.deepEqual(events, [])
  })

  test('create_post uses a unique composer file input when 图片 is absent', async () => {
    const events: string[] = []
    const empty = { count: async () => 0, nth: () => ({}) }
    const fileInput = {
      setInputFiles: async () => events.push('upload'),
      evaluate: async (
        fn: (node: { isConnected: boolean; files: { length: number } }) => unknown,
      ) => fn({ isConnected: true, files: { length: events.includes('upload') ? 1 : 0 } }),
      getAttribute: async () => 'image/*',
      click: async (options?: { trial?: boolean }) => {
        if (!options?.trial) events.push('input-click')
      },
      locator: () => empty,
    }
    const composer = {
      count: async () => 1,
      locator: (selector: string) => {
        if (selector === 'input[type="file"]') return { count: async () => 1, nth: () => fileInput }
        if (selector === 'img') return uploadedImageLocator(events)
        return empty
      },
    }
    const textarea = {
      fill: async () => {},
      inputValue: async () => (events.includes('click') ? '' : 'hello'),
      locator: (selector: string) => (String(selector).includes('发送') ? composer : empty),
    }
    const send = {
      click: async (options: { trial?: boolean }) => {
        if (!options.trial) events.push('click')
      },
    }
    const harness = compileWorkerPostHarness({
      ensureSelfId: async () => '12345',
      gotoAuthenticated: async () => {},
      collectPosts: async () =>
        events.includes('upload') ? [{ id: 'native-input', owned: true, text: 'hello' }] : [],
      uniqueVisible: async () => textarea,
      assertNoChallenge: async () => {},
      awaitDispatch: async () => events.push('dispatch'),
      exactMenuItem: async (_page: unknown, text: string) => (text === '发送' ? send : null),
      cleanText: (value: unknown) => String(value).trim(),
      readFile: async () => Buffer.from('image'),
    })
    const page = {
      locator: (selector: string) => {
        if (selector === 'img') return uploadedImageLocator(events)
        return empty
      },
      waitForEvent: async () => {
        events.push('filechooser')
        return {
          setFiles: async () => events.push('upload'),
          element: () => fileInput,
        }
      },
      waitForTimeout: async () => {},
    }
    const result = await harness.writeAction(page, {
      actionId: 'create_post',
      params: {
        text: 'hello',
        mediaManifest: [{ inputId: 'asset-1', filename: 'image.png', mimeType: 'image/png' }],
      },
    })
    assert.deepEqual(result, { post: { id: 'native-input', owned: true, text: 'hello' } })
    assert.ok(events.includes('dispatch'))
    assert.ok(events.includes('upload'))
    assert.equal(events.includes('input-click'), false)
    assert.equal(events.includes('filechooser'), false)
  })

  test('create_post does not dispatch an unarmed composer file input', async () => {
    const events: string[] = []
    const empty = { count: async () => 0, nth: () => ({}) }
    const fileInput = {
      setInputFiles: async () => events.push('upload'),
      evaluate: async (
        fn: (node: { isConnected: boolean; files: { length: number } }) => unknown,
      ) => fn({ isConnected: true, files: { length: 0 } }),
      getAttribute: async () => 'image/*',
      click: async (options?: { trial?: boolean }) => {
        if (!options?.trial) events.push('input-click')
      },
      locator: () => empty,
    }
    const composer = {
      count: async () => 1,
      locator: (selector: string) => {
        if (selector === 'input[type="file"]') return { count: async () => 1, nth: () => fileInput }
        return empty
      },
    }
    const textarea = {
      fill: async () => {},
      inputValue: async () => 'hello',
      locator: (selector: string) => (String(selector).includes('发送') ? composer : empty),
    }
    const harness = compileWorkerPostHarness({
      ensureSelfId: async () => '12345',
      gotoAuthenticated: async () => {},
      collectPosts: async () => [],
      uniqueVisible: async () => textarea,
      assertNoChallenge: async () => {},
      awaitDispatch: async () => events.push('dispatch'),
      exactMenuItem: async () => null,
      cleanText: (value: unknown) => String(value).trim(),
      readFile: async () => Buffer.from('unused'),
    })
    const page = {
      locator: () => empty,
      waitForEvent: async () => {
        events.push('filechooser')
        throw new Error('filechooser should not open')
      },
      waitForTimeout: async () => {},
    }
    await assert.rejects(
      harness.writeAction(page, {
        actionId: 'create_post',
        params: {
          text: 'hello',
          mediaManifest: [{ inputId: 'asset-1', filename: 'image.png', mimeType: 'image/png' }],
        },
      }),
      /media/,
    )
    assert.ok(events.includes('dispatch'))
    assert.equal(events.includes('upload'), true)
    assert.equal(events.includes('click'), false)
  })

  test('create_post uses a unique hidden composer file input without a native chooser', async () => {
    const events: string[] = []
    const textarea = {
      fill: async () => {},
      inputValue: async () => (events.includes('click') ? '' : 'hello'),
    }
    const fileInput = {
      setInputFiles: async () => events.push('upload'),
      evaluate: async (
        fn: (node: { isConnected: boolean; files: { length: number } }) => unknown,
      ) => fn({ isConnected: true, files: { length: events.includes('upload') ? 1 : 0 } }),
      getAttribute: async () => 'image/*',
    }
    const send = {
      click: async (options: { trial?: boolean }) => {
        if (!options.trial) events.push('click')
      },
    }
    const harness = compileWorkerPostHarness({
      ensureSelfId: async () => '12345',
      gotoAuthenticated: async () => {},
      collectPosts: async () =>
        events.includes('upload') ? [{ id: 'hidden-input', owned: true, text: 'hello' }] : [],
      uniqueVisible: async () => textarea,
      assertNoChallenge: async () => {},
      awaitDispatch: async () => events.push('dispatch'),
      exactMenuItem: async (_page: unknown, text: string) => {
        if (text === '图片') {
          events.push('image-menu')
          return {
            click: async (options?: { trial?: boolean }) => {
              if (!options?.trial) events.push('image-click')
            },
          }
        }
        if (text === '发送') return send
        return null
      },
      cleanText: (value: unknown) => String(value).trim(),
      readFile: async () => Buffer.from('image'),
    })
    const page = {
      locator: (selector: string) => {
        if (selector === 'input[type="file"]') return { count: async () => 1, nth: () => fileInput }
        if (selector === 'img') return uploadedImageLocator(events)
        return {}
      },
      waitForEvent: async () => {
        events.push('filechooser')
        throw new Error('filechooser should not open')
      },
      waitForTimeout: async () => {},
    }

    const result = await harness.writeAction(page, {
      actionId: 'create_post',
      params: {
        text: 'hello',
        mediaManifest: [{ inputId: 'asset-1', filename: 'image.png', mimeType: 'image/png' }],
      },
    })
    assert.deepEqual(result, { post: { id: 'hidden-input', owned: true, text: 'hello' } })
    assert.ok(events.indexOf('dispatch') < events.indexOf('upload'))
    assert.ok(events.includes('image-click'))
    assert.deepEqual(events.filter((event) => event !== 'image-menu' && event !== 'filechooser'), ['dispatch', 'image-click', 'upload', 'click'])
  })

  test('create_post waits for composer 发送 after upload and ignores extra 发送', async () => {
    const events: string[] = []
    const fileInput = {
      setInputFiles: async () => events.push('upload'),
      evaluate: async (
        fn: (node: { isConnected: boolean; files: { length: number } }) => unknown,
      ) => fn({ isConnected: true, files: { length: events.includes('upload') ? 1 : 0 } }),
      getAttribute: async () => 'image/*',
    }
    const composerRoot = {
      count: async () => 1,
      locator: (selector: string) => {
        if (selector === 'input[type="file"]') return { count: async () => 1, nth: () => fileInput }
        if (selector === 'img') return uploadedImageLocator(events)
        return {}
      },
    }
    const textarea = {
      fill: async () => {},
      inputValue: async () => (events.includes('click') ? '' : 'hello'),
      locator: () => composerRoot,
    }
    const send = {
      click: async (options: { trial?: boolean }) => {
        if (!events.includes('upload')) throw new Error('disabled')
        if (!options.trial) events.push('click')
      },
    }
    const harness = compileWorkerPostHarness({
      ensureSelfId: async () => '12345',
      gotoAuthenticated: async () => {},
      collectPosts: async () =>
        events.includes('click') ? [{ id: 'scoped-send', owned: true, text: 'hello' }] : [],
      uniqueVisible: async () => textarea,
      assertNoChallenge: async () => {},
      awaitDispatch: async () => events.push('dispatch'),
      exactMenuItem: async (root: unknown, text: string) => {
        if (text === '图片') {
          return {
            click: async (options?: { trial?: boolean }) => {
              if (!options?.trial) events.push('image-click')
            },
          }
        }
        if (text === '发送') {
          events.push(root === composerRoot ? 'send-scope' : 'send-page')
          return root === composerRoot ? send : { click: async () => events.push('comment-send') }
        }
        return null
      },
      cleanText: (value: unknown) => String(value).trim(),
      readFile: async () => Buffer.from('image'),
    })
    const page = {
      locator: () => ({}),
      waitForEvent: async () => {
        throw new Error('filechooser should not open')
      },
      waitForTimeout: async () => {},
    }

    const result = await harness.writeAction(page, {
      actionId: 'create_post',
      params: {
        text: 'hello',
        mediaManifest: [{ inputId: 'asset-1', filename: 'image.png', mimeType: 'image/png' }],
      },
    })
    assert.deepEqual(result, { post: { id: 'scoped-send', owned: true, text: 'hello' } })
    assert.ok(!events.includes('send-page'))
    assert.ok(!events.includes('image-menu'))
    assert.ok(!events.includes('comment-send'))
    assert.ok(events.includes('send-scope'))
    assert.deepEqual(
      events.filter((event) => event !== 'send-scope'),
      ['dispatch', 'image-click', 'upload', 'click'],
    )
  })

  test('create_post does not click send until composer preview count matches files', async () => {
    const events: string[] = []
    const textarea = { fill: async () => {}, inputValue: async () => 'hello' }
    const imageTrigger = {
      click: async (options: { trial?: boolean }) =>
        events.push(options.trial ? 'image-trial' : 'image-click'),
    }
    const imageChooser = {
      setFiles: async () => events.push('upload'),
      element: () => ({ evaluate: async () => 1 }),
    }
    const send = {
      click: async (options: { trial?: boolean }) => {
        if (!options.trial) events.push('click')
      },
    }
    const harness = compileWorkerPostHarness({
      ensureSelfId: async () => '12345',
      gotoAuthenticated: async () => {},
      collectPosts: async () => [],
      uniqueVisible: async () => textarea,
      assertNoChallenge: async () => {},
      awaitDispatch: async () => events.push('dispatch'),
      exactMenuItem: async (_page: unknown, text: string) =>
        text === '图片' ? imageTrigger : send,
      cleanText: (value: unknown) => String(value).trim(),
      readFile: async () => Buffer.from('image'),
    })

    await assert.rejects(
      harness.writeAction(
        {
          locator: () => ({}),
          waitForEvent: async () => imageChooser,
          waitForTimeout: async () => {},
        },
        {
          actionId: 'create_post',
          params: {
            text: 'hello',
            mediaManifest: [{ inputId: 'asset-1', filename: 'image.png', mimeType: 'image/png' }],
          },
        },
      ),
      /media/,
    )
    assert.ok(!events.includes('click'))
    assert.ok(events.indexOf('dispatch') < events.indexOf('image-click'))
    assert.ok(events.indexOf('dispatch') < events.indexOf('upload'))
    assert.ok(events.includes('image-click') && events.includes('upload'))
  })

  test('create_post ignores https avatar images when waiting for upload preview', async () => {
    const events: string[] = []
    const textarea = { fill: async () => {}, inputValue: async () => 'hello' }
    const imageTrigger = {
      click: async (options: { trial?: boolean }) =>
        events.push(options.trial ? 'image-trial' : 'image-click'),
    }
    const imageChooser = {
      setFiles: async () => events.push('upload'),
      element: () => ({ evaluate: async () => 1 }),
    }
    const avatar = {
      count: async () => 1,
      nth: () => ({
        isVisible: async () => true,
        getAttribute: async () => 'https://tvax1.sinaimg.cn/crop.0.0.1080.1080.50/avatar.jpg',
      }),
    }
    const harness = compileWorkerPostHarness({
      ensureSelfId: async () => '12345',
      gotoAuthenticated: async () => {},
      collectPosts: async () => [],
      uniqueVisible: async () => textarea,
      assertNoChallenge: async () => {},
      awaitDispatch: async () => events.push('dispatch'),
      exactMenuItem: async (_page: unknown, text: string) =>
        text === '图片' ? imageTrigger : { click: async () => events.push('click') },
      cleanText: (value: unknown) => String(value).trim(),
      readFile: async () => Buffer.from('image'),
    })

    await assert.rejects(
      harness.writeAction(
        {
          locator: (selector: string) => (selector === 'img' ? avatar : {}),
          waitForEvent: async () => imageChooser,
          waitForTimeout: async () => {},
        },
        {
          actionId: 'create_post',
          params: {
            text: 'hello',
            mediaManifest: [{ inputId: 'asset-1', filename: 'image.png', mimeType: 'image/png' }],
          },
        },
      ),
      /media/,
    )
    assert.ok(!events.includes('click'))
    assert.ok(events.indexOf('dispatch') < events.indexOf('image-click'))
    assert.ok(events.indexOf('dispatch') < events.indexOf('upload'))
    assert.ok(events.includes('image-click') && events.includes('upload'))
  })

  test('create_post opens 本地上传 when 图片 does not raise a native chooser', async () => {
    const events: string[] = []
    const textarea = {
      fill: async () => {},
      inputValue: async () => (events.includes('click') ? '' : 'hello'),
    }
    let localClicked = false
    const imageTrigger = {
      click: async (options: { trial?: boolean }) =>
        events.push(options.trial ? 'image-trial' : 'image-click'),
    }
    const localTrigger = {
      click: async (options: { trial?: boolean }) => {
        localClicked = true
        events.push(options.trial ? 'local-trial' : 'local-click')
      },
    }
    const imageChooser = {
      setFiles: async () => events.push('upload'),
      element: () => ({ evaluate: async () => 1 }),
    }
    const send = {
      click: async (options: { trial?: boolean }) => {
        if (!options.trial) events.push('click')
      },
    }
    let collectCount = 0
    const harness = compileWorkerPostHarness({
      ensureSelfId: async () => '12345',
      gotoAuthenticated: async () => {},
      collectPosts: async () => {
        collectCount += 1
        return collectCount === 1 ? [] : [{ id: 'local-upload', owned: true, text: 'hello' }]
      },
      uniqueVisible: async () => textarea,
      assertNoChallenge: async () => {},
      awaitDispatch: async () => events.push('dispatch'),
      exactMenuItem: async (_page: unknown, text: string) => {
        if (text === '图片') return imageTrigger
        if (text === '本地上传') return events.includes('image-click') ? localTrigger : null
        return send
      },
      cleanText: (value: unknown) => String(value).trim(),
      readFile: async () => Buffer.from('image'),
    })
    const page = {
      locator: (selector: string) => (selector === 'img' ? uploadedImageLocator(events) : {}),
      waitForEvent: async () => {
        const deadline = Date.now() + 250
        while (Date.now() < deadline) {
          if (localClicked) return imageChooser
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('Timeout')
      },
      waitForTimeout: async () => {},
    }

    const result = await harness.writeAction(page, {
      actionId: 'create_post',
      params: {
        text: 'hello',
        mediaManifest: [{ inputId: 'asset-1', filename: 'image.png', mimeType: 'image/png' }],
      },
    })
    assert.deepEqual(result, { post: { id: 'local-upload', owned: true, text: 'hello' } })
    assert.deepEqual(events, [
      'dispatch',
      'image-click',
      'local-click',
      'upload',
      'click',
    ])
  })

  test('create_post opens 长文 before attaching images when the body exceeds 2000 characters', async () => {
    const events: string[] = []
    const longText = '汉'.repeat(2001)
    let filled = ''
    const textarea = {
      fill: async (value: string) => {
        filled = value
      },
      inputValue: async () => filled,
    }
    const longOpener = {
      click: async () => events.push('long-text'),
    }
    const send = {
      click: async (options: { trial?: boolean }) => {
        if (!options.trial) {
          events.push('click')
          filled = ''
        }
      },
    }
    const imageTrigger = {
      click: async (options: { trial?: boolean }) =>
        events.push(options.trial ? 'image-trial' : 'image-click'),
    }
    const imageChooser = {
      setFiles: async () => events.push('upload'),
      element: () => ({ evaluate: async () => 1 }),
    }
    let collectCount = 0
    const harness = compileWorkerPostHarness({
      ensureSelfId: async () => '12345',
      gotoAuthenticated: async () => {},
      collectPosts: async () => {
        collectCount += 1
        return collectCount === 1 ? [] : [{ id: 'long-post', owned: true, text: longText }]
      },
      uniqueVisible: async () => textarea,
      assertNoChallenge: async () => {},
      awaitDispatch: async () => events.push('dispatch'),
      exactMenuItem: async (_page: unknown, text: string) => {
        if (text === '长文') return longOpener
        if (text === '图片') return imageTrigger
        return send
      },
      cleanText: (value: unknown) => String(value).trim(),
      readFile: async () => Buffer.from('image'),
    })
    const page = {
      locator: (selector: string) => (selector === 'img' ? uploadedImageLocator(events) : {}),
      waitForEvent: async () => imageChooser,
      waitForTimeout: async () => {},
    }

    const result = await harness.writeAction(page, {
      actionId: 'create_post',
      params: {
        text: longText,
        mediaManifest: [{ inputId: 'asset-1', filename: 'image.png', mimeType: 'image/png' }],
      },
    })
    assert.deepEqual(result, { post: { id: 'long-post', owned: true, text: longText } })
    assert.equal(filled, '')
    assert.ok(events.indexOf('long-text') < events.indexOf('dispatch'))
    assert.ok(events.indexOf('dispatch') < events.indexOf('image-click'))
    assert.ok(events.indexOf('dispatch') < events.indexOf('upload'))
    assert.ok(events.indexOf('upload') < events.indexOf('click'))
    assert.ok(events.indexOf('image-click') < events.indexOf('click'))
  })

  test('create_post keeps long text plus images on the default composer when 长文 is absent', async () => {
    const events: string[] = []
    const longText = '汉'.repeat(2001)
    let filled = ''
    const textarea = {
      fill: async (value: string) => {
        filled = value
      },
      inputValue: async () => filled,
    }
    const send = {
      click: async (options: { trial?: boolean }) => {
        if (!options.trial) {
          events.push('click')
          filled = ''
        }
      },
    }
    const imageTrigger = {
      click: async (options: { trial?: boolean }) =>
        events.push(options.trial ? 'image-trial' : 'image-click'),
    }
    const imageChooser = {
      setFiles: async () => events.push('upload'),
      element: () => ({ evaluate: async () => 1 }),
    }
    let collectCount = 0
    const harness = compileWorkerPostHarness({
      ensureSelfId: async () => '12345',
      gotoAuthenticated: async () => {},
      collectPosts: async () => {
        collectCount += 1
        return collectCount === 1 ? [] : [{ id: 'plain-long', owned: true, text: longText }]
      },
      uniqueVisible: async () => textarea,
      assertNoChallenge: async () => {},
      awaitDispatch: async () => events.push('dispatch'),
      exactMenuItem: async (_page: unknown, text: string) => {
        if (text === '长文') return null
        if (text === '图片') return imageTrigger
        return send
      },
      cleanText: (value: unknown) => String(value).trim(),
      readFile: async () => Buffer.from('image'),
    })
    const result = await harness.writeAction(
      {
        locator: (selector: string) => (selector === 'img' ? uploadedImageLocator(events) : {}),
        waitForEvent: async () => imageChooser,
        waitForTimeout: async () => {},
      },
      {
        actionId: 'create_post',
        params: {
          text: longText,
          mediaManifest: [{ inputId: 'asset-1', filename: 'image.png', mimeType: 'image/png' }],
        },
      },
    )
    assert.deepEqual(result, { post: { id: 'plain-long', owned: true, text: longText } })
    assert.equal(filled, '')
    assert.ok(events.indexOf('dispatch') < events.indexOf('image-click'))
    assert.ok(events.indexOf('dispatch') < events.indexOf('upload'))
    assert.ok(events.indexOf('upload') < events.indexOf('click'))
    assert.ok(events.indexOf('image-click') < events.indexOf('click'))
  })

  test('create_post never dispatches when the composer truncates long text', async () => {
    const events: string[] = []
    const longText = '汉'.repeat(2001)
    const textarea = {
      fill: async () => {},
      inputValue: async () => longText.slice(0, 2000),
    }
    const harness = compileWorkerPostHarness({
      ensureSelfId: async () => '12345',
      gotoAuthenticated: async () => {},
      collectPosts: async () => [],
      uniqueVisible: async () => textarea,
      assertNoChallenge: async () => {},
      awaitDispatch: async () => events.push('dispatch'),
      exactMenuItem: async () => null,
      cleanText: (value: unknown, max?: number) =>
        String(value)
          .trim()
          .slice(0, max ?? 20000),
      readFile: async () => Buffer.from('unused'),
    })

    await assert.rejects(
      harness.writeAction(
        { locator: () => ({}), waitForTimeout: async () => {} },
        {
          actionId: 'create_post',
          params: { text: longText, mediaManifest: [] },
        },
      ),
      /composer/,
    )
    assert.deepEqual(events, [])
  })

  test('create_post never clicks send when the chooser reports a different file count', async () => {
    const events: string[] = []
    const textarea = { fill: async () => {}, inputValue: async () => 'hello' }
    const imageTrigger = {
      click: async (options: { trial?: boolean }) =>
        events.push(options.trial ? 'image-trial' : 'image-click'),
    }
    const imageChooser = {
      setFiles: async () => events.push('upload'),
      element: () => ({ evaluate: async () => 0 }),
    }
    const harness = compileWorkerPostHarness({
      ensureSelfId: async () => '12345',
      gotoAuthenticated: async () => {},
      collectPosts: async () => [],
      uniqueVisible: async () => textarea,
      assertNoChallenge: async () => {},
      awaitDispatch: async () => events.push('dispatch'),
      exactMenuItem: async (_page: unknown, text: string) =>
        text === '图片' ? imageTrigger : { click: async () => events.push('send') },
      cleanText: (value: unknown) => String(value).trim(),
      readFile: async () => Buffer.from('image'),
    })

    await assert.rejects(
      harness.writeAction(
        {
          locator: () => ({}),
          waitForEvent: async () => imageChooser,
          waitForTimeout: async () => {},
        },
        {
          actionId: 'create_post',
          params: {
            text: 'hello',
            mediaManifest: [{ inputId: 'asset-1', filename: 'image.png', mimeType: 'image/png' }],
          },
        },
      ),
      /media/,
    )
    assert.ok(events.indexOf('dispatch') < events.indexOf('image-click'))
    assert.ok(events.indexOf('dispatch') < events.indexOf('upload'))
    assert.ok(events.includes('image-click') && events.includes('upload'))
    assert.ok(!events.includes('send'))
  })

  test(
    'real Chromium uses the lazy composer chooser and waits for delayed media readiness',
    { timeout: 30_000 },
    async () => {
      const browserResolverModule = '../../../../scripts/lib/resolve-browser.mjs'
      const { resolveBrowserExecutable } = (await import(browserResolverModule)) as {
        resolveBrowserExecutable(): string
      }
      const browser = await chromium.launch({
        executablePath: resolveBrowserExecutable(),
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      })
      try {
        const page = await browser.newPage()
        await page.setContent(`<!doctype html>
          <textarea></textarea>
          <button id="image">图片</button>
          <button id="send" disabled>发送</button>
          <script>
            window.imageClicks = 0;
            window.sendClicks = 0;
            document.querySelector('#image').addEventListener('click', () => {
              window.imageClicks += 1;
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = 'image/*';
              input.multiple = true;
              input.hidden = true;
              input.addEventListener('change', () => {
                const preview = document.createElement('img');
                preview.alt = 'preview';
                preview.src = 'blob:https://weibo.com/preview';
                document.body.append(preview);
                setTimeout(() => { document.querySelector('#send').disabled = false; }, 400);
              });
              document.body.append(input);
              input.click();
            });
            document.querySelector('#send').addEventListener('click', () => {
              window.sendClicks += 1;
              const textarea = document.querySelector('textarea');
              const post = document.createElement('article');
              post.dataset.id = 'new-post';
              post.textContent = textarea.value;
              textarea.value = '';
              document.body.append(post);
            });
          </script>`)
        let collectCount = 0
        const harness = compileWorkerPostHarness({
          ensureSelfId: async () => '12345',
          gotoAuthenticated: async () => {},
          collectPosts: async (targetPage: typeof page) => {
            collectCount += 1
            return targetPage.locator('article[data-id]').evaluateAll((articles) =>
              articles.map((article) => ({
                id: article.getAttribute('data-id'),
                owned: true,
                text: article.textContent?.trim() ?? '',
              })),
            )
          },
          uniqueVisible: async (locator: unknown) => locator,
          assertNoChallenge: async () => {},
          awaitDispatch: async () => {},
          exactMenuItem: async (targetPage: typeof page, text: string) => {
            const locator = targetPage.getByRole('button', { name: text, exact: true })
            return (await locator.count()) === 1 ? locator : null
          },
          cleanText: (value: unknown) => String(value).trim(),
          readFile: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        })

        const started = Date.now()
        const result = await harness.writeAction(page, {
          actionId: 'create_post',
          params: {
            text: 'hello',
            mediaManifest: [{ inputId: 'asset-1', filename: 'image.png', mimeType: 'image/png' }],
          },
        })
        assert.deepEqual(result, { post: { id: 'new-post', owned: true, text: 'hello' } })
        assert.ok(Date.now() - started >= 350, 'send must wait for delayed media readiness')
        assert.equal(await page.evaluate(() => Reflect.get(window, 'imageClicks')), 1)
        assert.equal(await page.evaluate(() => Reflect.get(window, 'sendClicks')), 1)
        assert.equal(collectCount, 2)
        await page.getByRole('button', { name: '发送', exact: true }).evaluate((button) => {
          ;(button as HTMLButtonElement).disabled = true
        })
        const timeoutStarted = Date.now()
        await assert.rejects(harness.awaitPostSendReady(page, 600), /send/)
        const elapsed = Date.now() - timeoutStarted
        assert.ok(elapsed >= 500, `readiness returned too early: ${elapsed}ms`)
        assert.ok(elapsed < 1_300, `readiness exceeded its wall-clock bound: ${elapsed}ms`)
      } finally {
        await browser.close()
      }
    },
  )

  test(
    'real Chromium uploads through a hidden composer file input without a native chooser',
    { timeout: 30_000 },
    async () => {
      const browserResolverModule = '../../../../scripts/lib/resolve-browser.mjs'
      const { resolveBrowserExecutable } = (await import(browserResolverModule)) as {
        resolveBrowserExecutable(): string
      }
      const browser = await chromium.launch({
        executablePath: resolveBrowserExecutable(),
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      })
      try {
        const page = await browser.newPage()
        await page.setContent(`<!doctype html>
          <div id="composer">
            <textarea></textarea>
            <button id="image">图片</button>
            <input id="file" type="file" accept="image/*" hidden />
            <button id="send" disabled>发送</button>
          </div>
          <script>
            window.imageClicks = 0;
            window.sendClicks = 0;
            window.chooserClicks = 0;
            document.querySelector('#image').addEventListener('click', () => {
              window.imageClicks += 1;
              const panel = document.createElement('div');
              panel.textContent = '相册';
              document.body.append(panel);
            });
            document.querySelector('#file').addEventListener('click', () => {
              window.chooserClicks += 1;
            });
            document.querySelector('#file').addEventListener('change', () => {
              const preview = document.createElement('img');
              preview.alt = 'preview';
              preview.src = 'blob:https://weibo.com/preview';
              document.querySelector('#composer').append(preview);
              setTimeout(() => { document.querySelector('#send').disabled = false; }, 400);
            });
            document.querySelector('#send').addEventListener('click', () => {
              window.sendClicks += 1;
              const textarea = document.querySelector('textarea');
              const post = document.createElement('article');
              post.dataset.id = 'hidden-post';
              post.textContent = textarea.value;
              textarea.value = '';
              document.body.append(post);
            });
          </script>`)
        let collectCount = 0
        const harness = compileWorkerPostHarness({
          ensureSelfId: async () => '12345',
          gotoAuthenticated: async () => {},
          collectPosts: async (targetPage: typeof page) => {
            collectCount += 1
            return targetPage.locator('article[data-id]').evaluateAll((articles) =>
              articles.map((article) => ({
                id: article.getAttribute('data-id'),
                owned: true,
                text: article.textContent?.trim() ?? '',
              })),
            )
          },
          uniqueVisible: async (locator: unknown) => locator,
          assertNoChallenge: async () => {},
          awaitDispatch: async () => {},
          exactMenuItem: async (targetPage: typeof page, text: string) => {
            const locator = targetPage.getByRole('button', { name: text, exact: true })
            return (await locator.count()) === 1 ? locator : null
          },
          cleanText: (value: unknown) => String(value).trim(),
          readFile: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        })

        const started = Date.now()
        const result = await harness.writeAction(page, {
          actionId: 'create_post',
          params: {
            text: 'hello',
            mediaManifest: [{ inputId: 'asset-1', filename: 'image.png', mimeType: 'image/png' }],
          },
        })
        assert.deepEqual(result, { post: { id: 'hidden-post', owned: true, text: 'hello' } })
        assert.ok(Date.now() - started >= 350, 'send must wait for delayed media readiness')
        assert.equal(await page.evaluate(() => Reflect.get(window, 'imageClicks')), 1)
        assert.equal(await page.evaluate(() => Reflect.get(window, 'chooserClicks')), 0)
        assert.equal(await page.evaluate(() => Reflect.get(window, 'sendClicks')), 1)
        assert.equal(collectCount, 2)
      } finally {
        await browser.close()
      }
    },
  )

  test(
    'real Chromium clicks the 图片 nearest the composer file input when five 图片 texts exist',
    { timeout: 30_000 },
    async () => {
      const browserResolverModule = '../../../../scripts/lib/resolve-browser.mjs'
      const { resolveBrowserExecutable } = (await import(browserResolverModule)) as {
        resolveBrowserExecutable(): string
      }
      const browser = await chromium.launch({
        executablePath: resolveBrowserExecutable(),
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      })
      try {
        const page = await browser.newPage()
        await page.setContent(`<!doctype html>
          <div id="composer">
            <textarea></textarea>
            <div id="image" class="wbpro-iconbed" role="button">
              <span><span><span><span><span>图片</span></span></span></span></span>
            </div>
            <input id="file" type="file" accept="image/*" hidden />
            <button id="send" disabled>发送</button>
          </div>
          <script>
            window.imageClicks = 0;
            window.sendClicks = 0;
            window.chooserClicks = 0;
            document.querySelector('#image').addEventListener('click', () => {
              window.imageClicks += 1;
            });
            document.querySelector('#file').addEventListener('click', () => {
              window.chooserClicks += 1;
            });
            document.querySelector('#file').addEventListener('change', () => {
              const preview = document.createElement('img');
              preview.alt = 'preview';
              preview.src = 'blob:https://weibo.com/preview';
              document.querySelector('#composer').append(preview);
              setTimeout(() => { document.querySelector('#send').disabled = false; }, 400);
            });
            document.querySelector('#send').addEventListener('click', () => {
              window.sendClicks += 1;
              const textarea = document.querySelector('textarea');
              const post = document.createElement('article');
              post.dataset.id = 'near-input-post';
              post.textContent = textarea.value;
              textarea.value = '';
              document.body.append(post);
            });
          </script>`)
        let collectCount = 0
        const harness = compileWorkerPostHarness({
          ensureSelfId: async () => '12345',
          gotoAuthenticated: async () => {},
          collectPosts: async (targetPage: typeof page) => {
            collectCount += 1
            return targetPage.locator('article[data-id]').evaluateAll((articles) =>
              articles.map((article) => ({
                id: article.getAttribute('data-id'),
                owned: true,
                text: article.textContent?.trim() ?? '',
              })),
            )
          },
          uniqueVisible: async (locator: unknown) => locator,
          assertNoChallenge: async () => {},
          awaitDispatch: async () => {},
          exactMenuItem: async (targetPage: typeof page, text: string) => {
            if (text === '图片' || text === '相册' || text === '本地上传') return null
            const locator = targetPage.getByRole('button', { name: text, exact: true })
            return (await locator.count()) === 1 ? locator : null
          },
          cleanText: (value: unknown) => String(value).trim(),
          readFile: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        })

        const result = await harness.writeAction(page, {
          actionId: 'create_post',
          params: {
            text: 'hello',
            mediaManifest: [{ inputId: 'asset-1', filename: 'image.png', mimeType: 'image/png' }],
          },
        })
        assert.deepEqual(result, { post: { id: 'near-input-post', owned: true, text: 'hello' } })
        assert.equal(await page.evaluate(() => Reflect.get(window, 'imageClicks')), 1)
        assert.equal(await page.evaluate(() => Reflect.get(window, 'chooserClicks')), 0)
        assert.equal(await page.evaluate(() => Reflect.get(window, 'sendClicks')), 1)
        assert.equal(collectCount, 2)
      } finally {
        await browser.close()
      }
    },
  )

  test(
    'real Chromium waits for composer 发送 after upload while a comment 发送 exists',
    { timeout: 30_000 },
    async () => {
      const browserResolverModule = '../../../../scripts/lib/resolve-browser.mjs'
      const { resolveBrowserExecutable } = (await import(browserResolverModule)) as {
        resolveBrowserExecutable(): string
      }
      const browser = await chromium.launch({
        executablePath: resolveBrowserExecutable(),
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      })
      try {
        const page = await browser.newPage()
        await page.setContent(`<!doctype html>
          <div id="composer">
            <textarea></textarea>
            <button id="image">图片</button>
            <input id="file" type="file" accept="image/*" hidden />
            <button id="send" disabled>发送</button>
          </div>
          <div id="comment">
            <textarea></textarea>
            <button id="comment-send">发送</button>
          </div>
          <script>
            window.sendClicks = 0;
            window.commentSendClicks = 0;
            document.querySelector('#file').addEventListener('change', () => {
              const preview = document.createElement('img');
              preview.alt = 'preview';
              preview.src = 'blob:https://weibo.com/preview';
              document.querySelector('#composer').append(preview);
              setTimeout(() => { document.querySelector('#send').disabled = false; }, 800);
            });
            document.querySelector('#send').addEventListener('click', () => {
              window.sendClicks += 1;
              const textarea = document.querySelector('#composer textarea');
              const post = document.createElement('article');
              post.dataset.id = 'scoped-post';
              post.textContent = textarea.value;
              textarea.value = '';
              document.body.append(post);
            });
            document.querySelector('#comment-send').addEventListener('click', () => {
              window.commentSendClicks += 1;
            });
          </script>`)
        const harness = compileWorkerPostHarness({
          ensureSelfId: async () => '12345',
          gotoAuthenticated: async () => {},
          collectPosts: async (targetPage: typeof page) =>
            targetPage.locator('article[data-id]').evaluateAll((articles) =>
              articles.map((article) => ({
                id: article.getAttribute('data-id'),
                owned: true,
                text: article.textContent?.trim() ?? '',
              })),
            ),
          uniqueVisible: async () => page.locator('#composer textarea'),
          assertNoChallenge: async () => {},
          awaitDispatch: async () => {},
          exactMenuItem: async (root: { getByRole: typeof page.getByRole }, text: string) => {
            const locator = root.getByRole('button', { name: text, exact: true })
            return (await locator.count()) === 1 ? locator : null
          },
          cleanText: (value: unknown) => String(value).trim(),
          readFile: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        })

        const started = Date.now()
        const result = await harness.writeAction(page, {
          actionId: 'create_post',
          params: {
            text: 'hello',
            mediaManifest: [{ inputId: 'asset-1', filename: 'image.png', mimeType: 'image/png' }],
          },
        })
        assert.deepEqual(result, { post: { id: 'scoped-post', owned: true, text: 'hello' } })
        assert.ok(Date.now() - started >= 750, 'send must wait for delayed media readiness')
        assert.equal(await page.evaluate(() => Reflect.get(window, 'sendClicks')), 1)
        assert.equal(await page.evaluate(() => Reflect.get(window, 'commentSendClicks')), 0)
      } finally {
        await browser.close()
      }
    },
  )

  test(
    'real Chromium activation skips slow navigation and observes a delayed result once',
    { timeout: 20_000 },
    async () => {
      let clickEvents = 0
      let profileReads = 0
      const server = createServer((request, response) => {
        if (request.url === '/') {
          response.setHeader('content-type', 'text/html; charset=utf-8')
          response.end(`<!doctype html><button id="send">发送</button><script>
            document.querySelector('#send').addEventListener('click', () => {
              fetch('/commit', { method: 'POST', keepalive: true });
              location.assign('/slow');
            });
          </script>`)
          return
        }
        if (request.url === '/commit') {
          clickEvents += 1
          response.end('ok')
          return
        }
        if (request.url === '/slow') {
          setTimeout(() => response.end('slow navigation'), 3_000)
          return
        }
        if (request.url === '/profile') {
          profileReads += 1
          response.setHeader('content-type', 'text/html; charset=utf-8')
          response.end(
            profileReads >= 3
              ? '<article data-id="late-post" data-owned="true">hello</article>'
              : '<main>not visible yet</main>',
          )
          return
        }
        response.statusCode = 404
        response.end('not found')
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      const base = `http://127.0.0.1:${address.port}`
      const browserResolverModule = '../../../../scripts/lib/resolve-browser.mjs'
      const { resolveBrowserExecutable } = (await import(browserResolverModule)) as {
        resolveBrowserExecutable(): string
      }
      const browser = await chromium.launch({
        executablePath: resolveBrowserExecutable(),
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      })
      try {
        const page = await browser.newPage()
        await page.goto(base, { waitUntil: 'domcontentloaded' })
        const harness = compileWorkerPostHarness({
          gotoAuthenticated: async (targetPage: typeof page) => {
            await targetPage.goto(`${base}/profile`, { waitUntil: 'domcontentloaded' })
          },
          collectPosts: async (targetPage: typeof page) =>
            targetPage.locator('article[data-id]').evaluateAll((articles) =>
              articles.map((article) => ({
                id: article.getAttribute('data-id'),
                owned: article.getAttribute('data-owned') === 'true',
                text: article.textContent?.trim() ?? '',
              })),
            ),
          cleanText: (value: unknown) => String(value).trim(),
        })
        const started = Date.now()
        const clickFailure = await harness.activatePostSend(
          page.getByRole('button', { name: '发送', exact: true }),
        )
        assert.equal(clickFailure, null)
        assert.ok(Date.now() - started < 2_000, 'activation must not wait for the 3s navigation')
        const post = await harness.awaitNewestOwnPost(page, '12345', 'hello', new Set())
        assert.deepEqual(post, { id: 'late-post', owned: true, text: 'hello' })
        for (let attempt = 0; attempt < 20 && clickEvents === 0; attempt += 1)
          await new Promise((resolve) => setTimeout(resolve, 25))
        assert.equal(clickEvents, 1)
        assert.equal(profileReads, 3)
      } finally {
        await browser.close()
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      }
    },
  )

  test('strict schemas reject forged server snapshots and oversized image metadata', () => {
    const create = WEIBO_PLUGIN_CONTRACT.actions.find((action) => action.id === 'create_post')!
    assert.doesNotThrow(() =>
      validateRuntimePluginJson(
        create.params,
        { text: '汉'.repeat(2001), images: ['/home/agent/.openclaude/uploads/a.jpg'] },
        'params',
      ),
    )
    assert.throws(
      () => validateRuntimePluginJson(create.params, { text: '汉'.repeat(20_001) }, 'params'),
      (error: unknown) =>
        error instanceof RuntimePluginContractError && error.code === 'INVALID_PARAMS',
    )
    assert.match(create.description, /带图长文/)
    assert.throws(
      () =>
        validateRuntimePluginJson(
          create.params,
          {
            text: 'hello',
            mediaManifest: [
              {
                path: '/home/agent/.openclaude/uploads/a.jpg',
                inputId: '123e4567-e89b-42d3-a456-426614174000',
                filename: 'a.jpg',
                sizeBytes: 16 * 1024 * 1024,
                sha256: '0'.repeat(64),
                mimeType: 'image/jpeg',
                kind: 'image',
              },
            ],
          },
          'params',
        ),
      (error: unknown) =>
        error instanceof RuntimePluginContractError && error.code === 'INVALID_PARAMS',
    )
    const edit = WEIBO_PLUGIN_CONTRACT.actions.find((action) => action.id === 'edit_post')!
    assert.throws(
      () =>
        validateRuntimePluginJson(
          edit.params,
          {
            userId: '12345',
            postId: 'AbCdE',
            text: 'changed',
            editSnapshot: { expectedDigest: '0'.repeat(64), owned: false },
          },
          'params',
        ),
      (error: unknown) =>
        error instanceof RuntimePluginContractError && error.code === 'INVALID_PARAMS',
    )
  })

  test('search can return an honest mobile UI summary without inventing an author identity', () => {
    const search = WEIBO_PLUGIN_CONTRACT.actions.find((action) => action.id === 'search_posts')!
    assert.doesNotThrow(() =>
      validateRuntimePluginJson(
        search.result,
        {
          posts: [
            {
              id: '1234567890123456',
              text: '公开搜索摘要',
              url: 'https://m.weibo.cn/status/1234567890123456',
              likeCount: 0,
              commentCount: 0,
              repostCount: 0,
              images: [],
              detailAvailable: false,
              contentDigest: '0'.repeat(64),
            },
          ],
        },
        'result',
      ),
    )
  })

  test('frame decoder accepts coalesced bounded protocol frames', () => {
    const chunk = Buffer.concat([
      framed({ event: 'ready', runtime: 'weibo-worker-v1', playwrightMcpVersion: '0.0.76' }),
      framed({ event: 'failed', code: 'WORKER_FAILED' }),
    ])
    assert.equal(decodeWeiboWorkerFramesForTest(chunk), 2)
  })
})
