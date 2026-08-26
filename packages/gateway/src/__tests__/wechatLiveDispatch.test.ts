/**
 * Regression tests for v3 WeChat realtime-link dispatch.
 *
 * Product direction after the iLink 9-message failure: WeChat itself is not an
 * event-log surface.  A WeChat-originated turn streams detailed thinking/tools
 * to the linked Web session and sends only the final/error result back through
 * v3-wechat-outbound.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChannelAdapter } from '@openclaude/plugin-sdk'
import type { InboundFrame, OutboundMessage } from '@openclaude/protocol'

import { Gateway, PerTurnDelegationGuard } from '../server.js'

const SESSION_ID = 'wsess-0123456789abcdef'
const SENDER_ID = 'wx-sender-abc'

function makeFrame(): InboundFrame {
  return {
    type: 'inbound.message',
    channel: 'webchat',
    peer: { id: SESSION_ID, kind: 'dm', displayName: SENDER_ID } as any,
    content: { text: '用户问题', media: [] },
    _userId: '1',
  } as any
}

function makeGateway(events: any[], delivered: any[] = []): any {
  const agent = { id: 'main', provider: 'anthropic', model: 'claude-sonnet-4-6' }
  const gateway = Object.create(Gateway.prototype) as any
  gateway._shuttingDown = false
  gateway.clientsByPeer = new Map()
  gateway.lastActiveChannel = new Map()
  gateway._seenIdempotencyKeys = new Map()
  gateway._hiddenDelegateGuard = new PerTurnDelegationGuard()
  gateway.log = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
  gateway.rateLimiter = { check: () => true }
  gateway.router = {
    route: () => ({
      sessionKey: `agent:main:webchat:dm:${SESSION_ID}`,
      agent,
    }),
  }
  gateway.deps = {
    config: {
      version: 1,
      provider: 'anthropic',
      gateway: { bind: '127.0.0.1', port: 18791, accessToken: 'test' },
      auth: { mode: 'subscription', claudeCodePath: '/tmp/ccb' },
      defaults: { model: 'claude-sonnet-4-6', permissionMode: 'default' },
      channels: { webchat: { enabled: true }, wechat: { enabled: true } },
    },
  }
  gateway._getAgentsConfig = async () => ({ default: 'main', agents: [agent] })
  gateway._isIdempotencyDuplicate = () => false
  gateway._markIdempotencyKey = () => {}
  gateway._runLog = {
    start: () => ({}),
    complete: () => {},
  }
  gateway.submittedPayloads = []
  gateway.sessions = {
    getOrCreate: async () => ({
      agentId: 'main',
      currentTurnStatus: null,
      runner: { sendPermissionResponse: () => {} },
    }),
    submit: async (_session: unknown, payload: string, onEvent: (e: any) => void) => {
      gateway.submittedPayloads.push(payload)
      for (const e of events) onEvent(e)
    },
    // team-durability — dispatchInbound 的客户 turn 计数/迟到产物钩子(fake no-op)
    beginClientTurn: () => {},
    endClientTurn: () => {},
  }
  gateway.deliver = (out: unknown, adapter?: ChannelAdapter) => {
    delivered.push({ out, adapter })
  }
  return gateway
}

test('message reply snapshot is derived into the engine prompt without replacing current text', async () => {
  const gateway = makeGateway([])
  const frame = makeFrame() as any
  frame.content = {
    text: '请解释这一段',
    replyTo: {
      messageId: 'assistant-42',
      role: 'assistant',
      text: '完整历史回答',
    },
  }

  await gateway.dispatchInbound(frame)

  assert.deepEqual(gateway.submittedPayloads, [[
    '[被引用的历史消息｜发送者：助手｜消息ID：assistant-42｜原文字符数：6]',
    '完整历史回答',
    '[用户当前消息]',
    '请解释这一段',
  ].join('\n')])
})

function liveEvents(): any[] {
  return [
    { kind: 'block', block: { kind: 'thinking', text: '先分析一下' } },
    { kind: 'block', block: { kind: 'tool_use', blockId: 'toolu_1', toolName: 'Bash', inputJson: { command: 'pwd' }, partial: true } },
    { kind: 'block', block: { kind: 'tool_use', blockId: 'toolu_1', toolName: 'Bash', inputJson: { command: 'pwd' }, partial: false } },
    { kind: 'block', block: { kind: 'tool_output_tail', toolUseId: 'toolu_1', text: 'still running...' } },
    { kind: 'block', block: { kind: 'tool_result', toolUseId: 'toolu_1', text: '/tmp' } },
    { kind: 'block', block: { kind: 'text', text: '**答案**：完成' } },
    { kind: 'final', meta: { cost: 0.01, inputTokens: 10, outputTokens: 20, turn: 1 } },
  ]
}

test('v3 WeChat mirrors only final text to WeChat and streams process to linked Web session', async () => {
  const wechatCalls: any[] = []
  const delivered: any[] = []
  const adapter: ChannelAdapter = {
    id: 'v3-wechat-outbound',
    name: 'v3-wechat-outbound',
    type: 'channel' as const,
    async init() {},
    async shutdown() {},
    async send(out: OutboundMessage) {
      wechatCalls.push(out)
    },
  }

  const gateway = makeGateway(liveEvents(), delivered)
  await gateway.dispatchInbound(makeFrame(), adapter)

  assert.deepEqual(
    wechatCalls.map((out) => out.blocks.map((b: any) => b.kind)),
    [['text']],
  )
  assert.equal(wechatCalls[0]!.isFinal, true)
  assert.equal(wechatCalls[0]!.blocks[0]!.text, '**答案**：完成')
  assert.equal(wechatCalls.some((out) => '_userId' in out), false, 'private routing fields must not reach adapter')

  assert.deepEqual(
    delivered.map((d) => d.out.blocks?.[0]?.kind ?? 'empty-final'),
    ['thinking', 'tool_use', 'tool_use', 'tool_output_tail', 'tool_result', 'text', 'empty-final'],
  )
  assert.deepEqual(delivered.map((d) => d.adapter), [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ])
  assert.equal(delivered.at(-1)!.out.isFinal, true)
})

test('v3 WeChat sends a completion marker when final has no text for WeChat', async () => {
  const wechatCalls: any[] = []
  const delivered: any[] = []
  const adapter: ChannelAdapter = {
    id: 'v3-wechat-outbound',
    name: 'v3-wechat-outbound',
    type: 'channel' as const,
    async init() {},
    async shutdown() {},
    async send(out: OutboundMessage) {
      wechatCalls.push(out)
    },
  }
  const events = [
    { kind: 'block', block: { kind: 'thinking', text: '只思考不输出文本' } },
    { kind: 'final', meta: { turn: 1 } },
  ]

  const gateway = makeGateway(events, delivered)
  await gateway.dispatchInbound(makeFrame(), adapter)

  assert.equal(wechatCalls.length, 1)
  assert.equal(wechatCalls[0]!.isFinal, true)
  assert.match(wechatCalls[0]!.blocks[0]!.text, /任务已完成/)
  assert.deepEqual(
    delivered.map((d) => d.out.blocks?.[0]?.kind ?? 'empty-final'),
    ['thinking', 'text', 'empty-final'],
  )
  assert.equal(delivered[1]!.out.blocks[0]!.text, '本轮未能产出可见回复，已结束，可重试或继续')
  assert.equal(delivered[1]!.out.isFinal, false)
  assert.equal(delivered.at(-1)!.out.isFinal, true)
})

test('non-WeChat adapters keep historical aggregate-on-final behavior', async () => {
  const delivered: any[] = []
  const adapter: ChannelAdapter = {
    id: 'telegram',
    name: 'telegram',
    type: 'channel' as const,
    init: async () => {},
    shutdown: async () => {},
    send: async () => {},
  }
  const gateway = makeGateway(liveEvents(), delivered)
  await gateway.dispatchInbound(makeFrame(), adapter)

  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]!.adapter, adapter)
  const out = delivered[0]!.out
  assert.equal(out.isFinal, true)
  assert.deepEqual(out.blocks.map((b: any) => b.kind), ['thinking', 'tool_use', 'tool_result', 'text'])
})

test('retrying API error attempt stays non-terminal and the next successful attempt streams live', async () => {
  const delivered: any[] = []
  const gateway = makeGateway([
    {
      kind: 'block',
      block: {
        kind: 'text',
        text: 'API Error: 429 {"error":{"code":"CONCURRENT_LIMIT","message":"concurrent limit reached"}}',
      },
    },
    { kind: 'final', meta: { turn: 1 } },
    {
      kind: 'turn_status',
      status: {
        status: 'retrying',
        retry: { attempt: 2, max: 10, delayMs: 1000, retryAt: 1_700_000_001_000 },
      },
    },
    { kind: 'block', block: { kind: 'text', text: '重试成功' } },
    { kind: 'final', meta: { turn: 2 } },
  ], delivered)

  await gateway.dispatchInbound(makeFrame())

  assert.equal(
    delivered.some(({ out }) => out.type === 'outbound.error'),
    false,
    'an intermediate failed attempt must not become a red terminal error card',
  )
  assert.deepEqual(
    delivered.map(({ out }) => ({
      type: out.type,
      status: out.status,
      text: out.blocks?.[0]?.text,
      final: out.isFinal === true,
    })),
    [
      { type: 'outbound.turn_status', status: 'retrying', text: undefined, final: false },
      { type: 'outbound.message', status: undefined, text: '重试成功', final: false },
      { type: 'outbound.message', status: undefined, text: undefined, final: true },
    ],
  )
})

test('exhausted API error attempt still emits the structured terminal error and final', async () => {
  const delivered: any[] = []
  const gateway = makeGateway([
    {
      kind: 'block',
      block: {
        kind: 'text',
        text: 'API Error: 429 {"error":{"code":"CONCURRENT_LIMIT","message":"concurrent limit reached"}}',
      },
    },
    { kind: 'final', meta: { turn: 1 } },
  ], delivered)

  await gateway.dispatchInbound(makeFrame())

  assert.deepEqual(delivered.map(({ out }) => out.type), [
    'outbound.error',
    'outbound.message',
  ])
  assert.equal(delivered[0]!.out.code, 'rate_limited')
  assert.equal(delivered[0]!.out.isFinal, false)
  assert.equal(delivered[1]!.out.isFinal, true)
  assert.match(delivered[1]!.out.blocks[0]!.text, /^\[error\] API Error: 429/)
})
