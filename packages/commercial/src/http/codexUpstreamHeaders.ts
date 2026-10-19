/** Header projection shared by the Codex relay and its behavioral release proof. */
import type { IncomingMessage } from 'node:http'

export const CODEX_UPSTREAM_AUTH_HEADER = 'x-openclaude-upstream-authorization'

export const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const SAFE_UPSTREAM_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'openai-beta',
  'openai-organization',
  'openai-project',
  'user-agent',
  // chatgpt.com/backend-api/codex(official_oauth 数据面)必需的非敏感请求元数据:
  // codex CLI 在 ChatGPT auth 模式下随请求发送 chatgpt-account-id(选择 workspace)、
  // originator / session_id / conversation_id(客户端指纹与会话关联)。均非凭证。
  'chatgpt-account-id',
  'originator',
  // Modern Codex uses session-id for ChatGPT cache affinity and thread-id
  // for thread correlation. These IDs are metadata, never credentials.
  'session-id',
  'thread-id',
  'session_id',
  'conversation_id',
  // Codex 0.144+ uses these headers for within-turn sticky routing and the
  // Responses Lite request path. They contain routing state/capability only;
  // broader client-correlation headers intentionally remain blocked.
  'x-codex-turn-state',
  'x-openai-internal-codex-responses-lite',
])


function appendHeader(headers: Headers, key: string, value: string | string[] | undefined): void {
  if (value === undefined) return
  if (Array.isArray(value)) {
    for (const v of value) headers.append(key, v)
    return
  }
  headers.set(key, value)
}

export function buildUpstreamHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [rawKey, rawValue] of Object.entries(req.headers)) {
    const key = rawKey.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(key)) continue
    if (key === 'host' || key === 'content-length') continue
    if (key === 'authorization' || key === CODEX_UPSTREAM_AUTH_HEADER) continue
    if (key.startsWith('x-openclaude-')) continue
    if (!SAFE_UPSTREAM_REQUEST_HEADERS.has(key)) continue
    appendHeader(headers, rawKey, rawValue)
  }
  const upstreamAuth = req.headers[CODEX_UPSTREAM_AUTH_HEADER]
  if (typeof upstreamAuth === 'string' && upstreamAuth.trim().length > 0) {
    headers.set('authorization', upstreamAuth)
  }
  // Avoid response decompression/header mismatch surprises in the relay. SSE
  // and JSON streaming work fine with identity encoding.
  headers.set('accept-encoding', 'identity')
  return headers
}
