/**
 * engine=ccb official-cc switch (`OC_CCB_OFFICIAL_CC`).
 *
 * Cursor Sand keeps `OC_CURSOR_SAND_OFFICIAL_CC`. This file pins the CCB
 * catalog-model lane: flag default, spawn preconditions, spawn-env fingerprint
 * recycle, and lease renew that cannot hot-apply on stock Claude Code.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/ccbOfficialCcHarness.test.ts
 */
import * as assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { CcbAdapter } from '../engine/ccbAdapter.js'
import {
  MODEL_EXECUTION_DESCRIPTOR_ENV,
  SubprocessRunner,
  assertOfficialCcSpawnPreconditions,
  buildOfficialCcProxySpawnEnv,
  ccbOfficialCcEnabled,
  officialCcProxySpawnFingerprint,
  resolveCcbHarness,
} from '../subprocessRunner.js'

const DESCRIPTOR = {
  canonicalModel: 'glm-5.3-zai',
  contextWindow: 1_000_000,
  capabilityZero: true,
  supportsThinking: true,
  supportsVision: false,
  supportedEfforts: ['high', 'max'],
} as const

const previousFlag = process.env.OC_CCB_OFFICIAL_CC
afterEach(() => {
  if (previousFlag === undefined) delete process.env.OC_CCB_OFFICIAL_CC
  else process.env.OC_CCB_OFFICIAL_CC = previousFlag
})

describe('OC_CCB_OFFICIAL_CC flag', () => {
  it('defaults to CCB and selects official-cc only when the flag is exactly 1', () => {
    delete process.env.OC_CCB_OFFICIAL_CC
    assert.equal(ccbOfficialCcEnabled(), false)
    assert.equal(resolveCcbHarness(undefined), 'ccb')

    process.env.OC_CCB_OFFICIAL_CC = '0'
    assert.equal(ccbOfficialCcEnabled(), false)
    assert.equal(resolveCcbHarness(undefined), 'ccb')

    process.env.OC_CCB_OFFICIAL_CC = 'true'
    assert.equal(ccbOfficialCcEnabled(), false)

    process.env.OC_CCB_OFFICIAL_CC = '1'
    assert.equal(ccbOfficialCcEnabled(), true)
    assert.equal(resolveCcbHarness(undefined), 'official-cc')
    assert.equal(resolveCcbHarness('ccb'), 'ccb', 'explicit harness wins over the flag')
    assert.equal(resolveCcbHarness('official-cc'), 'official-cc')
  })

  it('CcbAdapter follows the flag when opts.harness is omitted', () => {
    delete process.env.OC_CCB_OFFICIAL_CC
    const off = new CcbAdapter({} as never, {
      on() { return this },
    } as never)
    assert.equal((off as unknown as { harness: string }).harness, 'ccb')

    process.env.OC_CCB_OFFICIAL_CC = '1'
    const on = new CcbAdapter({} as never, {
      on() { return this },
    } as never)
    assert.equal((on as unknown as { harness: string }).harness, 'official-cc')
    assert.equal((on as unknown as { authorityEngine: string }).authorityEngine, 'ccb')
  })
})

describe('assertOfficialCcSpawnPreconditions', () => {
  it('allows engine=ccb proxy lane without Cursor Sand loopback', () => {
    assert.doesNotThrow(() => assertOfficialCcSpawnPreconditions({ authorityEngine: 'ccb' }))
    assert.doesNotThrow(() => assertOfficialCcSpawnPreconditions({}))
  })

  it('still requires Cursor Sand override when authorityEngine is cursor', () => {
    assert.throws(
      () => assertOfficialCcSpawnPreconditions({ authorityEngine: 'cursor' }),
      /OFFICIAL_CC_REQUIRES_LOCAL_CURSOR_SAND_LOOPBACK/,
    )
    assert.doesNotThrow(() => assertOfficialCcSpawnPreconditions({
      authorityEngine: 'cursor',
      providerEnvOverride: { ANTHROPIC_AUTH_TOKEN: 'cursor-sand-loopback' },
    }))
  })

  it('rejects hermetic advisor and remote ssh for official-cc', () => {
    assert.throws(
      () => assertOfficialCcSpawnPreconditions({ hermeticNoTools: true }),
      /OFFICIAL_CC_REQUIRES_LOCAL_NON_HERMETIC/,
    )
    assert.throws(
      () => assertOfficialCcSpawnPreconditions({ executionTarget: { kind: 'remote' } }),
      /OFFICIAL_CC_REQUIRES_LOCAL_NON_HERMETIC/,
    )
  })
})

describe('official-cc CCB proxy spawn env', () => {
  it('fingerprints header+descriptor changes so submit can recycle', () => {
    const a = buildOfficialCcProxySpawnEnv({
      headers: { lease: 'LEASE1' },
      executionDescriptorEnv: JSON.stringify(DESCRIPTOR),
    })
    const b = buildOfficialCcProxySpawnEnv({
      headers: { lease: 'LEASE2' },
      executionDescriptorEnv: JSON.stringify(DESCRIPTOR),
    })
    const same = buildOfficialCcProxySpawnEnv({
      headers: { lease: 'LEASE1' },
      executionDescriptorEnv: JSON.stringify(DESCRIPTOR),
    })
    assert.equal(a.CLAUDE_CODE_MAX_RETRIES, '0')
    assert.ok(a[MODEL_EXECUTION_DESCRIPTOR_ENV])
    assert.equal(officialCcProxySpawnFingerprint(a), officialCcProxySpawnFingerprint(same))
    assert.notEqual(officialCcProxySpawnFingerprint(a), officialCcProxySpawnFingerprint(b))
  })

  it('lease renew on the CCB proxy lane does not throw and invalidates the fingerprint', async () => {
    const runner = new SubprocessRunner({
      sessionKey: 'test',
      agentId: 'test',
      agentBaseDir: '/tmp',
      model: 'glm-5.3-zai',
      config: {} as never,
      harness: 'official-cc',
      authorityEngine: 'ccb',
    } as never)
    await runner.updateTurnLease('LEASE-NEW')
    const pending = (runner as unknown as {
      pendingOfficialSpawnEnv: Record<string, string> | null
      spawnedOfficialHeaderFingerprint: string | undefined
    })
    assert.ok(pending.pendingOfficialSpawnEnv?.ANTHROPIC_CUSTOM_HEADERS?.includes('LEASE-NEW'))
    assert.equal(pending.spawnedOfficialHeaderFingerprint, undefined)
  })

  it('keeps the Cursor Sand lease no-op throw when the loopback binding is invalid', async () => {
    const runner = new SubprocessRunner({
      sessionKey: 'test',
      agentId: 'test',
      agentBaseDir: '/tmp',
      model: 'cursor-fable-5.1-high',
      config: {} as never,
      harness: 'official-cc',
      authorityEngine: 'cursor',
      providerEnvOverride: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/route/short',
        ANTHROPIC_AUTH_TOKEN: 'wrong',
      },
    } as never)
    await assert.rejects(runner.updateTurnLease('LEASE2'), /OFFICIAL_CC_LEASE_NOOP_OUTSIDE_CURSOR_SAND/)
  })
})
