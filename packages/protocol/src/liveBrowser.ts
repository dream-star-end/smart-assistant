/**
 * Live cloud browser real-time streaming & interactive takeover protocol (OCV5-857).
 *
 * Intentionally 100% browser-safe (zero `node:*` imports): shared by commercial master,
 * in-container gateway and web-react. Cryptographic bridge assertions live in
 * `containerPreviewAuth.ts`.
 */

export const LIVE_BROWSER_PROTOCOL_VERSION = 1 as const
export const LIVE_BROWSER_PUBLIC_WS_PATH = '/ws/live-browser'
export const LIVE_BROWSER_INTERNAL_WS_PATH = '/ws/live-browser'
export const LIVE_BROWSER_TICKET_PROTOCOL = 'live-browser-v1'
export const LIVE_BROWSER_ASSERTION_HEADER = 'x-openclaude-live-browser-assertion'

export const LIVE_BROWSER_BINARY_MAGIC = 'OCLB'
export const LIVE_BROWSER_BINARY_HEADER_BYTES = 20
export const LIVE_BROWSER_MAX_BINARY_FRAME_BYTES = 8 * 1024 * 1024

export const LIVE_BROWSER_FRAME_FORMAT_JPEG = 1 as const
export const LIVE_BROWSER_FRAME_FORMAT_PNG = 2 as const
export const LIVE_BROWSER_FRAME_FLAG_SETTLED = 1 as const

export type LiveBrowserFrameFormat = 'jpeg' | 'png'

export interface LiveBrowserFrameInput {
  readonly seq: number
  readonly width: number
  readonly height: number
  readonly format: LiveBrowserFrameFormat
  readonly settled?: boolean
  readonly navGen?: number
  readonly payload: Uint8Array
}

export interface LiveBrowserDecodedFrame {
  readonly version: typeof LIVE_BROWSER_PROTOCOL_VERSION
  readonly seq: number
  readonly width: number
  readonly height: number
  readonly format: LiveBrowserFrameFormat
  readonly settled: boolean
  readonly flags: number
  readonly navGen: number
  readonly payload: Uint8Array
}

function assertUint(value: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`invalid live browser frame ${label}: ${String(value)}`)
  }
}

/**
 * Encode a live browser binary frame with a fixed 20-byte big-endian header:
 * - [0..3]  'OCLB' magic
 * - [4..7]  u32 version (1)
 * - [8..11] u32 seq
 * - [12..13] u16 width
 * - [14..15] u16 height
 * - [16]    u8 format (1=jpeg, 2=png)
 * - [17]    u8 flags (bit0=settled)
 * - [18..19] u16 navGen (navigation generation mod 65536; defaults to 0)
 * - [20..]  encoded image payload
 */
export function encodeLiveBrowserFrame(input: LiveBrowserFrameInput): Uint8Array {
  assertUint(input.seq, 0xffff_ffff, 'seq')
  assertUint(input.width, 0xffff, 'width')
  assertUint(input.height, 0xffff, 'height')
  const rawNavGen = input.navGen ?? 0
  if (!Number.isInteger(rawNavGen) || rawNavGen < 0) {
    throw new Error(`invalid live browser frame navGen: ${String(rawNavGen)}`)
  }
  const navGen = rawNavGen & 0xffff
  if (input.format !== 'jpeg' && input.format !== 'png') {
    throw new Error(`unsupported live browser frame format: ${String(input.format)}`)
  }
  if (!(input.payload instanceof Uint8Array) || input.payload.byteLength < 1) {
    throw new Error('empty live browser frame payload')
  }
  const totalBytes = LIVE_BROWSER_BINARY_HEADER_BYTES + input.payload.byteLength
  if (totalBytes > LIVE_BROWSER_MAX_BINARY_FRAME_BYTES) {
    throw new Error(`live browser frame exceeds max size (${totalBytes} > ${LIVE_BROWSER_MAX_BINARY_FRAME_BYTES})`)
  }

  const output = new Uint8Array(totalBytes)
  output[0] = 0x4f // 'O'
  output[1] = 0x43 // 'C'
  output[2] = 0x4c // 'L'
  output[3] = 0x42 // 'B'
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength)
  view.setUint32(4, LIVE_BROWSER_PROTOCOL_VERSION, false)
  view.setUint32(8, input.seq, false)
  view.setUint16(12, input.width, false)
  view.setUint16(14, input.height, false)
  view.setUint8(
    16,
    input.format === 'jpeg' ? LIVE_BROWSER_FRAME_FORMAT_JPEG : LIVE_BROWSER_FRAME_FORMAT_PNG,
  )
  view.setUint8(17, input.settled ? LIVE_BROWSER_FRAME_FLAG_SETTLED : 0)
  view.setUint16(18, navGen, false)
  output.set(input.payload, LIVE_BROWSER_BINARY_HEADER_BYTES)
  return output
}

export function decodeLiveBrowserFrame(buf: Uint8Array | ArrayBufferLike): LiveBrowserDecodedFrame {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  if (bytes.byteLength <= LIVE_BROWSER_BINARY_HEADER_BYTES) {
    throw new Error('truncated live browser frame')
  }
  if (bytes.byteLength > LIVE_BROWSER_MAX_BINARY_FRAME_BYTES) {
    throw new Error('live browser frame exceeds maximum byte size')
  }
  if (bytes[0] !== 0x4f || bytes[1] !== 0x43 || bytes[2] !== 0x4c || bytes[3] !== 0x42) {
    throw new Error('bad live browser frame magic')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(4, false)
  if (version !== LIVE_BROWSER_PROTOCOL_VERSION) {
    throw new Error(`unsupported live browser frame version: ${version}`)
  }
  const seq = view.getUint32(8, false)
  const width = view.getUint16(12, false)
  const height = view.getUint16(14, false)
  const formatCode = view.getUint8(16)
  let format: LiveBrowserFrameFormat
  if (formatCode === LIVE_BROWSER_FRAME_FORMAT_JPEG) {
    format = 'jpeg'
  } else if (formatCode === LIVE_BROWSER_FRAME_FORMAT_PNG) {
    format = 'png'
  } else {
    throw new Error(`unsupported live browser frame format code: ${formatCode}`)
  }
  const flags = view.getUint8(17)
  const navGen = view.getUint16(18, false)
  return {
    version: LIVE_BROWSER_PROTOCOL_VERSION,
    seq,
    width,
    height,
    format,
    settled: (flags & LIVE_BROWSER_FRAME_FLAG_SETTLED) === LIVE_BROWSER_FRAME_FLAG_SETTLED,
    flags,
    navGen,
    payload: bytes.subarray(LIVE_BROWSER_BINARY_HEADER_BYTES),
  }
}

export interface LiveBrowserViewport {
  readonly width: number
  readonly height: number
  readonly deviceScaleFactor?: number
}

export interface LiveBrowserTab {
  readonly index: number
  readonly id?: string
  readonly title: string
  readonly url: string
  readonly active: boolean
}

export interface LiveBrowserDialogInfo {
  readonly type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  readonly message: string
  readonly defaultPrompt?: string
  readonly url?: string
}

export type LiveBrowserMouseButton = 'left' | 'middle' | 'right'

export interface LiveBrowserModifiers {
  readonly alt?: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly shift?: boolean
}

/** Convert structured modifiers (or an existing CDP bitmask) to CDP modifier bits. */
export function liveBrowserModifiersToBitmask(modifiers?: LiveBrowserModifiers | number): number {
  if (typeof modifiers === 'number') {
    return Number.isInteger(modifiers) ? modifiers & 0x0f : 0
  }
  if (!modifiers) return 0
  let bits = 0
  if (modifiers.alt) bits |= 1
  if (modifiers.ctrl) bits |= 2
  if (modifiers.meta) bits |= 4
  if (modifiers.shift) bits |= 8
  return bits
}

export interface LiveBrowserStreamTicketResponse {
  readonly ticket: string
  readonly expiresAt: number
  readonly agentId: string
  readonly wsPath: typeof LIVE_BROWSER_PUBLIC_WS_PATH
  readonly protocol: typeof LIVE_BROWSER_TICKET_PROTOCOL
}

export const BROWSER_HANDOFF_RESUME_MAX_PATTERNS = 12 as const
export const BROWSER_HANDOFF_RESUME_MAX_STR_LEN = 256 as const
export const BROWSER_HANDOFF_MIN_DELAY_MS = 500 as const
export const BROWSER_HANDOFF_MAX_DELAY_MS = 15_000 as const

/**
 * Optional deterministic completion criteria attached to a `browser_handoff` card or
 * sent over the live-browser control channel so the container gateway can detect
 * handoff completion with zero LLM calls (OCV5-864).
 */
export interface BrowserHandoffResumeWhen {
  readonly urlLeave?: readonly string[]
  readonly urlMatch?: readonly string[]
  readonly selectorAppear?: string
  readonly selectorGone?: string
  readonly waitDownload?: boolean
  readonly autoResumeDelayMs?: number
}

function normalizeResumePatternList(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || trimmed.includes('\0') || /[\r\n]/.test(trimmed)) continue
    out.push(trimmed.slice(0, BROWSER_HANDOFF_RESUME_MAX_STR_LEN))
    if (out.length >= BROWSER_HANDOFF_RESUME_MAX_PATTERNS) break
  }
  return out.length > 0 ? out : undefined
}

function normalizeResumeSelector(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed || trimmed.includes('\0') || /[\r\n]/.test(trimmed)) return undefined
  return trimmed.slice(0, BROWSER_HANDOFF_RESUME_MAX_STR_LEN)
}

/**
 * Sanitize and normalize a `resume_when` / `resumeWhen` object (accepts both camelCase and
 * snake_case fields for LLM card ergonomics). Returns `undefined` when absent or empty.
 */
export function normalizeBrowserHandoffResumeWhen(
  raw: unknown,
): BrowserHandoffResumeWhen | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const urlLeave = normalizeResumePatternList(obj.urlLeave ?? obj.url_leave)
  const urlMatch = normalizeResumePatternList(obj.urlMatch ?? obj.url_match)
  const selectorAppear = normalizeResumeSelector(obj.selectorAppear ?? obj.selector_appear)
  const selectorGone = normalizeResumeSelector(obj.selectorGone ?? obj.selector_gone)
  const rawWaitDownload = obj.waitDownload ?? obj.wait_download
  const waitDownload = typeof rawWaitDownload === 'boolean' ? rawWaitDownload : undefined
  const rawDelay = obj.autoResumeDelayMs ?? obj.auto_resume_delay_ms
  let autoResumeDelayMs: number | undefined
  if (typeof rawDelay === 'number' && Number.isFinite(rawDelay)) {
    autoResumeDelayMs = Math.max(
      BROWSER_HANDOFF_MIN_DELAY_MS,
      Math.min(BROWSER_HANDOFF_MAX_DELAY_MS, Math.round(rawDelay)),
    )
  }
  if (
    !urlLeave &&
    !urlMatch &&
    !selectorAppear &&
    !selectorGone &&
    waitDownload === undefined &&
    autoResumeDelayMs === undefined
  ) {
    return undefined
  }
  return {
    ...(urlLeave ? { urlLeave } : {}),
    ...(urlMatch ? { urlMatch } : {}),
    ...(selectorAppear ? { selectorAppear } : {}),
    ...(selectorGone ? { selectorGone } : {}),
    ...(waitDownload !== undefined ? { waitDownload } : {}),
    ...(autoResumeDelayMs !== undefined ? { autoResumeDelayMs } : {}),
  }
}

export type LiveBrowserClientMessage =
  | {
      readonly type: 'takeover'
      readonly active: boolean
      readonly takeoverToken?: string
      readonly resumeWhen?: BrowserHandoffResumeWhen
      readonly watchId?: string
    }
  | {
      readonly type: 'handoff_watch'
      readonly resumeWhen?: BrowserHandoffResumeWhen | null
      readonly watchId?: string
    }
  | {
      readonly type: 'pointer'
      readonly action: 'move' | 'down' | 'up' | 'click' | 'dblclick'
      readonly x: number
      readonly y: number
      readonly button?: LiveBrowserMouseButton
      readonly clickCount?: number
      readonly modifiers?: LiveBrowserModifiers | number
      readonly expectedOrigin?: string
      readonly expectedTargetId?: string
      readonly expectedNavGen?: number
      readonly takeoverToken?: string
    }
  | {
      readonly type: 'wheel'
      readonly x?: number
      readonly y?: number
      readonly deltaX: number
      readonly deltaY: number
      readonly modifiers?: LiveBrowserModifiers | number
      readonly expectedOrigin?: string
      readonly expectedTargetId?: string
      readonly expectedNavGen?: number
      readonly takeoverToken?: string
    }
  | {
      readonly type: 'key'
      readonly action: 'down' | 'up' | 'press'
      readonly key: string
      readonly code?: string
      readonly text?: string
      readonly modifiers?: LiveBrowserModifiers | number
      readonly expectedOrigin?: string
      readonly expectedTargetId?: string
      readonly expectedNavGen?: number
      readonly takeoverToken?: string
    }
  | {
      readonly type: 'insert_text'
      readonly text: string
      readonly expectedOrigin?: string
      readonly expectedTargetId?: string
      readonly expectedNavGen?: number
      readonly takeoverToken?: string
    }
  | {
      readonly type: 'navigate'
      readonly url: string
    }
  | {
      readonly type: 'history'
      readonly action: 'back' | 'forward' | 'reload' | 'stop'
    }
  | {
      readonly type: 'tab'
      readonly action: 'new' | 'select' | 'close'
      readonly index?: number
      readonly id?: string
      readonly targetId?: string
      readonly url?: string
    }
  | {
      readonly type: 'resize'
      readonly width: number
      readonly height: number
      readonly deviceScaleFactor?: number
    }
  | {
      readonly type: 'dialog'
      readonly accept: boolean
      readonly promptText?: string
    }
  | {
      readonly type: 'open'
      readonly url?: string
    }
  | {
      readonly type: 'close_browser'
    }
  | {
      readonly type: 'ping'
      readonly ts?: number
    }

export interface LiveBrowserStatePayload {
  readonly active: boolean
  readonly agentBusy: boolean
  readonly humanTakeover: boolean
  readonly url: string
  readonly title: string
  readonly loading: boolean
  readonly viewport?: LiveBrowserViewport
  readonly tabs: readonly LiveBrowserTab[]
  readonly dialog: LiveBrowserDialogInfo | null
  readonly capturedAt?: number
  readonly targetId?: string
  readonly navGen?: number
  readonly origin?: string
  readonly cdpAvailable?: boolean
  readonly takeoverToken?: string
}

export interface LiveBrowserHandoffReadyMessage {
  readonly type: 'handoff_ready'
  readonly signal: string
  readonly url: string
  readonly title?: string
  readonly filename?: string
  readonly watchId?: string
  readonly detectedAt: number
}

export interface LiveBrowserHandoffVetoedMessage {
  readonly type: 'handoff_vetoed'
  readonly reason: string
  readonly url?: string
  readonly watchId?: string
  readonly detectedAt: number
}

export type LiveBrowserServerMessage =
  | {
      readonly type: 'ready'
      readonly protocolVersion: typeof LIVE_BROWSER_PROTOCOL_VERSION
      readonly agentId: string
      readonly state: LiveBrowserStatePayload
    }
  | ({
      readonly type: 'state'
    } & LiveBrowserStatePayload)
  | {
      readonly type: 'cursor'
      readonly cursor: string
    }
  | LiveBrowserHandoffReadyMessage
  | LiveBrowserHandoffVetoedMessage
  | {
      readonly type: 'error'
      readonly code: string
      readonly message: string
      readonly retryable?: boolean
    }
  | {
      readonly type: 'pong'
      readonly ts?: number
      readonly serverTs: number
    }

export type LiveBrowserServerControlMessage = LiveBrowserServerMessage
