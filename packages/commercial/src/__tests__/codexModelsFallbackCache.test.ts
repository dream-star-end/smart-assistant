import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, test } from 'node:test'
import { hashSecret, type ContainerIdentityRepo } from '../auth/containerIdentity.js'
import {
  CODEX_MODELS_CACHE_TTL_MS,
  CodexModelsFallbackCache,
  buildCodexModelsCacheKey,
  createModelsCacheTap,
} from '../http/codexModelsFallbackCache.js'
import {
  CODEX_RELAY_PREFIX,
  CODEX_UPSTREAM_AUTH_HEADER,
  makeCodexRelayHandler,
  type CodexRelayDb,
} from '../http/internalCodexRelay.js'

const SECRET = 'c'.repeat(64)
const TOKEN = `oc-v3.12.${SECRET}`
const CTX = { hostUuid: 'host-models', boundIp: '172.30.0.12' }
const DISPATCHER = { name: 'proxy-dispatcher' } as never

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
}

function makeRepo(): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid, boundIp) {
      if (hostUuid !== CTX.hostUuid || boundIp !== CTX.boundIp) return null
      return {
        id: 12,
        user_id: 42,
        bound_ip: CTX.boundIp,
        host_uuid: CTX.hostUuid,
        secret_hash: hashSecret(SECRET),
      }
    },
  }
}

describe('codexModelsFallbackCache unit', () => {
  test('binds identity, workspace, and version strictly without raw secret leakage or default-collision', () => {
    const hmacKey = randomBytes(32)
    assert.equal(
      buildCodexModelsCacheKey({ hmacKey, authHeader: '', accountId: 27n, search: '?client_version=0.170.0' }),
      null,
    )
    assert.equal(
      buildCodexModelsCacheKey({ hmacKey, authHeader: 'Bearer jwtA', accountId: null, search: '?client_version=0.170.0' }),
      null,
    )
    assert.equal(
      buildCodexModelsCacheKey({
        hmacKey,
        authHeader: 'Bearer jwtA',
        accountId: 27n,
        search: '?client_version=bad/../../x',
      }),
      null,
    )
    assert.equal(
      buildCodexModelsCacheKey({
        hmacKey,
        authHeader: 'Bearer jwtA',
        accountId: 27n,
        search: '?client_version=0.170.0&client_version=0.171.0',
      }),
      null,
    )
    const missing = buildCodexModelsCacheKey({ hmacKey, authHeader: 'Bearer jwtA', accountId: 27n, search: '' })
    const literalDefault = buildCodexModelsCacheKey({
      hmacKey,
      authHeader: 'Bearer jwtA',
      accountId: 27n,
      search: '?client_version=default',
    })
    assert.ok(missing && literalDefault && missing !== literalDefault)
    assert.doesNotMatch(missing, /jwtA/)

    const wsA = buildCodexModelsCacheKey({
      hmacKey,
      authHeader: 'Bearer jwtA',
      workspaceId: 'ws-1',
      accountId: 27n,
      search: '?client_version=0.170.0',
    })
    const wsB = buildCodexModelsCacheKey({
      hmacKey,
      authHeader: 'Bearer jwtA',
      workspaceId: 'ws-2',
      accountId: 27n,
      search: '?client_version=0.170.0',
    })
    const jwtB = buildCodexModelsCacheKey({
      hmacKey,
      authHeader: 'Bearer jwtB',
      workspaceId: 'ws-1',
      accountId: 27n,
      search: '?client_version=0.170.0',
    })
    assert.ok(wsA && wsB && jwtB)
    assert.notEqual(wsA, wsB)
    assert.notEqual(wsA, jwtB)
  })

  test('rejects structurally invalid, empty, oversize, or malformed JSON without poisoning existing valid cache, enforces LRU + TTL', () => {
    const cache = new CodexModelsFallbackCache({ maxEntries: 2, maxBodyBytes: 256, ttlMs: 1_000 })
    const valid = Buffer.from(JSON.stringify({ models: [{ slug: 'gpt-6.2-sol', service_tiers: [{ id: 'ultrafast' }] }] }))
    assert.equal(cache.putIfValid('k1', valid, 100), true)

    assert.equal(cache.putIfValid('k1', Buffer.from('{"models":'), 200), false)
    assert.equal(cache.putIfValid('k1', Buffer.from(JSON.stringify({ models: [] })), 200), false)
    assert.equal(cache.putIfValid('k1', Buffer.from(JSON.stringify({ models: [{}] })), 200), false)
    assert.equal(cache.putIfValid('k1', Buffer.from(JSON.stringify({ models: [{ slug: '   ' }] })), 200), false)
    assert.equal(cache.putIfValid('k1', Buffer.from(JSON.stringify({ models: [null] })), 200), false)
    assert.equal(cache.putIfValid('k1', Buffer.alloc(300, 97), 200), false)
    assert.deepEqual(cache.get('k1', 300), valid)

    assert.equal(cache.putIfValid('k2', valid, 400), true)
    assert.ok(cache.get('k1', 500))
    assert.equal(cache.putIfValid('k3', valid, 600), true)
    assert.equal(cache.size, 2)
    assert.equal(cache.get('k2', 700), null)
    assert.ok(cache.get('k1', 700))

    assert.equal(cache.get('k1', 100 + 1_001), null)
    assert.ok(CODEX_MODELS_CACHE_TTL_MS > 1_000)
  })

  test('createModelsCacheTap passes bytes through even over maxBytes without invoking cache write', async () => {
    const events: Buffer[] = []
    const tap = createModelsCacheTap(8, (b) => events.push(b))
    const chunks: Buffer[] = []
    tap.on('data', (c) => chunks.push(Buffer.from(c)))
    tap.write(Buffer.from('12345'))
    tap.end(Buffer.from('67890'))
    await new Promise<void>((r) => tap.once('finish', () => r()))
    assert.equal(Buffer.concat(chunks).toString('utf8'), '1234567890')
    assert.equal(events.length, 0)
  })
})

describe('internalCodexRelay /models retry + isolated fallback cache (P1-1)', () => {
  test('isolates by upstream identity/workspace/rebind window, excludes /v1/models, and never masks 401/403', async () => {
    let accountId = 27n
    const modelsOfficial = JSON.stringify({
      models: [{ slug: 'gpt-6.2-sol', service_tiers: [{ id: 'priority' }, { id: 'ultrafast' }] }],
    })
    const queue: Array<() => Response | Promise<Response>> = [
      // 1. Official /backend-api/codex/models cold 200 (acct 27, tok-27, ws-1) populates cache
      () => new Response(modelsOfficial, { status: 200, headers: { 'content-type': 'application/json' } }),
      // 2. Same identity + workspace transient 502 then 200 on retry
      () => new Response('bad gateway', { status: 502 }),
      () => new Response(modelsOfficial, { status: 200, headers: { 'content-type': 'application/json' } }),
      // 3. Same identity + workspace double 502 -> hits fallback cache (200)
      () => new Response('bad gateway 1', { status: 502 }),
      () => new Response('bad gateway 2', { status: 502 }),
      // 4. Compatible /v1/models 502 -> must NOT retry OR read official cache! (single 502 fetch)
      () => new Response('compat v1 502', { status: 502 }),
      // 5. Rebind race: DB switched to account 28, container STILL sends stale tok-27 and succeeds 200,
      //    then container switches to tok-28 and hits 502+502 -> MUST NOT read tok-27's catalog!
      () => new Response(modelsOfficial, { status: 200, headers: { 'content-type': 'application/json' } }),
      () => new Response('tok28 502-1', { status: 502 }),
      () => new Response('tok28 502-2', { status: 502 }),
      // 6. Different workspace (ws-2) under tok-27 + acct 27 -> miss on 502+502
      () => new Response('ws2 502-1', { status: 502 }),
      () => new Response('ws2 502-2', { status: 502 }),
      // 7. 401 fails closed without retry or cache hit
      () => new Response('unauthorized', { status: 401 }),
    ]

    const db: CodexRelayDb = {
      async readContainerBinding() {
        return {
          codexAccountId: accountId,
          userId: 42n,
          state: 'active',
          provider: 'codex',
          accountStatus: 'active',
        }
      },
    }

    const handler = makeCodexRelayHandler({
      identityRepo: makeRepo(),
      db,
      upstreamBaseUrl: 'https://yunwu.ai/v1',
      resolveDispatcher: async (id) => ({ accountId: id, proxyId: 1n, dispatcher: DISPATCHER }),
      fetchImpl: (async () => {
        const next = queue.shift()
        assert.ok(next, 'unexpected upstream fetch')
        return await next()
      }) as typeof fetch,
    })

    const server = createServer((req, res) => void handler(req, res, CTX))
    const port = await listen(server)
    const callOfficial = (tok: string, ws = 'ws-1', cv = '0.170.0') =>
      fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/backend-api/codex/models?client_version=${cv}`, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          [CODEX_UPSTREAM_AUTH_HEADER]: `Bearer ${tok}`,
          'chatgpt-account-id': ws,
        },
      })

    try {
      const r1 = await callOfficial('tok-27')
      assert.equal(r1.status, 200)
      assert.equal(await r1.text(), modelsOfficial)

      const r2 = await callOfficial('tok-27')
      assert.equal(r2.status, 200)
      assert.equal(await r2.text(), modelsOfficial)

      const r3 = await callOfficial('tok-27')
      assert.equal(r3.status, 200)
      assert.equal(await r3.text(), modelsOfficial)

      const rCompat = await fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/v1/models`, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          [CODEX_UPSTREAM_AUTH_HEADER]: 'Bearer tok-27',
        },
      })
      assert.equal(rCompat.status, 502)
      assert.equal(await rCompat.text(), 'compat v1 502')

      accountId = 28n
      const rRebindStale = await callOfficial('tok-27')
      assert.equal(rRebindStale.status, 200)
      await rRebindStale.text()

      const rRebindNew = await callOfficial('tok-28')
      assert.equal(rRebindNew.status, 502)
      assert.equal(await rRebindNew.text(), 'tok28 502-2')

      accountId = 27n
      const rWs2 = await callOfficial('tok-27', 'ws-2')
      assert.equal(rWs2.status, 502)
      assert.equal(await rWs2.text(), 'ws2 502-2')

      const r401 = await callOfficial('tok-27')
      assert.equal(r401.status, 401)
      assert.equal(await r401.text(), 'unauthorized')

      assert.equal(queue.length, 0)
    } finally {
      await close(server)
    }
  })
})
