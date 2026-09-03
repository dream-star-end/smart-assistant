/**
 * Cursor account-session login (Sand PKCE / loginDeepControl) state machine.
 * No real network: /auth/poll is a mocked fetch.
 *
 * Run: npx tsx --test --test-force-exit packages/commercial/src/__tests__/cursorSessionAuth.test.ts
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'

import { cursorSessionChecksum } from '@openclaude/protocol'
import {
  CURSOR_AUTH_POLL_URL,
  CURSOR_LOGIN_DEEP_CONTROL_URL,
  buildCursorLoginUrl,
  buildCursorPollHeaders,
  cancelCursorSessionAuth,
  generateCursorMachineId,
  getCursorSessionAuthStatus,
  parseCursorPollResponse,
  startCursorSessionAuth,
  waitForCursorSessionAuthLoop,
} from '../admin/cursorSessionAuth.js'

const NOW = 1_800_000_000_000
const MACHINE_ID = 'abcdefghijklmnopqrstuvwxyz'

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function jwt(claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify(claims))
  return `${header}.${payload}.${b64url('signature-bytes')}`
}

const FUTURE_EXP = Math.floor(NOW / 1000) + 60 * 24 * 3600
const ACCESS = jwt({ sub: 'auth0|user_01', iss: 'https://authentication.cursor.sh', type: 'session', exp: FUTURE_EXP })
const REFRESH = jwt({ sub: 'auth0|user_01', iss: 'https://authentication.cursor.sh', type: 'refresh', exp: FUTURE_EXP + 3600 })

type Step = { status: number; body?: unknown } | { throws: true }

function mockFetch(steps: Step[]): { fetchImpl: (input: string, init?: RequestInit) => Promise<Response>; calls: Array<{ url: URL; headers: Record<string, string> }> } {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = []
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: new URL(input), headers: { ...(init?.headers as Record<string, string>) } })
    const step = steps.shift() ?? steps[steps.length - 1] ?? { status: 404 }
    if ('throws' in step) throw new TypeError('fetch failed')
    if (step.body === undefined) return new Response(null, { status: step.status })
    return new Response(JSON.stringify(step.body), { status: step.status, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, calls }
}

/**
 * The module unref()s every timer (the HTTP server keeps the loop alive in
 * production), so the bare test process needs a ref'd handle while waiting.
 */
async function settle(id: string): Promise<void> {
  const keepAlive = setInterval(() => {}, 1_000)
  try {
    await waitForCursorSessionAuthLoop(id)
  } finally {
    clearInterval(keepAlive)
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

describe('generateCursorMachineId / buildCursorLoginUrl / buildCursorPollHeaders', () => {
  test('machine id is 26 lowercase alphanumerics and differs per call', () => {
    const a = generateCursorMachineId()
    const b = generateCursorMachineId()
    assert.match(a, /^[a-z0-9]{26}$/)
    assert.match(b, /^[a-z0-9]{26}$/)
    assert.notEqual(a, b)
  })

  test('login url carries S256 challenge, bp_ uuid and sand redirect target', () => {
    const url = new URL(buildCursorLoginUrl('chal', 'bp_x'))
    assert.equal(`${url.origin}${url.pathname}`, CURSOR_LOGIN_DEEP_CONTROL_URL)
    assert.equal(url.searchParams.get('challenge'), 'chal')
    assert.equal(url.searchParams.get('uuid'), 'bp_x')
    assert.equal(url.searchParams.get('mode'), 'login')
    assert.equal(url.searchParams.get('redirectTarget'), 'sand')
    assert.equal(url.searchParams.get('supportsSelectedTeamLogin'), 'true')
  })

  test('poll headers pin sand client identity and derive checksum from the machine id', () => {
    const headers = buildCursorPollHeaders(MACHINE_ID, NOW)
    assert.equal(headers['x-cursor-client-type'], 'sand')
    assert.equal(headers['x-ghost-mode'], 'true')
    assert.equal(headers['connect-protocol-version'], '1')
    assert.match(headers['x-request-id']!, /^[0-9a-f]{32}$/)
    assert.equal(headers['x-cursor-checksum'], cursorSessionChecksum(MACHINE_ID, NOW))
    assert.ok(headers['x-cursor-checksum']!.endsWith(MACHINE_ID))
  })
})

describe('parseCursorPollResponse', () => {
  test('accepts a valid pair and derives expires_at from the access token exp', () => {
    const cred = parseCursorPollResponse({ accessToken: ` ${ACCESS} `, refreshToken: REFRESH, authId: 'auth0|user_01', email: 'a@b.c' }, MACHINE_ID, NOW)
    assert.equal(cred.access_token, ACCESS)
    assert.equal(cred.refresh_token, REFRESH)
    assert.equal(cred.machine_id, MACHINE_ID)
    assert.equal(cred.auth_id, 'auth0|user_01')
    assert.equal(cred.email, 'a@b.c')
    assert.equal(cred.expires_at, new Date(FUTURE_EXP * 1000).toISOString())
  })

  test('rejects malformed, missing or near-expired tokens', () => {
    assert.throws(() => parseCursorPollResponse(null, MACHINE_ID, NOW), /CURSOR_SESSION_POLL_BODY_INVALID/)
    assert.throws(() => parseCursorPollResponse({ accessToken: 'nope', refreshToken: REFRESH }, MACHINE_ID, NOW), /CURSOR_SESSION_ACCESS_TOKEN_MALFORMED/)
    assert.throws(() => parseCursorPollResponse({ accessToken: ACCESS }, MACHINE_ID, NOW), /CURSOR_SESSION_REFRESH_TOKEN_MALFORMED/)
    const soon = jwt({ exp: Math.floor(NOW / 1000) + 600 })
    assert.throws(() => parseCursorPollResponse({ accessToken: soon, refreshToken: REFRESH }, MACHINE_ID, NOW), /CURSOR_SESSION_ACCESS_TOKEN_EXPIRED/)
    const noExp = jwt({ sub: 'x' })
    assert.throws(() => parseCursorPollResponse({ accessToken: noExp, refreshToken: REFRESH }, MACHINE_ID, NOW), /CURSOR_SESSION_ACCESS_TOKEN_MALFORMED/)
  })
})

describe('startCursorSessionAuth lifecycle', () => {
  test('pending until /auth/poll answers, then one-shot complete with the machine id used for polling', async () => {
    const mock = mockFetch([
      { status: 404 },
      { throws: true },
      { status: 503 },
      { status: 200, body: { accessToken: ACCESS, refreshToken: REFRESH, authId: 'auth0|user_01' } },
    ])
    const started = startCursorSessionAuth({ fetchImpl: mock.fetchImpl, pollIntervalMs: 1, now: () => NOW })
    assert.equal(started.status, 'pending')
    assert.match(started.session_id, /^[0-9a-f]{32}$/)
    const loginUrl = new URL(started.verification_url)
    assert.equal(loginUrl.host, 'cursor.com')
    const challenge = loginUrl.searchParams.get('challenge')!
    const uuid = loginUrl.searchParams.get('uuid')!
    assert.match(uuid, /^bp_[A-Za-z0-9_-]+$/)

    await settle(started.session_id)
    assert.equal(mock.calls.length, 4)
    for (const call of mock.calls) {
      assert.equal(`${call.url.origin}${call.url.pathname}`, CURSOR_AUTH_POLL_URL)
      assert.equal(call.url.searchParams.get('uuid'), uuid)
      assert.equal(call.headers['x-cursor-client-type'], 'sand')
    }
    // PKCE: the verifier sent to /auth/poll hashes to the challenge in the login url.
    const verifier = mock.calls[0]!.url.searchParams.get('verifier')!
    assert.equal(b64url(createHash('sha256').update(verifier).digest()), challenge)
    const machineId = mock.calls[0]!.headers['x-cursor-checksum']!.slice(-26)
    assert.match(machineId, /^[a-z0-9]{26}$/)

    const done = getCursorSessionAuthStatus(started.session_id)
    assert.ok(done && done.status === 'complete')
    assert.equal(done.access_token, ACCESS)
    assert.equal(done.refresh_token, REFRESH)
    assert.equal(done.machine_id, machineId)
    assert.equal(done.auth_id, 'auth0|user_01')
    assert.equal(done.email, null)
    // Credential is handed out exactly once.
    assert.equal(getCursorSessionAuthStatus(started.session_id), null)
  })

  test('401/403 from /auth/poll fails the login and is reported once', async () => {
    const mock = mockFetch([{ status: 403 }])
    const started = startCursorSessionAuth({ fetchImpl: mock.fetchImpl, pollIntervalMs: 1, now: () => NOW })
    await settle(started.session_id)
    const failed = getCursorSessionAuthStatus(started.session_id)
    assert.deepEqual(failed, { status: 'failed', session_id: started.session_id, error: 'CURSOR_SESSION_LOGIN_REJECTED' })
    assert.equal(getCursorSessionAuthStatus(started.session_id), null)
  })

  test('malformed success body fails without storing anything', async () => {
    const mock = mockFetch([{ status: 200, body: { accessToken: 'garbage', refreshToken: REFRESH } }])
    const started = startCursorSessionAuth({ fetchImpl: mock.fetchImpl, pollIntervalMs: 1, now: () => NOW })
    await settle(started.session_id)
    const failed = getCursorSessionAuthStatus(started.session_id)
    assert.ok(failed && failed.status === 'failed')
    assert.equal(failed.error, 'CURSOR_SESSION_ACCESS_TOKEN_MALFORMED')
  })

  test('ttl expiry fails the login and stops polling', async () => {
    const mock = mockFetch([{ status: 404 }])
    const started = startCursorSessionAuth({ fetchImpl: mock.fetchImpl, pollIntervalMs: 5, ttlMs: 20, now: () => NOW })
    await settle(started.session_id)
    const failed = getCursorSessionAuthStatus(started.session_id)
    assert.ok(failed && failed.status === 'failed')
    assert.equal(failed.error, 'CURSOR_SESSION_LOGIN_EXPIRED')
    const callsAfter = mock.calls.length
    await delay(30)
    assert.equal(mock.calls.length, callsAfter)
  })

  test('cancel removes the session and aborts the poll loop', async () => {
    const mock = mockFetch([{ status: 404 }])
    const started = startCursorSessionAuth({ fetchImpl: mock.fetchImpl, pollIntervalMs: 5, now: () => NOW })
    assert.equal(cancelCursorSessionAuth(started.session_id), true)
    assert.equal(getCursorSessionAuthStatus(started.session_id), null)
    assert.equal(cancelCursorSessionAuth(started.session_id), false)
    await settle(started.session_id)
    const callsAfter = mock.calls.length
    await delay(30)
    assert.equal(mock.calls.length, callsAfter)
  })

  test('unknown session id yields null', () => {
    assert.equal(getCursorSessionAuthStatus('0'.repeat(32)), null)
    assert.equal(cancelCursorSessionAuth('0'.repeat(32)), false)
  })
})
