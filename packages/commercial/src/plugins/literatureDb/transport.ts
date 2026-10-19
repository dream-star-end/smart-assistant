/** A single pinned HTTP(S) hop. No scripts, redirects, implicit proxy, or POST replay. */
import {
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  request as httpRequest,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { DnsResolver, PinnedAddress } from '../../connectors/outboundPolicy.js'
import { LiteratureError, abortable } from './errors.js'
import {
  LITERATURE_HOST,
  type LiteratureMethod,
  literatureMethod,
  literatureUrl,
  pinLiteratureRequest,
} from './policy.js'

export interface LiteratureHttpResponse {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
  /** It is validated, but never followed automatically (especially after a POST). */
  redirect?: string
}
export interface LiteratureHttpInput {
  url: string
  method?: LiteratureMethod
  body?: Buffer
  cookie?: string
  signal: AbortSignal
}
export interface LiteratureTransportOptions {
  resolver?: DnsResolver
  timeoutMs?: number
  maxResponseBytes?: number
  /** Trusted dependency injection for isolated socket fixtures, never user configuration. */
  requestFactory?: (
    options: RequestOptions,
    response: (message: IncomingMessage) => void,
  ) => ClientRequest
}
/** Exported for deterministic socket-option assertions, not accepted from HTTP callers. */
export function literatureSocketOptions(
  url: URL,
  pin: PinnedAddress,
  method: LiteratureMethod,
  body?: Buffer,
  cookie?: string,
): RequestOptions & { servername: string; rejectUnauthorized: true } {
  const safe = literatureUrl(url.href)
  const headers: Record<string, string | number> = {
    host: safe.host,
    'user-agent': 'Aurora-Literature/1.0',
  }
  if (cookie) headers.cookie = cookie
  if (body) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    headers['content-length'] = body.length
  }
  return {
    hostname: pin.ip,
    family: pin.family,
    port: safe.protocol === 'http:' ? 80 : 443,
    method,
    path: safe.pathname + safe.search,
    headers,
    agent: false,
    servername: LITERATURE_HOST,
    rejectUnauthorized: true,
    maxHeaderSize: 16 * 1024,
  }
}
export class LiteratureHttpTransport {
  private readonly timeout: number
  private readonly maximum: number
  constructor(private readonly options: LiteratureTransportOptions = {}) {
    this.timeout = options.timeoutMs ?? 10_000
    this.maximum = options.maxResponseBytes ?? 1024 * 1024
    if (
      !Number.isInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 30_000 ||
      !Number.isInteger(this.maximum) ||
      this.maximum < 1 ||
      this.maximum > 8 * 1024 * 1024
    )
      throw new LiteratureError('INVALID_INPUT')
  }
  async request(input: LiteratureHttpInput): Promise<LiteratureHttpResponse> {
    const method = literatureMethod(input.method ?? 'GET')
    if (
      (input.body !== undefined &&
        (!Buffer.isBuffer(input.body) || input.body.length > 16 * 1024 || method !== 'POST')) ||
      (input.cookie !== undefined &&
        (typeof input.cookie !== 'string' ||
          input.cookie.length > 16 * 1024 ||
          /[^\x20-\x7e]/.test(input.cookie)))
    )
      throw new LiteratureError('INVALID_INPUT')
    if (input.signal.aborted) throw new LiteratureError('CANCELLED')
    const controller = new AbortController()
    let timedOut = false
    const cancelled = () => controller.abort()
    input.signal.addEventListener('abort', cancelled, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeout)
    try {
      // The deadline includes DNS; abort races a resolver that ignores cancellation.
      const { url, pin } = await abortable(
        pinLiteratureRequest(input.url, this.options.resolver),
        controller.signal,
      )
      return await new Promise<LiteratureHttpResponse>((resolve, reject) => {
        const request = (
          this.options.requestFactory ?? (url.protocol === 'http:' ? httpRequest : httpsRequest)
        )(
          {
            ...literatureSocketOptions(url, pin, method, input.body, input.cookie),
            signal: controller.signal,
          },
          (response) => {
            const chunks: Buffer[] = []
            let size = 0
            response.on('data', (raw: Buffer) => {
              const chunk = Buffer.from(raw)
              size += chunk.length
              if (size > this.maximum) {
                request.destroy(new LiteratureError('RESPONSE_TOO_LARGE'))
                return
              }
              chunks.push(chunk)
            })
            response.once('error', () => reject(new LiteratureError('RESPONSE_INVALID')))
            response.once('aborted', () => reject(new LiteratureError('RESPONSE_INVALID')))
            response.once('end', () => {
              if (!response.complete) {
                reject(new LiteratureError('RESPONSE_INVALID'))
                return
              }
              const status = response.statusCode ?? 0
              try {
                const location = response.headers.location
                const redirect =
                  status >= 300 && status < 400 && location
                    ? literatureUrl(location, url.href).href
                    : undefined
                resolve({
                  status,
                  headers: response.headers,
                  body: Buffer.concat(chunks),
                  ...(redirect ? { redirect } : {}),
                })
              } catch {
                reject(new LiteratureError('OUTBOUND_BLOCKED'))
              }
            })
          },
        )
        request.once('error', (error: Error) =>
          reject(
            error instanceof LiteratureError
              ? error
              : new LiteratureError(
                  method === 'POST' ? 'SUBMISSION_UNCERTAIN' : 'RESPONSE_INVALID',
                ),
          ),
        )
        request.end(input.body)
      })
    } catch (error) {
      if (input.signal.aborted) throw new LiteratureError('CANCELLED')
      if (timedOut)
        throw new LiteratureError(method === 'POST' ? 'SUBMISSION_UNCERTAIN' : 'TIMEOUT')
      if (error instanceof LiteratureError) throw error
      throw new LiteratureError('RESPONSE_INVALID')
    } finally {
      clearTimeout(timer)
      input.signal.removeEventListener('abort', cancelled)
    }
  }
}
