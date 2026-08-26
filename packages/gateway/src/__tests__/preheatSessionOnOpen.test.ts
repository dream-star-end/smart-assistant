/**
 * GET /api/sessions/:id 成功后的引擎预热钩子(_preheatSessionOnOpen)契约:
 *   - OC_ENGINE_PREHEAT 未开 → 完全 no-op;
 *   - 会话行的 modelId 必须传进 getOrCreate(避免首条消息 model 不一致 respawn);
 *   - 任一解析/授权步骤抛错 → fail-closed 跳过(warn),绝不让预热错误外泄到请求路径。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/preheatSessionOnOpen.test.ts
 */
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { Gateway } from '../server.js'

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
    ...overrides,
  }
  return { fake, calls }
}

function invoke(
  fake: unknown,
  row: { agentId?: string; modelId?: string },
): void {
  ;(Gateway.prototype as unknown as {
    _preheatSessionOnOpen: (sessId: string, userId: string, row: unknown) => void
  })._preheatSessionOnOpen.call(fake, 'webtest1234', 'default', row)
}

async function settle(): Promise<void> {
  // 钩子是 fire-and-forget 的内层 async;两个 macrotask 足够 settle 全部桩。
  await new Promise((resolve) => setTimeout(resolve, 20))
}

const prevGate = process.env.OC_ENGINE_PREHEAT
const prevAuthority = process.env.OC_MODEL_AUTHORITY
afterEach(() => {
  if (prevGate === undefined) Reflect.deleteProperty(process.env, 'OC_ENGINE_PREHEAT')
  else process.env.OC_ENGINE_PREHEAT = prevGate
  if (prevAuthority === undefined) Reflect.deleteProperty(process.env, 'OC_MODEL_AUTHORITY')
  else process.env.OC_MODEL_AUTHORITY = prevAuthority
})

describe('_preheatSessionOnOpen', () => {
  test('gate 未开 → 完全 no-op', async () => {
    Reflect.deleteProperty(process.env, 'OC_ENGINE_PREHEAT')
    const { fake, calls } = makeFake()
    invoke(fake, { agentId: 'main', modelId: 'glm-5.3-zai' })
    await settle()
    assert.deepEqual(calls, [])
  })

  test('gate 开 → getOrCreate 带会话行 modelId,随后 preheatRunner', async () => {
    process.env.OC_ENGINE_PREHEAT = '1'
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

  test('已有活跃 session → 跳过 getOrCreate 直接 preheatRunner', async () => {
    process.env.OC_ENGINE_PREHEAT = '1'
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
    // 注意 overrides 替换整个 sessions,calls 闭包仍来自 makeFake
    invoke(fake, { agentId: 'main' })
    await settle()
    assert.ok(calls.some((c) => c.kind === 'preheatRunner'))
    assert.equal(calls.some((c) => c.kind === 'getOrCreate'), false)
  })

  test('解析/授权抛错 → fail-closed 跳过并 warn,不外泄', async () => {
    process.env.OC_ENGINE_PREHEAT = '1'
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
})
