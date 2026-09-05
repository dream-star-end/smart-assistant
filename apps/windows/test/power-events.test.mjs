import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { createPowerEventBridge, normalizePowerEvent } from '../src/powerEvents.mjs'

test('normalizePowerEvent maps online/offline to network_change', () => {
  assert.equal(normalizePowerEvent('suspend'), 'suspend')
  assert.equal(normalizePowerEvent('resume'), 'resume')
  assert.equal(normalizePowerEvent('offline'), 'network_change')
  assert.equal(normalizePowerEvent('online'), 'network_change')
  assert.equal(normalizePowerEvent('network_change'), 'network_change')
  assert.equal(normalizePowerEvent('other'), null)
})

test('E11 injected event source drives suspend/resume/network_change hooks', () => {
  const calls = []
  const source = new EventEmitter()
  const bridge = createPowerEventBridge({
    onSuspend: () => calls.push('suspend'),
    onResume: () => calls.push('resume'),
    onNetworkChange: () => calls.push('net'),
  })
  bridge.attachSource(source)
  source.emit('suspend')
  source.emit('resume')
  source.emit('offline')
  source.emit('online')
  assert.deepEqual(calls, ['suspend', 'resume', 'net', 'net'])
  bridge.detach()
  source.emit('suspend')
  assert.deepEqual(calls, ['suspend', 'resume', 'net', 'net'])
})
