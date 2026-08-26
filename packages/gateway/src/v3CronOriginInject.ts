// 容器 → master origin-session 注入 client。
// 有 OPENCLAUDE_V3_MASTER_BASE_URL + container token 才启用；缺 env → 调用方走本地 sqlite 路径。

import { request as undiciRequest } from 'undici'

import {
  readV3WechatOutboundConfig,
  type V3WechatOutboundConfig,
} from './v3WechatOutbound.js'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'v3CronOriginInject' })

export const CRON_ORIGIN_INJECT_PATH = '/internal/v3/cron-origin-inject'

const ATTEMPT_TIMEOUT_MS = 15_000

export function readV3CronOriginInjectConfig(
  env: NodeJS.ProcessEnv = process.env,
): V3WechatOutboundConfig | null {
  return readV3WechatOutboundConfig(env)
}

export type CronOriginInjectPayload = {
  sessionId: string
  text: string
  clientMessageId: string
  agentId: string
}

export type CronOriginInjectClientResult =
  | { kind: 'injected' }
  | { kind: 'gone' }
  | { kind: 'in_flight' }
  | { kind: 'retryable'; code: string }

export interface PostCronOriginInjectOpts {
  config?: V3WechatOutboundConfig | null
  fetcher?: typeof undiciRequest
  timeoutMs?: number
}

export async function postCronOriginInject(
  payload: CronOriginInjectPayload,
  opts: PostCronOriginInjectOpts = {},
): Promise<CronOriginInjectClientResult> {
  const config = opts.config !== undefined ? opts.config : readV3CronOriginInjectConfig()
  if (!config) {
    return { kind: 'retryable', code: 'NO_MASTER' }
  }
  const fetcher = opts.fetcher ?? undiciRequest
  const timeoutMs = opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS
  const body = JSON.stringify({
    sessionId: payload.sessionId,
    text: payload.text,
    clientMessageId: payload.clientMessageId,
    agentId: payload.agentId,
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetcher(`${config.baseUrl}${CRON_ORIGIN_INJECT_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${config.bearer}`,
      },
      body,
      signal: controller.signal,
    })
    try {
      for await (const _chunk of res.body) {
        // drain
      }
    } catch {
      // ignore drain
    }
    if (res.statusCode === 200) return { kind: 'injected' }
    if (res.statusCode === 404) return { kind: 'gone' }
    if (res.statusCode === 409) return { kind: 'in_flight' }
    log.warn('cron-origin-inject unexpected status', { status: res.statusCode })
    return { kind: 'retryable', code: `HTTP_${res.statusCode}` }
  } catch (err) {
    log.warn('cron-origin-inject request failed', {
      errorClass: err instanceof Error ? err.name : 'unknown',
    })
    return { kind: 'retryable', code: 'NETWORK' }
  } finally {
    clearTimeout(timer)
  }
}
