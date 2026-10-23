import assert from 'node:assert/strict'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import test from 'node:test'
import type { QueryRunner } from '../db/queries.js'
import { signAccess, issueRefresh } from '../auth/jwt.js'
import { normalizeConfirmationOrigin, requireBrowserConfirmationPrincipal } from '../auth/browserConfirmation.js'
const origin = 'https://fixture.example'
const secret = 'synthetic-browser-proof-unit-secret-only'
const refresh = issueRefresh()
const family = 'ec73b85d-f9ec-4d3b-b878-36c6754e6aa7'
async function setup() {
  const access = await signAccess({ sub: '765', role: 'user' }, secret)
  let active = true
  let dbRole = 'user'
  let reads = 0
  const runner = { async query(sql: string, params: unknown[]) {
    reads++
    assert.ok(sql.trimStart().startsWith('SELECT '))
    for (const predicate of ['rt.revoked_at IS NULL', 'rt.rotated_to_id IS NULL', 'rt.expires_at > CURRENT_TIMESTAMP', "u.status = 'active'", 'rt.user_id = $2::bigint']) assert.ok(sql.includes(predicate))
    assert.ok(params[0] === refresh.hash && params[1] === '765')
    return { rows: active ? [{ id: '765', role: dbRole, refresh_session_id: '91', refresh_family_id: family }] : [] }
  } } as unknown as QueryRunner
  const request = (overrides: Record<string, string | undefined> = {}) => {
    const req = new IncomingMessage(new Socket())
    req.method = 'POST'
    const headers = { authorization: `Bearer ${access.token}`, cookie: `oc_rt=${refresh.token}`, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...overrides }
    for (const [key, value] of Object.entries(headers)) if (value !== undefined) { req.headers[key] = value; req.rawHeaders.push(key, value) }
    return req
  }
  return { request, deps: { jwtSecret: secret, firstPartyOrigin: origin, runner }, setActive(v: boolean) { active = v }, setRole(v: string) { dbRole = v }, reads: () => reads }
}
test('a current first-party browser has independent read-only refresh proof and an internal binding', async () => {
  const f = await setup()
  const principal = await requireBrowserConfirmationPrincipal(f.request(), f.deps)
  assert.equal(principal.id, '765')
  assert.equal(principal.role, 'user')
  assert.equal(principal.refreshFamilyId, family)
  assert.equal(principal.refreshSessionId, '91')
  assert.ok(principal.accessJti.length > 0)
  assert.equal(f.reads(), 1)
})
test('an access JWT, copied oc_session, container token or body credential cannot replace independent oc_rt', async () => {
  const f = await setup()
  for (const headers of [{ cookie: undefined }, { cookie: 'oc_session=synthetic' }, { cookie: 'oc_rt=invalid' }, { authorization: 'Bearer oc-v3.container.synthetic' }]) {
    await assert.rejects(requireBrowserConfirmationPrincipal(f.request(headers), f.deps), /第一方/)
  }
  assert.equal(f.reads(), 0)
})
test('cross-origin, missing Fetch Metadata, non-JSON and unsafe method never reach refresh lookup', async () => {
  const f = await setup()
  for (const headers of [{ origin: 'https://preview.trycloudflare.com' }, { origin: 'null' }, { origin: undefined }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': undefined }, { 'content-type': 'text/plain' }]) {
    await assert.rejects(requireBrowserConfirmationPrincipal(f.request(headers), f.deps), /第一方/)
  }
  const get = f.request(); get.method = 'GET'
  await assert.rejects(requireBrowserConfirmationPrincipal(get, f.deps), /第一方/)
  assert.equal(f.reads(), 0)
})
test('ambiguous headers, duplicate refresh and noncanonical refresh bytes are rejected', async () => {
  const f = await setup()
  for (const name of ['authorization', 'origin', 'cookie', 'content-type', 'sec-fetch-site']) {
    const req = f.request(); req.rawHeaders.push(name, String(req.headers[name]))
    await assert.rejects(requireBrowserConfirmationPrincipal(req, f.deps), /第一方/)
  }
  for (const cookie of [`oc_rt=${refresh.token}; oc_rt=${refresh.token}`, `oc_rt=${refresh.token}=`, `oc_rt=${refresh.token.slice(0, -1)}!`]) {
    await assert.rejects(requireBrowserConfirmationPrincipal(f.request({ cookie }), f.deps), /第一方/)
  }
  assert.equal(f.reads(), 0)
})
test('revocation, expiry or inactive account fails closed; role changes require fresh identity', async () => {
  const f = await setup(); f.setActive(false)
  await assert.rejects(requireBrowserConfirmationPrincipal(f.request(), f.deps), /第一方/)
  f.setActive(true); f.setRole('admin')
  await assert.rejects(requireBrowserConfirmationPrincipal(f.request(), f.deps), /第一方/)
  assert.equal(f.reads(), 2)
})
test('a missing or invalid configured origin has no Host-derived fallback', async () => {
  const f = await setup()
  for (const raw of [undefined, '', 'http://external.example', 'https://user:pass@fixture.example', 'https://fixture.example/path', 'https://fixture.example/?a=1']) {
    assert.equal(normalizeConfirmationOrigin(raw), null)
    await assert.rejects(requireBrowserConfirmationPrincipal(f.request({ host: 'fixture.example' }), { ...f.deps, firstPartyOrigin: raw ?? null }), /第一方/)
  }
  assert.equal(normalizeConfirmationOrigin('http://127.0.0.1:18790'), 'http://127.0.0.1:18790')
  assert.equal(f.reads(), 0)
})
