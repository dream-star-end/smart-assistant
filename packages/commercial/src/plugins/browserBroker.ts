/**
 * Invocation-scoped raw TLS broker for managed-browser Plugin workers.
 *
 * Workers run with Docker network=none. Each CONNECT tunnel is authenticated on
 * a root-owned Unix socket and can reach only an already resolved IPv4 pin from
 * the signed Plugin contract. The broker never resolves DNS and never receives
 * marketplace-controlled destinations.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, chown, lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { type Server, type Socket, createConnection, createServer, isIP } from 'node:net'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type { ManagedBrowserPinnedOrigin } from './browserRuntime.js'

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const INVOCATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SOCKET_NAME = 'tls.sock'
const CONTAINER_SOCKET = '/run/oc-browser-broker/tls.sock'
const MAX_AUTH_FRAME_BYTES = 4096

export class ManagedBrowserBrokerError extends Error {
  readonly code:
    | 'INVALID_CONFIG'
    | 'UNAUTHORIZED'
    | 'DESTINATION_BLOCKED'
    | 'QUOTA_EXCEEDED'
    | 'CLOSING'
    | 'CLEANUP_FAILED'

  constructor(code: ManagedBrowserBrokerError['code'], message: string = code) {
    super(message)
    this.name = 'ManagedBrowserBrokerError'
    this.code = code
  }
}

export interface ManagedBrowserBrokerLimits {
  maxConnections: number
  maxConcurrent: number
  maxBytesPerDirection: number
  idleTimeoutMs: number
  connectTimeoutMs: number
}

export const DEFAULT_MANAGED_BROWSER_BROKER_LIMITS: ManagedBrowserBrokerLimits = Object.freeze({
  maxConnections: 64,
  maxConcurrent: 8,
  maxBytesPerDirection: 32 * 1024 * 1024,
  idleTimeoutMs: 30_000,
  connectTimeoutMs: 10_000,
})

export interface ManagedBrowserBrokerMount {
  invocationId: string
  brokerRoot: string
  hostDirectory: string
  hostSocketPath: string
  containerSocketPath: typeof CONTAINER_SOCKET
  token: string
}

export interface ManagedBrowserBrokerHandle {
  mount: ManagedBrowserBrokerMount
  stats(): {
    acceptedConnections: number
    openConnections: number
    closing: boolean
    closed: boolean
  }
  close(): Promise<void>
}

function assertLimits(limits: ManagedBrowserBrokerLimits): void {
  const valid =
    Number.isInteger(limits.maxConnections) &&
    limits.maxConnections >= 1 &&
    limits.maxConnections <= 256 &&
    Number.isInteger(limits.maxConcurrent) &&
    limits.maxConcurrent >= 1 &&
    limits.maxConcurrent <= 32 &&
    limits.maxConcurrent <= limits.maxConnections &&
    Number.isInteger(limits.maxBytesPerDirection) &&
    limits.maxBytesPerDirection >= 64 * 1024 &&
    limits.maxBytesPerDirection <= 128 * 1024 * 1024 &&
    Number.isInteger(limits.idleTimeoutMs) &&
    limits.idleTimeoutMs >= 1_000 &&
    limits.idleTimeoutMs <= 120_000 &&
    Number.isInteger(limits.connectTimeoutMs) &&
    limits.connectTimeoutMs >= 500 &&
    limits.connectTimeoutMs <= 30_000
  if (!valid)
    throw new ManagedBrowserBrokerError('INVALID_CONFIG', 'browser broker limits are invalid')
}

async function safeRoot(rootInput: string, expectedOwnerUid: number): Promise<string> {
  if (!isAbsolute(rootInput))
    throw new ManagedBrowserBrokerError('INVALID_CONFIG', 'browser broker root must be absolute')
  const root = resolve(rootInput)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700)
  const before = await lstat(root)
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    before.uid !== expectedOwnerUid ||
    (before.mode & 0o777) !== 0o700
  )
    throw new ManagedBrowserBrokerError('INVALID_CONFIG', 'browser broker root is unsafe')
  const canonical = await realpath(root)
  const after = await lstat(canonical)
  if (
    canonical !== root ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    !after.isDirectory()
  )
    throw new ManagedBrowserBrokerError('INVALID_CONFIG', 'browser broker root changed')
  return root
}

function equalToken(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || !TOKEN_RE.test(actual)) return false
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function parseAuthFrame(frame: Buffer): { token: string; host: string; port: number } {
  let value: unknown
  try {
    value = JSON.parse(frame.toString('utf8'))
  } catch {
    throw new ManagedBrowserBrokerError('UNAUTHORIZED', 'browser broker auth failed')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ManagedBrowserBrokerError('UNAUTHORIZED', 'browser broker auth failed')
  const object = value as Record<string, unknown>
  if (
    Object.keys(object).sort().join('\0') !== 'host\0port\0token' ||
    typeof object.token !== 'string' ||
    typeof object.host !== 'string' ||
    !Number.isInteger(object.port)
  )
    throw new ManagedBrowserBrokerError('UNAUTHORIZED', 'browser broker auth failed')
  return { token: object.token, host: object.host, port: Number(object.port) }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(socketPath, () => {
      server.off('error', onError)
      resolveListen()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()))
}

export async function createManagedBrowserTlsBroker(args: {
  root: string
  invocationId: string
  pins: readonly ManagedBrowserPinnedOrigin[]
  expectedOwnerUid?: number
  socketUid?: number
  socketGid?: number
  limits?: ManagedBrowserBrokerLimits
}): Promise<ManagedBrowserBrokerHandle> {
  if (!INVOCATION_RE.test(args.invocationId))
    throw new ManagedBrowserBrokerError('INVALID_CONFIG', 'browser broker invocation is invalid')
  const limits = args.limits ?? DEFAULT_MANAGED_BROWSER_BROKER_LIMITS
  assertLimits(limits)
  if (args.pins.length === 0 || args.pins.length > 16)
    throw new ManagedBrowserBrokerError('INVALID_CONFIG', 'browser broker pins are invalid')
  const pins = new Map<string, ManagedBrowserPinnedOrigin>()
  for (const pin of args.pins) {
    const key = `${pin.hostname}:${pin.port}`
    if (
      pins.has(key) ||
      pin.family !== 4 ||
      isIP(pin.ip) !== 4 ||
      pin.hostname !== pin.hostname.toLowerCase() ||
      pin.port < 1 ||
      pin.port > 65_535
    )
      throw new ManagedBrowserBrokerError('INVALID_CONFIG', 'browser broker pin is invalid')
    pins.set(key, pin)
  }
  const root = await safeRoot(args.root, args.expectedOwnerUid ?? 0)
  const hostDirectory = join(root, args.invocationId)
  if (dirname(hostDirectory) !== root || basename(hostDirectory) !== args.invocationId)
    throw new ManagedBrowserBrokerError('INVALID_CONFIG', 'browser broker path is invalid')
  await mkdir(hostDirectory, { mode: 0o711 })
  await chmod(hostDirectory, 0o711)
  const hostSocketPath = join(hostDirectory, SOCKET_NAME)
  if (Buffer.byteLength(hostSocketPath) > 100)
    throw new ManagedBrowserBrokerError('INVALID_CONFIG', 'browser broker socket path is too long')
  const token = randomBytes(32).toString('base64url')
  let acceptedConnections = 0
  let openConnections = 0
  let closing = false
  let closed = false
  const sockets = new Set<Socket>()

  const server = createServer((client) => {
    acceptedConnections++
    if (
      closing ||
      acceptedConnections > limits.maxConnections ||
      openConnections >= limits.maxConcurrent
    ) {
      client.destroy()
      return
    }
    openConnections++
    sockets.add(client)
    client.setTimeout(limits.idleTimeoutMs, () => client.destroy())
    let auth = Buffer.alloc(0)
    let expectedLength: number | null = null
    let upstream: Socket | null = null
    let connectTimer: NodeJS.Timeout | null = null
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      if (connectTimer) clearTimeout(connectTimer)
      openConnections--
      sockets.delete(client)
      if (upstream) sockets.delete(upstream)
      client.destroy()
      upstream?.destroy()
    }
    client.once('close', finish)
    client.once('error', finish)
    client.on('data', function authenticate(chunk: Buffer) {
      if (upstream) return
      auth = Buffer.concat([auth, chunk], auth.length + chunk.length)
      if (auth.length > MAX_AUTH_FRAME_BYTES + 4) return finish()
      if (expectedLength === null && auth.length >= 4) {
        expectedLength = auth.readUInt32BE(0)
        if (expectedLength < 2 || expectedLength > MAX_AUTH_FRAME_BYTES) return finish()
      }
      if (expectedLength === null || auth.length < expectedLength + 4) return
      client.off('data', authenticate)
      let request: { token: string; host: string; port: number }
      try {
        request = parseAuthFrame(auth.subarray(4, expectedLength + 4))
      } catch {
        return finish()
      }
      if (!equalToken(request.token, token)) return finish()
      const pin = pins.get(`${request.host}:${request.port}`)
      if (!pin) return finish()
      const remainder = auth.subarray(expectedLength + 4)
      auth = Buffer.alloc(0)
      const target = createConnection({ host: pin.ip, port: pin.port, family: 4 })
      upstream = target
      sockets.add(target)
      target.setTimeout(limits.idleTimeoutMs, finish)
      connectTimer = setTimeout(finish, limits.connectTimeoutMs)
      target.once('connect', () => {
        if (connectTimer) clearTimeout(connectTimer)
        connectTimer = null
        if (remainder.length > 0) target.write(remainder)
        client.write(Buffer.from([0]))
        let sent = remainder.length
        let received = 0
        client.on('data', (data: Buffer) => {
          sent += data.length
          if (sent > limits.maxBytesPerDirection) return finish()
          if (!target.write(data)) client.pause()
        })
        target.on('drain', () => client.resume())
        target.on('data', (data: Buffer) => {
          received += data.length
          if (received > limits.maxBytesPerDirection) return finish()
          if (!client.write(data)) target.pause()
        })
        client.on('drain', () => target.resume())
      })
      target.once('error', finish)
      target.once('close', finish)
    })
  })

  try {
    await listen(server, hostSocketPath)
    await chmod(hostSocketPath, 0o660)
    await chown(hostSocketPath, args.socketUid ?? 1000, args.socketGid ?? 1000)
    const socket = await lstat(hostSocketPath)
    const directory = await realpath(hostDirectory)
    if (
      directory !== hostDirectory ||
      relative(root, directory) !== args.invocationId ||
      !socket.isSocket() ||
      socket.isSymbolicLink() ||
      socket.uid !== (args.socketUid ?? 1000) ||
      socket.gid !== (args.socketGid ?? 1000) ||
      (socket.mode & 0o777) !== 0o660
    )
      throw new ManagedBrowserBrokerError('INVALID_CONFIG', 'browser broker mount is unsafe')
  } catch (error) {
    closing = true
    await closeServer(server).catch(() => {})
    await rm(hostDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  const mount: ManagedBrowserBrokerMount = {
    invocationId: args.invocationId,
    brokerRoot: root,
    hostDirectory,
    hostSocketPath,
    containerSocketPath: CONTAINER_SOCKET,
    token,
  }
  return {
    mount,
    stats: () => ({ acceptedConnections, openConnections, closing, closed }),
    async close() {
      if (closed) return
      closing = true
      for (const socket of sockets) socket.destroy()
      await closeServer(server).catch(() => {})
      await rm(hostDirectory, { recursive: true, force: true })
      if (await lstat(hostDirectory).catch(() => null))
        throw new ManagedBrowserBrokerError('CLEANUP_FAILED', 'browser broker cleanup failed')
      closed = true
    },
  }
}
