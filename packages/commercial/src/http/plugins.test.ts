import { LiteratureError } from '../plugins/literatureDb/errors.js'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'

import { signAccess } from '../auth/jwt.js'
import { PluginAccountError } from '../plugins/accounts.js'
import { KnowledgePlanetSetupError } from '../plugins/knowledgePlanetSetup.js'
import { PluginRuntimeFacadeError } from '../plugins/runtime.js'
import { WeiboSetupError } from '../plugins/weiboSetup.js'
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
    const starts: unknown[] = []
    const custom = deps()
    custom.weiboSetup.start = async (userId: number, accepted: boolean, accountId?: string) => {
      starts.push([userId, accepted, accountId])
      return {
        sessionId: SESSION,
        status: accepted && userId === 42 ? 'waiting_for_scan' : 'failed',
      }
    }
    let res = response()
    await dispatchPluginsRoute(
      await request('POST', '/api/plugins/weibo/setup', {
        acceptTerms: true,
        accountId: '901',
      }),
      res,
      ctx,
      custom,
    )
    assert.equal(res.statusCode, 201)
    assert.deepEqual(res.body, { sessionId: SESSION, status: 'waiting_for_scan' })
    assert.deepEqual(starts, [[42, true, '901']])

    await assert.rejects(
      dispatchPluginsRoute(
        await request('POST', '/api/plugins/knowledge-planet/setup', {
          acceptTerms: true,
          accountId: '901',
        }),
        response(),
        ctx,
        custom,
      ),
      (error: unknown) => error instanceof HttpError && error.status === 400,
    )
    await assert.rejects(
      dispatchPluginsRoute(
        await request('POST', '/api/plugins/weibo/setup', {
          acceptTerms: true,
          accountId: 'not-an-id',
        }),
        response(),
        ctx,
        custom,
      ),
      (error: unknown) => error instanceof HttpError && error.status === 400,
    )

    res = response()
    await dispatchPluginsRoute(
      await request('GET', `/api/plugins/weibo/setup/${SESSION}/qr`),
      res,
      ctx,
      custom,
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
      custom,
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

  test('Weibo setup UNAVAILABLE stays a generic 503 and keeps pin details off the public message', async () => {
    await assert.rejects(
      dispatchPluginsRoute(
        await request('POST', '/api/plugins/weibo/setup', { acceptTerms: true }),
        response(),
        ctx,
        deps({
          weiboSetup: {
            start: async () => {
              throw new WeiboSetupError('UNAVAILABLE', 'official Plugin trust pin mismatch')
            },
          },
        }),
      ),
      (error: unknown) => {
        if (!(error instanceof HttpError)) return false
        assert.equal(error.status, 503)
        assert.equal(error.code, 'PLUGIN_RUNTIME_UNAVAILABLE')
        assert.equal(error.message, 'Plugin runtime unavailable')
        assert.equal(error.logMessage, 'official Plugin trust pin mismatch')
        assert.equal(error.retrySafe, 'yes')
        assert.match(String(error.nextAction), /管理员/)
        assert.doesNotMatch(error.message, /pin|hash|mismatch/i)
        return true
      },
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
  test('literature PDF artifact download enforces user ownership, no-store headers, and status codes', async () => {
    const validId = 'litpdf-1234567890abcdef1234567890abcdef'
    const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n')
    const store = {
      read: (uid: number, id: string) => {
        if (uid === 42 && id === validId) {
          return {
            artifactId: validId,
            filename: '深度学习研究_2026.pdf',
            mimeType: 'application/pdf' as const,
            bytes: pdfBytes.length,
            data: pdfBytes,
          }
        }
        return null
      },
    }
    const res = response()
    await dispatchPluginsRoute(
      await request('GET', `/api/plugins/literature-db/artifacts/${validId}`),
      res,
      {} as any,
      deps({ literatureArtifacts: store }),
    )
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers.get('content-type'), 'application/pdf')
    assert.equal(res.headers.get('cache-control'), 'no-store, private')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename=/)
    assert.deepEqual(res.bytes, pdfBytes)

    await assert.rejects(
      dispatchPluginsRoute(
        await request('POST', `/api/plugins/literature-db/artifacts/${validId}`),
        response(),
        {} as any,
        deps({ literatureArtifacts: store }),
      ),
      (e: unknown) => e instanceof HttpError && e.status === 405,
    )
    await assert.rejects(
      dispatchPluginsRoute(
        await request('GET', '/api/plugins/literature-db/artifacts/bad_id!'),
        response(),
        {} as any,
        deps({ literatureArtifacts: store }),
      ),
      (e: unknown) => e instanceof HttpError && e.status === 400,
    )
    await assert.rejects(
      dispatchPluginsRoute(
        await request('GET', `/api/plugins/literature-db/artifacts/${validId}`),
        response(),
        {} as any,
        deps(),
      ),
      (e: unknown) => e instanceof HttpError && e.status === 503,
    )
    await assert.rejects(
      dispatchPluginsRoute(
        await request('GET', '/api/plugins/literature-db/artifacts/litpdf-ffffffffffffffffffffffffffffffff'),
        response(),
        {} as any,
        deps({ literatureArtifacts: store }),
      ),
      (e: unknown) => e instanceof HttpError && e.status === 404,
    )
    await assert.rejects(
      dispatchPluginsRoute(
        await request('GET', `/api/plugins/literature-db/artifacts/${validId}`),
        response(),
        {} as any,
        deps({
          literatureArtifacts: {
            read: () => {
              throw new LiteratureError('CAPACITY')
            },
          },
        }),
      ),
      (e: unknown) => e instanceof HttpError && e.status === 429,
    )
  })

  test('literature PDF artifact meta tells the owner when the saved file expires (OCV5-585)', async () => {
    const validId = 'litpdf-1234567890abcdef1234567890abcdef'
    const expiresAt = Date.parse('2026-10-23T01:30:00Z')
    const reads: string[] = []
    const store = {
      read: (_uid: number, id: string) => {
        reads.push(id)
        return null
      },
      describe: (uid: number, id: string) =>
        uid === 42 && id === validId
          ? { filename: '深度学习研究_2026.pdf', bytes: 2048, expiresAt, saved: false }
          : null,
    }
    const res = response()
    await dispatchPluginsRoute(
      await request('GET', `/api/plugins/literature-db/artifacts/${validId}/meta`),
      res,
      {} as any,
      deps({ literatureArtifacts: store }),
    )
    assert.equal(res.statusCode, 200)
    assert.match(res.headers.get('cache-control') ?? '', /no-store/)
    assert.deepEqual(JSON.parse(res.bytes.toString('utf8')), {
      expiresAt: '2026-10-23T01:30:00.000Z',
      bytes: 2048,
      saved: false,
    })
    assert.deepEqual(reads, [], 'meta never reads (and never marks the file saved)')
    await assert.rejects(
      dispatchPluginsRoute(
        await request(
          'GET',
          '/api/plugins/literature-db/artifacts/litpdf-ffffffffffffffffffffffffffffffff/meta',
        ),
        response(),
        {} as any,
        deps({ literatureArtifacts: store }),
      ),
      (e: unknown) =>
        e instanceof HttpError && e.status === 404 && e.code === 'LITERATURE_ARTIFACT_EXPIRED',
    )
  })
})

describe('private literature setup routes', () => {
  test('Bearer authentication and availability are checked before reading credentials', async () => {
    const req = await request('POST', '/api/plugins/literature-db/setup', {
      username: 'synthetic',
      password: 'synthetic-private',
    })
    Reflect.deleteProperty(req.headers, 'authorization')
    await assert.rejects(
      dispatchPluginsRoute(req, response(), {} as any, deps()),
      (e: unknown) => e instanceof HttpError && e.status === 401,
    )
    assert.equal(req.readableDidRead, false)
    const unavailable = await request('POST', '/api/plugins/literature-db/setup', {
      password: 'synthetic-private',
    })
    await assert.rejects(
      dispatchPluginsRoute(unavailable, response(), {} as any, deps()),
      (e: unknown) => e instanceof HttpError && e.status === 503,
    )
    assert.equal(unavailable.readableDidRead, false)
  })
  test('fixed JSON schema rejects unsupported type, oversized body and authority fields', async () => {
    let starts = 0
    const dependency = deps({
      literatureSetup: {
        assertAvailable: async () => {},
        start: async () => {
          starts++
        },
      },
    })
    for (const [input, contentType, status] of [
      [{ username: 'fixture', password: 'fixture', acceptTerms: true }, 'text/plain', 415],
      [
        { username: 'fixture', password: 'x'.repeat(9000), acceptTerms: true },
        'application/json',
        413,
      ],
      [
        { username: 'fixture', password: 'fixture', acceptTerms: true, userId: 99 },
        'application/json',
        400,
      ],
      [
        {
          username: 'fixture',
          password: 'fixture',
          acceptTerms: true,
          sessionExpiresAt: Date.now() + 1,
        },
        'application/json',
        400,
      ],
    ] as const) {
      const req = await request('POST', '/api/plugins/literature-db/setup', input)
      req.headers['content-type'] = contentType
      await assert.rejects(
        dispatchPluginsRoute(req, response(), {} as any, dependency),
        (e: unknown) => e instanceof HttpError && e.status === status,
      )
    }
    assert.equal(starts, 0)
  })
  test('private form uses server identity, and image responses stay authenticated and uncached', async () => {
    const req = await request('POST', '/api/plugins/literature-db/setup', {
      username: 'fixture',
      password: 'fixture',
      acceptTerms: true,
      accountId: '7',
    })
    req.headers['content-type'] = 'application/json; charset=utf-8'
    let captured: unknown
    const res = response()
    const dependency = deps({
      literatureSetup: {
        assertAvailable: async () => {},
        start: async (userId: number, input: unknown) => {
          captured = { userId, input }
          return { operationId: SESSION, status: 'running', agentReady: false }
        },
        image: async (userId: number, operationId: string, challengeId: string) => {
          assert.deepEqual([userId, operationId, challengeId], [42, SESSION, SESSION])
          return { mediaType: 'image/png', data: Buffer.from('synthetic-png') }
        },
      },
    })
    await dispatchPluginsRoute(req, res, {} as any, dependency)
    assert.deepEqual(captured, {
      userId: 42,
      input: { username: 'fixture', password: 'fixture', acceptTerms: true, accountId: '7' },
    })
    assert.equal(res.statusCode, 202)
    const png = response()
    await dispatchPluginsRoute(
      await request(
        'GET',
        `/api/plugins/literature-db/setup/${SESSION}/challenges/${SESSION}/image`,
      ),
      png,
      {} as any,
      dependency,
    )
    assert.equal(png.headers.get('cache-control'), 'no-store, private')
    assert.equal(png.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(png.headers.get('content-length'), String(png.bytes.length))
  })
  test('unexpected upstream errors are replaced before HTTP logging or response construction', async () => {
    const privateValue = 'synthetic-private-upstream-content'
    const req = await request('GET', '/api/plugins/literature-db/setup')
    await assert.rejects(
      dispatchPluginsRoute(
        req,
        response(),
        {} as any,
        deps({
          literatureSetup: {
            capability: async () => {
              throw new Error(privateValue)
            },
          },
        }),
      ),
      (e: unknown) => {
        assert(e instanceof HttpError)
        assert.equal(e.status, 500)
        assert(!e.message.includes(privateValue))
        assert(!JSON.stringify(e).includes(privateValue))
        return true
      },
    )
  })
})
