/**
 * P2b entry freeze (arch plan v3.6 §4.2): pins what gateway `verifyJwt` accepts
 * TODAY, before the auth rewrite. Several of these acceptances are known weak
 * spots; they are frozen as-is so that a refactor cannot change them silently.
 * Only the JWT-tightening PR (P4b) may flip the three cases marked
 * "P4b flips", and it must say so in its description.
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { signJwt, verifyJwt } from '../auth.js'

const SECRET = 's'.repeat(64)
const now = () => Math.floor(Date.now() / 1000)
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')

function forge(header: unknown, payload: unknown, secret = SECRET): string {
  const h = b64(header)
  const p = b64(payload)
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')
  return `${h}.${p}.${sig}`
}

test('freeze: a signed token with a future exp is accepted', () => {
  const exp = now() + 3600
  assert.deepEqual(verifyJwt(signJwt({ userId: 'u1', exp }, SECRET), SECRET), { userId: 'u1', exp })
})

test('freeze: an expired token is rejected', () => {
  assert.equal(verifyJwt(signJwt({ userId: 'u1', exp: now() - 1 }, SECRET), SECRET), null)
})

test('freeze (P4b flips): a token without exp is accepted and never expires', () => {
  const token = forge({ alg: 'HS256', typ: 'JWT' }, { userId: 'u1' })
  assert.deepEqual(verifyJwt(token, SECRET), { userId: 'u1' })
})

test('freeze (P4b flips): exp: 0 is treated as "no exp" and accepted', () => {
  const token = forge({ alg: 'HS256', typ: 'JWT' }, { userId: 'u1', exp: 0 })
  assert.deepEqual(verifyJwt(token, SECRET), { userId: 'u1', exp: 0 })
})

test('freeze (P4b flips): header alg is not read; alg none with a valid HMAC is accepted', () => {
  const token = forge({ alg: 'none', typ: 'JWT' }, { userId: 'u1', exp: now() + 60 })
  assert.equal(verifyJwt(token, SECRET)?.userId, 'u1')
})

test('freeze: a standard alg none token with an empty signature is rejected', () => {
  const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ userId: 'u1', exp: now() + 60 })}.`
  assert.equal(verifyJwt(token, SECRET), null)
})

test('freeze: a token signed with another secret is rejected', () => {
  assert.equal(verifyJwt(signJwt({ userId: 'u1', exp: now() + 60 }, 'x'.repeat(64)), SECRET), null)
})

test('freeze: a payload changed after signing is rejected', () => {
  const [h, , s] = signJwt({ userId: 'u1', exp: now() + 60 }, SECRET).split('.')
  assert.equal(verifyJwt(`${h}.${b64({ userId: 'admin', exp: now() + 60 })}.${s}`, SECRET), null)
})

test('freeze: userId is not required; a signed payload without it is returned as-is', () => {
  const exp = now() + 60
  assert.deepEqual(verifyJwt(forge({ alg: 'HS256', typ: 'JWT' }, { exp }), SECRET), { exp })
})

test('freeze: malformed tokens and a signed non-JSON body are rejected', () => {
  for (const token of ['', 'a.b', 'a.b.c.d', 'a.b.c']) assert.equal(verifyJwt(token, SECRET), null)
  const h = b64({ alg: 'HS256' })
  const body = Buffer.from('not json').toString('base64url')
  const sig = createHmac('sha256', SECRET).update(`${h}.${body}`).digest('base64url')
  assert.equal(verifyJwt(`${h}.${body}.${sig}`, SECRET), null)
})
