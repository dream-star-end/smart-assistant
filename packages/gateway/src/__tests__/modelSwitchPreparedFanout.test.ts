/**
 * Native model-switch prepare is a long-running compact. The completion
 * frame must not be pinned to the originating WebSocket: mobile visibility
 * probes and proxy idle routinely close that socket before compact returns.
 * Pin the fanout/ring helper structurally so a later refactor cannot revert
 * to `ws.send` as the only reply path.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { preparedModelSwitchCatchupFrame } from '../server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverSrc = readFileSync(join(__dirname, '..', 'server.ts'), 'utf8')

test('structural: prepare_model_switch replies through _sendStampedSessionFrame', () => {
  const startMarker = "} else if ((frame as any).type === 'control.session.prepare_model_switch') {"
  const startIdx = serverSrc.indexOf(startMarker)
  assert.ok(startIdx >= 0, 'prepare_model_switch handler not found')
  const compactMarker = "} else if ((frame as any).type === 'control.session.compact') {"
  const endIdx = serverSrc.indexOf(compactMarker, startIdx)
  assert.ok(endIdx > startIdx, 'prepare_model_switch handler terminator not found')
  const body = serverSrc.slice(startIdx, endIdx)

  const fanoutCalls = body.match(/_sendStampedSessionFrame\(/g) ?? []
  assert.equal(
    fanoutCalls.length,
    1,
    `prepare_model_switch must fan out prepared via _sendStampedSessionFrame exactly once, got ${fanoutCalls.length}`,
  )
  assert.match(
    body,
    /const reply = \(payload: Record<string, unknown>\) => \{/,
    'prepare_model_switch must keep a reply() closure so failed/completed share one delivery path',
  )
  assert.equal(
    body.includes("type: 'outbound.model_switch.prepared'"),
    true,
    'prepared frame type must stay outbound.model_switch.prepared',
  )
})

test('structural: hello catch-up emits preparedModelSwitchCatchupFrame', () => {
  const startMarker = "private async autoResumeFromHello("
  const startIdx = serverSrc.indexOf(startMarker)
  assert.ok(startIdx >= 0, 'autoResumeFromHello not found')
  const tail = serverSrc.slice(startIdx, startIdx + 12_000)
  assert.equal(
    tail.includes('preparedModelSwitchCatchupFrame(session)'),
    true,
    'hello must catch up a prepared model switch even when ring replay is no_buffer',
  )
})

test('preparedModelSwitchCatchupFrame emits only a live prepared generation', () => {
  const transition: {
    id: string
    sourceModel: string
    targetModel: string
    state: 'preparing' | 'prepared' | 'consuming'
    expiresAt: number
  } = {
    id: 'model-switch:abc',
    sourceModel: 'glm-5.3',
    targetModel: 'grok-build',
    state: 'prepared',
    expiresAt: 2_000,
  }
  const session = {
    sessionKey: 'agent:main:webchat:dm:s1',
    _modelSwitchTransition: transition,
  }
  assert.deepEqual(preparedModelSwitchCatchupFrame(session, 1_000), {
    type: 'outbound.model_switch.prepared',
    requestId: 'model-switch:abc',
    sessionKey: 'agent:main:webchat:dm:s1',
    sourceModel: 'glm-5.3',
    targetModel: 'grok-build',
    status: 'completed',
    ts: 1_000,
  })
  assert.equal(preparedModelSwitchCatchupFrame(session, 2_000), null)
  transition.state = 'preparing'
  assert.equal(preparedModelSwitchCatchupFrame(session, 1_000), null)
})
