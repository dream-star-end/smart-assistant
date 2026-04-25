/**
 * Unit tests for modules/broadcast.js (M5 / P1-7).
 *
 * Coverage:
 *   1. shouldAdoptTokenRefresh — full guard matrix (8 paths)
 *   2. publishLogout — BC available vs storage fallback
 *   3. publishTokenRefresh — userId guard + BC availability gate
 *   4. onAuthBroadcast — senderTabId self-suppression + storage event delivery
 *
 * Strategy: stub globalThis.BroadcastChannel / window / localStorage, then
 * fresh-import the module via Node `?cachebust=` ESM URL trick to reset its
 * module-level singletons (_bc / _handler / TAB_ID) per test.
 *
 * Run: npx tsx --test packages/web/__tests__/broadcastAuth.test.ts
 */
import * as assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'

const MODULE_PATH = resolve(import.meta.dirname, '..', 'public', 'modules', 'broadcast.js')
const MODULE_URL = pathToFileURL(MODULE_PATH).href

// Fresh import — `?t=...` busts Node's ESM loader cache so each test gets new
// module-level state (including a fresh TAB_ID). Without this, _bc / _handler
// would leak between tests.
async function freshImport() {
  return await import(`${MODULE_URL}?t=${Date.now()}_${Math.random()}`)
}

// ── globalThis stubs ──
type BcMessage = unknown
class StubBC {
  static instances: StubBC[] = []
  static throwOnConstruct = false
  name: string
  posted: BcMessage[] = []
  onmessage: ((ev: { data: unknown }) => void) | null = null
  closed = false
  constructor(name: string) {
    if (StubBC.throwOnConstruct) throw new Error('BC unavailable')
    this.name = name
    StubBC.instances.push(this)
  }
  postMessage(m: BcMessage) {
    this.posted.push(m)
  }
  close() {
    this.closed = true
  }
}

class StubStorage {
  store = new Map<string, string>()
  events: Array<{ key: string; newValue: string | null }> = []
  getItem(k: string) {
    return this.store.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.store.set(k, v)
    this.events.push({ key: k, newValue: v })
  }
  removeItem(k: string) {
    this.store.delete(k)
    this.events.push({ key: k, newValue: null })
  }
}

let _origBC: unknown
let _origWindow: unknown
let _origLocalStorage: unknown
let _winListeners: Map<string, Array<(ev: unknown) => void>>

function installStubs(opts: { bc: boolean }) {
  _origBC = (globalThis as Record<string, unknown>).BroadcastChannel
  _origWindow = (globalThis as Record<string, unknown>).window
  _origLocalStorage = (globalThis as Record<string, unknown>).localStorage
  StubBC.instances = []
  StubBC.throwOnConstruct = !opts.bc
  ;(globalThis as Record<string, unknown>).BroadcastChannel = opts.bc ? StubBC : undefined
  ;(globalThis as Record<string, unknown>).localStorage = new StubStorage()
  _winListeners = new Map()
  ;(globalThis as Record<string, unknown>).window = {
    addEventListener: (ev: string, cb: (e: unknown) => void) => {
      if (!_winListeners.has(ev)) _winListeners.set(ev, [])
      _winListeners.get(ev)!.push(cb)
    },
  }
}

function restoreStubs() {
  ;(globalThis as Record<string, unknown>).BroadcastChannel = _origBC
  ;(globalThis as Record<string, unknown>).window = _origWindow
  ;(globalThis as Record<string, unknown>).localStorage = _origLocalStorage
}

function fireStorageEvent(key: string, newValue: string | null) {
  const listeners = _winListeners.get('storage') || []
  for (const cb of listeners) cb({ key, newValue })
}

// ──────────────────────────────────────────────────────────────────────────
// 1. shouldAdoptTokenRefresh — guard matrix
// ──────────────────────────────────────────────────────────────────────────
describe('shouldAdoptTokenRefresh', () => {
  beforeEach(() => installStubs({ bc: true }))
  afterEach(() => restoreStubs())

  const baseState = () => ({ token: 'old-token', tokenExp: 1000, userId: '42' })
  const baseMsg = () => ({
    type: 'token_refresh',
    access_token: 'new-token',
    access_exp: 2000,
    userId: '42',
    remember: true,
  })

  it('happy path: same userId + newer exp + state.token non-empty → true', async () => {
    const { shouldAdoptTokenRefresh } = await freshImport()
    assert.equal(shouldAdoptTokenRefresh(baseState(), baseMsg()), true)
  })

  it('cross-identity (state.userId="10" vs msg.userId="20") → false', async () => {
    const { shouldAdoptTokenRefresh } = await freshImport()
    const s = baseState()
    s.userId = '10'
    const m = baseMsg()
    m.userId = '20'
    assert.equal(shouldAdoptTokenRefresh(s, m), false)
  })

  it('numeric vs string userId — strict equality after String()', async () => {
    const { shouldAdoptTokenRefresh } = await freshImport()
    const s = { ...baseState(), userId: 42 as unknown as string }
    const m = { ...baseMsg(), userId: '42' }
    assert.equal(shouldAdoptTokenRefresh(s, m), true)
  })

  it('state.userId == null (early /api/me race) → false', async () => {
    const { shouldAdoptTokenRefresh } = await freshImport()
    const s = baseState()
    s.userId = null as unknown as string
    assert.equal(shouldAdoptTokenRefresh(s, baseMsg()), false)
  })

  it('msg.userId missing → false', async () => {
    const { shouldAdoptTokenRefresh } = await freshImport()
    const m: { type: string; access_token: string; access_exp: number; userId?: string } = baseMsg()
    m.userId = undefined
    assert.equal(shouldAdoptTokenRefresh(baseState(), m), false)
  })

  it('state.token empty (already logged out) → false (no resurrection)', async () => {
    const { shouldAdoptTokenRefresh } = await freshImport()
    const s = baseState()
    s.token = ''
    assert.equal(shouldAdoptTokenRefresh(s, baseMsg()), false)
  })

  it('msg.access_exp <= state.tokenExp (stale broadcast) → false', async () => {
    const { shouldAdoptTokenRefresh } = await freshImport()
    const m = baseMsg()
    m.access_exp = 500 // older than state.tokenExp=1000
    assert.equal(shouldAdoptTokenRefresh(baseState(), m), false)
  })

  it('msg.access_exp == state.tokenExp (boundary) → false', async () => {
    const { shouldAdoptTokenRefresh } = await freshImport()
    const m = baseMsg()
    m.access_exp = 1000
    assert.equal(shouldAdoptTokenRefresh(baseState(), m), false)
  })

  it('msg.access_token non-string / empty → false', async () => {
    const { shouldAdoptTokenRefresh } = await freshImport()
    const m1 = { ...baseMsg(), access_token: '' }
    const m2 = { ...baseMsg(), access_token: 123 as unknown as string }
    assert.equal(shouldAdoptTokenRefresh(baseState(), m1), false)
    assert.equal(shouldAdoptTokenRefresh(baseState(), m2), false)
  })

  it('msg.access_exp non-finite (NaN/Infinity) → false', async () => {
    const { shouldAdoptTokenRefresh } = await freshImport()
    const m1 = { ...baseMsg(), access_exp: Number.NaN }
    const m2 = { ...baseMsg(), access_exp: Number.POSITIVE_INFINITY }
    assert.equal(shouldAdoptTokenRefresh(baseState(), m1), false)
    assert.equal(shouldAdoptTokenRefresh(baseState(), m2), false)
  })

  it('msg.type != "token_refresh" → false', async () => {
    const { shouldAdoptTokenRefresh } = await freshImport()
    const m = { ...baseMsg(), type: 'logout' }
    assert.equal(shouldAdoptTokenRefresh(baseState(), m), false)
  })

  it('null msg → false (no throw)', async () => {
    const { shouldAdoptTokenRefresh } = await freshImport()
    assert.equal(shouldAdoptTokenRefresh(baseState(), null), false)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 2. publishLogout
// ──────────────────────────────────────────────────────────────────────────
describe('publishLogout', () => {
  afterEach(() => restoreStubs())

  it('BC available → postMessage with type=logout + senderTabId + ts', async () => {
    installStubs({ bc: true })
    const { publishLogout } = await freshImport()
    publishLogout()
    assert.equal(StubBC.instances.length, 1)
    assert.equal(StubBC.instances[0].posted.length, 1)
    const msg = StubBC.instances[0].posted[0] as Record<string, unknown>
    assert.equal(msg.type, 'logout')
    assert.equal(typeof msg.senderTabId, 'string')
    assert.equal(typeof msg.ts, 'number')
  })

  it('BC unavailable → falls back to storage signal (set + remove)', async () => {
    installStubs({ bc: false })
    const { publishLogout } = await freshImport()
    publishLogout()
    const ls = (globalThis as Record<string, unknown>).localStorage as StubStorage
    // expect two events: setItem(KEY, ts) then removeItem(KEY)
    assert.equal(ls.events.length, 2)
    assert.equal(ls.events[0].key, 'oc_auth_logout_signal')
    assert.equal(typeof ls.events[0].newValue, 'string')
    assert.equal(ls.events[1].key, 'oc_auth_logout_signal')
    assert.equal(ls.events[1].newValue, null)
  })

  it('BC available → does NOT touch localStorage (no double-fire)', async () => {
    installStubs({ bc: true })
    const { publishLogout } = await freshImport()
    publishLogout()
    const ls = (globalThis as Record<string, unknown>).localStorage as StubStorage
    assert.equal(ls.events.length, 0)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 3. publishTokenRefresh
// ──────────────────────────────────────────────────────────────────────────
describe('publishTokenRefresh', () => {
  afterEach(() => restoreStubs())

  it('happy path: posts token_refresh with all fields incl. userId as string', async () => {
    installStubs({ bc: true })
    const { publishTokenRefresh } = await freshImport()
    publishTokenRefresh({
      access_token: 'tok',
      access_exp: 9999,
      remember: true,
      userId: 42, // numeric — should normalize to string
    })
    const msg = StubBC.instances[0].posted[0] as Record<string, unknown>
    assert.equal(msg.type, 'token_refresh')
    assert.equal(msg.access_token, 'tok')
    assert.equal(msg.access_exp, 9999)
    assert.equal(msg.remember, true)
    assert.equal(msg.userId, '42') // String() normalized
    assert.equal(typeof msg.senderTabId, 'string')
  })

  it('userId=null → skip (does NOT post)', async () => {
    installStubs({ bc: true })
    const { publishTokenRefresh } = await freshImport()
    publishTokenRefresh({
      access_token: 'tok',
      access_exp: 9999,
      remember: true,
      userId: null,
    })
    // BC channel must not have been opened (publish skips before _ensureChannel)
    assert.equal(StubBC.instances.length, 0)
  })

  it('userId=undefined → skip', async () => {
    installStubs({ bc: true })
    const { publishTokenRefresh } = await freshImport()
    publishTokenRefresh({
      access_token: 'tok',
      access_exp: 9999,
      remember: false,
      userId: undefined,
    })
    assert.equal(StubBC.instances.length, 0)
  })

  it('BC unavailable → skip (no storage fallback for token)', async () => {
    installStubs({ bc: false })
    const { publishTokenRefresh } = await freshImport()
    publishTokenRefresh({
      access_token: 'tok',
      access_exp: 9999,
      remember: true,
      userId: '42',
    })
    const ls = (globalThis as Record<string, unknown>).localStorage as StubStorage
    assert.equal(ls.events.length, 0) // no storage write — token never leaves memory
    assert.equal(StubBC.instances.length, 0)
  })

  it('remember=false propagates as false (not coerced to true)', async () => {
    installStubs({ bc: true })
    const { publishTokenRefresh } = await freshImport()
    publishTokenRefresh({
      access_token: 'tok',
      access_exp: 9999,
      remember: false,
      userId: '42',
    })
    const msg = StubBC.instances[0].posted[0] as Record<string, unknown>
    assert.equal(msg.remember, false)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 4. onAuthBroadcast
// ──────────────────────────────────────────────────────────────────────────
describe('onAuthBroadcast', () => {
  afterEach(() => restoreStubs())

  it('forwards messages from other tabs to handler', async () => {
    installStubs({ bc: true })
    const { onAuthBroadcast } = await freshImport()
    const received: unknown[] = []
    onAuthBroadcast((m: unknown) => received.push(m))
    const ch = StubBC.instances[0]
    ch.onmessage!({ data: { type: 'logout', senderTabId: 'OTHER_TAB', ts: 1 } })
    assert.equal(received.length, 1)
    assert.deepEqual(received[0], { type: 'logout', senderTabId: 'OTHER_TAB', ts: 1 })
  })

  it('suppresses self-broadcast (own senderTabId)', async () => {
    installStubs({ bc: true })
    const { onAuthBroadcast, publishLogout } = await freshImport()
    const received: unknown[] = []
    onAuthBroadcast((m: unknown) => received.push(m))
    publishLogout() // posts to ch.posted, but ch.onmessage isn't auto-called
    // simulate browser delivering own message back (defensive senderTabId check)
    const sentMsg = StubBC.instances[0].posted[0] as Record<string, unknown>
    StubBC.instances[0].onmessage!({ data: sentMsg })
    assert.equal(received.length, 0) // self-suppressed via senderTabId match
  })

  it('storage event delivers logout signal as synthesized msg', async () => {
    installStubs({ bc: true }) // even with BC, we listen storage for cross-fallback
    const { onAuthBroadcast } = await freshImport()
    const received: Array<{ type: string }> = []
    onAuthBroadcast((m: { type: string }) => received.push(m))
    fireStorageEvent('oc_auth_logout_signal', '12345')
    assert.equal(received.length, 1)
    assert.equal(received[0].type, 'logout')
  })

  it('storage event ignores unrelated keys', async () => {
    installStubs({ bc: true })
    const { onAuthBroadcast } = await freshImport()
    const received: unknown[] = []
    onAuthBroadcast((m: unknown) => received.push(m))
    fireStorageEvent('some_other_key', '12345')
    assert.equal(received.length, 0)
  })

  it('storage event ignores key removal (newValue=null)', async () => {
    installStubs({ bc: true })
    const { onAuthBroadcast } = await freshImport()
    const received: unknown[] = []
    onAuthBroadcast((m: unknown) => received.push(m))
    fireStorageEvent('oc_auth_logout_signal', null) // the cleanup remove
    assert.equal(received.length, 0)
  })

  it('handler throw is swallowed (does not break BC pipeline)', async () => {
    installStubs({ bc: true })
    const { onAuthBroadcast } = await freshImport()
    onAuthBroadcast(() => {
      throw new Error('handler bug')
    })
    // Should not throw
    StubBC.instances[0].onmessage!({
      data: { type: 'logout', senderTabId: 'OTHER', ts: 1 },
    })
  })

  it('non-object data is silently dropped', async () => {
    installStubs({ bc: true })
    const { onAuthBroadcast } = await freshImport()
    const received: unknown[] = []
    onAuthBroadcast((m: unknown) => received.push(m))
    StubBC.instances[0].onmessage!({ data: 'string-payload' })
    StubBC.instances[0].onmessage!({ data: null })
    assert.equal(received.length, 0)
  })
})
