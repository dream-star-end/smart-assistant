import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { ChannelContext } from '@openclaude/plugin-sdk'
import type { OutboundMessage } from '@openclaude/protocol'

import { type V3WechatOutboundConfig, makeV3QqbotOutboundAdapter } from '../v3WechatOutbound.js'
import type {
  V3WechatRetryEntry,
  V3WechatRetryQueue,
  V3WechatSinkWirePayload,
} from '../v3WechatRetryQueue.js'

const CONFIG: V3WechatOutboundConfig = {
  baseUrl: 'http://master.test:18791',
  bearer: `oc-v3.7.${'a'.repeat(64)}`,
  agentId: 'main',
}

function fakeQueue(): V3WechatRetryQueue & { rows: V3WechatRetryEntry[] } {
  const queue = {
    rows: [] as V3WechatRetryEntry[],
    async enqueueDurable(entry: V3WechatRetryEntry) {
      queue.rows.push(entry)
    },
    async drainOnce() {
      return {
        considered: 0,
        drained: 0,
        retried: 0,
        ttlDropped: 0,
        fatalDropped: 0,
        errors: 0,
        pending: 0,
      }
    },
    kick() {},
    startPeriodic() {},
    stopPeriodic() {},
    async pendingCount() {
      return queue.rows.length
    },
  }
  return queue
}

describe('v3 QQ outbound adapter', () => {
  test('stages a QQ payload only through the explicitly selected adapter', async () => {
    const queue = fakeQueue()
    const adapter = makeV3QqbotOutboundAdapter({
      config: CONFIG,
      retryQueue: queue,
      now: () => 1234,
    })
    await adapter.init({
      log: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
    } as unknown as ChannelContext)
    const out: OutboundMessage = {
      type: 'outbound.message',
      sessionKey: 'agent:main:webchat:dm:wsess-0123456789abcdef',
      channel: 'webchat',
      peer: {
        kind: 'dm',
        id: 'wsess-0123456789abcdef',
        displayName: 'qq-openid-1',
      },
      outboundId: 'qq.delivery.1',
      blocks: [{ kind: 'text', text: '完整回复' }],
      isFinal: true,
    } as OutboundMessage
    await adapter.send(out)
    assert.equal(queue.rows.length, 1)
    const payload = queue.rows[0]!.payload as V3WechatSinkWirePayload
    assert.equal(payload.channel, 'qqbot')
    assert.equal(payload.outboundId, 'qq.delivery.1')
    assert.equal(payload.peer.meta.senderId, 'qq-openid-1')
    assert.deepEqual(payload.blocks, out.blocks)
  })
})
