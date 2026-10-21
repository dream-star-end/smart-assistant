import assert from 'node:assert/strict'
// OCV5-559: hot log level. system_settings.log_level drives every registered shared level
// (gateway + commercial in master); "env" returns to the start values; read errors keep levels.
import { describe, test } from 'node:test'
import { registeredLogLevels } from '@openclaude/kernel'
// the master loads the gateway logger through gateway; load it here the same way it registers
import { gatewayLogLevel } from '../../../gateway/src/logger.js'
import {
  type LogLevelSetting,
  applyLogLevelSetting,
  startLogLevelSyncPoller,
} from '../logging/logLevelSync.js'
import { type Logger, commercialLogLevel, createLogger } from '../logging/logger.js'

const quiet: Logger = createLogger({ level: 'error', out: () => {} })

describe('log level hot setting', () => {
  test('both master loggers are registered and follow the setting; env restores start values', () => {
    const startC = commercialLogLevel.get()
    const startG = gatewayLogLevel.get()
    try {
      assert.ok('commercial' in registeredLogLevels() && 'gateway' in registeredLogLevels())
      const levels = applyLogLevelSetting('debug')
      assert.equal(commercialLogLevel.get(), 'debug')
      assert.equal(gatewayLogLevel.get(), 'debug')
      assert.equal(levels.commercial, 'debug')
      applyLogLevelSetting('env')
      assert.equal(commercialLogLevel.get(), startC)
      assert.equal(gatewayLogLevel.get(), startG)
    } finally {
      applyLogLevelSetting('env')
    }
  })

  test('a shared-level logger changes output immediately', () => {
    const lines: string[] = []
    const log = createLogger({
      out: (l) => {
        lines.push(l)
      },
    })
    try {
      applyLogLevelSetting('error')
      log.warn('dropped')
      applyLogLevelSetting('debug')
      log.debug('kept')
    } finally {
      applyLogLevelSetting('env')
    }
    assert.deepEqual(
      lines.map((l) => JSON.parse(l).msg),
      ['kept'],
    )
  })

  test('poller: applies at start and on change, keeps levels when the read fails', async () => {
    let value: LogLevelSetting = 'warn'
    let fail = false
    const p = startLogLevelSyncPoller({
      read: async () => {
        if (fail) throw new Error('pg down')
        return value
      },
      intervalMs: 60_000,
      log: quiet,
    })
    try {
      await p.tick()
      assert.equal(commercialLogLevel.get(), 'warn')
      value = 'trace'
      await p.tick()
      assert.equal(gatewayLogLevel.get(), 'trace')
      fail = true
      await assert.doesNotReject(p.tick())
      assert.equal(commercialLogLevel.get(), 'trace', 'a failed read changes nothing')
      fail = false
      value = 'env'
      await p.tick()
      assert.notEqual(commercialLogLevel.get(), 'trace')
    } finally {
      p.stop()
      applyLogLevelSetting('env')
    }
  })

  test('Codex r1: a PUT-applied level is re-synced when the DB goes back to the value the poller last read', async () => {
    let value: LogLevelSetting = 'info'
    const p = startLogLevelSyncPoller({ read: async () => value, intervalMs: 60_000, log: quiet })
    try {
      await p.tick()
      assert.equal(commercialLogLevel.get(), 'info')
      applyLogLevelSetting('debug') // admin PUT in this process
      value = 'info' // another process writes the old value back
      await p.tick()
      assert.equal(commercialLogLevel.get(), 'info')
      assert.equal(gatewayLogLevel.get(), 'info')
    } finally {
      p.stop()
      applyLogLevelSetting('env')
    }
  })

  test('an unknown level is rejected and changes nothing', () => {
    const before = registeredLogLevels()
    assert.throws(() => applyLogLevelSetting('loud' as LogLevelSetting), TypeError)
    assert.deepEqual(registeredLogLevels(), before)
  })
})
