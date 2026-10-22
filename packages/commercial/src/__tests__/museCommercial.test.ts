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
import { MuseError, parseAllowedUids } from '../muse/protocol.js'
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
    assert.deepEqual(store.orphanCalls[0], [1_800_000, []])
    hub.hello('1', null)
    const id = await hub.submit('120', null, { kind: 'image', prompt: 'p' })
    await hub.stop()
    assert.equal(store.rows.get(id)?.status, 'failed')
    assert.equal(store.rows.get(id)?.error, 'MUSE_MASTER_RESTARTED')
    assert.ok(hub.maxJobLifetimeMs() < 1_800_000, 'a live job is always younger than the grace')
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
})
