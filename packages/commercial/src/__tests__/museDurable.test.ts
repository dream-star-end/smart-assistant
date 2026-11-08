// Lifecycle policy uses fake time; SQL fencing and actual message/billing dedupe are in integ.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { MuseBridgeHub, type MuseBridgeHubOptions, type MuseWireJob } from '../muse/hub.js'
import {
  MUSE_BACKGROUND_TTL_MS,
  MUSE_LEASE_MS,
  type MuseDurability,
  type MuseDurableState,
  type MuseFence,
} from '../muse/durable.js'
import type { MuseJobInsert, MuseJobFinish, MuseStore } from '../muse/store.js'

class Journal implements MuseStore, MuseDurability {
  now = 1000
  rows = new Map<string, MuseJobInsert & { status: string; lease: number; fin?: MuseJobFinish }>()
  delivered = new Set<string>()
  origin = new Map([['agent:main:webchat:dm:origin', '1']])
  deliveryOffline = false
  saveGate: Promise<void> | null = null
  async validateOrigin(user: string, key: string) {
    if (this.origin.get(key) !== user) throw new Error('MUSE_ORIGIN_INVALID')
    return { sessionId: 'origin', agentId: 'main' }
  }
  async insertJob(row: MuseJobInsert) {
    this.rows.set(row.id, {
      ...structuredClone(row),
      status: 'queued',
      lease: this.now + MUSE_LEASE_MS,
    })
  }
  check(id: string, fence?: MuseFence) {
    const row = this.rows.get(id)!
    if (
      fence &&
      (row.leaseOwner !== fence.owner ||
        row.durable?.nonce !== fence.nonce ||
        row.lease <= this.now)
    )
      throw new Error('fenced')
    return row
  }
  async markRunning(id: string, _credential: string, fence?: MuseFence) {
    this.check(id, fence).status = 'running'
  }
  async finishJob(id: string, fin: MuseJobFinish, fence?: MuseFence) {
    const row = this.check(id, fence)
    row.status = fin.status
    row.fin = fin
  }
  async save(id: string, owner: string, state: MuseDurableState) {
    if (this.saveGate) await this.saveGate
    const row = this.rows.get(id)!
    if (row.leaseOwner !== owner || row.lease <= this.now) throw new Error('fenced')
    row.durable = structuredClone(state)
    row.lease = this.now + MUSE_LEASE_MS
  }
  async claim(owner: string, limit: number, online: boolean) {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.durable &&
          (online ||
            !r.durable.background ||
            (r.durable.expiresAt > 0 && r.durable.expiresAt <= this.now)) &&
          ['queued', 'running'].includes(r.status) &&
          r.lease <= this.now,
      )
      .slice(0, limit)
      .map((r) => {
        r.leaseOwner = owner
        r.lease = this.now + MUSE_LEASE_MS
        return {
          id: r.id,
          userId: r.userId,
          containerId: r.containerId,
          price: String(r.priceCredits ?? 0),
          durable: structuredClone(r.durable!),
        }
      })
  }
  async release(id: string, owner: string) {
    const r = this.rows.get(id)!
    if (r.leaseOwner === owner) r.lease = this.now
  }
  async protectedFile(id: string) {
    return Boolean(this.rows.get(id)?.durable)
  }
  async deliver() {
    if (this.deliveryOffline) return
    for (const r of this.rows.values()) if (r.fin) this.delivered.add(r.id)
  }
  async findJob(user: string, id: string) {
    const r = this.rows.get(id)
    return r && r.userId === user
      ? {
          id,
          kind: r.kind,
          status: r.status as 'queued',
          errorCode: r.fin?.errorCode ?? null,
          files: r.fin?.files ?? null,
          snapshotId: null,
          debitedCredits: null,
          durable: r.durable,
        }
      : null
  }
  async countRecent() {
    return { hour: 0, day: 0 }
  }
  async countSiteToday() {
    return 0
  }
  async openCredits() {
    return 0n
  }
  async failOrphans() {
    return 0
  }
  async findCredential() {
    return { id: '1' }
  }
  async touchCredential() {}
}
const mp4 = Buffer.concat([Buffer.from('0000ftypisom'), Buffer.alloc(30)])
const digest = createHash('sha256').update(mp4).digest('hex')
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

describe('durable Muse video lifecycle', () => {
  let root: string
  let journal: Journal
  let hubs: MuseBridgeHub[]
  let keep: NodeJS.Timeout
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'muse-durable-'))
    journal = new Journal()
    hubs = []
    keep = setInterval(() => {}, 1000)
  })
  afterEach(async () => {
    for (const h of hubs) await h.stop()
    clearInterval(keep)
    await rm(root, { recursive: true, force: true })
  })
  const make = (opts: Partial<MuseBridgeHubOptions> = {}) => {
    const hub = new MuseBridgeHub({
      store: journal,
      durability: journal,
      stateRoot: root,
      allowedUids: 'all',
      rate: { imagePerHour: 50, imagePerDay: 100, videoPerHour: 50, videoPerDay: 100 },
      cliTimeoutSec: { image: 120, video: 300 },
      now: () => journal.now,
      ...opts,
    })
    hubs.push(hub)
    return hub
  }
  const submit = (hub: MuseBridgeHub) =>
    hub.submit(
      '1',
      '2',
      { kind: 'video', prompt: 'cat' },
      { sessionKey: 'agent:main:webchat:dm:origin' },
    )
  async function advance(hub: MuseBridgeHub, ms: number) {
    journal.now += ms
    hub.tick()
    await flush()
  }
  async function success(hub: MuseBridgeHub, job: MuseWireJob) {
    await hub.heartbeat(job.id, job.nonce)
    await hub.putChunk(job.id, job.nonce, 0, 0, mp4, digest)
    await hub.result(job.id, job.nonce, {
      ok: true,
      files: [{ idx: 0, chunks: 1, bytes: mp4.length, sha256: digest, mime: 'video/mp4' }],
    })
  }
  it('initial + three 40s retries then durable acknowledgment, offline waiting consumes no execution retries', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const hub = make()
    const id = await submit(hub)
    for (let i = 0; i < 3; i++) {
      await advance(hub, 40_000)
      t.mock.timers.tick(40_000)
      await flush()
    }
    const view = await hub.view('1', id, 0)
    assert.equal(view?.background, true)
    assert.equal(view?.status, 'queued')
    assert.equal(view?.retry_count, 3)
    for (let i = 0; i < 10; i++) await advance(hub, 40_000)
    assert.equal(journal.rows.get(id)?.durable?.backgroundFailures, 0)
    const sid = hub.hello('1', '0.5.0')
    await hub.durableTick()
    await flush()
    const job = (await hub.poll(sid, 1))!
    assert.ok(job)
    await success(hub, job)
    await hub.durableTick()
    assert.equal(journal.delivered.size, 1)
    await assert.rejects(hub.result(id, job.nonce, { ok: true }), /reassigned/)
    await hub.durableTick()
    assert.equal(journal.delivered.size, 1)
  })
  for (const background of [false, true]) {
    it(`two bridges: ${background ? 'background' : 'sync'} video survives one heartbeat loss with one origin callback`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const hub = make({ multiBridge: true, concurrency: 2, perBridgeConcurrency: 1 })
      let a: string
      let b: string
      if (!background) {
        a = hub.hello('1', '0.5.0')
        b = hub.hello('2', '0.5.0')
      }
      const id = await submit(hub)
      if (background) {
        for (let i = 0; i < 3; i++) await advance(hub, 40_000)
        a = hub.hello('1', '0.5.0')
        b = hub.hello('2', '0.5.0')
        await hub.durableTick()
        await flush()
      }
      const lost = (await hub.poll(a!, 1))!
      await hub.heartbeat(id, lost.nonce)
      for (let i = 0; i < 13; i++) {
        hub.checkSession(b!)
        await advance(hub, 10_000)
      }
      assert.equal(hub.bridgeOnline(), true)
      assert.equal(journal.rows.get(id)?.durable?.background, background)
      await assert.rejects(hub.result(id, lost.nonce, { ok: true }), /reassigned/)
      const next = hub.poll(b!, 60_000)
      await advance(hub, 40_000)
      const winner = (await next)!
      assert.equal(winner.id, id)
      assert.notEqual(winner.nonce, lost.nonce)
      await success(hub, winner)
      await hub.durableTick()
      await hub.durableTick()
      await assert.rejects(hub.result(id, winner.nonce, { ok: true }), /reassigned/)
      assert.equal(journal.rows.size, 1)
      assert.deepEqual([...journal.delivered], [id])
    })
  }

  it('restart preserves backoff due time and payload; old owner cannot claim or finish', async () => {
    const first = make()
    const id = await submit(first)
    const due = journal.rows.get(id)!.durable!.retryAt
    await first.stop()
    journal.now += MUSE_LEASE_MS + 1
    const second = make()
    await second.start()
    await second.durableTick()
    await flush()
    assert.equal(journal.rows.get(id)!.durable!.retryAt, due)
    const sid = second.hello('1', '0.5.0')
    second.tick()
    await flush()
    const job = (await second.poll(sid, 1))!
    assert.equal(job.prompt, 'cat')
    await success(second, job)
    assert.equal((await first.view('1', id, 0))?.status, 'succeeded')
    assert.equal(await second.view('other', id, 0), null)
  })
  it('in-flight restart and worker replacement invalidate earlier callbacks and count failures', async () => {
    const first = make()
    const sid = first.hello('1', '0.5.0')
    const id = await submit(first)
    const old = (await first.poll(sid, 1))!
    await first.heartbeat(id, old.nonce)
    await first.stop()
    journal.now += MUSE_LEASE_MS + 1
    const second = make()
    const sid2 = second.hello('1', '0.5.0')
    await second.start()
    await second.durableTick()
    await flush()
    assert.equal((await second.view('1', id, 0))?.retry_count, 1)
    await advance(second, 40_000)
    const next = (await second.poll(sid2, 1))!
    assert.notEqual(next.nonce, old.nonce)
    await second.heartbeat(id, next.nonce)
    const replacement = second.hello('1', '0.5.0')
    await flush()
    assert.equal((await second.view('1', id, 0))?.retry_count, 2)
    await assert.rejects(
      second.result(id, next.nonce, { ok: false, code: 'MUSE_BRIDGE_LOST' }),
      /reassigned/,
    )
    await advance(second, 40_000)
    await success(second, (await second.poll(replacement, 1))!)
  })
  it('does not expose background acknowledgment before persistence and rejects another origin owner', async () => {
    const hub = make()
    await assert.rejects(
      hub.submit(
        '2',
        '3',
        { kind: 'video', prompt: 'cat' },
        { sessionKey: 'agent:main:webchat:dm:origin' },
      ),
      /ORIGIN_INVALID/,
    )
    const id = await submit(hub)
    await advance(hub, 40_000)
    await advance(hub, 40_000)
    let release!: () => void
    journal.saveGate = new Promise<void>((r) => {
      release = r
    })
    await advance(hub, 40_000)
    let answered = false
    const view = hub.view('1', id, 0).then((v) => {
      answered = true
      return v
    })
    await flush()
    assert.equal(answered, false)
    release()
    assert.equal((await view)?.background, true)
  })
  it('background execution retries exhaust without H3 and delivery can retry after user leaves', async () => {
    const hub = make()
    const id = await submit(hub)
    for (let i = 0; i < 3; i++) await advance(hub, 40_000)
    const sid = hub.hello('1', '0.5.0')
    await hub.durableTick()
    await flush()
    journal.deliveryOffline = true
    for (let i = 0; i < 4; i++) {
      const job = (await hub.poll(sid, 1))!
      await hub.heartbeat(id, job.nonce)
      await hub.result(id, job.nonce, { ok: false, error_code: 'MUSE_BRIDGE_LOST' })
      await flush()
      if (i < 3) await advance(hub, 40_000)
    }
    assert.equal((await hub.view('1', id, 0))?.status, 'failed')
    await hub.durableTick()
    assert.equal(journal.delivered.size, 0)
    journal.deliveryOffline = false
    await hub.durableTick()
    await hub.durableTick()
    assert.equal(journal.delivered.size, 1)
  })
  it('expires background work without charging or falling back', async () => {
    const hub = make()
    const id = await submit(hub)
    for (let i = 0; i < 3; i++) await advance(hub, 40_000)
    // Jump near expiry while retaining a valid fake lease, then cross expiry.
    journal.now += MUSE_BACKGROUND_TTL_MS - 10
    journal.rows.get(id)!.lease = journal.now + MUSE_LEASE_MS
    await hub.stop()
    journal.rows.get(id)!.lease = journal.now - 1
    const next = make()
    await next.start()
    await flush()
    await advance(next, 11)
    await next.durableTick()
    await flush()
    assert.equal((await next.view('1', id, 0))?.error?.code, 'MUSE_QUEUE_EXPIRED')
  })
})
