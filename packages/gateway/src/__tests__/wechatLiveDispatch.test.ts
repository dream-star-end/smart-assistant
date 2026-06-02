/**
 * Regression tests for v3 WeChat live process messages.
 *
 * The commercial WeChat broker path used to aggregate every adapter block and
 * send them only after final. Users saw thinking/tool process bubbles replayed
 * after the assistant had already finished.  v3-wechat-outbound is the one
 * adapter that must stream process blocks live while preserving final Markdown
 * aggregation for assistant text.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ChannelAdapter } from '@openclaude/plugin-sdk'
import type { InboundFrame, OutboundMessage } from '@openclaude/protocol'

import { Gateway } from '../server.js'

const SESSION_ID = 'wsess-0123456789abcdef'
const SENDER_ID = 'wx-sender-abc'

function makeFrame(): InboundFrame {
  return {
    type: 'inbound.message',
    channel: 'wechat',
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
  gateway.log = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }
  gateway.rateLimiter = { check: () => true }
  gateway.router = {
    route: () => ({
      sessionKey: `agent:main:wechat:dm:${SESSION_ID}`,
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
  gateway.sessions = {
    getOrCreate: async () => ({
      agentId: 'main',
      currentTurnStatus: null,
      runner: { sendPermissionResponse: () => {} },
    }),
    submit: async (_session: unknown, _payload: string, onEvent: (e: any) => void) => {
      for (const e of events) onEvent(e)
    },
  }
  gateway.deliver = (out: unknown, adapter?: ChannelAdapter) => {
    delivered.push({ out, adapter })
  }
  return gateway
}

function liveEvents(): any[] {
  return [
    { kind: 'block', block: { kind: 'thinking', text: '先分析一下' } },
    { kind: 'block', block: { kind: 'tool_use', blockId: 'toolu_1', toolName: 'Bash', inputJson: { command: 'pwd' }, partial: true } },
    // The finalized snapshot for the same tool must not create a second WeChat
    // process bubble. Web can update an existing row; WeChat cannot edit old
    // bubbles, so one tool_use event maps to one live message.
    { kind: 'block', block: { kind: 'tool_use', blockId: 'toolu_1', toolName: 'Bash', inputJson: { command: 'pwd' }, partial: false } },
    { kind: 'block', block: { kind: 'text', text: '**答案**：完成' } },
    { kind: 'final', meta: { cost: 0.01, inputTokens: 10, outputTokens: 20, turn: 1 } },
  ]
}

test('v3 WeChat streams process blocks live, serializes adapter sends, and final does not replay process', async () => {
  const calls: any[] = []
  let inFlight = 0
  let maxInFlight = 0
  const adapter: ChannelAdapter = {
    id: 'v3-wechat-outbound',
    name: 'v3-wechat-outbound',
    type: 'channel' as const,
    async init() {},
    async shutdown() {},
    async send(out: OutboundMessage) {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      calls.push(out)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
    },
  }

  const gateway = makeGateway(liveEvents())
  await gateway.dispatchInbound(makeFrame(), adapter)

  assert.equal(maxInFlight, 1, 'live WeChat adapter sends must be queued, not fire-and-forget concurrent')
  assert.deepEqual(
    calls.map((out) => out.blocks.map((b: any) => b.kind)),
    [['thinking'], ['tool_use'], ['text']],
  )
  assert.deepEqual(calls.map((out) => out.isFinal), [false, false, true])
  assert.equal(calls[0]!.blocks[0]!.text, '正在思考…')
  assert.equal(calls[0]!.blocks[0]!.text.includes('先分析一下'), false)
  assert.equal(calls[2]!.blocks[0]!.text, '**答案**：完成')
  assert.equal(calls[0]!.traceId, calls[1]!.traceId)
  assert.equal(calls[1]!.traceId, calls[2]!.traceId)
  const outboundIds = calls.map((out) => (out as any).outboundId)
  assert.equal(new Set(outboundIds).size, 3, 'each live message needs a unique outboundId for master outbox dedup')
  assert.ok(outboundIds.every((id) => /^[A-Za-z0-9._:-]{8,128}$/.test(id)))
  assert.equal(calls.some((out) => '_userId' in out), false, 'private routing fields must not reach adapter')
})

test('v3 WeChat caps live process bubbles so final answer is not starved', async () => {
  const calls: any[] = []
  const adapter: ChannelAdapter = {
    id: 'v3-wechat-outbound',
    name: 'v3-wechat-outbound',
    type: 'channel' as const,
    async init() {},
    async shutdown() {},
    async send(out: OutboundMessage) {
      calls.push(out)
    },
  }
  const noisyEvents: any[] = [
    { kind: 'block', block: { kind: 'thinking', text: 'raw internal thought 1' } },
    { kind: 'block', block: { kind: 'thinking', text: 'raw internal thought 2' } },
  ]
  for (let i = 1; i <= 10; i++) {
    noisyEvents.push({
      kind: 'block',
      block: { kind: 'tool_use', blockId: `toolu_${i}`, toolName: 'Bash', inputJson: { command: `echo ${i}` } },
    })
  }
  noisyEvents.push(
    { kind: 'block', block: { kind: 'text', text: '最终答案' } },
    { kind: 'final', meta: { cost: 0.01, inputTokens: 10, outputTokens: 20, turn: 1 } },
  )

  const gateway = makeGateway(noisyEvents)
  await gateway.dispatchInbound(makeFrame(), adapter)

  assert.deepEqual(
    calls.map((out) => out.blocks[0]!.kind),
    ['thinking', 'tool_use', 'tool_use', 'tool_use', 'text'],
  )
  assert.equal(calls[0]!.blocks[0]!.text, '正在思考…')
  assert.equal(calls.at(-1)!.isFinal, true)
  assert.equal(calls.at(-1)!.blocks[0]!.text, '最终答案')
  assert.equal(
    calls.slice(0, -1).length,
    4,
    'live process bubbles stay below the observed iLink burst rejection threshold',
  )
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
  assert.deepEqual(out.blocks.map((b: any) => b.kind), ['thinking', 'tool_use', 'text'])
})
