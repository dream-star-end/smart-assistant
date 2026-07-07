// 容器 → master「离线送达兜底写站内信」push client。
//
// 背景(docs/plans/v5-cron-master-wake-2026-07-07.md 第 5 节):cron 送达走容器内存
// ring / 在线 WS 客户端;用户离线时既没有在线 webchat 客户端、微信主动投递也没接管,
// 结果就静默丢了。兜底:把这条输出写进 master 的站内信(持久),用户下次上线能看到。
//
// 通道/鉴权复用 v3WechatOutbound 的 env(同 baseUrl + 容器 bearer,master 凭 bearer
// 权威解析 uid → createInboxMessage)。两 env 缺 → 个人/dev → no-op。
//
// 语义:fire-and-forget,永不抛。刻意只在「在线没送到 + 微信没接管」时才由 onDeliver
// 调用(见 server.ts),避免「送达成功还推站内信」的通知重复(boss UX 铁律)。

import { request as undiciRequest } from 'undici'

import {
  readV3WechatOutboundConfig,
  type V3WechatOutboundConfig,
} from './v3WechatOutbound.js'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'v3InboxPost' })

/** 容器侧路径常量,必须与 master internal 路由 INBOX_POST_PATH 对齐。 */
export const INBOX_POST_PATH = '/internal/v3/inbox-post'

const ATTEMPT_TIMEOUT_MS = 10_000
/** 标题上限:站内信标题栏用,过长无意义。 */
const MAX_TITLE_CHARS = 200
/** 正文上限:poster 侧先截,避免把整段长输出经内网灌给 master(master 侧也会再截)。 */
const MAX_BODY_CHARS = 4_096

/** 复用 outbound 的 env 配置(同 master baseUrl + 容器 bearer)。缺 env → null。 */
export function readV3InboxPostConfig(
  env: NodeJS.ProcessEnv = process.env,
): V3WechatOutboundConfig | null {
  return readV3WechatOutboundConfig(env)
}

export interface InboxMessageArgs {
  /** 站内信标题(截断 MAX_TITLE_CHARS)。 */
  title: string
  /** 站内信正文 Markdown(截断 MAX_BODY_CHARS)。 */
  bodyMd: string
}

export interface PostInboxOpts {
  /** 显式注入配置(测试用);不传则读 env,读不到即 no-op。 */
  config?: V3WechatOutboundConfig | null
  /** Override only for tests。 */
  fetcher?: typeof undiciRequest
  /** Override only for tests。 */
  timeoutMs?: number
}

function cap(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

/**
 * 写一条离线兜底站内信。best-effort:无 env / 任何网络/HTTP 错误都静默吞掉(永不抛,
 * 永不阻断 onDeliver)。
 */
export async function postInboxMessage(
  args: InboxMessageArgs,
  opts: PostInboxOpts = {},
): Promise<void> {
  const config = opts.config !== undefined ? opts.config : readV3InboxPostConfig()
  if (!config) return
  const fetcher = opts.fetcher ?? undiciRequest
  const timeoutMs = opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS
  // master 的 BodySchema 是 .strict():只认 { title, bodyMd, level? }。uid 由 master 从
  // bearer 权威解析,故这里**不能**捎带 agentId(会被 strict 拒成 400);level 省略 →
  // master 缺省按 'info'。
  const body = JSON.stringify({
    title: cap(args.title, MAX_TITLE_CHARS),
    bodyMd: cap(args.bodyMd, MAX_BODY_CHARS),
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetcher(`${config.baseUrl}${INBOX_POST_PATH}`, {
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
      log.debug('inbox post non-2xx', { status: res.statusCode })
    }
  } catch {
    // 网络 / DNS / TCP / TLS / abort → 静默
  } finally {
    clearTimeout(timer)
  }
}
