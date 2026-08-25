/**
 * Tests for `routeWechatInbound` — the pure router extracted from
 * `wechatChannelFactory.handleInbound` (manager.ts).
 *
 * **Slice 7c contract**(broker override hook):
 *   1. /status 命中 → 只调用 sendText,不进 override / dispatch
 *   2. /new + override 已注入 → 只调 override,让 broker 重置商业版 session pointer
 *   3. /new + override 未注入 → 调用 ctx.resetSession + sendText,保留 legacy 行为
 *   4. /help /model + override 已注入 → 只调 override,不调 sendText / ctx.dispatch
 *   5. /help /model + override 未注入 → manager 本地 fallback sendText
 *   6. 普通文本 + override 已注入 → 只调 override,不调 ctx.dispatch
 *   7. 普通文本 + override 未注入 → 走 ctx.dispatch 原路径(行为不变)
 *   8. override 抛错 → catch + ctx.log.error,不重抛,也不回落 ctx.dispatch
 *   9. override 收到的 evt 字段:bindingUserId/senderId/text/idempotencyKey/receivedAt/channel
 *
 * Run: npx tsx --test packages/channels/wechat/src/__tests__/wechatChannelOverride.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { WechatBinding } from '@openclaude/storage'
import {
  routeWechatInbound,
  type WechatInboundOverrideEvent,
  type WechatInboundRouterDeps,
  extractIlinkItemTypes,
} from '../manager.js'
import type { InboundEvent } from '../worker.js'

const NOW = 1_700_000_000_000

function makeBinding(over: Partial<WechatBinding> = {}): WechatBinding {
  return {
    userId: '777',
    accountId: 'acct-A',
    loginUserId: 'login-A',
    botToken: 'tok-A',
    getUpdatesBuf: '',
    contextTokens: {},
    whitelist: [],
    status: 'active',
    createdAt: NOW - 1000,
    updatedAt: NOW - 100,
    lastEventAt: NOW - 50,
    ...over,
  }
}

function makeEvent(over: Partial<InboundEvent> = {}): InboundEvent {
  return {
    binding: makeBinding(),
    senderId: 'wx-sender-abc',
    text: 'hello',
    contextToken: 'ctx-tok',
    messageId: 'msg-1',
    imageAttachments: [],
    mediaAttachments: [],
    raw: {},
    ...over,
  }
}

interface Captured {
  sendTextCalls: Array<{ userId: string; senderId: string; msg: string }>
  overrideCalls: WechatInboundOverrideEvent[]
  overrideThrow: Error | null
  dispatchCalls: unknown[]
  resetSessionCalls: Array<{ channel: string; peerId: string; kind: string }>
  resetSessionThrow: Error | null
  logErrors: string[]
}

function makeDeps(over: Partial<{
  workersCount: number
  withOverride: boolean
  overrideThrow: Error | null
  resetSessionThrow: Error | null
}> = {}): { deps: WechatInboundRouterDeps; cap: Captured } {
  const cap: Captured = {
    sendTextCalls: [],
    overrideCalls: [],
    overrideThrow: over.overrideThrow ?? null,
    dispatchCalls: [],
    resetSessionCalls: [],
    resetSessionThrow: over.resetSessionThrow ?? null,
    logErrors: [],
  }
  const log = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg: string) => cap.logErrors.push(msg),
  }
  const deps: WechatInboundRouterDeps = {
    ctx: {
      log: log as any,
      dispatch: (frame: unknown) => { cap.dispatchCalls.push(frame) },
      resetSession: async (channel: string, peerId: string, kind: string) => {
        cap.resetSessionCalls.push({ channel, peerId, kind })
        if (cap.resetSessionThrow) throw cap.resetSessionThrow
      },
    } as any,
    workersCount: over.workersCount ?? 1,
    sendText: (userId, senderId, msg) => {
      cap.sendTextCalls.push({ userId, senderId, msg })
    },
    onInboundOverride: over.withOverride
      ? async (evt) => {
          cap.overrideCalls.push(evt)
          if (cap.overrideThrow) throw cap.overrideThrow
        }
      : undefined,
    now: () => NOW,
  }
  return { deps, cap }
}

describe('routeWechatInbound — /help and /model commands are useful local replies', () => {
  it('/help forwards to override when broker is present; no local sendText, no dispatch', async () => {
    const { deps, cap } = makeDeps({ withOverride: true })
    await routeWechatInbound(makeEvent({ text: '/help' }), deps)
    assert.equal(cap.overrideCalls.length, 1)
    assert.equal(cap.dispatchCalls.length, 0)
    assert.equal(cap.sendTextCalls.length, 0)
    assert.equal(cap.overrideCalls[0]!.text, '/help')
  })

  it('/help without override lists supported WeChat commands locally', async () => {
    const { deps, cap } = makeDeps({ withOverride: false })
    await routeWechatInbound(makeEvent({ text: '/help' }), deps)
    assert.equal(cap.overrideCalls.length, 0)
    assert.equal(cap.dispatchCalls.length, 0)
    assert.equal(cap.sendTextCalls.length, 1)
    assert.match(cap.sendTextCalls[0]!.msg, /\/new/)
    assert.match(cap.sendTextCalls[0]!.msg, /\/status/)
    assert.match(cap.sendTextCalls[0]!.msg, /\/model/)
  })

  it('/model forwards to override when broker is present; no local sendText, no dispatch', async () => {
    const { deps, cap } = makeDeps({ withOverride: true })
    await routeWechatInbound(makeEvent({ text: '/model' }), deps)
    assert.equal(cap.overrideCalls.length, 1)
    assert.equal(cap.dispatchCalls.length, 0)
    assert.equal(cap.sendTextCalls.length, 0)
    assert.equal(cap.overrideCalls[0]!.text, '/model')
  })

  it('/model without override explains web default model behavior locally', async () => {
    const { deps, cap } = makeDeps({ withOverride: false })
    await routeWechatInbound(makeEvent({ text: '/model' }), deps)
    assert.equal(cap.overrideCalls.length, 0)
    assert.equal(cap.dispatchCalls.length, 0)
    assert.equal(cap.sendTextCalls.length, 1)
    assert.match(cap.sendTextCalls[0]!.msg, /网页端选择的默认模型/)
    assert.match(cap.sendTextCalls[0]!.msg, /claudeai\.chat/)
  })

  it('/model with args forwards to override when broker is present', async () => {
    const { deps, cap } = makeDeps({ withOverride: true })
    await routeWechatInbound(makeEvent({ text: '/model claude-sonnet-4-6' }), deps)
    assert.equal(cap.overrideCalls.length, 1)
    assert.equal(cap.dispatchCalls.length, 0)
    assert.equal(cap.sendTextCalls.length, 0)
    assert.equal(cap.overrideCalls[0]!.text, '/model claude-sonnet-4-6')
  })
})

describe('routeWechatInbound — /status command bypasses override and dispatch', () => {
  it('only calls sendText with status text; no override, no dispatch', async () => {
    const { deps, cap } = makeDeps({ withOverride: true, workersCount: 3 })
    await routeWechatInbound(makeEvent({ text: '/status' }), deps)
    assert.equal(cap.overrideCalls.length, 0, 'override must not fire for /status')
    assert.equal(cap.dispatchCalls.length, 0, 'dispatch must not fire for /status')
    assert.equal(cap.sendTextCalls.length, 1)
    assert.equal(cap.sendTextCalls[0]!.userId, '777')
    assert.equal(cap.sendTextCalls[0]!.senderId, 'wx-sender-abc')
    assert.match(cap.sendTextCalls[0]!.msg, /OpenClaude 状态/)
    assert.match(cap.sendTextCalls[0]!.msg, /活跃 worker: 3/)
  })

  it('tolerates leading/trailing whitespace in /status', async () => {
    const { deps, cap } = makeDeps({ withOverride: true })
    await routeWechatInbound(makeEvent({ text: '   /status   ' }), deps)
    assert.equal(cap.sendTextCalls.length, 1)
    assert.equal(cap.overrideCalls.length, 0)
  })
})

describe('routeWechatInbound — /new command routes to the correct session owner', () => {
  it('forwards to override when broker is present; no local resetSession, no dispatch', async () => {
    const { deps, cap } = makeDeps({ withOverride: true })
    await routeWechatInbound(makeEvent({ text: '/new' }), deps)
    assert.equal(cap.overrideCalls.length, 1)
    assert.equal(cap.overrideCalls[0]!.text, '/new')
    assert.equal(cap.resetSessionCalls.length, 0)
    assert.equal(cap.sendTextCalls.length, 0)
    assert.equal(cap.dispatchCalls.length, 0)
  })

  it('without override, calls resetSession + sendText success message; no dispatch', async () => {
    const { deps, cap } = makeDeps({ withOverride: false })
    await routeWechatInbound(makeEvent({ text: '/new' }), deps)
    assert.equal(cap.resetSessionCalls.length, 1)
    assert.deepEqual(cap.resetSessionCalls[0], {
      channel: 'wechat',
      peerId: '777:wx-sender-abc',
      kind: 'dm',
    })
    assert.equal(cap.sendTextCalls.length, 1)
    assert.match(cap.sendTextCalls[0]!.msg, /已开启新会话/)
    assert.equal(cap.overrideCalls.length, 0, 'override must not fire for /new')
    assert.equal(cap.dispatchCalls.length, 0, 'dispatch must not fire for /new')
  })

  it('without override, reports a fixed-copy failure to the WeChat user (raw detail stays in logs)', async () => {
    const { deps, cap } = makeDeps({
      withOverride: false,
      resetSessionThrow: new Error('db-down'),
    })
    await routeWechatInbound(makeEvent({ text: '/new' }), deps)
    assert.equal(cap.resetSessionCalls.length, 1)
    assert.equal(cap.sendTextCalls.length, 1)
    // E8 — 用户可见文案固定;内部错误细节(db-down)不得出现在微信消息里。
    assert.equal(cap.sendTextCalls[0]!.msg, '开启新会话失败，请稍后重试。')
    assert.ok(!cap.sendTextCalls[0]!.msg.includes('db-down'))
    assert.equal(cap.overrideCalls.length, 0)
    assert.equal(cap.dispatchCalls.length, 0)
  })
})

describe('routeWechatInbound — override hook precedence over ctx.dispatch', () => {
  it('plain text + override set: only override is called; ctx.dispatch skipped', async () => {
    const { deps, cap } = makeDeps({ withOverride: true })
    await routeWechatInbound(makeEvent({ text: 'hello broker' }), deps)
    assert.equal(cap.overrideCalls.length, 1)
    assert.equal(cap.dispatchCalls.length, 0,
      '关键不变量:override 命中后不能再走 ctx.dispatch,否则 broker wsess-* 和 personal-OC session 命名空间会串场')
  })

  it('override receives the full evt envelope', async () => {
    const { deps, cap } = makeDeps({ withOverride: true })
    await routeWechatInbound(makeEvent({
      text: '你好 broker',
      senderId: 'wx-sender-xyz',
      messageId: 'mid-42',
      binding: makeBinding({ userId: '888', accountId: 'acct-888' }),
      imageAttachments: [
        {
          fullUrl: 'https://novac2c.cdn.weixin.qq.com/c2c/download?x=1',
          aesKeyHex: '00112233445566778899aabbccddeeff',
        },
      ],
      raw: { item_list: [{ type: 1, text_item: { text: '你好 broker' } }, { type: 3, voice_item: { text: '语音' } }] },
    }), deps)
    assert.equal(cap.overrideCalls.length, 1)
    const evt = cap.overrideCalls[0]!
    assert.equal(evt.bindingUserId, '888')
    assert.equal(evt.accountId, 'acct-888')
    assert.equal(evt.senderId, 'wx-sender-xyz')
    assert.equal(evt.text, '你好 broker')
    assert.equal(evt.messageId, 'mid-42')
    assert.equal(evt.itemTypes, 'text,voice')
    assert.equal(evt.imageAttachments?.length, 1)
    assert.equal(
      evt.imageAttachments?.[0]?.aesKeyHex,
      '00112233445566778899aabbccddeeff',
    )
    assert.deepEqual(evt.rawPayload, {
      item_list: [{ type: 1, text_item: { text: '你好 broker' } }, { type: 3, voice_item: { text: '语音' } }],
    })
    assert.equal(evt.idempotencyKey, 'wechat:888:wx-sender-xyz:mid-42')
    assert.equal(evt.receivedAt, NOW)
    assert.equal(evt.channel, 'wechat')
  })

  it('plain text + NO override: legacy ctx.dispatch path preserved', async () => {
    const { deps, cap } = makeDeps({ withOverride: false })
    await routeWechatInbound(makeEvent({ text: 'legacy dispatch' }), deps)
    assert.equal(cap.overrideCalls.length, 0)
    assert.equal(cap.dispatchCalls.length, 1)
    const frame = cap.dispatchCalls[0]! as Record<string, unknown>
    assert.equal(frame.type, 'inbound.message')
    assert.equal(frame.channel, 'wechat')
    assert.equal(frame.idempotencyKey, 'wechat:777:wx-sender-abc:msg-1')
    const peer = frame.peer as Record<string, unknown>
    assert.equal(peer.id, '777:wx-sender-abc')
    assert.equal(peer.kind, 'dm')
    assert.equal(peer.displayName, 'wx-sender-abc')
    assert.deepEqual(frame.content, { text: 'legacy dispatch' })
    assert.equal(frame.ts, NOW)
  })
})

describe('extractIlinkItemTypes', () => {
  it('dedupes known item types and falls back for unknown numeric types', () => {
    assert.equal(extractIlinkItemTypes({
      item_list: [
        { type: 1 },
        { type: 1 },
        { type: 2 },
        { type: 99 },
      ],
    }), 'text,image,type:99')
  })

  it('returns unknown for malformed or empty payloads', () => {
    assert.equal(extractIlinkItemTypes({}), 'unknown')
    assert.equal(extractIlinkItemTypes(null), 'unknown')
  })
})

describe('routeWechatInbound — override error handling', () => {
  it('override throws → catch + log.error; no rethrow, no fallback to dispatch', async () => {
    const { deps, cap } = makeDeps({
      withOverride: true,
      overrideThrow: new Error('broker exploded'),
    })
    // 关键:不抛 — worker long-poll loop 不应因 broker 失败停摆。
    await assert.doesNotReject(
      routeWechatInbound(makeEvent({ text: 'will fail' }), deps),
    )
    assert.equal(cap.overrideCalls.length, 1)
    assert.equal(cap.dispatchCalls.length, 0,
      '关键不变量:broker 失败不能回落 ctx.dispatch — 否则同一条消息走两套 session 命名空间')
    assert.equal(cap.logErrors.length, 1)
    assert.match(cap.logErrors[0]!, /broker override err/)
    assert.match(cap.logErrors[0]!, /broker exploded/)
  })

  it('override rejected with non-Error value still survives + logs something useful', async () => {
    // 异常路径鲁棒性:override 抛非 Error(例如字符串、null)时也不能崩 worker loop
    const { cap } = makeDeps({ withOverride: true })
    const deps2: WechatInboundRouterDeps = {
      ctx: {
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: (m: string) => cap.logErrors.push(m) } as any,
        dispatch: (f: unknown) => cap.dispatchCalls.push(f),
        resetSession: async () => {},
      } as any,
      workersCount: 1,
      sendText: () => {},
      onInboundOverride: async () => { throw 'string-thrown' },
      now: () => NOW,
    }
    await assert.doesNotReject(routeWechatInbound(makeEvent(), deps2))
    assert.equal(cap.dispatchCalls.length, 0)
    assert.equal(cap.logErrors.length, 1)
    // 容错语法 `err?.message || err` 保证非 Error 也能 stringify 进日志
    assert.match(cap.logErrors[0]!, /string-thrown/)
  })
})
