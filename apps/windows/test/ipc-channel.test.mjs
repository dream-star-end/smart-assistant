import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { detectHostIpcChannel, announceHostReady } from '../src/host/ipcChannel.mjs'
import { HostToElectron } from '../src/host/ipc.mjs'

test('detectHostIpcChannel prefers parentPort over process.send', () => {
  const port = new EventEmitter()
  const sent = []
  port.postMessage = (msg) => sent.push(msg)
  const proc = {
    parentPort: port,
    send() { sent.push('send') },
    on() {},
  }
  const channel = detectHostIpcChannel(proc)
  assert.equal(channel.kind, 'parentPort')
  announceHostReady(channel)
  assert.equal(sent[0].type, HostToElectron.READY)
})

test('detectHostIpcChannel falls back to process.send for child_process.fork', () => {
  const proc = new EventEmitter()
  const sent = []
  proc.send = (msg) => sent.push(msg)
  const channel = detectHostIpcChannel(proc)
  assert.equal(channel.kind, 'process.send')
  channel.send({ type: 'hello' })
  assert.deepEqual(sent, [{ type: 'hello' }])
})

test('detectHostIpcChannel returns null when no IPC exists', () => {
  assert.equal(detectHostIpcChannel({}), null)
})
