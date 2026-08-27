/**
 * W1 cron 送达置顶:显式通道先于 QQ/微信自动瀑布。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/cronDeliver.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cronDeliveryId, type CronJob } from '../cron.js'
import { deliverCronOutput, type CronDeliverDeps, type CronLastActive } from '../cronDeliver.js'
import type { ProactiveDeliveryResult } from '../v3WechatProactive.js'
import type { V3WechatOutboundConfig } from '../v3WechatOutbound.js'

const CFG: V3WechatOutboundConfig = { baseUrl: 'http://master', bearer: 'tok' }
const NOW = 1_700_000_000_000
const JOB: CronJob = {
  id: 'remind-abc-1',
  schedule: '0 9 * * *',
  agent: 'main',
  prompt: 'p',
  deliver: 'webchat',
  label: '早报',
}

function lastActiveWebchat(overrides: Partial<CronLastActive> = {}): CronLastActive {
  return {
    channel: 'webchat',
    peerId: 'peer-1',
    sessionKey: 'sess-1',
    userId: '3',
    at: NOW - 60_000,
    ...overrides,
  }
}

function makeDeps(opts: {
  lastActive?: CronLastActive
  onlinePeer?: boolean
  extraClients?: Array<{ send(data: string): void }>
  channels?: CronDeliverDeps['channels']
  qq?: ProactiveDeliveryResult
  wechat?: ProactiveDeliveryResult
  inbox?: (args: { deliveryKey: string; title: string; bodyMd: string }) => Promise<boolean>
}): {
  deps: CronDeliverDeps
  calls: {
    qq: number
    wechat: number
    deliver: number
    adapter: string[]
    inbox: Array<{ deliveryKey: string; title: string; bodyMd: string }>
    broadcast: string[]
  }
} {
  const calls = {
    qq: 0,
    wechat: 0,
    deliver: 0,
    adapter: [] as string[],
    inbox: [] as Array<{ deliveryKey: string; title: string; bodyMd: string }>,
    broadcast: [] as string[],
  }
  const clientsByPeer = new Map<string, Set<{ send(data: string): void }>>()
  if (opts.onlinePeer) {
    clientsByPeer.set('3:webchat:peer-1', new Set([{ send: (data) => { calls.broadcast.push(data) } }]))
  }
  if (opts.extraClients?.length) {
    clientsByPeer.set('9:webchat:other', new Set(opts.extraClients.map((ws) => ({
      send: (data: string) => {
        calls.broadcast.push(data)
        ws.send(data)
      },
    }))))
  }
  const lastActiveChannel = new Map<string, CronLastActive>()
  if (opts.lastActive) lastActiveChannel.set('main', opts.lastActive)

  const deps: CronDeliverDeps = {
    lastActiveChannel,
    clientsByPeer,
    channels: opts.channels ?? new Map(),
    deliver: () => { calls.deliver++ },
    makePeerKey: (userId, channel, peerId) => `${userId}:${channel}:${peerId}`,
    now: () => NOW,
    qqProactiveCfg: opts.qq ? CFG : null,
    wechatProactiveCfg: opts.wechat ? CFG : null,
    sendQqProactive: async () => {
      calls.qq++
      return opts.qq ?? { kind: 'fallback', marked: false }
    },
    sendWechatProactive: async () => {
      calls.wechat++
      return opts.wechat ?? { kind: 'fallback', marked: false }
    },
    postInboxDurable: async (args) => {
      calls.inbox.push({ deliveryKey: args.deliveryKey, title: args.title, bodyMd: args.bodyMd })
      return opts.inbox ? opts.inbox(args) : true
    },
  }
  return { deps, calls }
}

describe('deliverCronOutput — 显式通道置顶', () => {
  it('显式 webchat 在线命中不触 QQ/微信', async () => {
    const { deps, calls } = makeDeps({
      lastActive: lastActiveWebchat(),
      onlinePeer: true,
      qq: { kind: 'delivered' },
      wechat: { kind: 'delivered' },
    })
    await deliverCronOutput('hello', { ...JOB, deliver: 'webchat' }, { dueMinuteKey: 1, deliveryId: 'cron.web' }, deps)
    assert.equal(calls.deliver, 1)
    assert.equal(calls.qq, 0)
    assert.equal(calls.wechat, 0)
    assert.equal(calls.inbox.length, 0)
  })

  it('显式 telegram 成功不触 QQ/微信', async () => {
    const channels = new Map<string, { send(value: unknown): Promise<void> }>()
    channels.set('telegram', {
      send: async () => { /* delivered */ },
    })
    const { deps, calls } = makeDeps({
      channels,
      qq: { kind: 'delivered' },
      wechat: { kind: 'delivered' },
    })
    const tracked = channels.get('telegram')!
    channels.set('telegram', {
      send: async (value) => {
        calls.adapter.push('telegram')
        await tracked.send(value)
      },
    })
    await deliverCronOutput('hello', { ...JOB, deliver: 'telegram' }, { dueMinuteKey: 1, deliveryId: 'cron.tg' }, deps)
    assert.deepEqual(calls.adapter, ['telegram'])
    assert.equal(calls.qq, 0)
    assert.equal(calls.wechat, 0)
    assert.equal(calls.deliver, 0)
    assert.equal(calls.inbox.length, 0)
  })

  it('显式通道失败回落自动瀑布,QQ retryable 仍上抛', async () => {
    const channels = new Map<string, { send(value: unknown): Promise<void> }>()
    channels.set('telegram', {
      send: async () => { throw new Error('telegram down') },
    })
    const { deps, calls } = makeDeps({
      channels,
      qq: { kind: 'failure', retryable: true, code: 'QQ_TRANSPORT_FAILED' },
      wechat: { kind: 'delivered' },
    })
    await assert.rejects(
      () => deliverCronOutput('hello', { ...JOB, deliver: 'telegram' }, { dueMinuteKey: 1, deliveryId: 'cron.tg-fail' }, deps),
      (err: unknown) =>
        err instanceof Error &&
        (err as Error & { code?: string; retryable?: boolean }).code === 'QQ_TRANSPORT_FAILED' &&
        (err as Error & { retryable?: boolean }).retryable === true,
    )
    assert.equal(calls.qq, 1)
    assert.equal(calls.wechat, 0)
    assert.equal(calls.inbox.length, 0)
  })

  it('显式 webchat 离线后微信 retryable 仍上抛', async () => {
    const { deps, calls } = makeDeps({
      lastActive: lastActiveWebchat(),
      onlinePeer: false,
      qq: { kind: 'fallback', marked: false },
      wechat: { kind: 'failure', retryable: true, code: 'WECHAT_MASTER_UNAVAILABLE' },
    })
    await assert.rejects(
      () => deliverCronOutput('hello', { ...JOB, deliver: 'webchat' }, { dueMinuteKey: 1, deliveryId: 'cron.wx' }, deps),
      (err: unknown) =>
        err instanceof Error &&
        (err as Error & { code?: string; retryable?: boolean }).code === 'WECHAT_MASTER_UNAVAILABLE' &&
        (err as Error & { retryable?: boolean }).retryable === true,
    )
    assert.equal(calls.qq, 1)
    assert.equal(calls.wechat, 1)
    assert.equal(calls.inbox.length, 0)
  })

  it('全部不可达 → inbox durable 且同 deliveryKey 幂等', async () => {
    const { deps, calls } = makeDeps({})
    const deliveryId = cronDeliveryId(JOB.id, 42)
    await deliverCronOutput('body-one', { ...JOB, deliver: 'webchat' }, { dueMinuteKey: 42, deliveryId }, deps)
    await deliverCronOutput('body-one', { ...JOB, deliver: 'webchat' }, { dueMinuteKey: 42, deliveryId }, deps)
    assert.equal(calls.inbox.length, 2)
    assert.equal(calls.inbox[0]!.deliveryKey, deliveryId)
    assert.equal(calls.inbox[1]!.deliveryKey, deliveryId)
    assert.equal(calls.inbox[0]!.bodyMd, 'body-one')
    assert.equal(calls.inbox[0]!.title, '早报')
    assert.equal(calls.qq, 0)
    assert.equal(calls.wechat, 0)
  })

  it('显式 webchat 广播命中后不再兜底站内信', async () => {
    const { deps, calls } = makeDeps({
      extraClients: [{ send: () => {} }],
      qq: { kind: 'delivered' },
    })
    await deliverCronOutput('hello', { ...JOB, deliver: 'webchat' }, { dueMinuteKey: 1, deliveryId: 'cron.bc' }, deps)
    assert.ok(calls.broadcast.length > 0)
    assert.equal(calls.qq, 0)
    assert.equal(calls.inbox.length, 0)
  })

  it('微信会话过期标注后 lastActive webchat 仍走 deliver()', async () => {
    const { deps, calls } = makeDeps({
      lastActive: lastActiveWebchat(),
      onlinePeer: true,
      wechat: { kind: 'fallback', marked: true },
    })
    // 无显式通道(空)走自动瀑布,模拟状态通知之外的「未设 deliver」不会发生;
    // 这里用一个未注册 adapter 名迫使显式失败再回落。
    await deliverCronOutput(
      'raw',
      { ...JOB, deliver: 'missing-adapter' },
      { dueMinuteKey: 1, deliveryId: 'cron.marked' },
      deps,
    )
    assert.equal(calls.wechat, 1)
    assert.equal(calls.deliver, 1)
    assert.equal(calls.inbox.length, 0)
  })
})
