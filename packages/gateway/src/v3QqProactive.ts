import { request as undiciRequest } from 'undici'

import { type V3WechatOutboundConfig, readV3WechatOutboundConfig } from './v3WechatOutbound.js'
import type { ProactiveDeliveryResult } from './v3WechatProactive.js'

export const QQ_PROACTIVE_PATH = '/internal/v3/qq-proactive'
const ATTEMPT_TIMEOUT_MS = 10_000
const MAX_RESP_BYTES = 16 * 1024

export function readV3QqProactiveConfig(
  env: NodeJS.ProcessEnv = process.env,
): V3WechatOutboundConfig | null {
  return readV3WechatOutboundConfig(env)
}

export async function sendV3QqProactive(args: {
  config: V3WechatOutboundConfig
  text: string
  outboundId: string
  traceId?: string
  fetcher?: typeof undiciRequest
  timeoutMs?: number
}): Promise<ProactiveDeliveryResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? ATTEMPT_TIMEOUT_MS)
  try {
    const response = await (args.fetcher ?? undiciRequest)(
      `${args.config.baseUrl}${QQ_PROACTIVE_PATH}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${args.config.bearer}`,
        },
        body: JSON.stringify({
          text: args.text,
          outboundId: args.outboundId,
          ...(args.traceId ? { traceId: args.traceId } : {}),
        }),
        signal: controller.signal,
      },
    )
    const body = await readBounded(response.body)
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        kind: 'failure',
        retryable:
          response.statusCode === 408 || response.statusCode === 429 || response.statusCode >= 500,
        code: response.statusCode >= 500 ? 'QQ_MASTER_UNAVAILABLE' : 'QQ_MASTER_REJECTED',
      }
    }
    let outcome: unknown
    try {
      outcome = (JSON.parse(body) as { outcome?: unknown }).outcome
    } catch {
      return { kind: 'failure', retryable: true, code: 'QQ_RESPONSE_INVALID' }
    }
    if (outcome === 'queued' || outcome === 'pending' || outcome === 'already_sent') {
      return { kind: 'delivered' }
    }
    if (outcome === 'pref_off' || outcome === 'no_binding') {
      return { kind: 'fallback', marked: false }
    }
    return { kind: 'failure', retryable: true, code: 'QQ_RESPONSE_INVALID' }
  } catch {
    return { kind: 'failure', retryable: true, code: 'QQ_TRANSPORT_FAILED' }
  } finally {
    clearTimeout(timer)
  }
}

async function readBounded(body: {
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer | Uint8Array | string>
}): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const raw of body) {
    const chunk = Buffer.isBuffer(raw)
      ? raw
      : typeof raw === 'string'
        ? Buffer.from(raw)
        : Buffer.from(raw)
    if (total + chunk.length > MAX_RESP_BYTES) break
    chunks.push(chunk)
    total += chunk.length
  }
  return Buffer.concat(chunks).toString('utf8')
}
