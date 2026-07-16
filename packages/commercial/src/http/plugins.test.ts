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
