/**
 * Pure CDP transport, key-event mapping, JPEG dimension probing, and WS upgrade
 * authorization helpers for `liveBrowserStream.ts` (OCV5-857).
 */
import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'

import {
  LIVE_BROWSER_ASSERTION_HEADER,
  liveBrowserModifiersToBitmask,
  parseAuthorityKeyring,
} from '@openclaude/protocol'
import { verifyLiveBrowserAssertion } from '@openclaude/protocol/containerPreviewAuth'
import { type RawData, WebSocket } from 'ws'

const CDP_CMD_TIMEOUT_MS = 10_000
const AGENT_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/

export interface LiveBrowserCdpEndpoint {
  readonly port: number
  readonly browserWsUrl: string
  readonly profileDir: string
}

export interface LiveBrowserCdpTransport {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>
  onEvent(handler: (method: string, params: any, sessionId?: string) => void): () => void
  onClose(handler: () => void): () => void
  close(): void
}

export function safePathname(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? '/', 'http://localhost').pathname
  } catch {
    return ''
  }
}

function parseQueryParam(rawUrl: string | undefined, key: string): string | null {
  try {
    return new URL(rawUrl ?? '/', 'http://localhost').searchParams.get(key)
  } catch {
    return null
  }
}

function parsePositiveSafeInteger(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw.trim())) return null
  const n = Number(raw.trim())
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function isIpv4Literal(raw: string): boolean {
  const parts = raw.split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255)
}

export function extractHttpOrigin(rawUrl: string): string | undefined {
  if (!rawUrl) return undefined
  try {
    const parsed = new URL(rawUrl)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined
  } catch {
    return undefined
  }
}

function resolveRequestOrigin(req: IncomingMessage): string | null {
  const rawHost = typeof req.headers.host === 'string' ? req.headers.host.trim() : ''
  if (!rawHost || /[\s/\\@]/.test(rawHost)) return null
  const rawProto =
    typeof req.headers['x-forwarded-proto'] === 'string'
      ? req.headers['x-forwarded-proto'].split(',')[0]?.trim().toLowerCase()
      : ''
  const proto =
    rawProto === 'https'
      ? 'https:'
      : rawProto === 'http'
        ? 'http:'
        : (req.socket as { encrypted?: boolean } | undefined)?.encrypted
          ? 'https:'
          : 'http:'
  try {
    const parsed = new URL(`${proto}//${rawHost}`)
    if (
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    ) {
      return null
    }
    return parsed.origin
  } catch {
    return null
  }
}

function isAllowedStandaloneOrigin(originHeader: string, req: IncomingMessage): boolean {
  let parsed: URL
  try {
    parsed = new URL(originHeader)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const reqOrigin = resolveRequestOrigin(req)
  if (!reqOrigin) return false
  return parsed.origin === reqOrigin
}

export class LiveBrowserUpgradeAuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message)
    this.name = 'LiveBrowserUpgradeAuthError'
  }
}

export function discoverLiveBrowserCdpEndpoint(stateDir: string): LiveBrowserCdpEndpoint | null {
  const profilePointer = join(stateDir, 'profile-dir')
  if (!existsSync(profilePointer)) return null
  let profileDir: string
  try {
    profileDir = readFileSync(profilePointer, 'utf8').trim()
  } catch {
    return null
  }
  if (!profileDir) return null
  const portFile = join(profileDir, 'DevToolsActivePort')
  if (!existsSync(portFile)) return null
  let lines: string[]
  try {
    lines = readFileSync(portFile, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return null
  }
  if (lines.length < 2) return null
  const port = Number.parseInt(lines[0]!, 10)
  const wsPath = lines[1]!
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  if (!wsPath.startsWith('/devtools/') || /\s/.test(wsPath)) return null
  return {
    port,
    browserWsUrl: `ws://127.0.0.1:${port}${wsPath}`,
    profileDir,
  }
}

class RawCdpWebSocketTransport implements LiveBrowserCdpTransport {
  private nextId = 1
  private readonly pending = new Map<
    number,
    {
      resolve: (val: any) => void
      reject: (err: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private readonly eventHandlers = new Set<
    (method: string, params: any, sessionId?: string) => void
  >()
  private readonly closeHandlers = new Set<() => void>()
  private closed = false

  constructor(private readonly ws: WebSocket) {
    ws.on('message', (data: RawData) => {
      let msg: {
        id?: unknown
        method?: unknown
        params?: unknown
        sessionId?: unknown
        result?: unknown
        error?: { message?: unknown; code?: unknown }
      }
      try {
        const text = typeof data === 'string' ? data : Buffer.from(data as any).toString('utf8')
        msg = JSON.parse(text)
      } catch {
        return
      }
      if (typeof msg.id === 'number') {
        const entry = this.pending.get(msg.id)
        if (!entry) return
        this.pending.delete(msg.id)
        clearTimeout(entry.timer)
        if (msg.error) {
          entry.reject(new Error(String(msg.error.message ?? 'CDP error')))
        } else {
          entry.resolve(msg.result ?? {})
        }
        return
      }
      if (typeof msg.method === 'string') {
        const sid = typeof msg.sessionId === 'string' ? msg.sessionId : undefined
        for (const handler of this.eventHandlers) {
          try {
            handler(msg.method, msg.params ?? {}, sid)
          } catch {}
        }
      }
    })

    const handleClose = () => {
      if (this.closed) return
      this.closed = true
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error('CDP connection closed'))
      }
      this.pending.clear()
      for (const handler of this.closeHandlers) {
        try {
          handler()
        } catch {}
      }
    }
    ws.once('close', handleClose)
    ws.once('error', handleClose)
  }

  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP socket is not open'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, CDP_CMD_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      const payload: Record<string, unknown> = { id, method }
      if (params) payload.params = params
      if (sessionId) payload.sessionId = sessionId
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  onEvent(handler: (method: string, params: any, sessionId?: string) => void): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('CDP connection closed'))
    }
    this.pending.clear()
    try {
      this.ws.close()
    } catch {}
  }
}

export async function defaultConnectCdp(
  endpoint: LiveBrowserCdpEndpoint,
): Promise<LiveBrowserCdpTransport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint.browserWsUrl, {
      maxPayload: 16 * 1024 * 1024,
      handshakeTimeout: 5_000,
    })
    let settled = false
    ws.once('open', () => {
      if (settled) return
      settled = true
      resolve(new RawCdpWebSocketTransport(ws))
    })
    ws.once('error', (err) => {
      if (settled) return
      settled = true
      reject(err instanceof Error ? err : new Error(String(err)))
    })
    ws.once('close', () => {
      if (settled) return
      settled = true
      reject(new Error('CDP WebSocket closed before open'))
    })
  })
}

export function readJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let offset = 2
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1
      continue
    }
    while (offset < buf.length && buf[offset] === 0xff) offset += 1
    if (offset >= buf.length) break
    const marker = buf[offset]!
    offset += 1
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > buf.length) break
    const segLen = buf.readUInt16BE(offset)
    if (segLen < 2 || offset + segLen > buf.length) break
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    if (isSof && segLen >= 7) {
      const height = buf.readUInt16BE(offset + 3)
      const width = buf.readUInt16BE(offset + 5)
      if (width >= 1 && width <= 65_535 && height >= 1 && height <= 65_535) {
        return { width, height }
      }
      return null
    }
    offset += segLen
  }
  return null
}

export interface KeyDef {
  key: string
  code: string
  keyCode: number
  text?: string
}

const SPECIAL_KEYS: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
}

const PUNCTUATION_KEYS: Record<string, { code: string; keyCode: number }> = {
  '-': { code: 'Minus', keyCode: 189 },
  _: { code: 'Minus', keyCode: 189 },
  '=': { code: 'Equal', keyCode: 187 },
  '+': { code: 'Equal', keyCode: 187 },
  '[': { code: 'BracketLeft', keyCode: 219 },
  '{': { code: 'BracketLeft', keyCode: 219 },
  ']': { code: 'BracketRight', keyCode: 221 },
  '}': { code: 'BracketRight', keyCode: 221 },
  '\\': { code: 'Backslash', keyCode: 220 },
  '|': { code: 'Backslash', keyCode: 220 },
  ';': { code: 'Semicolon', keyCode: 186 },
  ':': { code: 'Semicolon', keyCode: 186 },
  "'": { code: 'Quote', keyCode: 222 },
  '"': { code: 'Quote', keyCode: 222 },
  ',': { code: 'Comma', keyCode: 188 },
  '<': { code: 'Comma', keyCode: 188 },
  '.': { code: 'Period', keyCode: 190 },
  '>': { code: 'Period', keyCode: 190 },
  '/': { code: 'Slash', keyCode: 191 },
  '?': { code: 'Slash', keyCode: 191 },
  '`': { code: 'Backquote', keyCode: 192 },
  '~': { code: 'Backquote', keyCode: 192 },
}

for (let i = 1; i <= 12; i += 1) {
  SPECIAL_KEYS[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i }
}

const COMBO_MOD_BITS: Record<string, number> = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
}

/**
 * Parse both native single-key + bitmask payloads (`key: 'Tab', code: 'Tab', modifiers: 8`)
 * AND legacy Playwright combo strings (`key: 'Shift+Tab'`, `key: 'Control+a'`).
 */
export function resolveLiveBrowserKeyEvent(
  rawKey: string,
  rawCode?: string,
  rawText?: string,
  rawModifiers?: Parameters<typeof liveBrowserModifiersToBitmask>[0],
): { def: KeyDef; modifiers: number } {
  let modifiers = liveBrowserModifiersToBitmask(rawModifiers)
  let baseKey = rawKey
  if (rawKey.length > 1 && rawKey.includes('+')) {
    const parts = rawKey.split('+').filter(Boolean)
    if (parts.length >= 2) {
      let comboBits = 0
      let allPrefixMods = true
      for (let i = 0; i < parts.length - 1; i += 1) {
        const bit = COMBO_MOD_BITS[parts[i]!.toLowerCase()]
        if (!bit) {
          allPrefixMods = false
          break
        }
        comboBits |= bit
      }
      if (allPrefixMods) {
        modifiers |= comboBits
        baseKey = parts[parts.length - 1]!
      }
    }
  }

  const known = SPECIAL_KEYS[baseKey]
  if (known) {
    return {
      modifiers,
      def: {
        key: known.key,
        code: rawCode || known.code,
        keyCode: known.keyCode,
        ...(rawText !== undefined
          ? { text: rawText }
          : known.text !== undefined
            ? { text: known.text }
            : {}),
      },
    }
  }
  if (baseKey.length === 1) {
    const ch = baseKey
    const upper = ch.toUpperCase()
    const punct = PUNCTUATION_KEYS[ch]
    if (punct) {
      return {
        modifiers,
        def: {
          key: ch,
          code: rawCode || punct.code,
          keyCode: punct.keyCode,
          text: rawText ?? ch,
        },
      }
    }
    const code =
      rawCode ||
      (/^[A-Z]$/.test(upper) ? `Key${upper}` : /^[0-9]$/.test(ch) ? `Digit${ch}` : '')
    const keyCode = /^[A-Z0-9]$/.test(upper) ? upper.charCodeAt(0) : 0
    return {
      modifiers,
      def: {
        key: ch,
        code,
        keyCode,
        text: rawText ?? ch,
      },
    }
  }
  return {
    modifiers,
    def: {
      key: baseKey,
      code: rawCode || baseKey,
      keyCode: 0,
      ...(rawText !== undefined ? { text: rawText } : {}),
    },
  }
}

export function writeHttpRejection(socket: Duplex, statusLine: string): void {
  try {
    socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
  } catch {}
}

export interface VerifiedLiveBrowserUpgrade {
  readonly agentId: string
  readonly sessionId?: string
  readonly expiresAt?: number
}

export function verifyLiveBrowserUpgrade(
  req: IncomingMessage,
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
  opts?: {
    checkHttpAuth?: (req: IncomingMessage) => boolean
    isCommercialMaster?: boolean
  },
): VerifiedLiveBrowserUpgrade {
  const trustIp = env.OPENCLAUDE_TRUST_BRIDGE_IP?.trim() ?? ''
  const rawAssertion = req.headers[LIVE_BROWSER_ASSERTION_HEADER]

  // Commercial container mode: trusted bridge IP or assertion header requires strict Ed25519 verification.
  if (trustIp || typeof rawAssertion === 'string') {
    if (trustIp) {
      if (!isIpv4Literal(trustIp)) {
        throw new LiveBrowserUpgradeAuthError(403, 'trusted bridge IP unavailable')
      }
      const remote = req.socket.remoteAddress ?? ''
      if (remote !== trustIp && remote !== `::ffff:${trustIp}`) {
        throw new LiveBrowserUpgradeAuthError(403, 'wrong bridge source')
      }
    }
    if (typeof rawAssertion !== 'string') {
      throw new LiveBrowserUpgradeAuthError(403, 'missing assertion')
    }
    let payload: ReturnType<typeof verifyLiveBrowserAssertion>
    try {
      const keyring = parseAuthorityKeyring(env.OC_MODEL_AUTHORITY_KEYRING)
      payload = verifyLiveBrowserAssertion(rawAssertion, keyring, now)
    } catch (err) {
      throw new LiveBrowserUpgradeAuthError(
        403,
        err instanceof Error ? err.message : 'assertion verification failed',
      )
    }
    const uid = parsePositiveSafeInteger(env.OC_USER_ID)
    const containerId = parsePositiveSafeInteger(env.OC_CONTAINER_ID)
    if (uid === null || containerId === null) {
      throw new LiveBrowserUpgradeAuthError(403, 'container identity unavailable')
    }
    if (payload.uid !== uid || payload.containerId !== containerId) {
      throw new LiveBrowserUpgradeAuthError(403, 'assertion identity mismatch')
    }
    return {
      agentId: payload.agentId,
      sessionId: payload.sessionId,
      expiresAt: payload.expiresAt,
    }
  }

  // R2 #2: commercial master NEVER falls back to standalone live-browser auth.
  if (opts?.isCommercialMaster) {
    throw new LiveBrowserUpgradeAuthError(
      403,
      'standalone live browser upgrade disabled in commercial master mode',
    )
  }

  // Standalone mode (P1 #2 + R2 #1): NEVER bypass auth solely because of 127.0.0.1.
  // Require exact full-origin match (scheme + hostname + port) + real Gateway auth check.
  const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : ''
  if (rawOrigin && !isAllowedStandaloneOrigin(rawOrigin, req)) {
    throw new LiveBrowserUpgradeAuthError(403, 'origin rejected')
  }

  let authenticated = false
  if (opts?.checkHttpAuth) {
    authenticated = opts.checkHttpAuth(req) === true
  } else {
    const expectedToken = env.OPENCLAUDE_GATEWAY_TOKEN?.trim()
    if (expectedToken) {
      const auth =
        typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : ''
      const queryToken = parseQueryParam(req.url, 'token')?.trim() ?? ''
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
      authenticated = bearer === expectedToken || queryToken === expectedToken
    }
  }
  if (!authenticated) {
    throw new LiveBrowserUpgradeAuthError(401, 'unauthorized')
  }

  const agentId = (parseQueryParam(req.url, 'agentId') ?? 'main').trim()
  if (!AGENT_ID_RE.test(agentId)) {
    throw new LiveBrowserUpgradeAuthError(403, 'invalid agentId')
  }
  return { agentId }
}
