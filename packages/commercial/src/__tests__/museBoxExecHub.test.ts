// OCV5-750 (Aurora port): default-off box-exec video backend must not change the hatch path.
// Aurora keeps offline hatch jobs queued with a retry budget instead of rejecting at submit.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { BoxCcExecRequest } from '@openclaude/gateway'

import { BOX_EXEC_CHUNK_BYTES } from '../muse/boxExecVideo.js'
import { MuseBridgeHub } from '../muse/hub.js'
import {
  ACK_TIMEOUT_MS,
  BRIDGE_ONLINE_MS,
  MAX_DISPATCH_ATTEMPTS,
  MuseError,
} from '../muse/protocol.js'
import type { MuseJobFinish, MuseStore } from '../muse/store.js'

class MemStore implements MuseStore {
  rows = new Map<
    string,
    { status: string; error: string | null; userId: string; kind: 'image' | 'video' }
  >()
  async insertJob(r: { id: string; userId: string; kind: 'image' | 'video' }) {
    this.rows.set(r.id, { status: 'queued', error: null, userId: r.userId, kind: r.kind })
  }
  async markRunning() {}
  async finishJob(id: string, fin: MuseJobFinish) {
    const r = this.rows.get(id)
    if (r) Object.assign(r, { status: fin.status, error: fin.errorCode })
  }
  async countRecent() {
    return { hour: 0, day: 0 }
  }
  async failOrphans() {
    return 0
  }
  async findJob(userId: string, id: string) {
    const r = this.rows.get(id)
    return r && r.userId === userId
      ? {
          id,
          kind: r.kind,
          status: r.status as 'queued',
          errorCode: r.error,
          files: null,
          snapshotId: null,
          debitedCredits: null,
        }
      : null
  }
  async countSiteToday() {
    return 0
  }
  async openCredits() {
    return 0n
  }
  async findCredential() {
    return null
  }
  async touchCredential() {}
}

const hubs: MuseBridgeHub[] = []
function makeHub(
  root: string,
  extra: ConstructorParameters<typeof MuseBridgeHub>[0] extends infer T ? Partial<T> : never = {},
) {
  const hub = new MuseBridgeHub({
    store: extra.store ?? new MemStore(),
    stateRoot: root,
    allowedUids: new Set(['3']),
    rate: { imagePerHour: 30, imagePerDay: 200, videoPerHour: 10, videoPerDay: 40 },
    cliTimeoutSec: { image: 120, video: 300 },
    now: extra.now ?? Date.now,
    ...extra,
  })
  hubs.push(hub)
  return hub
}

const roots: string[] = []
function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'muse-box-exec-hub-'))
  roots.push(root)
  return root
}

// Hub timers are unref'd; keep the loop alive while a test long-polls (as museDurable.test does).
let keep: NodeJS.Timeout | null = null
beforeEach(() => {
  keep = setInterval(() => {}, 1000)
})
afterEach(async () => {
  if (keep) clearInterval(keep)
  for (const hub of hubs.splice(0)) await hub.stop()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('OCV5-750 hub routing', () => {
  it('flag off: an offline video stays queued for hatch and never reaches the relay', async () => {
    const counter = { submits: 0, calls: [] as string[] }
    const hub = makeHub(tmpRoot(), {
      boxExecPollMs: 1,
      boxExecRunner: async () => okRelay(counter),
    })
    const id = await hub.submit('3', null, { kind: 'video', prompt: 'a red bicycle' })
    const view = await hub.view('3', id, 50)
    assert.equal(view?.status, 'queued')
    assert.equal(counter.calls.length, 0)
  })

  it('flag on: video jobs skip the hatch offline check and finish via Exec', async () => {
    const payload = Buffer.alloc(80, 9)
    payload.write('ftyp', 4)
    const digest = createHash('sha256').update(payload).digest('hex')
    let submits = 0
    const exec = async (request: BoxCcExecRequest) => {
      const verb = request.args[2]
      if (verb === 'submit') {
        submits += 1
        return { stdout: JSON.stringify({ ok: true, id: 'relay1', status: 'queued' }) }
      }
      if (verb === 'status') {
        return {
          stdout: JSON.stringify({
            ok: true,
            id: 'relay1',
            status: 'done',
            files: [{ index: 0, name: 'out.mp4', size_bytes: payload.length }],
          }),
        }
      }
      if (verb === 'fetch-chunk') {
        return {
          stdout: JSON.stringify({
            ok: true,
            offset: 0,
            length: payload.length,
            total: payload.length,
            sha256: digest,
            data: payload.toString('base64'),
            eof: true,
          }),
        }
      }
      throw new Error(`unexpected ${verb}`)
    }
    const hub = makeHub(tmpRoot(), {
      videoBackend: 'box-exec',
      boxExecPollMs: 1,
      boxExecRunner: async () => exec,
    })
    const id = await hub.submit('3', null, { kind: 'video', prompt: 'a red bicycle' })
    const view = await hub.view('3', id, 2_000)
    assert.equal(view?.status, 'succeeded')
    assert.equal(view?.files?.[0]?.sha256, digest)
    assert.equal(submits, 1)
    const file = hub.fileFor('3', id, 0)
    assert.ok(file)
  })

  it('flag on: image jobs and --resume videos stay on the hatch queue', async () => {
    const counter = { submits: 0, calls: [] as string[] }
    const hub = makeHub(tmpRoot(), {
      videoBackend: 'box-exec',
      boxExecPollMs: 1,
      boxExecRunner: async () => okRelay(counter),
    })
    const a = await hub.submit('3', null, { kind: 'image', prompt: 'a still' })
    const b = await hub.submit('3', null, {
      kind: 'video',
      prompt: 'continue',
      resume_snapshot_id: 'abc:v1',
    })
    assert.equal((await hub.view('3', a, 50))?.status, 'queued')
    assert.equal((await hub.view('3', b, 50))?.status, 'queued')
    assert.equal(counter.calls.length, 0)
  })

  it('runtime file overrides env without a process restart', async () => {
    const root = tmpRoot()
    const hub = makeHub(root, { videoBackend: 'hatch' })
    assert.equal(hub.getVideoBackend(), 'hatch')
    writeFileSync(join(root, 'video-backend'), 'box-exec\n')
    assert.equal(hub.getVideoBackend(), 'box-exec')
    writeFileSync(join(root, 'video-backend'), 'hatch\n')
    assert.equal(hub.getVideoBackend(), 'hatch')
  })

  it('does not start a relay submit after the caller cancels while the runner is resolving', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let submits = 0
    const hub = makeHub(tmpRoot(), {
      videoBackend: 'box-exec',
      boxExecPollMs: 1,
      boxExecRunner: async () => {
        await gate
        return async (request: BoxCcExecRequest) => {
          const verb = request.args[2]
          if (verb === 'submit') {
            submits += 1
            return { stdout: JSON.stringify({ ok: true, id: 'late', status: 'queued' }) }
          }
          throw new Error(`unexpected ${verb}`)
        }
      },
    })
    const id = await hub.submit('3', null, { kind: 'video', prompt: 'a red bicycle' })
    const cancelled = hub.cancel('3', id)
    assert.equal(cancelled?.status, 'cancelled')
    release()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(submits, 0)
    const view = await hub.view('3', id, 100)
    assert.equal(view?.status, 'cancelled')
  })

  it('a relay failure after submit fails the job (Aurora has no box → hatch fallback)', async () => {
    const root = tmpRoot()
    let submits = 0
    const hub = makeHub(root, {
      videoBackend: 'box-exec',
      boxExecPollMs: 1,
      boxExecRunner: async () => async (request: BoxCcExecRequest) => {
        const verb = request.args[2]
        if (verb === 'submit') {
          submits += 1
          return { stdout: JSON.stringify({ ok: true, id: 'relay-started', status: 'queued' }) }
        }
        if (verb === 'status') throw new Error('BOX_EXEC_TIMEOUT')
        if (verb === 'cancel') return { stdout: JSON.stringify({ ok: true, status: 'cancelled' }) }
        throw new Error(`unexpected ${verb}`)
      },
    })
    hub.hello('1', '0.5.0')
    const id = await hub.submit('3', null, { kind: 'video', prompt: 'a red bicycle' })
    const view = await hub.view('3', id, 2_000)
    assert.equal(submits, 1)
    assert.equal(view?.status, 'failed')
    assert.equal(view?.error?.code, 'MUSE_UPSTREAM_ERROR')
  })
  it('an incomplete submit fails the job and never reaches hatch', async () => {
    const root = tmpRoot()
    let submits = 0
    let hatchHello = 0
    const hub = makeHub(root, {
      videoBackend: 'box-exec',
      boxExecPollMs: 1,
      boxExecRunner: async () => async (request: BoxCcExecRequest) => {
        const verb = request.args[2]
        if (verb === 'submit') {
          submits += 1
          throw new Error('BOX_EXEC_INCOMPLETE')
        }
        throw new Error(`unexpected ${verb}`)
      },
    })
    hub.hello('1', '0.5.0')
    hatchHello += 1
    const id = await hub.submit('3', null, { kind: 'video', prompt: 'a red bicycle' })
    const view = await hub.view('3', id, 2_000)
    assert.equal(submits, 1)
    assert.equal(view?.status, 'failed')
    assert.equal(view?.error?.code, 'MUSE_UPSTREAM_ERROR')
    assert.equal(hatchHello, 1)
  })
})

function okRelay(counter: { submits: number; calls: string[] }) {
  const payload = Buffer.alloc(64, 5)
  payload.write('ftyp', 4)
  const digest = createHash('sha256').update(payload).digest('hex')
  return async (request: BoxCcExecRequest) => {
    const verb = String(request.args[2])
    counter.calls.push(verb)
    if (verb === 'submit') {
      counter.submits += 1
      return { stdout: JSON.stringify({ ok: true, id: 'fb1', status: 'queued' }) }
    }
    if (verb === 'status') {
      return {
        stdout: JSON.stringify({ ok: true, id: 'fb1', status: 'done', files: [{ index: 0 }] }),
      }
    }
    if (verb === 'fetch-chunk') {
      return {
        stdout: JSON.stringify({
          ok: true,
          offset: 0,
          total: payload.length,
          sha256: digest,
          data: payload.toString('base64'),
          eof: true,
        }),
      }
    }
    if (verb === 'cancel') return { stdout: JSON.stringify({ ok: true }) }
    throw new Error(`unexpected ${verb}`)
  }
}

describe('OCV5-750 hatch-with-box-fallback', () => {
  it('hatch offline at submit: a fresh video goes to the relay; images and resume stay on hatch', async () => {
    const counter = { submits: 0, calls: [] as string[] }
    const hub = makeHub(tmpRoot(), {
      videoBackend: 'hatch-with-box-fallback',
      boxExecPollMs: 1,
      boxExecRunner: async () => okRelay(counter),
    })
    const id = await hub.submit('3', null, { kind: 'video', prompt: 'a red bicycle' })
    const view = await hub.view('3', id, 2_000)
    assert.equal(view?.status, 'succeeded')
    assert.equal(counter.submits, 1)
    const img = await hub.submit('3', null, { kind: 'image', prompt: 'still' })
    const res = await hub.submit('3', null, {
      kind: 'video',
      prompt: 'more',
      resume_snapshot_id: 'abc:v1',
    })
    assert.equal((await hub.view('3', img, 50))?.status, 'queued')
    assert.equal((await hub.view('3', res, 50))?.status, 'queued')
    assert.equal(counter.submits, 1)
  })

  it('hatch online: the job goes to hatch and the relay is never called', async () => {
    const counter = { submits: 0, calls: [] as string[] }
    const hub = makeHub(tmpRoot(), {
      videoBackend: 'hatch-with-box-fallback',
      boxExecPollMs: 1,
      boxExecRunner: async () => okRelay(counter),
    })
    const sid = hub.hello('1', '0.5.3')
    const id = await hub.submit('3', null, { kind: 'video', prompt: 'a red bicycle' })
    const job = (await hub.poll(sid, 50))!
    assert.equal(job.id, id)
    hub.heartbeat(job.id, job.nonce)
    assert.equal(counter.calls.length, 0)
  })

  it('a queued hatch job moves to the relay when the bridge goes offline', async () => {
    let clock = 1_000_000
    const counter = { submits: 0, calls: [] as string[] }
    const hub = makeHub(tmpRoot(), {
      now: () => clock,
      videoBackend: 'hatch-with-box-fallback',
      boxExecPollMs: 1,
      boxExecRunner: async () => okRelay(counter),
    })
    hub.hello('1', '0.5.3')
    const id = await hub.submit('3', null, { kind: 'video', prompt: 'a red bicycle' })
    clock += BRIDGE_ONLINE_MS + 1_000
    hub.tick()
    const view = await hub.view('3', id, 2_000)
    assert.equal(view?.status, 'succeeded')
    assert.equal(counter.submits, 1)
  })

  it('a never-acked dispatch moves to the relay and a late hatch ack gets 410', async () => {
    let clock = 1_000_000
    const counter = { submits: 0, calls: [] as string[] }
    const hub = makeHub(tmpRoot(), {
      now: () => clock,
      videoBackend: 'hatch-with-box-fallback',
      boxExecPollMs: 1,
      boxExecRunner: async () => okRelay(counter),
    })
    const sid = hub.hello('1', '0.5.3')
    const id = await hub.submit('3', null, { kind: 'video', prompt: 'a red bicycle' })
    const last = (await hub.poll(sid, 50))!
    assert.equal(last.id, id)
    // No ack, and the bridge then goes silent: the requeue hook moves the job to the relay.
    clock += ACK_TIMEOUT_MS + BRIDGE_ONLINE_MS + 1
    hub.tick()
    await assert.rejects(
      async () => hub.heartbeat(last.id, last.nonce),
      (err: unknown) => err instanceof MuseError && err.status === 410,
    )
    const view = await hub.view('3', id, 2_000)
    assert.equal(view?.status, 'succeeded')
    assert.equal(counter.submits, 1)
  })

  it('an acked (running) hatch job that loses its bridge fails and never touches the relay', async () => {
    let clock = 1_000_000
    const counter = { submits: 0, calls: [] as string[] }
    const hub = makeHub(tmpRoot(), {
      now: () => clock,
      videoBackend: 'hatch-with-box-fallback',
      boxExecPollMs: 1,
      boxExecRunner: async () => okRelay(counter),
    })
    const sid = hub.hello('1', '0.5.3')
    const id = await hub.submit('3', null, { kind: 'video', prompt: 'a red bicycle' })
    const job = (await hub.poll(sid, 50))!
    await hub.heartbeat(job.id, job.nonce)
    clock += 200_000
    hub.tick()
    await hub.view('3', id, 100)
    assert.equal(counter.calls.length, 0)
  })

  it('a relay failure fails the job and never bounces back to hatch', async () => {
    const hub = makeHub(tmpRoot(), {
      videoBackend: 'hatch-with-box-fallback',
      boxExecPollMs: 1,
      boxExecRunner: async () => async () => {
        throw new Error('relay is down')
      },
    })
    const id = await hub.submit('3', null, { kind: 'video', prompt: 'a red bicycle' })
    hub.hello('1', '0.5.3')
    const view = await hub.view('3', id, 2_000)
    assert.equal(view?.status, 'failed')
  })

  it('plain hatch mode never moves a queued job to the relay when the bridge goes offline', async () => {
    let clock = 1_000_000
    const counter = { submits: 0, calls: [] as string[] }
    const hub = makeHub(tmpRoot(), {
      now: () => clock,
      videoBackend: 'hatch',
      boxExecRunner: async () => okRelay(counter),
    })
    hub.hello('1', '0.5.3')
    const id = await hub.submit('3', null, { kind: 'video', prompt: 'a red bicycle' })
    clock += BRIDGE_ONLINE_MS + 1_000
    hub.tick()
    const view = await hub.view('3', id, 100)
    assert.notEqual(view?.status, 'succeeded')
    assert.equal(counter.calls.length, 0)
  })
})

void BOX_EXEC_CHUNK_BYTES
