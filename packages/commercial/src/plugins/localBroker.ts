/**
 * Read-only HTTPS broker for the inert local Plugin sandbox (phase 3.2a).
 *
 * Plugin containers keep `network=none`. A single invocation may instead receive
 * one read-only bind mount containing a Unix socket. The root-owned broker checks
 * a random 256-bit invocation token, an offline-reviewed exact-origin policy,
 * global-unicast DNS, and hard request/response quotas before master performs a
 * GET/HEAD request. No credentials, browser profile, persistence, write or send
 * effect is available in this slice.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import { chmod, chown, lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { type Server, type Socket, createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { ConnectorError } from '../connectors/errors.js'
import {
  type DnsResolver,
  normalizeHttpsOrigin,
  pinnedHttpsFetch,
} from '../connectors/outboundPolicy.js'

const ACTION_RE = /^[a-z][a-z0-9_-]{0,63}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const SAFE_REQUEST_HEADERS = new Set(['accept', 'if-none-match', 'if-modified-since'])
const SAFE_RESPONSE_HEADERS = ['content-type', 'etag', 'last-modified', 'cache-control'] as const
const BROKER_SOCKET_NAME = 'broker.sock'
const CONTAINER_BROKER_DIR = '/run/oc-plugin-broker'
const MAX_REQUEST_FRAME_BYTES = 64 * 1024
const CLIENT_IDLE_TIMEOUT_MS = 5_000
const POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export const LOCAL_PLUGIN_BROKER_SOCKET = `${CONTAINER_BROKER_DIR}/${BROKER_SOCKET_NAME}`

export class LocalPluginBrokerError extends Error {
  readonly code:
    | 'INVALID_POLICY'
    | 'UNAUTHORIZED'
    | 'BAD_REQUEST'
    | 'OUTBOUND_BLOCKED'
    | 'QUOTA_EXCEEDED'
    | 'RESPONSE_LIMIT'
    | 'TIMEOUT'
    | 'CLOSING'
    | 'CLEANUP_FAILED'
    | 'INTERNAL'

  constructor(code: LocalPluginBrokerError['code'], message: string = code) {
    super(message)
    this.name = 'LocalPluginBrokerError'
    this.code = code
  }
}

export interface LocalPluginHttpReadPolicy {
  origins: readonly string[]
  maxRequests: number
  maxConcurrent: number
  maxResponseBytes: number
  requestTimeoutMs: number
}

export interface LocalPluginBrokerActionPolicy {
  httpRead: LocalPluginHttpReadPolicy
}

export interface CompiledLocalPluginBrokerPolicy {
  schemaVersion: 1
  actions: Readonly<Record<string, LocalPluginBrokerActionPolicy>>
}

export interface LocalPluginBrokerMount {
  invocationId: string
  brokerRoot: string
  hostDirectory: string
  hostSocketPath: string
  containerSocketPath: typeof LOCAL_PLUGIN_BROKER_SOCKET
  token: string
}

export interface LocalPluginBrokerStats {
  acceptedConnections: number
  openConnections: number
  activeHandlers: number
  activeRequests: number
  requestsStarted: number
  closing: boolean
  closed: boolean
}

export interface CancelableDnsResolver extends DnsResolver {
  cancel(): void
}

export interface LocalPluginBrokerDeps {
  resolverFactory?: (timeoutMs: number) => CancelableDnsResolver
  fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<Response>
  logger?: (event: string, fields: Record<string, unknown>) => void
}

export interface LocalPluginBrokerHandle {
  mount: LocalPluginBrokerMount
  stats(): LocalPluginBrokerStats
  close(): Promise<void>
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new LocalPluginBrokerError('INVALID_POLICY', `${label} must be an object`)
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null)
    throw new LocalPluginBrokerError('INVALID_POLICY', `${label} must be a plain object`)
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allow = new Set(allowed)
  const unknown = Object.keys(value).filter((key) => !allow.has(key))
  if (unknown.length > 0)
    throw new LocalPluginBrokerError(
      'INVALID_POLICY',
      `${label} has unknown fields: ${unknown.sort().join(', ')}`,
    )
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum)
    throw new LocalPluginBrokerError(
      'INVALID_POLICY',
      `${label} must be an integer in ${minimum}-${maximum}`,
    )
  return Number(value)
}

export function compileLocalPluginBrokerPolicy(
  input: unknown,
  allowedActionIds?: ReadonlySet<string>,
): CompiledLocalPluginBrokerPolicy {
  const root = plainObject(input, 'broker policy')
  exactKeys(root, ['schemaVersion', 'actions'], 'broker policy')
  if (root.schemaVersion !== 1)
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker policy schemaVersion must be 1')
  const actionsRaw = plainObject(root.actions, 'broker policy actions')
  const actionEntries = Object.entries(actionsRaw)
  if (actionEntries.length === 0 || actionEntries.length > 16)
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker policy must contain 1-16 actions')

  const actions: Record<string, LocalPluginBrokerActionPolicy> = Object.create(null)
  for (const [actionId, rawAction] of actionEntries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!ACTION_RE.test(actionId) || (allowedActionIds && !allowedActionIds.has(actionId)))
      throw new LocalPluginBrokerError('INVALID_POLICY', `unknown broker action '${actionId}'`)
    const action = plainObject(rawAction, `broker action ${actionId}`)
    exactKeys(action, ['httpRead'], `broker action ${actionId}`)
    const http = plainObject(action.httpRead, `broker action ${actionId}.httpRead`)
    exactKeys(
      http,
      ['origins', 'maxRequests', 'maxConcurrent', 'maxResponseBytes', 'requestTimeoutMs'],
      `broker action ${actionId}.httpRead`,
    )
    if (!Array.isArray(http.origins) || http.origins.length === 0 || http.origins.length > 8)
      throw new LocalPluginBrokerError('INVALID_POLICY', 'httpRead.origins must contain 1-8 items')
    const origins: string[] = []
    for (const rawOrigin of http.origins) {
      if (typeof rawOrigin !== 'string')
        throw new LocalPluginBrokerError('INVALID_POLICY', 'httpRead origin must be a string')
      let normalized: string
      try {
        normalized = normalizeHttpsOrigin(rawOrigin)
      } catch {
        throw new LocalPluginBrokerError('INVALID_POLICY', 'httpRead origin is not safe HTTPS')
      }
      if (origins.includes(normalized))
        throw new LocalPluginBrokerError('INVALID_POLICY', 'duplicate httpRead origin')
      origins.push(normalized)
    }
    actions[actionId] = {
      httpRead: {
        origins,
        maxRequests: boundedInteger(http.maxRequests, 1, 32, 'httpRead.maxRequests'),
        maxConcurrent: boundedInteger(http.maxConcurrent, 1, 4, 'httpRead.maxConcurrent'),
        maxResponseBytes: boundedInteger(
          http.maxResponseBytes,
          1024,
          1024 * 1024,
          'httpRead.maxResponseBytes',
        ),
        requestTimeoutMs: boundedInteger(
          http.requestTimeoutMs,
          1000,
          30_000,
          'httpRead.requestTimeoutMs',
        ),
      },
    }
  }
  return { schemaVersion: 1, actions }
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function assertSafeBrokerRoot(root: string, expectedOwnerUid: number): Promise<string> {
  if (!isAbsolute(root))
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker root must be absolute')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const candidate = resolve(root)
  const before = await lstat(candidate)
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    before.uid !== expectedOwnerUid ||
    (before.mode & 0o777) !== 0o700
  )
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker root ownership or mode is unsafe')
  const canonical = await realpath(candidate)
  const after = await lstat(canonical)
  if (
    canonical !== candidate ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    !after.isDirectory()
  )
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker root changed during verification')
  return canonical
}

export async function verifyLocalPluginBrokerMount(
  mount: LocalPluginBrokerMount,
  opts: { expectedOwnerUid: number; socketUid: number; socketGid: number },
): Promise<void> {
  if (
    !UUID_RE.test(mount.invocationId) ||
    !isAbsolute(mount.brokerRoot) ||
    !isAbsolute(mount.hostDirectory) ||
    !isAbsolute(mount.hostSocketPath)
  )
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker mount paths are invalid')
  const rootCandidate = resolve(mount.brokerRoot)
  const rootBefore = await lstat(rootCandidate).catch(() => null)
  if (!rootBefore || !rootBefore.isDirectory() || rootBefore.isSymbolicLink())
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker root is not a real directory')
  const root = await realpath(rootCandidate)
  const rootAfter = await lstat(root)
  if (
    root !== rootCandidate ||
    rootBefore.uid !== opts.expectedOwnerUid ||
    (rootBefore.mode & 0o777) !== 0o700 ||
    rootAfter.dev !== rootBefore.dev ||
    rootAfter.ino !== rootBefore.ino ||
    !rootAfter.isDirectory() ||
    rootAfter.uid !== opts.expectedOwnerUid ||
    (rootAfter.mode & 0o777) !== 0o700
  )
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker root verification failed')

  const directoryCandidate = resolve(mount.hostDirectory)
  const dirBefore = await lstat(directoryCandidate).catch(() => null)
  if (!dirBefore || !dirBefore.isDirectory() || dirBefore.isSymbolicLink())
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker invocation path is not a directory')
  const directory = await realpath(directoryCandidate)
  const rel = relative(root, directory)
  if (
    directory !== directoryCandidate ||
    !contained(root, directory) ||
    rel !== mount.invocationId ||
    basename(directory) !== mount.invocationId ||
    dirname(directory) !== root ||
    dirBefore.uid !== opts.expectedOwnerUid ||
    (dirBefore.mode & 0o777) !== 0o711
  )
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker invocation directory is unsafe')
  const dirAfter = await lstat(directory)
  if (
    dirAfter.dev !== dirBefore.dev ||
    dirAfter.ino !== dirBefore.ino ||
    !dirAfter.isDirectory() ||
    dirAfter.uid !== opts.expectedOwnerUid ||
    (dirAfter.mode & 0o777) !== 0o711
  )
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker invocation directory changed')

  if (mount.hostSocketPath !== join(directory, BROKER_SOCKET_NAME))
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker socket path mismatch')
  if (Buffer.byteLength(mount.hostSocketPath) > 100)
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker socket path is too long')
  const socket = await lstat(mount.hostSocketPath).catch(() => null)
  if (
    !socket ||
    !socket.isSocket() ||
    socket.isSymbolicLink() ||
    socket.uid !== opts.socketUid ||
    socket.gid !== opts.socketGid ||
    (socket.mode & 0o777) !== 0o600
  )
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker socket ownership or mode is unsafe')
  if (!TOKEN_RE.test(mount.token))
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker invocation token is invalid')
}

function defaultResolverFactory(timeoutMs: number): CancelableDnsResolver {
  const resolver = new Resolver({ timeout: Math.max(1, Math.min(5_000, timeoutMs)), tries: 1 })
  return {
    resolve4: (hostname) => resolver.resolve4(hostname),
    resolve6: (hostname) => resolver.resolve6(hostname),
    cancel: () => resolver.cancel(),
  }
}

function logEvent(
  logger: LocalPluginBrokerDeps['logger'],
  event: string,
  fields: Record<string, unknown>,
): void {
  try {
    logger?.(event, fields)
  } catch {
    // Observability must not change the broker security/result contract.
  }
}

interface BrokerWireRequest {
  method: 'GET' | 'HEAD'
  url: URL
  headers: Record<string, string>
}

function tokenMatches(expected: Buffer, raw: unknown): boolean {
  if (typeof raw !== 'string' || !TOKEN_RE.test(raw)) return false
  let got: Buffer
  try {
    got = Buffer.from(raw, 'base64url')
  } catch {
    return false
  }
  return got.length === expected.length && timingSafeEqual(got, expected)
}

function containsUrlControlOrBackslash(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x20 || code === 0x5c || code === 0x7f) return true
  }
  return false
}

function containsNonPrintableAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code > 0x7e) return true
  }
  return false
}

function parseWireRequest(line: string, expectedToken: Buffer): BrokerWireRequest {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    throw new LocalPluginBrokerError('BAD_REQUEST')
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new LocalPluginBrokerError('BAD_REQUEST')
  const request = raw as Record<string, unknown>
  const allowed = new Set(['version', 'token', 'op', 'method', 'url', 'headers'])
  if (Object.keys(request).some((key) => POLLUTION_KEYS.has(key) || !allowed.has(key)))
    throw new LocalPluginBrokerError('BAD_REQUEST')
  if (!tokenMatches(expectedToken, request.token)) throw new LocalPluginBrokerError('UNAUTHORIZED')
  if (request.version !== 1 || request.op !== 'http.request')
    throw new LocalPluginBrokerError('BAD_REQUEST')
  if (request.method !== 'GET' && request.method !== 'HEAD')
    throw new LocalPluginBrokerError('BAD_REQUEST')
  if (
    typeof request.url !== 'string' ||
    request.url.length === 0 ||
    request.url.length > 4096 ||
    containsUrlControlOrBackslash(request.url)
  )
    throw new LocalPluginBrokerError('BAD_REQUEST')
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    throw new LocalPluginBrokerError('BAD_REQUEST')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '')
    throw new LocalPluginBrokerError('OUTBOUND_BLOCKED')

  const headers: Record<string, string> = Object.create(null)
  if (request.headers !== undefined) {
    if (
      request.headers === null ||
      typeof request.headers !== 'object' ||
      Array.isArray(request.headers)
    )
      throw new LocalPluginBrokerError('BAD_REQUEST')
    for (const [rawName, rawValue] of Object.entries(request.headers as Record<string, unknown>)) {
      const name = rawName.toLowerCase()
      if (
        POLLUTION_KEYS.has(rawName) ||
        !SAFE_REQUEST_HEADERS.has(name) ||
        Object.hasOwn(headers, name) ||
        typeof rawValue !== 'string' ||
        rawValue.length > 512 ||
        containsNonPrintableAscii(rawValue)
      )
        throw new LocalPluginBrokerError('BAD_REQUEST')
      headers[name] = rawValue
    }
  }
  headers['user-agent'] = 'OpenClaude-Plugin-Broker/1'
  return { method: request.method, url, headers }
}

async function readBoundedBody(
  response: Response,
  method: 'GET' | 'HEAD',
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (method === 'HEAD') {
    await response.body?.cancel().catch(() => {})
    return Buffer.alloc(0)
  }
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new LocalPluginBrokerError('RESPONSE_LIMIT')
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  const abortReader = () => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', abortReader)
  try {
    while (true) {
      if (signal.aborted) throw signal.reason
      const item = await reader.read()
      if (item.done) break
      const chunk = Buffer.from(item.value)
      bytes += chunk.length
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new LocalPluginBrokerError('RESPONSE_LIMIT')
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, bytes)
  } finally {
    signal.removeEventListener('abort', abortReader)
  }
}

function safeResponseHeaders(response: Response): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = response.headers.get(name)
    if (value !== null) out[name] = value.slice(0, 1024)
  }
  return out
}

function errorCode(
  error: unknown,
  closing: boolean,
  timedOut: boolean,
): LocalPluginBrokerError['code'] {
  if (closing) return 'CLOSING'
  if (timedOut) return 'TIMEOUT'
  if (error instanceof LocalPluginBrokerError) return error.code
  if (error instanceof ConnectorError) return 'OUTBOUND_BLOCKED'
  return 'INTERNAL'
}

function wireError(code: LocalPluginBrokerError['code']): Record<string, unknown> {
  return { ok: false, error: { code } }
}

export async function createLocalPluginBroker(args: {
  root: string
  invocationId: string
  policy: LocalPluginBrokerActionPolicy
  expectedOwnerUid?: number
  socketUid?: number
  socketGid?: number
  deps?: LocalPluginBrokerDeps
}): Promise<LocalPluginBrokerHandle> {
  if (!UUID_RE.test(args.invocationId))
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker invocation id must be UUID v4')
  const expectedOwnerUid = args.expectedOwnerUid ?? 0
  const socketUid = args.socketUid ?? 1000
  const socketGid = args.socketGid ?? 1000
  if (
    ![expectedOwnerUid, socketUid, socketGid].every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 2_147_483_647,
    )
  )
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker uid/gid is invalid')
  const runtimePolicy = compileLocalPluginBrokerPolicy(
    { schemaVersion: 1, actions: { invoke: args.policy } },
    new Set(['invoke']),
  ).actions.invoke
  if (!runtimePolicy)
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker action policy is missing')
  const brokerRoot = await assertSafeBrokerRoot(args.root, expectedOwnerUid)
  const hostDirectory = join(brokerRoot, args.invocationId)
  if (!contained(brokerRoot, hostDirectory) || dirname(hostDirectory) !== brokerRoot)
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker invocation path escaped root')
  await mkdir(hostDirectory, { mode: 0o700 })
  const hostSocketPath = join(hostDirectory, BROKER_SOCKET_NAME)
  if (Buffer.byteLength(hostSocketPath) > 100) {
    await rm(hostDirectory, { recursive: true, force: true })
    throw new LocalPluginBrokerError('INVALID_POLICY', 'broker socket path is too long')
  }

  const tokenBytes = randomBytes(32)
  const token = tokenBytes.toString('base64url')
  const invocationController = new AbortController()
  const sockets = new Set<Socket>()
  const handlers = new Set<Promise<void>>()
  let activeRequests = 0
  let requestsStarted = 0
  let acceptedConnections = 0
  let closing = false
  let closed = false
  let closePromise: Promise<void> | null = null
  const deps = args.deps ?? {}
  const httpPolicy = runtimePolicy.httpRead
  const connectionBudget = httpPolicy.maxRequests + 8

  const handleRequest = async (line: string): Promise<Record<string, unknown>> => {
    let request: BrokerWireRequest
    try {
      request = parseWireRequest(line, tokenBytes)
    } catch (error) {
      return wireError(errorCode(error, closing, false))
    }
    if (closing) return wireError('CLOSING')
    requestsStarted += 1
    if (requestsStarted > httpPolicy.maxRequests) return wireError('QUOTA_EXCEEDED')
    if (activeRequests >= httpPolicy.maxConcurrent) return wireError('QUOTA_EXCEEDED')

    let origin: string
    try {
      origin = normalizeHttpsOrigin(request.url.origin)
    } catch {
      return wireError('OUTBOUND_BLOCKED')
    }
    if (!httpPolicy.origins.includes(origin)) return wireError('OUTBOUND_BLOCKED')

    activeRequests += 1
    let timedOut = false
    const requestController = new AbortController()
    const onInvocationAbort = () => requestController.abort()
    invocationController.signal.addEventListener('abort', onInvocationAbort)
    const timeout = setTimeout(() => {
      timedOut = true
      requestController.abort()
    }, httpPolicy.requestTimeoutMs)
    timeout.unref()
    const resolver = (deps.resolverFactory ?? defaultResolverFactory)(
      Math.min(5_000, httpPolicy.requestTimeoutMs),
    )
    try {
      const response = await pinnedHttpsFetch(
        request.url,
        { method: request.method, headers: request.headers },
        {
          resolver,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          signal: requestController.signal,
        },
      )
      if (response.status >= 300 && response.status <= 399) {
        await response.body?.cancel().catch(() => {})
        throw new LocalPluginBrokerError('OUTBOUND_BLOCKED')
      }
      const body = await readBoundedBody(
        response,
        request.method,
        httpPolicy.maxResponseBytes,
        requestController.signal,
      )
      logEvent(deps.logger, 'plugin.broker.http.ok', {
        method: request.method,
        origin,
        status: response.status,
        responseBytes: body.length,
      })
      return {
        ok: true,
        response: {
          status: response.status,
          headers: safeResponseHeaders(response),
          bodyBase64: body.toString('base64'),
        },
      }
    } catch (error) {
      const code = errorCode(error, closing, timedOut)
      logEvent(deps.logger, 'plugin.broker.http.error', { method: request.method, origin, code })
      return wireError(code)
    } finally {
      clearTimeout(timeout)
      invocationController.signal.removeEventListener('abort', onInvocationAbort)
      activeRequests -= 1
    }
  }

  const server: Server = createServer((socket: Socket) => {
    if (closing || acceptedConnections >= connectionBudget) {
      socket.destroy()
      return
    }
    acceptedConnections += 1
    sockets.add(socket)
    socket.setEncoding('utf8')
    socket.setTimeout(CLIENT_IDLE_TIMEOUT_MS, () => socket.destroy())
    let buffer = ''
    let bytes = 0
    let handled = false
    socket.on('data', (chunk: string) => {
      if (handled || closing) return
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > MAX_REQUEST_FRAME_BYTES) {
        handled = true
        socket.end(`${JSON.stringify(wireError('BAD_REQUEST'))}\n`)
        return
      }
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      handled = true
      socket.setTimeout(0)
      if (buffer.slice(newline + 1) !== '') {
        socket.end(`${JSON.stringify(wireError('BAD_REQUEST'))}\n`)
        return
      }
      const task = (async () => {
        let result: Record<string, unknown>
        try {
          result = await handleRequest(buffer.slice(0, newline))
        } catch {
          result = wireError(closing ? 'CLOSING' : 'INTERNAL')
        }
        if (!socket.destroyed) socket.end(`${JSON.stringify(result)}\n`)
      })()
      handlers.add(task)
      void task.then(
        () => handlers.delete(task),
        () => handlers.delete(task),
      )
    })
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  })
  server.on('error', () => {
    if (!closing) invocationController.abort()
  })

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => rejectListen(error)
      server.once('error', onError)
      server.listen(hostSocketPath, () => {
        server.off('error', onError)
        resolveListen()
      })
    })
    await chown(hostSocketPath, socketUid, socketGid)
    await chmod(hostSocketPath, 0o600)
    // Keep the invocation directory root-only until the socket itself has its
    // final uid/gid/mode, avoiding a permissive bind target during startup.
    await chmod(hostDirectory, 0o711)
    const mount: LocalPluginBrokerMount = {
      invocationId: args.invocationId,
      brokerRoot,
      hostDirectory,
      hostSocketPath,
      containerSocketPath: LOCAL_PLUGIN_BROKER_SOCKET,
      token,
    }
    await verifyLocalPluginBrokerMount(mount, { expectedOwnerUid, socketUid, socketGid })

    const close = (): Promise<void> => {
      if (closePromise) return closePromise
      closePromise = (async () => {
        closing = true
        invocationController.abort()
        const serverClosed = new Promise<void>((resolveClose) => {
          if (!server.listening) {
            resolveClose()
            return
          }
          server.close(() => resolveClose())
        })
        const socketClosures = [...sockets].map(
          (socket) =>
            new Promise<void>((resolveSocket) => {
              if (!sockets.has(socket)) resolveSocket()
              else socket.once('close', () => resolveSocket())
            }),
        )
        for (const socket of sockets) socket.destroy()
        await serverClosed
        await Promise.all(socketClosures)
        await Promise.allSettled([...handlers])
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn))
        if (handlers.size !== 0 || sockets.size !== 0 || activeRequests !== 0)
          throw new LocalPluginBrokerError('CLEANUP_FAILED', 'broker lifecycle did not settle')
        await rm(hostDirectory, { recursive: true, force: true })
        tokenBytes.fill(0)
        closed = true
      })()
      return closePromise
    }

    return {
      mount,
      stats: () => ({
        acceptedConnections,
        openConnections: sockets.size,
        activeHandlers: handlers.size,
        activeRequests,
        requestsStarted,
        closing,
        closed,
      }),
      close,
    }
  } catch (error) {
    closing = true
    invocationController.abort()
    for (const socket of sockets) socket.destroy()
    if (server.listening)
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    await Promise.allSettled([...handlers])
    await rm(hostDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
