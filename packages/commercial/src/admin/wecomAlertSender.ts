/**
 * 企业微信群机器人告警发送(纯推送)。照 telegramAlertSender.ts 模板 —— 只发不收,
 * 没有 long-poll worker,只在 dispatcher tick 调度到 wecom 通道时直接打 webhook。
 *
 * ⚠️ 出口红线(归档企微调研):qyapi.weixin.qq.com 是**国内域名**,必须显式
 * directEgressDispatcher() 直连。gateway 启动时 setGlobalDispatcher(EnvHttpProxyAgent)
 * 把全局默认出口设成了海外(日本)代理;wecom webhook 若走全局代理 = "海外→日本→中国"
 * 双重跨境,易 timeout / 断流。per-request dispatcher 覆盖全局出口。
 *
 * 错误分类(类比 telegram / classifyIlinkBusinessAck 的业务 ack 语义):
 *   - HTTP 200 但 body.errcode !== 0:企微**业务失败**(HTTP 层看似成功但没送达)。
 *     errcode=93000(invalid webhook key,配置错)视为 permanent(重试无意义,降级通道);
 *     其余(45009 频率超限 / 其它)transient,交 outbox 指数退避重试。
 *   - HTTP 非 2xx / body 非 JSON / 网络错 / 超时:transient(退避)。
 *
 * 不做:图文 / 卡片 / @人;markdown 已够告警用。
 */

import type { Dispatcher } from 'undici'
import { directEgressDispatcher } from '../account-pool/egressDispatcher.js'

const WECOM_WEBHOOK_BASE = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send'
const REQUEST_TIMEOUT_MS = 10_000

/** WeCom markdown content 上限约 4096 字节;保守截断 4000 字符(留省略提示余量)。 */
export const WECOM_MAX_CONTENT_CHARS = 4000

/** 明确不可恢复的企微 errcode(配置错,重试无意义 → 降级通道 activation_status=error)。 */
const WECOM_PERMANENT_ERRCODES: ReadonlySet<number> = new Set<number>([
  93000, // invalid webhook url / key
])

/**
 * 永久错误 —— caller 应 markFailed 并把通道降级 error(不再重试)。
 * 与 TelegramPermanentError 同语义。
 */
export class WecomPermanentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WecomPermanentError'
  }
}

type FetchLike = typeof fetch

export interface WecomSendInput {
  /** webhook key(?key=<...> 的值),解密后明文。 */
  webhookKey: string
  /** 已格式化的 markdown content。 */
  markdown: string
}

export interface WecomSendDeps {
  /** 注入 fetch(测试用),默认全局 fetch。 */
  fetchImpl?: FetchLike
  /** 注入 dispatcher 工厂(测试用),默认 directEgressDispatcher(国内直连)。 */
  makeDispatcher?: () => Dispatcher | undefined
}

/**
 * 发送一条 markdown 告警到企微群机器人。成功 resolve void;失败抛 Error
 * (permanent 抛 WecomPermanentError,其余抛普通 Error 交 outbox 退避)。
 */
export async function sendWecomAlert(
  input: WecomSendInput,
  deps: WecomSendDeps = {},
): Promise<void> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((i, init) => fetch(i, init))
  const dispatcher = (deps.makeDispatcher ?? directEgressDispatcher)()
  const content =
    input.markdown.length > WECOM_MAX_CONTENT_CHARS
      ? `${input.markdown.slice(0, WECOM_MAX_CONTENT_CHARS)}\n…(truncated)`
      : input.markdown
  const url = `${WECOM_WEBHOOK_BASE}?key=${encodeURIComponent(input.webhookKey)}`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  let resp: Response
  try {
    resp = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
      signal: ctrl.signal,
      // 国内域名显式直连,绕 gateway 全局出海代理(见文件头注)。
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit & { dispatcher?: Dispatcher })
  } catch (err) {
    clearTimeout(timer)
    const msg = (err as Error)?.message ?? String(err)
    throw new Error(`wecom fetch failed: ${msg}`)
  }
  clearTimeout(timer)

  if (!resp.ok) {
    // HTTP 层失败(4xx/5xx)一律 transient,交退避(与 telegram 一致:真正的
    // permanent 靠 webhook 业务 errcode 判定,不靠 HTTP 状态)。
    throw new Error(`wecom http ${resp.status}`)
  }

  type WecomBody = { errcode?: number; errmsg?: string }
  let body: WecomBody | null = null
  try {
    body = (await resp.json()) as WecomBody
  } catch {
    // body 不是 JSON
  }
  if (!body) {
    // 200 但拿不到 JSON body → 无法确认 errcode=0,保守判 transient(避免静默丢告警)
    throw new Error('wecom returned non-JSON on 200')
  }

  const errcode = Number(body.errcode ?? -1)
  if (errcode === 0) return

  const errmsg = body.errmsg ?? 'unknown'
  if (WECOM_PERMANENT_ERRCODES.has(errcode)) {
    throw new WecomPermanentError(`wecom errcode=${errcode}: ${errmsg}`)
  }
  throw new Error(`wecom errcode=${errcode}: ${errmsg}`)
}
