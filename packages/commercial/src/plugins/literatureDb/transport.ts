/** A single pinned HTTP(S) hop. No scripts, redirects, implicit proxy, or POST replay. */
import {
  type ClientRequest,
  Agent as HttpAgent,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  request as httpRequest,
} from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { type Duplex, Transform, type Writable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import type { DnsResolver, PinnedAddress } from '../../connectors/outboundPolicy.js'
import { LiteratureError, abortable } from './errors.js'
import {
  LITERATURE_HOST,
  type LiteratureMethod,
  literatureMethod,
  literatureUrl,
  pinLiteratureRequest,
} from './policy.js'

interface LiteratureResponseMetadata {
  status: number
  headers: IncomingHttpHeaders
  /** It is validated, but never followed automatically (especially after a POST). */
  redirect?: string
}
export interface LiteratureHttpResponse extends LiteratureResponseMetadata {
  body: Buffer
}
export interface LiteratureStreamResponse extends LiteratureResponseMetadata {
  /** Raw bytes transferred, not proof of a valid document or authenticated session. */
  bytes: number
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
const STREAM_MAXIMUM = 25 * 1024 * 1024
function metadata(response: IncomingMessage, url: URL): LiteratureResponseMetadata {
  const status = response.statusCode ?? 0
  const location = response.headers.location
  const redirect =
    status >= 300 && status < 400 && location ? literatureUrl(location, url.href).href : undefined
  return { status, headers: response.headers, ...(redirect ? { redirect } : {}) }
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
  request(input: LiteratureHttpInput): Promise<LiteratureHttpResponse> {
    return this.execute(input, (response, current, url) => {
      return new Promise<LiteratureHttpResponse>((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (raw: Buffer) => {
          const chunk = Buffer.from(raw)
          size += chunk.length
          if (size > this.maximum) {
            current.destroy(new LiteratureError('RESPONSE_TOO_LARGE'))
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
          try {
            resolve({ ...metadata(response, url), body: Buffer.concat(chunks) })
          } catch {
            reject(new LiteratureError('OUTBOUND_BLOCKED'))
          }
        })
      })
    })
  }
  /**
   * Takes exclusive ownership of a fresh trusted Writable, including on validation/DNS failure.
   * Resource-backed sinks use default autoDestroy/emitClose and drain I/O in _destroy
   * (as native fs.WriteStream does). The owner must
   * remove failed partial files and verify status/format before publishing an artifact.
   */
  requestToSink(input: LiteratureHttpInput, sink: Writable): Promise<LiteratureStreamResponse> {
    return this.execute(
      input,
      async (response, _current, url, signal) => {
        const info = metadata(response, url)
        const declared = response.headers['content-length']
        if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(STREAM_MAXIMUM))
          throw new LiteratureError('RESPONSE_TOO_LARGE')
        let bytes = 0
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            if (chunk.length > STREAM_MAXIMUM - bytes) {
              callback(new LiteratureError('RESPONSE_TOO_LARGE'))
              return
            }
            bytes += chunk.length
            callback(null, chunk)
          },
        })
        await pipeline(response, meter, sink, { signal })
        if (!response.complete) throw new LiteratureError('RESPONSE_INVALID')
        return { ...info, bytes }
      },
      sink,
    )
  }
  private async execute<T>(
    input: LiteratureHttpInput,
    consume: (
      response: IncomingMessage,
      request: ClientRequest,
      url: URL,
      signal: AbortSignal,
    ) => Promise<T>,
    sink?: Writable,
  ): Promise<T> {
    // Observe the sink before validation/DNS: it may fail while no response exists yet.
    const sinkDone = sink ? finished(sink, { cleanup: true }).catch(() => {}) : undefined
    const controller = new AbortController()
    let consumerStarted = false
    let earlySinkFailure = false
    const sinkFailed = () => {
      if (!consumerStarted) {
        earlySinkFailure = true
        controller.abort()
      }
    }
    sink?.on('error', sinkFailed)
    let method: LiteratureMethod = 'GET'
    let timedOut = false
    const cancelled = () => controller.abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    let request: ClientRequest | undefined
    let requestClosed = Promise.resolve()
    let consumerWork: Promise<T> | undefined
    let agent: HttpAgent | undefined
    const sockets = new Map<Duplex, Promise<void>>()
    const capture = (socket: Duplex) => {
      if (!sockets.has(socket))
        sockets.set(
          socket,
          socket.closed
            ? Promise.resolve()
            : new Promise<void>((resolve) => socket.once('close', () => resolve())),
        )
    }
    try {
      method = literatureMethod(input.method ?? 'GET')
      if (
        (input.body !== undefined &&
          (!Buffer.isBuffer(input.body) || input.body.length > 16 * 1024 || method !== 'POST')) ||
        (input.cookie !== undefined &&
          (typeof input.cookie !== 'string' ||
            input.cookie.length > 16 * 1024 ||
            /[^\x20-\x7e]/.test(input.cookie))) ||
        (sink && (sink.destroyed || sink.writableEnded || !sink.writable))
      )
        throw new LiteratureError('INVALID_INPUT')
      if (input.signal.aborted) throw new LiteratureError('CANCELLED')
      input.signal.addEventListener('abort', cancelled, { once: true })
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, this.timeout)
      // The deadline includes DNS; abort races a resolver that ignores cancellation.
      const { url, pin } = await abortable(
        pinLiteratureRequest(input.url, this.options.resolver),
        controller.signal,
      )
      if (controller.signal.aborted) throw new LiteratureError('CANCELLED')
      // Capture before Agent.oncreate assigns the socket to the request. Cancellation in that
      // window may emit request.close without ever emitting request.socket.
      agent =
        url.protocol === 'http:'
          ? new HttpAgent({ keepAlive: false })
          : new HttpsAgent({ keepAlive: false })
      const connect = agent.createConnection.bind(agent)
      agent.createConnection = (options, callback) => {
        const socket = connect(options, callback)
        if (socket) capture(socket)
        return socket
      }
      return await new Promise<T>((resolve, reject) => {
        const current = (
          this.options.requestFactory ?? (url.protocol === 'http:' ? httpRequest : httpsRequest)
        )(
          {
            ...literatureSocketOptions(url, pin, method, input.body, input.cookie),
            agent,
            signal: controller.signal,
          },
          (response) => {
            consumerStarted = true
            // Early policy/length rejection precedes pipeline attaching its error handler.
            response.on('error', () => {})
            try {
              consumerWork = consume(response, current, url, controller.signal)
              void consumerWork.then(resolve, reject)
            } catch (error) {
              reject(error)
            }
          },
        )
        request = current
        requestClosed = current.closed
          ? Promise.resolve()
          : new Promise<void>((resolveClose) => current.once('close', () => resolveClose()))
        current.on('socket', capture)
        if (current.socket) capture(current.socket)
        current.once('error', (error: Error) =>
          reject(
            error instanceof LiteratureError
              ? error
              : new LiteratureError(
                  method === 'POST' ? 'SUBMISSION_UNCERTAIN' : 'RESPONSE_INVALID',
                ),
          ),
        )
        current.end(input.body)
      })
    } catch (error) {
      // Preserve the original input-validation precedence, including pre-cancelled calls.
      if (error instanceof LiteratureError && error.code === 'INVALID_INPUT') throw error
      if (input.signal.aborted) throw new LiteratureError('CANCELLED')
      if (timedOut)
        throw new LiteratureError(method === 'POST' ? 'SUBMISSION_UNCERTAIN' : 'TIMEOUT')
      if (earlySinkFailure) throw new LiteratureError('RESPONSE_INVALID')
      if (error instanceof LiteratureError) throw error
      throw new LiteratureError('RESPONSE_INVALID')
    } finally {
      clearTimeout(timer)
      input.signal.removeEventListener('abort', cancelled)
      controller.abort()
      request?.destroy()
      agent?.destroy()
      for (const socket of sockets.keys()) socket.destroy()
      // An unfinished emitClose:false Writable needs an error to signal premature termination.
      sink?.destroy(sink.writableFinished ? undefined : new LiteratureError('CANCELLED'))
      await requestClosed
      // A request error can precede pipeline/write completion. Drain both consumers and I/O.
      await consumerWork?.catch(() => {})
      await sinkDone
      await Promise.all(sockets.values())
      sink?.removeListener('error', sinkFailed)
    }
  }
}
