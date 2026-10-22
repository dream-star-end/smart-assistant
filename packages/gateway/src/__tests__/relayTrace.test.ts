/**
 * OCV5-580 (plan v3.6 §7.3 rows 2-3): container Grok / Codex relays send the running turn's trace
 * to egress as `x-openclaude-trace-id`, found only from what the request itself carries (Grok route
 * token in the path; Codex `x-codex-turn-metadata` turn_id / root_turn_id / pending thread). A
 * caller-supplied trace header is never forwarded; no match sends no header.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/relayTrace.test.ts
 */
import * as assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { TRACE_ID_HEADER } from '@openclaude/protocol'

import { CodexAppServerRunner } from '../engine/codexAppServerRunner.js'
import { GrokAdapter } from '../engine/grokAdapter.js'
import type { EngineCreateOpts } from '../engine/registry.js'
import {
  _resetRelayTraceForTests,
  adoptCodexTurnTrace,
  bindCodexThreadTrace,
  bindGrokRouteTrace,
  codexRelayTrace,
  grokRelayTrace,
} from '../relayTrace.js'
import { V3_CODEX_RELAY_PREFIX, handleV3CodexRelayLocal } from '../v3CodexRelay.js'
import { V5_GROK_RELAY_PREFIX, handleV5GrokRelayLocal } from '../v5GrokRelay.js'

const T1 = '0a1b2c3d4e5f60718293a4b5c6d7e8f9'
const T2 = 'ffeeddccbbaa99887766554433221100'
const TOKEN = 'a'.repeat(64)
const meta = (m: Record<string, string>) => JSON.stringify({ session_id: 'th-1', ...m })

afterEach(() => _resetRelayTraceForTests())

describe('relay trace registry', () => {
  it('Grok: the route token names the running turn; a stale release keeps the newer binding', () => {
    const path = `${V5_GROK_RELAY_PREFIX}/route/${TOKEN}/v1/chat/completions`
    assert.equal(grokRelayTrace(path), undefined)
    const release1 = bindGrokRouteTrace(TOKEN, T1)
    assert.equal(grokRelayTrace(path), T1)
    assert.equal(grokRelayTrace(`${V5_GROK_RELAY_PREFIX}/route/${'b'.repeat(64)}/v1`), undefined)
    const release2 = bindGrokRouteTrace(TOKEN, T2)
    release1()
    assert.equal(grokRelayTrace(path), T2)
    release2()
    assert.equal(grokRelayTrace(path), undefined)
    bindGrokRouteTrace(TOKEN, T1)
    bindGrokRouteTrace(TOKEN, 'not-a-trace')
    assert.equal(grokRelayTrace(path), undefined, 'a trace-less turn clears the token')
  })

  it('Codex: pending thread, then its own turn id; late requests keep their turn; others get nothing', () => {
    const release1 = bindCodexThreadTrace('th-1', T1)
    assert.equal(codexRelayTrace(meta({ thread_id: 'th-1', turn_id: 'u-1' })), T1, 'before turn/start answers')
    adoptCodexTurnTrace('th-1', 'u-1')
    assert.equal(codexRelayTrace(meta({ thread_id: 'th-1', turn_id: 'u-1' })), T1)
    assert.equal(codexRelayTrace(meta({ thread_id: 'th-1', turn_id: 'u-other' })), undefined, 'adopted thread, unknown turn')
    assert.equal(codexRelayTrace(meta({ thread_id: 'th-sub', turn_id: 'u-sub', root_turn_id: 'u-1' })), T1, 'subagent')
    release1()
    bindCodexThreadTrace('th-1', T2)
    adoptCodexTurnTrace('th-1', 'u-2')
    assert.equal(codexRelayTrace(meta({ thread_id: 'th-1', turn_id: 'u-1' })), T1, 'late request of turn 1')
    assert.equal(codexRelayTrace(meta({ thread_id: 'th-1', turn_id: 'u-2' })), T2)
    for (const bad of [undefined, '', 'not json', '[]', 'null', JSON.stringify({ turn_id: 7 }), `{"turn_id":"u-1"${' '.repeat(9000)}}`]) {
      assert.equal(codexRelayTrace(bad), undefined, String(bad).slice(0, 20))
    }
    assert.equal(codexRelayTrace(['a', 'b']), undefined)
  })

  it('Codex: the recent-turn map is bounded', () => {
    for (let i = 0; i < 600; i++) {
      bindCodexThreadTrace('th-1', T1)
      adoptCodexTurnTrace('th-1', `u-${i}`)
    }
    assert.equal(codexRelayTrace(meta({ thread_id: 'th-x', turn_id: 'u-0' })), undefined)
    assert.equal(codexRelayTrace(meta({ thread_id: 'th-x', turn_id: 'u-599' })), T1)
  })
})

async function relayOnce(
  handler: 'grok' | 'codex',
  path: string,
  headers: Record<string, string>,
): Promise<Headers> {
  let captured: Headers | undefined
  const cfg = { masterBaseUrl: 'http://master.internal:18791', containerToken: 'oc-v5.container' }
  const fetchImpl = async (_input: string, init: RequestInit) => {
    captured = new Headers(init.headers)
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const server = createServer((req, res) => {
    void (handler === 'grok'
      ? handleV5GrokRelayLocal(req, res, cfg, { fetchImpl })
      : handleV3CodexRelayLocal(req, res, cfg, { fetchImpl }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const port = (server.address() as AddressInfo).port
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: '{}' })
    assert.equal(res.status, 200)
    await res.text()
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
  assert.ok(captured)
  return captured
}

describe('container relays', () => {
  it('Grok relay: drops a caller trace header and sends the route token turn trace', async () => {
    const path = `${V5_GROK_RELAY_PREFIX}/route/${TOKEN}/v1/chat/completions`
    const forged = { [TRACE_ID_HEADER]: T2, 'content-type': 'application/json' }
    assert.equal((await relayOnce('grok', path, forged)).get(TRACE_ID_HEADER), null)
    bindGrokRouteTrace(TOKEN, T1)
    assert.equal((await relayOnce('grok', path, forged)).get(TRACE_ID_HEADER), T1)
  })

  it('Codex relay: drops a caller trace header and sends the turn trace from x-codex-turn-metadata', async () => {
    const path = `${V3_CODEX_RELAY_PREFIX}/backend-api/codex/responses`
    const withMeta = {
      [TRACE_ID_HEADER]: T2,
      'x-codex-turn-metadata': meta({ thread_id: 'th-1', turn_id: 'u-1' }),
    }
    assert.equal((await relayOnce('codex', path, withMeta)).get(TRACE_ID_HEADER), null)
    bindCodexThreadTrace('th-1', T1)
    adoptCodexTurnTrace('th-1', 'u-1')
    const fwd = await relayOnce('codex', path, withMeta)
    assert.equal(fwd.get(TRACE_ID_HEADER), T1)
    assert.equal(fwd.get('x-codex-turn-metadata'), withMeta['x-codex-turn-metadata'])
    const noMeta = await relayOnce('codex', `${V3_CODEX_RELAY_PREFIX}/backend-api/codex/ps/mcp`, { [TRACE_ID_HEADER]: T1 })
    assert.equal(noMeta.get(TRACE_ID_HEADER), null, 'a non-turn request gets no trace')
  })
})

describe('CodexAppServerRunner registers its turn', () => {
  it('pending before turn/start answers, by turn id after, released at turn end (turn id kept)', async () => {
    const baseTmp = await mkdtemp(join(tmpdir(), 'codex-relaytrace-'))
    const runner = new CodexAppServerRunner({ sessionKey: 'test', agentId: 'test', cwd: baseTmp })
    runner.on('error', () => {})
    // biome-ignore lint/suspicious/noExplicitAny: white-box drive of private surface
    const r = runner as any
    r.ensureSpawned = async () => {
      r.proc = { killed: false, stdin: { write: () => true } }
      r.initialized = true
      r.attached = true
      r.threadId = 'th-run'
      r.spawnedProviderSignature = r.codexRouteSignature()
    }
    const seen: Array<string | undefined> = []
    r.sendRequest = async (method: string) => {
      if (method !== 'turn/start') return {}
      seen.push(codexRelayTrace(meta({ thread_id: 'th-run', turn_id: 'u-run' })))
      setImmediate(() => {
        seen.push(codexRelayTrace(meta({ thread_id: 'th-run', turn_id: 'u-run' })))
        r.currentTurnCompleter?.resolve({ status: 'completed', durationMs: 1 })
      })
      return { turn: { id: 'u-run' } }
    }
    try {
      runner.setTraceId(T1)
      await r.runTurn('hi', 'req-1')
      assert.deepEqual(seen, [T1, T1])
      assert.equal(codexRelayTrace(meta({ thread_id: 'th-run', turn_id: 'u-run' })), T1, 'late request')
      assert.equal(codexRelayTrace(meta({ thread_id: 'th-run', turn_id: 'u-next' })), undefined, 'thread released')
    } finally {
      await rm(baseTmp, { recursive: true, force: true })
    }
  })
})

describe('GrokAdapter registers its turn', () => {
  it('the route token names the turn while its process runs, and nothing after', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-grok-relaytrace-'))
    const fake = join(dir, 'fake-grok.cjs')
    const started = join(dir, 'started')
    await writeFile(fake, `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.FAKE_GROK_STARTED, '1')
setTimeout(() => console.log(JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', usage: { input_tokens: 1, output_tokens: 1 } })), 400)
`)
    await chmod(fake, 0o755)
    const prevBin = process.env.OC_GROK_CLI_BIN
    const prevStarted = process.env.FAKE_GROK_STARTED
    process.env.OC_GROK_CLI_BIN = fake
    process.env.FAKE_GROK_STARTED = started
    const path = `${V5_GROK_RELAY_PREFIX}/route/${TOKEN}/v1/chat/completions`
    try {
      const adapter = new GrokAdapter({
        sessionKey: 'agent:main:webchat:dm:grok-relaytrace',
        agentId: 'main',
        agentBaseDir: dir,
        config: {
          version: 1,
          gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
          auth: { mode: 'subscription', claudeCodePath: '' },
          sessions: { dbPath: '' },
          defaults: { model: 'grok-build' },
        },
        model: 'grok-build',
        effortLevel: 'high',
      } as unknown as EngineCreateOpts)
      adapter.setGrokRoute({ baseUrl: `http://127.0.0.1:18789${V5_GROK_RELAY_PREFIX}/route/${TOKEN}/v1`, routeToken: TOKEN })
      adapter.on('error', () => {})
      adapter.setTraceId(T1)
      const run = adapter.submitTurn({
        input: 'hi',
        requestId: 'b'.repeat(32),
        onEvent: () => {},
        sessionTotals: { totalCostUSD: 0, turns: 0 },
        toolUseIdToName: new Map(),
      })
      await run.submitted
      const deadline = Date.now() + 5000
      while (!(await stat(started).then(() => true, () => false))) {
        assert.ok(Date.now() < deadline, 'fake grok never started')
        await new Promise((r) => setTimeout(r, 10))
      }
      assert.equal(grokRelayTrace(path), T1, 'while the turn process runs')
      assert.ok(await run.summary)
      await adapter.waitForOutputDrain()
      assert.equal(grokRelayTrace(path), undefined, 'after the turn')
    } finally {
      if (prevBin === undefined) Reflect.deleteProperty(process.env, 'OC_GROK_CLI_BIN')
      else process.env.OC_GROK_CLI_BIN = prevBin
      if (prevStarted === undefined) Reflect.deleteProperty(process.env, 'FAKE_GROK_STARTED')
      else process.env.FAKE_GROK_STARTED = prevStarted
      await rm(dir, { recursive: true, force: true })
    }
  })
})
