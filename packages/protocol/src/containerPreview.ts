/**
 * V5 container-local web preview protocol.
 *
 * This module is intentionally browser-safe: URL and frame helpers are shared
 * by commercial master, in-container gateway and web-react. Cryptographic
 * bridge assertions live in containerPreviewAuth.ts.
 */

export const CONTAINER_PREVIEW_PROTOCOL_VERSION = 1 as const
export const CONTAINER_PREVIEW_PUBLIC_WS_PATH = '/ws/container-preview'
export const CONTAINER_PREVIEW_INTERNAL_WS_PATH = '/ws/container-preview'
export const CONTAINER_PREVIEW_TICKET_PROTOCOL = 'preview-v1'
export const CONTAINER_PREVIEW_ASSERTION_HEADER = 'x-openclaude-preview-assertion'
export const OPENCLAUDE_CONTAINER_GATEWAY_PORT = 18_789

export const CONTAINER_PREVIEW_BINARY_MAGIC = 'OCPF'
export const CONTAINER_PREVIEW_BINARY_HEADER_BYTES = 20
export const CONTAINER_PREVIEW_MAX_BINARY_FRAME_BYTES = 8 * 1024 * 1024

export interface ContainerRuntimeReservedListener {
  readonly port: number
  readonly owner: string
  readonly purpose: string
}

/**
 * Single authority for platform-owned TCP listeners inside a V5 user
 * container. Any new platform listener must be registered here before it is
 * shipped. The preview browser can never target these ports.
 */
export const CONTAINER_RUNTIME_RESERVED_LISTENERS = [
  {
    port: OPENCLAUDE_CONTAINER_GATEWAY_PORT,
    owner: 'openclaude-gateway',
    purpose: 'container control plane',
  },
] as const satisfies readonly ContainerRuntimeReservedListener[]

export const CONTAINER_RUNTIME_RESERVED_PORTS: ReadonlySet<number> = new Set(
  CONTAINER_RUNTIME_RESERVED_LISTENERS.map((listener) => listener.port),
)

const ADMIN_AND_DATASTORE_PORTS: ReadonlySet<number> = new Set([
  22, 25, 111, 445, 465, 587, 2_375, 2_376, 3_306, 3_389, 5_432, 5_984, 6_379, 9_200, 9_222, 9_300,
  11_211, 27_017, 27_018,
])

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::'])

export class ContainerPreviewUrlError extends Error {
  constructor(
    readonly code: 'BAD_URL' | 'UNSAFE_HOST' | 'BLOCKED_PORT',
    message: string,
  ) {
    super(message)
    this.name = 'ContainerPreviewUrlError'
  }
}

export interface NormalizedContainerPreviewUrl {
  /** Canonical URL, with wildcard hosts mapped to loopback and fragment removed. */
  readonly url: string
  /** Canonical exact origin used to pin every local request in this session. */
  readonly origin: string
  readonly protocol: 'http:' | 'https:'
  /** Bracket-free canonical hostname. */
  readonly hostname: 'localhost' | '127.0.0.1' | '::1'
  readonly port: number
}

function bracketlessHostname(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

function effectivePort(url: URL): number {
  if (url.port !== '') return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

function assertPreviewPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ContainerPreviewUrlError('BAD_URL', 'invalid port')
  }
  if (CONTAINER_RUNTIME_RESERVED_PORTS.has(port) || ADMIN_AND_DATASTORE_PORTS.has(port)) {
    throw new ContainerPreviewUrlError('BLOCKED_PORT', 'platform or administrative port is blocked')
  }
  if (port < 1_024 && port !== 80 && port !== 443) {
    throw new ContainerPreviewUrlError('BLOCKED_PORT', 'privileged port is blocked')
  }
}

/**
 * Parse and canonicalize an address that may be opened in a user's own
 * container. Standard URL parsing happens before the exact loopback check, so
 * alternate IPv4 spellings cannot escape the boundary.
 */
export function normalizeContainerPreviewUrl(raw: string): NormalizedContainerPreviewUrl {
  if (typeof raw !== 'string') {
    throw new ContainerPreviewUrlError('BAD_URL', 'URL must be a string')
  }
  const input = raw.trim()
  if (input.length < 1 || input.length > 2_048 || input.includes('\\')) {
    throw new ContainerPreviewUrlError('BAD_URL', 'invalid URL length or syntax')
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new ContainerPreviewUrlError('BAD_URL', 'invalid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ContainerPreviewUrlError('BAD_URL', 'only HTTP and HTTPS are supported')
  }
  if (url.username !== '' || url.password !== '') {
    throw new ContainerPreviewUrlError('BAD_URL', 'URL credentials are not allowed')
  }

  let host = bracketlessHostname(url.hostname).toLowerCase()
  if (host === 'localhost.') host = 'localhost'
  if (!LOCAL_HOSTS.has(host)) {
    throw new ContainerPreviewUrlError(
      'UNSAFE_HOST',
      'only the current container loopback is allowed',
    )
  }
  if (host === '0.0.0.0') host = '127.0.0.1'
  if (host === '::') host = '::1'

  // Assigning hostname makes URL serialize IPv6 brackets correctly.
  url.hostname = host.includes(':') ? `[${host}]` : host
  url.hash = ''
  const port = effectivePort(url)
  assertPreviewPort(port)

  const canonical = url.toString()
  if (canonical.length > 2_048) {
    throw new ContainerPreviewUrlError('BAD_URL', 'canonical URL is too long')
  }
  return {
    url: canonical,
    origin: url.origin,
    protocol: url.protocol,
    hostname: host as NormalizedContainerPreviewUrl['hostname'],
    port,
  }
}

export function isContainerPreviewUrl(raw: string): boolean {
  try {
    normalizeContainerPreviewUrl(raw)
    return true
  } catch {
    return false
  }
}

/**
 * Every HTTP(S) request must remain on the one signed loopback origin.
 * External hostnames are also blocked: allowing them by name would permit DNS
 * rebinding back into a different loopback/platform listener after validation.
 */
export function isAllowedContainerPreviewHttpRequest(raw: string, pinnedOrigin: string): boolean {
  try {
    return normalizeContainerPreviewUrl(raw).origin === pinnedOrigin
  } catch {
    return false
  }
}

/** Top-level/frame navigations must never leave the signed local application origin. */
export function isAllowedContainerPreviewNavigation(raw: string, pinnedOrigin: string): boolean {
  try {
    return normalizeContainerPreviewUrl(raw).origin === pinnedOrigin
  } catch {
    return false
  }
}

/** True only when a loopback WS(S) URL maps to the pinned HTTP(S) origin. */
export function isAllowedContainerPreviewWebSocket(raw: string, pinnedOrigin: string): boolean {
  try {
    const ws = new URL(raw)
    if (ws.protocol !== 'ws:' && ws.protocol !== 'wss:') return false
    if (!isLoopbackHostname(ws.hostname)) return false
    const mapped = new URL(ws.toString())
    mapped.protocol = ws.protocol === 'wss:' ? 'https:' : 'http:'
    return normalizeContainerPreviewUrl(mapped.toString()).origin === pinnedOrigin
  } catch {
    return false
  }
}

export function isLoopbackHostname(rawHostname: string): boolean {
  let host = bracketlessHostname(rawHostname).toLowerCase()
  if (host === 'localhost.') host = 'localhost'
  if (host === '0.0.0.0') host = '127.0.0.1'
  if (host === '::') host = '::1'
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

export interface ContainerPreviewViewport {
  readonly width: number
  readonly height: number
  readonly deviceScaleFactor: number
  readonly isMobile: boolean
}

export const CONTAINER_PREVIEW_DESKTOP_VIEWPORT: ContainerPreviewViewport = {
  width: 1_280,
  height: 800,
  deviceScaleFactor: 1,
  isMobile: false,
}

export const CONTAINER_PREVIEW_MOBILE_VIEWPORT: ContainerPreviewViewport = {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  isMobile: true,
}

const CONTAINER_PREVIEW_MAX_DEVICE_PIXELS = 4_000_000

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function normalizeContainerPreviewViewport(
  input: Partial<ContainerPreviewViewport> | null | undefined,
): ContainerPreviewViewport {
  const mobile = input?.isMobile === true
  const fallback = mobile ? CONTAINER_PREVIEW_MOBILE_VIEWPORT : CONTAINER_PREVIEW_DESKTOP_VIEWPORT
  const width = Math.round(
    Math.min(1_920, Math.max(320, finiteNumber(input?.width, fallback.width))),
  )
  const height = Math.round(
    Math.min(1_200, Math.max(320, finiteNumber(input?.height, fallback.height))),
  )
  const requestedScale = Math.min(
    2,
    Math.max(1, finiteNumber(input?.deviceScaleFactor, fallback.deviceScaleFactor)),
  )
  const pixelBudgetScale = Math.sqrt(CONTAINER_PREVIEW_MAX_DEVICE_PIXELS / (width * height))
  const deviceScaleFactor = Math.floor(Math.min(requestedScale, pixelBudgetScale) * 100) / 100
  return {
    width,
    height,
    deviceScaleFactor: Math.max(1, deviceScaleFactor),
    isMobile: mobile,
  }
}

export function canonicalContainerPreviewTarget(
  canonicalUrl: string,
  viewport: ContainerPreviewViewport,
): string {
  const v = normalizeContainerPreviewViewport(viewport)
  return `${canonicalUrl}\n${v.width}x${v.height}@${v.deviceScaleFactor}\n${v.isMobile ? 'mobile' : 'desktop'}`
}

export interface ContainerPreviewFrameHeader {
  readonly version: typeof CONTAINER_PREVIEW_PROTOCOL_VERSION
  readonly highQuality: boolean
  readonly pageRevision: number
  readonly frameSequence: number
  readonly pixelWidth: number
  readonly pixelHeight: number
}

function assertUint(value: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`invalid ${label}`)
}

export function encodeContainerPreviewFrame(
  header: Omit<ContainerPreviewFrameHeader, 'version'> & {
    version?: typeof CONTAINER_PREVIEW_PROTOCOL_VERSION
  },
  jpeg: Uint8Array,
): Uint8Array {
  assertUint(header.pageRevision, 0xffff_ffff, 'pageRevision')
  assertUint(header.frameSequence, 0xffff_ffff, 'frameSequence')
  assertUint(header.pixelWidth, 0xffff, 'pixelWidth')
  assertUint(header.pixelHeight, 0xffff, 'pixelHeight')
  if (!(jpeg instanceof Uint8Array) || jpeg.byteLength < 1) throw new Error('empty JPEG frame')

  const output = new Uint8Array(CONTAINER_PREVIEW_BINARY_HEADER_BYTES + jpeg.byteLength)
  output.set([0x4f, 0x43, 0x50, 0x46], 0) // OCPF
  const view = new DataView(output.buffer)
  view.setUint8(4, header.version ?? CONTAINER_PREVIEW_PROTOCOL_VERSION)
  view.setUint8(5, header.highQuality ? 1 : 0)
  view.setUint16(6, CONTAINER_PREVIEW_BINARY_HEADER_BYTES, false)
  view.setUint32(8, header.pageRevision, false)
  view.setUint32(12, header.frameSequence, false)
  view.setUint16(16, header.pixelWidth, false)
  view.setUint16(18, header.pixelHeight, false)
  output.set(jpeg, CONTAINER_PREVIEW_BINARY_HEADER_BYTES)
  return output
}

export function decodeContainerPreviewFrame(packet: ArrayBuffer | Uint8Array): {
  header: ContainerPreviewFrameHeader
  jpeg: Uint8Array
} {
  const bytes = packet instanceof Uint8Array ? packet : new Uint8Array(packet)
  if (bytes.byteLength <= CONTAINER_PREVIEW_BINARY_HEADER_BYTES)
    throw new Error('truncated preview frame')
  if (bytes[0] !== 0x4f || bytes[1] !== 0x43 || bytes[2] !== 0x50 || bytes[3] !== 0x46) {
    throw new Error('bad preview frame magic')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint8(4)
  const headerBytes = view.getUint16(6, false)
  if (version !== CONTAINER_PREVIEW_PROTOCOL_VERSION)
    throw new Error('unsupported preview frame version')
  if (headerBytes !== CONTAINER_PREVIEW_BINARY_HEADER_BYTES)
    throw new Error('bad preview frame header length')
  return {
    header: {
      version: CONTAINER_PREVIEW_PROTOCOL_VERSION,
      highQuality: (view.getUint8(5) & 1) === 1,
      pageRevision: view.getUint32(8, false),
      frameSequence: view.getUint32(12, false),
      pixelWidth: view.getUint16(16, false),
      pixelHeight: view.getUint16(18, false),
    },
    jpeg: bytes.subarray(headerBytes),
  }
}

export interface ContainerPreviewElementTarget {
  readonly selector: string
  readonly tag: string
  readonly role?: string
  readonly ariaLabel?: string
  readonly text?: string
  readonly bounds: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
}

/** Trusted first frame sent by commercial master to the container gateway. */
export interface ContainerPreviewOpenMessage {
  readonly type: 'preview.open'
  readonly protocolVersion: typeof CONTAINER_PREVIEW_PROTOCOL_VERSION
  readonly url: string
  readonly viewport: ContainerPreviewViewport
}

export type ContainerPreviewClientMessage =
  | {
      type: 'preview.pointer'
      action: 'move' | 'down' | 'up' | 'click'
      x: number
      y: number
      button?: 'left' | 'middle' | 'right'
    }
  | { type: 'preview.wheel'; deltaX: number; deltaY: number }
  | { type: 'preview.key'; key: string }
  | { type: 'preview.text'; text: string }
  | { type: 'preview.select'; x: number; y: number }
  | { type: 'preview.resolve'; selector: string }
  | { type: 'preview.navigate'; action: 'back' | 'forward' | 'reload' }
  | { type: 'preview.resize'; viewport: ContainerPreviewViewport }
  | { type: 'preview.close' }

export type ContainerPreviewServerMessage =
  | {
      type: 'preview.status'
      status: 'connecting' | 'probing' | 'launching' | 'loading'
      message?: string
    }
  | {
      type: 'preview.ready'
      protocolVersion: 1
      url: string
      title: string
      viewport: ContainerPreviewViewport
    }
  | { type: 'preview.navigation'; url: string; title: string; pageRevision: number }
  | { type: 'preview.selection'; target: ContainerPreviewElementTarget | null }
  | { type: 'preview.resolved'; selector: string; target: ContainerPreviewElementTarget | null }
  | { type: 'preview.error'; code: string; message: string; retryable: boolean }
