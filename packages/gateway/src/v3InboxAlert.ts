// 容器 → master「告警级站内信」push client。
//
// 与 v3InboxPost 的差异:本端点允许 level=warning,master 走进程内
// createInboxMessage(见 commercial internalInboxPost 的 inbox-alert 装配)。
// 容器 inbox-post 只认 info,熔断告警不能走那条。
//
// 语义同 postInboxMessage:fire-and-forget,永不抛。无 env → 个人/dev no-op。

import { request as undiciRequest } from 'undici'

import { createLogger } from './logger.js'
import { type PostInboxOpts, readV3InboxPostConfig } from './v3InboxPost.js'

const log = createLogger({ module: 'v3InboxAlert' })

/** 单一权威在 protocol 内部路由注册表(master internal 路由同源)。 */
import { INBOX_ALERT_PATH } from '@openclaude/protocol'
export { INBOX_ALERT_PATH }

const ATTEMPT_TIMEOUT_MS = 10_000
const MAX_TITLE_CHARS = 200
const MAX_BODY_CHARS = 4_096

export interface InboxAlertArgs {
  title: string
  bodyMd: string
  level: 'warning' | 'info'
  deliveryKey: string
}

function cap(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

/**
 * 写一条 warning/info 站内信。best-effort:无 env / 任何网络错误都静默吞掉。
 * 熔断告警必须走这里,不能走 postInboxMessage。
 */
export async function postInboxAlert(
  args: InboxAlertArgs,
  opts: PostInboxOpts = {},
): Promise<void> {
  const config = opts.config !== undefined ? opts.config : readV3InboxPostConfig()
  if (!config) return
  const fetcher = opts.fetcher ?? undiciRequest
  const timeoutMs = opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS
  const body = JSON.stringify({
    title: cap(args.title, MAX_TITLE_CHARS),
    bodyMd: cap(args.bodyMd, MAX_BODY_CHARS),
    level: args.level,
    deliveryKey: args.deliveryKey,
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetcher(`${config.baseUrl}${INBOX_ALERT_PATH}`, {
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
        // discard
      }
    } catch {
      // drain 失败无所谓
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      log.debug('inbox alert non-2xx', { status: res.statusCode })
    }
  } catch {
    // 网络 / DNS / TCP / TLS / abort → 静默
  } finally {
    clearTimeout(timer)
  }
}
