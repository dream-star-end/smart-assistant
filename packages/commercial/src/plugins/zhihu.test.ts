import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { RuntimePluginContractError, validateRuntimePluginJson } from './contracts.js'
import {
  COMPILED_ZHIHU_PLUGIN,
  ZHIHU_DRIVER_VERSION,
  ZHIHU_LAUNCHER_VERSION,
  ZHIHU_LOGIN_ORIGINS,
  ZHIHU_PLUGIN_CONTRACT,
  ZHIHU_PLUGIN_SLUG,
  ZHIHU_PLUGIN_VERSION,
  classifyZhihuSetupPin,
  decodeZhihuWorkerFramesForTest,
  isOfficialZhihuPluginIdentity,
  resolveZhihuWorkerResources,
  validateZhihuAccountState,
} from './zhihu.js'
import { ZHIHU_WORKER_SOURCE } from './zhihuWorkerSource.js'
import { managedPluginWritePolicy, managedPluginWritePreapprovalPolicy } from './writePolicy.js'

function framed(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

const ACTION_IDS = [
  'get_self',
  'get_user',
  'get_question',
  'list_question_answers',
  'get_answer',
  'list_answer_comments',
  'search',
  'list_feed',
  'list_notifications',
  'list_my_answers',
  'list_my_articles',
  'list_hot',
  'create_pin',
  'create_answer',
  'edit_answer',
  'delete_answer',
  'create_comment',
  'reply_comment',
  'delete_comment',
  'set_vote',
  'set_following',
  'create_article',
] as const

function compileWorkerChallengeHarness(writeTerminalAndExit: (event: unknown) => Promise<void>): {
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
  ) as ReturnType<typeof compileWorkerChallengeHarness>
}

function compileFilteredStateHarness(): {
  cookieDomainAllowed(domain: string, domainSet: Set<string>): boolean
  isZhihuAuthHost(domain: string): boolean
  filteredState(
    state: unknown,
    domains: string[],
    origins: string[],
  ): { cookies: Array<{ name: string; domain: string }>; origins: unknown[] }
} {
  const start = ZHIHU_WORKER_SOURCE.indexOf('function cookieDomainAllowed')
  const end = ZHIHU_WORKER_SOURCE.indexOf('function digest(value)')
  assert.ok(start >= 0 && end > start)
  return new Function(
    `'use strict'; ${ZHIHU_WORKER_SOURCE.slice(start, end)}
      return { cookieDomainAllowed, isZhihuAuthHost, filteredState };`,
  )() as ReturnType<typeof compileFilteredStateHarness>
}

function compileSnapshotGuardHarness(
  writeTerminalAndExit: (event: unknown) => Promise<void>,
): {
  sameZhihuWriteSnapshot(
    current: unknown,
    snapshot: unknown,
    selfToken: string,
    expectedId: string,
  ): boolean
  rejectIfSnapshotChanged(
    current: unknown,
    snapshot: unknown,
    selfToken: string,
    expectedId: string,
  ): Promise<void>
} {
  const start = ZHIHU_WORKER_SOURCE.indexOf('function sameZhihuWriteSnapshot')
  const end = ZHIHU_WORKER_SOURCE.indexOf('async function findAnswerRoot', start)
  assert.ok(start >= 0 && end > start)
  return new Function(
    'writeTerminalAndExit',
    `'use strict'; ${ZHIHU_WORKER_SOURCE.slice(start, end)}
      return { sameZhihuWriteSnapshot, rejectIfSnapshotChanged };`,
  )(writeTerminalAndExit) as ReturnType<typeof compileSnapshotGuardHarness>
}

describe('official Zhihu Plugin', () => {
  test('pins the current artifact and compiles a stable hash', () => {
    assert.equal(ZHIHU_PLUGIN_VERSION, '1.1.0')
    assert.equal(ZHIHU_DRIVER_VERSION, ZHIHU_PLUGIN_VERSION)
    assert.equal(ZHIHU_LAUNCHER_VERSION, ZHIHU_PLUGIN_VERSION)
    assert.match(COMPILED_ZHIHU_PLUGIN.artifactHash, /^[0-9a-f]{64}$/)
    assert.match(COMPILED_ZHIHU_PLUGIN.execContractHash, /^[0-9a-f]{64}$/)
    assert.equal(COMPILED_ZHIHU_PLUGIN.pluginType, 'managed-browser')
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
        execContractHash: '0'.repeat(64),
        reviewSource: 'platform',
      }),
      false,
    )
  })

  test('exposes bounded reads and default-confirmed writes with independent preapproval', () => {
    assert.deepEqual(
      ZHIHU_PLUGIN_CONTRACT.actions.map((action) => action.id),
      [...ACTION_IDS],
    )
    assert.equal(
      ZHIHU_PLUGIN_CONTRACT.actions.filter((action) => action.effect === 'read').length,
      12,
    )
    assert.equal(
      ZHIHU_PLUGIN_CONTRACT.actions.filter((action) => action.effect === 'write').length,
      10,
    )
    for (const action of ZHIHU_PLUGIN_CONTRACT.actions.filter(
      (candidate) => candidate.effect === 'write',
    ))
      assert.match(action.description, /逐次确认/)
    const writePolicy = managedPluginWritePolicy(ZHIHU_PLUGIN_SLUG)
    assert.ok(writePolicy)
    assert.equal(writePolicy.version, 2)
    assert.match(writePolicy.disclaimerText, /默认每一次写操作仍须.*确认卡/)
    assert.match(writePolicy.disclaimerText, /发布想法/)
    assert.match(writePolicy.disclaimerText, /上传你指定的本地图片/)
    const preapprovalPolicy = managedPluginWritePreapprovalPolicy(ZHIHU_PLUGIN_SLUG)
    assert.ok(preapprovalPolicy)
    assert.equal(preapprovalPolicy.version, 2)
    assert.match(preapprovalPolicy.disclaimerText, /免逐次确认/)
    assert.match(preapprovalPolicy.disclaimerText, /发布想法/)
    assert.match(preapprovalPolicy.disclaimerText, /上传你指定的本地图片/)
    assert.match(preapprovalPolicy.disclaimerText, /派发围栏/)
  })

  test('keeps account state and browser network inside exact signed origins', () => {
    assert.ok(ZHIHU_PLUGIN_CONTRACT.runtime.network.origins.includes('https://www.zhihu.com:443'))
    assert.ok(
      ZHIHU_PLUGIN_CONTRACT.runtime.network.origins.includes('https://zhuanlan.zhihu.com:443'),
    )
    assert.ok(ZHIHU_PLUGIN_CONTRACT.runtime.network.origins.includes('https://picx.zhimg.com:443'))
    assert.ok(!ZHIHU_PLUGIN_CONTRACT.runtime.network.origins.some((origin) => /api\.zhihu/.test(origin)))
    assert.ok(ZHIHU_LOGIN_ORIGINS.includes('https://www.zhihu.com:443'))
    assert.ok(ZHIHU_LOGIN_ORIGINS.length <= 16)
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
      origins: [],
    })
    assert.equal(state.cookies[0]?.name, 'z_c0')
  })

  test('each action schema accepts a valid example and rejects extras', () => {
    const examples: Record<string, { params: Record<string, unknown>; result: Record<string, unknown> }> =
      {
        get_self: {
          params: {},
          result: {
            user: {
              urlToken: 'excited-vczh',
              name: 'vczh',
              profileUrl: 'https://www.zhihu.com/people/excited-vczh',
            },
          },
        },
        get_user: {
          params: { urlToken: 'excited-vczh' },
          result: {
            user: {
              urlToken: 'excited-vczh',
              name: 'vczh',
              profileUrl: 'https://www.zhihu.com/people/excited-vczh',
            },
          },
        },
        get_question: {
          params: { questionId: '19550225' },
          result: {
            question: {
              id: '19550225',
              title: '如何评价知乎',
              url: 'https://www.zhihu.com/question/19550225',
            },
          },
        },
        list_question_answers: {
          params: { questionId: '19550225', limit: 5 },
          result: { answers: [], complete: true, degradedReason: 'empty_list' },
        },
        get_answer: {
          params: { answerId: '12345678' },
          result: {
            answer: {
              id: '12345678',
              text: '正文',
              url: 'https://www.zhihu.com/answer/12345678',
              contentDigest: '0'.repeat(64),
            },
          },
        },
        list_answer_comments: {
          params: { answerId: '12345678' },
          result: { comments: [], complete: true },
        },
        search: {
          params: { query: 'openai', type: 'question', limit: 10 },
          result: { results: [], complete: true },
        },
        list_feed: { params: { limit: 10 }, result: { items: [], complete: true } },
        list_notifications: { params: {}, result: { notifications: [], complete: true } },
        list_my_answers: { params: {}, result: { answers: [], complete: true } },
        list_my_articles: { params: {}, result: { articles: [], complete: true } },
        list_hot: {
          params: {},
          result: {
            searches: [{ rank: 1, title: '热榜', url: 'https://www.zhihu.com/hot' }],
            complete: true,
          },
        },
        create_pin: {
          params: { text: '想法正文' },
          result: {
            pin: {
              id: '1',
              text: '想法正文',
              url: 'https://www.zhihu.com/pin/1',
              contentDigest: '0'.repeat(64),
            },
          },
        },
        create_answer: {
          params: { questionId: '19550225', text: '回答正文' },
          result: {
            answer: {
              id: '9',
              text: '回答正文',
              url: 'https://www.zhihu.com/answer/9',
              contentDigest: '0'.repeat(64),
            },
          },
        },
        edit_answer: {
          params: {
            answerId: '9',
            text: '改写',
            snapshot: { expectedDigest: '0'.repeat(64), owned: true },
          },
          result: {
            answer: {
              id: '9',
              text: '改写',
              url: 'https://www.zhihu.com/answer/9',
              contentDigest: '1'.repeat(64),
            },
          },
        },
        delete_answer: {
          params: { answerId: '9', snapshot: { expectedDigest: '0'.repeat(64), owned: true } },
          result: { ok: true, changed: true },
        },
        create_comment: {
          params: { answerId: '9', text: '评论' },
          result: {
            comment: {
              id: '1',
              answerId: '9',
              text: '评论',
              contentDigest: '0'.repeat(64),
            },
          },
        },
        reply_comment: {
          params: { answerId: '9', commentId: '1', text: '回复' },
          result: {
            comment: {
              id: '2',
              answerId: '9',
              text: '回复',
              contentDigest: '0'.repeat(64),
            },
          },
        },
        delete_comment: {
          params: {
            answerId: '9',
            commentId: '1',
            snapshot: { expectedDigest: '0'.repeat(64), owned: true },
          },
          result: { ok: true, changed: true },
        },
        set_vote: {
          params: { answerId: '9', vote: 'up' },
          result: { ok: true, changed: true },
        },
        set_following: {
          params: { urlToken: 'excited-vczh', following: true },
          result: { ok: true, changed: true },
        },
        create_article: {
          params: { title: '标题', text: '正文' },
          result: {
            article: {
              id: '1',
              title: '标题',
              url: 'https://zhuanlan.zhihu.com/p/1',
              contentDigest: '0'.repeat(64),
            },
          },
        },
      }

    for (const action of ZHIHU_PLUGIN_CONTRACT.actions) {
      const example = examples[action.id]
      assert.ok(example, `missing example for ${action.id}`)
      assert.doesNotThrow(() =>
        validateRuntimePluginJson(action.params, example.params, 'params'),
      )
      assert.doesNotThrow(() =>
        validateRuntimePluginJson(action.result, example.result, 'result'),
      )
      assert.throws(
        () =>
          validateRuntimePluginJson(action.params, { ...example.params, extra: true }, 'params'),
        (error: unknown) =>
          error instanceof RuntimePluginContractError && error.code === 'INVALID_PARAMS',
      )
    }

    const create = ZHIHU_PLUGIN_CONTRACT.actions.find((action) => action.id === 'create_answer')!
    assert.throws(
      () => validateRuntimePluginJson(create.params, { questionId: 'abc', text: 'x' }, 'params'),
      (error: unknown) =>
        error instanceof RuntimePluginContractError && error.code === 'INVALID_PARAMS',
    )
    const edit = ZHIHU_PLUGIN_CONTRACT.actions.find((action) => action.id === 'edit_answer')!
    assert.doesNotThrow(() =>
      validateRuntimePluginJson(edit.params, { answerId: '9', text: 'changed' }, 'params'),
    )
    assert.throws(
      () =>
        validateRuntimePluginJson(
          edit.params,
          {
            answerId: '9',
            text: 'changed',
            snapshot: { expectedDigest: '0'.repeat(64), owned: false },
          },
          'params',
        ),
      (error: unknown) =>
        error instanceof RuntimePluginContractError && error.code === 'INVALID_PARAMS',
    )
    const deleteComment = ZHIHU_PLUGIN_CONTRACT.actions.find(
      (action) => action.id === 'delete_comment',
    )!
    assert.doesNotThrow(() =>
      validateRuntimePluginJson(
        deleteComment.params,
        { answerId: '9', commentId: '1' },
        'params',
      ),
    )

    const pin = ZHIHU_PLUGIN_CONTRACT.actions.find((action) => action.id === 'create_pin')
    assert.ok(pin)
    assert.equal(pin.effect, 'write')
    assert.equal(pin.timeoutSeconds, 600)
    assert.match(pin.description, /可带图/)
    const article = ZHIHU_PLUGIN_CONTRACT.actions.find((action) => action.id === 'create_article')
    assert.ok(article)
    assert.match(article.description, /可带图/)
    for (const id of ['create_pin', 'create_answer', 'edit_answer', 'create_article'] as const) {
      const action = ZHIHU_PLUGIN_CONTRACT.actions.find((candidate) => candidate.id === id)
      assert.ok(action, `missing ${id}`)
      assert.equal(action.timeoutSeconds, 600, `${id} timeout`)
      assert.match(action.description, /可带图/, `${id} description`)
      const properties = (action.params as { properties?: Record<string, unknown> }).properties
      assert.ok(properties?.images, `${id} missing images`)
      assert.ok(properties?.mediaManifest, `${id} missing mediaManifest`)
    }
    assert.doesNotThrow(() =>
      validateRuntimePluginJson(pin.params, { images: ['/home/agent/.openclaude/uploads/a.png'] }, 'params'),
    )
  })

  test('worker source has a handling branch for every action id and is DOM-only', () => {
    for (const id of ACTION_IDS) {
      if (
        id === 'create_pin' &&
        !ZHIHU_WORKER_SOURCE.includes(`'${id}'`) &&
        !ZHIHU_WORKER_SOURCE.includes(`"${id}"`)
      )
        continue
      assert.ok(
        ZHIHU_WORKER_SOURCE.includes(`'${id}'`) || ZHIHU_WORKER_SOURCE.includes(`"${id}"`),
        `worker missing action id ${id}`,
      )
    }
    assert.match(ZHIHU_WORKER_SOURCE, /actionId === 'get_self'/)
    assert.match(ZHIHU_WORKER_SOURCE, /actionId === 'create_answer'/)
    assert.match(ZHIHU_WORKER_SOURCE, /actionId === 'create_comment'/)
    assert.match(ZHIHU_WORKER_SOURCE, /actionId === 'edit_answer'/)
    assert.match(ZHIHU_WORKER_SOURCE, /actionId === 'delete_answer'/)
    assert.match(ZHIHU_WORKER_SOURCE, /actionId === 'delete_comment'/)
    assert.match(ZHIHU_WORKER_SOURCE, /actionId === 'set_vote'/)
    assert.match(ZHIHU_WORKER_SOURCE, /actionId === 'set_following'/)
    assert.match(ZHIHU_WORKER_SOURCE, /IMPLEMENTED_WRITES = new Set\(\['create_answer', 'edit_answer', 'delete_answer'/)
    assert.match(ZHIHU_WORKER_SOURCE, /PRECONDITION_CHANGED/)
    assert.match(ZHIHU_WORKER_SOURCE, /ZHIHU_UPSTREAM_CHALLENGE/)
    assert.match(ZHIHU_WORKER_SOURCE, /\/account\/unhuman/)
    assert.doesNotMatch(ZHIHU_WORKER_SOURCE, /page\.request/)
    assert.doesNotMatch(ZHIHU_WORKER_SOURCE, /__reactFiber/)
    assert.doesNotMatch(ZHIHU_WORKER_SOURCE, /__INITIAL_STATE__/)
    assert.doesNotMatch(ZHIHU_WORKER_SOURCE, /api\.zhihu\.com/)
  })

  test('login loop emits non-secret step names for scan diagnosis', () => {
    assert.match(ZHIHU_WORKER_SOURCE, /step: 'login\.signal'/)
    assert.match(ZHIHU_WORKER_SOURCE, /cookie-changed/)
    assert.match(ZHIHU_WORKER_SOURCE, /url-left-signin/)
    assert.match(ZHIHU_WORKER_SOURCE, /step: 'login\.prove_self'/)
    assert.match(ZHIHU_WORKER_SOURCE, /home-no-unique-token/)
    assert.match(ZHIHU_WORKER_SOURCE, /login\.self_token/)
    assert.match(ZHIHU_WORKER_SOURCE, /login\.home_ready/)
    assert.match(ZHIHU_WORKER_SOURCE, /login\.home_retry/)
    assert.match(ZHIHU_WORKER_SOURCE, /login\.probe/)
    assert.match(ZHIHU_WORKER_SOURCE, /people-page-token-mismatch/)
    assert.match(ZHIHU_WORKER_SOURCE, /profile-projection-null/)
    assert.match(ZHIHU_WORKER_SOURCE, /step: 'login\.qr_refresh'/)
    assert.match(ZHIHU_WORKER_SOURCE, /https:\/\/www\.zhihu\.com\/people\/edit/)
    assert.match(ZHIHU_WORKER_SOURCE, /我的主页/)
    assert.match(ZHIHU_WORKER_SOURCE, /bounds\.top > 200/)
    assert.match(ZHIHU_WORKER_SOURCE, /isZhihuAuthHost/)
    assert.match(ZHIHU_WORKER_SOURCE, /canonical === 'www\.zhihu\.com'/)
  })

  test('question projection emits diagnostic steps and waits for SPA render', () => {
    assert.match(ZHIHU_WORKER_SOURCE, /question\.project/)
    assert.match(ZHIHU_WORKER_SOURCE, /question\.answers/)
    assert.match(ZHIHU_WORKER_SOURCE, /waitQuestionRendered/)
    assert.match(ZHIHU_WORKER_SOURCE, /id-mismatch/)
    assert.match(ZHIHU_WORKER_SOURCE, /no-title/)
    assert.match(ZHIHU_WORKER_SOURCE, /typeof event.hits === 'number'/)
    assert.match(ZHIHU_WORKER_SOURCE, /step: 'nav\.response'/)
    assert.match(ZHIHU_WORKER_SOURCE, /typeof event.textLen === 'number'/)
    assert.match(ZHIHU_WORKER_SOURCE, /code: 'http-' \+ status/)
    assert.match(ZHIHU_WORKER_SOURCE, /nav\.blocked/)
    assert.match(ZHIHU_WORKER_SOURCE, /gotoInSite/)
    assert.match(ZHIHU_WORKER_SOURCE, /location\.assign/)
    assert.match(ZHIHU_WORKER_SOURCE, /请求存在异常/)
    assert.match(ZHIHU_WORKER_SOURCE, /限制本次访问/)
  })

  test('filteredState keeps z_c0 from both .zhihu.com and www.zhihu.com', () => {
    const { cookieDomainAllowed, isZhihuAuthHost, filteredState } = compileFilteredStateHarness()
    const allowed = new Set(['zhihu.com', 'zhuanlan.zhihu.com', 'zhimg.com'])
    assert.equal(cookieDomainAllowed('zhihu.com', allowed), true)
    assert.equal(cookieDomainAllowed('.zhihu.com', allowed), true)
    assert.equal(cookieDomainAllowed('www.zhihu.com', allowed), true)
    assert.equal(cookieDomainAllowed('example.com', allowed), false)
    assert.equal(isZhihuAuthHost('.zhihu.com'), true)
    assert.equal(isZhihuAuthHost('www.zhihu.com'), true)
    assert.equal(isZhihuAuthHost('zhihu.com'), true)
    assert.equal(isZhihuAuthHost('zhuanlan.zhihu.com'), true)
    assert.equal(isZhihuAuthHost('example.com'), false)
    const cookie = (
      name: string,
      domain: string,
      extra: Record<string, unknown> = {},
    ) => ({
      name,
      value: 'secret',
      domain,
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      ...extra,
    })
    const state = filteredState(
      {
        cookies: [
          cookie('z_c0', '.zhihu.com'),
          cookie('z_c0', 'www.zhihu.com'),
          cookie('z_c0', '.zhihu.com', { secure: false }),
          cookie('z_c0', 'attacker.example'),
        ],
        origins: [],
      },
      [...allowed],
      ['https://www.zhihu.com'],
    )
    assert.deepEqual(
      state.cookies.map((row) => `${row.domain}:${row.name}`).sort(),
      ['.zhihu.com:z_c0', 'www.zhihu.com:z_c0'],
    )
  })

  test('mismatched edit/delete snapshots fail closed as PRECONDITION_CHANGED', async () => {
    const events: unknown[] = []
    const { sameZhihuWriteSnapshot, rejectIfSnapshotChanged } = compileSnapshotGuardHarness(
      async (event) => {
        events.push(event)
      },
    )
    const snapshot = { expectedDigest: 'a'.repeat(64), owned: true as const }
    const current = {
      id: '9',
      authorUrlToken: 'me',
      contentDigest: 'a'.repeat(64),
    }
    assert.equal(sameZhihuWriteSnapshot(current, snapshot, 'me', '9'), true)
    await rejectIfSnapshotChanged(current, snapshot, 'me', '9')
    assert.equal(events.length, 0)

    const stale = { ...current, contentDigest: 'b'.repeat(64) }
    assert.equal(sameZhihuWriteSnapshot(stale, snapshot, 'me', '9'), false)
    await rejectIfSnapshotChanged(stale, snapshot, 'me', '9')
    assert.deepEqual(events.at(-1), {
      event: 'not_dispatched',
      code: 'PRECONDITION_CHANGED',
    })

    events.length = 0
    assert.equal(sameZhihuWriteSnapshot(current, snapshot, 'other', '9'), false)
    await rejectIfSnapshotChanged(current, snapshot, 'other', '9')
    assert.deepEqual(events.at(-1), {
      event: 'not_dispatched',
      code: 'PRECONDITION_CHANGED',
    })

    events.length = 0
    await rejectIfSnapshotChanged(undefined, snapshot, 'me', '9')
    assert.deepEqual(events.at(-1), {
      event: 'not_dispatched',
      code: 'PRECONDITION_CHANGED',
    })
  })

  test('risk pages and unhuman URLs fail closed as ZHIHU_UPSTREAM_CHALLENGE', async () => {
    const events: unknown[] = []
    const { assertNoChallenge } = compileWorkerChallengeHarness(async (event) => {
      events.push(event)
    })
    const page = (text: string, url: string) => ({
      locator: (selector: string) => {
        assert.equal(selector, 'body')
        return { innerText: async () => text }
      },
      url: () => url,
    })
    await assertNoChallenge(page('欢迎来到知乎', 'https://www.zhihu.com/'))
    assert.equal(events.length, 0)
    await assertNoChallenge(page('安全验证 请完成验证', 'https://www.zhihu.com/account/unhuman'))
    assert.deepEqual(events.at(-1), {
      event: 'failed',
      code: 'ZHIHU_UPSTREAM_CHALLENGE',
    })
    events.length = 0
    await assertNoChallenge(page('普通正文', 'https://www.zhihu.com/account/unhuman?type=slide'))
    assert.deepEqual(events.at(-1), {
      event: 'failed',
      code: 'ZHIHU_UPSTREAM_CHALLENGE',
    })
  })

  test('does not mistake standard SMS login labels for a challenge', async () => {
    const events: unknown[] = []
    const { assertNoChallenge } = compileWorkerChallengeHarness(async (event) => {
      events.push(event)
    })
    await assertNoChallenge({
      locator: (selector: string) => {
        assert.equal(selector, 'body')
        return { innerText: async () => '验证码登录 获取验证码 短信验证码' }
      },
      url: () => 'https://www.zhihu.com/signin',
    })
    assert.equal(events.length, 0)
  })

  test('worker resources and coalesced protocol frames', () => {
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
    const chunk = Buffer.concat([
      framed({ event: 'ready', runtime: 'zhihu-worker-v1', playwrightMcpVersion: '0.0.76' }),
      framed({ event: 'failed', code: 'WORKER_FAILED' }),
    ])
    assert.equal(decodeZhihuWorkerFramesForTest(chunk), 2)
  })
})

describe('zhihu worker media source', () => {
  test('pins DOM-only image upload paths and new write branches', () => {
    assert.match(ZHIHU_WORKER_SOURCE, /\/inputs\//)
    assert.match(ZHIHU_WORKER_SOURCE, /media\.attach/)
    assert.match(ZHIHU_WORKER_SOURCE, /create_pin/)
    assert.match(ZHIHU_WORKER_SOURCE, /zhuanlan\.zhihu\.com\/write/)
    assert.match(ZHIHU_WORKER_SOURCE, /ZHIHU_WRITE_MEDIA_UPLOAD/)
    assert.doesNotMatch(ZHIHU_WORKER_SOURCE, /api\.zhihu\.com/)
    assert.doesNotMatch(ZHIHU_WORKER_SOURCE, /fetch\(/)
  })
})
