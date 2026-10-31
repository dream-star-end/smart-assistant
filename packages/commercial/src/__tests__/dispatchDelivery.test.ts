import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { WebSocket } from 'ws'
import { ContainerLinkRegistry, getContainerLinkHandle } from '../ws/containerLink.js'
import { _OutboundPersistQueueCoordinator } from '../ws/userChatBridge.js'
import type { Queryable } from '../dispatch/turnDispatchStore.js'

class Transport extends EventEmitter {
  readyState = WebSocket.OPEN
  sent: Record<string, unknown>[] = []
  send(data: unknown, _opts: unknown, done?: (err?: Error) => void) {
    this.sent.push(JSON.parse(String(data)))
    done?.()
  }
  terminate() { this.readyState = WebSocket.CLOSED; this.emit('close') }
}
const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Queryable
const wire = (frame: unknown) => Buffer.from(JSON.stringify(frame))
const hello = { type: 'inbound.hello', peers: [{ peerId: 'session', agentId: 'main' }] }
const turn = { type: 'inbound.message', peer: { id: 'session' }, clientMessageId: 'message' }

test('OCV5-682: a fresh dispatch bypasses a held replay drain and keeps its receipt route', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const registry = new ContainerLinkRegistry(pool)
  registry.beforeReplay = () => gate
  const physical = new Transport()
  try {
    const socket = await registry.attach(42n, 7, () => physical as unknown as WebSocket)
    getContainerLinkHandle(socket)!.activate()
    const received: unknown[] = []
    socket.on('message', data => received.push(JSON.parse(String(data))))
    socket.send(wire(hello), {})
    await new Promise(resolve => setImmediate(resolve))
    socket.send(wire(turn), {})
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(physical.sent.map(frame => frame.type), ['inbound.message'])
    physical.emit('message', wire({ type: 'outbound.control.turn_dispatch_receipt', sessionId: 'session', clientMessageId: 'message' }), false)
    assert.equal(received.length, 1)
  } finally { release(); await registry.shutdown() }
})

test('OCV5-682: replay proceeds from PG after its bounded drain wait', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const registry = new ContainerLinkRegistry(pool, null, { replayDrainTimeoutMs: 5 })
  const physical = new Transport()
  let called: unknown[] = []
  registry.beforeReplay = (uid, cid) => { called = [uid, cid]; return gate }
  try {
    const socket = await registry.attach(42n, 7, () => physical as unknown as WebSocket)
    getContainerLinkHandle(socket)!.activate()
    const sent = new Promise<void>((resolve, reject) => socket.send(wire(hello), {}, err => err ? reject(err) : resolve()))
    const completed = await Promise.race([sent.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 100))])
    assert.equal(completed, true, 'a blocked persistence drain cannot suspend replay indefinitely')
    assert.deepEqual(called, [42n, 7])
    assert.equal(physical.sent[0]?.type, 'inbound.hello')
  } finally { release(); await registry.shutdown() }
})

test('OCV5-682: replay drain excludes another user and container persistence queue', async () => {
  const coordinator = new _OutboundPersistQueueCoordinator()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  coordinator.enqueue('99:7:agent:main:webchat:dm:other', 1, () => gate, () => {})
  coordinator.enqueue('42:8:agent:main:webchat:dm:other', 1, () => gate, () => {})
  coordinator.enqueue('42:7:agent:main:webchat:dm:session', 1, async () => {}, () => {})
  try {
    const completed = await Promise.race([coordinator.drain('42:7:').then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 100))])
    assert.equal(completed, true, 'an unrelated save must not hold this replay')
  } finally { release(); await coordinator.drain() }
})
