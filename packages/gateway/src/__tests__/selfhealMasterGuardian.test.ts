import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Logger } from '../logger.js'
import type { HostActionReceipt } from '../selfheal/hostAction.js'
import { SelfhealMasterGuardian, masterGuardianConfigFromEnv } from '../selfheal/masterGuardian.js'

const HOST_ACTION = { host: 'kl-mirror', keyPath: '/root/.secrets/action_key' }

function receipt(
  outcome: HostActionReceipt['outcome'],
  action?: 'noop' | 'restart',
): HostActionReceipt {
  const exit = outcome === 'completed' ? 0 : outcome === 'rejected' ? 66 : 70
  return {
    opcode: 'ensure-v5-active-master-v1',
    outcome,
    exit,
    host: 'kl-mirror',
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    detail: {
      opcode: 'ensure-v5-active-master-v1',
      outcome: outcome === 'action_failed' ? 'failed' : outcome,
      exit,
      detail: action ? { action } : {},
    },
  }
}

function captureLog() {
  const entries: Array<{ level: string; msg: string }> = []
  const write = (level: string) => (msg: string) => {
    entries.push({ level, msg })
  }
  const log = {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  } as Logger
  return { log, entries }
}

describe('masterGuardianConfigFromEnv', () => {
  it('is default-off and requires the existing restricted host-action config', () => {
    assert.equal(masterGuardianConfigFromEnv({}), null)
    assert.equal(
      masterGuardianConfigFromEnv({
        OC_SELFHEAL_MASTER_GUARDIAN_ENABLED: '0',
        OC_SELFHEAL_ACTION_HOST: 'kl-mirror',
        OC_SELFHEAL_ACTION_KEY: '/k',
      }),
      null,
    )
    assert.equal(
      masterGuardianConfigFromEnv({
        OC_SELFHEAL_MASTER_GUARDIAN_ENABLED: '1',
        OC_SELFHEAL_ACTION_HOST: 'kl-mirror',
      }),
      null,
    )
    assert.deepEqual(
      masterGuardianConfigFromEnv({
        OC_SELFHEAL_MASTER_GUARDIAN_ENABLED: '1',
        OC_SELFHEAL_ACTION_HOST: 'kl-mirror',
        OC_SELFHEAL_ACTION_KEY: '/k',
      }),
      { host: 'kl-mirror', keyPath: '/k' },
    )
  })
})

describe('SelfhealMasterGuardian', () => {
  it('sends only the fixed ensure opcode and classifies noop/restart/failures', async () => {
    const cases = [
      { value: receipt('completed', 'noop'), level: 'debug' },
      { value: receipt('completed', 'restart'), level: 'warn' },
      { value: receipt('rejected'), level: 'info' },
      { value: receipt('action_failed'), level: 'error' },
    ] as const
    for (const fixture of cases) {
      const { log, entries } = captureLog()
      let opcode = ''
      const guardian = new SelfhealMasterGuardian({
        hostAction: HOST_ACTION,
        log,
        execute: async (sent) => {
          opcode = sent
          return fixture.value
        },
      })
      assert.equal(await guardian.runOnce(), true)
      assert.equal(opcode, 'ensure-v5-active-master-v1')
      assert.equal(entries.at(-1)?.level, fixture.level)
    }
  })

  it('never overlaps runs and stop prevents new work', async () => {
    let release!: (value: HostActionReceipt) => void
    const blocked = new Promise<HostActionReceipt>((resolve) => {
      release = resolve
    })
    let calls = 0
    const guardian = new SelfhealMasterGuardian({
      hostAction: HOST_ACTION,
      execute: async () => {
        calls++
        return blocked
      },
    })
    const first = guardian.runOnce()
    await Promise.resolve()
    assert.equal(await guardian.runOnce(), false)
    assert.equal(calls, 1)
    release(receipt('completed', 'noop'))
    assert.equal(await first, true)
    guardian.stop()
    assert.equal(await guardian.runOnce(), false)
    assert.equal(calls, 1)
  })

  it('start schedules immediately and stop prevents a later timer tick', async () => {
    let firstCall!: () => void
    const called = new Promise<void>((resolve) => {
      firstCall = resolve
    })
    let calls = 0
    const guardian = new SelfhealMasterGuardian({
      hostAction: HOST_ACTION,
      intervalMs: 10,
      execute: async () => {
        calls++
        firstCall()
        return receipt('completed', 'noop')
      },
    })
    guardian.start()
    await called
    guardian.stop()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(calls, 1)
  })
})
