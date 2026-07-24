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
  isClientMessageId,
  isPersistedClientMessageId,
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

describe('client message id contracts', () => {
  it('keeps new frame ids strict while persisted readers cover legacy colon ids', () => {
    assert.equal(isClientMessageId('a'.repeat(128)), true)
    assert.equal(isClientMessageId('cm:user:large'), false)
    assert.equal(isPersistedClientMessageId('a'.repeat(128)), true)
    assert.equal(isPersistedClientMessageId('cm:user:large'), true)
    assert.equal(isPersistedClientMessageId('a'.repeat(129)), false)
    assert.equal(isPersistedClientMessageId(`${'a'.repeat(80)}:x`), false)
  })
})

describe('InboundMessage schema', () => {
  it('accepts frame without traceId / clientTraceId (backward compat)', () => {
    assert.equal(Value.Check(InboundMessage, baseInbound()), true)
  })
  it('accepts exact browser displayText alongside a different model prompt', () => {
    assert.equal(Value.Check(InboundMessage, {
      ...(baseInbound() as object),
      content: { text: '模型正文\n[附件提示]', displayText: '模型正文' },
    }), true)
  })
  it('accepts complete recovery lineage and rejects partial lineage', () => {
    assert.equal(Value.Check(InboundMessage, {
      ...(baseInbound() as object),
      clientMessageId: 'm-recover-abc',
      content: {
        text: 'continue',
        recovery: {
          sourceClientMessageId: 'cm-source',
          mode: 'checkpoint',
          automatic: true,
        },
      },
    }), true)
    assert.equal(Value.Check(InboundMessage, {
      ...(baseInbound() as object),
      clientMessageId: 'm-recover-abc',
      content: {
        text: 'continue',
        recovery: {
          sourceClientMessageId: 'cm-source',
          mode: 'checkpoint',
        },
      },
    }), false)
  })
  it('accepts an exact reply snapshot and rejects malformed reply identities', () => {
    assert.equal(Value.Check(InboundMessage, {
      ...(baseInbound() as object),
      replyToId: 'assistant-1',
      content: {
        text: '请解释这一段',
        replyTo: {
          messageId: 'assistant-1',
          role: 'assistant',
          text: '完整历史回答',
        },
      },
    }), true)
    assert.equal(Value.Check(InboundMessage, {
      ...(baseInbound() as object),
      content: {
        text: 'bad role',
        replyTo: { messageId: 'assistant-1', role: 'tool', text: 'x' },
      },
    }), false)
    assert.equal(Value.Check(InboundMessage, {
      ...(baseInbound() as object),
      content: {
        text: 'bad id',
        replyTo: { messageId: 'line\nbreak', role: 'assistant', text: 'x' },
      },
    }), false)
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

describe('InboundMessage.imageEdit — annotated / outpaint (v5 图片体验)', () => {
  const withImageEdit = (imageEdit: Record<string, unknown>) => ({
    ...(baseInbound() as object),
    content: { text: 'edit', media: [], imageEdit },
  })
  it('accepts a legacy annotated imageEdit without mode (backward compat)', () => {
    assert.equal(
      Value.Check(
        InboundMessage,
        withImageEdit({
          clientJobId: '0'.repeat(32),
          sourceIndex: 0,
          maskIndex: 1,
          guideIndex: 2,
          width: 1024,
          height: 768,
        }),
      ),
      true,
    )
  })
  it('accepts an outpaint imageEdit with mode + targetAspect and no maskIndex', () => {
    assert.equal(
      Value.Check(
        InboundMessage,
        withImageEdit({
          clientJobId: '0'.repeat(32),
          mode: 'outpaint',
          sourceIndex: 0,
          guideIndex: 1,
          targetAspect: '16:9',
          width: 1024,
          height: 768,
        }),
      ),
      true,
    )
  })
  it('rejects an unsupported targetAspect literal', () => {
    assert.equal(
      Value.Check(
        InboundMessage,
        withImageEdit({
          clientJobId: '0'.repeat(32),
          mode: 'outpaint',
          sourceIndex: 0,
          guideIndex: 1,
          targetAspect: '2:1',
          width: 1024,
          height: 768,
        }),
      ),
      false,
    )
  })
})

describe('OutboundMessage schema', () => {
  it('accepts frame without traceId (backward compat)', () => {
    assert.equal(Value.Check(OutboundMessage, baseOutboundMsg()), true)
  })
  it('accepts an image-edit delivery frame carrying imageEditJobId', () => {
    assert.equal(
      Value.Check(OutboundMessage, { ...(baseOutboundMsg() as object), imageEditJobId: 'a'.repeat(32) }),
      true,
    )
  })
  it('rejects a malformed imageEditJobId (not 32 hex)', () => {
    assert.equal(
      Value.Check(OutboundMessage, { ...(baseOutboundMsg() as object), imageEditJobId: 'nope' }),
      false,
    )
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
  it('accepts only a canonical optional lossless turnKey', () => {
    assert.equal(
      Value.Check(OutboundCodexBilling, {
        ...(baseOutboundCodexBilling() as object),
        turnKey: 'ab'.repeat(32),
      }),
      true,
    )
    for (const bad of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) {
      assert.equal(
        Value.Check(OutboundCodexBilling, {
          ...(baseOutboundCodexBilling() as object),
          turnKey: bad,
        }),
        false,
      )
    }
  })
  it('accepts canonical delegate billing attribution and rejects malformed locators', () => {
    assert.equal(
      Value.Check(OutboundCodexBilling, {
        ...(baseOutboundCodexBilling() as object),
        turnKey: 'ab'.repeat(32),
        parentTurnKey: 'cd'.repeat(32),
        parentSessionId: 'web-parent-1',
        delegateAgentId: 'researcher_2',
      }),
      true,
    )
    assert.equal(
      Value.Check(OutboundCodexBilling, {
        ...(baseOutboundCodexBilling() as object),
        parentTurnKey: 'A'.repeat(64),
      }),
      false,
    )
    assert.equal(
      Value.Check(OutboundCodexBilling, {
        ...(baseOutboundCodexBilling() as object),
        delegateAgentId: 'bad agent',
      }),
      false,
    )
  })
  // M2 — engineSessionId(engine-reported 计费的稳定会话维度)。
  // Optional(渐进部署:旧容器镜像不带)+ 形状钉死 'oceng-' + 48 hex 小写。
  it('accepts frame without engineSessionId (渐进部署兼容)', () => {
    assert.equal(Value.Check(OutboundCodexBilling, baseOutboundCodexBilling()), true)
  })
  it('accepts valid engineSessionId (oceng- + 48 hex)', () => {
    assert.equal(
      Value.Check(OutboundCodexBilling, {
        ...(baseOutboundCodexBilling() as object),
        engineSessionId: `oceng-${'a1'.repeat(24)}`,
      }),
      true,
    )
  })
  it('rejects engineSessionId with bad shape', () => {
    for (const bad of [
      'oceng-short', // hex 段不足 48
      `OCENG-${'a'.repeat(48)}`, // 前缀大小写错
      `oceng-${'A'.repeat(48)}`, // 大写 hex(算法产出恒小写)
      `oceng-${'a'.repeat(49)}`, // 超长
      `${'a'.repeat(54)}`, // 无前缀
      'container-123', // 旧 v3 containerId 占位口径(已废弃)
    ]) {
      assert.equal(
        Value.Check(OutboundCodexBilling, {
          ...(baseOutboundCodexBilling() as object),
          engineSessionId: bad,
        }),
        false,
        `must reject: ${bad}`,
      )
    }
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
  it('accepts a valid clientMessageId and rejects an invalid turn id', () => {
    assert.equal(
      Value.Check(OutboundPermissionRequest, {
        ...(baseOutboundPermissionRequest() as object),
        clientMessageId: 'm-user_permission-1',
      }),
      true,
    )
    assert.equal(
      Value.Check(OutboundPermissionRequest, {
        ...(baseOutboundPermissionRequest() as object),
        clientMessageId: 'contains spaces',
      }),
      false,
    )
  })
})
