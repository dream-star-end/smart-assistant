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
  const first = beginIdleWait(session, emit)
  const second = beginIdleWait(session, emit)
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
  const second = beginIdleWait(session, emit)
  const third = beginIdleWait(session, emit)
  endIdleWait(session) // actual submit handoff, before the user engine starts
  runner.isRunning = true
  session.currentTurnStatus = 'compacting' // now owned by the user turn
  const before = [...events]
  second(); third(); first()
  assert.deepEqual(events, before)
  assert.equal(session.currentTurnStatus, 'compacting')
  assert.deepEqual(await reconnect(session), ['compacting'])
})

test('OCV5-747 crash fixture installs all 3 fault seams and checkpoint restore clears post-fault rollback tombstones', async () => {
  const { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const { readIdleRollbacks, writeIdleRollback } = await import('@openclaude/storage')
  const { installIdleFaultFixture, saveIdleCheckpoint, restoreIdleCheckpoint } = await import('./fixtures/idleCrashFixture.js')

  const root = mkdtempSync(join(tmpdir(), 'oc-idle-crash-fixture-'))
  try {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
    const candidate = join(root, 'candidate')
    const targetRel = 'claude-code-best/src/services/compact/idleRecover.ts'
    mkdirSync(dirname(join(candidate, targetRel)), { recursive: true })
    cpSync(join(repoRoot, targetRel), join(candidate, targetRel))
    const installed = installIdleFaultFixture(candidate, join(root, 'control'))
    assert.notEqual(installed.before, installed.after)
    const injected = readFileSync(join(candidate, targetRel), 'utf8')
    for (const seam of ['before-artifact', 'native-half', 'receipt-lost']) {
      assert.ok(injected.includes(`testIdleFault('${seam}'`), `missing fault seam ${seam}`)
    }

    const home = join(root, 'home')
    const sessionKey = 'agent:main:webchat:dm:crash-checkpoint'
    const nativeId = '74700000-0000-4000-8000-000000000099'
    const opId = 'f'.repeat(64)
    mkdirSync(join(home, 'idle-ops', encodeURIComponent(sessionKey)), { recursive: true })
    mkdirSync(join(home, 'idle-native', encodeURIComponent(nativeId)), { recursive: true })
    mkdirSync(join(home, 'idle-candidates'), { recursive: true })
    mkdirSync(join(home, 'claude-config', 'projects', 'p'), { recursive: true })
    writeFileSync(join(home, 'idle-ops', encodeURIComponent(sessionKey), 'rev.json'), JSON.stringify({ idleTurnKey: opId }))
    writeFileSync(join(home, 'idle-native', encodeURIComponent(nativeId), 'rev.json'), JSON.stringify({ v: 1, opId, revision: 'rev', sessionId: nativeId }))
    writeFileSync(join(home, 'idle-candidates', `${encodeURIComponent(sessionKey)}.json`), JSON.stringify({ sessionKey }))
    writeFileSync(join(home, 'claude-config', 'projects', 'p', `${nativeId}.jsonl`), '{"uuid":"74700000-0000-4000-8000-000000000002"}\n')

    const atFault = saveIdleCheckpoint(home, join(root, 'checkpoint'), sessionKey, nativeId)
    writeIdleRollback(home, { v: 1, sessionId: nativeId, opId, restoreTip: '74700000-0000-4000-8000-000000000002' })
    assert.equal(readIdleRollbacks(home, nativeId).length, 1)
    restoreIdleCheckpoint(atFault)
    assert.equal(readIdleRollbacks(home, nativeId).length, 0, 'restoreIdleCheckpoint must remove post-checkpoint idle-abandoned tombstones')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
