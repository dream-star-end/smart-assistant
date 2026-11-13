import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SubprocessRunner } from '../subprocessRunner.js'
import { DELEGATE_CONTEXT_TTL_MS, verifyDelegateContextToken } from '../delegateContext.js'

test('successful same-turn lease renewal rolls the caller token beyond 24h without changing identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-lease-caller-'))
  const originalNow = Date.now
  let now = 1_780_000_000_000
  Date.now = () => now
  try {
    const runner = new SubprocessRunner({
      sessionKey: 'agent:main:webchat:dm:lease-context', agentId: 'main', agentBaseDir: dir,
      harness: 'official-cc', boxResidentCc: true, config: {} as never,
    } as never)
    const internals = runner as unknown as {
      delegateContextFile: string; delegateContextTraceId: string
    }
    internals.delegateContextFile = join(dir, 'delegate-context')
    internals.delegateContextTraceId = 'a'.repeat(32)
    await runner.updateTurnLease('first')
    const firstToken = readFileSync(internals.delegateContextFile, 'utf8').trim()
    const first = verifyDelegateContextToken(firstToken, now)!
    assert.equal(first.v, 1)
    now += 24 * 60 * 60_000
    assert.equal(verifyDelegateContextToken(firstToken, now), null)
    await runner.updateTurnLease('renewed')
    const renewed = verifyDelegateContextToken(readFileSync(internals.delegateContextFile, 'utf8').trim(), now)!
    assert.equal(renewed.exp, now + DELEGATE_CONTEXT_TTL_MS)
    assert.equal(renewed.agentId, first.agentId)
    assert.equal(renewed.sessionKey, first.sessionKey)
    assert.equal(renewed.traceId, first.traceId)
    assert.equal(renewed.v, 1)
  } finally {
    Date.now = originalNow
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rolling lease renewal preserves the immutable advisor receipt token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-lease-advisor-'))
  const originalNow = Date.now
  let now = 1_780_000_000_000
  Date.now = () => now
  try {
    const runner = new SubprocessRunner({
      sessionKey: 'agent:main:webchat:dm:lease-advisor', agentId: 'main', agentBaseDir: dir,
      harness: 'official-cc', boxResidentCc: true, config: {} as never,
    } as never)
    const internals = runner as unknown as {
      delegateContextFile: string; refreshDelegateContext(traceId: string): void
    }
    internals.delegateContextFile = join(dir, 'delegate-context')
    runner.setConsultTurn({ turnKey: 'b'.repeat(64), turnIndex: 7, configVersion: 'config-v1' })
    internals.refreshDelegateContext('a'.repeat(32))
    const original = readFileSync(internals.delegateContextFile, 'utf8')
    now += 30 * 60_000
    await runner.updateTurnLease('renewed')
    assert.equal(readFileSync(internals.delegateContextFile, 'utf8'), original)
    assert.equal(verifyDelegateContextToken(original, now)?.v, 2)
  } finally {
    Date.now = originalNow
    rmSync(dir, { recursive: true, force: true })
  }
})
