/**
 * 企业微信智能机器人(aibot)长连接 —— 纯函数单测(无 ws / 无 PG / 无网络)。
 *
 * 覆盖(对应实施清单):
 *   - 订阅帧构造 buildSubscribeFrame
 *   - send_msg 帧构造 buildSendMsgFrame + 欢迎语 buildWelcomeResponseFrame
 *   - 心跳间隔常量 HEARTBEAT_INTERVAL_MS = 30s
 *   - 重连退避 reconnectBackoffMs(指数 + 5min 封顶 + jitter 注入 rng 确定性)
 *   - 入站解析 parseInboundFrame(msg_callback / event_callback / ack / unknown / 非法)
 *   - 绑定学习 learnBindingFromCallback + 首绑确认判定 shouldConfirmBinding
 *   - 未绑定 / 未连接文案 assertAibotSendable(→ AibotSendError transient)
 *   - 发送 ack 分类 classifyAibotAck(参数错永久 / 频控 transient / 未知 transient)
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/wecomAibotConnection.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  AIBOT_WS_URL,
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_MAX_MS,
  BINDING_CONFIRM_TEXT,
  WELCOME_TEXT,
  buildSubscribeFrame,
  buildSendMsgFrame,
  buildWelcomeResponseFrame,
  reconnectBackoffMs,
  parseInboundFrame,
  learnBindingFromCallback,
  shouldConfirmBinding,
  assertAibotSendable,
  AibotSendError,
  classifyAibotAck,
  type InboundFrame,
} from '../admin/wecomAibotConnection.js'

describe('buildSubscribeFrame', () => {
  it('carries bot_id + secret + req_id under aibot_subscribe', () => {
    const f = buildSubscribeFrame('BOT123456', 'super-secret-value-000', 'r-1')
    assert.equal(f.cmd, 'aibot_subscribe')
    assert.equal(f.headers.req_id, 'r-1')
    assert.deepEqual(f.body, { bot_id: 'BOT123456', secret: 'super-secret-value-000' })
  })
})

describe('buildSendMsgFrame', () => {
  it('builds markdown proactive push with chatid + chat_type + req_id', () => {
    const f = buildSendMsgFrame('CHAT_A', 'single', '**alert** body', 'r-2')
    assert.equal(f.cmd, 'aibot_send_msg')
    assert.equal(f.headers.req_id, 'r-2')
    assert.deepEqual(f.body, {
      chatid: 'CHAT_A',
      chat_type: 1,
      msgtype: 'markdown',
      markdown: { content: '**alert** body' },
    })
  })
  it('group chat_type maps to uint32 2', () => {
    const f = buildSendMsgFrame('CHAT_G', 'group', 'x', 'r-3')
    assert.equal((f.body as { chat_type: number }).chat_type, 2)
  })
})

describe('buildWelcomeResponseFrame', () => {
  it('replies welcome under aibot_respond_welcome_msg keyed by event req_id', () => {
    const f = buildWelcomeResponseFrame('evt-1', WELCOME_TEXT)
    assert.equal(f.cmd, 'aibot_respond_welcome_msg')
    assert.equal(f.headers.req_id, 'evt-1')
    assert.deepEqual(f.body, { msgtype: 'markdown', markdown: { content: WELCOME_TEXT } })
  })
})

describe('constants', () => {
  it('heartbeat is 30s, reconnect cap is 5min, ws url is openws domestic', () => {
    assert.equal(HEARTBEAT_INTERVAL_MS, 30_000)
    assert.equal(RECONNECT_MAX_MS, 300_000)
    assert.equal(AIBOT_WS_URL, 'wss://openws.work.weixin.qq.com')
  })
})

describe('reconnectBackoffMs', () => {
  it('exponential from base 1s (no jitter)', () => {
    assert.equal(reconnectBackoffMs(1), 1_000)
    assert.equal(reconnectBackoffMs(2), 2_000)
    assert.equal(reconnectBackoffMs(3), 4_000)
    assert.equal(reconnectBackoffMs(4), 8_000)
  })
  it('caps at 5min', () => {
    assert.equal(reconnectBackoffMs(100), 300_000)
    assert.equal(reconnectBackoffMs(9), 256_000)
    assert.equal(reconnectBackoffMs(10), 300_000) // 512_000 → capped
  })
  it('jitter uses injected rng deterministically within ±20%', () => {
    // rng=0 → factor 0.8;rng≈1 → factor ~1.2
    assert.equal(reconnectBackoffMs(1, { jitter: true, rng: () => 0 }), 800)
    assert.equal(reconnectBackoffMs(1, { jitter: true, rng: () => 0.5 }), 1_000)
  })
  it('attempt < 1 clamped to 1', () => {
    assert.equal(reconnectBackoffMs(0), 1_000)
  })
})

describe('classifyAibotAck', () => {
  it('0 → ok', () => {
    assert.equal(classifyAibotAck(0), 'ok')
  })
  it('rate-limit code → transient', () => {
    assert.equal(classifyAibotAck(45009), 'transient')
  })
  it('param-error code → permanent', () => {
    assert.equal(classifyAibotAck(40058), 'permanent')
  })
  it('unknown non-zero → transient (never silent-drop)', () => {
    assert.equal(classifyAibotAck(999999), 'transient')
  })
})

describe('parseInboundFrame', () => {
  it('parses aibot_msg_callback (single) with chatid + from + text', () => {
    const raw = JSON.stringify({
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'm-1' },
      body: {
        msgid: 'M1',
        aibotid: 'BOT',
        chatid: 'CHAT_A',
        chattype: 'single',
        from: { userid: 'U1' },
        msgtype: 'text',
        text: { content: 'hi bot' },
      },
    })
    const f = parseInboundFrame(raw)
    assert.equal(f.kind, 'msg_callback')
    if (f.kind !== 'msg_callback') return
    assert.equal(f.chatId, 'CHAT_A')
    assert.equal(f.chatType, 'single')
    assert.equal(f.fromUserId, 'U1')
    assert.equal(f.text, 'hi bot')
  })
  it('parses group msg_callback', () => {
    const f = parseInboundFrame(
      JSON.stringify({
        cmd: 'aibot_msg_callback',
        body: { chatid: 'CHAT_G', chattype: 'group', text: { content: '@bot go' } },
      }),
    )
    assert.equal(f.kind, 'msg_callback')
    if (f.kind !== 'msg_callback') return
    assert.equal(f.chatType, 'group')
  })
  it('parses aibot_event_callback (enter chat)', () => {
    const f = parseInboundFrame(
      JSON.stringify({
        cmd: 'aibot_event_callback',
        headers: { req_id: 'e-1' },
        body: { chatid: 'CHAT_A', chattype: 'single', eventtype: 'enter_chat' },
      }),
    )
    assert.equal(f.kind, 'event_callback')
    if (f.kind !== 'event_callback') return
    assert.equal(f.reqId, 'e-1')
    assert.equal(f.eventType, 'enter_chat')
  })
  it('parses ack (subscribe/send response) with errcode', () => {
    const f = parseInboundFrame(
      JSON.stringify({ cmd: 'aibot_subscribe', headers: { req_id: 's-1' }, body: { errcode: 0, errmsg: 'ok' } }),
    )
    assert.equal(f.kind, 'ack')
    if (f.kind !== 'ack') return
    assert.equal(f.reqId, 's-1')
    assert.equal(f.errcode, 0)
  })
  it('non-zero ack errcode preserved', () => {
    const f = parseInboundFrame(JSON.stringify({ headers: { req_id: 's-2' }, body: { errcode: 40058, errmsg: 'bad' } }))
    assert.equal(f.kind, 'ack')
    if (f.kind !== 'ack') return
    assert.equal(f.errcode, 40058)
    assert.equal(f.errmsg, 'bad')
  })
  it('invalid JSON / array → unknown (never throws)', () => {
    assert.equal(parseInboundFrame('not json').kind, 'unknown')
    assert.equal(parseInboundFrame('[1,2,3]').kind, 'unknown')
    assert.equal(parseInboundFrame(Buffer.from('{bad')).kind, 'unknown')
  })
})

describe('learnBindingFromCallback + shouldConfirmBinding', () => {
  function cb(chatId: string | null, chatType: 'single' | 'group' | null) {
    return {
      kind: 'msg_callback',
      reqId: null,
      chatId,
      chatType,
      fromUserId: null,
      msgType: 'text',
      text: 'x',
    } as Extract<InboundFrame, { kind: 'msg_callback' }>
  }
  it('learns chatid+type from a single-chat callback', () => {
    assert.deepEqual(learnBindingFromCallback(cb('CHAT_A', 'single')), {
      chatId: 'CHAT_A',
      chatType: 'single',
    })
  })
  it('group @bot learns too (WeCom only delivers @-ed group msgs)', () => {
    assert.deepEqual(learnBindingFromCallback(cb('CHAT_G', 'group')), {
      chatId: 'CHAT_G',
      chatType: 'group',
    })
  })
  it('missing chattype defaults single', () => {
    assert.deepEqual(learnBindingFromCallback(cb('CHAT_A', null)), {
      chatId: 'CHAT_A',
      chatType: 'single',
    })
  })
  it('no chatid → null (ignored)', () => {
    assert.equal(learnBindingFromCallback(cb(null, 'single')), null)
  })
  it('first bind (prev null) → confirm; rebind to new chat → confirm; same chat → no confirm', () => {
    assert.equal(shouldConfirmBinding(null, 'CHAT_A'), true)
    assert.equal(shouldConfirmBinding('CHAT_A', 'CHAT_B'), true)
    assert.equal(shouldConfirmBinding('CHAT_A', 'CHAT_A'), false)
  })
  it('confirmation text is the OpenClaude 已绑定 message', () => {
    assert.match(BINDING_CONFIRM_TEXT, /已绑定/)
  })
})

describe('assertAibotSendable (未绑定 / 未连接 文案单一权威源)', () => {
  it('not connected → AibotSendError 等待连接', () => {
    assert.throws(
      () => assertAibotSendable({ connState: 'reconnecting', boundChatId: 'CHAT_A' }),
      (err: unknown) => {
        assert.ok(err instanceof AibotSendError)
        assert.match((err as Error).message, /等待连接/)
        return true
      },
    )
  })
  it('connected but not bound → AibotSendError 等待绑定 (给机器人发一条消息)', () => {
    assert.throws(
      () => assertAibotSendable({ connState: 'connected', boundChatId: null }),
      (err: unknown) => {
        assert.ok(err instanceof AibotSendError)
        assert.match((err as Error).message, /等待绑定/)
        assert.match((err as Error).message, /发一条消息/)
        return true
      },
    )
  })
  it('connected + bound → no throw', () => {
    assert.doesNotThrow(() =>
      assertAibotSendable({ connState: 'connected', boundChatId: 'CHAT_A' }),
    )
  })
})
