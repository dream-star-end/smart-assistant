/**
 * OCV5-570, official-cc lane: the stock Claude Code CLI has no stdin env update, so the turn's
 * canonical traceId reaches egress only through the spawn env. The proxy lane already respawns per
 * turn (lease + oc_turn_key are in its spawn fingerprint); the trace joins that fingerprint and the
 * spawn's `ANTHROPIC_CUSTOM_HEADERS`, only when the process's upstream is egress.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/ccbOfficialTraceHeader.test.ts
 */
import './helpers/subprocessRunnerSpawnEnvIsolate.js'

import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { afterEach, describe, it } from 'node:test'
import { TRACE_ID_HEADER } from '@openclaude/protocol'

import { TURN_LEASE_HEADER } from '../modelCatalogClient.js'
import {
  SubprocessRunner,
  __setCcbSpawnForTests,
  buildOfficialCcProxySpawnEnv,
  officialCcProxySpawnFingerprint,
  type TurnModelAuthority,
} from '../subprocessRunner.js'
import { _withTraceIdHeader } from '../subprocessSpawnConfig.js'

const T1 = '0a1b2c3d4e5f60718293a4b5c6d7e8f9'
const T2 = 'ffeeddccbbaa99887766554433221100'
const EGRESS = 'http://172.31.0.1:18892'
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

const prevBase = process.env.ANTHROPIC_BASE_URL
afterEach(() => {
  __setCcbSpawnForTests(null)
  Reflect.deleteProperty(process.env, 'OPENCLAUDE_OFFICIAL_CLAUDE_PATH')
  if (prevBase === undefined) Reflect.deleteProperty(process.env, 'ANTHROPIC_BASE_URL')
  else process.env.ANTHROPIC_BASE_URL = prevBase
})

class FakeProc extends EventEmitter {
  pid = 4243
  killed = false
  stdout = Object.assign(new EventEmitter(), { setEncoding() { return this } })
  stderr = Object.assign(new EventEmitter(), { setEncoding() { return this } })
  stdin = Object.assign(new EventEmitter(), {
    write: (_line: string, cb?: (err?: Error | null) => void) => {
      if (cb) setImmediate(() => cb())
      return true
    },
  })
  kill(): boolean {
    this.killed = true
    return true
  }
}

function headerLines(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const l of (env.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n')) {
    const i = l.indexOf(':')
    if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim()
  }
  return out
}

/** First official-cc proxy-lane spawn of a real runner start path; returns the spawn env. */
async function spawnOnce(opts: { upstream: string; traceId: string | undefined }) {
  // Any existing absolute file passes the binary check; the spawn itself is faked.
  process.env.OPENCLAUDE_OFFICIAL_CLAUDE_PATH = process.execPath
  process.env.ANTHROPIC_BASE_URL = EGRESS
  const envs: Array<Record<string, string | undefined>> = []
  __setCcbSpawnForTests((spawnOpts) => {
    envs.push({ ...(spawnOpts.env as Record<string, string | undefined>) })
    return new FakeProc() as never
  })
  const runner = new SubprocessRunner({
    sessionKey: 'agent:main:webchat:dm:official-trace',
    agentId: 'main',
    agentBaseDir: '/tmp',
    model: 'glm-5.2',
    harness: 'official-cc',
    authorityEngine: 'ccb',
    providerEnvOverride: { ANTHROPIC_BASE_URL: opts.upstream },
    config: {
      auth: { mode: 'subscription' },
      defaults: { model: 'glm-5.2', permissionMode: 'default' },
      terminal: { type: 'local' },
    },
  } as never)
  runner.setTraceId(opts.traceId)
  await runner.submit('one', 'req-1', authority('LEASE1'), 'a'.repeat(64))
  return { runner, envs }
}

describe('official-cc turn trace header', () => {
  it('_withTraceIdHeader appends one valid trace line and drops an invalid one', () => {
    assert.equal(_withTraceIdHeader(`${TURN_LEASE_HEADER}: L`, T1), `${TURN_LEASE_HEADER}: L\n${TRACE_ID_HEADER}: ${T1}`)
    assert.equal(_withTraceIdHeader('', T1), `${TRACE_ID_HEADER}: ${T1}`)
    assert.equal(_withTraceIdHeader(`${TURN_LEASE_HEADER}: L`, undefined), `${TURN_LEASE_HEADER}: L`)
    assert.equal(_withTraceIdHeader(`${TURN_LEASE_HEADER}: L`, `${T1}\nx-forged: 1`), `${TURN_LEASE_HEADER}: L`)
  })

  it('the trace is part of the spawn fingerprint; no trace keeps the old fingerprint', () => {
    const env = buildOfficialCcProxySpawnEnv({
      headers: { lease: 'LEASE1' },
      executionDescriptorEnv: JSON.stringify(DESCRIPTOR),
    })
    assert.equal(officialCcProxySpawnFingerprint(env), JSON.stringify(env))
    assert.equal(officialCcProxySpawnFingerprint(env, 'short'), JSON.stringify(env), 'invalid trace is ignored')
    assert.equal(officialCcProxySpawnFingerprint(env, T1), officialCcProxySpawnFingerprint(env, T1))
    assert.notEqual(officialCcProxySpawnFingerprint(env, T1), officialCcProxySpawnFingerprint(env, T2))
    assert.notEqual(officialCcProxySpawnFingerprint(env, T1), officialCcProxySpawnFingerprint(env))
  })

  it('an egress-bound spawn carries the lease and the turn trace', async () => {
    const { runner, envs } = await spawnOnce({ upstream: EGRESS, traceId: T1 })
    assert.equal(envs.length, 1)
    const h = headerLines(envs[0]!)
    assert.equal(h[TURN_LEASE_HEADER], 'LEASE1')
    assert.equal(h[TRACE_ID_HEADER], T1)
    const r = runner as unknown as { spawnedOfficialHeaderFingerprint: string | undefined; pendingOfficialSpawnEnv: Record<string, string> }
    assert.equal(r.spawnedOfficialHeaderFingerprint, officialCcProxySpawnFingerprint(r.pendingOfficialSpawnEnv, T1))
    assert.equal(r.pendingOfficialSpawnEnv.ANTHROPIC_CUSTOM_HEADERS?.includes(TRACE_ID_HEADER), false)
  })

  it('a spawn whose upstream is not egress, or a trace-less turn, gets no trace header', async () => {
    const direct = await spawnOnce({ upstream: 'https://api.deepseek.com/anthropic', traceId: T1 })
    assert.equal(headerLines(direct.envs[0]!)[TRACE_ID_HEADER], undefined)
    assert.equal(headerLines(direct.envs[0]!)[TURN_LEASE_HEADER], 'LEASE1')
    const none = await spawnOnce({ upstream: EGRESS, traceId: undefined })
    assert.equal(headerLines(none.envs[0]!)[TRACE_ID_HEADER], undefined)
  })
})
