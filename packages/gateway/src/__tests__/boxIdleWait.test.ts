import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { beginIdleWait, endIdleWait } from '../boxIdleWait.js'
import { autoResumeFromHello } from '../wsConnection.js'
import type { AgentSession } from '../sessionTypes.js'

function fixture() {
  const runner = { isRunning: false }
  const session = { runner, currentTurnStatus: null } as unknown as AgentSession
  const events: unknown[] = []
  const emit = (e: any) => { session.currentTurnStatus = e.status; events.push(e.status) }
  return { session, runner, events, emit }
}
async function reconnect(session: AgentSession) {
  const frames: any[] = []
  const ws = Object.assign(new EventEmitter(), { readyState: 1, send: (s: string) => frames.push(JSON.parse(s)) })
  await autoResumeFromHello.call({
    getWsUserId: () => '3', sessions: { getByKey: () => session },
    clientsByPeer: new Map(), _activeTurnReplaysServed: new WeakMap(), _pendingPermissions: new Map(),
    _outboundRing: { peekReplay: () => ({ ok: true, sent: [], evicted: [] }) },
    _recordRingEvictions() {}, log: { info() {}, warn() {} },
  } as any, [{ peerId: 'idle-wait', agentId: 'main', lastFrameSeq: 0 }], ws as any)
  ws.emit('close')
  return frames.filter(f => f.type === 'outbound.turn_status').map(f => f.status)
}

test('OCV5-747 concurrent idle waiters retain live status and reconnect hello until last exit', async () => {
  const { session, events, emit } = fixture()
  const first = beginIdleWait(session, emit), second = beginIdleWait(session, emit)
  assert.deepEqual(await reconnect(session), ['compacting'])
  first()
  assert.equal(session._idleWaiters?.size, 1)
  assert.equal(session.currentTurnStatus, 'compacting')
  assert.deepEqual(events, ['compacting', 'compacting'])
  assert.deepEqual(await reconnect(session), ['compacting'])
  second()
  assert.deepEqual(events, ['compacting', 'compacting', null])
  assert.deepEqual(await reconnect(session), [])
})

test('OCV5-747 idle cleanup cannot clear a different owner or a handed-off user compact', async () => {
  const { session, runner, events, emit } = fixture()
  const first = beginIdleWait(session, emit)
  session.currentTurnStatus = 'engine_starting'
  first()
  assert.equal(session.currentTurnStatus, 'engine_starting')
  assert.deepEqual(events, ['compacting'])
  const second = beginIdleWait(session, emit), third = beginIdleWait(session, emit)
  endIdleWait(session) // actual submit handoff, before the user engine starts
  runner.isRunning = true
  session.currentTurnStatus = 'compacting' // now owned by the user turn
  const before = [...events]
  second(); third(); first()
  assert.deepEqual(events, before)
  assert.equal(session.currentTurnStatus, 'compacting')
  assert.deepEqual(await reconnect(session), ['compacting'])
})
