/**
 * M4 / P1-4 — Telegram Bot 告警发送。
 *
 * 与 iLink 不同,Telegram 只发不收 —— 没有 long-poll worker,只在 dispatcher
 * tick 调度到 telegram 通道时直接打 sendMessage HTTP API。
 *
 * 错误分类:
 *   - 401 / 404 / `chat not found` / `bot was blocked`:永久失败,outbox markFailed
 *     即可,后续 retry 也无意义(通道需 admin 介入)
 *   - 429 Too Many Requests:Telegram 在 body.parameters.retry_after 给秒数,
 *     这里也按普通失败抛(outbox 退避会再来),不专门读 retry_after —— 退避起点
 *     60s,Telegram 限流通常 < 60s 就放开,不必抢精度
 *   - 其他 5xx / 网络错:抛 Error,outbox 退避
 *
 * 不做:
 *   - parse_mode / Markdown 转义(plain text 已够告警用,Markdown 转义出错风险高)
 *   - inline keyboard / 按钮
 *   - 富媒体(图片 / 文件)
 *   - retry_after 精确退避(outbox 通用退避够用)
 */

const TELEGRAM_API_BASE = 'https://api.telegram.org'
const REQUEST_TIMEOUT_MS = 10_000

export interface TelegramSendInput {
  botToken: string
  chatId: string
  text: string
}

/**
 * 永久错误 —— caller 应当 markFailed 并不再重试。
 * 用普通 Error.name 区分,outbox 层目前不读 name,只是 last_error 文案前缀
 * 给 admin 看清是 "perm-fail"(非常坏)还是 "transient"(可能恢复)。
 */
export class TelegramPermanentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TelegramPermanentError'
  }
}

/**
 * 发送一条文本告警到 Telegram chat。失败抛 Error;成功 resolve void。
 */
export async function sendTelegramAlert(input: TelegramSendInput): Promise<void> {
  const { botToken, chatId, text } = input
  // Telegram message text 上限 4096 字符 —— 截断保守值 4000(留 96 给省略提示)
  const truncated = text.length > 4000 ? `${text.slice(0, 4000)}\n…(truncated)` : text
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: truncated,
        disable_web_page_preview: true,
      }),
      signal: ctrl.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    const msg = (err as Error)?.message ?? String(err)
    throw new Error(`telegram fetch failed: ${msg}`)
  }
  clearTimeout(timer)

  type TgBody = { ok?: boolean; error_code?: number; description?: string }
  let body: TgBody | null = null
  try {
    body = (await resp.json()) as TgBody
  } catch {
    // body 不是 JSON
  }

  if (resp.ok && body?.ok === true) return

  const code = body?.error_code ?? resp.status
  const desc = body?.description ?? `http ${resp.status}`

  // 401 = bot token 无效 / 被 revoke
  // 403 = bot 被 chat block
  // 404 = chat_id 不存在
  // 400 本身是笼统 "Bad Request" —— 只有 description 明确提示 chat not found /
  // bot was blocked 时才视作 permanent。其他 400(文案格式错等)仍按 transient,
  // 让 outbox 退避;真正无法恢复的配置错只能靠 description 精确匹配判定。
  const descLc = desc.toLowerCase()
  const isPermDesc =
    descLc.includes('chat not found') ||
    descLc.includes('bot was blocked') ||
    descLc.includes('user is deactivated') ||
    descLc.includes('chat_id is empty') ||
    descLc.includes('bot is not a member')
  if (
    resp.status === 401 ||
    resp.status === 403 ||
    resp.status === 404 ||
    (resp.status === 400 && isPermDesc)
  ) {
    throw new TelegramPermanentError(`telegram ${code}: ${desc}`)
  }
  // 其他错误(429 / 5xx / 网络异常 / 400 格式错)走通用 retry
  throw new Error(`telegram ${code}: ${desc}`)
}
