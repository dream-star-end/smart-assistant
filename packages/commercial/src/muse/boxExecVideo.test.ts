import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import type { BoxCcExecRequest } from '@openclaude/gateway'

import {
  BOX_EXEC_CHUNK_BYTES,
  BOX_EXEC_READ_RETRY_BUDGET,
  BOX_EXEC_READ_RETRY_DELAYS_MS,
  applyChunk,
  canRouteToBoxExec,
  createMuseBoxExecRunner,
  downloadRelayFile,
  isStaleBoxExecTransport,
  isTransientBoxExecReadError,
  mapRelayMode,
  museExecRequest,
  museRelayStagingPath,
  parseMuseVideoBackend,
  runBoxExecVideoJob,
} from './boxExecVideo.js'
import type { MuseJobSpec } from './protocol.js'
import { MuseError } from './protocol.js'

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

  it('isolates staging paths by dest dir and entropy', () => {
    const a = museRelayStagingPath('/var/lib/muse-media/mj_one', 0, 'aaa111')
    const b = museRelayStagingPath('/var/lib/muse-media/mj_two', 0, 'aaa111')
    const c = museRelayStagingPath('/var/lib/muse-media/mj_one', 0, 'bbb222')
    assert.notEqual(a, b)
    assert.notEqual(a, c)
    assert.match(a, /^\/tmp\/oc-muse-mj_one-aaa111-0\.img$/)
  })

  it('refreshes a cached Exec transport after an account-guard failure', async () => {
    let resolves = 0
    let calls = 0
    const factory = createMuseBoxExecRunner('3', {
      resolve: async () => {
        resolves += 1
        return async () => {
          calls += 1
          if (calls === 1) {
            const err = new Error('guard') as Error & { code: string }
            err.code = 'BOX_EXEC_ACCOUNT_GUARD_FAILED'
            throw err
          }
          return { stdout: JSON.stringify({ ok: true }) }
        }
      },
    })
    const exec = await factory()
    const first = await exec(
      {
        command: '/usr/bin/python3',
        args: ['-I', '/workspace/muse-relay/bin/muse-exec-cli', 'health'],
        cwd: '/tmp',
        environment: {},
      },
      { timeoutMs: 5000 },
    )
    assert.equal(JSON.parse(first.stdout).ok, true)
    assert.equal(resolves, 2)
    assert.equal(calls, 2)
    assert.equal(isStaleBoxExecTransport({ code: 'BOX_EGRESS_CHANGED' }), true)
    assert.equal(isStaleBoxExecTransport({ code: 'BOX_EXEC_TIMEOUT' }), false)
  })

  it('pins each job to the Box it resolved, even if another job resolves later', async () => {
    let started = 0
    let release!: () => void
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve
    })
    const seen: Array<{ box: number; verb: string }> = []
    const factory = createMuseBoxExecRunner('3', {
      resolve: async () => {
        const box = ++started
        if (started >= 2) release()
        await bothStarted
        return async (request) => {
          const verb = String(request.args[2] ?? '')
          seen.push({ box, verb })
          return { stdout: JSON.stringify({ ok: true, box, verb }) }
        }
      },
    })
    const first = await factory()
    const second = await factory()
    const req = {
      command: '/usr/bin/python3',
      args: ['-I', '/workspace/muse-relay/bin/muse-exec-cli', 'submit'],
      cwd: '/tmp',
      environment: {},
    }
    await Promise.all([first(req, { timeoutMs: 5000 }), second(req, { timeoutMs: 5000 })])
    const firstStatus = await first(
      { ...req, args: ['-I', '/workspace/muse-relay/bin/muse-exec-cli', 'status'] },
      { timeoutMs: 5000 },
    )
    const secondStatus = await second(
      { ...req, args: ['-I', '/workspace/muse-relay/bin/muse-exec-cli', 'status'] },
      { timeoutMs: 5000 },
    )
    const firstBox = seen.find((row) => row.verb === 'submit' && row.box === 1)?.box
    const secondBox = seen.find((row) => row.verb === 'submit' && row.box === 2)?.box
    assert.equal(firstBox, 1)
    assert.equal(secondBox, 2)
    assert.equal(JSON.parse(firstStatus.stdout).box, 1)
    assert.equal(JSON.parse(secondStatus.stdout).box, 2)
  })
})

describe('OCV5-750 Gemini r1 fixes', () => {
  const req = (verb: string) => ({
    command: '/usr/bin/python3',
    args: ['-I', '/workspace/muse-relay/bin/muse-exec-cli', verb],
    cwd: '/tmp',
    environment: {},
  })

  it('re-resolves a stale transport only on the first call of a job', async () => {
    let resolves = 0
    let calls = 0
    const factory = createMuseBoxExecRunner('3', {
      resolve: async () => {
        resolves += 1
        return async () => {
          calls += 1
          if (calls === 2) {
            const err = new Error('guard') as Error & { code: string }
            err.code = 'BOX_EXEC_ACCOUNT_GUARD_FAILED'
            throw err
          }
          return { stdout: JSON.stringify({ ok: true }) }
        }
      },
    })
    const exec = await factory()
    await exec(req('submit'), { timeoutMs: 5000 })
    await assert.rejects(exec(req('status'), { timeoutMs: 5000 }), /guard/)
    assert.equal(resolves, 1, 'a mid-job stale transport must not move the job to another Box')
  })

  it('does not call the Box after the caller aborted during resolve', async () => {
    const ac = new AbortController()
    let calls = 0
    const factory = createMuseBoxExecRunner('3', {
      resolve: async () => {
        ac.abort()
        return async () => {
          calls += 1
          return { stdout: '{"ok":true}' }
        }
      },
    })
    const exec = await factory()
    await assert.rejects(exec(req('submit'), { timeoutMs: 5000, signal: ac.signal }), /cancelled/)
    assert.equal(calls, 0)
  })

  it('maps a CLI error printed on stdout (or legacy stderr) to its Muse code', async () => {
    for (const where of ['stdout', 'stderr'] as const) {
      const body = JSON.stringify({
        ok: false,
        code: 'MUSE_RELAY_DOWN',
        message: 'relay unreachable',
      })
      const exec = async () =>
        where === 'stdout' ? { stdout: body } : { stdout: '', stderr: body }
      const dest = await mkdtemp(join(tmpdir(), 'muse-box-exec-'))
      await assert.rejects(
        runBoxExecVideoJob({ exec, spec: spec(), destDir: dest, pollMs: 1 }),
        (err: unknown) => (err as { code?: string }).code === 'MUSE_BRIDGE_OFFLINE',
      )
    }
  })

  it('passes a prompt that starts with "-" as --prompt=<text>', async () => {
    const seen: string[][] = []
    const exec = async (request: BoxCcExecRequest) => {
      seen.push(request.args.slice(2))
      return { stdout: JSON.stringify({ ok: false, code: 'MUSE_CLI_BAD_ARGS', message: 'stop' }) }
    }
    const dest = await mkdtemp(join(tmpdir(), 'muse-box-exec-'))
    await assert.rejects(
      runBoxExecVideoJob({ exec, spec: spec({ prompt: '- a list item prompt' }), destDir: dest }),
    )
    assert.equal(seen[0]![1], '--prompt=- a list item prompt')
  })

  it('reports the submit attempt before the submit call leaves', async () => {
    const order: string[] = []
    const exec = async (request: BoxCcExecRequest) => {
      order.push(String(request.args[2]))
      throw new Error('BOX_EXEC_INCOMPLETE')
    }
    const dest = await mkdtemp(join(tmpdir(), 'muse-box-exec-'))
    await assert.rejects(
      runBoxExecVideoJob({
        exec,
        spec: spec(),
        destDir: dest,
        onSubmitAttempt: () => order.push('attempt'),
      }),
    )
    assert.deepEqual(order.slice(0, 2), ['attempt', 'submit'])
  })
})

describe('OCV5-750 relay Box pinning', () => {
  it('refuses to resolve a Box without OC_MUSE_BOX_EXEC_ACCOUNT_ID (no random Box)', async () => {
    const exec = await createMuseBoxExecRunner('25')()
    await assert.rejects(
      exec({ args: ['muse-exec-cli', '--json', 'health'] } as unknown as BoxCcExecRequest, {
        timeoutMs: 1_000,
      }),
      /OC_MUSE_BOX_EXEC_ACCOUNT_ID is not set/,
    )
  })
})

class FakeTransportError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function relayFake(payload: Buffer, failures: Map<string, string[]>) {
  const digest = createHash('sha256').update(payload).digest('hex')
  const calls: string[][] = []
  const exec = async (request: BoxCcExecRequest) => {
    const verb = request.args[2]!
    const rest = request.args.slice(3)
    calls.push([verb, ...rest])
    const key = verb === 'fetch-chunk' ? `fetch-chunk@${rest[2]}` : verb
    const queue = failures.get(key)
    if (queue && queue.length > 0) throw new FakeTransportError(queue.shift()!)
    if (verb === 'submit')
      return { stdout: JSON.stringify({ ok: true, id: 'rj', status: 'queued' }) }
    if (verb === 'status') {
      return {
        stdout: JSON.stringify({ ok: true, id: 'rj', status: 'done', files: [{ index: 0 }] }),
      }
    }
    if (verb === 'cancel') return { stdout: JSON.stringify({ ok: true }) }
    const offset = Number(rest[2])
    const slice = payload.subarray(offset, offset + Number(rest[3]))
    return {
      stdout: JSON.stringify({
        ok: true,
        offset,
        total: payload.length,
        sha256: digest,
        data: slice.toString('base64'),
      }),
    }
  }
  return { exec, calls, digest }
}

describe('OCV5-750 transient Box Exec failures on read-only relay calls', () => {
  it('classifies transport failures, not relay/CLI errors or aborts', () => {
    assert.equal(isTransientBoxExecReadError(new FakeTransportError('BOX_EXEC_HTTP_417')), true)
    assert.equal(isTransientBoxExecReadError(new FakeTransportError('BOX_EXEC_HTTP_503')), true)
    assert.equal(
      isTransientBoxExecReadError(new FakeTransportError('BOX_EXEC_STREAM_UNKNOWN')),
      true,
    )
    assert.equal(
      isTransientBoxExecReadError(new Error('MUSE_UPSTREAM_ERROR BOX_EXEC_INCOMPLETE')),
      true,
    )
    assert.equal(
      isTransientBoxExecReadError(new FakeTransportError('BOX_EXEC_REQUEST_INVALID')),
      false,
    )
    assert.equal(
      isTransientBoxExecReadError(new FakeTransportError('BOX_EXEC_RESPONSE_TOO_LARGE')),
      false,
    )
    assert.equal(isTransientBoxExecReadError(new MuseError(502, 'MUSE_BAD_OUTPUT', 'x')), false)
    assert.equal(isTransientBoxExecReadError(new Error('ECONNRESET')), false)
    const ac = new AbortController()
    ac.abort()
    assert.equal(
      isTransientBoxExecReadError(new FakeTransportError('BOX_EXEC_HTTP_417'), ac.signal),
      false,
    )
  })

  it('a transient 417 mid-download is retried and the MP4 still reassembles', async () => {
    const payload = Buffer.alloc(BOX_EXEC_CHUNK_BYTES * 3 + 5, 3)
    const failures = new Map([
      [`fetch-chunk@${BOX_EXEC_CHUNK_BYTES * 2}`, ['BOX_EXEC_HTTP_417', 'BOX_EXEC_HTTP_417']],
    ])
    const { exec, calls, digest } = relayFake(payload, failures)
    const slept: number[] = []
    const out = await downloadRelayFile(exec, 'rj', 0, undefined, async (ms) => {
      slept.push(ms)
    })
    assert.equal(out.sha256, digest)
    assert.equal(out.bytes.equals(payload), true)
    assert.deepEqual(slept, [1_000, 2_000])
    assert.equal(calls.filter((c) => c[0] === 'fetch-chunk').length, 4 + 2)
  })

  it('gives up after the bounded retries and surfaces the transport error', async () => {
    const payload = Buffer.alloc(10, 1)
    const n = BOX_EXEC_READ_RETRY_DELAYS_MS.length + 1
    const failures = new Map([['fetch-chunk@0', Array(n).fill('BOX_EXEC_HTTP_417')]])
    const { exec, calls } = relayFake(payload, failures)
    const slept: number[] = []
    await assert.rejects(
      downloadRelayFile(exec, 'rj', 0, undefined, async (ms) => {
        slept.push(ms)
      }),
      /BOX_EXEC_HTTP_417/,
    )
    assert.deepEqual(slept, [...BOX_EXEC_READ_RETRY_DELAYS_MS])
    assert.equal(calls.length, n)
  })

  it('does not retry a non-transient transport error', async () => {
    const failures = new Map([['fetch-chunk@0', ['BOX_EXEC_REQUEST_INVALID']]])
    const { exec, calls } = relayFake(Buffer.alloc(10, 1), failures)
    await assert.rejects(
      downloadRelayFile(exec, 'rj', 0, undefined, async () => {}),
      /REQUEST_INVALID/,
    )
    assert.equal(calls.length, 1)
  })

  it('stops retrying once the job is cancelled during the backoff', async () => {
    const failures = new Map([['fetch-chunk@0', ['BOX_EXEC_HTTP_417', 'BOX_EXEC_HTTP_417']]])
    const { exec, calls } = relayFake(Buffer.alloc(10, 1), failures)
    const ac = new AbortController()
    await assert.rejects(
      downloadRelayFile(exec, 'rj', 0, ac.signal, async () => {
        ac.abort()
      }),
      (err: unknown) => err instanceof MuseError && err.code === 'MUSE_CANCELLED',
    )
    assert.equal(calls.length, 1)
  })

  it('retries a transient status poll but never re-sends submit', async () => {
    const payload = Buffer.alloc(BOX_EXEC_CHUNK_BYTES + 1, 9)
    const failures = new Map([
      ['status', ['BOX_EXEC_HTTP_417']],
      [`fetch-chunk@${BOX_EXEC_CHUNK_BYTES}`, ['BOX_EXEC_HTTP_502']],
    ])
    const { exec, calls, digest } = relayFake(payload, failures)
    const dest = await mkdtemp(join(tmpdir(), 'muse-box-exec-retry-'))
    const result = await runBoxExecVideoJob({
      exec,
      spec: spec(),
      destDir: dest,
      pollMs: 1,
      retrySleep: async () => {},
    })
    assert.equal(result.files[0]!.sha256, digest)
    assert.equal(calls.filter((c) => c[0] === 'submit').length, 1)
    assert.equal(calls.filter((c) => c[0] === 'status').length, 2)
    assert.equal(calls.filter((c) => c[0] === 'cancel').length, 0)
  })

  it('a transient submit failure is not retried (the relay may already hold the job)', async () => {
    const failures = new Map([['submit', ['BOX_EXEC_HTTP_417']]])
    const { exec, calls } = relayFake(Buffer.alloc(10, 1), failures)
    const dest = await mkdtemp(join(tmpdir(), 'muse-box-exec-retry-'))
    await assert.rejects(
      runBoxExecVideoJob({
        exec,
        spec: spec(),
        destDir: dest,
        pollMs: 1,
        retrySleep: async () => {},
      }),
      /BOX_EXEC_HTTP_417/,
    )
    assert.equal(calls.filter((c) => c[0] === 'submit').length, 1)
  })
})

describe('OCV5-750 Gemini r4: read-retry classification, budget, abort', () => {
  it('permanent 4xx and pinned-Box guard failures are not transient; 408/417/425/429 are', () => {
    for (const c of [
      'BOX_EXEC_HTTP_400',
      'BOX_EXEC_HTTP_401',
      'BOX_EXEC_HTTP_403',
      'BOX_EXEC_HTTP_404',
    ]) {
      assert.equal(isTransientBoxExecReadError(new FakeTransportError(c)), false, c)
    }
    for (const c of [
      'BOX_EXEC_HTTP_408',
      'BOX_EXEC_HTTP_417',
      'BOX_EXEC_HTTP_425',
      'BOX_EXEC_HTTP_429',
    ]) {
      assert.equal(isTransientBoxExecReadError(new FakeTransportError(c)), true, c)
    }
    assert.equal(
      isTransientBoxExecReadError(new FakeTransportError('BOX_EXEC_ACCOUNT_GUARD_FAILED')),
      false,
    )
    assert.equal(isTransientBoxExecReadError(new FakeTransportError('BOX_EGRESS_CHANGED')), false)
    // any non-transient token anywhere wins
    assert.equal(
      isTransientBoxExecReadError(
        new Error('BOX_EXEC_HTTP_502 then BOX_EXEC_ACCOUNT_GUARD_FAILED'),
      ),
      false,
    )
  })

  it('a per-job retry budget bounds retries across all chunks', async () => {
    const payload = Buffer.alloc(BOX_EXEC_CHUNK_BYTES * 6, 2)
    const failures = new Map<string, string[]>()
    for (let i = 0; i < 6; i++)
      failures.set(`fetch-chunk@${BOX_EXEC_CHUNK_BYTES * i}`, [
        'BOX_EXEC_HTTP_417',
        'BOX_EXEC_HTTP_417',
      ])
    const { exec } = relayFake(payload, failures)
    const slept: number[] = []
    await assert.rejects(
      downloadRelayFile(exec, 'rj', 0, undefined, async (ms) => {
        slept.push(ms)
      }),
      /BOX_EXEC_HTTP_417/,
    )
    assert.equal(slept.length, BOX_EXEC_READ_RETRY_BUDGET)
  })

  it('the default backoff wakes immediately on abort', async () => {
    const failures = new Map([['fetch-chunk@0', ['BOX_EXEC_HTTP_417', 'BOX_EXEC_HTTP_417']]])
    const { exec } = relayFake(Buffer.alloc(10, 1), failures)
    const ac = new AbortController()
    const t0 = Date.now()
    setTimeout(() => ac.abort(), 50)
    await assert.rejects(
      downloadRelayFile(exec, 'rj', 0, ac.signal),
      (err: unknown) => err instanceof MuseError && err.code === 'MUSE_CANCELLED',
    )
    assert.ok(Date.now() - t0 < 900, `took ${Date.now() - t0}ms`)
  })

  it('status retries stop at the job deadline', async () => {
    let t = 0
    const failures = new Map([['status', Array(4).fill('BOX_EXEC_HTTP_417')]])
    const { exec, calls } = relayFake(Buffer.alloc(10, 1), failures)
    const dest = await mkdtemp(join(tmpdir(), 'muse-box-exec-retry-'))
    await assert.rejects(
      runBoxExecVideoJob({
        exec,
        spec: spec(),
        destDir: dest,
        pollMs: 1,
        now: () => t,
        retrySleep: async (ms) => {
          t += ms + 6 * 60_000 // jump past the native deadline
        },
      }),
      /BOX_EXEC_HTTP_417|MUSE_TIMEOUT/,
    )
    assert.ok(calls.filter((c) => c[0] === 'status').length <= 2)
  })
})
