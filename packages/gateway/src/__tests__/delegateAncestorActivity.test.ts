/**
 * `_markDelegateAncestorActivity` must advance ancestor `lastActivityAt` AND
 * emit `activity` (so the 30-min fallback timer can `refresh()`), without
 * re-entering itself when those ancestor emits fire the child-activity
 * listener that production binds on every delegate runner.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateAncestorActivity.test.ts
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import { Gateway } from '../server.js'

function makeRunner(lastActivityAt = 1) {
  return Object.assign(new EventEmitter(), { lastActivityAt })
}

function makeSession(opts: {
  sessionKey: string
  parentSessionKey?: string
  lastActivityAt?: number
}) {
  return {
    sessionKey: opts.sessionKey,
    parentSessionKey: opts.parentSessionKey,
    runner: makeRunner(opts.lastActivityAt ?? 1),
  }
}

function makeGw(sessions: Record<string, ReturnType<typeof makeSession>>) {
  const gw = Object.create(Gateway.prototype) as any
  let getByKeyCalls = 0
  gw.sessions = {
    getByKey: (key: string) => {
      getByKeyCalls += 1
      return sessions[key]
    },
  }
  return {
    gw,
    getByKeyCalls: () => getByKeyCalls,
    mark: (key: string | undefined) => gw._markDelegateAncestorActivity(key),
  }
}

/** Mirrors server.ts `handleChildActivity`: child activity walks from the parent key. */
function bindChildActivity(gw: any, child: ReturnType<typeof makeSession>) {
  child.runner.on('activity', () => gw._markDelegateAncestorActivity(child.parentSessionKey))
}

describe('_markDelegateAncestorActivity — emit activity + reentrancy', () => {
  it('single ancestor: lastActivityAt advances and activity emits once', () => {
    const parent = makeSession({ sessionKey: 'parent' })
    const child = makeSession({ sessionKey: 'child', parentSessionKey: 'parent' })
    const { gw } = makeGw({ parent })
    bindChildActivity(gw, child)

    let parentEmits = 0
    parent.runner.on('activity', () => {
      parentEmits += 1
    })

    child.runner.emit('activity')
    assert.ok(parent.runner.lastActivityAt > 1, 'parent lastActivityAt must advance')
    assert.equal(parentEmits, 1, 'parent runner must receive exactly one activity event')
  })

  it('3-level chain: each ancestor advances and emits once; nested activity listeners do not re-walk', () => {
    const root = makeSession({ sessionKey: 'root' })
    const mid = makeSession({ sessionKey: 'mid', parentSessionKey: 'root' })
    const parent = makeSession({ sessionKey: 'parent', parentSessionKey: 'mid' })
    const child = makeSession({ sessionKey: 'child', parentSessionKey: 'parent' })
    const { gw, getByKeyCalls } = makeGw({ root, mid, parent })

    // Every delegate session binds the production listener, including ancestors
    // that are themselves someone else's delegate child.
    bindChildActivity(gw, child)
    bindChildActivity(gw, parent)
    bindChildActivity(gw, mid)

    const counts = { parent: 0, mid: 0, root: 0 }
    parent.runner.on('activity', () => {
      counts.parent += 1
    })
    mid.runner.on('activity', () => {
      counts.mid += 1
    })
    root.runner.on('activity', () => {
      counts.root += 1
    })

    child.runner.emit('activity')

    assert.ok(parent.runner.lastActivityAt > 1)
    assert.ok(mid.runner.lastActivityAt > 1)
    assert.ok(root.runner.lastActivityAt > 1)
    assert.equal(counts.parent, 1, 'each ancestor emits at most once')
    assert.equal(counts.mid, 1, 'each ancestor emits at most once')
    assert.equal(counts.root, 1, 'each ancestor emits at most once')
    // One walk, three in-memory ancestors. Reentrant emits must not restart.
    assert.equal(getByKeyCalls(), 3, 'chain must be walked once (not O(n²))')
  })

  it('cyclic parent pointers return without looping or throwing', () => {
    const a = makeSession({ sessionKey: 'A', parentSessionKey: 'B' })
    const b = makeSession({ sessionKey: 'B', parentSessionKey: 'A' })
    const { gw, getByKeyCalls } = makeGw({ A: a, B: b })
    bindChildActivity(gw, a)
    bindChildActivity(gw, b)

    const counts = { a: 0, b: 0 }
    a.runner.on('activity', () => {
      counts.a += 1
    })
    b.runner.on('activity', () => {
      counts.b += 1
    })

    assert.doesNotThrow(() => gw._markDelegateAncestorActivity('A'))
    assert.equal(counts.a, 1)
    assert.equal(counts.b, 1)
    assert.ok(a.runner.lastActivityAt > 1)
    assert.ok(b.runner.lastActivityAt > 1)
    assert.equal(getByKeyCalls(), 2, 'cycle must visit each node once')

    // A second external trigger still terminates.
    assert.doesNotThrow(() => gw._markDelegateAncestorActivity('B'))
    assert.equal(counts.a, 2)
    assert.equal(counts.b, 2)
  })

  it('self-parent session terminates after one visit', () => {
    const a = makeSession({ sessionKey: 'A', parentSessionKey: 'A' })
    const { gw, getByKeyCalls } = makeGw({ A: a })
    bindChildActivity(gw, a)

    let emits = 0
    a.runner.on('activity', () => {
      emits += 1
    })

    assert.doesNotThrow(() => gw._markDelegateAncestorActivity('A'))
    assert.equal(emits, 1)
    assert.equal(getByKeyCalls(), 1)
  })

  it('a throwing ancestor activity listener does not abort the rest of the chain', () => {
    const root = makeSession({ sessionKey: 'root' })
    const mid = makeSession({ sessionKey: 'mid', parentSessionKey: 'root' })
    const parent = makeSession({ sessionKey: 'parent', parentSessionKey: 'mid' })
    const { mark } = makeGw({ root, mid, parent })

    const seen: string[] = []
    parent.runner.on('activity', () => {
      seen.push('parent')
    })
    mid.runner.on('activity', () => {
      seen.push('mid')
      throw new Error('mid listener boom')
    })
    root.runner.on('activity', () => {
      seen.push('root')
    })

    assert.doesNotThrow(() => mark('parent'))
    assert.deepEqual(seen, ['parent', 'mid', 'root'])
    assert.ok(parent.runner.lastActivityAt > 1)
    assert.ok(mid.runner.lastActivityAt > 1)
    assert.ok(root.runner.lastActivityAt > 1)
  })

  it('lastActivityAt is only moved forward (Math.max)', () => {
    const future = Date.now() + 60_000
    const parent = makeSession({ sessionKey: 'parent', lastActivityAt: future })
    const { mark } = makeGw({ parent })
    mark('parent')
    assert.equal(parent.runner.lastActivityAt, future)
  })
})
