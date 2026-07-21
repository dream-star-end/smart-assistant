import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { RuntimePluginContractError, validateRuntimePluginJson } from './contracts.js'
import {
  COMPILED_WEIBO_PLUGIN,
  WEIBO_DRIVER_VERSION,
  WEIBO_LAUNCHER_VERSION,
  WEIBO_LOGIN_ORIGINS,
  WEIBO_PLUGIN_CONTRACT,
  WEIBO_PLUGIN_SLUG,
  WEIBO_PLUGIN_VERSION,
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

describe('official Weibo Plugin', () => {
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

  test('pins one exact platform artifact and has no compatible predecessor', () => {
    assert.equal(WEIBO_PLUGIN_VERSION, '1.2.0')
    assert.equal(WEIBO_DRIVER_VERSION, WEIBO_PLUGIN_VERSION)
    assert.equal(WEIBO_LAUNCHER_VERSION, WEIBO_PLUGIN_VERSION)
    assert.equal(
      classifyWeiboSetupPin({
        version: WEIBO_PLUGIN_VERSION,
        artifactHash: COMPILED_WEIBO_PLUGIN.artifactHash,
        execContractHash: COMPILED_WEIBO_PLUGIN.execContractHash,
      }),
      'current',
    )
    assert.equal(
      classifyWeiboSetupPin({
        version: WEIBO_PLUGIN_VERSION,
        artifactHash: '0'.repeat(64),
        execContractHash: COMPILED_WEIBO_PLUGIN.execContractHash,
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
        WEIBO_WORKER_SOURCE.indexOf('await fileInput.setInputFiles(files);'),
      'media must not be uploaded before the parent dispatch fence is armed',
    )
  })

  test('strict schemas reject forged server snapshots and oversized image metadata', () => {
    const create = WEIBO_PLUGIN_CONTRACT.actions.find((action) => action.id === 'create_post')!
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
