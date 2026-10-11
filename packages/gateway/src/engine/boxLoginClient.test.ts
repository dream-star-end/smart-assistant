import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BOX_LOGIN_PATH,
  BOX_LOGIN_SIGNALS_PATH,
  BoxLoginUnavailableError,
  boxLoginUrlFromEnv,
  reportBoxLoginSignals,
  requestBoxLogin,
} from './boxLoginClient.js'

const ORIGIN = 'http://172.31.0.1:18892'
const ENV = { OC_BOX_LOGIN_URL: ORIGIN, OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.c1.secret' }

function recorder(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { calls, fetchImpl }
}

test('the login endpoint comes only from the master route the container already uses', () => {
  assert.equal(boxLoginUrlFromEnv({ ANTHROPIC_BASE_URL: ORIGIN, OPENCLAUDE_V3_MASTER_BASE_URL: ORIGIN }), ORIGIN)
  assert.equal(boxLoginUrlFromEnv({ ANTHROPIC_BASE_URL: `${ORIGIN}/`, OPENCLAUDE_V3_MASTER_BASE_URL: `${ORIGIN}/` }), ORIGIN)
  for (const env of [
    {},
    { ANTHROPIC_BASE_URL: ORIGIN },
    { ANTHROPIC_BASE_URL: ORIGIN, OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:18892' },
    { ANTHROPIC_BASE_URL: 'https://172.31.0.1:18892', OPENCLAUDE_V3_MASTER_BASE_URL: 'https://172.31.0.1:18892' },
    { ANTHROPIC_BASE_URL: 'http://10.0.0.1:18892', OPENCLAUDE_V3_MASTER_BASE_URL: 'http://10.0.0.1:18892' },
    { ANTHROPIC_BASE_URL: `${ORIGIN}/v1`, OPENCLAUDE_V3_MASTER_BASE_URL: `${ORIGIN}/v1` },
  ]) assert.equal(boxLoginUrlFromEnv(env), null, JSON.stringify(env))
})

test('requestBoxLogin asks the egress with the container token and returns the chosen login', async () => {
  const { calls, fetchImpl } = recorder(200, { profile: 'account2' })
  assert.deepEqual(await requestBoxLogin({ accountId: '25' }, { env: ENV, fetchImpl }), { profile: 'account2', source: 'master' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, `${ORIGIN}${BOX_LOGIN_PATH}`)
  assert.equal(calls[0]!.init.method, 'POST')
  assert.equal(calls[0]!.init.redirect, 'error')
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer oc-v3.c1.secret')
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { account_id: '25' })
})

test('requestBoxLogin falls back to the default login when it cannot ask, and fails only on "nothing usable"', async () => {
  const fallback = { profile: 'default', source: 'fallback' }
  const never = (async () => { throw new Error('must not be called') }) as typeof fetch
  assert.deepEqual(await requestBoxLogin({ accountId: undefined }, { env: ENV, fetchImpl: never }), fallback)
  assert.deepEqual(await requestBoxLogin({ accountId: '0x19' }, { env: ENV, fetchImpl: never }), fallback)
  assert.deepEqual(await requestBoxLogin({ accountId: '25' }, { env: {}, fetchImpl: never }), fallback, 'no endpoint')
  assert.deepEqual(await requestBoxLogin({ accountId: '25' }, { env: { OC_BOX_LOGIN_URL: ORIGIN, OPENCLAUDE_V3_CONTAINER_TOKEN: 'bad' },
    fetchImpl: never }), fallback, 'no valid token')
  const tokenFile = await requestBoxLogin({ accountId: '25' }, { env: { OC_BOX_LOGIN_URL: ORIGIN,
    OPENCLAUDE_V3_CONTAINER_TOKEN_FILE: '/run/token' }, readFile: () => 'oc-v3.f.secret\n', fetchImpl: recorder(200, { profile: 'default' }).fetchImpl })
  assert.deepEqual(tokenFile, { profile: 'default', source: 'master' })
  for (const [status, body] of [[404, { error: 'NOT_FOUND' }], [500, {}], [200, { profile: '../x' }], [200, {}],
    [503, { error: 'BOX_LOGIN_STORE_UNAVAILABLE' }]] as const) {
    assert.deepEqual(await requestBoxLogin({ accountId: '25' }, { env: ENV, fetchImpl: recorder(status, body).fetchImpl }), fallback,
      `${status} ${JSON.stringify(body)}`)
  }
  const down = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
  assert.deepEqual(await requestBoxLogin({ accountId: '25' }, { env: ENV, fetchImpl: down }), fallback)
  await assert.rejects(requestBoxLogin({ accountId: '25' }, { env: ENV,
    fetchImpl: recorder(503, { error: 'BOX_LOGIN_UNAVAILABLE' }).fetchImpl }), BoxLoginUnavailableError)
})

test('reportBoxLoginSignals sends bounded lines for the login, or the Box refusal', async () => {
  const { calls, fetchImpl } = recorder(200, { recorded: true })
  const line = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}'
  assert.equal(await reportBoxLoginSignals({ accountId: '25', profile: 'account2', lines: [line] }, { env: ENV, fetchImpl }), true)
  assert.equal(calls[0]!.url, `${ORIGIN}${BOX_LOGIN_SIGNALS_PATH}`)
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { account_id: '25', profile: 'account2', lines: [line] })
  assert.equal(await reportBoxLoginSignals({ accountId: '25', profile: 'account2', lines: [], unsafe: true }, { env: ENV, fetchImpl }), true)
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { account_id: '25', profile: 'account2', lines: [], unsafe: true })
  const many = Array.from({ length: 40 }, () => line)
  await reportBoxLoginSignals({ accountId: '25', profile: 'default', lines: [...many, 'x'.repeat(70_000)] }, { env: ENV, fetchImpl })
  assert.equal(JSON.parse(String(calls[2]!.init.body)).lines.length, 16)
  // Nothing to say, a bad name or account: no request.
  assert.equal(await reportBoxLoginSignals({ accountId: '25', profile: 'default', lines: [] }, { env: ENV, fetchImpl }), false)
  assert.equal(await reportBoxLoginSignals({ accountId: '25', profile: 'Bad', lines: [line] }, { env: ENV, fetchImpl }), false)
  assert.equal(await reportBoxLoginSignals({ accountId: undefined, profile: 'default', lines: [line] }, { env: ENV, fetchImpl }), false)
  assert.equal(calls.length, 3)
})
