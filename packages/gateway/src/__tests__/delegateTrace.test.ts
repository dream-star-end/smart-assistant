import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import type { request } from 'undici'
import {
  mintDelegateTrace,
  cancelDelegateTraceWait,
  registerDelegateTraceWait,
} from '../delegateTrace.js'
import { verifyDelegateContextToken } from '../delegateContext.js'
import { CodexAppServerRunner } from '../engine/codexAppServerRunner.js'
import { writeCodexDelegateContext } from '../engine/codexDelegateContext.js'

const parent = 'a'.repeat(32)
const child = 'b'.repeat(32)
const input = {
  sessionKey: 'agent:coding-assistant:delegate:main:trace',
  agentId: 'coding-assistant',
  delegateRunId: 'dlg-proof',
  parentTraceId: parent,
}
const env = {
  OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:1',
  OPENCLAUDE_V3_CONTAINER_TOKEN: 'synthetic-proof',
}

test('trace client is bounded, does not retry and preserves the frozen parent', async () => {
  let calls = 0
  const fetcher = (async (_url: unknown, options: any) => {
    calls++
    assert.deepEqual(JSON.parse(options.body), input)
    assert.equal(options.headersTimeout, 3000)
    assert.ok(options.signal)
    return {
      statusCode: 200,
      body: Readable.from([JSON.stringify({ traceId: child, parentTraceId: parent })]),
    }
  }) as unknown as typeof request
  assert.deepEqual(await mintDelegateTrace(input, { env, fetcher }), {
    traceId: child,
    parentTraceId: parent,
  })
  assert.equal(calls, 1)
  assert.equal(await mintDelegateTrace(input, { env: {}, fetcher }), null)
  assert.equal(calls, 1)
  for (const [statusCode, result] of [
    [503, {}],
    [200, { traceId: child, parentTraceId: 'c'.repeat(32) }],
    [200, { traceId: 'request-id', parentTraceId: parent }],
    [200, { traceId: 'x'.repeat(9000) }],
  ] as const) {
    const broken = (async () => ({
      statusCode,
      body: Readable.from([JSON.stringify(result)]),
    })) as unknown as typeof request
    await assert.rejects(mintDelegateTrace(input, { env, fetcher: broken }))
  }
})

test('pre-spawn cancellation is separate from capacity waiters and scoped by host and child', () => {
  const host = { _delegateQueueWaiters: new Map() }
  const a = registerDelegateTraceWait(host, 'child-a')
  const b = registerDelegateTraceWait(host, 'child-b')
  assert.equal(host._delegateQueueWaiters.size, 0)
  assert.equal(cancelDelegateTraceWait({}, 'child-a'), false)
  assert.equal(cancelDelegateTraceWait(host, 'child-a'), true)
  assert.equal(a.isAborted(), true)
  assert.equal(b.isAborted(), false)
  a.close()
  b.close()
  assert.equal(cancelDelegateTraceWait(host, 'child-a'), false)
})

test('Codex queued turns retain separate traces across await and a following trace-less turn clears context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-605-codex-'))
  try {
    const file = join(dir, 'context')
    const runner = new CodexAppServerRunner({
      sessionKey: 'proof',
      agentId: 'coding-assistant',
      cwd: dir,
    })
    const r = runner as any
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const observed: Array<string | undefined> = []
    r.runTurn = async (
      _prompt: string,
      _request: string,
      _policy: unknown,
      _retry: unknown,
      traceId: string | null,
    ) => {
      if (observed.length === 0) await barrier
      writeCodexDelegateContext({
        file,
        agentId: 'coding-assistant',
        sessionKey: 'proof',
        depth: 0,
        traceId: traceId ?? undefined,
      })
      observed.push(verifyDelegateContextToken((await readFile(file, 'utf8')).trim())?.traceId)
    }
    runner.setTraceId(parent)
    const first = runner.submit('first', 'request-1')
    runner.setTraceId(child)
    const second = runner.submit('second', 'request-2')
    const third = runner.submit('legacy', 'request-3', undefined, false, undefined, null)
    runner.setTraceId('c'.repeat(32))
    release()
    await Promise.all([first, second, third])
    assert.deepEqual(observed, [parent, child, undefined])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
