import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { RuntimePluginContractError, validateRuntimePluginJson } from './contracts.js'
import { managedPluginWritePolicy, managedPluginWritePreapprovalPolicy } from './writePolicy.js'
import {
  COMPILED_ZHIHU_PLUGIN,
  ZHIHU_DRIVER_VERSION,
  ZHIHU_LAUNCHER_VERSION,
  ZHIHU_LOGIN_ORIGINS,
  ZHIHU_PLUGIN_CONTRACT,
  ZHIHU_PLUGIN_SLUG,
  ZHIHU_PLUGIN_VERSION,
  ZHIHU_SETUP_COMPATIBLE_PREDECESSORS,
  classifyZhihuSetupPin,
  decodeZhihuWorkerFramesForTest,
  isOfficialZhihuPluginIdentity,
  resolveZhihuWorkerResources,
  validateZhihuAccountState,
} from './zhihu.js'
import { ZHIHU_WORKER_SOURCE } from './zhihuWorkerSource.js'

function framed(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

function compileChallengeHarness(writeTerminalAndExit: (event: unknown) => Promise<void>): {
  assertNoChallenge(page: {
    locator(selector: string): { innerText(): Promise<string> }
    url(): string
  }): Promise<void>
} {
  const riskStart = ZHIHU_WORKER_SOURCE.indexOf('const RISK_TEXT')
  const riskEnd = ZHIHU_WORKER_SOURCE.indexOf('let terminal', riskStart)
  const bodyStart = ZHIHU_WORKER_SOURCE.indexOf('async function bodyText')
  const bodyEnd = ZHIHU_WORKER_SOURCE.indexOf('async function isLoginVisible', bodyStart)
  assert.ok(riskStart >= 0 && riskEnd > riskStart && bodyStart >= 0 && bodyEnd > bodyStart)
  return new Function(
    'writeTerminalAndExit',
    'cleanText',
    `'use strict'; ${ZHIHU_WORKER_SOURCE.slice(riskStart, riskEnd)}
      ${ZHIHU_WORKER_SOURCE.slice(bodyStart, bodyEnd)}
      return { assertNoChallenge };`,
  )(writeTerminalAndExit, (value: unknown, max: number) =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max),
  ) as ReturnType<typeof compileChallengeHarness>
}

function compileContentHarness(): {
  cleanContent(value: unknown, max: number): string
  pageWithinFrame(
    items: unknown[],
    offset: number,
    count: number,
  ): { items: unknown[]; hasMore: boolean; nextOffset: number }
} {
  const start = ZHIHU_WORKER_SOURCE.indexOf('function cleanContent')
  const end = ZHIHU_WORKER_SOURCE.indexOf('function countFrom', start)
  assert.ok(start >= 0 && end > start)
  return new Function(
    `'use strict'; ${ZHIHU_WORKER_SOURCE.slice(start, end)}; return { cleanContent, pageWithinFrame };`,
  )() as ReturnType<typeof compileContentHarness>
}

describe('official Zhihu Plugin', () => {
  test('does not mistake the standard signin alternative for a challenge', async () => {
    const events: unknown[] = []
    const { assertNoChallenge } = compileChallengeHarness(async (event) => events.push(event))
    const page = (text: string, url = 'https://www.zhihu.com/signin') => ({
      locator: (selector: string) => {
        assert.equal(selector, 'body')
        return { innerText: async () => text }
      },
      url: () => url,
    })

    await assertNoChallenge(page('打开知乎 App 扫码登录 验证码登录 获取短信验证码'))
    assert.deepEqual(events, [])
    await assertNoChallenge(page('请完成验证码安全验证'))
    assert.deepEqual(events, [{ event: 'failed', code: 'UPSTREAM_FAILED' }])
  })

  test('pins a new exact artifact and bounded worker resources', () => {
    assert.equal(ZHIHU_PLUGIN_VERSION, '1.0.0')
    assert.equal(ZHIHU_DRIVER_VERSION, ZHIHU_PLUGIN_VERSION)
    assert.equal(ZHIHU_LAUNCHER_VERSION, ZHIHU_PLUGIN_VERSION)
    assert.deepEqual(ZHIHU_SETUP_COMPATIBLE_PREDECESSORS, [])
    assert.equal(
      classifyZhihuSetupPin({
        version: ZHIHU_PLUGIN_VERSION,
        artifactHash: COMPILED_ZHIHU_PLUGIN.artifactHash,
        execContractHash: COMPILED_ZHIHU_PLUGIN.execContractHash,
      }),
      'current',
    )
    assert.equal(
      classifyZhihuSetupPin({
        version: ZHIHU_PLUGIN_VERSION,
        artifactHash: '0'.repeat(64),
        execContractHash: COMPILED_ZHIHU_PLUGIN.execContractHash,
      }),
      null,
    )
    assert.deepEqual(resolveZhihuWorkerResources('action'), {
      memoryBytes: 768 * 1024 * 1024,
      memorySwapBytes: 768 * 1024 * 1024,
      pidsLimit: 128,
      shmSizeBytes: 64 * 1024 * 1024,
    })
    assert.deepEqual(resolveZhihuWorkerResources('login'), {
      memoryBytes: 768 * 1024 * 1024,
      memorySwapBytes: 768 * 1024 * 1024,
      pidsLimit: 256,
      shmSizeBytes: 256 * 1024 * 1024,
    })
  })

  test('official badge requires platform provenance and both exact hashes', () => {
    const exact = {
      slug: ZHIHU_PLUGIN_SLUG,
      pluginType: 'managed-browser',
      artifactHash: COMPILED_ZHIHU_PLUGIN.artifactHash,
      execContractHash: COMPILED_ZHIHU_PLUGIN.execContractHash,
    }
    assert.equal(isOfficialZhihuPluginIdentity({ ...exact, reviewSource: 'platform' }), true)
    assert.equal(isOfficialZhihuPluginIdentity({ ...exact, reviewSource: 'human' }), false)
    assert.equal(
      isOfficialZhihuPluginIdentity({
        ...exact,
        artifactHash: '0'.repeat(64),
        reviewSource: 'platform',
      }),
      false,
    )
  })

  test('exposes complete paginated reads and default-confirmed writes', () => {
    assert.deepEqual(
      ZHIHU_PLUGIN_CONTRACT.actions.map((action) => action.id),
      [
        'get_self',
        'search_content',
        'list_hot',
        'get_question',
        'list_question_answers',
        'get_answer',
        'get_article',
        'get_user',
        'list_user_content',
        'list_favorites',
        'list_notifications',
        'list_comments',
        'get_comment',
        'create_question',
        'create_answer',
        'edit_answer',
        'delete_answer',
        'create_article',
        'edit_article',
        'delete_article',
        'create_comment',
        'reply_comment',
        'delete_comment',
        'set_answer_vote',
        'set_comment_vote',
        'set_favorite',
        'set_following',
      ],
    )
    assert.equal(
      ZHIHU_PLUGIN_CONTRACT.actions.filter((action) => action.effect === 'read').length,
      13,
    )
    assert.equal(
      ZHIHU_PLUGIN_CONTRACT.actions.filter((action) => action.effect === 'write').length,
      14,
    )
    for (const action of ZHIHU_PLUGIN_CONTRACT.actions.filter(
      (candidate) => candidate.effect === 'write',
    ))
      assert.match(action.description, /逐次确认/)

    const writePolicy = managedPluginWritePolicy(ZHIHU_PLUGIN_SLUG)
    assert.equal(writePolicy?.version, 1)
    assert.match(writePolicy?.disclaimerText ?? '', /不是知乎官方产品/)
    assert.match(writePolicy?.disclaimerText ?? '', /服务协议或平台规则/)
    assert.match(writePolicy?.disclaimerText ?? '', /默认每一次写操作仍须.*确认卡/)
    const preapproval = managedPluginWritePreapprovalPolicy(ZHIHU_PLUGIN_SLUG)
    assert.equal(preapproval?.version, 1)
    assert.match(preapproval?.disclaimerText ?? '', /免逐次确认/)
    assert.match(preapproval?.disclaimerText ?? '', /派发围栏/)
    assert.match(preapproval?.disclaimerText ?? '', /删除不可撤销/)
  })

  test('keeps account state and browser network inside exact signed origins', () => {
    assert.ok(ZHIHU_PLUGIN_CONTRACT.runtime.network.origins.includes('https://www.zhihu.com:443'))
    assert.ok(
      ZHIHU_PLUGIN_CONTRACT.runtime.network.origins.includes('https://zhuanlan.zhihu.com:443'),
    )
    assert.ok(ZHIHU_LOGIN_ORIGINS.includes('https://captcha.zhihu.com:443'))
    const state = validateZhihuAccountState({
      cookies: [
        {
          name: 'z_c0',
          value: 'secret',
          domain: '.zhihu.com',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ],
      origins: [{ origin: 'https://www.zhihu.com', localStorage: [] }],
    })
    assert.equal(state.cookies.length, 1)
    assert.throws(
      () =>
        validateZhihuAccountState({
          cookies: [{ ...state.cookies[0], domain: '.example.com' }],
          origins: [],
        }),
      /outside the signed Plugin contract/,
    )
  })

  test('worker is syntax-valid, DOM-only, QR-based, and dispatch-fenced', () => {
    const path = `/tmp/zhihu-worker-test-${process.pid}.mjs`
    writeFileSync(path, ZHIHU_WORKER_SOURCE, { mode: 0o600 })
    try {
      const checked = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' })
      assert.equal(checked.status, 0, checked.stderr)
    } finally {
      rmSync(path, { force: true })
    }
    assert.doesNotMatch(ZHIHU_WORKER_SOURCE, /\{\s*chromium\s*,\s*request\s*\}/)
    assert.doesNotMatch(
      ZHIHU_WORKER_SOURCE,
      /context\.request|page\.request|response\.body|response\.json|__react|webpackChunk|__vue__/,
    )
    assert.doesNotMatch(ZHIHU_WORKER_SOURCE, /api\.zhihu\.com|\/api\/v4\//)
    assert.match(ZHIHU_WORKER_SOURCE, /page\.goto/)
    assert.match(ZHIHU_WORKER_SOURCE, /locator\(/)
    assert.match(ZHIHU_WORKER_SOURCE, /canvas\.Qrcode-qrcode/)
    assert.match(ZHIHU_WORKER_SOURCE, /serviceWorkers: 'block'/)
    assert.match(ZHIHU_WORKER_SOURCE, /event: 'prepared'/)
    assert.match(ZHIHU_WORKER_SOURCE, /command\.command !== 'dispatch'/)
    assert.match(ZHIHU_WORKER_SOURCE, /event: 'not_dispatched'/)
    assert.match(ZHIHU_WORKER_SOURCE, /replySnapshot/)
    assert.match(ZHIHU_WORKER_SOURCE, /deleteSnapshot/)
    assert.match(ZHIHU_WORKER_SOURCE, /editSnapshot/)
    assert.match(ZHIHU_WORKER_SOURCE, /cookie\.secure !== true/)
    assert.match(ZHIHU_WORKER_SOURCE, /localStorage: \[\]/)
    assert.match(ZHIHU_WORKER_SOURCE, /RISK_TEXT/)
  })

  test('preserves long-form paragraph structure and paginates before the physical frame budget', () => {
    const { cleanContent, pageWithinFrame } = compileContentHarness()
    assert.equal(cleanContent('第一段\n\n第二段\n第三行', 500_000), '第一段\n\n第二段\n第三行')
    const rows = [
      { id: '1', content: 'a'.repeat(400_000) },
      { id: '2', content: 'b'.repeat(400_000) },
      { id: '3', content: 'c' },
    ]
    const first = pageWithinFrame(rows, 0, 3)
    assert.deepEqual(first.items, [rows[0]])
    assert.equal(first.hasMore, true)
    assert.equal(first.nextOffset, 1)
    assert.deepEqual(pageWithinFrame(rows, first.nextOffset, 3).items, [rows[1], rows[2]])
  })

  test('schemas reject invalid caller snapshots and accept exact service snapshots', () => {
    const edit = ZHIHU_PLUGIN_CONTRACT.actions.find((action) => action.id === 'edit_answer')!
    assert.throws(
      () =>
        validateRuntimePluginJson(
          edit.params,
          {
            answerId: '123',
            content: 'changed',
            editSnapshot: { expectedDigest: '0'.repeat(64), owned: false },
          },
          'params',
        ),
      (error: unknown) =>
        error instanceof RuntimePluginContractError && error.code === 'INVALID_PARAMS',
    )
    assert.doesNotThrow(() =>
      validateRuntimePluginJson(
        edit.params,
        {
          answerId: '123',
          content: 'changed',
          editSnapshot: { expectedDigest: '0'.repeat(64), owned: true },
        },
        'params',
      ),
    )
    const reply = ZHIHU_PLUGIN_CONTRACT.actions.find((action) => action.id === 'reply_comment')!
    assert.doesNotThrow(() =>
      validateRuntimePluginJson(
        reply.params,
        {
          targetKind: 'answer',
          targetId: '123',
          commentId: '1'.repeat(64),
          text: 'reply',
          replySnapshot: {
            expectedDigest: '2'.repeat(64),
            targetKind: 'answer',
            targetId: '123',
            owned: false,
          },
        },
        'params',
      ),
    )
  })

  test('frame decoder accepts coalesced bounded protocol frames', () => {
    const chunk = Buffer.concat([
      framed({ event: 'ready', runtime: 'zhihu-worker-v1', playwrightMcpVersion: '0.0.76' }),
      framed({ event: 'failed', code: 'WORKER_FAILED' }),
    ])
    assert.equal(decodeZhihuWorkerFramesForTest(chunk), 2)
  })
})
