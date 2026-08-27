/**
 * master → 用户容器 session-open 引擎预热客户端。
 *
 * 复用 wechat inbound / durable-dispatch 的 HMAC + ContainerTransport 基建。
 * 失败(未就绪 / 404 旧容器 / 5xx / 超时 / tunnel)一律 swallow —— 预热不得影响
 * GET /api/sessions/:id、dispatch 或计费。
 */
import { randomBytes } from 'node:crypto'

import { ENGINE_PREHEAT_PATH } from '@openclaude/protocol'

import { computeInboundNonce } from '../bridgeSecret.js'
import type { RunningContainerEndpoint } from './containerDispatchClient.js'
import type { ContainerTransport } from '../wechat/inboundDispatcher.js'

export const ENGINE_PREHEAT_TIMEOUT_MS = 3_000

export interface EnginePreheatClientDeps {
  transport: ContainerTransport
  bridgeSecret: string
  /** 只解析当前 running 容器;不在跑 → null(绝不 provision)。 */
  resolveRunningEndpoint: (uid: bigint) => Promise<RunningContainerEndpoint | null>
  timeoutMs?: number
}

export interface EnginePreheatRequest {
  userId: string
  sessionId: string
  agentId: string
  modelId?: string
}

/** JWT / gateway getUserId 的 `c:<uid>` 或裸数字 → bigint;个人版 default 等返回 null。 */
export function parseUidFromGatewayUserId(userId: string): bigint | null {
  const raw = userId.startsWith('c:') ? userId.slice(2) : userId
  if (!/^[1-9][0-9]{0,18}$/.test(raw)) return null
  try {
    return BigInt(raw)
  } catch {
    return null
  }
}

export function makeEnginePreheatClient(
  deps: EnginePreheatClientDeps,
): (args: EnginePreheatRequest) => Promise<void> {
  const timeoutMs = deps.timeoutMs ?? ENGINE_PREHEAT_TIMEOUT_MS

  return async (args: EnginePreheatRequest): Promise<void> => {
    if (!deps.bridgeSecret) return
    const uid = parseUidFromGatewayUserId(args.userId)
    if (uid === null) return

    let endpoint: RunningContainerEndpoint | null
    try {
      endpoint = await deps.resolveRunningEndpoint(uid)
    } catch {
      return
    }
    if (!endpoint) return
    if (endpoint.tunnel !== undefined && !deps.transport.supportsTunnel) return

    const nonce = computeInboundNonce(deps.bridgeSecret, endpoint.containerId)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-openclaude-container-id': String(endpoint.containerId),
      'x-openclaude-inbound-nonce': nonce,
      'x-request-id': `eph-${randomBytes(8).toString('hex')}`,
    }
    const body = JSON.stringify({
      sessionId: args.sessionId,
      agentId: args.agentId,
      ...(args.modelId ? { modelId: args.modelId } : {}),
    })

    try {
      if (typeof deps.transport.request === 'function') {
        await deps.transport.request('POST', endpoint, ENGINE_PREHEAT_PATH, headers, body, timeoutMs)
      } else {
        await deps.transport.post(endpoint, ENGINE_PREHEAT_PATH, headers, body, timeoutMs)
      }
    } catch {
      // timeout / SSRF / connect refused — fail-open
    }
  }
}
