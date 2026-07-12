import * as assert from 'node:assert/strict'
/**
 * oc-selfheal CLI tests (block C / design §C2): protocol shape over a mock
 * broker socket, argument surface, and exit-code semantics. The real CLI
 * binary (ops/oc-selfheal.mjs) is spawned — no broker code involved.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/selfhealCli.test.ts
 */
import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { type Server, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'

const CLI = resolve(import.meta.dirname, '../../../../ops/oc-selfheal.mjs')
const SOCK = join(mkdtempSync(join(tmpdir(), 'oc-cli-')), 'broker.sock')

/** Requests the mock broker received, in order. */
const received: Array<Record<string, unknown>> = []
/** Next response the mock broker returns (JSON line). */
let nextResponse: Record<string, unknown> = { ok: true, status: 'ok' }

let server: Server

before(async () => {
  server = createServer((conn) => {
    let buf = ''
    conn.setEncoding('utf8')
    conn.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      received.push(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>)
      conn.write(`${JSON.stringify(nextResponse)}\n`)
      conn.end()
    })
  })
  await new Promise<void>((r) => server.listen(SOCK, r))
})

after(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        env: { ...process.env, OC_SELFHEAL_BROKER_SOCK: SOCK, OC_SELFHEAL_CLI_TIMEOUT_MS: '5000' },
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: number }).code === 'number'
            ? ((err as { code?: number }).code as number)
            : err
              ? 1
              : 0
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })
}

const SHA = 'a'.repeat(40)

describe('oc-selfheal — request protocol per subcommand', () => {
  it('context sends {repairId, actionKind:context}', async () => {
    nextResponse = { ok: true, status: 'ok', detail: { context: { incident: 1 } } }
    const r = await runCli(['context', 'r-ctx'])
    assert.equal(r.code, 0)
    assert.deepEqual(received.at(-1), { repairId: 'r-ctx', actionKind: 'context', params: {} })
    assert.deepEqual(JSON.parse(r.stdout).detail, { context: { incident: 1 } })
  })

  it('verify sends the sha', async () => {
    nextResponse = { ok: true, status: 'verified', detail: { allPassed: true } }
    const r = await runCli(['verify', 'r-v', SHA])
    assert.equal(r.code, 0)
    assert.deepEqual(received.at(-1), {
      repairId: 'r-v',
      actionKind: 'verify',
      params: { sha: SHA },
    })
  })

  it('cutover defaults verificationRef to the repairId', async () => {
    nextResponse = { ok: false, status: 'pending_release', detail: { sha: SHA } }
    const r = await runCli(['cutover', 'r-c', SHA])
    assert.equal(r.code, 0, 'pending_release is the expected posture — exit 0')
    assert.deepEqual(received.at(-1), {
      repairId: 'r-c',
      actionKind: 'cutover',
      params: { sha: SHA, verificationRef: 'r-c' },
    })
  })

  it('cutover honors an explicit verificationRef', async () => {
    nextResponse = { ok: false, status: 'pending_release' }
    await runCli(['cutover', 'r-c2', SHA, 'ref-9'])
    assert.deepEqual((received.at(-1) as { params: unknown }).params, {
      sha: SHA,
      verificationRef: 'ref-9',
    })
  })

  it('report sends outcome/message (+optional detail)', async () => {
    nextResponse = { ok: true, status: 'reported' }
    await runCli(['report', 'r-r', 'progress', 'halfway there'])
    assert.deepEqual(received.at(-1), {
      repairId: 'r-r',
      actionKind: 'report',
      params: { outcome: 'progress', message: 'halfway there' },
    })
    await runCli(['report', 'r-r', 'failed', 'gave up', 'stack trace here'])
    assert.deepEqual((received.at(-1) as { params: unknown }).params, {
      outcome: 'failed',
      message: 'gave up',
      detail: 'stack trace here',
    })
  })
})

describe('oc-selfheal — exit codes and argument validation', () => {
  it('a broker rejection exits 1', async () => {
    nextResponse = { ok: false, status: 'rejected', detail: { reason: 'nope' } }
    const r = await runCli(['context', 'r-bad'])
    assert.equal(r.code, 1)
    assert.equal(JSON.parse(r.stdout).status, 'rejected')
  })

  it('usage errors exit 2 without touching the socket', async () => {
    const before = received.length
    for (const args of [
      [],
      ['unknown-cmd', 'x'],
      ['context'],
      ['verify', 'r-1', 'not-a-sha'],
      ['report', 'r-1', 'exploded', 'msg'],
      ['report', 'r-1', 'done'],
      ['context', 'bad id!'],
    ]) {
      const r = await runCli(args)
      assert.equal(r.code, 2, JSON.stringify(args))
    }
    assert.equal(received.length, before, 'no request was sent for usage errors')
  })

  it('an unreachable socket exits 1 with a clear error', async () => {
    const r = await new Promise<{ code: number; stderr: string }>((resolvePromise) => {
      execFile(
        process.execPath,
        [CLI, 'context', 'r-x'],
        { env: { ...process.env, OC_SELFHEAL_BROKER_SOCK: '/nonexistent/broker.sock' } },
        (err, _stdout, stderr) => {
          resolvePromise({
            code: err ? ((err as { code?: number }).code ?? 1) : 0,
            stderr: String(stderr),
          })
        },
      )
    })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /cannot reach broker socket/)
  })

  it('--help exits 0 and documents every subcommand', async () => {
    const r = await runCli(['--help'])
    assert.equal(r.code, 0)
    for (const cmd of ['context', 'verify', 'cutover', 'report']) {
      assert.ok(r.stdout.includes(cmd), cmd)
    }
  })
})
