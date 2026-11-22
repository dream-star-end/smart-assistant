// 容器 → master origin-session 注入 client。
// 有 OPENCLAUDE_V3_MASTER_BASE_URL + container token 才启用；缺 env → 调用方走本地 sqlite 路径。

import { CRON_ORIGIN_INJECT_PATH } from '@openclaude/protocol'
import { request as undiciRequest } from 'undici'

import {
  readV3WechatOutboundConfig,
  type V3WechatOutboundConfig,
} from './v3WechatOutbound.js'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'v3CronOriginInject' })

export { CRON_ORIGIN_INJECT_PATH }

const ATTEMPT_TIMEOUT_MS = 15_000
const MAX_ERROR_BODY_BYTES = 8_192

/**
 * Authoritative Master error code emitted ONLY on HTTP 503 when Master proves
 * the previous `clientMessageId` dispatch was terminal `not_accepted` with
 * zero billing evidence (OCV5-73). Never emitted for `executed_error`,
 * recovery sentinels, `in_flight`, or billed dispatches.
 */
export const CRON_ORIGIN_PREVIOUSLY_FAILED_UNEXECUTED_CODE = 'PREVIOUSLY_FAILED_UNEXECUTED'
export const CRON_ORIGIN_SESSION_GONE_CODE = 'SESSION_GONE'

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
  | { kind: 'previously_failed' }
  | { kind: 'retryable'; code: string }

export interface PostCronOriginInjectOpts {
  config?: V3WechatOutboundConfig | null
  fetcher?: typeof undiciRequest
  timeoutMs?: number
}

type CronOriginInjectErrorInfo = {
  code?: string
  message?: string
}

function parseCronOriginInjectErrorBody(chunks: Buffer[]): CronOriginInjectErrorInfo | null {
  if (chunks.length === 0) return null
  try {
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const errObj =
      parsed && typeof parsed.error === 'object' && parsed.error !== null && !Array.isArray(parsed.error)
        ? (parsed.error as Record<string, unknown>)
        : parsed
    const code = typeof errObj.code === 'string' ? errObj.code : undefined
    const message = typeof errObj.message === 'string' ? errObj.message : undefined
    if (!code && !message) return null
    return { code, message }
  } catch {
    return null
  }
}

function isPreviouslyFailedResponse(
  statusCode: number,
  info: CronOriginInjectErrorInfo | null,
): boolean {
  return (
    statusCode === 503 &&
    info?.code === CRON_ORIGIN_PREVIOUSLY_FAILED_UNEXECUTED_CODE
  )
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
    const chunks: Buffer[] = []
    let capturedBytes = 0
    let bodyReadComplete = true
    let bodyTruncated = false
    const shouldCapture = res.statusCode !== 200 && res.statusCode !== 409
    try {
      for await (const chunk of res.body) {
        if (shouldCapture) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          if (capturedBytes < MAX_ERROR_BODY_BYTES) {
            const remaining = MAX_ERROR_BODY_BYTES - capturedBytes
            if (buf.length > remaining) bodyTruncated = true
            chunks.push(buf.length <= remaining ? buf : buf.subarray(0, remaining))
            capturedBytes += Math.min(buf.length, remaining)
          } else if (buf.length > 0) {
            bodyTruncated = true
          }
        }
      }
    } catch {
      bodyReadComplete = false
    }
    if (res.statusCode === 200) return { kind: 'injected' }
    if (res.statusCode === 404) {
      if (!bodyReadComplete || bodyTruncated) {
        log.warn('cron-origin-inject 404 body incomplete; treating as retryable', {
          status: res.statusCode,
          bodyReadComplete,
          bodyTruncated,
        })
        return { kind: 'retryable', code: `HTTP_${res.statusCode}` }
      }
      const rawBody = Buffer.concat(chunks).toString('utf8')
      if (rawBody === '') return { kind: 'gone' }
      const errorInfo = parseCronOriginInjectErrorBody(chunks)
      if (errorInfo?.code === CRON_ORIGIN_SESSION_GONE_CODE) {
        return { kind: 'gone' }
      }
      log.warn('cron-origin-inject 404 without SESSION_GONE code; treating as retryable', {
        status: res.statusCode,
        ...(errorInfo?.code ? { code: errorInfo.code } : {}),
        ...(errorInfo?.message ? { message: errorInfo.message } : {}),
      })
      return { kind: 'retryable', code: `HTTP_${res.statusCode}` }
    }
    if (res.statusCode === 409) return { kind: 'in_flight' }
    const errorInfo = parseCronOriginInjectErrorBody(chunks)
    if (isPreviouslyFailedResponse(res.statusCode, errorInfo)) {
      log.warn('cron-origin-inject clientMessageId previously failed (unexecuted) on master', {
        status: res.statusCode,
        ...(errorInfo?.code ? { code: errorInfo.code } : {}),
        ...(errorInfo?.message ? { message: errorInfo.message } : {}),
      })
      return { kind: 'previously_failed' }
    }
    log.warn('cron-origin-inject unexpected status', {
      status: res.statusCode,
      ...(errorInfo?.code ? { code: errorInfo.code } : {}),
      ...(errorInfo?.message ? { message: errorInfo.message } : {}),
    })
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
