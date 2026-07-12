/**
 * Self-heal out-of-band notifications — WeCom group webhook (block C / §C1).
 *
 * qyapi.weixin.qq.com is a MAINLAND-direct endpoint: the send explicitly pins a
 * plain undici Agent as its dispatcher so it can never be routed through any
 * global proxy dispatcher / egress subscription (which would break or leak).
 * Missing OC_SELFHEAL_WECOM_WEBHOOK degrades to a logged warning — notification
 * loss must never crash the broker or a repair.
 */

import { Agent } from 'undici'
import { createLogger } from '../logger.js'

const log = createLogger({ module: 'selfheal-notify' })

// One shared keep-alive-free direct agent (cheap; no proxy, no subscription).
const directAgent = new Agent()

const SEND_TIMEOUT_MS = 10_000
const MAX_TEXT_CHARS = 1800 // WeCom text cap is ~2048 bytes; stay well under

export type SelfhealNotifier = (text: string) => void

/**
 * Build the fire-and-forget WeCom notifier. The webhook URL is read from
 * OC_SELFHEAL_WECOM_WEBHOOK at SEND time (env-file reload friendly); when it is
 * unset the message is dropped with a warning (never throws).
 */
export function createWecomNotifier(env: NodeJS.ProcessEnv = process.env): SelfhealNotifier {
  return (text: string) => {
    const url = env.OC_SELFHEAL_WECOM_WEBHOOK?.trim()
    if (!url) {
      log.warn('OC_SELFHEAL_WECOM_WEBHOOK unset — selfheal notification dropped', {
        preview: text.slice(0, 120),
      })
      return
    }
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text.slice(0, MAX_TEXT_CHARS) } }),
      // Explicitly bypass any global proxy dispatcher — qyapi must go direct.
      dispatcher: directAgent,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    } as RequestInit & { dispatcher: Agent })
      .then((res) => {
        if (!res.ok) log.warn('wecom webhook returned non-2xx', { status: res.status })
      })
      .catch((err) => log.warn('wecom webhook send failed', undefined, err))
  }
}
