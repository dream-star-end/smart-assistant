/**
 * V3 S12e frame schema 测试 — 验证 traceId / clientTraceId 字段:
 *   1) 不带这俩字段的老 frame Value.Check 通过(向后兼容硬合同)
 *   2) 带合法 traceId / clientTraceId 通过
 *   3) 带非法值(bad-charset / too-short / too-long) Value.Check 拒
 *
 * 注意:Value.Check 用于 schema 测试,**不在**热路径上跑;运行时实际校验
 * 走 parseTraceIdCandidate(参见 ../traceId.ts 的设计动机)。
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Value } from '@sinclair/typebox/value'

import {
  InboundMessage,
  OutboundCodexBilling,
  OutboundError,
  OutboundMessage,
  OutboundPermissionRequest,
} from '../frames.js'

// 共用 fixture 构造器 —— 一处构造 base frame,后续 spread 覆盖单字段验各种 trace 输入
const peer = { id: 'p1', kind: 'dm' as const }

function baseInbound(): unknown {
  return {
    type: 'inbound.message',
    idempotencyKey: 'idem-1',
    channel: 'webchat',
    peer,
    content: { text: 'hi' },
    ts: 1714000000000,
  }
}

function baseOutboundMsg(): unknown {
  return {
    type: 'outbound.message',
    sessionKey: 'sess-1',
    channel: 'webchat',
    peer,
    blocks: [],
    isFinal: false,
  }
}

function baseOutboundError(): unknown {
  return {
    type: 'outbound.error',
    sessionKey: 'sess-1',
    channel: 'webchat',
    peer,
    code: 'upstream_failed',
    message: 'boom',
    isFinal: false,
  }
}

function baseOutboundCodexBilling(): unknown {
  return {
    type: 'outbound.codex_billing',
    sessionKey: 'sess-1',
    channel: 'webchat',
    peer,
    requestId: 'req-1',
    status: 'success',
    durationMs: 100,
  }
}

function baseOutboundPermissionRequest(): unknown {
  return {
    type: 'outbound.permission_request',
    sessionKey: 'sess-1',
    channel: 'webchat',
    peer,
    requestId: 'req-1',
    toolName: 'Bash',
  }
}

const VALID_TRACE = '0123456789abcdef0123456789abcdef' // 32 hex, 合法
const VALID_TRACE_SHORT = 'aaaaaaaaaaaaaaaa' // 16 chars 下边界
const VALID_TRACE_LONG = 'a'.repeat(64) // 64 chars 上边界
const BAD_TRACE_CHARSET = '../etc/passwd_abc' // 含 . /
const BAD_TRACE_SHORT = 'short' // 5 chars
const BAD_TRACE_LONG = 'a'.repeat(65) // 65 chars

describe('InboundMessage schema', () => {
  it('accepts frame without traceId / clientTraceId (backward compat)', () => {
    assert.equal(Value.Check(InboundMessage, baseInbound()), true)
  })
  it('accepts valid clientTraceId', () => {
    assert.equal(
      Value.Check(InboundMessage, { ...(baseInbound() as object), clientTraceId: VALID_TRACE }),
      true,
    )
  })
  it('accepts 16-char and 64-char clientTraceId (boundary)', () => {
    assert.equal(
      Value.Check(InboundMessage, {
        ...(baseInbound() as object),
        clientTraceId: VALID_TRACE_SHORT,
      }),
      true,
    )
    assert.equal(
      Value.Check(InboundMessage, {
        ...(baseInbound() as object),
        clientTraceId: VALID_TRACE_LONG,
      }),
      true,
    )
  })
  it('rejects clientTraceId with bad charset', () => {
    assert.equal(
      Value.Check(InboundMessage, {
        ...(baseInbound() as object),
        clientTraceId: BAD_TRACE_CHARSET,
      }),
      false,
    )
  })
  it('rejects clientTraceId too short / too long', () => {
    assert.equal(
      Value.Check(InboundMessage, {
        ...(baseInbound() as object),
        clientTraceId: BAD_TRACE_SHORT,
      }),
      false,
    )
    assert.equal(
      Value.Check(InboundMessage, {
        ...(baseInbound() as object),
        clientTraceId: BAD_TRACE_LONG,
      }),
      false,
    )
  })
})

describe('OutboundMessage schema', () => {
  it('accepts frame without traceId (backward compat)', () => {
    assert.equal(Value.Check(OutboundMessage, baseOutboundMsg()), true)
  })
  it('accepts valid traceId', () => {
    assert.equal(
      Value.Check(OutboundMessage, { ...(baseOutboundMsg() as object), traceId: VALID_TRACE }),
      true,
    )
  })
  it('rejects invalid traceId charset', () => {
    assert.equal(
      Value.Check(OutboundMessage, {
        ...(baseOutboundMsg() as object),
        traceId: BAD_TRACE_CHARSET,
      }),
      false,
    )
  })
})

describe('OutboundError schema', () => {
  it('accepts frame without traceId', () => {
    assert.equal(Value.Check(OutboundError, baseOutboundError()), true)
  })
  it('accepts valid traceId', () => {
    assert.equal(
      Value.Check(OutboundError, { ...(baseOutboundError() as object), traceId: VALID_TRACE }),
      true,
    )
  })
  it('rejects bad traceId', () => {
    assert.equal(
      Value.Check(OutboundError, {
        ...(baseOutboundError() as object),
        traceId: BAD_TRACE_CHARSET,
      }),
      false,
    )
  })
})

describe('OutboundCodexBilling schema', () => {
  it('accepts frame without traceId', () => {
    assert.equal(Value.Check(OutboundCodexBilling, baseOutboundCodexBilling()), true)
  })
  it('accepts valid traceId', () => {
    assert.equal(
      Value.Check(OutboundCodexBilling, {
        ...(baseOutboundCodexBilling() as object),
        traceId: VALID_TRACE,
      }),
      true,
    )
  })
  it('rejects bad traceId', () => {
    assert.equal(
      Value.Check(OutboundCodexBilling, {
        ...(baseOutboundCodexBilling() as object),
        traceId: BAD_TRACE_SHORT,
      }),
      false,
    )
  })
})

describe('OutboundPermissionRequest schema', () => {
  it('accepts frame without traceId', () => {
    assert.equal(Value.Check(OutboundPermissionRequest, baseOutboundPermissionRequest()), true)
  })
  it('accepts valid traceId', () => {
    assert.equal(
      Value.Check(OutboundPermissionRequest, {
        ...(baseOutboundPermissionRequest() as object),
        traceId: VALID_TRACE,
      }),
      true,
    )
  })
  it('rejects bad traceId', () => {
    assert.equal(
      Value.Check(OutboundPermissionRequest, {
        ...(baseOutboundPermissionRequest() as object),
        traceId: BAD_TRACE_LONG,
      }),
      false,
    )
  })
})
