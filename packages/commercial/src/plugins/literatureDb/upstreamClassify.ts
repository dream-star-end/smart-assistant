/**
 * Upstream page / status classification for the literature executor (OCV5-585).
 *
 * Markers come from read-only samples (ocv5-308/g585-upstream-samples.md) plus the member-page
 * phrases the login probe already relies on. Anything unrecognised stays `unknown`; callers map it
 * to a neutral code instead of guessing "login expired" or "zero results". Only an explicit login
 * signal yields SESSION_EXPIRED, because that code triggers automatic re-login and, if it repeats,
 * marks the account relink_required.
 */
import { LiteratureError } from './errors.js'

export type UpstreamPageKind = 'login' | 'no_access' | 'rate_limited' | 'challenge' | 'unknown'

/** Publisher landing page for an unsubscribed article; institutional permission pages. */
const NO_ACCESS_RES = [
  /<meta\s+name=["']access["']\s+content=["']no["']/i,
  /data-test=["']buy-box/i,
  /data-test=["']access-via-institution["']/i,
  /无权访问|没有权限|权限不足|未授权访问|Access Denied/i,
]
/** Jieyou member login: redirect target, "please log in" notices, a password form. */
const LOGIN_RES = [
  /\/e\/member\/login/i,
  /请先登录|您还未登录|您还没登录|登录已过期|登录超时/,
  /<input[^>]+type=["']?password/i,
]
const RATE_LIMIT_RES = [/Too Many Requests|访问过于频繁|请求过于频繁|操作过于频繁|访问频率过高/i]
const CHALLENGE_RES = [
  /captcha|验证码|人机验证|安全验证|滑块验证|Just a moment|cf-chl|challenge-platform/i,
]

export function decodeUpstreamHtml(body: Buffer, contentType?: string): string {
  const declared =
    /charset=([\w-]+)/i.exec(contentType ?? '')?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1] ??
    'utf-8'
  const enc = /gb/i.test(declared) ? 'gb18030' : declared.toLowerCase()
  try {
    return new TextDecoder(enc, { fatal: false }).decode(body)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(body)
  }
}

export function classifyUpstreamHtml(html: string): UpstreamPageKind {
  // Order matters: a publisher landing page links "Log in", and the member login form carries a
  // captcha, so access pages are checked before login and login before challenge.
  if (NO_ACCESS_RES.some((re) => re.test(html))) return 'no_access'
  if (LOGIN_RES.some((re) => re.test(html))) return 'login'
  if (RATE_LIMIT_RES.some((re) => re.test(html))) return 'rate_limited'
  if (CHALLENGE_RES.some((re) => re.test(html))) return 'challenge'
  return 'unknown'
}

export function upstreamPageError(
  kind: UpstreamPageKind,
  unknownCode: 'RESPONSE_INVALID' | 'LITERATURE_UPSTREAM_CHANGED' | 'LITERATURE_NO_ACCESS',
): LiteratureError {
  switch (kind) {
    case 'login':
      return new LiteratureError('SESSION_EXPIRED')
    case 'no_access':
      return new LiteratureError('LITERATURE_NO_ACCESS')
    case 'rate_limited':
      return new LiteratureError('LITERATURE_UPSTREAM_RATE_LIMITED')
    case 'challenge':
      return new LiteratureError('LITERATURE_UPSTREAM_CHALLENGE')
    default:
      return new LiteratureError(unknownCode)
  }
}

export interface UpstreamResponseLike {
  readonly statusCode: number
  readonly headers: Readonly<Record<string, unknown>>
  readonly body: Buffer
}

function contentTypeOf(res: UpstreamResponseLike): string {
  return String(res.headers['content-type'] ?? '').toLowerCase()
}

export function isHtmlResponse(res: UpstreamResponseLike): boolean {
  const type = contentTypeOf(res)
  return type.includes('text/html') || type.includes('application/xhtml')
}

export function classifyResponsePage(res: UpstreamResponseLike): UpstreamPageKind {
  if (res.body.length === 0) return 'unknown'
  return classifyUpstreamHtml(decodeUpstreamHtml(res.body, contentTypeOf(res)))
}

/**
 * 401/403/429 on any WebVPN hop. WebVPN access does not depend on the member login (a fixed
 * authdomain cookie is sent), so a bare 401/403 is an access refusal, not an expired member
 * session; only a login page body re-logins.
 */
export function upstreamStatusError(res: UpstreamResponseLike): LiteratureError | null {
  if (res.statusCode === 429) return new LiteratureError('LITERATURE_UPSTREAM_RATE_LIMITED')
  if (res.statusCode === 401 || res.statusCode === 403)
    return upstreamPageError(classifyResponsePage(res), 'LITERATURE_NO_ACCESS')
  return null
}

/** Jieyou member entry page probe (verifyMemberSessionOnEntry). */
export function classifyMemberEntryResponse(input: {
  readonly status: number
  readonly url: string
  readonly contentType?: string
  readonly body: Buffer
}): LiteratureError | null {
  if (/\/e\/member\/login/i.test(input.url)) return new LiteratureError('SESSION_EXPIRED')
  if (input.status === 401) return new LiteratureError('SESSION_EXPIRED')
  if (input.status === 429) return new LiteratureError('LITERATURE_UPSTREAM_RATE_LIMITED')
  const html = decodeUpstreamHtml(input.body, input.contentType)
  if (input.status === 403)
    return upstreamPageError(classifyUpstreamHtml(html), 'LITERATURE_NO_ACCESS')
  if (input.status !== 200) return new LiteratureError('RESPONSE_INVALID')
  if (/请先登录|您还未登录|您还没登录|name=["']username["']/i.test(html))
    return new LiteratureError('SESSION_EXPIRED')
  return null
}

/**
 * gRPC-web status: the `grpc-status` header (trailers-only replies, as observed for errors) or a
 * trailer frame (flag 0x80) inside the body. `null` when the reply carries no status at all.
 */
export function grpcWebStatus(res: UpstreamResponseLike): number | null {
  const header = res.headers['grpc-status']
  const headerValue = Array.isArray(header) ? header[0] : header
  if (typeof headerValue === 'string' && /^\d+$/.test(headerValue.trim()))
    return Number(headerValue.trim())
  let pos = 0
  const body = res.body
  while (pos + 5 <= body.length) {
    const flag = body[pos]!
    const len = body.readUInt32BE(pos + 1)
    const end = pos + 5 + len
    if (end > body.length) break
    if (flag & 0x80) {
      const match = /grpc-status:\s*(\d+)/i.exec(body.subarray(pos + 5, end).toString('latin1'))
      if (match?.[1]) return Number(match[1])
    }
    pos = end
  }
  return null
}

export function grpcStatusError(status: number | null): LiteratureError | null {
  if (status === null || status === 0) return null
  if (status === 7 || status === 16) return new LiteratureError('LITERATURE_NO_ACCESS')
  if (status === 8) return new LiteratureError('LITERATURE_UPSTREAM_RATE_LIMITED')
  return new LiteratureError('RESPONSE_INVALID')
}
