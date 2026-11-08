// Commercial Muse (OCV5-574): several bridge slots, per-account caps, per-kind queue waits, a site
// cap, open-to-all, credits charged only on success, and the A/B-slot orphan grace.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { MuseBilling, MuseSettleInput } from '../muse/billing.js'
import { MuseBridgeHub, type MuseBridgeHubOptions, type MuseWireJob } from '../muse/hub.js'
import { MUSE_RETRY_MAX, MUSE_RETRY_INTERVAL_MS, HEARTBEAT_LOST_MS, MuseError, parseAllowedUids } from '../muse/protocol.js'
import type { MuseJobFinish, MuseStore } from '../muse/store.js'

const WEBP = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'), Buffer.alloc(200, 7)])
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

type Row = {
  status: string
  error: string | null
  userId: string
  kind: 'image' | 'video'
  price: bigint
  files: Array<{ mime: string; bytes: number; sha256: string }> | null
  debited: string | null
}

class MemStore implements MuseStore {
  rows = new Map<string, Row>()
  /** Quotes of open jobs another process (the other A/B slot) holds. */
  otherSlotOpen = 0n
  finished: Array<[string, MuseJobFinish]> = []
  orphanCalls: Array<[number, string[]]> = []
  site = 0
  async insertJob(r: {
    id: string
    userId: string
    kind: 'image' | 'video'
    priceCredits?: bigint
  }) {
    this.rows.set(r.id, {
      status: 'queued',
      error: null,
      userId: r.userId,
      kind: r.kind,
      price: r.priceCredits ?? 0n,
      files: null,
      debited: null,
    })
  }
  async markRunning(id: string) {
    const r = this.rows.get(id)
    if (r) r.status = 'running'
  }
  async finishJob(id: string, fin: MuseJobFinish) {
    this.finished.push([id, fin])
    const r = this.rows.get(id)
    if (r && (r.status === 'queued' || r.status === 'running')) {
      Object.assign(r, { status: fin.status, error: fin.errorCode, files: fin.files })
    }
  }
  async countRecent() {
    return { hour: 0, day: 0 }
  }
  async countSiteToday() {
    return this.site
  }
  async failOrphans(graceMs: number, ownIds: readonly string[]) {
    this.orphanCalls.push([graceMs, [...ownIds]])
    return 0
  }
  async findJob(userId: string, id: string) {
    const r = this.rows.get(id)
    if (!r || r.userId !== userId) return null
    return {
      id,
      kind: r.kind,
      status: r.status as 'succeeded',
      errorCode: r.error,
      files: r.files,
      snapshotId: null,
      debitedCredits: r.debited,
    }
  }
  async openCredits(userId: string) {
    let sum = this.otherSlotOpen
    for (const r of this.rows.values()) {
      if (r.userId === userId && (r.status === 'queued' || r.status === 'running')) sum += r.price
    }
    return sum
  }
  async findCredential() {
    return { id: '1' }
  }
  async touchCredential() {}
}

class FakeBilling implements MuseBilling {
  constructor(private readonly store: MemStore) {}
  balance = new Map<string, bigint>()
  /** The transaction committed, then the call failed (a lost COMMIT reply). */
  commitThenFail = false
  outcomeError: Error | null = null
  settled: MuseSettleInput[] = []
  checks: Array<[string, bigint]> = []
  settleGate: Promise<void> | null = null
  settleError: Error | null = null
  settleStarted: () => void = () => {}
  price(kind: 'image' | 'video') {
    return kind === 'video' ? 50n : 10n
  }
  async ensureBalance(userId: string, required: bigint) {
    this.checks.push([userId, required])
    const have = this.balance.get(userId) ?? 1_000n
    if (have < required) {
      throw new MuseError(
        402,
        'MUSE_INSUFFICIENT_CREDITS',
        `insufficient credits: balance=${have} required=${required}`,
      )
    }
  }
  async settle(input: MuseSettleInput) {
    this.settleStarted()
    if (this.settleGate) await this.settleGate
    if (this.settleError) throw this.settleError
    this.settled.push(input)
    const row = this.store.rows.get(input.jobId)
    if (row)
      Object.assign(row, {
        status: 'succeeded',
        files: input.files,
        debited: input.price.toString(),
      })
    if (this.commitThenFail) throw new Error('Connection terminated unexpectedly')
    return { ledgerId: 77n, debitedCredits: input.price, clamped: false }
  }
  async outcome(jobId: string) {
    if (this.outcomeError) throw this.outcomeError
    const row = this.store.rows.get(jobId)
    const charged = row?.status === 'succeeded' && row.debited !== null
    return { charged, debitedCredits: charged ? BigInt(row!.debited!) : null }
  }
}

describe('commercial muse hub (OCV5-574)', () => {
  let root: string
  let store: MemStore
  let billing: FakeBilling
  let clock: { t: number }
  let hubs: MuseBridgeHub[]
  // The hub unrefs its poll timers; keep the loop alive while a test awaits one.
  let keepAlive: NodeJS.Timeout

  function makeHub(opts: Partial<MuseBridgeHubOptions> = {}) {
    const hub = new MuseBridgeHub({
      store,
      stateRoot: root,
      allowedUids: 'all',
      rate: { imagePerHour: 900, imagePerDay: 6000, videoPerHour: 300, videoPerDay: 1200 },
      cliTimeoutSec: { image: 120, video: 300 },
      concurrency: 3,
      queueMax: 50,
      queueWaitMs: { image: 600_000, video: 900_000 },
      billing,
      now: () => clock.t,
      ...opts,
    })
    hubs.push(hub)
    return hub
  }

  async function runToSuccess(hub: MuseBridgeHub, job: MuseWireJob) {
    hub.heartbeat(job.id, job.nonce)
    await hub.putChunk(job.id, job.nonce, 0, 0, WEBP, sha(WEBP))
    await hub.result(job.id, job.nonce, {
      ok: true,
      files: [
        {
          idx: 0,
          filename: 'x.webp',
          mime: 'image/webp',
          bytes: WEBP.length,
          sha256: sha(WEBP),
          chunks: 1,
        },
      ],
      meta: { snapshot_id: 'snap:1' },
    })
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'muse-commercial-'))
    store = new MemStore()
    billing = new FakeBilling(store)
    clock = { t: 1_000_000 }
    hubs = []
    keepAlive = setInterval(() => {}, 1000)
  })
  afterEach(async () => {
    clearInterval(keepAlive)
    for (const hub of hubs) await hub.stop()
    rmSync(root, { recursive: true, force: true })
  })

  it('multi-Muse enforces per-bridge, site and user caps without head-of-line poll blocking', async () => {
    const hub = makeHub({ multiBridge: true, concurrency: 2, perBridgeConcurrency: 1, userRunningMax: 1 })
    const a = hub.hello('1', '0.5.0')
    const b = hub.hello('2', '0.5.0')
    assert.equal(hub.checkSession(a, '1'), 'ok')
    assert.equal(hub.checkSession(a, '2'), 'unknown')
    assert.equal(hub.bridgeConcurrency(), 1)
    const one = await hub.submit('10', null, { kind: 'image', prompt: 'one' })
    const two = await hub.submit('10', null, { kind: 'image', prompt: 'two' })
    const first = (await hub.poll(a, 5))!
    assert.equal(first.id, one)
    const aBlocked = hub.poll(a, 1000)
    const bFree = hub.poll(b, 1000)
    const three = await hub.submit('11', null, { kind: 'image', prompt: 'three' })
    const next = (await bFree)!
    assert.equal(next.id, three, 'full A and capped user do not starve B')
    const c = hub.hello('3', '0.5.0')
    assert.equal(await hub.poll(c, 5), null, 'global cap still applies')
    await runToSuccess(hub, first)
    const pending = (await aBlocked)!
    assert.equal(pending.id, two)
    assert.equal(await hub.poll(a, 5), null)
    assert.equal(await hub.poll(b, 5), null)
    await runToSuccess(hub, next)
    await runToSuccess(hub, pending)
    assert.equal(billing.settled.length, 3)
  })

  it('same-token replacement only fences its own attempts and pending polls', async () => {
    const hub = makeHub({ multiBridge: true, perBridgeConcurrency: 1 })
    const a = hub.hello('1', '0.5.0')
    const b = hub.hello('2', '0.5.0')
    await hub.submit('10', null, { kind: 'image', prompt: 'one' })
    await hub.submit('11', null, { kind: 'image', prompt: 'two' })
    const first = (await hub.poll(a, 5))!
    const other = (await hub.poll(b, 5))!
    hub.heartbeat(first.id, first.nonce)
    hub.heartbeat(other.id, other.nonce)
    const waitingA = hub.poll(a, 1000)
    const waitingB = hub.poll(b, 1000)
    const replacement = hub.hello('1', '0.5.0')
    assert.equal(await waitingA, null)
    assert.equal(hub.checkSession(a), 'superseded')
    assert.equal(hub.checkSession(b), 'ok')
    assert.equal((await hub.view('11', other.id, 0))?.retry_count, 0)
    await assert.rejects(hub.result(first.id, first.nonce, { ok: true }), /reassigned/)
    await runToSuccess(hub, other)
    clock.t += MUSE_RETRY_INTERVAL_MS
    hub.checkSession(b)
    hub.tick()
    const reassigned = (await waitingB)!
    assert.equal(reassigned.id, first.id)
    assert.notEqual(reassigned.nonce, first.nonce)
    hub.undeliverable(first.id, first.nonce)
    hub.requireAssignment(first.id, reassigned.nonce, b)
    await runToSuccess(hub, reassigned)
    assert.equal(await hub.poll(replacement, 5), null)
    assert.equal(billing.settled.filter((x) => x.jobId === first.id).length, 1)
  })

  it('one bridge heartbeat timeout reassigns to a live peer after exactly 40s and bills once', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const hub = makeHub({ multiBridge: true, perBridgeConcurrency: 1 })
    const a = hub.hello('1', '0.5.0')
    const b = hub.hello('2', '0.5.0')
    const id = await hub.submit('10', null, { kind: 'image', prompt: 'one' })
    const lost = (await hub.poll(a, 5))!
    hub.heartbeat(id, lost.nonce)
    clock.t += HEARTBEAT_LOST_MS + 1
    hub.checkSession(b)
    hub.tick()
    assert.equal(hub.bridgeOnline(), true)
    assert.equal((await hub.view('10', id, 0))?.retry_count, 1)
    const next = hub.poll(b, 60_000)
    let dispatched = false
    void next.then(() => { dispatched = true })
    clock.t += 39_999
    t.mock.timers.tick(39_999)
    await Promise.resolve()
    assert.equal(dispatched, false)
    clock.t += 1
    hub.checkSession(b)
    t.mock.timers.tick(1)
    const winner = (await next)!
    assert.equal(winner.id, id)
    assert.notEqual(winner.nonce, lost.nonce)
    await assert.rejects(hub.result(id, lost.nonce, { ok: true }), /reassigned/)
    await runToSuccess(hub, winner)
    await assert.rejects(hub.result(id, winner.nonce, { ok: true }), /reassigned/)
    assert.equal(store.rows.size, 1)
    assert.equal(billing.settled.length, 1)
  })

  it('legacy polls do not consume a large-source job that a modern bridge can execute', async () => {
    const hub = makeHub({ multiBridge: true, perBridgeConcurrency: 1 })
    const modern = hub.hello('1', '0.5.0')
    const legacy = hub.hello('2', '0.3.0')
    const oldPoll = hub.poll(legacy, 10)
    const modernPoll = hub.poll(modern, 1000)
    const id = await hub.submit('10', null, {
      kind: 'image', prompt: 'large', source_images: [Buffer.alloc(600_000).toString('base64')],
    })
    const job = (await modernPoll)!
    assert.equal(job.id, id)
    assert.ok(job.source_refs)
    assert.equal(await oldPoll, null)
    assert.equal((await hub.view('10', id, 0))?.retry_count, 0)
  })

  it('opens to every account with the single token all (uid 4 included)', () => {
    assert.equal(parseAllowedUids(['all']), 'all')
    const hub = makeHub()
    for (const uid of ['1', '4', '247', '99999']) assert.equal(hub.isAllowed(uid), true, uid)
    assert.deepEqual([...(parseAllowedUids(['3', '4']) as Set<string>)], ['3'])
  })

  it('runs up to `concurrency` jobs at once and dispatches the next when a slot frees', async () => {
    const hub = makeHub()
    const sid = hub.hello('1', '0.4.0')
    for (const uid of ['10', '11', '12', '13'])
      await hub.submit(uid, null, { kind: 'image', prompt: uid })
    const got = await Promise.all([0, 1, 2].map(() => hub.poll(sid, 50)))
    assert.deepEqual(
      got.map((j) => j?.prompt),
      ['10', '11', '12'],
    )
    assert.equal(await hub.poll(sid, 30), null, 'the fourth waits for a free slot')
    const fourth = hub.poll(sid, 1000)
    await runToSuccess(hub, got[0]!)
    assert.equal((await fourth)?.prompt, '13')
  })

  it('tells the bridge how many slots to run', () => {
    assert.equal(makeHub().bridgeConcurrency(), 3)
    assert.equal(makeHub({ concurrency: undefined }).bridgeConcurrency(), 1)
  })

  it('caps running jobs per account and lets other accounts go ahead', async () => {
    const hub = makeHub({ userRunningMax: 1 })
    const sid = hub.hello('1', null)
    await hub.submit('20', null, { kind: 'image', prompt: 'a1' })
    await hub.submit('20', null, { kind: 'image', prompt: 'a2' })
    await hub.submit('21', null, { kind: 'image', prompt: 'b1' })
    const first = await hub.poll(sid, 50)
    const second = await hub.poll(sid, 50)
    assert.deepEqual([first?.prompt, second?.prompt], ['a1', 'b1'])
    assert.equal(await hub.poll(sid, 30), null, 'a2 waits for a1')
    const view = await hub.view('20', [...store.rows.keys()][1]!, 0)
    assert.equal(view?.status, 'queued')
    assert.equal(view?.queue_position, 1)
    assert.equal(view?.queue_length, 1)
  })

  it('caps queued + running jobs per account (MUSE_USER_BUSY, retryable)', async () => {
    const hub = makeHub({ userInflightMax: 2 })
    hub.hello('1', null)
    await hub.submit('30', null, { kind: 'image', prompt: 'x' })
    await hub.submit('30', null, { kind: 'video', prompt: 'y' })
    await assert.rejects(
      hub.submit('30', null, { kind: 'image', prompt: 'z' }),
      (e: unknown) =>
        e instanceof MuseError && e.code === 'MUSE_USER_BUSY' && e.status === 429 && e.retryable,
    )
    await hub.submit('31', null, { kind: 'image', prompt: 'other account' })
  })

  it('ends a queued job after its kind’s queue wait without charging it', async () => {
    const hub = makeHub({ concurrency: 1 })
    const sid = hub.hello('1', null)
    await hub.submit('40', null, { kind: 'image', prompt: 'runs' })
    const imageId = await hub.submit('41', null, { kind: 'image', prompt: 'waits' })
    const videoId = await hub.submit('42', null, { kind: 'video', prompt: 'waits longer' })
    const running = (await hub.poll(sid, 50))!
    clock.t += 601_000
    hub.checkSession(sid)
    hub.heartbeat(running.id, running.nonce)
    hub.tick()
    assert.equal((await hub.view('41', imageId, 0))?.error?.code, 'MUSE_BUSY')
    assert.equal((await hub.view('42', videoId, 0))?.status, 'queued', 'video waits up to 900 s')
    assert.deepEqual(billing.settled, [])
  })

  it('refuses a job the balance cannot cover together with the account’s other open jobs', async () => {
    const hub = makeHub()
    hub.hello('1', null)
    billing.balance.set('50', 59n)
    await hub.submit('50', null, { kind: 'video', prompt: 'v' })
    assert.deepEqual(billing.checks.at(-1), ['50', 50n])
    await assert.rejects(
      hub.submit('50', null, { kind: 'image', prompt: 'i' }),
      (e: unknown) =>
        e instanceof MuseError && e.code === 'MUSE_INSUFFICIENT_CREDITS' && e.status === 402,
    )
    assert.deepEqual(billing.checks.at(-1), ['50', 60n], 'image 10 + the open video 50 > 59')
    assert.equal(store.rows.size, 1, 'the refused job never reaches the database')
  })

  it('charges once, only for a succeeded job, and reports the charge', async () => {
    const hub = makeHub()
    const sid = hub.hello('1', null)
    const id = await hub.submit('60', null, { kind: 'image', prompt: 'p' })
    await runToSuccess(hub, (await hub.poll(sid, 50))!)
    assert.equal(billing.settled.length, 1)
    assert.equal(billing.settled[0]?.price, 10n)
    assert.equal(billing.settled[0]?.jobId, id)
    const view = await hub.view('60', id, 0)
    assert.equal(view?.status, 'succeeded')
    assert.equal(view?.charged_credits, '10')
  })

  it('never charges failed, cancelled or timed-out jobs', async () => {
    const hub = makeHub()
    const sid = hub.hello('1', null)
    await hub.submit('70', null, { kind: 'image', prompt: 'fails' })
    const cancelled = await hub.submit('71', null, { kind: 'video', prompt: 'cancelled' })
    await hub.submit('72', null, { kind: 'image', prompt: 'times out' })
    const [a, , c] = await Promise.all([0, 1, 2].map(() => hub.poll(sid, 50)))
    hub.heartbeat(a!.id, a!.nonce)
    await hub.result(a!.id, a!.nonce, { ok: false, error_code: 'MUSE_UPSTREAM_REJECTED' })
    hub.cancel('71', cancelled)
    hub.heartbeat(c!.id, c!.nonce)
    clock.t += 400_000
    hub.tick()
    assert.deepEqual(billing.settled, [])
  })

  it('a charged job is delivered: nothing else may finish it while it settles', async () => {
    const hub = makeHub()
    const sid = hub.hello('1', null)
    const id = await hub.submit('80', null, { kind: 'image', prompt: 'p' })
    const job = (await hub.poll(sid, 50))!
    let open!: () => void
    billing.settleGate = new Promise((r) => {
      open = r
    })
    const started = new Promise<void>((r) => {
      billing.settleStarted = r
    })
    hub.heartbeat(job.id, job.nonce)
    await hub.putChunk(job.id, job.nonce, 0, 0, WEBP, sha(WEBP))
    const result = hub.result(job.id, job.nonce, {
      ok: true,
      files: [
        {
          idx: 0,
          filename: 'x.webp',
          mime: 'image/webp',
          bytes: WEBP.length,
          sha256: sha(WEBP),
          chunks: 1,
        },
      ],
    })
    await started
    clock.t += 3_600_000
    hub.tick()
    hub.cancel('80', id)
    hub.hello('1', null)
    open()
    await result
    const view = await hub.view('80', id, 0)
    assert.equal(view?.status, 'succeeded')
    assert.equal(view?.charged_credits, '10')
  })

  it('a failed charge is neither delivered nor charged', async () => {
    const hub = makeHub()
    const sid = hub.hello('1', null)
    const id = await hub.submit('90', null, { kind: 'image', prompt: 'p' })
    billing.settleError = new Error('connection reset')
    await runToSuccess(hub, (await hub.poll(sid, 50))!)
    const view = await hub.view('90', id, 0)
    assert.equal(view?.status, 'failed')
    assert.equal(view?.error?.code, 'MUSE_BILLING_FAILED')
    assert.equal(await hub.fileFor('90', id, 0), null)
  })

  it('enforces the site daily cap per kind', async () => {
    const hub = makeHub({ globalPerDay: { video: 5 } })
    hub.hello('1', null)
    store.site = 4
    await hub.submit('100', null, { kind: 'video', prompt: 'fifth' })
    store.site = 5
    await assert.rejects(
      hub.submit('101', null, { kind: 'video', prompt: 'sixth' }),
      (e: unknown) => e instanceof MuseError && e.code === 'MUSE_DAILY_CAP',
    )
    await hub.submit('101', null, { kind: 'image', prompt: 'images have no cap' })
  })

  it('drops a poll whose client went away, so the job goes to a live poll', async () => {
    const hub = makeHub()
    const sid = hub.hello('1', null)
    const gone = new AbortController()
    const dead = hub.poll(sid, 5_000, gone.signal)
    gone.abort()
    assert.equal(await dead, null)
    const live = hub.poll(sid, 1_000)
    await hub.submit('110', null, { kind: 'image', prompt: 'p' })
    assert.equal((await live)?.prompt, 'p')
  })

  it('with an orphan grace, start removes only job directories older than any live job', async () => {
    const old = join(root, 'mj_00000000-0000-0000-0000-000000000001')
    const young = join(root, 'mj_00000000-0000-0000-0000-000000000002')
    mkdirSync(old)
    mkdirSync(young)
    const past = (Date.now() - 3 * 3_600_000) / 1000
    utimesSync(old, past, past)
    await makeHub({ orphanGraceMs: 1_800_000 }).start()
    assert.equal(existsSync(old), false)
    assert.equal(existsSync(young), true, 'may belong to the other slot')
  })

  it('with an orphan grace, start leaves younger rows (the other A/B slot) alone and stop closes its own', async () => {
    const hub = makeHub({ orphanGraceMs: 1_800_000 })
    await hub.start()
    assert.deepEqual(store.orphanCalls[0], [hub.maxJobLifetimeMs() + 60_000, []])
    hub.hello('1', null)
    const id = await hub.submit('120', null, { kind: 'image', prompt: 'p' })
    await hub.stop()
    assert.equal(store.rows.get(id)?.status, 'failed')
    assert.equal(store.rows.get(id)?.error, 'MUSE_MASTER_RESTARTED')
    assert.ok(hub.maxJobLifetimeMs() < store.orphanCalls[0]![0], 'retry lifetime fits the grace')
  })

  it('a settle that failed after its COMMIT is delivered as charged (the database is asked)', async () => {
    const hub = makeHub()
    const sid = hub.hello('1', null)
    const id = await hub.submit('130', null, { kind: 'video', prompt: 'p' })
    billing.commitThenFail = true
    const job = (await hub.poll(sid, 50))!
    hub.heartbeat(job.id, job.nonce)
    const MP4 = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypmp42'),
      Buffer.alloc(100),
    ])
    await hub.putChunk(job.id, job.nonce, 0, 0, MP4, sha(MP4))
    await hub.result(job.id, job.nonce, {
      ok: true,
      files: [
        {
          idx: 0,
          filename: 'x.mp4',
          mime: 'video/mp4',
          bytes: MP4.length,
          sha256: sha(MP4),
          chunks: 1,
        },
      ],
    })
    const view = await hub.view('130', id, 0)
    assert.equal(view?.status, 'succeeded')
    assert.equal(view?.charged_credits, '50')
    assert.ok(await hub.fileFor('130', id, 0), 'the charged file is still there')
  })

  it('when the settle outcome cannot be read, the job is delivered (never charged and dropped)', async () => {
    const hub = makeHub()
    const sid = hub.hello('1', null)
    const id = await hub.submit('140', null, { kind: 'image', prompt: 'p' })
    billing.settleError = new Error('connection reset')
    billing.outcomeError = new Error('database unreachable')
    await runToSuccess(hub, (await hub.poll(sid, 50))!)
    const view = await hub.view('140', id, 0)
    assert.equal(view?.status, 'succeeded')
    assert.equal(view?.charged_credits, undefined)
    assert.ok(await hub.fileFor('140', id, 0))
  })

  it('another process (restart, the other A/B slot) can show and serve a succeeded job', async () => {
    const first = makeHub({ orphanGraceMs: 1_800_000 })
    const sid = first.hello('1', null)
    const id = await first.submit('150', null, { kind: 'image', prompt: 'p' })
    await runToSuccess(first, (await first.poll(sid, 50))!)
    const second = makeHub({ orphanGraceMs: 1_800_000 })
    await second.start()
    const view = await second.view('150', id, 0)
    assert.equal(view?.status, 'succeeded')
    assert.equal(view?.files?.length, 1)
    assert.equal(view?.files?.[0]?.sha256, sha(WEBP))
    assert.equal(view?.charged_credits, '10')
    const file = await second.fileFor('150', id, 0)
    assert.ok(file && existsSync(file.path))
    assert.equal(await second.fileFor('151', id, 0), null, 'never for another account')
  })

  it('the balance check counts open jobs the other A/B slot recorded', async () => {
    const hub = makeHub()
    hub.hello('1', null)
    store.otherSlotOpen = 50n
    billing.balance.set('160', 50n)
    await assert.rejects(
      hub.submit('160', null, { kind: 'video', prompt: 'v' }),
      (e: unknown) => e instanceof MuseError && e.code === 'MUSE_INSUFFICIENT_CREDITS',
    )
    assert.deepEqual(billing.checks.at(-1), ['160', 100n], "this 50 + the other slot's open 50")
  })

  // t1654u: fake timers prove the delay, shared budget and single billing/delivery record.
  for (const kind of ['image', 'video'] as const) {
    it(`offline ${kind} dispatch retries after 40s and succeeds on the same billed row`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const hub = makeHub()
      const id = await hub.submit('120', null, { kind, prompt: 'p' })
      const sid = hub.hello('1', '0.5.1')
      let claimed = false
      const pending = hub.poll(sid, 50_000).then((j) => { claimed = true; return j! })
      clock.t += 39_999
      t.mock.timers.tick(39_999)
      await Promise.resolve()
      assert.equal(claimed, false)
      assert.equal(store.finished.length, 0)
      clock.t += 1
      t.mock.timers.tick(1)
      const job = await pending
      assert.equal(job.id, id)
      if (kind === 'image') await runToSuccess(hub, job)
      else {
        const bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(100)])
        hub.heartbeat(id, job.nonce)
        await hub.putChunk(id, job.nonce, 0, 0, bytes, sha(bytes))
        await hub.result(id, job.nonce, { ok: true, files: [
          { idx: 0, mime: 'video/mp4', bytes: bytes.length, sha256: sha(bytes), chunks: 1 },
        ] })
      }
      assert.equal((await hub.view('120', id, 0))?.status, 'succeeded')
      assert.equal(store.rows.size, 1)
      assert.equal(billing.checks.length, 1)
      assert.equal(billing.settled.length, 1)
      assert.equal(billing.settled[0]!.jobId, id)
      assert.equal(billing.settled[0]!.price, kind === 'image' ? 10n : 50n)
    })
  }

  for (const cause of ['reconnect', 'heartbeat', 'ack', 'reported'] as const) {
    it(`${cause} retries with a fresh nonce; late results cannot bill or deliver twice`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      const hub = makeHub()
      let sid = hub.hello('1', '0.5.1')
      const id = await hub.submit('120', null, { kind: 'image', prompt: 'p' })
      const first = (await hub.poll(sid, 1))!
      if (cause !== 'ack') {
        hub.heartbeat(id, first.nonce)
        await hub.putChunk(id, first.nonce, 0, 0, WEBP, sha(WEBP))
      }
      if (cause === 'reconnect') sid = hub.hello('2', '0.5.1')
      if (cause === 'heartbeat' || cause === 'ack') {
        clock.t += cause === 'ack' ? 20_001 : HEARTBEAT_LOST_MS + 1
        hub.checkSession(sid)
        hub.tick()
      }
      if (cause === 'reported') await hub.result(id, first.nonce, {
        ok: false, error_code: 'MUSE_UPSTREAM_ERROR', retryable: false,
      })
      assert.equal((await hub.view('120', id, 0))?.status, 'queued')
      const late = () => hub.result(id, first.nonce, { ok: true })
      await assert.rejects(late, (e: MuseError) => e.code === 'JOB_GONE')
      let claimed = false
      const pending = hub.poll(sid, 50_000).then((j) => { claimed = true; return j! })
      clock.t += MUSE_RETRY_INTERVAL_MS - 1
      t.mock.timers.tick(MUSE_RETRY_INTERVAL_MS - 1)
      await Promise.resolve()
      assert.equal(claimed, false)
      clock.t += 1
      t.mock.timers.tick(1)
      const next = await pending
      assert.notEqual(next.nonce, first.nonce)
      await assert.rejects(late, (e: MuseError) => e.code === 'JOB_GONE')
      await runToSuccess(hub, next)
      await assert.rejects(late, (e: MuseError) => e.code === 'JOB_GONE')
      await assert.rejects(hub.result(id, next.nonce, { ok: true }), (e: MuseError) => e.code === 'JOB_GONE')
      assert.equal(billing.settled.length, 1)
      assert.equal(store.finished.filter(([, f]) => f.status === 'succeeded').length, 1)
      assert.equal(store.rows.size, 1)
    })
  }

  it('initial failure plus three failed retries exposes the original failure path only at exhaustion', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const hub = makeHub()
    const sid = hub.hello('1', '0.5.1')
    const id = await hub.submit('120', null, { kind: 'image', prompt: 'p' })
    for (let attempt = 0; attempt <= MUSE_RETRY_MAX; attempt++) {
      hub.checkSession(sid)
      const job = (await hub.poll(sid, 1))!
      hub.heartbeat(id, job.nonce)
      await hub.result(id, job.nonce, { ok: false, error_code: 'MUSE_UPSTREAM_ERROR', upstream_error_code: 'TEMPORARY' })
      if (attempt < MUSE_RETRY_MAX) {
        assert.equal((await hub.view('120', id, 0))?.status, 'queued')
        assert.equal(store.finished.length, 0, 'caller must not receive terminal failure early')
        clock.t += MUSE_RETRY_INTERVAL_MS
        t.mock.timers.tick(MUSE_RETRY_INTERVAL_MS)
      }
    }
    const view = await hub.view('120', id, 0)
    assert.equal(view?.status, 'failed')
    assert.equal(view?.error?.code, 'MUSE_UPSTREAM_ERROR')
    assert.equal(view?.error?.upstream_error_code, 'TEMPORARY')
    assert.equal(store.finished.length, 1)
    assert.equal(billing.settled.length, 0)
    assert.equal(store.rows.size, 1)
  })

  it('offline retries exhaust at 120s, retain admission limits, and never bill', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const hub = makeHub({ userInflightMax: 1 })
    const id = await hub.submit('120', null, { kind: 'image', prompt: 'p' })
    await assert.rejects(hub.submit('120', null, { kind: 'image', prompt: 'q' }), (e: MuseError) => e.code === 'MUSE_USER_BUSY')
    for (let i = 0; i < MUSE_RETRY_MAX; i++) {
      assert.equal((await hub.view('120', id, 0))?.status, 'queued')
      clock.t += MUSE_RETRY_INTERVAL_MS
      t.mock.timers.tick(MUSE_RETRY_INTERVAL_MS)
    }
    assert.equal((await hub.view('120', id, 0))?.error?.code, 'MUSE_BRIDGE_OFFLINE')
    assert.equal(billing.settled.length, 0)
  })

  it('cancellation and shutdown clear pending retries', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const hub = makeHub()
    const a = await hub.submit('120', null, { kind: 'image', prompt: 'p' })
    const b = await hub.submit('121', null, { kind: 'image', prompt: 'q' })
    hub.cancel('120', a)
    await hub.stop()
    clock.t += 120_000
    t.mock.timers.tick(120_000)
    assert.equal((await hub.view('120', a, 0))?.status, 'cancelled')
    assert.equal((await hub.view('121', b, 0))?.error?.code, 'MUSE_MASTER_RESTARTED')
    assert.equal(store.finished.length, 2)
    assert.equal(billing.settled.length, 0)
  })

  for (const code of ['MUSE_INVALID_INPUT', 'MUSE_UPSTREAM_REJECTED', 'MUSE_VIDEO_REGION_BLOCKED', 'MUSE_CANCELLED']) {
    it(`${code} skips retries even when the bridge marks it retryable`, async () => {
      const hub = makeHub()
      const sid = hub.hello('1', '0.5.1')
      const id = await hub.submit('120', null, { kind: 'image', prompt: 'p' })
      const job = (await hub.poll(sid, 1))!
      hub.heartbeat(id, job.nonce)
      await hub.result(id, job.nonce, { ok: false, error_code: code, retryable: true })
      assert.equal((await hub.view('120', id, 0))?.error?.code, code)
      assert.equal((await hub.view('120', id, 0))?.retry_count, 0)
      assert.equal(billing.settled.length, 0)
    })
  }


  it('a long video attempt does not spend its execution time out of the queue wait limit', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const hub = makeHub({ queueWaitMs: { image: 60_000, video: 60_000 } })
    const sid = hub.hello('1', '0.5.1')
    const id = await hub.submit('120', null, { kind: 'video', prompt: 'p' })
    const first = (await hub.poll(sid, 1))!
    hub.heartbeat(id, first.nonce)
    clock.t += 300_000
    hub.checkSession(sid)
    await hub.result(id, first.nonce, { ok: false, error_code: 'MUSE_TIMEOUT' })
    hub.tick()
    assert.equal((await hub.view('120', id, 0))?.status, 'queued')
    clock.t += 40_000
    t.mock.timers.tick(40_000)
    const next = (await hub.poll(sid, 1))!
    assert.equal(next.id, id)
    hub.heartbeat(id, next.nonce)
    await hub.result(id, next.nonce, { ok: false, error_code: 'MUSE_TIMEOUT' })
    clock.t += 20_001
    hub.tick()
    assert.equal((await hub.view('120', id, 0))?.error?.code, 'MUSE_BUSY', 'cumulative waiting still respects the original limit')
  })

  it('a chunk already writing during reconnect cannot corrupt the replacement attempt', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const hub = makeHub()
    const sid = hub.hello('1', '0.5.1')
    const id = await hub.submit('120', null, { kind: 'image', prompt: 'p' })
    const first = (await hub.poll(sid, 1))!
    hub.heartbeat(id, first.nonce)
    const writing = hub.putChunk(id, first.nonce, 0, 0, WEBP, sha(WEBP))
    const nextSid = hub.hello('2', '0.5.1')
    await assert.rejects(writing)
    clock.t += 40_000
    t.mock.timers.tick(40_000)
    const next = (await hub.poll(nextSid, 1))!
    await runToSuccess(hub, next)
    assert.equal((await hub.view('120', id, 0))?.status, 'succeeded')
    assert.equal(billing.settled.length, 1)
  })

  it('a success being verified wins a concurrent reconnect exactly once', async () => {
    const hub = makeHub()
    const sid = hub.hello('1', '0.5.1')
    const id = await hub.submit('120', null, { kind: 'image', prompt: 'p' })
    const job = (await hub.poll(sid, 1))!
    hub.heartbeat(id, job.nonce)
    await hub.putChunk(id, job.nonce, 0, 0, WEBP, sha(WEBP))
    const result = hub.result(id, job.nonce, { ok: true, files: [
      { idx: 0, mime: 'image/webp', bytes: WEBP.length, sha256: sha(WEBP), chunks: 1 },
    ] })
    hub.hello('2', '0.5.1')
    await result
    assert.equal((await hub.view('120', id, 0))?.status, 'succeeded')
    assert.equal((await hub.view('120', id, 0))?.retry_count, 0)
    assert.equal(billing.settled.length, 1)
  })

})
