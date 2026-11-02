/** No real upstream requests. Runtime identity and files are synthetic. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AgentDef, OpenClaudeConfig } from '@openclaude/storage'
import { runningCostFenForUsage } from '../creditExhaustion.js'
import { CcbAdapter } from '../engine/ccbAdapter.js'
import { type CatalogRuntimePort, createGatewayRuntimeServices } from '../gatewayRuntimeServices.js'
import {
  MODEL_CATALOG_EPOCH_PATH,
  MODEL_CATALOG_PATH,
  ModelCatalogClient,
  type ModelCatalogTransport,
  _setModelCatalogClientForTests,
} from '../modelCatalogClient.js'
import { SessionManager } from '../sessionManager.js'
import type { SubprocessRunner } from '../subprocessRunner.js'
import { createTaskboardPreflight } from '../taskboard/stagePreflight.js'

function response(value: unknown) {
  return {
    statusCode: 200,
    body: (async function* () {
      yield Buffer.from(JSON.stringify(value))
    })(),
  }
}
const catalogBody = {
  models: [
    {
      model_id: 'glm-5.2',
      display_name: 'Synthetic model',
      engine: 'ccb',
      provider_id: 'synthetic',
      context_window: 100000,
      supported_efforts: [],
      supports_vision: false,
      capability_zero: false,
      supports_thinking: false,
      default_effort: null,
      input_per_mtok: '100',
      output_per_mtok: '1000',
      cache_read_per_mtok: '10',
      cache_write_per_mtok: '0',
      multiplier: '1.000',
    },
  ],
  projection_revision: 'p1',
  availability_revision: 'a1',
  security_epoch: '1',
  aliases: { 'synthetic-alias': 'glm-5.2' },
  agent_cost_overrides: { main: '2.000' },
}
function client(t: test.TestContext, transport?: ModelCatalogTransport, timeoutMs?: number) {
  const root = mkdtempSync(join(tmpdir(), 'gateway-runtime-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const forbiddenEnv = new Proxy(
    {},
    {
      get(_target, key) {
        throw new Error(`unexpected-env-read:${String(key)}`)
      },
    },
  )
  const requests: string[] = []
  const catalog = new ModelCatalogClient({
    env: forbiddenEnv,
    lkgPath: join(root, 'lkg.json'),
    timeoutMs,
    fetcher: (async () => {
      throw new Error('unexpected-default-fetcher')
    }) as never,
    transport: transport ?? {
      async get(path, options) {
        assert.deepEqual(Object.keys(options), ['signal'])
        assert.ok(options.signal instanceof AbortSignal)
        requests.push(path)
        return response(
          path === MODEL_CATALOG_EPOCH_PATH
            ? { epoch: '1', availability_revision: 'a1' }
            : catalogBody,
        )
      },
    },
    log: () => {},
  })
  return { catalog, root, requests }
}

test('selected catalog transport never resolves container identity, retains cache and canonical model tokens', async (t) => {
  const { catalog, requests } = client(t)
  assert.equal(catalog.configured, true)
  const [one, two] = await Promise.all([catalog.getView(), catalog.getView()])
  assert.equal(one, two)
  assert.equal(one.canonicalize('synthetic-alias'), 'glm-5.2')
  assert.equal(one.resolve('glm-5.2')!.providerId, 'synthetic')
  assert.ok(await catalog.getToken())
  assert.deepEqual(requests, [MODEL_CATALOG_PATH])
  assert.equal(await catalog.lookupAgentCostMultiplier('main'), '2.000')
})

test('transport fetch and body stalls time out independently even when they ignore abort; late fetch cannot replace cache', async (t) => {
  let late: ((value: Awaited<ReturnType<ModelCatalogTransport['get']>>) => void) | undefined
  let calls = 0
  const first = client(
    t,
    {
      get() {
        calls++
        if (calls === 1)
          return new Promise((resolve) => {
            late = resolve
          })
        return Promise.resolve(response(catalogBody))
      },
    },
    10,
  )
  await assert.rejects(first.catalog.getView(), /aborted/i)
  const current = await first.catalog.getView()
  late!(response({ ...catalogBody, security_epoch: '999' }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(first.catalog.peekView()!.view, current)
  let returned = 0
  const stalled = client(
    t,
    {
      async get() {
        return {
          statusCode: 200,
          body: {
            [Symbol.asyncIterator]() {
              return this as AsyncIterableIterator<Uint8Array>
            },
            next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
            return() {
              returned++
              return new Promise<IteratorResult<Uint8Array>>(() => {})
            },
          },
        }
      },
    },
    10,
  )
  await assert.rejects(stalled.catalog.getView(), /aborted/i)
  assert.equal(returned, 1)
})

test('selected catalog transport keeps the bounded response limit and closes an oversized stream', async (t) => {
  let returned = 0
  const { catalog } = client(t, {
    async get() {
      return {
        statusCode: 200,
        body: {
          [Symbol.asyncIterator]() {
            return this as AsyncIterableIterator<Uint8Array>
          },
          async next() {
            return { done: false as const, value: Buffer.alloc(512 * 1024 + 1) }
          },
          async return() {
            returned++
            return { done: true as const, value: undefined }
          },
        },
      }
    },
  })
  await assert.rejects(catalog.getView(), /catalog response too large/)
  assert.equal(returned, 1)
})

test('actual SessionManager to CCB Runner resolves injected catalog before a deliberately stopped spawn', async (t) => {
  const { catalog, root } = client(t)
  const services = createGatewayRuntimeServices({
    catalog,
    turnLease: {
      async renew() {
        throw new Error('unexpected-renew')
      },
    },
  })
  const config = {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
    defaults: { model: 'glm-5.2' },
  } as unknown as OpenClaudeConfig
  const manager = new SessionManager(config, services)
  const session = await manager.getOrCreate({
    sessionKey: 'agent:main:webchat:dm:runtime',
    peerId: 'runtime',
    channel: 'webchat',
    agent: { id: 'main', model: 'glm-5.2', cwd: root } as AgentDef,
  })
  const runner = (session.runner as unknown as { runner: SubprocessRunner }).runner
  assert.ok(runner)
  runner.start = async () => {
    throw new Error('intentional-stop-before-spawn')
  }
  const oldAuthority = process.env.OC_MODEL_AUTHORITY
  process.env.OC_MODEL_AUTHORITY = '1'
  try {
    await assert.rejects(runner.submit('synthetic'), /intentional-stop-before-spawn/)
  } finally {
    if (oldAuthority === undefined) Reflect.deleteProperty(process.env, 'OC_MODEL_AUTHORITY')
    else process.env.OC_MODEL_AUTHORITY = oldAuthority
  }
  assert.ok(catalog.peekView(), 'real Runner must have resolved the injected catalog')
  await session.runner.shutdown()
})

class FakeRunner extends EventEmitter {
  model = 'glm-5.2'
  lastActivityAt = 0
  interrupts = 0
  updated: string[] = []
  submit = async () => {}
  interrupt() {
    this.interrupts++
    return true
  }
  shutdown = async () => {}
  waitForOutputDrain = async () => {}
  setConsultTurn() {}
  pinBoxNativeHarness() {
    return 'ccb' as const
  }
  async updateTurnLease(value: string) {
    this.updated.push(value)
  }
}

test('actual adapter credit guard and rolling renewal both use the injected catalog and lease service', async (t) => {
  const { catalog } = client(t)
  let renewed = 0
  const services = createGatewayRuntimeServices({
    catalog,
    turnLease: {
      async renew() {
        renewed++
        return { lease: 'synthetic-renewed', expiresAt: 999999 }
      },
    },
  })
  const runner = new FakeRunner()
  const adapter = new CcbAdapter(
    {
      runtime: services,
      model: 'glm-5.2',
      config: {},
      agentId: 'main',
      sessionKey: 'runtime',
    } as never,
    runner as unknown as SubprocessRunner,
  )
  const turn = adapter.submitTurn({
    input: 'synthetic',
    onEvent: () => {},
    creditBudgetFen: 50n,
    sessionTotals: { totalCostUSD: 0, turns: 0 },
    toolUseIdToName: new Map(),
  })
  await turn.submitted
  runner.emit('message', {
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { usage: { input_tokens: 1000000, output_tokens: 0 } },
    },
  })
  for (let i = 0; i < 10 && runner.interrupts === 0; i++)
    await new Promise<void>((r) => setImmediate(r))
  assert.equal(runner.interrupts, 1)
  assert.equal(
    await runningCostFenForUsage({
      modelId: 'glm-5.2',
      agentId: 'main',
      usage: { inputTokens: 1000000, outputTokens: 0 },
      composeAgentMultiplier: true,
      catalog,
    }),
    200n,
  )
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const timers = new Map<object, () => void>()
  globalThis.setTimeout = ((fn: () => void) => {
    const h = { unref() {} }
    timers.set(h, fn)
    return h
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((h: object) => {
    timers.delete(h)
  }) as unknown as typeof clearTimeout
  try {
    const authority = { leaseEnvelope: 'synthetic-initial' }
    const internal = adapter as unknown as {
      _activeTurn: unknown
      _startLeaseRenewal(
        ctx: unknown,
        key: string,
        authority: { leaseEnvelope: string },
      ): () => void
    }
    const stop = internal._startLeaseRenewal(internal._activeTurn, 'turn', authority)
    const [h, fire] = [...timers.entries()][0]!
    timers.delete(h)
    fire()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    assert.equal(renewed, 1)
    assert.deepEqual(runner.updated, ['synthetic-renewed'])
    assert.equal(authority.leaseEnvelope, 'synthetic-renewed')
    stop()
  } finally {
    globalThis.setTimeout = originalSet
    globalThis.clearTimeout = originalClear
    turn.end()
    await adapter.shutdown()
  }
})

test('AI stage preflight uses the same injected catalog after model availability checks', async (t) => {
  const { catalog } = client(t)
  _setModelCatalogClientForTests({
    getRoutingView() {
      throw new Error('unexpected-default-catalog')
    },
  } as unknown as ModelCatalogClient)
  t.after(() => _setModelCatalogClientForTests(null))
  const preflight = createTaskboardPreflight({
    catalog,
    env: { OC_MODEL_AUTHORITY: '1' },
    getAgentsConfig: async () => ({ agents: [{ id: 'main', model: 'glm-5.2' }] }) as never,
    getIdentityProjection: async () => undefined,
  })
  assert.deepEqual(await preflight([{ kind: 'ai', agentId: 'main', model: 'synthetic-alias' }]), [
    null,
  ])
})
