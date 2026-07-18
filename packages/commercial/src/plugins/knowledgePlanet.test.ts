import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'

import type Docker from 'dockerode'

import { ManagedBrowserRuntime } from './browserRuntime.js'
import { RuntimePluginContractError, validateRuntimePluginJson } from './contracts.js'

import {
  COMPILED_KNOWLEDGE_PLANET_PLUGIN,
  KNOWLEDGE_PLANET_DRIVER_ID,
  KNOWLEDGE_PLANET_DRIVER_VERSION,
  KNOWLEDGE_PLANET_LAUNCHER_ID,
  KNOWLEDGE_PLANET_LAUNCHER_VERSION,
  KNOWLEDGE_PLANET_LOGIN_ORIGINS,
  KNOWLEDGE_PLANET_PLUGIN_CONTRACT,
  KNOWLEDGE_PLANET_PLUGIN_SLUG,
  KNOWLEDGE_PLANET_PLUGIN_VERSION,
  KNOWLEDGE_PLANET_SETUP_COMPATIBLE_PREDECESSORS,
  KNOWLEDGE_PLANET_WORKER_DIGEST,
  KnowledgePlanetDockerService,
  KnowledgePlanetRuntimeError,
  classifyKnowledgePlanetSetupPin,
  createKnowledgePlanetRuntimeRegistries,
  decodeKnowledgePlanetWorkerFramesForTest,
  isOfficialKnowledgePlanetPluginIdentity,
  validateKnowledgePlanetAccountState,
} from './knowledgePlanet.js'
import {
  KNOWLEDGE_PLANET_COMMENT_RESULT_MAX,
  KNOWLEDGE_PLANET_LOGIN_PROBE_CONTROL_SOURCE,
  KNOWLEDGE_PLANET_LOGIN_PROBE_INITIAL_DELAY_MS,
  KNOWLEDGE_PLANET_LOGIN_PROBE_INTERVAL_MS,
  KNOWLEDGE_PLANET_LOGIN_PROBE_MAX_ATTEMPTS,
  KNOWLEDGE_PLANET_QR_CAPTURE_TIMEOUT_MS,
  KNOWLEDGE_PLANET_QR_MIN_DARK_FRACTION,
  KNOWLEDGE_PLANET_QR_MIN_LIGHT_FRACTION,
  KNOWLEDGE_PLANET_QR_MIN_LUMINANCE_DEVIATION,
  KNOWLEDGE_PLANET_TOPIC_PAGE_MAX,
  KNOWLEDGE_PLANET_WORKER_MAX_OUTPUT_BYTES,
  KNOWLEDGE_PLANET_WORKER_MAX_STATE_JSON_BYTES,
  KNOWLEDGE_PLANET_WORKER_SOURCE,
  KNOWLEDGE_PLANET_WRITE_REQUEST_SOURCE,
  isKnowledgePlanetLoginProbeDue,
  isKnowledgePlanetQrPixelSampleReady,
} from './knowledgePlanetWorkerSource.js'

const roots: string[] = []

function knowledgePlanetWorkerCommentHelpers() {
  const start = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf('function text')
  const end = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf('\nfunction buildAction', start)
  assert.ok(start >= 0 && end > start)
  return Function(
    'createHash',
    'Buffer',
    'NUMERIC_ID',
    `'use strict'; ${KNOWLEDGE_PLANET_WORKER_SOURCE.slice(start, end)}; return { projectComment, flattenComments, normalizedCommentPage, commentQuery, commentListResult, firstArrayAt };`,
  )(createHash, Buffer, /^\d{6,32}$/) as {
    projectComment: (
      value: Record<string, unknown>,
      hierarchy?: Record<string, unknown>,
    ) => Record<string, unknown>
    flattenComments: (values: unknown[]) => {
      comments: Array<Record<string, unknown>>
      truncated: boolean
      hasPartialReplies: boolean
    }
    normalizedCommentPage: (
      value: Record<string, unknown>,
      requireExplicit?: boolean,
    ) => Record<string, unknown>
    commentQuery: (page: Record<string, unknown>) => Record<string, unknown>
    commentListResult: (
      payload: Record<string, unknown>,
      page: Record<string, unknown>,
    ) => Record<string, unknown>
    firstArrayAt: (payload: Record<string, unknown>, keys: string[]) => unknown[]
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('official Knowledge Planet Plugin', () => {
  test('requires platform provenance as well as both exact signed hashes for official identity', () => {
    const exact = {
      slug: KNOWLEDGE_PLANET_PLUGIN_SLUG,
      pluginType: 'managed-browser',
      artifactHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash,
      execContractHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash,
    }
    assert.equal(
      isOfficialKnowledgePlanetPluginIdentity({ ...exact, reviewSource: 'human' }),
      false,
      'a human-approved copy of public artifact bytes must never receive the official badge',
    )
    assert.equal(
      isOfficialKnowledgePlanetPluginIdentity({ ...exact, reviewSource: 'platform' }),
      true,
    )
    assert.equal(
      isOfficialKnowledgePlanetPluginIdentity({
        ...exact,
        execContractHash: '0'.repeat(64),
        reviewSource: 'platform',
      }),
      false,
    )
  })

  test('accepts only the current or exact signed compatible predecessors for product setup', () => {
    assert.equal(
      classifyKnowledgePlanetSetupPin({
        version: KNOWLEDGE_PLANET_PLUGIN_VERSION,
        artifactHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.artifactHash,
        execContractHash: COMPILED_KNOWLEDGE_PLANET_PLUGIN.execContractHash,
      }),
      'current',
    )
    assert.equal(KNOWLEDGE_PLANET_SETUP_COMPATIBLE_PREDECESSORS.length, 5)
    assert.deepEqual(KNOWLEDGE_PLANET_SETUP_COMPATIBLE_PREDECESSORS[0], {
      version: '1.4.0',
      artifactHash: 'bc027e75eade8285c776f0ca6aa1f10bc32d8f6e4bc870b1be35a965946a04fb',
      execContractHash: '02d496327bf1d088b3f6b1821731416980ac6a77e21df16dabeea2da0882d8b8',
    })
    for (const predecessor of KNOWLEDGE_PLANET_SETUP_COMPATIBLE_PREDECESSORS)
      assert.equal(classifyKnowledgePlanetSetupPin(predecessor), 'compatible-predecessor')
    assert.equal(
      classifyKnowledgePlanetSetupPin({
        ...KNOWLEDGE_PLANET_SETUP_COMPATIBLE_PREDECESSORS[0]!,
        artifactHash: '0'.repeat(64),
      }),
      null,
    )
    assert.equal(
      classifyKnowledgePlanetSetupPin({
        ...KNOWLEDGE_PLANET_SETUP_COMPATIBLE_PREDECESSORS[0]!,
        version: '1.5.0',
      }),
      null,
    )
    assert.equal(
      classifyKnowledgePlanetSetupPin({
        ...KNOWLEDGE_PLANET_SETUP_COMPATIBLE_PREDECESSORS[0]!,
        execContractHash: '0'.repeat(64),
      }),
      null,
    )
  })

  test('has a signed read/write action network separated from login/account state', () => {
    assert.equal(COMPILED_KNOWLEDGE_PLANET_PLUGIN.pluginType, 'managed-browser')
    assert.deepEqual(KNOWLEDGE_PLANET_PLUGIN_CONTRACT.runtime.network, {
      origins: ['https://api.zsxq.com:443', 'https://upload-z1.qiniup.com:443'],
      methods: ['DELETE', 'GET', 'POST', 'PUT'],
      forbiddenChannels: [
        'background-network',
        'doh',
        'proxy',
        'quic',
        'websocket',
        'webrtc',
        'worker',
      ],
      redirects: 'revalidate-every-hop',
      ipv4PinsRequired: true,
    })
    assert.ok(KNOWLEDGE_PLANET_PLUGIN_CONTRACT.runtime.accountState.origins.length > 1)
    assert.ok(KNOWLEDGE_PLANET_LOGIN_ORIGINS.includes('https://open.weixin.qq.com:443'))
    assert.equal(
      KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions.filter((action) => action.effect === 'read').length,
      16,
    )
    assert.equal(
      KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions.filter((action) => action.effect === 'write').length,
      7,
    )
  })

  test('v1.5 exposes bounded reply-aware reads plus default-confirmed or account-preapproved rich writes without credential-bearing results', () => {
    assert.equal(KNOWLEDGE_PLANET_PLUGIN_VERSION, '1.5.0')
    assert.equal(KNOWLEDGE_PLANET_DRIVER_VERSION, KNOWLEDGE_PLANET_PLUGIN_VERSION)
    assert.equal(KNOWLEDGE_PLANET_LAUNCHER_VERSION, KNOWLEDGE_PLANET_PLUGIN_VERSION)
    assert.deepEqual(
      KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions.map((action) => action.id),
      [
        'get_self',
        'list_groups',
        'get_group',
        'list_topics',
        'get_topic',
        'list_comments',
        'search_topics',
        'list_dynamics',
        'get_unread_counts',
        'list_hashtags',
        'list_hashtag_topics',
        'list_columns',
        'list_column_topics',
        'list_checkins',
        'get_checkin',
        'list_checkin_topics',
        'create_topic',
        'create_comment',
        'edit_topic',
        'delete_topic',
        'delete_comment',
        'set_topic_like',
        'set_comment_like',
      ],
    )
    for (const action of KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions.filter(
      (candidate) => candidate.effect === 'write',
    )) {
      assert.match(action.description, /默认逐次确认/)
      assert.match(action.description, /免确认/)
    }
    const forbidden = /(?:url|uri|href|token|cookie|header|signature|secret)/i
    const visit = (schema: unknown): void => {
      if (!schema || typeof schema !== 'object') return
      if (Array.isArray(schema)) {
        for (const child of schema) visit(child)
        return
      }
      for (const [key, child] of Object.entries(schema)) {
        if (key === 'properties' && child && typeof child === 'object')
          for (const property of Object.keys(child)) assert.doesNotMatch(property, forbidden)
        visit(child)
      }
    }
    for (const action of KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions) visit(action.result)
  })

  test('projects upstream embedded replies as a bounded flat hierarchy without claiming missing replies are complete', () => {
    const helpers = knowledgePlanetWorkerCommentHelpers()
    const rawComments = [
      {
        comment_id: '100001',
        text: 'root',
        replies_count: 3,
        replied_comments: [
          {
            comment_id: '100002',
            parent_comment_id: '100001',
            text: 'child',
            replies_count: 1,
            replied_comments: [
              {
                comment_id: '100003',
                parent_comment_id: '100002',
                text: 'grandchild',
              },
            ],
          },
          { comment_id: '100004', text: 'second child' },
        ],
      },
      { comment_id: '100005', text: 'second root', replies_count: 0 },
    ]
    const page = helpers.normalizedCommentPage(
      { count: 2, sort: 'asc', beginTime: '2026-07-01T00:00:00.000+0800' },
      true,
    )
    assert.deepEqual(page, {
      count: 2,
      sort: 'asc',
      beginTime: '2026-07-01T00:00:00.000+0800',
    })
    assert.deepEqual(helpers.commentQuery(page), {
      count: 2,
      sort: 'asc',
      begin_time: '2026-07-01T00:00:00.000+0800',
      with_sticky: true,
    })
    const result = helpers.commentListResult({ resp_data: { comments: rawComments } }, page) as {
      comments: Array<Record<string, unknown>>
      topLevelCount: number
      returnedCount: number
      truncated: boolean
      hasPartialReplies: boolean
      page: Record<string, unknown>
    }
    assert.deepEqual(
      result.comments.map((comment) => comment.id),
      ['100001', '100002', '100003', '100004', '100005'],
    )
    assert.deepEqual(
      result.comments.map((comment) => comment.rootCommentId),
      ['100001', '100001', '100001', '100001', '100005'],
    )
    assert.deepEqual(
      result.comments.map((comment) => comment.parentCommentId),
      [undefined, '100001', '100002', '100001', undefined],
    )
    assert.deepEqual(
      result.comments.map((comment) => comment.depth),
      [0, 1, 2, 1, 0],
    )
    assert.deepEqual(
      result.comments.map((comment) => comment.returnedReplyCount),
      [2, 1, 0, 0, 0],
    )
    assert.equal(result.comments[0]?.replyCount, 3)
    assert.equal(result.comments[0]?.repliesComplete, false)
    assert.equal(result.comments[1]?.repliesComplete, true)
    assert.equal(result.comments[2]?.repliesComplete, undefined)
    assert.deepEqual(
      {
        topLevelCount: result.topLevelCount,
        returnedCount: result.returnedCount,
        truncated: result.truncated,
        hasPartialReplies: result.hasPartialReplies,
        page: result.page,
      },
      {
        topLevelCount: 2,
        returnedCount: 5,
        truncated: false,
        hasPartialReplies: true,
        page,
      },
    )
    const action = KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions.find(
      (candidate) => candidate.id === 'list_comments',
    )!
    validateRuntimePluginJson(action.result, result, 'result')

    const duplicate = helpers.flattenComments([
      { comment_id: '200001', text: 'first' },
      {
        comment_id: '200001',
        text: 'duplicate',
        replied_comments: [{ comment_id: '200002', text: 'unique child' }],
      },
    ])
    assert.deepEqual(
      duplicate.comments.map((comment) => [comment.id, comment.text]),
      [
        ['200001', 'first'],
        ['200002', 'unique child'],
      ],
    )
    assert.equal(duplicate.comments[1]?.parentCommentId, '200001')

    const capped = helpers.flattenComments(
      Array.from({ length: KNOWLEDGE_PLANET_COMMENT_RESULT_MAX + 1 }, (_, index) => ({
        comment_id: String(300000 + index),
        text: String(index),
      })),
    )
    assert.equal(capped.comments.length, KNOWLEDGE_PLANET_COMMENT_RESULT_MAX)
    assert.equal(capped.truncated, true)
    assert.throws(() => helpers.normalizedCommentPage({ count: 50, sort: 'asc', extra: 1 }, true))
    assert.throws(() => helpers.normalizedCommentPage({ sort: 'asc' }, true))
  })

  test('uses exactly the supplied comment lookup page to find nested replies and never falls back', async () => {
    const helpers = knowledgePlanetWorkerCommentHelpers()
    const start = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf('async function currentComment')
    const end = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf(
      '\nasync function verifyWritePrecondition',
      start,
    )
    assert.ok(start >= 0 && end > start)
    const queries: Array<Record<string, unknown>> = []
    let responses: Array<Record<string, unknown>> = []
    const currentComment = Function(
      'fetchApi',
      'commentQuery',
      'normalizedCommentPage',
      'firstArrayAt',
      'flattenComments',
      `'use strict'; ${KNOWLEDGE_PLANET_WORKER_SOURCE.slice(start, end)}; return currentComment;`,
    )(
      async (_api: unknown, spec: { query: Record<string, unknown> }) => {
        queries.push(spec.query)
        return responses.shift() ?? { resp_data: { comments: [] } }
      },
      helpers.commentQuery,
      helpers.normalizedCommentPage,
      helpers.firstArrayAt,
      helpers.flattenComments,
    ) as (
      api: unknown,
      state: unknown,
      topicId: string,
      commentId: string,
      lookupPage?: Record<string, unknown>,
    ) => Promise<Record<string, unknown> | null>

    responses = [
      {
        resp_data: {
          comments: [
            {
              comment_id: '400001',
              replied_comments: [{ comment_id: '400002', text: 'target reply' }],
            },
          ],
        },
      },
    ]
    assert.equal(
      (
        await currentComment({}, {}, '900001', '400002', {
          count: 20,
          sort: 'asc',
          beginTime: '2026-07-01T00:00:00.000+0800',
        })
      )?.id,
      '400002',
    )
    assert.deepEqual(queries.splice(0), [
      {
        count: 20,
        sort: 'asc',
        begin_time: '2026-07-01T00:00:00.000+0800',
        with_sticky: true,
      },
    ])

    responses = [{ resp_data: { comments: [] } }, { resp_data: { comments: [] } }]
    assert.equal(
      await currentComment({}, {}, '900001', '400002', { count: 20, sort: 'desc' }),
      null,
    )
    assert.equal(queries.splice(0).length, 1, 'an explicit lookup page must never fall back')

    responses = [
      { resp_data: { comments: [] } },
      { resp_data: { comments: [{ comment_id: '400002', text: 'default fallback' }] } },
    ]
    assert.equal((await currentComment({}, {}, '900001', '400002'))?.id, '400002')
    assert.deepEqual(
      queries.splice(0).map((query) => query.sort),
      ['desc', 'asc'],
    )
  })

  test('declares the same numeric ID domain enforced by every worker action path', () => {
    let checked = 0
    for (const action of KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions) {
      const schema = action.params as {
        properties?: Record<string, Record<string, unknown>>
        required?: string[]
      }
      const idNames = Object.keys(schema.properties ?? {}).filter((name) => name.endsWith('Id'))
      if (idNames.length === 0) continue
      const valid: Record<string, unknown> = {}
      for (const name of schema.required ?? []) {
        const property = schema.properties?.[name]
        valid[name] =
          property?.type === 'boolean'
            ? true
            : property?.type === 'integer'
              ? 1
              : name === 'keyword'
                ? 'x'
                : '123456'
      }
      validateRuntimePluginJson(action.params, valid, 'params')
      for (const name of idNames) {
        assert.deepEqual(schema.properties?.[name], {
          type: 'string',
          minLength: 6,
          maxLength: 32,
          pattern: '^[0-9]{6,32}$',
        })
        assert.throws(
          () => validateRuntimePluginJson(action.params, { ...valid, [name]: 'abcdef' }, 'params'),
          (error: unknown) =>
            error instanceof RuntimePluginContractError && error.code === 'INVALID_PARAMS',
          `${action.id}.${name}`,
        )
        checked++
      }
    }
    assert.ok(checked >= 20)
    assert.match(KNOWLEDGE_PLANET_WORKER_SOURCE, /const NUMERIC_ID = \/\^\\d\{6,32\}\$\//)
  })

  test('builds exact one-shot mutation bytes and the current URL/request signature', () => {
    const helpers = Function(
      'createHash',
      'Buffer',
      'NUMERIC_ID',
      `'use strict'; ${KNOWLEDGE_PLANET_WRITE_REQUEST_SOURCE}; return { buildKnowledgePlanetWriteRequest, knowledgePlanetSignature };`,
    )(createHash, Buffer, /^\d{6,32}$/) as {
      buildKnowledgePlanetWriteRequest: (
        action: string,
        params: Record<string, unknown>,
        uploaded?: { imageIds?: string[]; fileIds?: string[] },
      ) => { path: string; body: string; method: string } | null
      knowledgePlanetSignature: (url: string, timestamp: string, requestId: string) => string
    }
    const topic = helpers.buildKnowledgePlanetWriteRequest('create_topic', {
      groupId: '123456789',
      text: '含中文与 "引号"',
    })!
    assert.equal(topic.method, 'POST')
    assert.equal(topic.path, '/v2/groups/123456789/topics')
    assert.equal(
      topic.body,
      JSON.stringify({
        req_data: {
          type: 'talk',
          text: '含中文与 "引号"',
          image_ids: [],
          file_ids: [],
          mentioned_user_ids: [],
        },
      }),
    )
    const timestamp = '1774404109'
    const requestId = '12345678-1234-4234-8234-123456789abc'
    const url = "https://api.zsxq.com/v2/groups/123456789/topics?q='x'"
    const expected = createHash('sha1')
      .update(`https://api.zsxq.com/v2/groups/123456789/topics?q=%27x%27 1774404109 ${requestId}`)
      .digest('hex')
    assert.equal(helpers.knowledgePlanetSignature(url, timestamp, requestId), expected)

    const comment = helpers.buildKnowledgePlanetWriteRequest('create_comment', {
      topicId: '223456789',
      text: '评论',
    })!
    assert.equal(comment.path, '/v2/topics/223456789/comments')
    assert.equal(
      comment.body,
      JSON.stringify({ req_data: { text: '评论', image_ids: [], mentioned_user_ids: [] } }),
    )
    assert.equal(
      helpers.buildKnowledgePlanetWriteRequest('create_comment', {
        topicId: '223456789',
        repliedCommentId: '523456789',
        text: '楼中楼回复',
      })?.body,
      JSON.stringify({
        req_data: {
          text: '楼中楼回复',
          image_ids: [],
          replied_comment_id: '523456789',
          mentioned_user_ids: [],
        },
      }),
    )
    assert.deepEqual(
      helpers.buildKnowledgePlanetWriteRequest(
        'create_topic',
        { groupId: '123456789', text: '' },
        { imageIds: ['323456789'], fileIds: ['423456789'] },
      ),
      {
        method: 'POST',
        path: '/v2/groups/123456789/topics',
        query: {},
        resultKind: 'topic',
        body: JSON.stringify({
          req_data: {
            type: 'talk',
            text: '',
            image_ids: ['323456789'],
            file_ids: ['423456789'],
            mentioned_user_ids: [],
          },
        }),
      },
    )
    assert.equal(
      helpers.buildKnowledgePlanetWriteRequest('delete_topic', { topicId: '223456789' })?.method,
      'DELETE',
    )
    assert.deepEqual(
      helpers.buildKnowledgePlanetWriteRequest('delete_comment', { commentId: '523456789' }),
      {
        method: 'DELETE',
        path: '/v2/comments/523456789',
        query: {},
        resultKind: 'ok',
        body: undefined,
      },
    )
    assert.equal(
      helpers.buildKnowledgePlanetWriteRequest(
        'edit_topic',
        { groupId: '123456789', topicId: '223456789', text: 'edited' },
        { imageIds: ['623456789', '723456789'], fileIds: ['823456789'] },
      )?.body,
      JSON.stringify({
        req_data: {
          type: 'talk',
          text: 'edited',
          image_ids: ['623456789', '723456789'],
          file_ids: ['823456789'],
          mentioned_user_ids: [],
        },
      }),
    )
    assert.equal(
      helpers.buildKnowledgePlanetWriteRequest('set_comment_like', {
        commentId: '523456789',
        liked: false,
      })?.method,
      'DELETE',
    )
    assert.equal(
      helpers.buildKnowledgePlanetWriteRequest('set_comment_like', {
        commentId: '523456789',
        liked: true,
      })?.body,
      undefined,
    )
    assert.match(KNOWLEDGE_PLANET_WORKER_SOURCE, /uploadData\.upload_zone\?\.domains/)
    assert.match(
      KNOWLEDGE_PLANET_WORKER_SOURCE,
      /JSON\.stringify\(\{ req_data: item\.kind === 'image'/,
    )
    assert.match(
      KNOWLEDGE_PLANET_WORKER_SOURCE,
      /type: 'image', size: item\.sizeBytes, name: '', hash: ''/,
    )
    assert.match(KNOWLEDGE_PLANET_WORKER_SOURCE, /data\?\.succeeded !== true/)
    assert.match(KNOWLEDGE_PLANET_WORKER_SOURCE, /dataAt\(data\)\.image_id/)
    assert.match(KNOWLEDGE_PLANET_WORKER_SOURCE, /dataAt\(data\)\.file_id/)
    assert.match(
      KNOWLEDGE_PLANET_WORKER_SOURCE,
      /uploaded\.imageIds = \[\.\.\.params\.editSnapshot\.keepImageIds, \.\.\.uploaded\.imageIds\]/,
    )
    assert.equal([...KNOWLEDGE_PLANET_WORKER_SOURCE.matchAll(/api\.fetch\(/g)].length, 1)
    assert.doesNotMatch(KNOWLEDGE_PLANET_WORKER_SOURCE, /retry|retries/i)
  })

  test('login API probe is delayed, five-second limited and capped at 48 attempts', () => {
    assert.equal(KNOWLEDGE_PLANET_LOGIN_PROBE_INITIAL_DELAY_MS, 3_000)
    assert.equal(KNOWLEDGE_PLANET_LOGIN_PROBE_INTERVAL_MS, 5_000)
    assert.equal(KNOWLEDGE_PLANET_LOGIN_PROBE_MAX_ATTEMPTS, 48)
    assert.equal(isKnowledgePlanetLoginProbeDue(2_999, 3_000, 0), false)
    assert.equal(isKnowledgePlanetLoginProbeDue(3_000, 3_000, 0), true)
    assert.equal(isKnowledgePlanetLoginProbeDue(999_999, 3_000, 48), false)
  })

  test('uses a redirect only once to accelerate the authoritative API probe', () => {
    const controls = Function(
      `'use strict'; ${KNOWLEDGE_PLANET_LOGIN_PROBE_CONTROL_SOURCE}; return { scheduleKnowledgePlanetLoginProbe, hasAuthenticatedKnowledgePlanetSession };`,
    )() as {
      scheduleKnowledgePlanetLoginProbe: (
        now: number,
        pageAuthenticated: boolean,
        pageHintApplied: boolean,
        nextProbeAt: number,
        attempts: number,
      ) => { pageHintApplied: boolean; nextProbeAt: number; due: boolean }
      hasAuthenticatedKnowledgePlanetSession: (probeAuthenticated: boolean) => boolean
    }
    let pageHintApplied = false
    let nextProbeAt = KNOWLEDGE_PLANET_LOGIN_PROBE_INITIAL_DELAY_MS
    let attempts = 0
    const probeTimes: number[] = []
    for (let now = 0; now <= 12_000; now += 1_000) {
      const scheduled = controls.scheduleKnowledgePlanetLoginProbe(
        now,
        true,
        pageHintApplied,
        nextProbeAt,
        attempts,
      )
      pageHintApplied = scheduled.pageHintApplied
      nextProbeAt = scheduled.nextProbeAt
      if (!scheduled.due) continue
      probeTimes.push(now)
      attempts += 1
      nextProbeAt = now + KNOWLEDGE_PLANET_LOGIN_PROBE_INTERVAL_MS
    }
    assert.deepEqual(probeTimes, [0, 5_000, 10_000])
    assert.equal(controls.hasAuthenticatedKnowledgePlanetSession(false), false)
    assert.equal(controls.hasAuthenticatedKnowledgePlanetSession(true), true)

    const loginStart = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf('async function runLogin')
    const entrypointStart = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf('\ntry {', loginStart)
    const loginSource = KNOWLEDGE_PLANET_WORKER_SOURCE.slice(loginStart, entrypointStart)
    assert.match(
      loginSource,
      /if \(hasAuthenticatedKnowledgePlanetSession\(probeAuthenticated\)\) \{[\s\S]*filteredState\([\s\S]*writeAuthenticatedAndExit/,
    )
    assert.doesNotMatch(loginSource, /pageAuthenticated \|\| probeAuthenticated/)
  })

  test('projects Playwright storage state to the exact signed account shape', () => {
    const filteredStart = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf('function filteredState')
    const readAduidStart = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf(
      '\nfunction readAduid',
      filteredStart,
    )
    assert.ok(filteredStart >= 0 && readAduidStart > filteredStart)
    const filteredState = Function(
      `'use strict'; ${KNOWLEDGE_PLANET_WORKER_SOURCE.slice(filteredStart, readAduidStart)}; return filteredState;`,
    )() as (
      state: unknown,
      domains: string[],
      origins: string[],
    ) => { cookies: Array<Record<string, unknown>>; origins: Array<Record<string, unknown>> }
    const projected = filteredState(
      {
        cookies: [
          {
            name: 'zsxq_access_token',
            value: 'credential-value',
            domain: '.zsxq.com',
            path: '/',
            expires: 1_786_872_498,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
            partitionKey: 'https://wx.zsxq.com',
          },
          {
            name: 'outside',
            value: 'discarded',
            domain: '.example.com',
            path: '/',
            expires: -1,
            httpOnly: false,
            secure: true,
            sameSite: 'Lax',
          },
        ],
        origins: [
          {
            origin: 'https://wx.zsxq.com',
            localStorage: [{ name: 'XAduid', value: 'device-value', extra: 'discarded' }],
            indexedDB: [{ name: 'playwright-extension' }],
          },
          {
            origin: 'https://example.com',
            localStorage: [{ name: 'outside', value: 'discarded' }],
          },
        ],
      },
      ['api.zsxq.com', 'wx.zsxq.com', 'zsxq.com'],
      ['https://api.zsxq.com:443', 'https://wx.zsxq.com:443'],
    )
    assert.deepEqual(projected, {
      cookies: [
        {
          name: 'zsxq_access_token',
          value: 'credential-value',
          domain: '.zsxq.com',
          path: '/',
          expires: 1_786_872_498,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
      ],
      origins: [
        {
          origin: 'https://wx.zsxq.com',
          localStorage: [{ name: 'XAduid', value: 'device-value' }],
        },
      ],
    })
    const validated = validateKnowledgePlanetAccountState(projected)
    assert.equal(validated.cookies[0]?.value, 'credential-value')
    assert.equal(validated.origins[0]?.origin, 'https://wx.zsxq.com:443')
    assert.deepEqual(validated.origins[0]?.localStorage, [
      { name: 'XAduid', value: 'device-value' },
    ])
  })

  test('flushes authenticated state before exiting so host cleanup can finish immediately', () => {
    assert.match(
      KNOWLEDGE_PLANET_WORKER_SOURCE,
      /async function writeTerminalAndExit\(value\)[\s\S]*process\.stdout\.write\(output, \(error\) => error \? reject\(error\) : resolve\(\)\);[\s\S]*process\.exit\(0\)/,
    )
    assert.match(
      KNOWLEDGE_PLANET_WORKER_SOURCE,
      /async function writeAuthenticatedAndExit\(storageState\) \{[\s\S]*await writeTerminalAndExit\(\{ event: 'authenticated', storageState \}\)/,
    )
    const loginStart = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf('async function runLogin')
    const entrypointStart = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf('\ntry {', loginStart)
    assert.ok(loginStart >= 0 && entrypointStart > loginStart)
    const loginSource = KNOWLEDGE_PLANET_WORKER_SOURCE.slice(loginStart, entrypointStart)
    assert.match(
      loginSource,
      /const state = filteredState\([\s\S]*await writeAuthenticatedAndExit\(state\)/,
    )
    assert.doesNotMatch(loginSource, /writeFrame\(\{ event: 'authenticated'/)
  })

  test('flushes action terminal frames before exiting instead of waiting on proxy cleanup', () => {
    const actionStart = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf('async function fetchApi')
    const probeStart = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf(
      '\nasync function authenticatedProbe',
      actionStart,
    )
    assert.ok(actionStart >= 0 && probeStart > actionStart)
    const actionSource = KNOWLEDGE_PLANET_WORKER_SOURCE.slice(actionStart, probeStart)
    assert.match(
      actionSource,
      /if \(!response\.ok\(\) \|\| data\?\.succeeded !== true\) \{[\s\S]*await writeTerminalAndExit\(\{ event: 'failed'/,
    )
    assert.match(
      actionSource,
      /catch \{[\s\S]*response\.status\(\) === 401[\s\S]*code: 'LOGIN_EXPIRED'/,
    )
    assert.match(actionSource, /await writeTerminalAndExit\(completed\)/)
    assert.doesNotMatch(actionSource, /writeFrame\(completed\)/)
    assert.doesNotMatch(actionSource, /writeFrame\(\{ event: 'failed'/)
  })

  test('waits for the real QR image and never publishes the iframe loading mask', () => {
    assert.equal(KNOWLEDGE_PLANET_QR_CAPTURE_TIMEOUT_MS, 45_000)
    assert.equal(KNOWLEDGE_PLANET_QR_MIN_DARK_FRACTION, 0.15)
    assert.equal(KNOWLEDGE_PLANET_QR_MIN_LIGHT_FRACTION, 0.2)
    assert.equal(KNOWLEDGE_PLANET_QR_MIN_LUMINANCE_DEVIATION, 70)
    assert.equal(
      isKnowledgePlanetQrPixelSampleReady({
        darkFraction: 0.378,
        lightFraction: 0.547,
        luminanceDeviation: 117.9,
      }),
      true,
    )
    assert.equal(
      isKnowledgePlanetQrPixelSampleReady({
        darkFraction: 0.0011,
        lightFraction: 0.7,
        luminanceDeviation: 19.25,
      }),
      false,
    )
    const captureStart = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf('async function captureQr')
    const captureEnd = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf('async function runLogin')
    assert.ok(captureStart >= 0 && captureEnd > captureStart)
    const captureSource = KNOWLEDGE_PLANET_WORKER_SOURCE.slice(captureStart, captureEnd)
    assert.match(
      KNOWLEDGE_PLANET_WORKER_SOURCE,
      /async function beforeCaptureDeadline\(operation,[\s\S]*Promise\.race\([\s\S]*Promise\.resolve\(\)\.then\(operation\)[\s\S]*setTimeout\(\(\) => reject\(new Error\('qr'\)\), remaining\)/,
    )
    assert.match(captureSource, /while \(Date\.now\(\) < captureDeadline\)/)
    assert.match(captureSource, /let requested = false/)
    assert.match(captureSource, /let consentHandled = false/)
    assert.match(captureSource, /consentHandled = true;[\s\S]*requested = false/)
    assert.match(
      captureSource,
      /requested = await beforeCaptureDeadline\([\s\S]*\(\) => qrButton\.click\(\{ timeout:/,
    )
    assert.match(captureSource, /!element\.complete \|\| element\.naturalWidth < 180/)
    assert.match(captureSource, /style\.filter !== 'none'/)
    assert.match(captureSource, /Number\(style\.opacity\) < 0\.99/)
    assert.match(captureSource, /document\.elementFromPoint\([\s\S]*\) !== element/)
    assert.match(captureSource, /sampleContext\.fillStyle = '#fff'/)
    assert.match(captureSource, /sampleContext\.imageSmoothingEnabled = false/)
    assert.match(captureSource, /sampleContext\.getImageData/)
    assert.match(captureSource, /output\.toDataURL\('image\/png'\)/)
    assert.match(captureSource, /png\.toString\('base64'\) !== encodedQr/)
    assert.match(captureSource, /Buffer\.from\(\[137, 80, 78, 71, 13, 10, 26, 10\]\)/)
    assert.match(
      captureSource,
      /beforeCaptureDeadline\(\(\) => image\.isVisible\(\), captureDeadline\)/,
    )
    assert.match(
      captureSource,
      /beforeCaptureDeadline\(\(\) => images\.count\(\), captureDeadline\)/,
    )
    assert.match(
      captureSource,
      /beforeCaptureDeadline\([\s\S]*\(\) => image\.evaluate\([\s\S]*undefined,[\s\S]*timeout: remainingCaptureTimeout\(captureDeadline\)[\s\S]*captureDeadline/,
    )
    assert.match(captureSource, /remainingCaptureTimeout\(captureDeadline\);\s*return png/)
    assert.doesNotMatch(captureSource, /\.screenshot\(|iframe/)
    assert.match(
      KNOWLEDGE_PLANET_WORKER_SOURCE,
      /const qrCaptureDeadline = Math\.min\(input\.deadlineMs,[\s\S]*const qrButton =[\s\S]*const switchButton =[\s\S]*const qr = await beforeCaptureDeadline\([\s\S]*captureQr\(page, qrButton, switchButton, qrCaptureDeadline\)[\s\S]*remainingCaptureTimeout\(qrCaptureDeadline\);\s*writeFrame/,
    )
    const deadlineStart = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf('const qrCaptureDeadline')
    const captureCall = KNOWLEDGE_PLANET_WORKER_SOURCE.indexOf(
      'const qr = await beforeCaptureDeadline(',
    )
    assert.ok(deadlineStart >= 0 && captureCall > deadlineStart)
    assert.doesNotMatch(
      KNOWLEDGE_PLANET_WORKER_SOURCE.slice(deadlineStart, captureCall),
      /\.click\(\)/,
    )
  })

  test('materialized worker source is valid JavaScript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-kp-worker-source-'))
    roots.push(root)
    const path = join(root, 'worker.mjs')
    await writeFile(path, KNOWLEDGE_PLANET_WORKER_SOURCE)
    const status = await new Promise<number | null>((resolveStatus) => {
      const child = spawn(process.execPath, ['--check', path], { stdio: 'ignore' })
      child.once('exit', resolveStatus)
    })
    assert.equal(status, 0)
  })

  test('keeps worst-case topic pages plus account state below the worker frame ceiling', () => {
    const jsonStringAtMost = (bytes: number) => '汉'.repeat(Math.floor((bytes - 2) / 3))
    const topic = {
      id: '123456',
      title: jsonStringAtMost(1024),
      text: jsonStringAtMost(12 * 1024),
      question: jsonStringAtMost(8 * 1024),
      answer: jsonStringAtMost(8 * 1024),
      article: { title: jsonStringAtMost(1024), summary: jsonStringAtMost(4 * 1024) },
      files: Array.from({ length: 10 }, (_, index) => ({
        id: String(123456 + index),
        name: jsonStringAtMost(1024),
        type: jsonStringAtMost(256),
      })),
      images: Array.from({ length: 10 }, (_, index) => ({ id: String(223456 + index) })),
    }
    const storageState = {
      cookies: [{ value: 'x'.repeat(KNOWLEDGE_PLANET_WORKER_MAX_STATE_JSON_BYTES - 128) }],
      origins: [],
    }
    const stateBytes = Buffer.byteLength(JSON.stringify(storageState), 'utf8')
    assert.ok(stateBytes <= KNOWLEDGE_PLANET_WORKER_MAX_STATE_JSON_BYTES)
    const completed = {
      event: 'completed',
      result: { topics: Array.from({ length: KNOWLEDGE_PLANET_TOPIC_PAGE_MAX }, () => topic) },
      storageState,
    }
    assert.ok(
      Buffer.byteLength(JSON.stringify(completed), 'utf8') <
        KNOWLEDGE_PLANET_WORKER_MAX_OUTPUT_BYTES,
    )
    assert.match(KNOWLEDGE_PLANET_WORKER_SOURCE, /while \(result\[listKey\]\.length > 0/)
  })

  test('keeps a worst-case flattened comment page plus account state below the worker frame ceiling', () => {
    const comment = {
      id: '123456',
      rootCommentId: '123456',
      parentCommentId: '223456',
      depth: KNOWLEDGE_PLANET_COMMENT_RESULT_MAX - 1,
      createdAt: '2026-07-18T00:00:00.000+0800',
      text: '😀'.repeat(1_200),
      author: { id: '323456', name: '😀'.repeat(128) },
      replyTo: { id: '423456', name: '😀'.repeat(128) },
      likeCount: 999_999,
      replyCount: 999_999,
      returnedReplyCount: 999_999,
      repliesComplete: false,
      sticky: true,
      liked: true,
      images: [
        {
          id: '523456',
          type: 'image/'.concat('x'.repeat(58)),
          width: 99_999,
          height: 99_999,
          size: 50 * 1024 * 1024,
        },
      ],
      contentDigest: 'f'.repeat(64),
    }
    const storageState = {
      cookies: [{ value: 'x'.repeat(KNOWLEDGE_PLANET_WORKER_MAX_STATE_JSON_BYTES - 128) }],
      origins: [],
    }
    const completed = {
      event: 'completed',
      result: {
        comments: Array.from({ length: KNOWLEDGE_PLANET_COMMENT_RESULT_MAX }, () => comment),
        topLevelCount: 50,
        returnedCount: KNOWLEDGE_PLANET_COMMENT_RESULT_MAX,
        truncated: true,
        hasPartialReplies: true,
        page: { count: 50, sort: 'asc' },
      },
      storageState,
    }
    assert.ok(
      Buffer.byteLength(JSON.stringify(completed), 'utf8') <
        KNOWLEDGE_PLANET_WORKER_MAX_OUTPUT_BYTES,
    )
  })

  test('decodes coalesced ready plus a near-limit completed frame independently', () => {
    const workerFrame = (value: unknown) => {
      const body = Buffer.from(JSON.stringify(value))
      const header = Buffer.alloc(4)
      header.writeUInt32BE(body.length)
      return Buffer.concat([header, body])
    }
    const ready = workerFrame({
      event: 'ready',
      runtime: 'knowledge-planet-worker-v1.5',
      playwrightMcpVersion: '0.0.76',
    })
    const completedBase = {
      event: 'completed',
      result: { padding: '' },
      storageState: { cookies: [], origins: [] },
    }
    const completed = workerFrame({
      ...completedBase,
      result: {
        padding: 'x'.repeat(
          KNOWLEDGE_PLANET_WORKER_MAX_OUTPUT_BYTES -
            Buffer.byteLength(JSON.stringify(completedBase), 'utf8'),
        ),
      },
    })
    assert.equal(completed.length, KNOWLEDGE_PLANET_WORKER_MAX_OUTPUT_BYTES + 4)
    assert.ok(ready.length + completed.length > KNOWLEDGE_PLANET_WORKER_MAX_OUTPUT_BYTES + 4)
    assert.equal(decodeKnowledgePlanetWorkerFramesForTest(Buffer.concat([ready, completed])), 2)
  })

  test('normalizes explicit-port login pins before browser route checks', () => {
    assert.ok(KNOWLEDGE_PLANET_LOGIN_ORIGINS.every((origin) => origin.endsWith(':443')))
    assert.ok(
      KNOWLEDGE_PLANET_WORKER_SOURCE.includes(
        'new Set(input.allowedOrigins.map((origin) => new URL(origin).origin))',
      ),
    )
  })

  test('registers only the fixed official driver/launcher pair', () => {
    const service = {} as KnowledgePlanetDockerService
    const registries = createKnowledgePlanetRuntimeRegistries(service)
    assert.deepEqual(
      [...registries.drivers.keys()],
      [`${KNOWLEDGE_PLANET_DRIVER_ID}@${KNOWLEDGE_PLANET_DRIVER_VERSION}`],
    )
    assert.deepEqual(
      [...registries.launchers.keys()],
      [`${KNOWLEDGE_PLANET_LAUNCHER_ID}@${KNOWLEDGE_PLANET_LAUNCHER_VERSION}`],
    )
    assert.equal(KNOWLEDGE_PLANET_DRIVER_ID, `kp-${KNOWLEDGE_PLANET_WORKER_DIGEST.slice(0, 60)}`)
    assert.equal(
      KNOWLEDGE_PLANET_LAUNCHER_ID,
      `kp-container-${KNOWLEDGE_PLANET_WORKER_DIGEST.slice(0, 50)}`,
    )
    const driver = registries.drivers.get(
      `${KNOWLEDGE_PLANET_DRIVER_ID}@${KNOWLEDGE_PLANET_DRIVER_VERSION}`,
    )
    assert.ok(driver)
    assert.deepEqual(
      driver.maximumNetwork.origins.map((origin) => new URL(origin).origin),
      KNOWLEDGE_PLANET_PLUGIN_CONTRACT.runtime.network.origins.map(
        (origin) => new URL(origin).origin,
      ),
    )
    assert.deepEqual(
      driver.maximumNetwork.methods,
      KNOWLEDGE_PLANET_PLUGIN_CONTRACT.runtime.network.methods,
    )
    assert.equal(
      new ManagedBrowserRuntime({
        ...registries,
        profileRoot: '/tmp/not-used',
      }).supportsContract(KNOWLEDGE_PLANET_PLUGIN_CONTRACT),
      true,
    )
  })

  test('refuses a tag before any Docker worker can be created', async () => {
    let inspected = false
    const docker = {
      getImage() {
        inspected = true
        throw new Error('must not inspect a tag')
      },
    } as unknown as Docker
    const service = new KnowledgePlanetDockerService(docker, {
      imageId: 'openclaude-runtime:v5',
      workerRoot: '/tmp/not-used',
      brokerRoot: '/tmp/not-used',
    })
    await assert.rejects(
      service.runAction({
        profileDir: '/tmp/not-used-profile',
        pins: [],
        storageState: { cookies: [], origins: [] },
        actionId: 'list_groups',
        params: {},
        deadlineMs: Date.now() + 10_000,
      }),
      (error: unknown) =>
        error instanceof KnowledgePlanetRuntimeError && error.code === 'IMAGE_MISMATCH',
    )
    assert.equal(inspected, false)
  })

  test('uses fixed Docker slots as an atomic host-wide total cap', async () => {
    const attempted: string[] = []
    const docker = {
      async createContainer(options: Docker.ContainerCreateOptions) {
        attempted.push(options.name ?? '')
        throw Object.assign(new Error('name is already in use'), { statusCode: 409 })
      },
      async listContainers() {
        return []
      },
    } as unknown as Docker
    const service = new KnowledgePlanetDockerService(docker, {
      imageId: `sha256:${'0'.repeat(64)}`,
      workerRoot: '/tmp/not-used',
      brokerRoot: '/tmp/not-used',
      maxWorkers: 2,
    })
    const createInSlot = (
      service as unknown as {
        createContainerInHostSlot(options: Docker.ContainerCreateOptions): Promise<Docker.Container>
      }
    ).createContainerInHostSlot.bind(service)
    await assert.rejects(
      createInSlot({ Image: `sha256:${'0'.repeat(64)}` }),
      (error: unknown) =>
        error instanceof KnowledgePlanetRuntimeError && error.code === 'CAPACITY_EXCEEDED',
    )
    assert.deepEqual(attempted, ['oc-v5-kp-worker-slot-0', 'oc-v5-kp-worker-slot-1'])
  })

  test('reclaims an expired fixed-slot orphan and retries without a gateway restart', async () => {
    let occupied = true
    let removals = 0
    let listFilters: unknown
    const attempted: string[] = []
    const created = { id: 'new-worker' } as unknown as Docker.Container
    const docker = {
      async createContainer(options: Docker.ContainerCreateOptions) {
        attempted.push(options.name ?? '')
        if (occupied) throw Object.assign(new Error('name is already in use'), { statusCode: 409 })
        return created
      },
      async listContainers(options?: Docker.ContainerListOptions) {
        listFilters = options?.filters ?? ''
        return occupied
          ? [
              {
                Id: 'foreign-worker',
                Labels: {
                  'com.openclaude.plugin.worker': 'another-managed-browser-plugin-v1',
                  'com.openclaude.plugin.expires_at_ms': String(Date.now() - 60_000),
                },
              },
              {
                Id: 'expired-worker',
                Labels: {
                  'com.openclaude.plugin.worker': 'knowledge-planet-v1',
                  'com.openclaude.plugin.expires_at_ms': String(Date.now() - 60_000),
                },
              },
            ]
          : []
      },
      getContainer(id: string) {
        assert.equal(id, 'expired-worker')
        return {
          async kill() {},
          async remove() {
            removals++
            occupied = false
          },
          async inspect() {
            return occupied ? {} : null
          },
        }
      },
    } as unknown as Docker
    const service = new KnowledgePlanetDockerService(docker, {
      imageId: `sha256:${'0'.repeat(64)}`,
      workerRoot: '/tmp/not-used',
      brokerRoot: '/tmp/not-used',
      orphanGraceMs: 0,
      maxWorkers: 1,
    })
    const createInSlot = (
      service as unknown as {
        createContainerInHostSlot(options: Docker.ContainerCreateOptions): Promise<Docker.Container>
      }
    ).createContainerInHostSlot.bind(service)
    assert.equal(await createInSlot({ Image: `sha256:${'0'.repeat(64)}` }), created)
    assert.equal(removals, 1)
    assert.deepEqual(typeof listFilters === 'string' ? JSON.parse(listFilters) : listFilters, {
      label: ['com.openclaude.plugin.worker'],
    })
    assert.deepEqual(attempted, ['oc-v5-kp-worker-slot-0', 'oc-v5-kp-worker-slot-0'])
  })

  test('does not create a worker if an action aborts during image initialization', async () => {
    const imageId = `sha256:${'0'.repeat(64)}`
    let resolveInspect!: () => void
    const inspect = new Promise<{ Id: string }>((resolve) => {
      resolveInspect = () => resolve({ Id: imageId })
    })
    let created = false
    const docker = {
      getImage() {
        return { inspect: () => inspect }
      },
      async listContainers() {
        return []
      },
      createContainer() {
        created = true
        throw new Error('worker must not be created after abort')
      },
    } as unknown as Docker
    const root = await mkdtemp(join(tmpdir(), 'oc-kp-abort-'))
    roots.push(root)
    const service = new KnowledgePlanetDockerService(docker, {
      imageId,
      workerRoot: join(root, 'workers'),
      brokerRoot: join(root, 'brokers'),
    })
    const controller = new AbortController()
    const aborted = new Error('cancelled')
    const action = service.runAction({
      profileDir: join(root, 'profile'),
      pins: [],
      storageState: { cookies: [], origins: [] },
      actionId: 'list_groups',
      params: {},
      deadlineMs: Date.now() + 10_000,
      signal: controller.signal,
    })
    controller.abort(aborted)
    resolveInspect()
    await assert.rejects(action, (error: unknown) => error === aborted)
    assert.equal(created, false)
  })

  test('atomically caps pending action workers and releases capacity after startup abort', async () => {
    const imageId = `sha256:${'1'.repeat(64)}`
    let resolveInspect!: () => void
    const inspect = new Promise<{ Id: string }>((resolve) => {
      resolveInspect = () => resolve({ Id: imageId })
    })
    let created = false
    const docker = {
      getImage() {
        return { inspect: () => inspect }
      },
      async listContainers() {
        return []
      },
      createContainer() {
        created = true
        throw new Error('worker must not be created after abort')
      },
    } as unknown as Docker
    const root = await mkdtemp(join(tmpdir(), 'oc-kp-capacity-'))
    roots.push(root)
    const service = new KnowledgePlanetDockerService(docker, {
      imageId,
      workerRoot: join(root, 'workers'),
      brokerRoot: join(root, 'brokers'),
      maxWorkers: 1,
      maxActionWorkers: 1,
    })
    const firstController = new AbortController()
    const first = service.runAction({
      profileDir: join(root, 'profile-1'),
      pins: [],
      storageState: { cookies: [], origins: [] },
      actionId: 'list_groups',
      params: {},
      deadlineMs: Date.now() + 10_000,
      signal: firstController.signal,
    })
    await assert.rejects(
      service.runAction({
        profileDir: join(root, 'profile-2'),
        pins: [],
        storageState: { cookies: [], origins: [] },
        actionId: 'list_groups',
        params: {},
        deadlineMs: Date.now() + 10_000,
      }),
      (error: unknown) =>
        error instanceof KnowledgePlanetRuntimeError && error.code === 'CAPACITY_EXCEEDED',
    )
    const firstAbort = new Error('first cancelled')
    firstController.abort(firstAbort)
    resolveInspect()
    await assert.rejects(first, (error: unknown) => error === firstAbort)

    const nextController = new AbortController()
    const nextAbort = new Error('next cancelled')
    const next = service.runAction({
      profileDir: join(root, 'profile-3'),
      pins: [],
      storageState: { cookies: [], origins: [] },
      actionId: 'list_groups',
      params: {},
      deadlineMs: Date.now() + 10_000,
      signal: nextController.signal,
    })
    nextController.abort(nextAbort)
    await assert.rejects(next, (error: unknown) => error === nextAbort)
    assert.equal(created, false)
  })

  test('caps concurrent login workers and shutdown waits for pending reservations', async () => {
    const imageId = `sha256:${'2'.repeat(64)}`
    let resolveInspect!: () => void
    const inspect = new Promise<{ Id: string }>((resolve) => {
      resolveInspect = () => resolve({ Id: imageId })
    })
    let created = false
    const docker = {
      getImage() {
        return { inspect: () => inspect }
      },
      async listContainers() {
        return []
      },
      createContainer() {
        created = true
        throw new Error('worker must not start while closing')
      },
    } as unknown as Docker
    const root = await mkdtemp(join(tmpdir(), 'oc-kp-login-capacity-'))
    roots.push(root)
    const service = new KnowledgePlanetDockerService(docker, {
      imageId,
      workerRoot: join(root, 'workers'),
      brokerRoot: join(root, 'brokers'),
      maxWorkers: 2,
      maxLoginWorkers: 1,
    })
    const callbacks = {
      pins: [],
      deadlineMs: Date.now() + 10_000,
      onQr() {},
      onAuthenticated() {},
      onFailed() {},
    }
    const first = service.startLogin({ sessionId: randomUUID(), ...callbacks })
    await assert.rejects(
      service.startLogin({ sessionId: randomUUID(), ...callbacks }),
      (error: unknown) =>
        error instanceof KnowledgePlanetRuntimeError && error.code === 'CAPACITY_EXCEEDED',
    )
    const closing = service.closeAndDrain()
    resolveInspect()
    await assert.rejects(
      first,
      (error: unknown) => error instanceof KnowledgePlanetRuntimeError && error.code === 'CLOSING',
    )
    await closing
    assert.equal(created, false)
  })
})
