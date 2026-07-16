import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'
import { SignJWT } from 'jose'
import type { GoalStateService } from '../../goal/goalStateService.js'
import { dispatchGoalRoute } from '../goalRoutes.js'
import { HttpError } from '../util.js'

const SECRET = 'goal_route_test_secret_is_at_least_32_bytes_long'

async function token(sub = '7'): Promise<string> {
  return new SignJWT({ sub, role: 'user', jti: 'goal-test' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET))
}

function request(args: { method: string; url: string; bearer?: string; body?: unknown }): IncomingMessage {
  const stream = Readable.from(args.body === undefined ? [] : [JSON.stringify(args.body)]) as IncomingMessage
  stream.method = args.method
  stream.url = args.url
  stream.headers = args.bearer ? { authorization: `Bearer ${args.bearer}` } : {}
  return stream
}

function response(): { res: ServerResponse; body: () => unknown; status: () => number } {
  let payload = ''
  let statusCode = 200
  const res = {
    setHeader() {},
    get statusCode() { return statusCode },
    set statusCode(value: number) { statusCode = value },
    end(chunk?: string) { payload = chunk ?? '' },
  } as unknown as ServerResponse
  return { res, body: () => JSON.parse(payload), status: () => statusCode }
}

describe('GoalState HTTP routes', () => {
  test('requires bearer auth before touching the service', async () => {
    let called = false
    const service = { get: async () => { called = true; return null } } as unknown as GoalStateService
    await assert.rejects(
      dispatchGoalRoute(request({ method: 'GET', url: '/api/session-goals/s1' }), response().res, {
        jwtSecret: SECRET,
        goalStateService: service,
      }),
      (err: unknown) => err instanceof HttpError && err.status === 401,
    )
    assert.equal(called, false)
  })

  test('derives the owner uid from JWT and decodes the session id', async () => {
    const calls: unknown[][] = []
    const service = {
      get: async (...args: unknown[]) => { calls.push(args); return null },
    } as unknown as GoalStateService
    const out = response()
    await dispatchGoalRoute(
      request({ method: 'GET', url: '/api/session-goals/session%2D7', bearer: await token() }),
      out.res,
      { jwtSecret: SECRET, goalStateService: service },
    )
    assert.equal(out.status(), 200)
    assert.deepEqual(out.body(), { goal: null })
    assert.deepEqual(calls, [[7n, 'session-7']])
  })

  test('rejects malformed budgets and CAS revisions instead of silently clearing them', async () => {
    let called = false
    const service = { set: async () => { called = true; return null } } as unknown as GoalStateService
    const bearer = await token()
    for (const body of [
      { objective: 'x' },
      { objective: 'x', tokenBudget: '100' },
      { objective: 'x', creditBudget: 100 },
      { objective: 'x', expectedStateRevision: -1 },
      { objective: 'x', expectedStateRevision: 1.5 },
    ]) {
      await assert.rejects(
        dispatchGoalRoute(
          request({ method: 'PUT', url: '/api/session-goals/s1', bearer, body }),
          response().res,
          { jwtSecret: SECRET, goalStateService: service },
        ),
        (err: unknown) => err instanceof HttpError && err.status === 400,
      )
    }
    assert.equal(called, false)
  })

  test('passes validated set and transition inputs to the service', async () => {
    const calls: Array<{ op: string; args: unknown[] }> = []
    const snapshot = { status: 'active' }
    const service = {
      set: async (...args: unknown[]) => { calls.push({ op: 'set', args }); return snapshot },
      pause: async (...args: unknown[]) => { calls.push({ op: 'pause', args }); return snapshot },
    } as unknown as GoalStateService
    const bearer = await token()
    await dispatchGoalRoute(
      request({
        method: 'PUT',
        url: '/api/session-goals/s1',
        bearer,
        body: { objective: 'ship', tokenBudget: 100, creditBudget: '20', expectedStateRevision: 3 },
      }),
      response().res,
      { jwtSecret: SECRET, goalStateService: service },
    )
    await dispatchGoalRoute(
      request({ method: 'POST', url: '/api/session-goals/s1/pause', bearer, body: { expectedStateRevision: 4 } }),
      response().res,
      { jwtSecret: SECRET, goalStateService: service },
    )
    assert.deepEqual(calls, [
      {
        op: 'set',
        args: [7n, 's1', {
          objective: 'ship',
          tokenBudget: 100,
          creditBudget: '20',
          expectedStateRevision: 3,
        }],
      },
      { op: 'pause', args: [7n, 's1', 4] },
    ])
  })
})
