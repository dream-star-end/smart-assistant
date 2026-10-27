/**
 * Native model-switch prepare is a long-running compact. The completion
 * frame must not be pinned to the originating WebSocket: mobile visibility
 * probes and proxy idle routinely close that socket before compact returns.
 * Pin the fanout/ring helper structurally so a later refactor cannot revert
 * to `ws.send` as the only reply path.
 */
import { gatewayMethodBody, readGatewaySource } from './helpers/gatewaySource.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { preparedModelSwitchCatchupFrame } from '../server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// server.ts + split-out modules (FINDINGS §7.6 S6: dispatchInbound / ws connection moved out)
const serverSrc = readGatewaySource()

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
  // FINDINGS §7.6 S6: autoResumeFromHello lives in wsConnection.ts; read its implementation.
  const tail = gatewayMethodBody('autoResumeFromHello')
  assert.ok(tail.length > 0, 'autoResumeFromHello not found')
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

test('preparedModelSwitchCatchupFrame replays a recent failure so a reconnecting client stops waiting', () => {
  const session = {
    sessionKey: 'agent:main:webchat:dm:s1',
    _modelSwitchFailure: {
      id: 'model-switch:failed',
      sourceModel: 'antigravity-gemini-3.8-flash',
      targetModel: 'box-api-claude-sonnet-5-5',
      errorCode: 'MODEL_SWITCH_NATIVE_COMPACTION_UNAVAILABLE',
      message: '上下文压缩失败，仍保留原模型',
      at: 1_000,
    },
  }
  assert.deepEqual(preparedModelSwitchCatchupFrame(session, 2_000), {
    type: 'outbound.model_switch.prepared',
    requestId: 'model-switch:failed',
    sessionKey: 'agent:main:webchat:dm:s1',
    sourceModel: 'antigravity-gemini-3.8-flash',
    targetModel: 'box-api-claude-sonnet-5-5',
    status: 'failed',
    errorCode: 'MODEL_SWITCH_NATIVE_COMPACTION_UNAVAILABLE',
    message: '上下文压缩失败，仍保留原模型',
    ts: 2_000,
  })
  assert.equal(preparedModelSwitchCatchupFrame(session, 1_000 + 30 * 60_000), null)
  // A newer attempt in flight owns the catch-up.
  assert.equal(
    preparedModelSwitchCatchupFrame(
      {
        ...session,
        _modelSwitchTransition: { id: 'model-switch:new', sourceModel: 'a', targetModel: 'b', state: 'preparing' as const },
      },
      2_000,
    ),
    null,
  )
})

test('structural: prepare_model_switch answers catalog models instead of dropping them, and records failures', () => {
  const startIdx = serverSrc.indexOf("} else if ((frame as any).type === 'control.session.prepare_model_switch') {")
  const endIdx = serverSrc.indexOf("} else if ((frame as any).type === 'control.session.compact') {", startIdx)
  const body = serverSrc.slice(startIdx, endIdx)
  assert.equal(/ALLOWED_INBOUND_MODELS\.has/.test(body), false, 'the baked allowlist drops box-api-claude-* switches with no reply')
  assert.match(body, /session\._modelSwitchFailure = \{/)
})
