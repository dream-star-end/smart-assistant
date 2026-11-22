/**
 * Run: npx tsx --test packages/commercial/src/__tests__/imRemoteControl.test.ts
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import type { Pool } from 'pg'
import type { QQBot, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs'
import {
  InMemoryBrowserHandoffStore,
  InMemoryTaskboardDecisionBackend,
  ShortCodeRegistry,
  createBrowserHandoffSource,
  createImRemoteControlHandler,
  createPendingDecisionsService,
  createTaskboardSource,
} from '../pendingDecisions/index.js'
import { makeWechatBroker } from '../wechat/broker.js'
import type { InboundDispatcher, InboundEvent } from '../wechat/inboundDispatcher.js'
import { pushWechatPendingDecision } from '../wechat/pendingDecisionPush.js'
import { pushQqPendingDecision } from '../qqbot/pendingDecisionPush.js'
import { makeQqBotService } from '../qqbot/service.js'

function createFakeQqBot() {
  const ee = new EventEmitter()
  const sent: Array<{ target: unknown; text: string }> = []
  const bot = Object.assign(ee, {
    gateway: {
      currentWs: {},
      isConnecting: false,
      reconnectTimer: null,
      isAborted: false,
      reconnect: { isExhausted: () => false },
    },
    start: async () => {
      queueMicrotask(() => ee.emit('ready'))
      return new Promise<void>((resolve) => {
        ee.once('__stopped', resolve)
      })
    },
    stop: () => {
      ee.emit('__stopped')
    },
    sendText: async (target: unknown, text: string) => {
      sent.push({ target, text })
    },
    sendMedia: async () => {},
  })
  return { bot: bot as unknown as QQBot, ee, sent }
}

describe('ShortCodeRegistry — B8 cooldown, TTL & uid isolation', () => {
  it('assigns deterministic bidirectional codes, enforces cooldown after release, TTL, and uid isolation', () => {
    let now = 1_700_000_000_000
    let seq = 4828
    const registry = new ShortCodeRegistry({
      now: () => now,
      defaultTtlMs: 60_000,
      cooldownMs: 10 * 60_000,
      randCode: () => {
        // First two calls attempt 4829 to verify cooldown forces a distinct code!
        seq = seq < 4829 ? 4829 : 4830
        return seq
      },
    })

    const assigned = registry.getOrAssign('42', 'taskboard:tb-1@v1')
    assert.equal(assigned.code, '4829')
    assert.equal(registry.getCodeForDecision('42', 'taskboard:tb-1@v1'), '4829')
    assert.equal(registry.lookup('99', '4829').ok, false)

    // Invalidate (after resolve) -> code 4829 enters cooldown and MUST NOT be immediately reassigned!
    registry.invalidateByDecisionId('42', 'taskboard:tb-1@v1')
    const nextAssigned = registry.getOrAssign('42', 'taskboard:tb-2@v1')
    assert.notEqual(nextAssigned.code, '4829')
    assert.equal(nextAssigned.code, '4830')

    // After TTL elapses, lookup fails as expired
    now += 61_000
    const expired = registry.lookup('42', '4830')
    assert.equal(expired.ok, false)
    if (!expired.ok) assert.equal(expired.reason, 'expired')
  })
})

describe('B7 — WeChat owner verification, shared-bot negative control & authoritative proactive push', () => {
  async function buildImStack() {
    let now = 1_700_000_000_000
    const taskboard = new InMemoryTaskboardDecisionBackend()
    taskboard.upsert({
      id: 'tb-10',
      identifier: 'OCV5-827',
      userId: '42',
      title: '发布首页更新',
      summary: '确认发布 staging -> prod',
      status: 'waiting_human',
      version: 1,
      priority: 'P1',
      createdAt: new Date(now),
    })
    const browserStore = new InMemoryBrowserHandoffStore({ now: () => now })
    await browserStore.create({
      id: 'bh-10',
      userId: '42',
      sessionId: 'wsess-1111111111111111',
      title: '登录二步验证',
      url: 'https://console.example.com',
      reason: '需要扫码完成 2FA',
      ttlMs: 10 * 60_000,
    })

    const service = createPendingDecisionsService({
      sources: [createTaskboardSource(taskboard), createBrowserHandoffSource(browserStore)],
      now: () => now,
    })

    let seq = 5100
    const shortCodes = new ShortCodeRegistry({
      now: () => now,
      randCode: () => ++seq,
    })

    let currentSessionId = 'wsess-1111111111111111'
    const sessionsList = [
      { sessionId: 'wsess-1111111111111111', title: '日常研发会话', agentId: 'main' },
      { sessionId: 'wsess-2222222222222222', title: '运维排障会话', agentId: 'ops' },
    ]

    const remoteControl = createImRemoteControlHandler({
      pendingDecisions: service,
      shortCodes,
      now: () => now,
      sessions: {
        listSessions: async () => sessionsList,
        getCurrentSessionId: async () => currentSessionId,
        switchSession: async (_uid, sessionId) => {
          currentSessionId = sessionId
        },
      },
    })

    return {
      service,
      shortCodes,
      remoteControl,
      getCurrentSessionId: () => currentSessionId,
    }
  }

  it('rejects non-owner sender on the SAME WeChat bot for /pending, /approve, /sessions, /switch while allowing owner', async () => {
    const stack = await buildImStack()
    const sentTexts: Array<{ toUserId: string; text: string }> = []
    const dispatcher: InboundDispatcher = {
      dispatch: async () => ({
        kind: 'dispatched',
        sessionId: 'wsess-1111111111111111',
        newSession: false,
      }),
      stop: async () => ({ kind: 'command_echo', reply: 'stopped', interrupted: true }),
    }
    const fakePool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool

    const broker = makeWechatBroker({
      pgPool: fakePool,
      dispatcher,
      outboundReceiver: async () => {},
      allMasterWsessRows: async () => [],
      softDeleteMasterSession: async () => {},
      sendText: async (p) => {
        sentTexts.push({ toUserId: p.toUserId, text: p.text })
        return { ok: true }
      },
      // SQLite key is `c:42`, bound owner is `owner-wx-42@im.wechat`, another contact `other-contact` also messaged the bot
      getBinding: async (key) =>
        key === 'c:42'
          ? {
              botToken: 'tok-wx',
              status: 'active',
              loginUserId: 'owner-wx-42@im.wechat',
              contextTokens: {
                'other-contact': 'ctx-other',
                'owner-wx-42': 'ctx-owner',
              },
            }
          : null,
      brokerEnabled: () => true,
      remoteControl: stack.remoteControl,
      isProactiveEnabled: async () => true,
    })

    const mkEvt = (text: string, senderId: string): InboundEvent => ({
      bindingUserId: 'c:42',
      senderId,
      text,
      idempotencyKey: `ik-${Math.random()}`,
      receivedAt: Date.now(),
    })

    // 1. Non-owner on the SAME bindingUserId (`c:42`) is REJECTED for high-privilege commands!
    for (const cmd of ['/pending', '/approve 5101', '/sessions', '/switch 2']) {
      const denied = await broker.onInbound(mkEvt(cmd, 'other-contact'))
      assert.equal(denied.kind, 'command_echo')
      if (denied.kind === 'command_echo') {
        assert.match(denied.reply, /仅限当前已绑定的微信账号本人/)
      }
    }

    // 2. Owner (`owner-wx-42`) succeeds on /pending, /approve, /sessions, /switch!
    const pending = await broker.onInbound(mkEvt('/pending', 'owner-wx-42'))
    assert.equal(pending.kind, 'command_echo')
    if (pending.kind === 'command_echo') {
      assert.match(pending.reply, /当前有 2 项待拍板/)
      assert.match(pending.reply, /\[5101\]/)
    }

    const approved = await broker.onInbound(mkEvt('/approve 5101 本人确认', 'owner-wx-42'))
    assert.equal(approved.kind, 'command_echo')
    if (approved.kind === 'command_echo') {
      assert.match(approved.reply, /已批准短码 5101/)
    }

    const switched = await broker.onInbound(mkEvt('/switch 2', 'owner-wx-42'))
    assert.equal(switched.kind, 'command_echo')
    assert.equal(stack.getCurrentSessionId(), 'wsess-2222222222222222')

    // 3. Proactive push resolves `c:42` binding and delivers ONLY to `owner-wx-42` (NOT `other-contact`!)
    const pushRes = await broker.pushPendingDecision({
      id: 'taskboard:tb-push@v1',
      source: 'taskboard',
      sourceId: 'tb-push@v1',
      userId: '42',
      sessionId: null,
      title: '紧急回滚审批',
      summary: '确认回滚到上一版本',
      riskLevel: 'critical',
      status: 'pending',
      metadata: {},
      createdAt: new Date().toISOString(),
      expiresAt: null,
      allowedActions: ['approve', 'deny'],
    })
    assert.equal(pushRes.outcome, 'sent')
    assert.equal(sentTexts.at(-1)!.toUserId, 'owner-wx-42')
  })

  it('WeChat & QQ proactive push never fall back to first contact, never emit 0000, and respect pref_off', async () => {
    const stack = await buildImStack()
    const item = {
      id: 'taskboard:tb-neg@v1',
      source: 'taskboard' as const,
      sourceId: 'tb-neg@v1',
      userId: '42',
      sessionId: null,
      title: '敏感审批',
      summary: '敏感操作',
      riskLevel: 'high' as const,
      status: 'pending' as const,
      metadata: {},
      createdAt: new Date().toISOString(),
      expiresAt: null,
      allowedActions: ['approve', 'deny'] as const,
    }

    // Missing owner token when another contact has a token -> skipped (no_context_token), NEVER sent to bystander!
    let sentCount = 0
    const noOwnerToken = await pushWechatPendingDecision({
      item,
      getBinding: async (key) =>
        key === 'c:42'
          ? {
              botToken: 'tok',
              status: 'active',
              loginUserId: 'owner-42@im.wechat',
              contextTokens: { 'bystander-1': 'ctx-bystander' },
            }
          : null,
      sendText: async () => {
        sentCount += 1
        return { ok: true }
      },
      isProactiveEnabled: async () => true,
      remoteControl: stack.remoteControl,
    })
    assert.equal(noOwnerToken.outcome, 'skipped')
    assert.equal(noOwnerToken.reason, 'no_context_token')
    assert.equal(sentCount, 0)

    // Legacy bare-uid binding MUST NOT be used when canonical `c:42` is missing
    const bareOnly = await pushWechatPendingDecision({
      item,
      getBinding: async (key) =>
        key === '42'
          ? {
              botToken: 'tok',
              status: 'active',
              loginUserId: 'owner-42@im.wechat',
              contextTokens: { 'owner-42': 'ctx-owner' },
            }
          : null,
      sendText: async () => ({ ok: true }),
      isProactiveEnabled: async () => true,
      remoteControl: stack.remoteControl,
    })
    assert.equal(bareOnly.outcome, 'skipped')
    assert.equal(bareOnly.reason, 'no_binding')

    // Missing isProactiveEnabled fails closed (pref_unavailable) on both WeChat & QQ
    const wxNoPref = await pushWechatPendingDecision({
      item,
      getBinding: async (key) =>
        key === 'c:42'
          ? {
              botToken: 'tok',
              status: 'active',
              loginUserId: 'owner-42@im.wechat',
              contextTokens: { 'owner-42': 'ctx-owner' },
            }
          : null,
      sendText: async () => ({ ok: true }),
      remoteControl: stack.remoteControl,
    })
    assert.equal(wxNoPref.outcome, 'skipped')
    assert.equal(wxNoPref.reason, 'pref_unavailable')

    // Proactive push disabled -> skipped (pref_off)
    const prefOff = await pushWechatPendingDecision({
      item,
      getBinding: async () => ({
        botToken: 'tok',
        status: 'active',
        loginUserId: 'owner-42@im.wechat',
        contextTokens: { 'owner-42': 'ctx-owner' },
      }),
      sendText: async () => ({ ok: true }),
      isProactiveEnabled: async () => false,
      remoteControl: stack.remoteControl,
    })
    assert.equal(prefOff.outcome, 'skipped')
    assert.equal(prefOff.reason, 'pref_off')

    // Missing ShortCodeRegistry -> fails instead of fabricating 0000
    const noRegistry = await pushWechatPendingDecision({
      item,
      getBinding: async () => ({
        botToken: 'tok',
        status: 'active',
        loginUserId: 'owner-42@im.wechat',
        contextTokens: { 'owner-42': 'ctx-owner' },
      }),
      sendText: async () => ({ ok: true }),
      isProactiveEnabled: async () => true,
    })
    assert.equal(noRegistry.outcome, 'failed')
    assert.equal(noRegistry.reason, 'short_code_registry_required')

    // QQ proactive push missing pref -> pref_unavailable; pref_off -> pref_off; missing ShortCodeRegistry -> failed
    const fakePool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool
    const qqNoPref = await pushQqPendingDecision({
      pool: fakePool,
      item,
      sendC2cText: async () => {},
      remoteControl: stack.remoteControl,
    })
    assert.equal(qqNoPref.outcome, 'skipped')
    assert.equal(qqNoPref.reason, 'pref_unavailable')

    const qqPrefOff = await pushQqPendingDecision({
      pool: fakePool,
      item,
      sendC2cText: async () => {},
      isProactiveEnabled: async () => false,
      remoteControl: stack.remoteControl,
    })
    assert.equal(qqPrefOff.outcome, 'skipped')
    assert.equal(qqPrefOff.reason, 'pref_off')

    const qqNoReg = await pushQqPendingDecision({
      pool: fakePool,
      item,
      sendC2cText: async () => {},
      isProactiveEnabled: async () => true,
    })
    assert.equal(qqNoReg.outcome, 'failed')
    assert.equal(qqNoReg.reason, 'short_code_registry_required')
  })

  it('QQBot service handles /pending, /approve, /sessions, /switch and proactive push', async () => {
    const stack = await buildImStack()
    const fakeQq = createFakeQqBot()
    const fakePool = {
      query: async (sql: string) => {
        if (sql.includes('FROM qq_bot_bindings')) {
          return {
            rows: [
              {
                user_id: '42',
                bot_openid: 'qq-openid-42',
                binding_version: '1',
                bound_at: '1000',
                last_interaction_at: '2000',
              },
            ],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      },
    } as unknown as Pool

    const dispatcher: InboundDispatcher = {
      dispatch: async () => ({
        kind: 'dispatched',
        sessionId: 'wsess-1111111111111111',
        newSession: false,
      }),
      stop: async () => ({ kind: 'command_echo', reply: 'stopped', interrupted: true }),
    }

    const svc = makeQqBotService({
      pool: fakePool,
      config: {
        appId: 'app-1',
        appSecret: 'sec-1',
        bindingHmacSecret: 'hmac-1',
        entryUrl: 'https://qq.example.test',
      },
      dispatcher,
      botFactory: () => fakeQq.bot,
      outboxWorkerFactory: () => ({ kick() {}, stop: async () => {} }),
      remoteControl: stack.remoteControl,
      isProactiveEnabled: async () => true,
    })

    await svc.start()
    const sendInbound = async (content: string) => {
      const msg: QQBotInboundMessage = {
        kind: 'c2c',
        senderId: 'qq-openid-42',
        content,
        messageId: `qq-msg-${Math.random()}`,
        timestamp: new Date().toISOString(),
        replyTarget: { scope: 'c2c', targetId: 'qq-openid-42' },
        attachments: [],
      } as unknown as QQBotInboundMessage
      for (const fn of fakeQq.ee.listeners('message')) {
        await (fn as (ctx: unknown, m: QQBotInboundMessage) => Promise<void>)({}, msg)
      }
    }

    await sendInbound('/pending')
    assert.match(fakeQq.sent.at(-1)!.text, /当前有 2 项待拍板/)
    await sendInbound('/approve 5101 QQ批准')
    assert.match(fakeQq.sent.at(-1)!.text, /已批准短码 5101/)
    await sendInbound('/sessions')
    assert.match(fakeQq.sent.at(-1)!.text, /最近会话（QQ）/)
    await sendInbound('/switch 2')
    assert.match(fakeQq.sent.at(-1)!.text, /已切换到会话：运维排障会话/)

    await svc.stop()
  })
})
