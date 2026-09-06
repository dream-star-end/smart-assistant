import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'

import type { Pool } from 'pg'

import { signAccess } from '../../auth/jwt.js'
import type { ChatGptProxyCredentialStore } from '../../chatgptProxy/credentials.js'
import {
  handleGetChatGptProxyAccess,
  handleIssueChatGptProxyCredential,
  handleRevokeChatGptProxyCredential,
} from '../chatgptProxy.js'
import type { CommercialHttpDeps, RequestContext } from '../handlers.js'
import { HttpError } from '../util.js'

const JWT_SECRET = 'chatgpt-proxy-auth-test-secret-at-least-32-bytes-long'

function makePool(accounts: ReadonlyMap<string, 'user' | 'admin'>): Pool {
  return {
    query: async (_sql: string, params: unknown[] = []) => {
      const sub = String(params[0] ?? '')
      const role = accounts.get(sub)
      return role ? { rowCount: 1, rows: [{ id: sub, role }] } : { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
}

function makeCredentials(): {
  store: ChatGptProxyCredentialStore
  issued: number[]
  revoked: number[]
} {
  const issued: number[] = []
  const revoked: number[] = []
  const store = {
    info: async (uid: number) => ({
      hasCredential: issued.includes(uid),
      createdAt: null,
      rotatedAt: null,
      lastUsedAt: null,
    }),
    issue: async (uid: number) => {
      issued.push(uid)
      return { secret: `plain-secret-${uid}`, rotatedAt: '2026-09-06T00:00:00.000Z' }
    },
    revoke: async (uid: number) => {
      revoked.push(uid)
    },
  } as unknown as ChatGptProxyCredentialStore
  return { store, issued, revoked }
}

function makeDeps(
  accounts: ReadonlyMap<string, 'user' | 'admin'>,
  flags: { assembled: boolean; allowlist: number[] } | 'off',
) {
  const creds = makeCredentials()
  const deps = {
    jwtSecret: JWT_SECRET,
    v3Supervisor: { pool: makePool(accounts) },
    chatgptProxy:
      flags === 'off'
        ? undefined
        : {
            publicHost: 'proxy.example.test',
            port: 8443,
            credentials: creds.store,
            getFlags: async () => ({ envEnabled: true, settingsOn: flags.assembled, ...flags }),
          },
  } as unknown as CommercialHttpDeps
  return { deps, ...creds }
}

async function makeRequest(
  sub: string,
  role: 'user' | 'admin',
  method = 'GET',
): Promise<IncomingMessage> {
  const { token } = await signAccess({ sub, role }, JWT_SECRET)
  const req = Readable.from([])
  Object.assign(req, {
    method,
    url: '/api/chatgpt-proxy/access',
    headers: { authorization: `Bearer ${token}` },
    socket: { remoteAddress: '127.0.0.1' },
  })
  return req as unknown as IncomingMessage
}

function makeResponse() {
  let statusCode = 200
  let rawBody = ''
  const res = {
    setHeader: () => {},
    end: (chunk?: string) => {
      rawBody = chunk ?? ''
    },
  } as unknown as ServerResponse
  Object.defineProperty(res, 'statusCode', {
    get: () => statusCode,
    set: (value: number) => {
      statusCode = value
    },
  })
  return {
    res,
    status: () => statusCode,
    body: () => JSON.parse(rawBody) as Record<string, unknown>,
  }
}

const ctx = {
  log: { info: () => {}, warn: () => {}, error: () => {} },
} as unknown as RequestContext

describe('chatgpt proxy http', () => {
  test('admin sees connection details and can issue a credential', async () => {
    const { deps, issued } = makeDeps(new Map([['3', 'admin']]), { assembled: true, allowlist: [] })
    const access = makeResponse()
    await handleGetChatGptProxyAccess(await makeRequest('3', 'admin'), access.res, ctx, deps)
    assert.equal(access.status(), 200)
    assert.equal(access.body().enabled, true)
    assert.equal(access.body().username, 'u3')
    assert.equal(access.body().pacUrl, 'https://proxy.example.test:8443/pac')
    assert.equal(access.body().hasCredential, false)

    const issue = makeResponse()
    await handleIssueChatGptProxyCredential(
      await makeRequest('3', 'admin', 'POST'),
      issue.res,
      ctx,
      deps,
    )
    assert.equal(issue.status(), 201)
    assert.deepEqual(issued, [3])
    assert.equal(issue.body().username, 'u3')
    assert.equal(issue.body().password, 'plain-secret-3')
  })

  test('allowlisted user is enabled; non-allowlisted user is not and gets 403 on issue', async () => {
    const { deps } = makeDeps(
      new Map([
        ['7', 'user'],
        ['9', 'user'],
      ]),
      { assembled: true, allowlist: [7] },
    )
    const ok = makeResponse()
    await handleGetChatGptProxyAccess(await makeRequest('7', 'user'), ok.res, ctx, deps)
    assert.equal(ok.body().enabled, true)

    const denied = makeResponse()
    await handleGetChatGptProxyAccess(await makeRequest('9', 'user'), denied.res, ctx, deps)
    assert.deepEqual(denied.body(), { enabled: false })

    await assert.rejects(
      handleIssueChatGptProxyCredential(
        await makeRequest('9', 'user', 'POST'),
        makeResponse().res,
        ctx,
        deps,
      ),
      (err: unknown) =>
        err instanceof HttpError && err.status === 403 && err.code === 'CHATGPT_PROXY_FORBIDDEN',
    )
  })

  test('settings off → even admin disabled; listener off → 503 on issue, access says disabled', async () => {
    const off = makeDeps(new Map([['3', 'admin']]), { assembled: false, allowlist: [] })
    const r = makeResponse()
    await handleGetChatGptProxyAccess(await makeRequest('3', 'admin'), r.res, ctx, off.deps)
    assert.deepEqual(r.body(), { enabled: false })

    const none = makeDeps(new Map([['3', 'admin']]), 'off')
    const r2 = makeResponse()
    await handleGetChatGptProxyAccess(await makeRequest('3', 'admin'), r2.res, ctx, none.deps)
    assert.deepEqual(r2.body(), { enabled: false })
    await assert.rejects(
      handleIssueChatGptProxyCredential(
        await makeRequest('3', 'admin', 'POST'),
        makeResponse().res,
        ctx,
        none.deps,
      ),
      (err: unknown) => err instanceof HttpError && err.status === 503,
    )
  })

  test('revoke works even when no longer entitled; inactive account is 403', async () => {
    const { deps, revoked } = makeDeps(new Map([['9', 'user']]), { assembled: true, allowlist: [] })
    const r = makeResponse()
    await handleRevokeChatGptProxyCredential(
      await makeRequest('9', 'user', 'DELETE'),
      r.res,
      ctx,
      deps,
    )
    assert.equal(r.status(), 200)
    assert.deepEqual(revoked, [9])

    await assert.rejects(
      handleGetChatGptProxyAccess(await makeRequest('404', 'user'), makeResponse().res, ctx, deps),
      (err: unknown) => err instanceof HttpError && err.status === 403,
    )
  })
})
