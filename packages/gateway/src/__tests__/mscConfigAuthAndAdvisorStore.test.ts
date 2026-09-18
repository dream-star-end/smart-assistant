/**
 * msc-config 阶段 B:verifyJwt 载荷形状(CFG-22)与 AdvisorConfigStore 的错误码语义(CFG-21)。
 * 运行:npx tsx --test --test-concurrency=1 packages/gateway/src/__tests__/mscConfigAuthAndAdvisorStore.test.ts
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { AdvisorConfigStore, CollaborationConfigError } from '../advisorConfigStore.js'
import { checkToken, signJwt, verifyJwt } from '../auth.js'

const SECRET = 'unit-test-secret'

/** 用同一把密钥手工签一个任意载荷(绕过 signJwt 的形状),模拟「密钥在手但载荷畸形」。 */
function signRaw(payload: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

describe('verifyJwt payload shape (CFG-22)', () => {
  it('accepts what signJwt produces and rejects a tampered signature', () => {
    const exp = Math.floor(Date.now() / 1000) + 60
    const token = signJwt({ userId: 'boss', exp }, SECRET)
    assert.deepEqual(verifyJwt(token, SECRET), { userId: 'boss', exp })
    assert.equal(verifyJwt(token, 'other-secret'), null)
    assert.equal(verifyJwt(`${token}x`, SECRET), null)
  })

  it('rejects a correctly signed payload that has no exp (must not become a forever token)', () => {
    assert.equal(verifyJwt(signRaw({ userId: 'boss' }), SECRET), null)
    assert.equal(verifyJwt(signRaw({ userId: 'boss', exp: 'never' }), SECRET), null)
    assert.equal(
      verifyJwt(signRaw({ userId: 'boss', exp: Number.POSITIVE_INFINITY }), SECRET),
      null,
    )
  })

  it('rejects a correctly signed payload whose userId is missing or not a non-empty string', () => {
    const exp = Math.floor(Date.now() / 1000) + 60
    assert.equal(verifyJwt(signRaw({ exp }), SECRET), null)
    assert.equal(verifyJwt(signRaw({ userId: '', exp }), SECRET), null)
    assert.equal(verifyJwt(signRaw({ userId: 7, exp }), SECRET), null)
    assert.equal(verifyJwt(signRaw(null), SECRET), null)
    assert.equal(verifyJwt(signRaw('str'), SECRET), null)
  })

  it('still rejects expired tokens; raw accessToken comparison is unchanged (single-token mode零变化)', () => {
    assert.equal(
      verifyJwt(signRaw({ userId: 'boss', exp: Math.floor(Date.now() / 1000) - 1 }), SECRET),
      null,
    )
    assert.equal(checkToken(SECRET, SECRET), true)
    assert.equal(checkToken('nope', SECRET), false)
  })
})

describe('AdvisorConfigStore error codes (CFG-21)', () => {
  it('deleteSession validates the id like putSession and reports VALIDATION', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-collab-msc-'))
    const store = new AdvisorConfigStore(join(dir, 'collaboration-config.json'))
    await assert.rejects(
      store.deleteSession('bad id with spaces'),
      (err: unknown) => err instanceof CollaborationConfigError && err.code === 'VALIDATION',
    )
    await store.putSession('s1', { mode: 'solo', advisorModel: null })
    const doc = await store.deleteSession('s1')
    assert.equal(doc.sessions.s1, undefined)
  })

  it('markEngineProven rejects over-long engine ids up front as VALIDATION, not CORRUPT after the write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-collab-msc-'))
    const store = new AdvisorConfigStore(join(dir, 'collaboration-config.json'))
    await assert.rejects(
      store.markEngineProven('x'.repeat(33)),
      (err: unknown) => err instanceof CollaborationConfigError && err.code === 'VALIDATION',
    )
    const doc = await store.markEngineProven('codex')
    assert.deepEqual(doc.provenEngines, ['codex'])
    // 文件从未被畸形值污染:重读仍合法
    assert.deepEqual(store.read().provenEngines, ['codex'])
  })
})
