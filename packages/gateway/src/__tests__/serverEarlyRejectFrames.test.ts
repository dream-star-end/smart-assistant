/**
 * gateway 早期拒帧 / turn_status wire 构造 —— 纯 helper 行为断言。
 *
 * 覆盖:
 *   - _earlyRejectErrorFrames:结构化 outbound.error 先于兼容 [error] final 的
 *     有序双帧,路由三件套 + traceId + _userId 两帧一致。
 *   - _buildTurnStatusFrame / _turnStatusWireFields:GatewayTurnPhase → protocol
 *     OutboundTurnStatus 判别联合(retrying 展平为 status:'retrying' + 平级 retry)。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/serverEarlyRejectFrames.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  _buildEngineErrorFrame,
  _buildTurnStatusFrame,
  _earlyRejectErrorFrames,
  _turnStatusWireFields,
} from '../server.js'

const PEER = { id: 'u1', kind: 'dm' as const }

describe('_buildEngineErrorFrame — turn 终态 wire', () => {
  const routing = {
    sessionKey: 'sk-stop',
    channel: 'webchat',
    peer: PEER,
    clientMessageId: 'm-stop-1',
    traceId: 'trace-stop',
  }

  it('gateway 权威 USER_CANCELLED 原样成为 user_cancelled wire code', () => {
    const frame = _buildEngineErrorFrame(routing, {
      kind: 'error',
      error: '本轮已由用户停止。',
      errorCode: 'user_cancelled',
    })
    assert.equal(frame.type, 'outbound.error')
    assert.equal(frame.code, 'user_cancelled')
    assert.equal(frame.message, '本轮已由用户停止。')
    assert.equal(frame.detail, '本轮已由用户停止。')
    assert.equal(frame.clientMessageId, 'm-stop-1')
    assert.equal(frame.isFinal, false)
  })

  it('无权威终态码的 unknown 错误仍保持 upstream_failed 兼容语义', () => {
    const frame = _buildEngineErrorFrame(routing, {
      kind: 'error',
      error: 'unclassified failure',
    })
    assert.equal(frame.code, 'upstream_failed')
    assert.equal(frame.message, '任务执行暂时中断，请直接重试本条消息')
  })
})

describe('_earlyRejectErrorFrames — 结构化双帧', () => {
  const frames = _earlyRejectErrorFrames({
    sessionKey: 'sk-1',
    channel: 'webchat',
    peer: PEER,
    userId: 'user-42',
    traceId: 'trace-xyz',
    code: 'upstream_failed',
    message: '模型服务暂时不可用，请稍后重试或切换模型',
    legacyErrorText: '[error] MODEL_NOT_AVAILABLE',
  })

  it('返回有序二元组:先 outbound.error,后 outbound.message', () => {
    assert.equal(frames.length, 2)
    assert.equal(frames[0].type, 'outbound.error')
    assert.equal(frames[1].type, 'outbound.message')
  })

  it('结构化帧:isFinal=false + code 透传 + message', () => {
    const [structured] = frames
    assert.equal(structured.isFinal, false)
    assert.equal(structured.code, 'upstream_failed')
    assert.equal(structured.message, '模型服务暂时不可用，请稍后重试或切换模型')
  })

  it('兼容 final 帧:isFinal=true + 原样 [error] 文本(终止器语义不变)', () => {
    const legacy = frames[1]
    assert.equal(legacy.isFinal, true)
    assert.equal(legacy.blocks.length, 1)
    assert.equal((legacy.blocks[0] as { text: string }).text, '[error] MODEL_NOT_AVAILABLE')
  })

  it('两帧路由 + traceId + _userId 完全一致', () => {
    for (const f of frames) {
      assert.equal(f.sessionKey, 'sk-1')
      assert.equal(f.channel, 'webchat')
      assert.deepEqual(f.peer, PEER)
      assert.equal(f.traceId, 'trace-xyz')
      assert.equal((f as { _userId?: string })._userId, 'user-42')
    }
  })
})

describe('_turnStatusWireFields — 判别联合展平', () => {
  it('compacting → { status:"compacting" },无 retry', () => {
    const f = _turnStatusWireFields('compacting')
    assert.deepEqual(f, { status: 'compacting' })
    assert.ok(!('retry' in f))
  })

  it('null → { status:null }', () => {
    assert.deepEqual(_turnStatusWireFields(null), { status: null })
  })

  it('retrying 形态 → { status:"retrying", retry } 平级', () => {
    const retry = { attempt: 3, max: 5, delayMs: 2000, retryAt: 1_700_000_000_000 }
    const f = _turnStatusWireFields({ status: 'retrying', retry })
    assert.deepEqual(f, { status: 'retrying', retry })
  })
})

describe('_buildTurnStatusFrame — 完整 wire 帧', () => {
  const routing = {
    sessionKey: 'sk-2',
    channel: 'webchat',
    peer: PEER,
    traceId: 'trace-2',
  }

  it('compacting 帧', () => {
    const frame = _buildTurnStatusFrame(routing, 'compacting')
    assert.equal(frame.type, 'outbound.turn_status')
    assert.equal(frame.status, 'compacting')
    assert.equal(frame.sessionKey, 'sk-2')
    assert.equal(frame.traceId, 'trace-2')
  })

  it('retrying 帧带平级 retry', () => {
    const retry = { attempt: 1, max: 3, delayMs: 500, retryAt: 1_700_000_000_001 }
    const frame = _buildTurnStatusFrame(routing, { status: 'retrying', retry })
    assert.equal(frame.status, 'retrying')
    assert.deepEqual((frame as { retry: unknown }).retry, retry)
  })

  it('null 帧(回到普通流式/空闲)', () => {
    const frame = _buildTurnStatusFrame(routing, null)
    assert.equal(frame.status, null)
  })

  it('working 帧带可选 detail，且不会被展平成 retrying', () => {
    const frame = _buildTurnStatusFrame(routing, { status: 'working', detail: 'Read foo.ts' })
    assert.equal(frame.type, 'outbound.turn_status')
    assert.equal(frame.status, 'working')
    assert.equal((frame as { detail?: string }).detail, 'Read foo.ts')
    assert.equal('retry' in frame, false)
    const fields = _turnStatusWireFields({ status: 'working', detail: 'Read foo.ts' })
    assert.deepEqual(fields, { status: 'working', detail: 'Read foo.ts' })
    assert.deepEqual(_turnStatusWireFields({ status: 'working' }), { status: 'working' })
  })
})
