/**
 * httpJsonBody — gateway 通用 JSON 请求体读取(server.ts `readJsonBody` 的实现)。
 *
 * 此前 server.ts 的 readJsonBody 把整个请求体无上限读进内存,坏 JSON 抛普通 Error 后被
 * 路由兜底当 500 回(MSC 审计:memory MEM-05 同源问题 + skills / config 两侧各自避开未改,
 * 统一归 memory owner 在此收口)。现在:
 *   - 超过 `maxBytes`(默认 4 MB)→ 抛 {@link JsonBodyTooLargeError}(→ 413);
 *   - 解析失败 → 抛 {@link JsonBodyInvalidError}(→ 400);
 *   - 空 body → `{}`(保持历史语义:不少路由把「没带 body」当成「全部可选字段缺省」)。
 * 错误 → 状态码的映射用 {@link jsonBodyErrorStatus},server.ts 在统一兜底处先问一遍它,
 * 再落 500,所有 readJsonBody 调用点无需各自 try/catch 即得到 413 / 400。
 *
 * 超限时**不 destroy 连接**而是 `req.resume()` 把剩余字节丢掉:掐连接会让浏览器 fetch 直接
 * 失败(TypeError: Failed to fetch),来不及收到 413 响应体。与 taskboard/http.ts 口径一致。
 */
import type { IncomingMessage } from 'node:http'

/** 默认上限 4 MB:记忆 / 技能 / 配置 PUT 的合理上界;文件上传走 multipart 专用路径不经此。 */
export const DEFAULT_JSON_BODY_MAX_BYTES = 4 * 1024 * 1024

export class JsonBodyTooLargeError extends Error {
  readonly httpStatus = 413 as const
  constructor(readonly maxBytes: number) {
    super(`payload too large (limit ${maxBytes} bytes)`)
    this.name = 'JsonBodyTooLargeError'
  }
}

export class JsonBodyInvalidError extends Error {
  readonly httpStatus = 400 as const
  constructor() {
    super('invalid json body')
    this.name = 'JsonBodyInvalidError'
  }
}

/** 读原始 body(utf-8),超过 maxBytes 抛 JsonBodyTooLargeError。 */
export function readBodyBounded(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        chunks.length = 0
        req.resume()
        finish(() => reject(new JsonBodyTooLargeError(maxBytes)))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(() => resolve(Buffer.concat(chunks).toString('utf-8'))))
    req.on('error', (err) => finish(() => reject(err)))
  })
}

/**
 * 读并解析 JSON body。空 body → `{}`;超限 → JsonBodyTooLargeError;坏 JSON → JsonBodyInvalidError。
 * 泛型只是给调用方的形状提示,不做运行时校验(与 server.ts 历史行为一致)。
 */
export async function readJsonBodyBounded<T = unknown>(
  req: IncomingMessage,
  maxBytes = DEFAULT_JSON_BODY_MAX_BYTES,
): Promise<T> {
  const raw = await readBodyBounded(req, maxBytes)
  if (!raw) return {} as T
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new JsonBodyInvalidError()
  }
}

/** 是 body 读取/解析类错误 → 对应 4xx 状态码;否则 null(交给调用方按 500 兜底)。 */
export function jsonBodyErrorStatus(err: unknown): 413 | 400 | null {
  if (err instanceof JsonBodyTooLargeError) return 413
  if (err instanceof JsonBodyInvalidError) return 400
  return null
}
