import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { RedisSessionBus, type RedisFrameEnvelope, validateReplay } from '../redisSessionBus.js'

const frameData = (seq: number) =>
  JSON.stringify({
    type: 'outbound.message',
    sessionKey: 's1',
    channel: 'webchat',
    peer: { id: 'p1', kind: 'dm' },
    frameSeq: seq,
  })

function env(seq: number, originId = 'other'): RedisFrameEnvelope {
  return {
    originId,
    sessionKey: 's1',
    peerKey: 'default:webchat:p1',
    frameSeq: seq,
    ts: 1000 + seq,
    data: frameData(seq),
  }
}

describe('validateReplay', () => {
  it('requires a continuous replay window after the client cursor', () => {
    const ok = validateReplay([env(1), env(2), env(3)], 1)
    assert.equal(ok.ok, true)
    if (!ok.ok) return
    assert.deepEqual(
      ok.frames.map((f) => f.seq),
      [2, 3],
    )
    assert.equal(ok.to, 3)
  })

  it('misses when Redis trim removed the first needed frame', () => {
    const miss = validateReplay([env(5), env(6)], 2)
    assert.equal(miss.ok, false)
    if (miss.ok) return
    assert.equal(miss.reason, 'buffer_miss')
  })

  it('misses on duplicate seq instead of silently replaying ambiguous frames', () => {
    const miss = validateReplay([env(1), env(2), env(2)], 0)
    assert.equal(miss.ok, false)
    if (miss.ok) return
    assert.equal(miss.reason, 'sequence_mismatch')
  })

  it('drops envelopes whose wire frame disagrees with the envelope cursor', () => {
    const bad = { ...env(2), data: frameData(99) }
    const replay = validateReplay([env(1), bad, env(3)], 0)
    assert.equal(replay.ok, false)
    if (replay.ok) return
    assert.equal(replay.reason, 'sequence_mismatch')
  })
})

describe('RedisSessionBus', () => {
  it('disabled bus does not connect and returns null seq', async () => {
    let created = 0
    const bus = new RedisSessionBus({
      config: { enabled: false },
      createClient: () => {
        created++
        return {}
      },
    })
    await bus.start(() => {})
    assert.equal(created, 0)
    assert.equal(await bus.reserveFrameSeq('s1'), null)
  })

  it('uses prefix-scoped channel, ignores same origin, and handles external frames', async () => {
    const broker = createFakeRedisBroker()
    const received: RedisFrameEnvelope[] = []
    const bus = new RedisSessionBus({
      config: { enabled: true, keyPrefix: 'testprefix' },
      originId: 'origin-a',
      createClient: broker.createClient,
    })
    await bus.start((frame) => received.push(frame))

    assert.equal(broker.channels.has('testprefix:frames'), true)
    await broker.publish('testprefix:frames', JSON.stringify(env(1, 'origin-a')))
    assert.equal(received.length, 0, 'self-origin frames must not rebroadcast to local clients')

    await broker.publish('testprefix:frames', JSON.stringify(env(2, 'origin-b')))
    assert.equal(received.length, 1)
    assert.equal(received[0].frameSeq, 2)
    await bus.close()
  })

  it('reserves redis-global seq and replays only continuous cached frames', async () => {
    const broker = createFakeRedisBroker()
    const bus = new RedisSessionBus({
      config: { enabled: true, keyPrefix: 'testprefix', maxReplayFrames: 5 },
      originId: 'origin-a',
      createClient: broker.createClient,
    })
    await bus.start(() => {})

    assert.equal(await bus.reserveFrameSeq('s1'), 1)
    assert.equal(await bus.reserveFrameSeq('s1'), 2)
    assert.equal(await bus.advanceFrameSeq('s1', 2, 10), 11)
    bus.publishFrame({
      sessionKey: 's1',
      peerKey: 'default:webchat:p1',
      frameSeq: 1,
      ts: 1001,
      data: frameData(1),
    })
    bus.publishFrame({
      sessionKey: 's1',
      peerKey: 'default:webchat:p1',
      frameSeq: 2,
      ts: 1002,
      data: frameData(2),
    })
    await Promise.resolve()

    const replay = await bus.replay('s1', 0)
    assert.equal(replay.ok, true)
    if (!replay.ok) return
    assert.deepEqual(
      replay.frames.map((f) => f.seq),
      [1, 2],
    )
    await bus.close()
  })

  it('caches client session lists and validates user-scoped envelopes', async () => {
    const broker = createFakeRedisBroker()
    const bus = new RedisSessionBus({
      config: {
        enabled: true,
        keyPrefix: 'testprefix',
        sessionCacheTtlMs: 10_000,
      },
      createClient: broker.createClient,
    })
    await bus.start(() => {})
    const list = [
      {
        id: 'sess-1',
        agentId: 'main',
        title: 'T',
        pinned: false,
        createdAt: 1,
        lastAt: 2,
        messageCount: 3,
        updatedAt: 4,
      },
    ]
    bus.setSessionList('user-A', list)
    await Promise.resolve()

    assert.deepEqual(await bus.getSessionList('user-A'), list)
    assert.equal(await bus.getSessionList('user-B'), null)

    await bus.close()
  })

  it('caches full client sessions, skips oversized snapshots, and invalidates', async () => {
    const broker = createFakeRedisBroker()
    const bus = new RedisSessionBus({
      config: {
        enabled: true,
        keyPrefix: 'testprefix',
        maxSessionSnapshotBytes: 1024,
      },
      createClient: broker.createClient,
    })
    await bus.start(() => {})
    const session = {
      id: 'sess-1',
      userId: 'user-A',
      agentId: 'main',
      title: 'T',
      pinned: false,
      createdAt: 1,
      lastAt: 2,
      messages: [{ id: 'm1', role: 'user', text: 'hi' }],
      updatedAt: 4,
    }
    bus.setClientSession('user-A', session)
    await Promise.resolve()
    assert.deepEqual(await bus.getClientSession('user-A', 'sess-1'), session)
    assert.equal(await bus.getClientSession('user-B', 'sess-1'), null)

    bus.invalidateClientSession('user-A', 'sess-1')
    await Promise.resolve()
    assert.equal(await bus.getClientSession('user-A', 'sess-1'), null)

    bus.setClientSession('user-A', {
      ...session,
      id: 'big',
      messages: [{ text: 'x'.repeat(2000) }],
    })
    await Promise.resolve()
    assert.equal(await bus.getClientSession('user-A', 'big'), null)
    await bus.close()
  })

  it('clears client session cache keys without touching frame replay keys', async () => {
    const broker = createFakeRedisBroker()
    const bus = new RedisSessionBus({
      config: { enabled: true, keyPrefix: 'testprefix' },
      createClient: broker.createClient,
    })
    await bus.start(() => {})
    bus.setSessionList('user-A', [])
    bus.publishFrame({
      sessionKey: 's1',
      peerKey: 'default:webchat:p1',
      frameSeq: 1,
      ts: 1001,
      data: frameData(1),
    })
    await Promise.resolve()
    bus.clearClientSessionCache()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(await bus.getSessionList('user-A'), null)
    const replay = await bus.replay('s1', 0)
    assert.equal(replay.ok, true)
    if (!replay.ok) return
    assert.equal(replay.frames.length, 1)
    await bus.close()
  })

  it('treats runtime Redis command failures as cache misses, not thrown errors', async () => {
    const bus = new RedisSessionBus({
      config: { enabled: true, keyPrefix: 'testprefix', reserveTimeoutMs: 5 },
      createClient: () => ({
        isOpen: true,
        on() {},
        async connect() {},
        async quit() {},
        async subscribe() {},
        async incr() {
          throw new Error('redis down')
        },
        async lRange() {
          throw new Error('redis down')
        },
      }),
    })
    await bus.start(() => {})
    assert.equal(await bus.reserveFrameSeq('s1'), null)
    const replay = await bus.replay('s1', 1)
    assert.equal(replay.ok, false)
    if (replay.ok) return
    assert.equal(replay.reason, 'disabled')
    await bus.close()
  })
})

function createFakeRedisBroker() {
  const lists = new Map<string, string[]>()
  const counters = new Map<string, number>()
  const channels = new Map<string, (message: string) => void>()
  const strings = new Map<string, string>()
  const createClient = () => ({
    isOpen: true,
    on() {},
    async connect() {},
    async quit() {
      this.isOpen = false
    },
    async disconnect() {
      this.isOpen = false
    },
    async subscribe(channel: string, cb: (message: string) => void) {
      channels.set(channel, cb)
    },
    async publish(channel: string, message: string) {
      channels.get(channel)?.(message)
    },
    async incr(key: string) {
      const next = (counters.get(key) ?? 0) + 1
      counters.set(key, next)
      return next
    },
    async incrBy(key: string, delta: number) {
      const next = (counters.get(key) ?? 0) + delta
      counters.set(key, next)
      return next
    },
    async pExpire() {},
    async pSetEx(key: string, _ttlMs: number, value: string) {
      strings.set(key, value)
    },
    async get(key: string) {
      return strings.get(key) ?? null
    },
    async del(keys: string[] | string) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        strings.delete(key)
        lists.delete(key)
      }
    },
    async *scanIterator(opts: { MATCH?: string } = {}) {
      const prefix = opts.MATCH?.endsWith('*') ? opts.MATCH.slice(0, -1) : opts.MATCH
      for (const key of [...strings.keys(), ...lists.keys()]) {
        if (!prefix || key.startsWith(prefix)) yield key
      }
    },
    async rPush(key: string, value: string) {
      const list = lists.get(key) ?? []
      list.push(value)
      lists.set(key, list)
    },
    async lTrim(key: string, start: number, end: number) {
      const list = lists.get(key) ?? []
      const normalizedStart = start < 0 ? Math.max(0, list.length + start) : start
      const normalizedEnd = end < 0 ? list.length + end : end
      lists.set(key, list.slice(normalizedStart, normalizedEnd + 1))
    },
    async lRange(key: string) {
      return [...(lists.get(key) ?? [])]
    },
  })
  return {
    channels,
    createClient,
    publish: async (channel: string, message: string) => channels.get(channel)?.(message),
  }
}
