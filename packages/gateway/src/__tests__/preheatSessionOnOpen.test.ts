/**
 * GET /api/sessions/:id 成功后的引擎预热钩子(_preheatSessionOnOpen)契约:
 *   - OC_ENGINE_PREHEAT 未开 → 完全 no-op;
 *   - 容器进程(有 catalog token)走本地 preheatRunner,会话行 modelId 必须进 getOrCreate;
 *   - master 进程(无 token)不本地 spawn,改调 commercial.preheatUserContainer;
 *   - 同 session 短窗去抖;失败 fail-open warn,不外泄到请求路径。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/preheatSessionOnOpen.test.ts
 */
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import {
  Gateway,
  hasContainerCatalogEnv,
  SESSION_OPEN_PREHEAT_DEBOUNCE_MS,
  validateEnginePreheatBody,
} from '../server.js'

type FakeCall = { kind: string; detail?: unknown }

function makeFake(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: FakeCall[] = []
  const fake = {
    log: {
      info: (msg: string) => calls.push({ kind: `log:${msg}` }),
      warn: (msg: string) => calls.push({ kind: `warn:${msg}` }),
      error: (msg: string) => calls.push({ kind: `error:${msg}` }),
    },
    sessions: {
      getByKey: () => undefined,
      getOrCreate: async (opts: { sessionKey: string; model?: string }) => {
        calls.push({ kind: 'getOrCreate', detail: opts })
        return { sessionKey: opts.sessionKey }
      },
      preheatRunner: async () => {
        calls.push({ kind: 'preheatRunner' })
        return 'started'
      },
    },
    _getAgentsConfig: async () => ({ agents: [{ id: 'main' }] }),
    deps: { config: { defaults: { model: 'glm-5.3-zai' } } },
    _sessionOpenPreheatAt: new Map<string, number>(),
    ...overrides,
  }
  return { fake, calls }
}

function invoke(
  fake: unknown,
  row: { agentId?: string; modelId?: string },
  userId = 'default',
): void {
  ;(Gateway.prototype as unknown as {
    _preheatSessionOnOpen: (sessId: string, userId: string, row: unknown) => void
  })._preheatSessionOnOpen.call(fake, 'webtest1234', userId, row)
}

async function settle(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function setContainerEnv(): void {
  process.env.OPENCLAUDE_V3_MASTER_BASE_URL = 'http://172.31.0.1:18892'
  process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'oc-v3.testtoken'
}

function clearContainerEnv(): void {
  Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_MASTER_BASE_URL')
  Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_CONTAINER_TOKEN')
}

const prevGate = process.env.OC_ENGINE_PREHEAT
const prevAuthority = process.env.OC_MODEL_AUTHORITY
const prevMaster = process.env.OPENCLAUDE_V3_MASTER_BASE_URL
const prevToken = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
afterEach(() => {
  if (prevGate === undefined) Reflect.deleteProperty(process.env, 'OC_ENGINE_PREHEAT')
  else process.env.OC_ENGINE_PREHEAT = prevGate
  if (prevAuthority === undefined) Reflect.deleteProperty(process.env, 'OC_MODEL_AUTHORITY')
  else process.env.OC_MODEL_AUTHORITY = prevAuthority
  if (prevMaster === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_MASTER_BASE_URL')
  else process.env.OPENCLAUDE_V3_MASTER_BASE_URL = prevMaster
  if (prevToken === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_V3_CONTAINER_TOKEN')
  else process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = prevToken
})

describe('hasContainerCatalogEnv', () => {
  test('两项都在才是容器', () => {
    clearContainerEnv()
    assert.equal(hasContainerCatalogEnv(), false)
    setContainerEnv()
    assert.equal(hasContainerCatalogEnv(), true)
  })
})

describe('validateEnginePreheatBody', () => {
  test('接受最小合法 payload', () => {
    const r = validateEnginePreheatBody({
      sessionId: 'webtest1234',
      agentId: 'main',
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.payload.sessionId, 'webtest1234')
    assert.equal(r.payload.agentId, 'main')
    assert.equal('modelId' in r.payload, false)
  })
  test('接受带 modelId', () => {
    const r = validateEnginePreheatBody({
      sessionId: 'webtest1234',
      agentId: 'main',
      modelId: 'glm-5.3-zai',
    })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.payload.modelId, 'glm-5.3-zai')
  })
  test('拒绝缺 sessionId / 非法 agentId', () => {
    assert.equal(validateEnginePreheatBody({ agentId: 'main' }).ok, false)
    assert.equal(
      validateEnginePreheatBody({ sessionId: 'webtest1234', agentId: '' }).ok,
      false,
    )
    assert.equal(validateEnginePreheatBody(null).ok, false)
  })
})

describe('_preheatSessionOnOpen', () => {
  test('gate 未开 → 完全 no-op', async () => {
    Reflect.deleteProperty(process.env, 'OC_ENGINE_PREHEAT')
    setContainerEnv()
    const { fake, calls } = makeFake()
    invoke(fake, { agentId: 'main', modelId: 'glm-5.3-zai' })
    await settle()
    assert.deepEqual(calls, [])
  })

  test('容器进程:getOrCreate 带会话行 modelId,随后 preheatRunner', async () => {
    process.env.OC_ENGINE_PREHEAT = '1'
    setContainerEnv()
    Reflect.deleteProperty(process.env, 'OC_MODEL_AUTHORITY')
    const { fake, calls } = makeFake()
    invoke(fake, { agentId: 'main', modelId: 'cursor-opus-5-high' })
    await settle()
    const create = calls.find((c) => c.kind === 'getOrCreate')
    assert.ok(create, 'getOrCreate 必须被调用')
    assert.equal(
      (create!.detail as { model?: string }).model,
      'cursor-opus-5-high',
      '会话行 modelId 必须传进 getOrCreate',
    )
    assert.equal(
      (create!.detail as { sessionKey?: string }).sessionKey,
      'agent:main:webchat:dm:webtest1234',
    )
    assert.ok(calls.some((c) => c.kind === 'preheatRunner'))
  })

  test('容器进程:已有活跃 session → 跳过 getOrCreate 直接 preheatRunner', async () => {
    process.env.OC_ENGINE_PREHEAT = '1'
    setContainerEnv()
    Reflect.deleteProperty(process.env, 'OC_MODEL_AUTHORITY')
    const { fake, calls } = makeFake({
      sessions: {
        getByKey: () => ({ sessionKey: 'agent:main:webchat:dm:webtest1234' }),
        getOrCreate: async () => {
          throw new Error('must not create when session exists')
        },
        preheatRunner: async () => {
          calls.push({ kind: 'preheatRunner' })
          return 'already_running'
        },
      },
    })
    invoke(fake, { agentId: 'main' })
    await settle()
    assert.ok(calls.some((c) => c.kind === 'preheatRunner'))
    assert.equal(calls.some((c) => c.kind === 'getOrCreate'), false)
  })

  test('容器进程:解析/授权抛错 → fail-open 跳过并 warn,不外泄', async () => {
    process.env.OC_ENGINE_PREHEAT = '1'
    setContainerEnv()
    const { fake, calls } = makeFake({
      _getAgentsConfig: async () => {
        throw new Error('catalog projection unavailable')
      },
    })
    invoke(fake, { agentId: 'main', modelId: 'glm-5.3-zai' })
    await settle()
    assert.equal(calls.some((c) => c.kind === 'getOrCreate'), false)
    assert.equal(calls.some((c) => c.kind === 'preheatRunner'), false)
    assert.ok(calls.some((c) => c.kind.startsWith('warn:')), '必须 warn 一条跳过日志')
  })

  test('master 无 token:不本地调 preheatRunner,改调 commercial.preheatUserContainer', async () => {
    process.env.OC_ENGINE_PREHEAT = '1'
    clearContainerEnv()
    const posted: unknown[] = []
    const { fake, calls } = makeFake({
      deps: {
        config: { defaults: { model: 'glm-5.3-zai' } },
        commercial: {
          preheatUserContainer: async (args: unknown) => {
            posted.push(args)
          },
        },
      },
    })
    invoke(fake, { agentId: 'main', modelId: 'glm-5.3-zai' }, 'c:3')
    await settle()
    assert.equal(calls.some((c) => c.kind === 'preheatRunner'), false)
    assert.equal(calls.some((c) => c.kind === 'getOrCreate'), false)
    assert.equal(posted.length, 1)
    assert.deepEqual(posted[0], {
      userId: 'c:3',
      sessionId: 'webtest1234',
      agentId: 'main',
      modelId: 'glm-5.3-zai',
    })
  })

  test('master hook 5xx/抛错 → fail-open warn,不外泄', async () => {
    process.env.OC_ENGINE_PREHEAT = '1'
    clearContainerEnv()
    const { fake, calls } = makeFake({
      deps: {
        config: { defaults: { model: 'glm-5.3-zai' } },
        commercial: {
          preheatUserContainer: async () => {
            throw new Error('container 503')
          },
        },
      },
    })
    invoke(fake, { agentId: 'main', modelId: 'glm-5.3-zai' }, 'c:3')
    await settle()
    assert.equal(calls.some((c) => c.kind === 'preheatRunner'), false)
    assert.ok(calls.some((c) => c.kind.startsWith('warn:')))
  })

  test('同 session 短窗去抖:第二次打开不重复打', async () => {
    process.env.OC_ENGINE_PREHEAT = '1'
    clearContainerEnv()
    let n = 0
    const { fake } = makeFake({
      deps: {
        config: { defaults: { model: 'glm-5.3-zai' } },
        commercial: {
          preheatUserContainer: async () => {
            n += 1
          },
        },
      },
    })
    invoke(fake, { agentId: 'main', modelId: 'glm-5.3-zai' }, 'c:3')
    invoke(fake, { agentId: 'main', modelId: 'glm-5.3-zai' }, 'c:3')
    await settle()
    assert.equal(n, 1)
    assert.ok(SESSION_OPEN_PREHEAT_DEBOUNCE_MS >= 1_000)
  })
})

describe('handleEnginePreheat', () => {
  test('合法 body → 立刻 200,随后打 preheatRunner(engine_preheat 路径)', async () => {
    const { fake, calls } = makeFake()
    const statuses: number[] = []
    const ext = fake as typeof fake & {
      readBody: () => Promise<string>
      sendJson: (_res: unknown, status: number) => void
    }
    ext.readBody = async () =>
      JSON.stringify({ sessionId: 'webtest1234', agentId: 'main', modelId: 'glm-5.3-zai' })
    ext.sendJson = (_res, status) => {
      statuses.push(status)
    }
    await (Gateway.prototype as unknown as {
      handleEnginePreheat: (req: unknown, res: unknown) => Promise<void>
    }).handleEnginePreheat.call(ext, {}, {})
    assert.deepEqual(statuses, [200], '必须在 spawn 前返回 200')
    await settle(40)
    assert.ok(calls.some((c) => c.kind === 'preheatRunner'))
  })

  test('preheatRunner 抛错 → 仍已 200,只 warn', async () => {
    const { fake, calls } = makeFake({
      sessions: {
        getByKey: () => undefined,
        getOrCreate: async (opts: { sessionKey: string }) => ({ sessionKey: opts.sessionKey }),
        preheatRunner: async () => {
          throw new Error('spawn failed')
        },
      },
    })
    const statuses: number[] = []
    const ext = fake as typeof fake & {
      readBody: () => Promise<string>
      sendJson: (_res: unknown, status: number) => void
    }
    ext.readBody = async () => JSON.stringify({ sessionId: 'webtest1234', agentId: 'main' })
    ext.sendJson = (_res, status) => {
      statuses.push(status)
    }
    await (Gateway.prototype as unknown as {
      handleEnginePreheat: (req: unknown, res: unknown) => Promise<void>
    }).handleEnginePreheat.call(ext, {}, {})
    assert.deepEqual(statuses, [200])
    await settle(40)
    assert.ok(calls.some((c) => c.kind.startsWith('warn:')))
    assert.equal(statuses.length, 1, '失败不得再写响应')
  })
})
