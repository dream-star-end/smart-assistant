/**
 * Cron onDeliver 瀑布。从 Gateway.start 抽出以便单测,行为与 server.ts 接线必须一致。
 *
 * 2026-08 行为变化:UI 默认 deliver='webchat' 现视为**显式选择**,不再被 QQ/微信抢先接管。
 * 理由:用户在管理中心选「网页对话」是明确意图;有在线 webchat 客户端就应先落到网页。
 * 显式通道不可达/失败后,才走自动瀑布(QQ → 微信 → lastActive → 广播 → 站内信)。
 *
 * 不变式:
 *   - QQ/微信 retryable 失败仍上抛,保留 cron outbox(同 deliveryId 重试);
 *   - 微信会话过期 fallback 标注文本;
 *   - 任一通道送达成功不再兜底(don't double-notify);
 *   - buildOut 带 cronJob 元数据;广播路径内联 ts,不走 deliver()(其只作用单 peerKey);
 *   - deliver='local' 的任务不进本函数(cron.ts 短路);状态变更通知会以 deliver:'webchat' 借道。
 */

import {
  cronDeliveryId,
  deliverCronViaAdapter,
  isUserInitiatedCronJob,
  type CronDeliveryContext,
  type CronJob,
} from './cron.js'
import type { ProactiveDeliveryResult } from './v3WechatProactive.js'
import type { V3WechatOutboundConfig } from './v3WechatOutbound.js'
import type { InboxMessageArgs, PostInboxOpts } from './v3InboxPost.js'

export interface CronLastActive {
  channel: string
  peerId: string
  sessionKey: string
  userId: string
  at: number
}

export interface CronOutboundMessage {
  type: 'outbound.message'
  sessionKey: string
  channel: 'webchat'
  peer: { id: string; kind: 'dm' }
  blocks: Array<{ kind: 'text'; text: string }>
  isFinal: true
  cronJob: { id: string; heartbeat: boolean; label: string }
  _userId?: string
}

export interface CronDeliverDeps {
  lastActiveChannel: Map<string, CronLastActive>
  clientsByPeer: Map<string, Set<{ send(data: string): void }>>
  channels: Map<string, { send(value: unknown): Promise<void> }>
  deliver: (msg: CronOutboundMessage) => void
  makePeerKey: (userId: string, channel: string, peerId: string) => string
  now?: () => number
  qqProactiveCfg: V3WechatOutboundConfig | null
  wechatProactiveCfg: V3WechatOutboundConfig | null
  sendQqProactive: (args: {
    config: V3WechatOutboundConfig
    text: string
    outboundId: string
  }) => Promise<ProactiveDeliveryResult>
  sendWechatProactive: (args: {
    config: V3WechatOutboundConfig
    text: string
    outboundId: string
  }) => Promise<ProactiveDeliveryResult>
  postInboxDurable: (
    args: InboxMessageArgs & { deliveryKey: string },
    opts?: PostInboxOpts,
  ) => Promise<boolean>
}

const LAST_ACTIVE_TTL_MS = 24 * 3600_000

function jobIcon(job: CronJob): string {
  if (job.id === 'heartbeat') return '💓'
  if (job.id.includes('skill')) return '🛠'
  if (job.id.startsWith('remind')) return '⏰'
  return '🪞'
}

function throwRetryable(code: string): never {
  throw Object.assign(new Error(code), { code, retryable: true })
}

function broadcastWebchat(
  clientsByPeer: Map<string, Set<{ send(data: string): void }>>,
  payload: CronOutboundMessage,
): number {
  // 广播不能走 deliver()——它按单 peerKey 路由。内联 ts 以保住客户端 stale-final 守卫。
  const data = JSON.stringify({ ...payload, ts: Date.now() })
  let sent = 0
  for (const set of clientsByPeer.values()) {
    for (const ws of set) {
      try {
        ws.send(data)
        sent++
      } catch {}
    }
  }
  return sent
}

export async function deliverCronOutput(
  text: string,
  job: CronJob,
  delivery: CronDeliveryContext | undefined,
  deps: CronDeliverDeps,
): Promise<void> {
  const now = deps.now?.() ?? Date.now()
  const stableDeliveryId =
    delivery?.deliveryId ?? cronDeliveryId(`${job.id}:${text}`, Math.floor(now / 60_000))

  let deliverText = text
  const icon = jobIcon(job)
  const buildOut = (peerId: string, sessionKey?: string): CronOutboundMessage => ({
    type: 'outbound.message',
    sessionKey: sessionKey || `agent:${job.agent}:cron:dm:${job.id}`,
    channel: 'webchat',
    peer: { id: peerId, kind: 'dm' },
    blocks: [{ kind: 'text', text: `${icon} ${job.label || job.id}\n\n${deliverText}` }],
    isFinal: true,
    cronJob: { id: job.id, heartbeat: !!job.heartbeat, label: job.label || job.id },
  })

  const tryLastActiveWebchat = (lastActive: CronLastActive): boolean => {
    const peerKey = deps.makePeerKey(lastActive.userId, 'webchat', lastActive.peerId)
    const set = deps.clientsByPeer.get(peerKey)
    if (!set || set.size === 0) return false
    deps.deliver({
      ...buildOut(lastActive.peerId, lastActive.sessionKey),
      _userId: lastActive.userId,
    })
    return true
  }

  let delivered = false
  let broadcastSent = 0
  const explicit = job.deliver && job.deliver !== 'local'

  // 显式非 local 通道置顶。deliver='webchat' 是 UI 默认值,本轮起按显式选择处理:
  // 有在线网页客户端就先落网页,不被 QQ/微信接管;离线才轮到自动通道。
  if (explicit) {
    if (job.deliver === 'webchat') {
      const lastActive = deps.lastActiveChannel.get(job.agent)
      if (
        lastActive &&
        now - lastActive.at < LAST_ACTIVE_TTL_MS &&
        lastActive.channel === 'webchat' &&
        tryLastActiveWebchat(lastActive)
      ) {
        return
      }
      broadcastSent = broadcastWebchat(deps.clientsByPeer, buildOut('__reflection__'))
      if (broadcastSent > 0) return
    } else {
      const adapter = deps.channels.get(job.deliver as string)
      if (adapter) {
        try {
          await deliverCronViaAdapter(adapter, buildOut(job.deliverTarget?.peerId || '__cron__'))
          return
        } catch {
          // 显式 adapter 不可达/失败 → 回落自动瀑布。QQ/微信 retryable 上抛仍在下面。
        }
      }
    }
  }

  if (deps.qqProactiveCfg && isUserInitiatedCronJob(job)) {
    const result = await deps.sendQqProactive({
      config: deps.qqProactiveCfg,
      text,
      outboundId: stableDeliveryId,
    })
    if (result.kind === 'delivered') return
    if (result.kind === 'failure' && result.retryable) throwRetryable(result.code)
  }

  if (deps.wechatProactiveCfg && isUserInitiatedCronJob(job)) {
    const result = await deps.sendWechatProactive({
      config: deps.wechatProactiveCfg,
      text,
      outboundId: stableDeliveryId,
    })
    if (result.kind === 'delivered') return
    if (result.kind === 'failure' && result.retryable) throwRetryable(result.code)
    if (result.kind === 'fallback' && result.marked) {
      deliverText = `⚠️ 微信因会话过期/未激活未送达(发条微信即可恢复推送)\n\n${text}`
    }
  }

  const lastActive = deps.lastActiveChannel.get(job.agent)
  if (lastActive && now - lastActive.at < LAST_ACTIVE_TTL_MS) {
    if (lastActive.channel === 'webchat') {
      delivered = tryLastActiveWebchat(lastActive)
    }
    if (!delivered) {
      const adapter = deps.channels.get(lastActive.channel)
      if (adapter) {
        await deliverCronViaAdapter(adapter, buildOut(lastActive.peerId, lastActive.sessionKey))
        delivered = true
      }
    }
  }

  if (!delivered) {
    broadcastSent += broadcastWebchat(deps.clientsByPeer, buildOut('__reflection__'))
  }

  // 离线站内信兜底。bodyMd 用原始 text,不用微信标注前缀。
  // uid 由 master 凭容器 bearer 解析(verifyContainerIdentity);selfhost 单主用户
  // 下容器 token 只绑这一个 uid。禁止把同一 bearer 注入中央网关——多用户会全部记到同一 uid。
  if (!delivered && broadcastSent === 0) {
    await deps.postInboxDurable({
      title: job.label || 'AI定时任务结果',
      bodyMd: text,
      deliveryKey: stableDeliveryId,
    })
  }
}
