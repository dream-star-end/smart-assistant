/**
 * P1-3 — 流式错误分类。
 *
 * CCB 子进程 / runner 抛出的 error.message 是裸字符串,内含 HTTP 状态码、
 * Anthropic JSON、`INSUFFICIENT_CREDITS` 等关键字。前端要按错误"种类"渲染
 * 不同 UX(余额不足给"去充值",限流给"稍后再试",上游故障给"系统繁忙"),
 * 所以服务端用纯字符串匹配做一次粗分类。
 *
 * 故意只识别少量高确定性场景,其它一律回退 'unknown' → caller 仍发老的
 * `[error] ${msg}` 文本气泡,UX 不变。新增 code 时在这里加,前端 schema
 * 同步加 Type.Literal()。
 */

export type ClassifiedErrorCode =
  | 'insufficient_credits'
  | 'rate_limited'
  | 'upstream_failed'
  | 'unknown'

export interface ClassifiedError {
  code: ClassifiedErrorCode
  /** 用户可见的简短文案 */
  message: string
}

export interface DelegateOutputError {
  code: ClassifiedErrorCode | 'bad_request'
  /** 用户可见的简短文案 */
  message: string
  /** 原始 CCB/API 错误文本,用于日志和 tool detail */
  detail: string
}

const PATTERNS: Array<{
  re: RegExp
  code: Exclude<ClassifiedErrorCode, 'unknown'>
  message: string
}> = [
  // anthropicProxy.ts:1362 sendJsonError(res, 402, "INSUFFICIENT_CREDITS", ...)
  // CCB 抛出的 message 形如 "402 INSUFFICIENT_CREDITS: insufficient credits: balance=... required=..."
  {
    re: /(?:insufficient[_ ]credits|INSUFFICIENT_CREDITS|\b402\b.*credit)/i,
    code: 'insufficient_credits',
    message: '余额不足,请充值后继续',
  },
  // 429 / RATE_LIMITED — Anthropic 直接返还,或本地 RATE_LIMITED reject
  {
    re: /(?:\b429\b|rate[_ ]?limit(?:ed)?|RATE_LIMITED)/i,
    code: 'rate_limited',
    message: '当前账号被限流,请稍后再试',
  },
  // 502/503/504 / 上游连接失败
  {
    re: /(?:\b50[234]\b|upstream|ECONNRESET|ETIMEDOUT|ENOTFOUND|ACCOUNT_POOL_(?:BUSY|UNAVAILABLE)|UPSTREAM_FAILED)/i,
    code: 'upstream_failed',
    message: 'Anthropic 上游异常,请稍后重试',
  },
]

export function classifyRunError(raw: string | undefined | null): ClassifiedError {
  const s = String(raw ?? '')
  if (!s) return { code: 'unknown', message: '' }
  for (const p of PATTERNS) {
    if (p.re.test(s)) return { code: p.code, message: p.message }
  }
  return { code: 'unknown', message: '' }
}

export function classifyDelegateOutputError(
  raw: string | undefined | null,
): DelegateOutputError | null {
  const detail = String(raw ?? '').trim()
  if (!detail) return null
  // CCB's createAssistantAPIErrorMessage emits upstream API failures as a
  // normal assistant text block that starts with this prefix.  Do not classify
  // arbitrary prose that merely mentions "API Error".
  if (!/^API Error:\s*(?:\d{3}\b|\{)/i.test(detail)) return null

  const cls = classifyRunError(detail)
  if (cls.code !== 'unknown') {
    return { code: cls.code, message: cls.message, detail }
  }

  if (
    /\b400\b[\s\S]{0,200}\bBAD_BODY\b|\bBAD_BODY\b[\s\S]{0,200}\binvalid request body\b|"code"\s*:\s*"BAD_BODY"/i.test(
      detail,
    )
  ) {
    return {
      code: 'bad_request',
      message: '子 agent 请求体无效,请降低思考深度或稍后重试',
      detail,
    }
  }

  return null
}
