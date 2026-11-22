/**
 * WebSocket frame payload & legacy inline-base64 attachment guardrails (OCV5-825).
 *
 * Modern web clients stream attachments over HTTP `/api/uploads` and send small
 * `/api/media/*` URL references over WS. Keeping `WebSocketServer.maxPayload`
 * at 448 MiB allowed a single malformed or legacy base64 frame to allocate
 * ~1 GiB of V8 heap inside a 4 GiB container.
 *
 * Defaults tighten `maxPayload` to 16 MiB (with `OC_WS_MAX_PAYLOAD_BYTES`
 * escape hatch) and cap legacy inline base64 payloads to 8 MiB with a clear
 * actionable error directing clients to HTTP `/api/uploads`.
 */

export const DEFAULT_WS_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024
export const MIN_WS_MAX_PAYLOAD_BYTES = 256 * 1024
export const MAX_WS_MAX_PAYLOAD_BYTES = 448 * 1024 * 1024

export const DEFAULT_LEGACY_BASE64_MAX_BYTES = 8 * 1024 * 1024

function parseNonNegativeInt(raw: string | undefined): number | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * Resolve `WebSocketServer` `maxPayload` in bytes.
 * Supports `OC_WS_MAX_PAYLOAD_BYTES` override for emergency rollback.
 */
export function resolveWsMaxPayloadBytes(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = parseNonNegativeInt(env.OC_WS_MAX_PAYLOAD_BYTES)
  if (parsed === null || parsed < MIN_WS_MAX_PAYLOAD_BYTES) {
    return DEFAULT_WS_MAX_PAYLOAD_BYTES
  }
  return Math.min(parsed, MAX_WS_MAX_PAYLOAD_BYTES)
}

/**
 * Resolve maximum decoded bytes allowed for legacy inline base64 WS attachments.
 * `OC_WS_LEGACY_BASE64_MAX_BYTES=0` disables inline base64 completely.
 */
export function resolveLegacyBase64MaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = parseNonNegativeInt(env.OC_WS_LEGACY_BASE64_MAX_BYTES)
  if (parsed !== null) {
    return Math.min(parsed, MAX_WS_MAX_PAYLOAD_BYTES)
  }
  const wsCap = resolveWsMaxPayloadBytes(env)
  return Math.min(DEFAULT_LEGACY_BASE64_MAX_BYTES, Math.floor(wsCap * 0.75))
}

export function formatLegacyBase64OversizeError(byteLen: number, limitBytes: number): string {
  const actualMb = (byteLen / 1024 / 1024).toFixed(1)
  if (limitBytes <= 0) {
    return `WebSocket 内联 base64 附件已停用 (${actualMb}MB)，请改用 HTTP /api/uploads 上传接口`
  }
  const limitMb = (limitBytes / 1024 / 1024).toFixed(limitBytes % (1024 * 1024) === 0 ? 0 : 1)
  return `WebSocket 内联 base64 附件超过 ${limitMb}MB 上限 (${actualMb}MB)，大文件请刷新客户端并改用 HTTP /api/uploads 流式上传`
}
