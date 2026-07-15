import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'

import type { Pool } from 'pg'

import { signAccess } from '../../auth/jwt.js'
import { ContainerPreviewTicketStore } from '../../ws/containerPreviewTickets.js'
import { handleCreateContainerPreviewTicket } from '../containerPreview.js'
import type { CommercialHttpDeps, RequestContext } from '../handlers.js'
import { HttpError } from '../util.js'

const JWT_SECRET = 'container-preview-auth-test-secret-at-least-32-bytes'
const TARGET_URL = 'http://127.0.0.1:5173/hello-world/'

interface PoolCall {
  sql: string
  params: unknown[]
}

function makePool(accounts: ReadonlyMap<string, 'user' | 'admin'>): {
  pool: Pool
  calls: PoolCall[]
} {
  const calls: PoolCall[] = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      const sub = String(params[0] ?? '')
      const allowedRoles = Array.isArray(params[1]) ? params[1] : []
      const role = accounts.get(sub)
      if (role && allowedRoles.includes(role)) {
        return { rowCount: 1, rows: [{ id: sub, role }] }
      }
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
  return { pool, calls }
}

function makeDeps(accounts: ReadonlyMap<string, 'user' | 'admin'>): {
  deps: CommercialHttpDeps
  tickets: ContainerPreviewTicketStore
  poolCalls: PoolCall[]
} {
  const { pool, calls } = makePool(accounts)
  const tickets = new ContainerPreviewTicketStore()
  return {
    deps: {
      jwtSecret: JWT_SECRET,
      v3Supervisor: { pool },
      containerPreviewTickets: tickets,
      containerPreviewAvailable: () => true,
    } as unknown as CommercialHttpDeps,
    tickets,
    poolCalls: calls,
  }
}

async function makeRequest(sub: string, role: 'user' | 'admin'): Promise<IncomingMessage> {
  const { token } = await signAccess({ sub, role }, JWT_SECRET)
  const req = Readable.from([Buffer.from(JSON.stringify({ url: TARGET_URL }))])
  Object.assign(req, {
    method: 'POST',
    url: '/api/container-preview/ticket',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    socket: { remoteAddress: '127.0.0.1' },
  })
  return req as unknown as IncomingMessage
}

function makeResponse(): {
  res: ServerResponse
  status: () => number
  body: () => Record<string, unknown>
} {
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

const ctx = {} as RequestContext

function assertActiveMultiRoleQuery(call: PoolCall | undefined, sub: string): void {
  assert.ok(call)
  assert.match(call.sql, /status = 'active'/i)
  assert.match(call.sql, /role = ANY/i)
  assert.deepEqual(call.params, [sub, ['user', 'admin']])
}

describe('container preview ticket account authorization', () => {
  for (const role of ['user', 'admin'] as const) {
    test(`active ${role} receives a user-scoped preview ticket`, async () => {
      const sub = role === 'user' ? '42' : '1'
      const { deps, tickets, poolCalls } = makeDeps(new Map([[sub, role]]))
      const response = makeResponse()

      await handleCreateContainerPreviewTicket(
        await makeRequest(sub, role),
        response.res,
        ctx,
        deps,
      )

      assert.equal(response.status(), 201)
      const body = response.body()
      assert.equal(body.url, TARGET_URL)
      assert.equal(body.protocol, 'preview-v1')
      assert.equal(typeof body.ticket, 'string')
      const record = tickets.consume(String(body.ticket))
      assert.equal(record?.uid, BigInt(sub))
      assertActiveMultiRoleQuery(poolCalls[0], sub)
    })
  }

  test('inactive admin remains forbidden and receives no ticket', async () => {
    const sub = '1'
    const { deps, tickets, poolCalls } = makeDeps(new Map())
    const response = makeResponse()

    await assert.rejects(
      handleCreateContainerPreviewTicket(await makeRequest(sub, 'admin'), response.res, ctx, deps),
      (err: unknown) =>
        err instanceof HttpError &&
        err.status === 403 &&
        err.code === 'FORBIDDEN' &&
        err.message === 'account is not allowed to open a container preview',
    )
    assert.equal(tickets.size, 0)
    assertActiveMultiRoleQuery(poolCalls[0], sub)
  })
})
