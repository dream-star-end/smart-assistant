/**
 * DelegateResumeRegistry: mint uniqueness, tuple resume, occupancy 409,
 * TTL/cap eviction that skips reserved keys.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateResume.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DelegateResumeRegistry,
  mintDelegateSessionKey,
} from '../delegateResume.js'

describe('mintDelegateSessionKey', () => {
  it('includes target, source, timestamp and nonce', () => {
    const key = mintDelegateSessionKey('auditor', 'main', 1_700_000_000_000, 'deadbeefcafebabe')
    assert.equal(key, 'agent:auditor:delegate:main:1700000000000:deadbeefcafebabe')
  })
})

describe('DelegateResumeRegistry', () => {
  it('omitting resume mints unique keys even with a frozen clock', () => {
    let n = 0
    const reg = new DelegateResumeRegistry({
      now: () => 1_700_000_000_000,
      nonce: () => `nonce${n++}`,
    })
    const a = reg.preflight({
      parentSessionKey: 'parent-a',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
    })
    const b = reg.preflight({
      parentSessionKey: 'parent-a',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
    })
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    if (!a.ok || !b.ok) return
    assert.equal(a.minted, true)
    assert.equal(b.minted, true)
    assert.notEqual(a.sessionKey, b.sessionKey)
  })

  it('same parent/source/target can resume after release; mismatch/unknown is 400', () => {
    const reg = new DelegateResumeRegistry({ now: () => 10, nonce: () => 'aa' })
    const minted = reg.preflight({
      parentSessionKey: 'parent-a',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
    })
    assert.equal(minted.ok, true)
    if (!minted.ok) return
    reg.release(minted.sessionKey)

    const ok = reg.preflight({
      resumeSessionKey: minted.sessionKey,
      parentSessionKey: 'parent-a',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
    })
    assert.equal(ok.ok, true)
    if (!ok.ok) return
    assert.equal(ok.minted, false)
    assert.equal(ok.sessionKey, minted.sessionKey)
    reg.release(minted.sessionKey)

    const wrongParent = reg.preflight({
      resumeSessionKey: minted.sessionKey,
      parentSessionKey: 'parent-b',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
    })
    assert.equal(wrongParent.ok, false)
    if (wrongParent.ok) return
    assert.equal(wrongParent.httpStatus, 400)

    const unknown = reg.preflight({
      resumeSessionKey: 'agent:auditor:taskboard:ticket:stage:run',
      parentSessionKey: 'parent-a',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
    })
    assert.equal(unknown.ok, false)
    if (unknown.ok) return
    assert.equal(unknown.httpStatus, 400)
  })

  it('in-flight resume of the same key 409s before any second occupancy', () => {
    const reg = new DelegateResumeRegistry({ now: () => 10, nonce: () => 'bb' })
    const minted = reg.preflight({
      parentSessionKey: 'parent-a',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
    })
    assert.equal(minted.ok, true)
    if (!minted.ok) return
    const again = reg.preflight({
      resumeSessionKey: minted.sessionKey,
      parentSessionKey: 'parent-a',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
    })
    assert.equal(again.ok, false)
    if (again.ok) return
    assert.equal(again.httpStatus, 409)
    assert.equal(reg.reservedSize(), 1)
    reg.markRetiring(minted.sessionKey)
    const duringRetire = reg.preflight({
      resumeSessionKey: minted.sessionKey,
      parentSessionKey: 'parent-a',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
    })
    assert.equal(duringRetire.ok, false)
    if (duringRetire.ok) return
    assert.equal(duringRetire.httpStatus, 409)
  })

  it('TTL prune and cap eviction skip reserved keys and return evicted ids', () => {
    let now = 1000
    const ttlReg = new DelegateResumeRegistry({
      now: () => now,
      nonce: () => `n${now}`,
      ttlMs: 100,
      maxBindings: 8,
    })
    const a = ttlReg.preflight({
      parentSessionKey: 'p',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
    })
    assert.equal(a.ok, true)
    if (!a.ok) return
    ttlReg.release(a.sessionKey)
    now = 2000
    const b = ttlReg.preflight({
      parentSessionKey: 'p',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
    })
    assert.equal(b.ok, true)
    if (!b.ok) return
    assert.ok(b.evictedKeys.includes(a.sessionKey))
    assert.equal(ttlReg.get(a.sessionKey), undefined)
    assert.equal(ttlReg.size(), 1)

    now = 0
    const capReg = new DelegateResumeRegistry({
      now: () => now,
      nonce: () => `c${now}`,
      ttlMs: 10_000,
      maxBindings: 2,
    })
    const x = capReg.preflight({
      parentSessionKey: 'p',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
    })
    assert.equal(x.ok, true)
    if (!x.ok) return
    now = 1
    const y = capReg.preflight({
      parentSessionKey: 'p',
      targetAgentId: 'coding-assistant',
      sourceAgent: 'main',
    })
    assert.equal(y.ok, true)
    if (!y.ok) return
    assert.equal(capReg.isReserved(x.sessionKey), true)
    assert.equal(capReg.size(), 2)
    const zBusy = capReg.preflight({
      parentSessionKey: 'p',
      targetAgentId: 'explorer',
      sourceAgent: 'main',
    })
    assert.equal(zBusy.ok, false)
    if (zBusy.ok) return
    assert.equal(zBusy.httpStatus, 503)
    capReg.release(x.sessionKey)
    capReg.release(y.sessionKey)
    now = 2
    const z = capReg.preflight({
      parentSessionKey: 'p',
      targetAgentId: 'explorer',
      sourceAgent: 'main',
    })
    assert.equal(z.ok, true)
    if (!z.ok) return
    assert.equal(capReg.size(), 2)
    assert.ok(z.evictedKeys.includes(x.sessionKey))
    assert.equal(capReg.get(x.sessionKey), undefined)
    assert.ok(capReg.get(y.sessionKey))
  })

  it('abort drops occupancy and minted binding', () => {
    const reg = new DelegateResumeRegistry({ now: () => 1, nonce: () => 'cc' })
    const minted = reg.preflight({
      parentSessionKey: 'p',
      targetAgentId: 'auditor',
      sourceAgent: 'main',
    })
    assert.equal(minted.ok, true)
    if (!minted.ok) return
    reg.abort(minted.sessionKey, true)
    assert.equal(reg.size(), 0)
    assert.equal(reg.reservedSize(), 0)
  })
})
