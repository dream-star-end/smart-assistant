/**
 * 无票 inbound 沿用存活 runner 的 model/engine,禁止用 agent 默认改判。
 *
 * 锁住的是 decideLocalExecution 阶梯 + localExecutionOverride 喂给 getOrCreate
 * 之后「不 teardown 现存 runner」这条生产路径。dispatchInbound 只是把
 * `readLiveRunnerModel(getByKey(sessionKey))` 在 catalog 拉完后喂进来。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/ticketlessInboundLiveEngine.test.ts
 */

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import type { AgentDef, OpenClaudeConfig } from '@openclaude/storage'

import '../engine/ccbAdapter.js'
import '../engine/cursorAdapter.js'
import {
  type LocalCatalogView,
  ModelCatalogClient,
  _setModelCatalogClientForTests,
  parseCatalogResponse,
} from '../modelCatalogClient.js'
import {
  Gateway,
  TICKETLESS_INBOUND_LIVE_SESSION_FALLBACK_WARN,
  TICKETLESS_LIVE_SESSION_REPLACING_REASON,
  decideLocalExecution,
  localExecutionOverride,
  liveSessionModelUnusableReason,
  liveSessionReuseSkipReason,
  readLiveRunnerModel,
  resolveLocalExecutionIfEnforced,
} from '../server.js'
import { SessionManager } from '../sessionManager.js'

const MASTER_ENV = {
  OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master.invalid:18791',
  OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.1.deadbeef',
} as NodeJS.ProcessEnv

const ON = { ...MASTER_ENV, OC_MODEL_AUTHORITY: '1' } as NodeJS.ProcessEnv
const EXEMPT = { OC_SELFHOST_ENGINE_LOCAL_TURNS: '1' } as NodeJS.ProcessEnv

function row(
  model_id: string,
  engine: 'ccb' | 'codex' | 'grok' | 'cursor',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model_id,
    display_name: model_id,
    engine,
    provider_id: engine === 'ccb' ? 'ark' : engine,
    context_window: 200_000,
    supported_efforts: ['high'],
    supports_vision: false,
    capability_zero: engine === 'ccb',
    supports_thinking: engine === 'ccb',
    default_effort: 'high',
    ...extra,
  }
}

function view(models: Array<Record<string, unknown>>): LocalCatalogView {
  return parseCatalogResponse({
    models,
    projection_revision: 'proj-ticketless-1',
    security_epoch: '7',
  })
}

function catalogView(): LocalCatalogView {
  return view([
    row('cursor-auto', 'cursor'),
    row('cursor-grok-4.6-high', 'cursor'),
    row('glm-5.2', 'ccb'),
    row('deepseek-v4-pro', 'ccb'),
  ])
}

const MAIN: Pick<AgentDef, 'id' | 'model' | 'provider'> = { id: 'main', model: 'glm-5.2' }

function makeConfig(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
    defaults: { model: 'glm-5.2' },
  } as unknown as OpenClaudeConfig
}

afterEach(() => {
  _setModelCatalogClientForTests(null)
})

describe('readLiveRunnerModel', () => {
  test('没有 session → undefined(冷启动)', () => {
    assert.equal(readLiveRunnerModel(undefined), undefined)
    assert.equal(readLiveRunnerModel(null), undefined)
  })

  test('优先 runner.model,不读空字符串,其次 session.model', () => {
    assert.equal(
      readLiveRunnerModel({ runner: { model: 'cursor-auto' }, model: 'glm-5.2' }),
      'cursor-auto',
    )
    assert.equal(readLiveRunnerModel({ runner: { model: '' }, model: 'cursor-grok-4.6-high' }), 'cursor-grok-4.6-high')
    assert.equal(readLiveRunnerModel({ model: 'cursor-auto' }), 'cursor-auto')
  })

  test('_replacing 中的 session 不得沿用 → undefined', () => {
    const replacing = { runner: { model: 'cursor-auto' }, model: 'cursor-auto', _replacing: true }
    assert.equal(readLiveRunnerModel(replacing), undefined)
    assert.equal(liveSessionReuseSkipReason(replacing), TICKETLESS_LIVE_SESSION_REPLACING_REASON)
    assert.equal(liveSessionReuseSkipReason({ runner: { model: 'cursor-auto' } }), undefined)
  })
})

describe('无票 inbound + 存活 runner → 沿用会话 engine/model', () => {
  test('liveSessionModel 可路由 → 取会话模型,不是 agent 默认', () => {
    const d = decideLocalExecution({
      view: catalogView(),
      agent: MAIN,
      liveSessionModel: 'cursor-grok-4.6-high',
      defaultModel: 'glm-5.2',
      kind: 'turn',
      env: EXEMPT,
    })
    assert.equal(d.canonicalModel, 'cursor-grok-4.6-high')
    assert.equal(d.engine, 'cursor')
    assert.equal(d.liveSessionFallback, undefined)
    assert.deepEqual(localExecutionOverride(d), {
      model: 'cursor-grok-4.6-high',
      executionAuthority: {
        canonicalModel: 'cursor-grok-4.6-high',
        engine: 'cursor',
        source: 'local_catalog',
      },
    })
  })

  test('getOrCreate + local_catalog 权威:沿用会话不 teardown 现存 cursor runner', async () => {
    const prevAuth = process.env.OC_MODEL_AUTHORITY
    const prevExempt = process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS
    process.env.OC_MODEL_AUTHORITY = '1'
    process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'
    const key = 'agent:main:webchat:dm:ticketless-keep'
    const sm = new SessionManager(makeConfig())
    try {
      const first = await sm.getOrCreate({
        sessionKey: key,
        agent: { id: 'main', model: 'glm-5.2' } as AgentDef,
        channel: 'webchat',
        peerId: 'ticketless-keep',
        model: 'cursor-auto',
        executionAuthority: {
          canonicalModel: 'cursor-auto',
          engine: 'cursor',
          source: 'local_catalog',
        },
      })
      assert.equal(first.providerTag, 'cursor')
      let shutdown = false
      const orig = first.runner.shutdown.bind(first.runner)
      first.runner.shutdown = async () => {
        shutdown = true
        await orig()
      }

      const d = decideLocalExecution({
        view: catalogView(),
        agent: MAIN,
        liveSessionModel: readLiveRunnerModel(first),
        defaultModel: 'glm-5.2',
        kind: 'turn',
        env: EXEMPT,
      })
      assert.equal(d.engine, 'cursor')
      const again = await sm.getOrCreate({
        sessionKey: key,
        agent: { id: 'main', model: 'glm-5.2' } as AgentDef,
        channel: 'webchat',
        peerId: 'ticketless-keep',
        ...localExecutionOverride(d),
      })
      assert.equal(again, first, '无票 inbound 必须复用现存 cursor session')
      assert.equal(again.providerTag, 'cursor')
      assert.equal(shutdown, false, '不得 teardown 现存 runner')
    } finally {
      if (prevAuth === undefined) Reflect.deleteProperty(process.env, 'OC_MODEL_AUTHORITY')
      else process.env.OC_MODEL_AUTHORITY = prevAuth
      if (prevExempt === undefined) Reflect.deleteProperty(process.env, 'OC_SELFHOST_ENGINE_LOCAL_TURNS')
      else process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = prevExempt
    }
  })
})

describe('无票 inbound + 无 runner → 走 agent 默认', () => {
  test('不传 liveSessionModel 时阶梯与原来相同', () => {
    const d = decideLocalExecution({
      view: catalogView(),
      agent: MAIN,
      defaultModel: 'deepseek-v4-pro',
      kind: 'turn',
    })
    assert.equal(d.canonicalModel, 'glm-5.2')
    assert.equal(d.engine, 'ccb')
    assert.equal(d.liveSessionFallback, undefined)
  })
})

describe('带 model 的 inbound → 行为不变', () => {
  test('显式 model 优先于存活 runner 模型(用户换模型)', () => {
    const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = []
    const d = decideLocalExecution({
      view: catalogView(),
      agent: MAIN,
      model: 'glm-5.2',
      liveSessionModel: 'cursor-auto',
      defaultModel: 'glm-5.2',
      kind: 'turn',
      env: EXEMPT,
      warn: (msg, fields) => {
        warns.push({ msg, fields })
      },
    })
    assert.equal(d.canonicalModel, 'glm-5.2')
    assert.equal(d.engine, 'ccb')
    assert.equal(d.liveSessionFallback, undefined)
    assert.equal(warns.length, 0, '带 model 的 inbound 不是无票沿用,不得打回退 warn')
  })

  test('getOrCreate:显式换到 ccb 仍会切引擎(用户选择器路径不变)', async () => {
    const prevAuth = process.env.OC_MODEL_AUTHORITY
    process.env.OC_MODEL_AUTHORITY = '1'
    const key = 'agent:main:webchat:dm:ticketless-switch'
    const sm = new SessionManager(makeConfig())
    try {
      const first = await sm.getOrCreate({
        sessionKey: key,
        agent: { id: 'main', model: 'glm-5.2' } as AgentDef,
        channel: 'webchat',
        peerId: 'ticketless-switch',
        model: 'cursor-auto',
        executionAuthority: {
          canonicalModel: 'cursor-auto',
          engine: 'cursor',
          source: 'local_catalog',
        },
      })
      const switched = await sm.getOrCreate({
        sessionKey: key,
        agent: { id: 'main', model: 'glm-5.2' } as AgentDef,
        channel: 'webchat',
        peerId: 'ticketless-switch',
        model: 'glm-5.2',
        executionAuthority: {
          canonicalModel: 'glm-5.2',
          engine: 'ccb',
          source: 'local_catalog',
        },
      })
      assert.notEqual(switched, first)
      assert.equal(switched.providerTag, 'ccb')
    } finally {
      if (prevAuth === undefined) Reflect.deleteProperty(process.env, 'OC_MODEL_AUTHORITY')
      else process.env.OC_MODEL_AUTHORITY = prevAuth
    }
  })
})

describe('沿用模型不可用 → 回退且有日志', () => {
  test('available=false → 回退 agent 默认,warn 含原因与回退目标', () => {
    const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = []
    const v = view([row('cursor-auto', 'cursor', { available: false }), row('glm-5.2', 'ccb')])
    assert.equal(liveSessionModelUnusableReason(v, 'cursor-auto'), 'unavailable')
    const d = decideLocalExecution({
      view: v,
      agent: MAIN,
      liveSessionModel: 'cursor-auto',
      defaultModel: 'glm-5.2',
      kind: 'turn',
      env: EXEMPT,
      warn: (msg, fields) => {
        warns.push({ msg, fields })
      },
    })
    assert.equal(d.canonicalModel, 'glm-5.2')
    assert.equal(d.engine, 'ccb')
    assert.deepEqual(d.liveSessionFallback, { from: 'cursor-auto', reason: 'unavailable' })
    assert.equal(warns.length, 1)
    assert.equal(warns[0]?.msg, TICKETLESS_INBOUND_LIVE_SESSION_FALLBACK_WARN)
    assert.equal(warns[0]?.fields?.liveModel, 'cursor-auto')
    assert.equal(warns[0]?.fields?.reason, 'unavailable')
    assert.equal(warns[0]?.fields?.fallbackModel, 'glm-5.2')
  })

  test('不在投影(未授权/已下线摘掉) → not_in_projection', () => {
    const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = []
    const d = decideLocalExecution({
      view: view([row('glm-5.2', 'ccb')]),
      agent: MAIN,
      liveSessionModel: 'cursor-auto',
      kind: 'turn',
      env: EXEMPT,
      warn: (msg, fields) => {
        warns.push({ msg, fields })
      },
    })
    assert.equal(d.canonicalModel, 'glm-5.2')
    assert.equal(d.liveSessionFallback?.reason, 'not_in_projection')
    assert.equal(warns[0]?.msg, TICKETLESS_INBOUND_LIVE_SESSION_FALLBACK_WARN)
    assert.equal(warns[0]?.fields?.reason, 'not_in_projection')
    assert.equal(warns[0]?.fields?.fallbackModel, 'glm-5.2')
  })

  test('生产豁免门未开:沿用 cursor 失败则回退 agent 默认,不把整条 turn 拒掉', () => {
    const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = []
    const d = decideLocalExecution({
      view: catalogView(),
      agent: MAIN,
      liveSessionModel: 'cursor-auto',
      kind: 'turn',
      env: {} as NodeJS.ProcessEnv,
      warn: (msg, fields) => {
        warns.push({ msg, fields })
      },
    })
    assert.equal(d.canonicalModel, 'glm-5.2')
    assert.equal(d.engine, 'ccb')
    assert.equal(d.liveSessionFallback?.reason, 'engine_local_turn_not_exempt')
    assert.equal(warns[0]?.fields?.reason, 'engine_local_turn_not_exempt')
  })
})

describe('resolveLocalExecutionIfEnforced 在 catalog 之后取样存活 runner', () => {
  test('resolveLiveSessionModel 在 getView 之后调用,沿用其返回值', async () => {
    const order: string[] = []
    _setModelCatalogClientForTests({
      getRoutingView: async () => {
        order.push('view')
        return catalogView()
      },
    } as unknown as ModelCatalogClient)
    const d = await resolveLocalExecutionIfEnforced({
      agent: MAIN,
      kind: 'turn',
      defaultModel: 'glm-5.2',
      env: { ...ON, OC_SELFHOST_ENGINE_LOCAL_TURNS: '1' },
      resolveLiveSessionModel: () => {
        order.push('live')
        return 'cursor-auto'
      },
    })
    assert.deepEqual(order, ['view', 'live'])
    assert.equal(d?.canonicalModel, 'cursor-auto')
    assert.equal(d?.engine, 'cursor')
  })
})

describe('正在替换/关闭的 session 不得沿用', () => {
  test('liveSessionSkipReason=session_replacing → 走原阶梯 + warn', () => {
    const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = []
    const replacing = { runner: { model: 'cursor-auto' }, model: 'cursor-auto', _replacing: true }
    assert.equal(readLiveRunnerModel(replacing), undefined)
    const d = decideLocalExecution({
      view: catalogView(),
      agent: MAIN,
      liveSessionModel: 'cursor-auto',
      liveSessionSkipReason: liveSessionReuseSkipReason(replacing),
      defaultModel: 'glm-5.2',
      kind: 'turn',
      env: EXEMPT,
      warn: (msg, fields) => {
        warns.push({ msg, fields })
      },
    })
    assert.equal(d.canonicalModel, 'glm-5.2')
    assert.equal(d.engine, 'ccb')
    assert.deepEqual(d.liveSessionFallback, { from: '', reason: TICKETLESS_LIVE_SESSION_REPLACING_REASON })
    assert.equal(warns.length, 1)
    assert.equal(warns[0]?.msg, TICKETLESS_INBOUND_LIVE_SESSION_FALLBACK_WARN)
    assert.equal(warns[0]?.fields?.reason, TICKETLESS_LIVE_SESSION_REPLACING_REASON)
    assert.equal(warns[0]?.fields?.fallbackModel, 'glm-5.2')
  })

  test('catalog 之后取样到 _replacing → 不沿用 + warn reason 正确', async () => {
    const warns: Array<{ msg: string; fields?: Record<string, unknown> }> = []
    const order: string[] = []
    const replacing = { runner: { model: 'cursor-auto' }, _replacing: true }
    _setModelCatalogClientForTests({
      getRoutingView: async () => {
        order.push('view')
        return catalogView()
      },
    } as unknown as ModelCatalogClient)
    const d = await resolveLocalExecutionIfEnforced({
      agent: MAIN,
      kind: 'turn',
      defaultModel: 'glm-5.2',
      env: { ...ON, OC_SELFHOST_ENGINE_LOCAL_TURNS: '1' },
      resolveLiveSessionModel: () => {
        order.push('live')
        return readLiveRunnerModel(replacing)
      },
      resolveLiveSessionSkipReason: () => {
        order.push('skip')
        return liveSessionReuseSkipReason(replacing)
      },
      warn: (msg, fields) => {
        warns.push({ msg, fields })
      },
    })
    assert.deepEqual(order, ['view', 'live', 'skip'])
    assert.equal(d?.canonicalModel, 'glm-5.2')
    assert.equal(d?.engine, 'ccb')
    assert.equal(d?.liveSessionFallback?.reason, TICKETLESS_LIVE_SESSION_REPLACING_REASON)
    assert.equal(warns[0]?.fields?.reason, TICKETLESS_LIVE_SESSION_REPLACING_REASON)
  })

  test('getOrCreate 跨引擎替换时在 shutdown 前就置 _replacing', async () => {
    const prevAuth = process.env.OC_MODEL_AUTHORITY
    process.env.OC_MODEL_AUTHORITY = '1'
    const key = 'agent:main:webchat:dm:ticketless-replacing'
    const sm = new SessionManager(makeConfig())
    try {
      const first = await sm.getOrCreate({
        sessionKey: key,
        agent: { id: 'main', model: 'glm-5.2' } as AgentDef,
        channel: 'webchat',
        peerId: 'ticketless-replacing',
        model: 'cursor-auto',
        executionAuthority: {
          canonicalModel: 'cursor-auto',
          engine: 'cursor',
          source: 'local_catalog',
        },
      })
      let sawReplacing = false
      const orig = first.runner.shutdown.bind(first.runner)
      first.runner.shutdown = async () => {
        sawReplacing = first._replacing === true
        await orig()
      }
      await sm.getOrCreate({
        sessionKey: key,
        agent: { id: 'main', model: 'glm-5.2' } as AgentDef,
        channel: 'webchat',
        peerId: 'ticketless-replacing',
        model: 'glm-5.2',
        executionAuthority: {
          canonicalModel: 'glm-5.2',
          engine: 'ccb',
          source: 'local_catalog',
        },
      })
      assert.equal(sawReplacing, true, 'shutdown 被调用时旧 session 必须已标 _replacing')
    } finally {
      if (prevAuth === undefined) Reflect.deleteProperty(process.env, 'OC_MODEL_AUTHORITY')
      else process.env.OC_MODEL_AUTHORITY = prevAuth
    }
  })
})

describe('detached ask 合成帧不再带 model', () => {
  test('_submitDetachedAskUserAnswer 合成帧只有 text,不带 model', async () => {
    const inboundFrames: unknown[] = []
    const gateway = Object.create(Gateway.prototype) as {
      dispatchInbound: (frame: unknown) => Promise<void>
      _submitDetachedAskUserAnswer: (
        pending: {
          sessionKey: string
          userId: string
          channel: string
          peer: { id: string; kind: 'dm' | 'group' }
        },
        text: string,
        requestId: string,
      ) => Promise<void>
    }
    gateway.dispatchInbound = async (frame: unknown) => {
      inboundFrames.push(frame)
    }
    await gateway._submitDetachedAskUserAnswer(
      {
        sessionKey: 'agent:main:webchat:dm:ticketless-ask',
        userId: 'default',
        channel: 'webchat',
        peer: { id: 'ticketless-ask', kind: 'dm' },
      },
      'Vim',
      'ask-user:ticketless-1',
    )
    assert.equal(inboundFrames.length, 1)
    const frame = inboundFrames[0] as Record<string, unknown>
    assert.equal(frame.type, 'inbound.message')
    assert.deepEqual(frame.content, { text: 'Vim' })
    assert.equal('model' in frame, false, '合成帧不得再带显式 model')
    assert.equal(frame.channel, 'webchat')
    assert.equal(frame.agentId, 'main')
    assert.equal(frame._userId, 'default')
  })
})
