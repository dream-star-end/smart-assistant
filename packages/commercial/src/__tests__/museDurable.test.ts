// Lifecycle policy uses fake time; SQL fencing and actual message/billing dedupe are in integ.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test'
import type { Pool } from 'pg'
import { hashSecret } from '../auth/containerIdentity.js'
import { makeMuseInternalHandler } from '../muse/internalHttp.js'
import { MUSE_INTERNAL_PREFIX, parseSubmission } from '../muse/protocol.js'
import { MuseBridgeHub, type MuseBridgeHubOptions, type MuseWireJob } from '../muse/hub.js'
import {
  createMuseDurability,
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
  async function internalServer(hub: MuseBridgeHub, t: TestContext) {
    const secret = 'b'.repeat(64)
    const handler = makeMuseInternalHandler({
      hub,
      identityRepo: {
        async findActiveByHostAndBoundIp() {
          return { id: 2, user_id: 1, bound_ip: '10.0.0.2', host_uuid: 'test', secret_hash: hashSecret(secret) }
        },
      },
    })
    const server = createServer((req, res) => void handler(req, res, { hostUuid: 'test', boundIp: '10.0.0.2' }))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    t.after(async () => {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    })
    return {
      base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: `oc-v3.2.${secret}`,
    }
  }

  it('INC-20261109-MUSE-ORIGIN-SCHEMA: explicit metadata stays strict and out of the bridge spec', () => {
    const body = { kind: 'video', prompt: 'cat', session_key: 'agent:main:webchat:dm:origin' }
    assert.deepEqual(parseSubmission(body), { kind: 'video', prompt: 'cat' })
    for (const session_key of ['', '   ', null, 4, {}, 'x'.repeat(513)]) {
      assert.throws(() => parseSubmission({ ...body, session_key }), /invalid session_key/)
    }
    assert.throws(() => parseSubmission({ ...body, arbitrary_unknown: true }), /Unrecognized key/)
  })

  it('INC-20261109-MUSE-ORIGIN-SCHEMA: HTTP reaches real origin ownership gate before insertion', async (t) => {
    const originChecks: Array<[string, string]> = []
    // Real production origin parser/owner gate; only session storage is substituted.
    const origin = createMuseDurability({} as Pool, async () => {}, async (id, owner) => {
      originChecks.push([id, owner])
      return id === 'origin' && owner === 'c:1'
    })
    journal.validateOrigin = origin.validateOrigin
    const hub = make()
    const { base, token } = await internalServer(hub, t)
    const post = (body: unknown) => fetch(`${base}${MUSE_INTERNAL_PREFIX}/jobs`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    for (const [extra, expected] of [
      [{}, 400], [{ session_key: '' }, 400], [{ session_key: 5 }, 400],
      [{ session_key: 'agent:main:telegram:dm:origin' }, 400],
      [{ session_key: 'agent:main:webchat:dm:other-user-session' }, 403],
      [{ session_key: 'agent:main:webchat:dm:origin', unexpected: 1 }, 400],
    ] as const) {
      const res = await post({ kind: 'video', prompt: 'cat', ...extra })
      assert.equal(res.status, expected, await res.text())
      assert.equal(journal.rows.size, 0, 'rejected input must not create a billable job')
    }
    const res = await post({ kind: 'video', prompt: 'cat', session_key: 'agent:main:webchat:dm:origin' })
    assert.equal(res.status, 202)
    const { job_id: id } = await res.json() as { job_id: string }
    assert.equal(journal.rows.size, 1)
    assert.deepEqual(originChecks.at(-1), ['origin', 'c:1'])
    assert.equal(journal.rows.get(id)?.durable?.sessionId, 'origin')
    assert.equal(journal.rows.get(id)?.durable?.agentId, 'main')
    assert.equal('session_key' in journal.rows.get(id)!.durable!.spec, false)
  })

  it('INC-20261109-MUSE-ORIGIN-SCHEMA: real oc-muse video submits origin and acknowledges one conversation result', async (t) => {
    const hub = make()
    const sid = hub.hello('1', '0.5.3')
    const { base, token } = await internalServer(hub, t)
    const cli = fileURLToPath(new URL('../../agent-sandbox/platform-runtime/bin/oc-muse.py', import.meta.url))
    const child = spawn('python3', ['-I', cli, 'video', 'cat', '--json'], {
      env: { PATH: process.env.PATH, HOME: root, OPENCLAUDE_V3_MASTER_BASE_URL: base,
        OPENCLAUDE_V3_CONTAINER_TOKEN: token, OPENCLAUDE_SESSION_KEY: 'agent:main:webchat:dm:origin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (x) => { stdout += x })
    child.stderr.on('data', (x) => { stderr += x })
    const done = new Promise<number | null>((resolve) => child.on('close', resolve))
    const deadline = setTimeout(() => child.kill('SIGKILL'), 20_000)
    t.after(() => { clearTimeout(deadline); child.kill('SIGTERM') })
    const job = await hub.poll(sid, 10_000)
    assert.ok(job, stderr)
    assert.equal(job.prompt, 'cat')
    assert.equal('session_key' in job, false)
    await success(hub, job)
    await hub.durableTick()
    await hub.durableTick()
    assert.equal(await done, 0, stderr)
    const ack = JSON.parse(stdout.trim())
    assert.equal(ack.job_id, job.id)
    assert.equal(ack.delivery, 'conversation')
    assert.equal(journal.rows.size, 1)
    assert.deepEqual([...journal.delivered], [job.id])
    await assert.rejects(hub.result(job.id, job.nonce, { ok: true }), /reassigned/)
    assert.equal(journal.rows.size, 1)
  })

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

  // OCV5-750: durable jobs on the Box relay backup.
  function relay(calls: string[], hangSubmit = false) {
    return async (request: { args: readonly unknown[] }) => {
      const verb = String(request.args[2])
      calls.push(verb)
      if (verb === 'submit') {
        // Relay accepted the request and is generating; the owner restarts before it answers.
        if (hangSubmit) await new Promise(() => {})
        return { stdout: JSON.stringify({ ok: true, id: 'r1', status: 'queued' }) }
      }
      if (verb === 'status')
        return { stdout: JSON.stringify({ ok: true, id: 'r1', status: 'done', files: [{ index: 0 }] }) }
      if (verb === 'fetch-chunk')
        return {
          stdout: JSON.stringify({
            ok: true, offset: 0, total: mp4.length, sha256: digest,
            data: mp4.toString('base64'), eof: true,
          }),
        }
      return { stdout: JSON.stringify({ ok: true }) }
    }
  }

  it('OCV5-750: hatch offline in fallback mode runs a durable video on the relay once and journals via', async () => {
    const calls: string[] = []
    const hub = make({
      videoBackend: 'hatch-with-box-fallback',
      boxExecPollMs: 1,
      boxExecRunner: async () => relay(calls) as never,
    })
    const id = await submit(hub)
    for (let i = 0; i < 20 && journal.rows.get(id)?.status !== 'succeeded'; i++) {
      await new Promise((r) => setTimeout(r, 5))
      await flush()
    }
    const row = journal.rows.get(id)!
    assert.equal(row.status, 'succeeded')
    assert.equal(row.durable?.via, 'box-exec')
    assert.equal(calls.filter((c) => c === 'submit').length, 1)
  })

  it('OCV5-750: a restart while a relay job runs fails it with no charge and never resubmits', async () => {
    const calls: string[] = []
    const first = make({
      videoBackend: 'box-exec',
      boxExecPollMs: 1,
      boxExecRunner: async () => relay(calls, true) as never,
    })
    const id = await submit(first)
    for (let i = 0; i < 20 && !calls.includes('submit'); i++) {
      await new Promise((r) => setTimeout(r, 5))
      await flush()
    }
    assert.equal(journal.rows.get(id)?.durable?.state, 'running')
    assert.equal(journal.rows.get(id)?.durable?.via, 'box-exec')
    await first.stop()
    journal.now += MUSE_LEASE_MS + 1
    const again: string[] = []
    const second = make({
      videoBackend: 'box-exec',
      boxExecPollMs: 1,
      boxExecRunner: async () => relay(again) as never,
    })
    await second.start()
    await second.durableTick()
    await flush()
    const row = journal.rows.get(id)!
    assert.equal(row.status, 'failed')
    assert.equal(row.fin?.errorCode, 'MUSE_BOX_EXEC_INTERRUPTED')
    assert.equal(again.length, 0)
  })

  it('OCV5-750: a durable job waiting for a relay slot goes to the background instead of MUSE_BUSY', async () => {
    const calls: string[] = []
    const hub = make({
      videoBackend: 'box-exec',
      boxExecPollMs: 1,
      userRunningMax: 1,
      queueWaitMs: { image: 1_000, video: 1_000 },
      boxExecRunner: async () => relay(calls, true) as never,
    })
    const first = await submit(hub)
    const second = await submit(hub)
    for (let i = 0; i < 20 && !calls.includes('submit'); i++) {
      await new Promise((r) => setTimeout(r, 5))
      await flush()
    }
    assert.equal(journal.rows.get(first)?.durable?.state, 'running')
    journal.now += 5_000
    hub.tick()
    await flush()
    const row = journal.rows.get(second)!
    assert.equal(row.status, 'queued')
    assert.equal(row.durable?.background, true)
    assert.equal(calls.filter((c) => c === 'submit').length, 1)
  })
})
