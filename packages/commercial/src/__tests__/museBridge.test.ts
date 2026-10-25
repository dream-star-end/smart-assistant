// Muse media bridge (OCV5-561): hub state machine, chunk/result verification, bridge HTTP.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { type Server, createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { Logger } from '../logging/logger.js'
import { makeMuseBridgeHttpHandler } from '../muse/bridgeHttp.js'
import { MuseBridgeHub, type MuseWireJob } from '../muse/hub.js'
import { MuseError, parseAllowedUids, parseSubmission, supportsSourceRefs } from '../muse/protocol.js'
import type { MuseJobFinish, MuseStore } from '../muse/store.js'

const TOKEN = `mbr_${'x'.repeat(43)}`
const WEBP = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'), Buffer.alloc(200, 7)])
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(50),
])
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

class MemStore implements MuseStore {
  rows = new Map<
    string,
    { status: string; error: string | null; userId: string; kind: 'image' | 'video' }
  >()
  running: string[] = []
  finished: Array<[string, MuseJobFinish]> = []
  recent = { hour: 0, day: 0 }
  creds = new Map<string, string>([[sha(Buffer.from(TOKEN)), '1']])
  async insertJob(r: { id: string; userId: string; kind: 'image' | 'video' }) {
    this.rows.set(r.id, { status: 'queued', error: null, userId: r.userId, kind: r.kind })
  }
  async markRunning(id: string) {
    this.running.push(id)
    const r = this.rows.get(id)
    if (r) r.status = 'running'
  }
  async finishJob(id: string, fin: MuseJobFinish) {
    this.finished.push([id, fin])
    const r = this.rows.get(id)
    if (r) Object.assign(r, { status: fin.status, error: fin.errorCode })
  }
  async countRecent() {
    return this.recent
  }
  async failOrphans() {
    return 0
  }
  async findJob(userId: string, id: string) {
    const r = this.rows.get(id)
    return r && r.userId === userId
      ? { id, kind: r.kind, status: r.status as 'queued', errorCode: r.error }
      : null
  }
  async findCredential(s: Buffer) {
    const id = this.creds.get(s.toString('hex'))
    return id ? { id } : null
  }
  async touchCredential() {}
}

function makeHub(
  store: MemStore,
  clock: { t: number },
  root: string,
  rate = { imagePerHour: 30, imagePerDay: 200, videoPerHour: 10, videoPerDay: 40 },
  logger?: Logger,
) {
  return new MuseBridgeHub({
    store,
    stateRoot: root,
    allowedUids: new Set(['3']),
    rate,
    cliTimeoutSec: { image: 120, video: 300 },
    now: () => clock.t,
    logger,
  })
}

const flush = () => new Promise((r) => setImmediate(r))

describe('muse protocol', () => {
  it('negotiates source refs by SemVer, including prereleases and build metadata', () => {
    for (const v of [null, '', '0.3.2', '0.4.0', '0.5', '0.5.0-rc.1', '0.5.0-01', '00.5.0', 'garbage']) {
      assert.equal(supportsSourceRefs(v), false, String(v))
    }
    for (const v of ['0.5.0', '0.5.0+build.1', '0.5.1-rc.1', '0.6.0', '1.0.0']) {
      assert.equal(supportsSourceRefs(v), true, v)
    }
  })
  it('allowlist defaults to uid 3 and never enables uid 4', () => {
    assert.deepEqual([...parseAllowedUids(undefined)], ['3'])
    assert.deepEqual([...parseAllowedUids(['3', '4', '765'])], ['3', '765'])
    assert.deepEqual([...parseAllowedUids([])], [])
  })
  it('rejects image_format on video, bad base64, non-image sources and >4 sources', () => {
    const bad = [
      { kind: 'video', prompt: 'x', image_format: 'png' },
      { kind: 'image', prompt: 'x', source_images: [{ base64: '!!!' }] },
      {
        kind: 'image',
        prompt: 'x',
        source_images: [{ base64: Buffer.from('GIF89a....').toString('base64') }],
      },
      {
        kind: 'image',
        prompt: 'x',
        source_images: Array(5).fill({ base64: PNG.toString('base64') }),
      },
      { kind: 'image', prompt: '   ' },
      { kind: 'image', prompt: 'x', duration: 10 },
      { kind: 'image', prompt: 'x', resume_snapshot_id: 'a b' },
    ]
    for (const b of bad) {
      assert.throws(
        () => parseSubmission(b),
        (e: unknown) => e instanceof MuseError && e.code === 'MUSE_INVALID_INPUT',
        JSON.stringify(b).slice(0, 80),
      )
    }
    const ok = parseSubmission({
      kind: 'video',
      prompt: 'p',
      source_images: [{ base64: PNG.toString('base64') }],
      resume_snapshot_id: 'abc:v1',
    })
    assert.equal(ok.source_images?.length, 1)
  })
})

describe('muse hub', () => {
  let root: string
  let store: MemStore
  let clock: { t: number }
  let hub: MuseBridgeHub
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'muse-hub-'))
    store = new MemStore()
    clock = { t: 1_000_000 }
    hub = makeHub(store, clock, root)
  })
  afterEach(() => {
    hub.stop()
    rmSync(root, { recursive: true, force: true })
  })

  async function online(): Promise<string> {
    return hub.hello('1', '0.3.0')
  }

  async function runningJob(kind: 'image' | 'video' = 'image'): Promise<MuseWireJob> {
    const sid = await online()
    const id = await hub.submit('3', '9', { kind, prompt: 'red fox' })
    const job = (await hub.poll(sid, 50))!
    assert.equal(job.id, id)
    hub.heartbeat(job.id, job.nonce)
    return job
  }

  async function upload(job: MuseWireJob, data: Buffer) {
    await hub.putChunk(job.id, job.nonce, 0, 0, data, sha(data))
  }

  it('source refs keep a multi-MiB claim small; legacy versions still receive inline sources', async () => {
    const data = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)])
    for (const version of [null, '0.3.2', '0.4.0', '0.5.0-rc.1', '0.5.0', '0.6.0']) {
      const sid = hub.hello('1', version)
      const id = await hub.submit('3', null, parseSubmission({
        kind: 'video', prompt: 'animate fox', source_images: [{ base64: data.toString('base64') }],
      }))
      const job = (await hub.poll(sid, 50))!
      if (supportsSourceRefs(version)) {
        assert.equal('source_images' in job, false)
        assert.deepEqual(job.source_refs, [{ n: 0, bytes: data.length, sha256: sha(data), mime: 'image/png' }])
        assert.ok(Buffer.byteLength(JSON.stringify({ job })) < 1024)
      } else {
        assert.equal('source_refs' in job, false)
        assert.equal(job.source_images?.[0]?.base64, data.toString('base64'))
      }
      hub.cancel('3', id)
    }
  })

  it('source bytes survive requeue but only the acked current nonce can read them', async () => {
    const sid = hub.hello('1', '0.5.0')
    await hub.submit('3', null, { kind: 'image', prompt: 'x', source_images: [PNG.toString('base64')] })
    const first = (await hub.poll(sid, 50))!
    assert.throws(() => hub.sourceFor(first.id, first.nonce, 0), (e: MuseError) => e.status === 410)
    clock.t += 21_000
    hub.tick()
    const second = (await hub.poll(sid, 50))!
    hub.heartbeat(second.id, second.nonce)
    assert.throws(() => hub.sourceFor(first.id, first.nonce, 0), (e: MuseError) => e.status === 410)
    assert.deepEqual(hub.sourceFor(second.id, second.nonce, 0).data, PNG)
    hub.cancel('3', second.id)
    assert.throws(() => hub.sourceFor(second.id, second.nonce, 0), (e: MuseError) => e.status === 410)
  })

  it('ack timeout logs the actual UTF-8 claim response bytes on requeue and exhaustion', async () => {
    const entries: Array<{ msg: string; meta: Record<string, unknown> }> = []
    const logger = {
      child() { return this }, info() {}, error() {},
      warn(msg: string, meta: Record<string, unknown>) { entries.push({ msg, meta }) },
    } as unknown as Logger
    hub = makeHub(store, clock, root, undefined, logger)
    const sid = hub.hello('1', '0.5.0')
    await hub.submit('3', null, { kind: 'image', prompt: '红狐', source_images: [PNG.toString('base64')] })
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = (await hub.poll(sid, 50))!
      clock.t += 21_000
      hub.checkSession(sid)
      hub.tick()
      const entry = entries[attempt - 1]!
      assert.equal(entry.msg, attempt === 3 ? 'muse_job_ack_timeout_failed' : 'muse_job_ack_timeout_requeued')
      assert.equal(entry.meta.claimResponseBytes, Buffer.byteLength(JSON.stringify({ job })))
    }
  })

  it('refuses when offline, not allowed, busy, or rate limited', async () => {
    await assert.rejects(hub.submit('3', null, { kind: 'image', prompt: 'x' }), /not connected/)
    await online()
    await assert.rejects(
      hub.submit('765', null, { kind: 'image', prompt: 'x' }),
      (e: MuseError) => e.code === 'MUSE_NOT_ENABLED',
    )
    store.recent = { hour: 30, day: 30 }
    await assert.rejects(
      hub.submit('3', null, { kind: 'image', prompt: 'x' }),
      (e: MuseError) => e.code === 'MUSE_RATE_LIMITED',
    )
    store.recent = { hour: 0, day: 0 }
    for (let i = 0; i < 3; i++) await hub.submit('3', null, { kind: 'image', prompt: 'x' })
    await assert.rejects(
      hub.submit('3', null, { kind: 'image', prompt: 'x' }),
      (e: MuseError) => e.code === 'MUSE_BUSY',
    )
  })

  it('un-acked dispatch is requeued with a new nonce; the old nonce gets 410', async () => {
    const sid = await online()
    await hub.submit('3', null, { kind: 'image', prompt: 'x' })
    const first = (await hub.poll(sid, 50))!
    clock.t += 21_000
    hub.tick()
    assert.throws(
      () => hub.heartbeat(first.id, first.nonce),
      (e: MuseError) => e.status === 410,
    )
    const second = (await hub.poll(sid, 50))!
    assert.equal(second.id, first.id)
    assert.notEqual(second.nonce, first.nonce)
    hub.heartbeat(second.id, second.nonce)
    await flush()
    assert.deepEqual(store.running, [first.id])
  })

  it('gives up after three un-acked dispatches', async () => {
    const sid = await online()
    const id = await hub.submit('3', null, { kind: 'image', prompt: 'x' })
    for (let i = 0; i < 3; i++) {
      assert.ok(await hub.poll(sid, 50))
      clock.t += 21_000
      hub.checkSession(sid)
      hub.tick()
    }
    const v = await hub.view('3', id, 0)
    assert.equal(v?.status, 'failed')
    assert.equal(v?.error?.code, 'MUSE_BRIDGE_LOST')
  })

  it('a poll response that could not be written puts the job back', async () => {
    const sid = await online()
    await hub.submit('3', null, { kind: 'image', prompt: 'x' })
    const j = (await hub.poll(sid, 50))!
    hub.undeliverable(j.id)
    const again = (await hub.poll(sid, 50))!
    assert.equal(again.id, j.id)
    assert.notEqual(again.nonce, j.nonce)
  })

  it('lost heartbeat and deadline fail the running job', async () => {
    const a = await runningJob()
    clock.t += 61_000
    hub.checkSession((hub as any).session.id)
    hub.tick()
    assert.equal((await hub.view('3', a.id, 0))?.error?.code, 'MUSE_BRIDGE_LOST')
    const b = await runningJob()
    for (let i = 0; i < 20; i++) {
      clock.t += 10_000
      hub.checkSession((hub as any).session.id)
      if (i < 19) hub.heartbeat(b.id, b.nonce)
      hub.tick()
    }
    const v = await hub.view('3', b.id, 0)
    assert.equal(v?.error?.code, 'MUSE_TIMEOUT')
    assert.equal(v?.error?.retryable, true)
  })

  it('a new hello requeues a dispatched job but fails a running one', async () => {
    const sid = await online()
    await hub.submit('3', null, { kind: 'image', prompt: 'x' })
    const d = (await hub.poll(sid, 50))!
    const sid2 = await online()
    assert.equal(hub.checkSession(sid), 'superseded')
    assert.equal(hub.checkSession('never-seen'), 'unknown')
    const again = (await hub.poll(sid2, 50))!
    assert.equal(again.id, d.id)
    hub.heartbeat(again.id, again.nonce)
    await online()
    assert.equal((await hub.view('3', d.id, 0))?.error?.code, 'MUSE_BRIDGE_LOST')
  })

  it('chunks: sequential, sha-checked, idempotent retry, size cap fails the job', async () => {
    const job = await runningJob()
    const c0 = WEBP.subarray(0, 100)
    const c1 = WEBP.subarray(100)
    await hub.putChunk(job.id, job.nonce, 0, 0, c0, sha(c0))
    await hub.putChunk(job.id, job.nonce, 0, 0, c0, sha(c0)) // lost-response retry
    await assert.rejects(hub.putChunk(job.id, job.nonce, 0, 2, c1, sha(c1)), /sequential/)
    await assert.rejects(hub.putChunk(job.id, job.nonce, 0, 1, c1, sha(c0)), /sha256/)
    await hub.putChunk(job.id, job.nonce, 0, 1, c1, sha(c1))
    await hub.result(job.id, job.nonce, {
      ok: true,
      files: [
        {
          idx: 0,
          filename: '../../etc/x',
          mime: 'image/webp',
          bytes: WEBP.length,
          sha256: sha(WEBP),
          chunks: 2,
        },
      ],
      meta: { snapshot_id: 'c51d:981z14', artifact_ids: ['media-artifact:1'] },
    })
    const v = await hub.view('3', job.id, 0)
    assert.equal(v?.status, 'succeeded')
    assert.equal(v?.snapshot_id, 'c51d:981z14')
    assert.match(v!.files![0]!.filename, /^muse-image-[0-9a-f-]{8}-1\.webp$/)
    const f = hub.fileFor('3', job.id, 0)!
    assert.deepEqual(readFileSync(f.path), WEBP)
    assert.equal(hub.fileFor('765', job.id, 0), null)
    assert.equal(await hub.view('765', job.id, 0), null)

    const big = await runningJob('image')
    const chunk = Buffer.alloc(4 * 1024 * 1024, 1)
    let n = 0
    await assert.rejects(
      async () => {
        for (; n < 8; n++) await hub.putChunk(big.id, big.nonce, 0, n, chunk, sha(chunk))
      },
      (e: MuseError) => e.status === 410,
    )
    assert.equal((await hub.view('3', big.id, 0))?.error?.code, 'MUSE_FILE_TOO_LARGE')
  })

  it('result verification rejects mismatches and non-media content', async () => {
    const job = await runningJob()
    await upload(job, WEBP)
    await assert.rejects(
      hub.result(job.id, job.nonce, {
        ok: true,
        files: [
          { idx: 0, mime: 'image/webp', bytes: WEBP.length, sha256: '0'.repeat(64), chunks: 1 },
        ],
      }),
      /sha256/,
    )
    assert.equal((await hub.view('3', job.id, 0))?.error?.code, 'MUSE_BAD_OUTPUT')
    const txt = await runningJob()
    const junk = Buffer.from('not an image at all')
    await upload(txt, junk)
    await assert.rejects(
      hub.result(txt.id, txt.nonce, {
        ok: true,
        files: [{ idx: 0, mime: 'image/webp', bytes: junk.length, sha256: sha(junk), chunks: 1 }],
      }),
      /allowed image type/,
    )
  })

  it('bridge failures are normalized; unknown codes become MUSE_BAD_OUTPUT', async () => {
    const a = await runningJob('video')
    await hub.result(a.id, a.nonce, {
      ok: false,
      error_code: 'MUSE_VIDEO_REGION_BLOCKED',
      error_message: 'region',
      retryable: false,
      upstream_error_code: 'video_not_available',
    })
    const v = await hub.view('3', a.id, 0)
    assert.deepEqual(v?.error, {
      code: 'MUSE_VIDEO_REGION_BLOCKED',
      message: 'region',
      retryable: false,
      upstream_error_code: 'video_not_available',
    })
    const b = await runningJob()
    await hub.result(b.id, b.nonce, { ok: false, error_code: 'rm -rf', error_message: 'x' })
    assert.equal((await hub.view('3', b.id, 0))?.error?.code, 'MUSE_BAD_OUTPUT')
  })

  it('cancel frees the slot and the bridge sees 410 on its next heartbeat', async () => {
    const job = await runningJob()
    assert.equal(hub.cancel('765', job.id), null)
    assert.equal(hub.cancel('3', job.id)?.status, 'cancelled')
    assert.throws(
      () => hub.heartbeat(job.id, job.nonce),
      (e: MuseError) => e.status === 410,
    )
  })

  it('concurrent submissions cannot overrun the rate limit or the queue (Codex r1 P1)', async () => {
    store.countRecent = async () => {
      await new Promise((r) => setTimeout(r, 20))
      return { hour: 0, day: 0 }
    }
    const limited = makeHub(store, clock, root, {
      imagePerHour: 1,
      imagePerDay: 1,
      videoPerHour: 1,
      videoPerDay: 1,
    })
    limited.hello('1', null)
    const r1 = await Promise.allSettled(
      Array.from({ length: 20 }, () => limited.submit('3', null, { kind: 'image', prompt: 'x' })),
    )
    assert.equal(r1.filter((r) => r.status === 'fulfilled').length, 1)
    limited.stop()
    await online()
    const r2 = await Promise.allSettled(
      Array.from({ length: 20 }, () => hub.submit('3', null, { kind: 'image', prompt: 'x' })),
    )
    assert.equal(r2.filter((r) => r.status === 'fulfilled').length, 3)
    assert.ok(
      r2.every((r) => r.status === 'fulfilled' || (r.reason as MuseError).code === 'MUSE_BUSY'),
    )
  })

  it('no chunk can land while a result is being verified (Codex r1 P1)', async () => {
    const job = await runningJob()
    await upload(job, PNG)
    const verifying = hub.result(job.id, job.nonce, {
      ok: true,
      files: [{ idx: 0, mime: 'image/png', bytes: PNG.length, sha256: sha(PNG), chunks: 1 }],
    })
    const extra = Buffer.alloc(1024, 9)
    await assert.rejects(
      hub.putChunk(job.id, job.nonce, 0, 1, extra, sha(extra)),
      (e: MuseError) => e.status === 429 || e.status === 410,
    )
    await verifying
    const v = await hub.view('3', job.id, 0)
    assert.equal(v?.status, 'succeeded')
    assert.equal(v?.files?.[0]?.bytes, PNG.length)
    assert.deepEqual(readFileSync(hub.fileFor('3', job.id, 0)!.path), PNG)
  })

  it('view waits for the terminal state and falls back to the audit row', async () => {
    const job = await runningJob()
    const pending = hub.view('3', job.id, 2000)
    await upload(job, WEBP)
    await hub.result(job.id, job.nonce, {
      ok: true,
      files: [{ idx: 0, mime: 'image/webp', bytes: WEBP.length, sha256: sha(WEBP), chunks: 1 }],
    })
    assert.equal((await pending)?.status, 'succeeded')
    store.rows.set('mj_00000000-0000-0000-0000-000000000000', {
      status: 'failed',
      error: 'MUSE_MASTER_RESTARTED',
      userId: '3',
      kind: 'image',
    })
    const old = await hub.view('3', 'mj_00000000-0000-0000-0000-000000000000', 0)
    assert.equal(old?.error?.code, 'MUSE_MASTER_RESTARTED')
    assert.equal(old?.error?.retryable, true)
  })
})

describe('muse bridge http', () => {
  let root: string
  let store: MemStore
  let hub: MuseBridgeHub
  let server: Server
  let base: string
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'muse-http-'))
    store = new MemStore()
    hub = makeHub(
      store,
      {
        get t() {
          return Date.now()
        },
      } as { t: number },
      root,
    )
    const h = makeMuseBridgeHttpHandler({ hub, store, pollHoldMs: 1500 })
    server = createServer(
      (req, res) => void h(req, res, { clientIp: String(req.headers['x-test-ip'] ?? '1.1.1.1') }),
    )
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/muse-bridge/v1`
  })
  afterEach(async () => {
    hub.stop()
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
    rmSync(root, { recursive: true, force: true })
  })

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    const text = await r.text()
    return { status: r.status, json: text ? JSON.parse(text) : null }
  }

  it('source GET requires token, session, nonce and ack; serves ranges only until finish', async () => {
    const sid = (await post('/hello', { bridge_version: '0.5.0' })).json.session_id
    const hdr = { 'x-muse-bridge-session': sid }
    await hub.submit('3', null, { kind: 'image', prompt: 'x', source_images: [PNG.toString('base64')] })
    const job = (await post('/poll', {}, hdr)).json.job
    const get = (extra: Record<string, string> = {}, n = '0') => fetch(`${base}/jobs/${job.id}/sources/${n}`, {
      headers: { authorization: `Bearer ${TOKEN}`, ...hdr, 'x-job-nonce': job.nonce, ...extra },
    })
    assert.equal((await get({ authorization: 'Bearer invalid' })).status, 401)
    assert.equal((await get({ 'x-muse-bridge-session': '' })).status, 400)
    assert.equal((await get()).status, 410)
    await post(`/jobs/${job.id}/heartbeat`, { job_nonce: job.nonce }, hdr)
    assert.equal((await get({ 'x-job-nonce': 'wrong' })).status, 410)
    assert.equal((await get({}, '1')).status, 404)
    const full = await get()
    assert.equal(full.status, 200)
    assert.equal(full.headers.get('cache-control'), 'no-store')
    assert.equal(full.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), PNG)
    for (const [range, start, end] of [['bytes=0-7', 0, 7], ['bytes=8-', 8, PNG.length - 1], ['bytes=-4', PNG.length - 4, PNG.length - 1]] as const) {
      const r = await get({ range })
      assert.equal(r.status, 206)
      assert.equal(r.headers.get('content-range'), `bytes ${start}-${end}/${PNG.length}`)
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG.subarray(start, end + 1))
    }
    for (const range of ['bytes=9999-', 'bytes=7-2', 'bytes=0-1,4-5', 'bytes=-0', 'bad']) {
      const r = await get({ range })
      assert.equal(r.status, 416, range)
      assert.equal(r.headers.get('content-range'), `bytes */${PNG.length}`)
    }
    await post(`/jobs/${job.id}/result`, { job_nonce: job.nonce, ok: false, error_code: 'MUSE_INVALID_INPUT' }, hdr)
    assert.equal((await get()).status, 410)
    await post('/hello', { bridge_version: '0.5.0' })
    assert.equal((await get()).status, 409)
  })

  it('401 for a bad token, 429 after repeated failures from one IP', async () => {
    let last = 0
    for (let i = 0; i < 12; i++) {
      last = (
        await post(
          '/hello',
          {},
          { authorization: `Bearer mbr_${'y'.repeat(43)}`, 'x-test-ip': '9.9.9.9' },
        )
      ).status
    }
    assert.equal(last, 429)
    assert.equal((await post('/hello', {}, { 'x-test-ip': '8.8.8.8' })).status, 200)
  })

  it('unknown session → 400 (hello again), superseded → 409, empty poll → 204', async () => {
    assert.equal((await post('/poll', {}, { 'x-muse-bridge-session': 'nope' })).status, 400)
    const a = (await post('/hello', { bridge_version: '0.3.0' })).json.session_id
    const b = (await post('/hello', { bridge_version: '0.3.0' })).json.session_id
    assert.equal((await post('/poll', {}, { 'x-muse-bridge-session': a })).status, 409)
    assert.equal((await post('/poll', {}, { 'x-muse-bridge-session': b })).status, 204)
  })

  it('a live poll keeps waiting after its body is read and receives a job submitted later', async () => {
    const sid = (await post('/hello', {})).json.session_id
    const polling = post('/poll', {}, { 'x-muse-bridge-session': sid })
    await new Promise((r) => setTimeout(r, 200))
    const id = await hub.submit('3', null, { kind: 'image', prompt: 'x' })
    const r = await polling
    assert.equal(r.status, 200)
    assert.equal(r.json.job.id, id)
  })

  it('an aborted poll does not swallow the next job', async () => {
    const sid = (await post('/hello', {})).json.session_id
    await new Promise<void>((resolve) => {
      const req = httpRequest(`${base}/poll`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'x-muse-bridge-session': sid,
          'content-type': 'application/json',
        },
      })
      req.on('error', () => resolve())
      req.end('{}')
      setTimeout(() => {
        req.destroy()
        resolve()
      }, 200)
    })
    await new Promise((r) => setTimeout(r, 100))
    const id = await hub.submit('3', null, { kind: 'image', prompt: 'x' })
    const r = await post('/poll', {}, { 'x-muse-bridge-session': sid })
    assert.equal(r.status, 200)
    assert.equal(r.json.job.id, id)
  })

  it('heartbeat with a stale nonce → 410; chunk + result round trip', async () => {
    const sid = (await post('/hello', {})).json.session_id
    const hdr = { 'x-muse-bridge-session': sid }
    await hub.submit('3', null, { kind: 'image', prompt: 'x' })
    const job = (await post('/poll', {}, hdr)).json.job
    assert.equal((await post(`/jobs/${job.id}/heartbeat`, { job_nonce: 'stale' }, hdr)).status, 410)
    assert.equal(
      (await post(`/jobs/${job.id}/heartbeat`, { job_nonce: job.nonce }, hdr)).status,
      200,
    )
    const put = await fetch(`${base}/jobs/${job.id}/files/0/chunks/0`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...hdr,
        'x-job-nonce': job.nonce,
        'x-chunk-sha256': sha(WEBP),
        'content-type': 'application/octet-stream',
      },
      body: WEBP,
    })
    assert.equal(put.status, 200)
    const res = await post(
      `/jobs/${job.id}/result`,
      {
        job_nonce: job.nonce,
        ok: true,
        files: [{ idx: 0, mime: 'image/webp', bytes: WEBP.length, sha256: sha(WEBP), chunks: 1 }],
      },
      hdr,
    )
    assert.equal(res.status, 200)
    assert.equal((await hub.view('3', job.id, 0))?.status, 'succeeded')
    assert.equal((await post('/jobs/../../etc/heartbeat', {}, hdr)).status, 404)
  })
})
