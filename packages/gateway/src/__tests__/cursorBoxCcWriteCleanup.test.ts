import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { runBoxCcBridge } from '../engine/cursorBoxCcBridge.js'
import { BOX_CC_STOP_SCRIPT, type BoxCcExecRequest } from '../engine/cursorBoxCcExec.js'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(5)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

async function refusedWrite(entry: 'held' | 'ready', stopFailure?: 'body' | 'network',
  ending: 'error' | 'clean' | 'early-clean' | 'early-error' = 'error') {
  const home = mkdtempSync(join(tmpdir(), 'ocv5-527-write-cleanup-'))
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let out = ''
  let err = ''
  stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
  stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
  const choose = barrier()
  const launched = barrier()
  const ready = barrier()
  const stopped = barrier()
  const aborted = barrier()
  const writing = barrier()
  const writeReply = barrier()
  let launch!: ReadableStreamDefaultController<Uint8Array>
  let stopBody!: ReadableStreamDefaultController<Uint8Array>
  const original = new Error('original launch abort after refused write')
  const stopError = new Error('stop transport/body error')
  let launches = 0
  let writes = 0
  let stops = 0
  let settled = false
  stderr.on('data', () => { if (err.includes('BOX_INTERACTIVE_READY')) ready.release() })
  const fetchImpl = async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(Buffer.from(init.body as Uint8Array).subarray(5).toString()) as BoxCcExecRequest
    if (body.environment.OC_BOX_CC_SEQ !== undefined) {
      writes++
      writing.release()
      if (ending.startsWith('early-')) {
        if (ending === 'early-error') launch.error(original)
        else {
          launch.enqueue(Uint8Array.from(frame({ exitEvent: { exitCode: 0 } })))
          launch.close()
        }
        await writeReply.promise
      }
      return new Response(Uint8Array.from(frame({ exitEvent: { exitCode: 1 } })))
    }
    if (body.args.includes(BOX_CC_STOP_SCRIPT)) {
      stops++
      stopped.release()
      if (stopFailure === 'network') throw stopError
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stopBody = controller } }))
    }
    launches++
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      launch = controller
      init.signal?.addEventListener('abort', () => {
        if (ending === 'error') controller.error(original)
        else if (ending === 'clean') {
          controller.enqueue(Uint8Array.from(frame({ exitEvent: { exitCode: 0 } })))
          controller.close()
        }
        aborted.release()
      }, { once: true })
      launched.release()
    } }))
  }
  const bridge = runBoxCcBridge({
    control: { execUrl: 'https://fixture.invalid/exec', execToken: 'fixture', networkToken: 'fixture',
      remoteClaude: '/fixture/claude', fifo: '/tmp/oc-box-cc-0123456789abcdef.fifo', cwd: '/fixture' },
    args: ['--model', 'box-claude-opus-5-5'], stdin, stdout, stderr, fetchImpl,
    loginStateDir: home, env: {}, login: {
      choose: async () => { await choose.promise; return { profile: 'default', source: 'master' } },
      report: async () => {},
    },
  }).then((code) => { settled = true; return { code, error: undefined } },
    (error: unknown) => { settled = true; return { code: undefined, error } })
  try {
    const line = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'refused exactly once' } })}\n`
    if (entry === 'held') {
      stdin.write(line)
      // Hold login selection until the real input pump has buffered its first line.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    choose.release()
    await launched.promise
    launch.enqueue(Uint8Array.from(frame({ stderrEvent: { data: 'BOX_INTERACTIVE_READY\n' } })))
    await ready.promise
    if (entry === 'ready') stdin.write(line)
    if (ending.startsWith('early-')) {
      await writing.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(settled, false, 'bridge must join the delayed write after the launch stream ends')
      writeReply.release()
    }
    await stopped.promise
    await aborted.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (!stopFailure) {
      assert.equal(settled, false, `${entry}: bridge settled before the existing stop response body completed`)
      stopBody.close()
    } else if (stopFailure === 'body') stopBody.error(stopError)
    const outcome = await bridge
    if (ending === 'error' || ending === 'early-error') {
      assert.equal(outcome.error, original, 'cleanup must preserve the original failed-write rejection')
      assert.equal(outcome.code, undefined)
    } else {
      assert.equal(outcome.error, undefined)
      assert.equal(outcome.code, 1, 'a clean host exit cannot hide a refused write')
    }
    assert.equal(writes, 1, 'an explicit refused write is never replayed')
    assert.equal(launches, 1, 'the failed turn never starts another host')
    assert.equal(stops, 1)
    assert.equal((err.match(/BOX_CC_WRITE_FAILED/g) ?? []).length, 1)
    assert.equal(out, '', 'the refused line produced no result')
  } finally {
    choose.release()
    writeReply.release()
    try { stopBody?.close() } catch { /* already settled or failed */ }
    stdin.destroy()
    await bridge
    rmSync(home, { recursive: true, force: true })
  }
}

for (const entry of ['held', 'ready'] as const) {
  test(`refused Box write joins the stop response body before settling: ${entry}`, { timeout: 5_000 }, async () => {
    await refusedWrite(entry)
  })
}
for (const failure of ['body', 'network'] as const) {
  test(`failed Box write preserves its original rejection when stop ${failure} fails`, { timeout: 5_000 }, async () => {
    await refusedWrite('held', failure)
  })
}

for (const entry of ['held', 'ready'] as const) {
  for (const ending of ['clean', 'early-clean', 'early-error'] as const) {
    test(`refused Box write stays failed across ${ending} launch completion: ${entry}`, { timeout: 5_000 }, async () => {
      await refusedWrite(entry, undefined, ending)
    })
  }
}
for (const failure of ['body', 'network'] as const) {
  test(`refused Box write keeps nonzero exit when stop ${failure} fails`, { timeout: 5_000 }, async () => {
    await refusedWrite('held', failure, 'clean')
  })
}
