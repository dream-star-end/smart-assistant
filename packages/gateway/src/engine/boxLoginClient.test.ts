import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BOX_EXEC_TARGET_PATH,
  BOX_LOGIN_PATH,
  BoxExecTargetError,
  requestBoxExecTarget,
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
  assert.deepEqual(await requestBoxLogin({ accountId: '25' }, { env: ENV, fetchImpl }), { profile: 'account2', source: 'master', alternatives: 0 })
  assert.equal((await requestBoxLogin({ accountId: '25' }, { env: ENV, fetchImpl: recorder(200, { profile: 'default', alternatives: 1 }).fetchImpl }))
    .alternatives, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, `${ORIGIN}${BOX_LOGIN_PATH}`)
  assert.equal(calls[0]!.init.method, 'POST')
  assert.equal(calls[0]!.init.redirect, 'error')
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer oc-v3.c1.secret')
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { account_id: '25' })
  await requestBoxLogin({ accountId: '25', session: '0123456789abcdef', prefer: 'account2' }, { env: ENV, fetchImpl })
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { account_id: '25', session: '0123456789abcdef', prefer: 'account2' })
  await requestBoxLogin({ accountId: '25', session: 'not-a-hash', prefer: '../x' }, { env: ENV, fetchImpl })
  assert.deepEqual(JSON.parse(String(calls[2]!.init.body)), { account_id: '25' }, 'malformed hints are dropped, not sent')
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
  assert.deepEqual(tokenFile, { profile: 'default', source: 'master', alternatives: 0 })
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

test('requestBoxExecTarget asks the master route with the container token and checks every field', async () => {
  const env = { ANTHROPIC_BASE_URL: ORIGIN, OPENCLAUDE_V3_MASTER_BASE_URL: ORIGIN, OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.c1.secret' }
  const good = { account_id: '25', exec_url: 'https://box.example.cursorvm.com/agent.v1.ControlService/Exec', exec_token: 'T0K', network_token: 'N3T' }
  const { calls, fetchImpl } = recorder(200, good)
  assert.deepEqual(await requestBoxExecTarget({ env, fetchImpl }),
    { accountId: '25', execUrl: good.exec_url, execToken: 'T0K', networkToken: 'N3T' })
  assert.equal(calls[0]!.url, `${ORIGIN}${BOX_EXEC_TARGET_PATH}`)
  assert.equal(calls[0]!.init.body, '{}')
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer oc-v3.c1.secret')
  const code = async (status: number, body: unknown, e: Record<string, string> = env): Promise<string> => {
    try { await requestBoxExecTarget({ env: e, fetchImpl: recorder(status, body).fetchImpl }); return 'ok' }
    catch (err) { return err instanceof BoxExecTargetError ? err.code : String(err) }
  }
  assert.equal(await code(403, { error: 'BOX_EXEC_NOT_ENTITLED' }), 'BOX_EXEC_NOT_ENTITLED')
  assert.equal(await code(503, { error: 'BOX_EXEC_TARGET_UNAVAILABLE' }), 'BOX_EXEC_TARGET_UNAVAILABLE')
  for (const bad of [
    { ...good, exec_url: 'https://evil.example.com/agent.v1.ControlService/Exec' },
    { ...good, exec_url: 'http://box.example.cursorvm.com/agent.v1.ControlService/Exec' },
    { ...good, exec_url: 'https://box.example.cursorvm.com/other' },
    { ...good, exec_token: 'has space' },
    { ...good, account_id: '025' },
    { exec_url: good.exec_url },
  ]) assert.equal(await code(200, bad), 'BOX_EXEC_TARGET_UNAVAILABLE', JSON.stringify(bad))
  assert.equal(await code(200, good, { OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.c1.secret' }), 'BOX_EXEC_TARGET_UNAVAILABLE', 'no master route')
  const down = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
  await assert.rejects(requestBoxExecTarget({ env, fetchImpl: down }), (e: unknown) => e instanceof BoxExecTargetError && e.code === 'BOX_EXEC_TARGET_UNAVAILABLE')
})
