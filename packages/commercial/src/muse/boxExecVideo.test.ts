import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import type { BoxCcExecRequest } from '@openclaude/gateway'

import {
  BOX_EXEC_CHUNK_BYTES,
  applyChunk,
  canRouteToBoxExec,
  mapRelayMode,
  museExecRequest,
  parseMuseVideoBackend,
  runBoxExecVideoJob,
} from './boxExecVideo.js'
import type { MuseJobSpec } from './protocol.js'

function spec(partial: Partial<MuseJobSpec> = {}): MuseJobSpec {
  return { kind: 'video', prompt: 'a red bicycle', ...partial }
}

describe('OCV5-750 muse video backend flag and routing', () => {
  it('defaults to hatch and treats empty as hatch', () => {
    assert.equal(parseMuseVideoBackend(undefined), 'hatch')
    assert.equal(parseMuseVideoBackend(''), 'hatch')
    assert.equal(parseMuseVideoBackend('hatch'), 'hatch')
    assert.equal(parseMuseVideoBackend('box-exec'), 'box-exec')
    assert.equal(canRouteToBoxExec('hatch', spec()), false)
    assert.equal(canRouteToBoxExec('box-exec', spec()), true)
    assert.equal(canRouteToBoxExec('box-exec', spec({ kind: 'image' })), false)
    assert.equal(canRouteToBoxExec('box-exec', spec({ resume_snapshot_id: 'snap-1' })), false)
  })

  it('maps modes from images unless composite is explicit', () => {
    assert.equal(mapRelayMode(spec()), 'native')
    assert.equal(mapRelayMode(spec({ source_images: ['aa'] })), 'first_frame')
    assert.equal(mapRelayMode(spec({ source_images: ['aa', 'bb'] })), 'reference')
    assert.equal(mapRelayMode(spec({ mode: 'composite', source_images: ['aa'] })), 'composite')
    assert.equal(mapRelayMode(spec({ mode: 'native', source_images: ['aa'] })), 'native')
  })

  it('builds an absolute-path Exec request for the local CLI', () => {
    const req = museExecRequest(['health'])
    assert.equal(req.command, '/usr/bin/python3')
    assert.equal(req.args[0], '-I')
    assert.equal(req.args[1], '/workspace/muse-relay/bin/muse-exec-cli')
    assert.equal(req.args[2], 'health')
    assert.equal(req.cwd, '/tmp')
  })
})

describe('OCV5-750 chunk reassembly', () => {
  it('accepts sequential windows and verifies the full digest', () => {
    const blob = Buffer.from('abcdefghijklmnopqrstuvwxyz0123456789')
    const digest = createHash('sha256').update(blob).digest('hex')
    const parts: Buffer[] = []
    let expected: { sha256?: string; total?: number } = {}
    const first = applyChunk(parts, expected, {
      offset: 0,
      data: blob.subarray(0, 10),
      total: blob.length,
      sha256: digest,
    })
    expected = first
    assert.equal(first.eof, false)
    const second = applyChunk(parts, expected, {
      offset: 10,
      data: blob.subarray(10),
      total: blob.length,
      sha256: digest,
    })
    assert.equal(second.eof, true)
    assert.equal(Buffer.concat(parts).equals(blob), true)
  })

  it('rejects a gap or a changed digest', () => {
    const parts: Buffer[] = []
    assert.throws(() =>
      applyChunk(parts, {}, { offset: 4, data: Buffer.from('x'), total: 8, sha256: 'aa' }),
    )
  })
})

describe('OCV5-750 runBoxExecVideoJob against a fake Exec', () => {
  it('submits, polls, and writes reassembled files', async () => {
    const payload = Buffer.alloc(BOX_EXEC_CHUNK_BYTES + 20, 7)
    payload.write('ftyp', 0)
    const digest = createHash('sha256').update(payload).digest('hex')
    const calls: string[][] = []
    const exec = async (request: BoxCcExecRequest) => {
      const verb = request.args[2]
      const rest = request.args.slice(3)
      calls.push([verb, ...rest])
      if (verb === 'submit') {
        return { stdout: JSON.stringify({ ok: true, id: 'relayjob1', status: 'queued' }) }
      }
      if (verb === 'status') {
        return {
          stdout: JSON.stringify({
            ok: true,
            id: 'relayjob1',
            status: calls.filter((c) => c[0] === 'status').length >= 1 ? 'done' : 'running',
            mode_mismatch: false,
            files: [{ index: 0, name: 'out.mp4', size_bytes: payload.length }],
          }),
        }
      }
      if (verb === 'fetch-chunk') {
        const offset = Number(rest[2])
        const length = Number(rest[3])
        const slice = payload.subarray(offset, offset + length)
        return {
          stdout: JSON.stringify({
            ok: true,
            offset,
            length: slice.length,
            total: payload.length,
            sha256: digest,
            data: slice.toString('base64'),
            eof: offset + slice.length >= payload.length,
          }),
        }
      }
      throw new Error(`unexpected ${verb}`)
    }
    const dest = await mkdtemp(join(tmpdir(), 'muse-box-exec-'))
    const result = await runBoxExecVideoJob({
      exec,
      spec: spec(),
      destDir: dest,
      pollMs: 1,
    })
    assert.equal(result.files.length, 1)
    assert.equal(result.files[0]!.sha256, digest)
    assert.equal(result.files[0]!.bytes, payload.length)
    const written = await readFile(join(dest, '0.bin'))
    assert.equal(written.equals(payload), true)
    assert.equal(calls[0]![0], 'submit')
    assert.ok(calls[0]!.includes('--mode'))
    assert.ok(calls[0]!.includes('native'))
  })
})
