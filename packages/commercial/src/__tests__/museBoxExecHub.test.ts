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
import { MuseError } from '../muse/protocol.js'
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
})

void BOX_EXEC_CHUNK_BYTES
