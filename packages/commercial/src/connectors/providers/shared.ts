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

// ─── 写送达不确定性标记(P1#4:pre-dispatch vs post-dispatch) ───────────────

/**
 * 标注一个错误为「可能已送达」(maybeDelivered):请求体已开始/完成发送后失败,
 * 第三方**可能已执行写入** → 写路径 finalize 成 `unknown`(绝不盲重试,防重复写)。
 * 反之,未打标的写错误 = 确定未送达(pre-dispatch 连接失败 / 明确 4xx 拒绝) → `failed`。
 */
export function markMaybeDelivered<E extends ConnectorError>(e: E): E {
  ;(e as ConnectorError & { maybeDelivered?: boolean }).maybeDelivered = true
  return e
}

/** 一个错误是否已被标注为「可能已送达」。 */
export function isMaybeDelivered(err: unknown): boolean {
  return (err as { maybeDelivered?: boolean } | null)?.maybeDelivered === true
}

/**
 * 「确定未送达」的连接期错误码(请求体从未发出:DNS/连接拒绝/路由不可达/连接超时/
 * TLS 握手失败)。命中这些 → 写路径可安全判 `failed`(重提交不会重复)。
 */
const PRE_DISPATCH_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  // TLS 握手在请求体发送前完成 → 握手类失败 = 未送达
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

/** undici fetch 把根因裹在 `.cause` 里;取顶层或 cause 的 code。 */
function fetchErrCode(err: unknown): string | undefined {
  const top = (err as { code?: string } | null)?.code
  if (top) return top
  return (err as { cause?: { code?: string } } | null)?.cause?.code
}

/** 取错误 name(fetch 包成 TypeError,穿透到 cause 找真实 name)。 */
function fetchErrName(err: unknown): string | undefined {
  const top = (err as { name?: string } | null)?.name
  if (top && top !== 'TypeError' && top !== 'Error') return top
  return (err as { cause?: { name?: string } } | null)?.cause?.name ?? top
}

// ─── 上游错误映射 ────────────────────────────────────────────────────────

/**
 * HTTP 状态 → 稳定错误码(不带上游 body)。
 * P1#4:5xx = 服务端可能已处理写入 → 标 maybeDelivered;其余 4xx = 服务端收到并拒绝
 * (401/403/404/429/400/409/…) = 确定未写入,不打标。
 */
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
  if (status >= 500) {
    // 5xx:服务端已收到请求,可能已落地写入 → 结局不明
    return markMaybeDelivered(new ConnectorError('UPSTREAM_ERROR', `${providerTag} upstream ${status}`))
  }
  // 其余 4xx:服务端明确拒绝 → 未写入
  return new ConnectorError('UPSTREAM_ERROR', `${providerTag} upstream ${status}`)
}

/**
 * fetch/网络异常 → 稳定错误码(超时区分 + 送达不确定性)。message 不含 err 原文
 * (可能带 URL)。P1#4:pre-dispatch(连接期)失败 = 未送达 → 不打标;post-dispatch
 * (已建连后 socket 断裂 / 响应超时) = 可能已送达 → 打标 maybeDelivered。
 */
export function mapFetchFailure(err: unknown, providerTag: string): ConnectorError {
  if (err instanceof ConnectorError) return err
  const name = fetchErrName(err)
  const code = fetchErrCode(err)
  const preDispatch = code != null && PRE_DISPATCH_ERROR_CODES.has(code)

  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT'
  ) {
    const e = new ConnectorError('UPSTREAM_TIMEOUT', `${providerTag} upstream timeout`)
    // 连接期超时 = 未送出;其余超时 = 已建连后 → 结局不明
    return preDispatch ? e : markMaybeDelivered(e)
  }
  if (preDispatch) {
    return new ConnectorError('UPSTREAM_ERROR', `${providerTag} upstream unreachable`)
  }
  // 已建连后 socket 断裂(ECONNRESET / EPIPE / UND_ERR_SOCKET / …)→ 可能已送达
  return markMaybeDelivered(
    new ConnectorError('UPSTREAM_ERROR', `${providerTag} upstream error (${name ?? code ?? 'err'})`),
  )
}

/**
 * 响应 **body 读取阶段**失败映射(P1#4 Codex R2)。此刻响应头已到(调用方已过 res.ok
 * 检查)→ 定义上是 post-dispatch:对写操作 = 服务端可能已落地写入 → 一律标 maybeDelivered
 * (读操作会忽略该标记,只是读失败)。已是 ConnectorError(如自身 RESULT_TOO_LARGE)原样透出。
 */
function mapBodyReadFailure(err: unknown, providerTag: string): ConnectorError {
  if (err instanceof ConnectorError) return err
  const name = fetchErrName(err)
  const code = fetchErrCode(err)
  const isTimeout =
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT'
  return markMaybeDelivered(
    new ConnectorError(
      isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR',
      `${providerTag} upstream body read failed`,
    ),
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
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (err) {
        // body 读取中途 socket 断裂/超时:响应头已到 → post-dispatch,写路径判 maybeDelivered。
        await reader.cancel().catch(() => {})
        throw mapBodyReadFailure(err, providerTag)
      }
      const { done, value } = chunk
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        // 2xx 后 body 超限:响应头已到 → post-dispatch,写操作服务端可能已落地 →
        // maybeDelivered(写路径→unknown 防重复;读/文件下载会忽略该标记,P1#4 Codex R3)。
        throw markMaybeDelivered(
          new ConnectorError('RESULT_TOO_LARGE', `${providerTag} upstream body exceeds cap`),
        )
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
    // 2xx 后响应体截断/非 JSON:写操作服务端可能已落地 → maybeDelivered(读操作忽略)。
    throw markMaybeDelivered(
      new ConnectorError('UPSTREAM_ERROR', `${providerTag} upstream returned non-JSON`),
    )
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
