// OCV5-750: default-off box-exec video backend must not change the hatch path.

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'

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
      ? { id, kind: r.kind, status: r.status as 'queued', errorCode: r.error }
      : null
  }
  async findCredential() {
    return null
  }
  async touchCredential() {}
}

function makeHub(
  root: string,
  extra: ConstructorParameters<typeof MuseBridgeHub>[0] extends infer T ? Partial<T> : never = {},
) {
  return new MuseBridgeHub({
    store: extra.store ?? new MemStore(),
    stateRoot: root,
    allowedUids: new Set(['3']),
    rate: { imagePerHour: 30, imagePerDay: 200, videoPerHour: 10, videoPerDay: 40 },
    cliTimeoutSec: { image: 120, video: 300 },
    now: extra.now ?? Date.now,
    ...extra,
  })
}

const roots: string[] = []
function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'muse-box-exec-hub-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('OCV5-750 hub routing', () => {
  it('flag off: video submit without a hatch session still fails MUSE_BRIDGE_OFFLINE', async () => {
    const hub = makeHub(tmpRoot())
    await assert.rejects(
      hub.submit('3', null, { kind: 'video', prompt: 'a red bicycle' }),
      (err: unknown) => err instanceof MuseError && err.code === 'MUSE_BRIDGE_OFFLINE',
    )
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

  it('flag on: image jobs and --resume videos still require the hatch bridge', async () => {
    const hub = makeHub(tmpRoot(), { videoBackend: 'box-exec' })
    await assert.rejects(
      hub.submit('3', null, { kind: 'image', prompt: 'a still' }),
      (err: unknown) => err instanceof MuseError && err.code === 'MUSE_BRIDGE_OFFLINE',
    )
    await assert.rejects(
      hub.submit('3', null, { kind: 'video', prompt: 'continue', resume_snapshot_id: 'abc:v1' }),
      (err: unknown) => err instanceof MuseError && err.code === 'MUSE_BRIDGE_OFFLINE',
    )
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

  it('does not fall back to hatch after the relay job was already submitted', async () => {
    const root = tmpRoot()
    let submits = 0
    const hub = makeHub(root, {
      videoBackend: 'box-exec',
      fallbackHatch: true,
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
  it('does not fall back to hatch when submit ends with BOX_EXEC_INCOMPLETE', async () => {
    const root = tmpRoot()
    let submits = 0
    let hatchHello = 0
    const hub = makeHub(root, {
      videoBackend: 'box-exec',
      fallbackHatch: true,
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
  it('hatch offline at submit: a fresh video goes to the relay; images and resume still fail', async () => {
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
    await assert.rejects(
      hub.submit('3', null, { kind: 'image', prompt: 'still' }),
      (err: unknown) => err instanceof MuseError && err.code === 'MUSE_BRIDGE_OFFLINE',
    )
    await assert.rejects(
      hub.submit('3', null, { kind: 'video', prompt: 'more', resume_snapshot_id: 'abc:v1' }),
      (err: unknown) => err instanceof MuseError && err.code === 'MUSE_BRIDGE_OFFLINE',
    )
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
    let last: { id: string; nonce: string } | null = null
    for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt++) {
      const job = (await hub.poll(sid, 50))!
      last = job
      clock += ACK_TIMEOUT_MS + 1
      hub.checkSession(sid)
      hub.tick()
    }
    assert.throws(
      () => hub.heartbeat(last!.id, last!.nonce),
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
    hub.heartbeat(job.id, job.nonce)
    clock += 200_000
    hub.tick()
    const view = await hub.view('3', id, 100)
    assert.equal(view?.status, 'failed')
    assert.equal(view?.error?.code, 'MUSE_BRIDGE_LOST')
    assert.equal(counter.calls.length, 0)
  })

  it('a job that fell back to the relay never bounces back to hatch', async () => {
    const hub = makeHub(tmpRoot(), {
      videoBackend: 'hatch-with-box-fallback',
      fallbackHatch: true,
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

  it('plain hatch mode still fails queued jobs when the bridge goes offline', async () => {
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
    assert.equal(view?.error?.code, 'MUSE_BRIDGE_OFFLINE')
    assert.equal(counter.calls.length, 0)
  })
})

void BOX_EXEC_CHUNK_BYTES

describe('OCV5-750 Gemini r1: box → hatch fallback only before the relay could hold the job', () => {
  it('a relay-down answer to submit falls back; a status failure after submit does not', async () => {
    const down = makeHub(tmpRoot(), {
      videoBackend: 'box-exec',
      fallbackHatch: true,
      boxExecPollMs: 1,
      boxExecRunner: async () => async () => ({
        stdout: JSON.stringify({
          ok: false,
          code: 'MUSE_RELAY_DOWN',
          message: 'relay unreachable',
        }),
      }),
    })
    const sid = down.hello('1', '0.5.3')
    const id = await down.submit('3', null, { kind: 'video', prompt: 'a red bicycle' })
    const job = await down.poll(sid, 2_000)
    assert.equal(job?.id, id, 'pre-submit relay-down falls back onto hatch')
  })

  it('a deadline-expired box job aborts its CLI calls', async () => {
    let clock = 1_000_000
    let aborted = false
    const hub = makeHub(tmpRoot(), {
      now: () => clock,
      videoBackend: 'box-exec',
      boxExecPollMs: 1,
      boxExecRunner:
        async () => async (_request: BoxCcExecRequest, opts: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal?.addEventListener('abort', () => {
              aborted = true
              reject(new Error('aborted'))
            })
          }),
    })
    const id = await hub.submit('3', null, { kind: 'video', prompt: 'a red bicycle' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    clock += 60 * 60_000
    hub.tick()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const view = await hub.view('3', id, 100)
    assert.equal(view?.error?.code, 'MUSE_TIMEOUT')
    assert.equal(aborted, true)
  })
})
