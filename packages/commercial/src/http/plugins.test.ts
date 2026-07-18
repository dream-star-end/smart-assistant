import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'

import { signAccess } from '../auth/jwt.js'
import { PluginAccountError } from '../plugins/accounts.js'
import { KnowledgePlanetSetupError } from '../plugins/knowledgePlanetSetup.js'
import { PluginRuntimeFacadeError } from '../plugins/runtime.js'
import { dispatchPluginsRoute } from './plugins.js'
import { HttpError } from './util.js'

const SECRET = 'plugin-http-test-secret-that-is-at-least-32-bytes'
const SESSION = '123e4567-e89b-42d3-a456-426614174000'

async function request(method: string, path: string, body?: unknown): Promise<IncomingMessage> {
  const token = await signAccess({ sub: '42', role: 'user' }, SECRET)
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const req = Readable.from(bytes.length ? [bytes] : []) as unknown as IncomingMessage & {
    method: string
    url: string
    headers: Record<string, string>
  }
  req.method = method
  req.url = path
  req.headers = { authorization: `Bearer ${token.token}`, host: 'test.local' }
  return req
}

function response(): ServerResponse & {
  body: unknown
  bytes: Buffer
  headers: Map<string, string>
} {
  const headers = new Map<string, string>()
  const res: any = {
    statusCode: 0,
    headers,
    body: null,
    bytes: Buffer.alloc(0),
    setHeader(name: string, value: string | number) {
      headers.set(name.toLowerCase(), String(value))
      return res
    },
    end(value?: string | Buffer) {
      res.bytes = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '')
      if (headers.get('content-type')?.startsWith('application/json'))
        res.body = JSON.parse(res.bytes.toString('utf8'))
      return res
    },
  }
  return res as ServerResponse & {
    body: unknown
    bytes: Buffer
    headers: Map<string, string>
  }
}

function deps(overrides: Record<string, unknown> = {}): any {
  return {
    jwtSecret: SECRET,
    pluginRuntime: {
      management: async (userId: number) => ({
        catalog: [{ versionId: '91', slug: `p-${userId}` }],
        accounts: [{ id: '7', provider: 'p-42' }],
      }),
      revokeManagedAccount: async (userId: number, id: string) => ({ id: `${userId}:${id}` }),
      setManagedAccountWriteAccess: async (input: Record<string, unknown>) => ({
        available: true,
        enabled: input.enabled === true,
        disclaimerVersion: 1,
        acceptedVersion: input.enabled === true ? 1 : null,
        acceptedAt: input.enabled === true ? '2026-07-17T00:00:00.000Z' : null,
        disclaimerText: 'test disclaimer',
      }),
      setManagedAccountWritePreapproval: async (input: Record<string, unknown>) => ({
        available: true,
        enabled: true,
        disclaimerVersion: 1,
        acceptedVersion: 1,
        acceptedAt: '2026-07-17T00:00:00.000Z',
        disclaimerText: 'test disclaimer',
        preapproval: {
          available: true,
          enabled: input.enabled === true,
          disclaimerVersion: 1,
          acceptedVersion: input.enabled === true ? 1 : null,
          acceptedAt: input.enabled === true ? '2026-07-17T00:00:00.000Z' : null,
          disclaimerText: 'preapproval disclaimer',
        },
      }),
    },
    knowledgePlanetSetup: {
      start: async (userId: number, accepted: boolean) => ({
        sessionId: SESSION,
        status: accepted && userId === 42 ? 'waiting_for_scan' : 'failed',
      }),
      status: async () => ({ sessionId: SESSION, status: 'finalizing' }),
      qr: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
      cancel: async () => ({ sessionId: SESSION, status: 'cancelled' }),
    },
    weiboSetup: {
      start: async (userId: number, accepted: boolean) => ({
        sessionId: SESSION,
        status: accepted && userId === 42 ? 'waiting_for_scan' : 'failed',
      }),
      status: async () => ({ sessionId: SESSION, status: 'finalizing' }),
      qr: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2]),
      cancel: async () => ({ sessionId: SESSION, status: 'cancelled' }),
    },
    knowledgePlanetAutomation: {
      get: async () => ({
        control: {
          available: true,
          enabled: false,
          disclaimerVersion: 1,
          acceptedVersion: null,
          acceptedAt: null,
          disclaimerText: 'automation notice',
          accountDailyLimit: 10,
          pausedReason: null,
        },
        rules: [],
        recentRuns: [],
      }),
      setControl: async (input: Record<string, unknown>) => ({
        available: true,
        enabled: input.enabled === true,
        disclaimerVersion: 1,
        acceptedVersion: input.enabled === true ? 1 : null,
        acceptedAt: input.enabled === true ? '2026-07-17T00:00:00.000Z' : null,
        disclaimerText: 'automation notice',
        accountDailyLimit: Number(input.accountDailyLimit ?? 10),
        pausedReason: null,
      }),
      createRule: async (input: Record<string, unknown>) => ({ id: 'rule-created', ...input }),
      listGroups: async () => [{ id: '123456789', name: 'Test group', memberCount: 12 }],
      createRulesBatch: async (input: Record<string, unknown>) => [
        { id: 'rule-created-batch', ...input },
      ],
      patchRule: async (input: Record<string, unknown>) => ({
        id: input.ruleId,
        ...(input.patch as Record<string, unknown>),
      }),
      deleteRule: async () => undefined,
    },
    ...overrides,
  }
}

const ctx = {} as never

describe('Plugin management HTTP dispatcher', () => {
  test('catalog/accounts are user scoped; revoke uses the same authenticated owner', async () => {
    let res = response()
    await dispatchPluginsRoute(await request('GET', '/api/plugins/management'), res, ctx, deps())
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body, {
      catalog: [{ versionId: '91', slug: 'p-42' }],
      accounts: [{ id: '7', provider: 'p-42' }],
    })

    res = response()
    await dispatchPluginsRoute(
      await request('DELETE', '/api/plugins/accounts/901'),
      res,
      ctx,
      deps(),
    )
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body, { id: '42:901', status: 'revoked' })
  })

  test('Knowledge Planet setup requires the exact consent body and QR is private no-store PNG', async () => {
    let res = response()
    await dispatchPluginsRoute(
      await request('POST', '/api/plugins/knowledge-planet/setup', { acceptTerms: true }),
      res,
      ctx,
      deps(),
    )
    assert.equal(res.statusCode, 201)
    assert.deepEqual(res.body, { sessionId: SESSION, status: 'waiting_for_scan' })

    res = response()
    await dispatchPluginsRoute(
      await request('GET', `/api/plugins/knowledge-planet/setup/${SESSION}/qr`),
      res,
      ctx,
      deps(),
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
    assert.equal(res.headers.get('cache-control'), 'no-store, private')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual([...res.bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])

    await assert.rejects(
      dispatchPluginsRoute(
        await request('POST', '/api/plugins/knowledge-planet/setup', {
          acceptTerms: true,
          unexpected: true,
        }),
        response(),
        ctx,
        deps(),
      ),
      (error: unknown) => error instanceof HttpError && error.status === 400,
    )
  })

  test('Weibo setup uses the provider-bound manager and a private no-store QR endpoint', async () => {
    let res = response()
    await dispatchPluginsRoute(
      await request('POST', '/api/plugins/weibo/setup', { acceptTerms: true }),
      res,
      ctx,
      deps(),
    )
    assert.equal(res.statusCode, 201)
    assert.deepEqual(res.body, { sessionId: SESSION, status: 'waiting_for_scan' })

    res = response()
    await dispatchPluginsRoute(
      await request('GET', `/api/plugins/weibo/setup/${SESSION}/qr`),
      res,
      ctx,
      deps(),
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
    assert.equal(res.headers.get('cache-control'), 'no-store, private')
    assert.deepEqual([...res.bytes], [137, 80, 78, 71, 13, 10, 26, 10, 2])

    res = response()
    await dispatchPluginsRoute(
      await request('DELETE', `/api/plugins/weibo/setup/${SESSION}`),
      res,
      ctx,
      deps(),
    )
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body, { sessionId: SESSION, status: 'cancelled' })
  })

  test('write access requires the exact current consent body and authenticated owner', async () => {
    const calls: unknown[] = []
    const custom = deps({
      pluginRuntime: {
        setManagedAccountWriteAccess: async (input: unknown) => {
          calls.push(input)
          return {
            available: true,
            enabled: true,
            disclaimerVersion: 3,
            acceptedVersion: 3,
            acceptedAt: '2026-07-17T00:00:00.000Z',
            disclaimerText: 'notice',
          }
        },
      },
    })
    const res = response()
    await dispatchPluginsRoute(
      await request('PATCH', '/api/plugins/accounts/901/write-access', {
        enabled: true,
        accepted: true,
        disclaimerVersion: 3,
      }),
      res,
      ctx,
      custom,
    )
    assert.equal(res.statusCode, 200)
    assert.deepEqual(calls, [
      {
        userId: 42,
        targetId: '901',
        enabled: true,
        accepted: true,
        disclaimerVersion: 3,
      },
    ])

    for (const invalid of [
      { enabled: true, accepted: false, disclaimerVersion: 3 },
      { enabled: true, accepted: true },
      { enabled: false, accepted: true },
      { enabled: false, extra: true },
    ]) {
      await assert.rejects(
        dispatchPluginsRoute(
          await request('PATCH', '/api/plugins/accounts/901/write-access', invalid),
          response(),
          ctx,
          custom,
        ),
        (error: unknown) => error instanceof HttpError && error.status === 400,
      )
    }

    const disabled = response()
    await dispatchPluginsRoute(
      await request('PATCH', '/api/plugins/accounts/901/write-access', { enabled: false }),
      disabled,
      ctx,
      custom,
    )
    assert.deepEqual(calls.at(-1), { userId: 42, targetId: '901', enabled: false })
  })

  test('account write preapproval has its own exact consent endpoint', async () => {
    const calls: unknown[] = []
    const custom = deps({
      pluginRuntime: {
        setManagedAccountWritePreapproval: async (input: unknown) => {
          calls.push(input)
          return { preapproval: { enabled: true } }
        },
      },
    })
    const res = response()
    await dispatchPluginsRoute(
      await request('PATCH', '/api/plugins/accounts/901/write-preapproval', {
        enabled: true,
        accepted: true,
        disclaimerVersion: 1,
      }),
      res,
      ctx,
      custom,
    )
    assert.equal(res.statusCode, 200)
    assert.deepEqual(calls.at(-1), {
      userId: 42,
      targetId: '901',
      enabled: true,
      accepted: true,
      disclaimerVersion: 1,
    })

    await dispatchPluginsRoute(
      await request('PATCH', '/api/plugins/accounts/901/write-preapproval', { enabled: false }),
      response(),
      ctx,
      custom,
    )
    assert.deepEqual(calls.at(-1), { userId: 42, targetId: '901', enabled: false })
    for (const invalid of [
      { enabled: true, accepted: false, disclaimerVersion: 1 },
      { enabled: true, accepted: true },
      { enabled: false, disclaimerVersion: 1 },
    ])
      await assert.rejects(
        dispatchPluginsRoute(
          await request('PATCH', '/api/plugins/accounts/901/write-preapproval', invalid),
          response(),
          ctx,
          custom,
        ),
        (error: unknown) => error instanceof HttpError && error.status === 400,
      )
  })

  test('runtime ownership failures map to stable HTTP errors; unknown methods stay dispatcher-owned', async () => {
    await assert.rejects(
      dispatchPluginsRoute(
        await request('DELETE', '/api/plugins/accounts/901'),
        response(),
        ctx,
        deps({
          pluginRuntime: {
            revokeManagedAccount: async () => {
              throw new PluginRuntimeFacadeError('TARGET_NOT_FOUND')
            },
          },
        }),
      ),
      (error: unknown) =>
        error instanceof HttpError && error.status === 404 && error.code === 'TARGET_NOT_FOUND',
    )
    await assert.rejects(
      dispatchPluginsRoute(
        await request('DELETE', '/api/plugins/accounts/901'),
        response(),
        ctx,
        deps({
          pluginRuntime: {
            revokeManagedAccount: async () => {
              throw new PluginAccountError('ACCOUNT_STALE')
            },
          },
        }),
      ),
      (error: unknown) =>
        error instanceof HttpError && error.status === 409 && error.code === 'TARGET_STALE',
    )
    await assert.rejects(
      dispatchPluginsRoute(await request('PATCH', '/api/plugins'), response(), ctx, deps()),
      (error: unknown) => error instanceof HttpError && error.status === 404,
    )
  })

  test('unattended automation uses separate consent and exact account/rule bindings', async () => {
    const calls: Array<{ kind: string; input: unknown }> = []
    const custom = deps({
      knowledgePlanetAutomation: {
        get: async (userId: number, targetId: string) => {
          calls.push({ kind: 'get', input: { userId, targetId } })
          return { control: { enabled: false }, rules: [], recentRuns: [] }
        },
        setControl: async (input: unknown) => {
          calls.push({ kind: 'control', input })
          return { enabled: true }
        },
        createRule: async (input: unknown) => {
          calls.push({ kind: 'create', input })
          return { id: '123e4567-e89b-42d3-a456-426614174001' }
        },
        listGroups: async (userId: number, targetId: string) => {
          calls.push({ kind: 'groups', input: { userId, targetId } })
          return [{ id: '123456789', name: '产品群', memberCount: 42 }]
        },
        createRulesBatch: async (input: unknown) => {
          calls.push({ kind: 'batch', input })
          return [{ id: '123e4567-e89b-42d3-a456-426614174002' }]
        },
        patchRule: async (input: unknown) => {
          calls.push({ kind: 'patch', input })
          return { id: '123e4567-e89b-42d3-a456-426614174001', enabled: true }
        },
        deleteRule: async (userId: number, targetId: string, ruleId: string) => {
          calls.push({ kind: 'delete', input: { userId, targetId, ruleId } })
        },
      },
    })
    let res = response()
    await dispatchPluginsRoute(
      await request('GET', '/api/plugins/accounts/901/automation'),
      res,
      ctx,
      custom,
    )
    assert.deepEqual(calls.at(-1), {
      kind: 'get',
      input: { userId: 42, targetId: '901' },
    })

    res = response()
    await dispatchPluginsRoute(
      await request('PATCH', '/api/plugins/accounts/901/automation', {
        enabled: true,
        accepted: true,
        disclaimerVersion: 1,
        accountDailyLimit: 12,
      }),
      res,
      ctx,
      custom,
    )
    assert.deepEqual(calls.at(-1), {
      kind: 'control',
      input: {
        userId: 42,
        targetId: '901',
        enabled: true,
        accepted: true,
        disclaimerVersion: 1,
        accountDailyLimit: 12,
      },
    })

    res = response()
    await dispatchPluginsRoute(
      await request('GET', '/api/plugins/accounts/901/automation/groups'),
      res,
      ctx,
      custom,
    )
    assert.deepEqual(res.body, {
      groups: [{ id: '123456789', name: '产品群', memberCount: 42 }],
    })
    assert.deepEqual(calls.at(-1), {
      kind: 'groups',
      input: { userId: 42, targetId: '901' },
    })

    res = response()
    await dispatchPluginsRoute(
      await request('POST', '/api/plugins/accounts/901/automation/rules/batch', {
        groupIds: ['123456789', '223456789'],
        name: '新主题',
        instructions: '只回答产品问题',
        triggerKind: 'new_question',
      }),
      res,
      ctx,
      custom,
    )
    assert.equal(res.statusCode, 201)
    assert.deepEqual(calls.at(-1), {
      kind: 'batch',
      input: {
        userId: 42,
        targetId: '901',
        groupIds: ['123456789', '223456789'],
        name: '新主题',
        instructions: '只回答产品问题',
        triggerKind: 'new_question',
      },
    })

    res = response()
    await dispatchPluginsRoute(
      await request('POST', '/api/plugins/accounts/901/automation/rules', {
        groupId: '123456789',
        name: '新主题',
        instructions: '只回答产品问题',
      }),
      res,
      ctx,
      custom,
    )
    assert.equal(res.statusCode, 201)
    assert.deepEqual(calls.at(-1), {
      kind: 'create',
      input: {
        userId: 42,
        targetId: '901',
        groupId: '123456789',
        name: '新主题',
        instructions: '只回答产品问题',
      },
    })

    const ruleId = '123e4567-e89b-42d3-a456-426614174001'
    await dispatchPluginsRoute(
      await request('PATCH', `/api/plugins/accounts/901/automation/rules/${ruleId}`, {
        enabled: true,
      }),
      response(),
      ctx,
      custom,
    )
    assert.deepEqual(calls.at(-1), {
      kind: 'patch',
      input: {
        userId: 42,
        targetId: '901',
        ruleId,
        patch: { enabled: true },
      },
    })
    await dispatchPluginsRoute(
      await request('DELETE', `/api/plugins/accounts/901/automation/rules/${ruleId}`),
      response(),
      ctx,
      custom,
    )
    assert.equal(calls.at(-1)?.kind, 'delete')

    for (const invalid of [
      { enabled: true, accepted: true },
      { enabled: false, accepted: true },
      { enabled: 'true', accepted: true, disclaimerVersion: 1 },
    ])
      await assert.rejects(
        dispatchPluginsRoute(
          await request('PATCH', '/api/plugins/accounts/901/automation', invalid),
          response(),
          ctx,
          custom,
        ),
        (error: unknown) => error instanceof HttpError && error.status === 400,
      )
  })

  test('setup worker saturation is a stable retryable 429', async () => {
    await assert.rejects(
      dispatchPluginsRoute(
        await request('POST', '/api/plugins/knowledge-planet/setup', { acceptTerms: true }),
        response(),
        ctx,
        deps({
          knowledgePlanetSetup: {
            start: async () => {
              throw new KnowledgePlanetSetupError('CAPACITY_EXCEEDED')
            },
          },
        }),
      ),
      (error: unknown) =>
        error instanceof HttpError && error.status === 429 && error.code === 'CAPACITY_EXCEEDED',
    )
  })
})
