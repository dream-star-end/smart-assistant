import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyDelegateContextToken } from '../delegateContext.js'
/**
 * OCV5-570 (plan v3.6 §7.3 row 1): every CCB request to egress carries the turn's canonical traceId
 * as `x-openclaude-trace-id`, through the same per-turn `ANTHROPIC_CUSTOM_HEADERS` hot update that
 * carries the authority / lease headers (CCB unchanged). Only when CCB's upstream is egress; a
 * trace-less turn clears it; an invalid value is dropped, never rejected.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/ccbTraceHeader.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TRACE_ID_HEADER } from '@openclaude/protocol'

import { TURN_LEASE_HEADER } from '../modelCatalogClient.js'
import { SubprocessRunner, type TurnModelAuthority } from '../subprocessRunner.js'
import { _buildAnthropicCustomHeadersEnv, _ccbUpstreamIsEgress } from '../subprocessSpawnConfig.js'

const T1 = '0a1b2c3d4e5f60718293a4b5c6d7e8f9'
const T2 = 'ffeeddccbbaa99887766554433221100'
const DESCRIPTOR = {
  canonicalModel: 'glm-5.2',
  contextWindow: 1_000_000,
  capabilityZero: true,
  supportsThinking: true,
  supportsVision: false,
  supportedEfforts: ['high', 'max'],
} as const
const authority = (lease: string): TurnModelAuthority => ({
  authorityEnvelope: 'AUTH',
  leaseEnvelope: lease,
  executionDescriptor: DESCRIPTOR,
})

/** A runner whose fake process only records stdin writes (no real CCB). */
function harness(upstreamIsEgress: boolean) {
  const runner = new SubprocessRunner({
    sessionKey: 'test',
    agentId: 'test',
    agentBaseDir: '/tmp',
    model: 'glm-5.2',
    config: {} as never,
  } as never)
  const writes: string[] = []
  const r = runner as unknown as Record<string, unknown>
  r.proc = {
    stdin: {
      write(chunk: string, cb?: (err?: Error | null) => void) {
        writes.push(chunk)
        queueMicrotask(() => cb?.(null))
        return true
      },
      destroy() {},
    },
    kill() {},
  }
  r.spawnedExecutionDescriptor = DESCRIPTOR
  r.spawnedUpstreamIsEgress = upstreamIsEgress
  return { runner, writes }
}

function customHeaders(line: string): Record<string, string> {
  const msg = JSON.parse(line) as { variables: Record<string, string> }
  const out: Record<string, string> = {}
  for (const l of (msg.variables.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n')) {
    const i = l.indexOf(':')
    if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim()
  }
  return out
}

describe('CCB turn trace header', () => {
  it('builder: a valid trace is one more `Name: Value` line; undefined adds nothing; invalid is dropped, not rejected', () => {
    assert.deepEqual(_buildAnthropicCustomHeadersEnv({ lease: 'L' }, T1).ANTHROPIC_CUSTOM_HEADERS.split('\n'), [
      `${TURN_LEASE_HEADER}: L`,
      `${TRACE_ID_HEADER}: ${T1}`,
    ])
    assert.equal(_buildAnthropicCustomHeadersEnv(undefined, T1).ANTHROPIC_CUSTOM_HEADERS, `${TRACE_ID_HEADER}: ${T1}`)
    assert.equal(_buildAnthropicCustomHeadersEnv({ lease: 'L' }).ANTHROPIC_CUSTOM_HEADERS, `${TURN_LEASE_HEADER}: L`)
    for (const bad of ['short', `${T1}\nx-forged: 1`, 'has space in it 0000', 'ü'.repeat(20)]) {
      assert.equal(
        _buildAnthropicCustomHeadersEnv({ lease: 'L' }, bad).ANTHROPIC_CUSTOM_HEADERS,
        `${TURN_LEASE_HEADER}: L`,
        JSON.stringify(bad),
      )
    }
  })

  it('upstream is egress only when the CCB base URL is the gateway egress base', () => {
    const gw = { ANTHROPIC_BASE_URL: 'http://172.31.0.1:18892/' }
    assert.equal(_ccbUpstreamIsEgress({ ANTHROPIC_BASE_URL: 'http://172.31.0.1:18892' }, gw), true)
    assert.equal(_ccbUpstreamIsEgress({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' }, gw), false)
    assert.equal(_ccbUpstreamIsEgress({ ANTHROPIC_BASE_URL: '' }, gw), false, 'oauth-direct clears it')
    assert.equal(_ccbUpstreamIsEgress({}, gw), false)
    assert.equal(_ccbUpstreamIsEgress({ ANTHROPIC_BASE_URL: 'http://172.31.0.1:18892' }, {}), false)
  })

  it('each turn carries its own trace; a trace-less turn clears it (no leak into the next turn)', async () => {
    const { runner, writes } = harness(true)
    runner.setTraceId(T1)
    await runner.submit('one', 'req-1', authority('LEASE1'))
    assert.equal(customHeaders(writes[0]!)[TRACE_ID_HEADER], T1)
    assert.equal(customHeaders(writes[0]!)[TURN_LEASE_HEADER], 'LEASE1')
    runner.setTraceId(T2)
    await runner.submit('two', 'req-2', authority('LEASE2'))
    assert.equal(customHeaders(writes[2]!)[TRACE_ID_HEADER], T2)
    runner.setTraceId(undefined)
    await runner.submit('three', 'req-3', authority('LEASE3'))
    assert.equal(customHeaders(writes[4]!)[TRACE_ID_HEADER], undefined)
    assert.equal(customHeaders(writes[4]!)[TURN_LEASE_HEADER], 'LEASE3')
  })

  it('a lease renewal mid-turn keeps the trace', async () => {
    const { runner, writes } = harness(true)
    runner.setTraceId(T1)
    await runner.submit('one', 'req-1', authority('LEASE1'))
    await runner.updateTurnLease('LEASE1b')
    const renewed = customHeaders(writes[2]!)
    assert.equal(renewed[TURN_LEASE_HEADER], 'LEASE1b')
    assert.equal(renewed[TRACE_ID_HEADER], T1)
  })

  it('a CCB whose upstream is not egress never gets the trace header', async () => {
    const { runner, writes } = harness(false)
    runner.setTraceId(T1)
    await runner.submit('one', 'req-1', authority('LEASE1'))
    await runner.updateTurnLease('LEASE1b')
    for (const w of [writes[0]!, writes[2]!]) assert.equal(customHeaders(w)[TRACE_ID_HEADER], undefined)
  })
})

it('delegate context uses the CCB submit snapshot even when current trace changes during runtime resolution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-605-ccb-'))
  try {
    const { runner } = harness(true)
    const file = join(dir, 'context')
    ;(runner as any).delegateContextFile = file
    runner.setTraceId(T1)
    const first = runner.submit('one', 'request-1', authority('L1'))
    runner.setTraceId(T2)
    await first
    assert.equal(verifyDelegateContextToken((await readFile(file, 'utf8')).trim())?.traceId, T1)
    await runner.submit('two', 'request-2', authority('L2'), undefined, T2)
    assert.equal(verifyDelegateContextToken((await readFile(file, 'utf8')).trim())?.traceId, T2)
    await runner.submit('legacy', 'request-3', authority('L3'), undefined, null)
    assert.equal(verifyDelegateContextToken((await readFile(file, 'utf8')).trim())?.traceId, undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
