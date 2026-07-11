/**
 * providers/shared — 各 provider 公用的防泄漏/限幅工具(设计终稿 §6)。
 *
 * 纪律:
 *   - 上游错误**不透传**:body/headers/URL 全吞 → 稳定错误码;这里的 message 只带
 *     状态数等非敏感摘要(进服务端日志,不到容器/用户)。
 *   - 结果硬限:结构化结果 256KB / 深度 8 / 数组 200;file 类只受 6MB base64 cap。
 *   - 文本字段统一截断,防上游超长正文打爆结果面。
 */

import { ConnectorError } from '../errors.js'

// ─── 上游错误映射 ────────────────────────────────────────────────────────

/** HTTP 状态 → 稳定错误码(不带上游 body)。 */
export function mapUpstreamStatus(status: number, providerTag: string): ConnectorError {
  if (status === 401 || status === 403) {
    return new ConnectorError('UPSTREAM_AUTH_FAILED', `${providerTag} upstream ${status}`)
  }
  if (status === 404) {
    return new ConnectorError('UPSTREAM_NOT_FOUND', `${providerTag} upstream 404`)
  }
  if (status === 429) {
    return new ConnectorError('UPSTREAM_RATE_LIMITED', `${providerTag} upstream 429`)
  }
  return new ConnectorError('UPSTREAM_ERROR', `${providerTag} upstream ${status}`)
}

/** fetch/网络异常 → 稳定错误码(超时区分)。message 不含 err 原文(可能带 URL)。 */
export function mapFetchFailure(err: unknown, providerTag: string): ConnectorError {
  if (err instanceof ConnectorError) return err
  const name = (err as { name?: string })?.name
  const code = (err as { code?: string })?.code
  if (name === 'AbortError' || name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new ConnectorError('UPSTREAM_TIMEOUT', `${providerTag} upstream timeout`)
  }
  return new ConnectorError(
    'UPSTREAM_ERROR',
    `${providerTag} upstream unreachable (${name ?? code ?? 'err'})`,
  )
}

// ─── 上游响应读取(有界) ─────────────────────────────────────────────────

/** 上游 JSON 响应上限(结构化路径)。 */
export const MAX_UPSTREAM_JSON_BYTES = 4 * 1024 * 1024
/** 文件下载(webdav get_file)原始字节上限:base64 后 ≤6MB → 原始 ≤4.5MB。 */
export const MAX_FILE_RAW_BYTES = Math.floor((6 * 1024 * 1024) / 4) * 3

/** 流式读 body,超限立刻 cancel + 抛(照 literatureProxy readUpstreamJson 纪律)。 */
export async function readBoundedBody(
  res: Response,
  maxBytes: number,
  providerTag: string,
): Promise<Buffer> {
  const body = res.body
  if (body === null) return Buffer.alloc(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new ConnectorError('RESULT_TOO_LARGE', `${providerTag} upstream body exceeds cap`)
      }
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))
}

export async function readBoundedJson(
  res: Response,
  maxBytes: number,
  providerTag: string,
): Promise<unknown> {
  const buf = await readBoundedBody(res, maxBytes, providerTag)
  if (buf.length === 0) return null
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new ConnectorError('UPSTREAM_ERROR', `${providerTag} upstream returned non-JSON`)
  }
}

// ─── 结果硬限(§6:256KB / 深度8 / 数组200) ───────────────────────────────

export const RESULT_MAX_BYTES = 256 * 1024
export const RESULT_MAX_DEPTH = 8
export const RESULT_MAX_ARRAY = 200

function checkDepthAndArrays(v: unknown, depth: number): void {
  if (depth > RESULT_MAX_DEPTH) {
    throw new ConnectorError('RESULT_TOO_LARGE', 'result exceeds max depth')
  }
  if (Array.isArray(v)) {
    if (v.length > RESULT_MAX_ARRAY) {
      throw new ConnectorError('RESULT_TOO_LARGE', 'result array exceeds max items')
    }
    for (const item of v) checkDepthAndArrays(item, depth + 1)
    return
  }
  if (v !== null && typeof v === 'object') {
    for (const val of Object.values(v as Record<string, unknown>)) {
      checkDepthAndArrays(val, depth + 1)
    }
  }
}

/**
 * 结构化结果硬限收口(json 类 action 出口必经;file 类跳过 —— 其 6MB cap 在
 * provider 内按原始字节前置执行)。
 */
export function enforceResultLimits<T>(result: T): T {
  checkDepthAndArrays(result, 1)
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
  if (bytes > RESULT_MAX_BYTES) {
    throw new ConnectorError('RESULT_TOO_LARGE', `result ${bytes}B exceeds ${RESULT_MAX_BYTES}B`)
  }
  return result
}

// ─── 文本工具 ────────────────────────────────────────────────────────────

/** 截断到 max 字符,返回 [text, truncated]。 */
export function truncateText(s: string, max: number): [string, boolean] {
  if (s.length <= max) return [s, false]
  return [s.slice(0, max), true]
}

/** 邮件正文/文档默认截断(64K 字符,结果 256KB 限内)。 */
export const TEXT_FIELD_MAX_CHARS = 64 * 1024
