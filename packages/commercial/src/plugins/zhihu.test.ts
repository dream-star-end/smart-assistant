import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { chromium } from 'playwright-core'

import { buildWriteDetail, buildWriteSummary } from '../connectors/service.js'
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
  cleanContent(value: unknown): string
  pageWithinFrame(
    items: unknown[],
    offset: number,
    count: number,
    exhausted?: boolean,
  ): { items: unknown[]; hasMore: boolean; nextOffset: number }
  contentPage(
    item: Record<string, unknown>,
    field: string,
    offset: number,
    count: number,
  ): Record<string, unknown>
} {
  const start = ZHIHU_WORKER_SOURCE.indexOf('function cleanContent')
  const end = ZHIHU_WORKER_SOURCE.indexOf('function countFrom', start)
  assert.ok(start >= 0 && end > start)
  return new Function(
    `'use strict'; ${ZHIHU_WORKER_SOURCE.slice(start, end)}; return { cleanContent, pageWithinFrame, contentPage };`,
  )() as ReturnType<typeof compileContentHarness>
}

function compileWorkerFunction(name: string, nextName: string, dependencies: string[]) {
  const start = ZHIHU_WORKER_SOURCE.indexOf(`async function ${name}`)
  const end = ZHIHU_WORKER_SOURCE.indexOf(`async function ${nextName}`, start)
  assert.ok(start >= 0 && end > start, `${name} source is missing`)
  return new Function(
    'deps',
    `'use strict'; const { ${dependencies.join(', ')} } = deps;
      ${ZHIHU_WORKER_SOURCE.slice(start, end)}
      return ${name};`,
  )
}

describe('official Zhihu Plugin', () => {
  test('does not mistake the standard signin alternative for a challenge', async () => {
    const events: unknown[] = []
    const { assertNoChallenge } = compileChallengeHarness(async (event) => {
      events.push(event)
    })
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

  test('executes every read action through the worker DOM-routing fixture', async () => {
    const { contentPage, pageWithinFrame } = compileContentHarness()
    const actionRead = compileWorkerFunction('actionRead', 'awaitDispatch', [
      'ensureSelfToken',
      'getUser',
      'gotoPage',
      'targetUrl',
      'projectQuestion',
      'contentPage',
      'projectAnswer',
      'projectArticle',
      'loadAnswers',
      'pageWithinFrame',
      'loadSummaries',
      'loadUntil',
      'digest',
      'openComments',
      'resolveExactComment',
      'loadComments',
    ])({
      ensureSelfToken: async () => 'self-user',
      getUser: async (_page: unknown, token: string) => ({
        id: token,
        name: token,
        url: `https://www.zhihu.com/people/${token}`,
        owned: token === 'self-user',
      }),
      gotoPage: async () => {},
      targetUrl: (kind: string, id: string) => `https://fixture/${kind}/${id}`,
      projectQuestion: async () => ({
        id: '10',
        title: 'fixture question',
        detail: '完整问题背景',
        url: 'https://fixture/question/10',
        followed: false,
        owned: false,
        contentDigest: '1'.repeat(64),
      }),
      contentPage,
      projectAnswer: async () => ({
        id: '20',
        questionId: '10',
        author: {
          id: 'author',
          name: 'author',
          url: 'https://www.zhihu.com/people/author',
          owned: false,
        },
        content: '完整回答正文',
        url: 'https://fixture/answer/20',
        voteState: 'none',
        favorited: false,
        owned: false,
        contentDigest: '2'.repeat(64),
      }),
      projectArticle: async () => ({
        id: '30',
        title: 'fixture article',
        author: {
          id: 'author',
          name: 'author',
          url: 'https://www.zhihu.com/people/author',
          owned: false,
        },
        content: '完整文章正文',
        url: 'https://fixture/article/30',
        favorited: false,
        owned: false,
        contentDigest: '3'.repeat(64),
      }),
      loadAnswers: async (_page: unknown, _self: string, _wanted: number) => ({
        items: [
          {
            id: '20',
            questionId: '10',
            author: {
              id: 'author',
              name: 'author',
              url: 'https://www.zhihu.com/people/author',
              owned: false,
            },
            content: '完整回答正文',
            url: 'https://fixture/answer/20',
            voteState: 'none',
            favorited: false,
            owned: false,
            contentDigest: '2'.repeat(64),
          },
        ],
        exhausted: true,
      }),
      pageWithinFrame,
      loadSummaries: async () => ({
        items: [
          {
            kind: 'answer',
            id: '20',
            title: 'fixture summary',
            summary: 'summary',
            url: 'https://fixture/answer/20',
            owned: false,
            contentDigest: '4'.repeat(64),
          },
        ],
        exhausted: true,
      }),
      loadUntil: async () => ({
        items: [
          {
            id: 'notice',
            text: 'notification',
            url: 'https://fixture/notification',
            unread: false,
            contentDigest: '5'.repeat(64),
          },
        ],
        exhausted: true,
      }),
      digest: () => '6'.repeat(64),
      openComments: async () => {},
      resolveExactComment: async () => ({
        status: 'unique',
        entry: {
          comment: {
            id: '7'.repeat(64),
            targetKind: 'answer',
            targetId: '20',
            author: {
              id: 'author',
              name: 'author',
              url: 'https://www.zhihu.com/people/author',
              owned: false,
            },
            text: 'comment',
            voteState: 'none',
            owned: false,
            contentDigest: '8'.repeat(64),
          },
        },
      }),
      loadComments: async () => ({
        items: [
          {
            comment: {
              id: '7'.repeat(64),
              targetKind: 'answer',
              targetId: '20',
              author: {
                id: 'author',
                name: 'author',
                url: 'https://www.zhihu.com/people/author',
                owned: false,
              },
              text: 'comment',
              voteState: 'none',
              owned: false,
              contentDigest: '8'.repeat(64),
            },
          },
        ],
        exhausted: true,
      }),
    }) as (
      page: unknown,
      input: { actionId: string; params: Record<string, unknown> },
    ) => Promise<unknown>

    const page = { locator: () => ({ first: () => ({}) }) }
    const params: Record<string, Record<string, unknown>> = {
      get_self: {},
      get_user: { urlToken: 'author' },
      get_question: { questionId: '10' },
      get_answer: { answerId: '20' },
      get_article: { articleId: '30' },
      list_question_answers: { questionId: '10', count: 5 },
      search_content: { keyword: 'fixture', count: 5 },
      list_hot: { count: 5 },
      list_user_content: { urlToken: 'author', kind: 'answer', count: 5 },
      list_favorites: { count: 5 },
      list_notifications: { count: 5 },
      list_comments: { targetKind: 'answer', targetId: '20', count: 5 },
      get_comment: { targetKind: 'answer', targetId: '20', commentId: '7'.repeat(64) },
    }
    for (const action of ZHIHU_PLUGIN_CONTRACT.actions.filter(
      (candidate) => candidate.effect === 'read',
    )) {
      const result = await actionRead(page, { actionId: action.id, params: params[action.id] })
      assert.doesNotThrow(
        () => validateRuntimePluginJson(action.result, result, 'result'),
        action.id,
      )
    }
  })

  test('executes all writes in an inert DOM fixture with dispatch fences and post-state proof', async () => {
    const { cleanContent, contentPage } = compileContentHarness()
    const state: {
      action: string
      params: Record<string, unknown>
      dispatched: boolean
      mutated: boolean
      submitted: boolean
      deleted: boolean
      ambiguousAfterDelete: boolean
      clicks: string[]
      tamperEditor: boolean
    } = {
      action: '',
      params: {},
      dispatched: false,
      mutated: false,
      submitted: false,
      deleted: false,
      ambiguousAfterDelete: false,
      clicks: [],
      tamperEditor: false,
    }
    type FixtureLocator = {
      selector: string
      value: string
      fill(value: string): Promise<void>
      click(): Promise<void>
      getAttribute(name: string): Promise<string | null>
      inputValue(): Promise<string>
      innerText(): Promise<string>
      locator(child: string): FixtureLocator
      first(): FixtureLocator
      last(): FixtureLocator
      nth(): FixtureLocator
      count(): Promise<number>
    }
    const locatorCache = new Map<string, FixtureLocator>()
    function locator(selector = ''): FixtureLocator {
      const cached = locatorCache.get(selector)
      if (cached) return cached
      const node = {
        selector,
        value: '',
        async fill(value: string) {
          node.value = value
        },
        async click() {
          state.clicks.push(selector)
        },
        async getAttribute(name: string) {
          return name === 'contenteditable' && selector.includes('contenteditable') ? 'true' : null
        },
        async inputValue() {
          return node.value
        },
        async innerText() {
          return node.value
        },
        locator: (child: string) => locator(`${selector} ${child}`),
        first: () => node,
        last: () => node,
        nth: () => node,
        async count() {
          return 1
        },
      }
      locatorCache.set(selector, node)
      return node
    }
    const page = {
      locator,
      getByText: (text: string) => locator(`topic:${text}`),
      waitForTimeout: async () => {},
      url: () =>
        state.action === 'create_question'
          ? 'https://www.zhihu.com/question/10'
          : state.action === 'create_article'
            ? 'https://zhuanlan.zhihu.com/p/30'
            : 'https://www.zhihu.com/question/10/answer/20',
    }
    const author = {
      id: 'self-user',
      name: 'self-user',
      url: 'https://www.zhihu.com/people/self-user',
      owned: true,
    }
    const answer = () => ({
      id: String(state.params.answerId ?? '20'),
      questionId: String(state.params.questionId ?? '10'),
      author,
      content:
        state.submitted || state.action === 'create_answer'
          ? String(state.params.content ?? 'answer')
          : 'old answer',
      url: 'https://fixture/answer/20',
      voteState: state.mutated ? String(state.params.vote ?? 'none') : 'none',
      favorited: false,
      owned: true,
      contentDigest: 'a'.repeat(64),
    })
    const article = () => ({
      id: String(state.params.articleId ?? '30'),
      title: state.submitted ? String(state.params.title ?? 'article') : 'old article',
      author,
      content: state.submitted ? String(state.params.content ?? 'article') : 'old article body',
      url: 'https://fixture/article/30',
      favorited: false,
      owned: true,
      contentDigest: 'b'.repeat(64),
    })
    const comment = () => ({
      id: String(state.params.commentId ?? 'c'.repeat(64)),
      targetKind: String(state.params.targetKind ?? 'answer'),
      targetId: String(state.params.targetId ?? '20'),
      author,
      text: state.submitted ? String(state.params.text ?? 'comment') : 'old comment',
      voteState: state.mutated && state.params.voted === true ? 'up' : 'none',
      owned: true,
      contentDigest: 'd'.repeat(64),
    })
    const exactControl = async (_root: unknown, labels: string[]) => {
      const control = locator(`control:${labels.join('|')}`)
      control.value = labels[0]
      control.click = async () => {
        assert.equal(state.dispatched || labels[0] === '写回答', true, `${state.action}:${labels}`)
        state.clicks.push(labels.join('|'))
        if (
          state.action.startsWith('set_') &&
          labels.some((label) => /关注|收藏|赞同|反对|^赞$/.test(label))
        )
          state.mutated = true
        if (labels.includes('保存修改') || labels.includes('发布文章')) state.submitted = true
        if (state.action === 'delete_comment' && labels.includes('确定')) state.deleted = true
        if (
          labels.includes('发布问题') ||
          labels.includes('发布回答') ||
          labels[0] === '发布' ||
          (labels[0] === '评论' && labels.length === 1) ||
          (labels[0] === '发布' && labels.includes('回复'))
        )
          state.submitted = true
      }
      return control
    }
    const writeAction = compileWorkerFunction('writeAction', 'finishAction', [
      'ensureSelfToken',
      'gotoPage',
      'targetUrl',
      'uniqueVisible',
      'exactControl',
      'cleanText',
      'editorText',
      'cleanContent',
      'selectedQuestionTopics',
      'sameStringSet',
      'writeTerminalAndExit',
      'contentPage',
      'projectQuestion',
      'hrefIdentity',
      'editorFill',
      'assertNoChallenge',
      'projectArticle',
      'projectAnswer',
      'freshOwnedAnswer',
      'sameOwnedSnapshot',
      'awaitDispatch',
      'confirmDialog',
      'verifyAnswerDeleted',
      'freshOwnedArticle',
      'verifyArticleDeleted',
      'openComments',
      'collectCommentEntries',
      'resolveExactComment',
      'sameCommentSnapshot',
      'controlText',
    ])({
      ensureSelfToken: async () => 'self-user',
      gotoPage: async () => {},
      targetUrl: (kind: string, id: string) => `https://fixture/${kind}/${id}`,
      uniqueVisible: async (candidate: unknown) => candidate,
      exactControl,
      cleanText: (value: unknown, max: number) =>
        String(value ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, max),
      editorText: async (editor: { value: string }) =>
        state.tamperEditor ? 'tampered' : cleanContent(editor.value),
      cleanContent,
      selectedQuestionTopics: async () => (state.params.topics as string[] | undefined) ?? [],
      sameStringSet: (actual: string[], expected: string[]) =>
        actual.length === expected.length && actual.every((item) => expected.includes(item)),
      writeTerminalAndExit: async (event: unknown) => {
        throw Object.assign(new Error('terminal'), { event })
      },
      contentPage,
      projectQuestion: async () => ({
        id: '10',
        title: String(state.params.title ?? 'question'),
        detail: String(state.params.detail ?? ''),
        url: 'https://fixture/question/10',
        followed: false,
        owned: true,
        contentDigest: 'e'.repeat(64),
      }),
      hrefIdentity: (url: string) =>
        url.includes('zhuanlan')
          ? { kind: 'article', id: '30' }
          : url.includes('/answer/')
            ? { kind: 'answer', id: '20' }
            : { kind: 'question', id: '10' },
      editorFill: async (_page: unknown, text: string) => {
        const editor = locator('editor')
        editor.value = text
        return editor
      },
      assertNoChallenge: async () => {},
      projectArticle: async () => article(),
      projectAnswer: async () => answer(),
      freshOwnedAnswer: async () => answer(),
      sameOwnedSnapshot: () => true,
      awaitDispatch: async () => {
        state.dispatched = true
      },
      confirmDialog: async () => {
        assert.equal(state.dispatched, true)
        state.deleted = true
      },
      verifyAnswerDeleted: async () => state.deleted,
      freshOwnedArticle: async () => article(),
      verifyArticleDeleted: async () => state.deleted,
      openComments: async () => {},
      collectCommentEntries: async () =>
        state.submitted ? [{ root: locator('comment'), comment: comment() }] : [],
      resolveExactComment: async () =>
        state.deleted
          ? { status: state.ambiguousAfterDelete ? 'ambiguous' : 'absent' }
          : { status: 'unique', entry: { root: locator('comment'), comment: comment() } },
      sameCommentSnapshot: () => true,
      controlText: async () => {
        if (state.action === 'set_following')
          return state.mutated === (state.params.following === true) ? '已关注' : '关注'
        if (state.action === 'set_favorite')
          return state.mutated === (state.params.favorited === true) ? '已收藏' : '收藏'
        return ''
      },
    }) as (
      page: unknown,
      input: { actionId: string; params: Record<string, unknown> },
    ) => Promise<unknown>

    const snapshot = { expectedDigest: 'f'.repeat(64), owned: true }
    const commentSnapshot = {
      expectedDigest: 'f'.repeat(64),
      targetKind: 'answer',
      targetId: '20',
      owned: true,
    }
    const params: Record<string, Record<string, unknown>> = {
      create_question: { title: 'fixture question', detail: 'fixture detail', topics: ['fixture'] },
      create_answer: { questionId: '10', content: 'new answer' },
      edit_answer: { answerId: '20', content: 'new answer', editSnapshot: snapshot },
      delete_answer: { answerId: '20', deleteSnapshot: snapshot },
      create_article: { title: 'new article', content: 'new article body' },
      edit_article: {
        articleId: '30',
        title: 'new article',
        content: 'new article body',
        editSnapshot: snapshot,
      },
      delete_article: { articleId: '30', deleteSnapshot: snapshot },
      create_comment: { targetKind: 'answer', targetId: '20', text: 'new comment' },
      reply_comment: {
        targetKind: 'answer',
        targetId: '20',
        commentId: 'c'.repeat(64),
        text: 'new reply',
        replySnapshot: commentSnapshot,
      },
      delete_comment: {
        targetKind: 'answer',
        targetId: '20',
        commentId: 'c'.repeat(64),
        deleteSnapshot: commentSnapshot,
      },
      set_answer_vote: { answerId: '20', vote: 'up' },
      set_comment_vote: {
        targetKind: 'answer',
        targetId: '20',
        commentId: 'c'.repeat(64),
        voted: true,
      },
      set_favorite: { targetKind: 'answer', targetId: '20', favorited: true },
      set_following: { targetKind: 'user', targetId: 'author', following: true },
    }
    for (const action of ZHIHU_PLUGIN_CONTRACT.actions.filter(
      (candidate) => candidate.effect === 'write',
    )) {
      Object.assign(state, {
        action: action.id,
        params: params[action.id],
        dispatched: false,
        mutated: false,
        submitted: false,
        deleted: false,
        ambiguousAfterDelete: false,
        clicks: [],
        tamperEditor: false,
      })
      const result = await writeAction(page, { actionId: action.id, params: state.params })
      assert.equal(state.dispatched, true, action.id)
      assert.doesNotThrow(
        () => validateRuntimePluginJson(action.result, result, 'result'),
        action.id,
      )
    }

    Object.assign(state, {
      action: 'create_answer',
      params: params.create_answer,
      dispatched: false,
      mutated: false,
      submitted: false,
      deleted: false,
      ambiguousAfterDelete: false,
      clicks: [],
      tamperEditor: true,
    })
    await assert.rejects(
      writeAction(page, { actionId: 'create_answer', params: state.params }),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { event?: unknown }).event !== undefined &&
        state.clicks.every((click) => click !== '发布回答'),
    )

    Object.assign(state, {
      action: 'delete_comment',
      params: params.delete_comment,
      dispatched: false,
      mutated: false,
      submitted: false,
      deleted: false,
      ambiguousAfterDelete: true,
      clicks: [],
      tamperEditor: false,
    })
    await assert.rejects(
      writeAction(page, { actionId: 'delete_comment', params: state.params }),
      /comment-delete-ambiguous/,
    )
  })

  test('preserves long-form paragraph structure and paginates before the physical frame budget', () => {
    const { cleanContent, contentPage, pageWithinFrame } = compileContentHarness()
    assert.equal(cleanContent('第一段\n\n第二段\n第三行'), '第一段\n\n第二段\n第三行')
    const long = `${'a'.repeat(500_000)}${'b'.repeat(100_000)}`
    assert.equal(cleanContent(long).length, 600_000)
    const firstContent = contentPage({ content: long, contentDigest: 'd' }, 'content', 0, 400_000)
    assert.equal((firstContent.content as string).length, 400_000)
    assert.equal(firstContent.contentLength, 600_000)
    assert.equal(firstContent.hasMoreContent, true)
    assert.equal(firstContent.nextContentOffset, 400_000)
    const finalContent = contentPage({ content: long }, 'content', 400_000, 400_000)
    assert.equal(finalContent.content, `${'a'.repeat(100_000)}${'b'.repeat(100_000)}`)
    assert.equal(finalContent.hasMoreContent, false)
    const cjkPage = contentPage({ content: '中'.repeat(400_000) }, 'content', 0, 400_000)
    assert.ok(Buffer.byteLength(String(cjkPage.content), 'utf8') <= 700_000)
    assert.equal(cjkPage.hasMoreContent, true)
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
    assert.equal(pageWithinFrame([], 0, 3, false).hasMore, true)
  })

  test('proves DOM exhaustion and fails closed on ambiguous comment identities', async () => {
    const loadUntil = compileWorkerFunction('loadUntil', 'selfTokenFromPage', [])({}) as (
      page: unknown,
      collect: () => Promise<unknown[]>,
      wanted: number,
      expand: () => Promise<boolean>,
      ended: () => Promise<boolean>,
    ) => Promise<{ items: unknown[]; exhausted: boolean }>
    const endPage = {
      evaluate: async () => {},
      waitForTimeout: async () => {},
    }
    const exhausted = await loadUntil(
      endPage,
      async () => [],
      2,
      async () => false,
      async () => true,
    )
    assert.deepEqual(exhausted, { items: [], exhausted: true })

    let count = 0
    const growing = await loadUntil(
      endPage,
      async () => Array.from({ length: count++ > 10 ? 2 : 0 }, (_, index) => ({ id: index })),
      2,
      async () => false,
      async () => false,
    )
    assert.equal(growing.items.length, 2)
    assert.equal(growing.exhausted, false)

    let expanded = false
    const continued = await loadUntil(
      endPage,
      async () => (expanded ? [{ id: 1 }] : []),
      1,
      async () => {
        expanded = true
        return true
      },
      async () => false,
    )
    assert.equal(expanded, true)
    assert.equal(continued.items.length, 1)
    assert.equal(continued.exhausted, false)

    const duplicate = { comment: { id: 'a'.repeat(64) } }
    const resolveExactComment = compileWorkerFunction('resolveExactComment', 'actionRead', [
      'loadComments',
    ])({ loadComments: async () => ({ items: [duplicate, duplicate], exhausted: true }) }) as (
      page: unknown,
      kind: string,
      targetId: string,
      commentId: string,
      selfToken: string,
    ) => Promise<{ status: string }>
    assert.deepEqual(await resolveExactComment({}, 'answer', '20', 'a'.repeat(64), 'self-user'), {
      status: 'ambiguous',
    })
  })

  test(
    'real DOM comment identity stays stable and duplicate fallback identities remain ambiguous',
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
      const cleanText = (value: unknown, max: number) =>
        String(value ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, max)
      const projectComment = compileWorkerFunction('projectComment', 'collectCommentEntries', [
        'userToken',
        'digest',
        'cleanText',
        'countFrom',
      ])({
        userToken: (raw: string) => {
          const match = /^\/people\/([A-Za-z0-9-]{1,100})(?:\/|$)/.exec(
            new URL(raw, 'https://www.zhihu.com/').pathname,
          )
          return match?.[1] ?? null
        },
        digest: (value: unknown) =>
          createHash('sha256').update(JSON.stringify(value)).digest('hex'),
        cleanText,
        countFrom: () => 0,
      }) as (
        root: unknown,
        kind: string,
        targetId: string,
        selfToken: string,
        parentId?: string | null,
      ) => Promise<{ id: string; contentDigest: string } | null>
      const collectCommentEntries = compileWorkerFunction('collectCommentEntries', 'findComment', [
        'projectComment',
      ])({ projectComment }) as (
        page: unknown,
        kind: string,
        targetId: string,
        selfToken: string,
      ) => Promise<Array<{ comment: { id: string } }>>
      const visible = (locator: { isVisible(): Promise<boolean> }) => locator.isVisible()
      const visibleContinuation = compileWorkerFunction('visibleContinuation', 'expandList', [
        'cleanText',
        'visible',
      ])({ cleanText, visible }) as (page: unknown, pattern: RegExp) => Promise<unknown | null>
      const expandList = compileWorkerFunction('expandList', 'visiblePlatformState', [
        'visibleContinuation',
      ])({ visibleContinuation }) as (page: unknown) => Promise<boolean>
      const visiblePlatformState = compileWorkerFunction(
        'visiblePlatformState',
        'explicitDocumentEnd',
        ['cleanText', 'visible'],
      )({ cleanText, visible }) as (
        page: unknown,
        selectors: string,
        pattern: RegExp,
      ) => Promise<boolean>
      const explicitDocumentEnd = compileWorkerFunction('explicitDocumentEnd', 'loadUntil', [
        'visibleContinuation',
        'visiblePlatformState',
      ])({
        visibleContinuation,
        visiblePlatformState,
      }) as (
        page: unknown,
        continuationPattern: RegExp,
        finiteContainer?: string | null,
      ) => Promise<boolean>
      try {
        const page = await browser.newPage()
        await page.setContent(
          '<div class="ContentItem"><div class="RichText">没有更多了</div></div>',
        )
        assert.equal(await explicitDocumentEnd(page, /^(?:加载更多)$/), false)

        await page.setContent(`<!doctype html><style>.HotList-list { min-height: 20px }</style>
          <div class="HotList-list">热榜条目</div>
          <button onclick="window.expansions = (window.expansions || 0) + 1; this.remove()">加载更多</button>`)
        const continuationPattern = /^(?:加载更多|查看更多内容)$/
        assert.equal(await explicitDocumentEnd(page, continuationPattern, '.HotList-list'), false)
        assert.equal(await expandList(page), true)
        assert.equal(
          await page.evaluate(() => (window as Window & { expansions?: number }).expansions),
          1,
        )
        assert.equal(await explicitDocumentEnd(page, continuationPattern, '.HotList-list'), true)

        await page.setContent(`<!doctype html><base href="https://www.zhihu.com/">
          <div class="CommentItem" data-comment-id="stable-1">
            <a href="/people/author">作者</a><span class="CommentItem-content">第一版正文</span>
            <time>1 分钟前</time><button>赞</button>
          </div>`)
        const root = page.locator('.CommentItem')
        const first = await projectComment(root, 'answer', '20', 'self-user')
        await root.locator('.CommentItem-content').evaluate((node) => {
          node.textContent = '第二版正文'
        })
        await root.locator('time').evaluate((node) => {
          node.textContent = '2 分钟前'
        })
        const second = await projectComment(root, 'answer', '20', 'self-user')
        assert.ok(first && second)
        assert.equal(first.id, second.id)
        assert.notEqual(first.contentDigest, second.contentDigest)

        await page.setContent(`<!doctype html><base href="https://www.zhihu.com/">
          <div class="CommentItem"><a href="/people/author">作者</a><span class="CommentItem-content">重复正文</span></div>
          <div class="CommentItem"><a href="/people/author">作者</a><span class="CommentItem-content">重复正文</span></div>`)
        const duplicates = await collectCommentEntries(page, 'answer', '20', 'self-user')
        assert.equal(duplicates.length, 2)
        assert.equal(duplicates[0]?.comment.id, duplicates[1]?.comment.id)
      } finally {
        await browser.close()
      }
    },
  )

  test('deletion proof requires a system tombstone and an absent target root', async () => {
    const cleanText = (value: unknown, max: number) =>
      String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    const visible = (locator: { isVisible(): Promise<boolean> }) => locator.isVisible()
    const visiblePlatformState = compileWorkerFunction(
      'visiblePlatformState',
      'explicitDocumentEnd',
      ['cleanText', 'visible'],
    )({ cleanText, visible })
    const deps = {
      gotoPage: async () => {},
      targetUrl: (kind: string, id: string) => `https://fixture/${kind}/${id}`,
      visiblePlatformState,
    }
    const verifyAnswerDeleted = compileWorkerFunction(
      'verifyAnswerDeleted',
      'verifyArticleDeleted',
      ['gotoPage', 'targetUrl', 'visiblePlatformState'],
    )(deps) as (page: unknown, id: string) => Promise<boolean>
    const verifyArticleDeleted = compileWorkerFunction('verifyArticleDeleted', 'confirmDialog', [
      'gotoPage',
      'targetUrl',
      'visiblePlatformState',
    ])(deps) as (page: unknown, id: string) => Promise<boolean>
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
      await page.setContent('<main>知乎首页 普通内容</main>')
      assert.equal(await verifyAnswerDeleted(page, '20'), false)
      assert.equal(await verifyArticleDeleted(page, '30'), false)

      await page.setContent(
        '<div class="AnswerItem"><div class="RichText">该回答不存在</div></div><div class="ErrorPage">该回答不存在</div>',
      )
      assert.equal(await verifyAnswerDeleted(page, '20'), false)
      await page.setContent(
        '<article><div class="RichText">文章已删除</div></article><div class="ErrorPage">文章已删除</div>',
      )
      assert.equal(await verifyArticleDeleted(page, '30'), false)

      await page.setContent('<main class="ErrorPage"><h1>该回答不存在</h1></main>')
      assert.equal(await verifyAnswerDeleted(page, '20'), true)
      await page.setContent('<main class="NotFoundPage"><h1>文章已删除</h1></main>')
      assert.equal(await verifyArticleDeleted(page, '30'), true)
    } finally {
      await browser.close()
    }
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

  test('confirmation copy identifies server-sealed destructive and reply targets', () => {
    const targetPreview = {
      label: '原文章标题',
      authorName: '作者甲',
      contentPreview: '可辨认的原正文预览',
    }
    const summary = buildWriteSummary(
      'zhihu',
      'delete_article',
      { articleId: '30', targetPreview },
      '扫码账号',
    )
    assert.match(summary, /原文章标题/)
    assert.match(summary, /作者甲/)
    assert.match(summary, /可辨认的原正文预览/)
    assert.deepEqual(
      buildWriteDetail('zhihu', 'reply_comment', {
        targetKind: 'answer',
        targetId: '20',
        commentId: 'c'.repeat(64),
        text: '回复正文',
        targetPreview,
      }).targetPreview,
      targetPreview,
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
