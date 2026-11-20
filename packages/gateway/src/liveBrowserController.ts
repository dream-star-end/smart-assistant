/**
 * Container-local live cloud browser controller for Workbench live view & human takeover (OCV5-813).
 *
 * Bridges the authenticated Workbench HTTP API (`GET /api/agents/:id/browser/live`,
 * `POST /api/agents/:id/browser/action`) to the container's pinned `oc-browser` CLI
 * (per-agent isolated Playwright CLI daemon with flock serialization).
 *
 * Security & resource invariants:
 * - Zero shell interpolation: invokes `/usr/local/bin/oc-browser` strictly via `execFile`.
 * - URL protocol allowlist: only `http:` and `https:` are permitted (blocks `file:`, `javascript:`,
 *   `data:`, `chrome:`, etc.).
 * - Strict key/action allowlist and bounded coordinates/text length.
 * - Per-agent serialized execution queue (bounded depth) + in-flight frame-read coalescing so
 *   rapid UI polling never starves interactive takeover commands or overwhelms Chromium.
 * - Zero cold-launch on passive polling: checks the oc-browser activity marker first and returns
 *   `{ available: true, active: false }` in O(1) when no browser daemon is running.
 * - Frame size cap (~1.2 MiB base64 ceiling with automatic JPEG quality step-down) to stay well
 *   under commercial `containerApiProxy`'s 2 MiB response body limit.
 */
import { createHash } from 'node:crypto'
import { execFile as execFileCb } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

export const LIVE_BROWSER_AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/
export const LIVE_BROWSER_MAX_URL_CHARS = 2048
export const LIVE_BROWSER_MAX_TYPE_CHARS = 2000
export const LIVE_BROWSER_MAX_BODY_BYTES = 32 * 1024
export const LIVE_BROWSER_MAX_QUEUE_DEPTH = 6
export const LIVE_BROWSER_MAX_IMAGE_BYTES = 900 * 1024 // ~1.2 MiB base64
const READ_TIMEOUT_MS = 12_000
const ACTION_TIMEOUT_MS = 20_000
const EXEC_MAX_BUFFER = 4 * 1024 * 1024

const DEFAULT_OC_BROWSER_BIN = '/usr/local/bin/oc-browser'
const STATE_ROOT = '/tmp/openclaude-playwright-cli'

export const ALLOWED_PRESS_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  'Backspace',
  'Delete',
  'Tab',
  'Shift+Tab',
  'Escape',
  'Space',
  ' ',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Control+a',
  'Meta+a',
  'Control+c',
  'Meta+c',
  'Control+v',
  'Meta+v',
  'Control+x',
  'Meta+x',
  'Control+z',
  'Meta+z',
])

// Match only Playwright / CLI browser-session-absent errors, NEVER webpage network errors
// such as `net::ERR_CONNECTION_CLOSED` or `ERR_HTTP2_PROTOCOL_ERROR`.
const SESSION_CLOSED_RE =
  /browser is not open|not open\b|no browser\b|session.*not found|browser has been closed|target page, context or browser has been closed|context or browser has been closed|browser disconnected|no active session/i

export interface LiveBrowserTabInfo {
  index: number
  title: string
  url: string
  active: boolean
}

export interface LiveBrowserState {
  available: boolean
  active: boolean
  agentBusy?: boolean
  url?: string
  title?: string
  viewport?: { width: number; height: number }
  tabs?: LiveBrowserTabInfo[]
  imageBase64?: string
  mimeType?: 'image/jpeg'
  capturedAt?: number
  reason?: string
}

export type LiveBrowserAction =
  | { action: 'open'; url?: string }
  | { action: 'goto'; url: string }
  | { action: 'click'; x: number; y: number; normalized?: boolean; button?: 'left' | 'right' }
  | { action: 'dblclick'; x: number; y: number; normalized?: boolean; button?: 'left' | 'right' }
  | { action: 'wheel'; x?: number; y?: number; normalized?: boolean; deltaX?: number; deltaY: number }
  | { action: 'type'; text: string; submit?: boolean }
  | { action: 'press'; key: string }
  | { action: 'back' }
  | { action: 'forward' }
  | { action: 'reload' }
  | { action: 'tab_select'; index: number }
  | { action: 'tab_new'; url?: string }
  | { action: 'tab_close'; index?: number }
  | { action: 'close' }

export class LiveBrowserError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'LiveBrowserError'
    this.status = status
    this.code = code
  }
}

export interface LiveBrowserExecResult {
  stdout: string
  stderr: string
}

export type LiveBrowserExecFn = (
  bin: string,
  args: readonly string[],
  opts: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<LiveBrowserExecResult>

export interface LiveBrowserControllerDeps {
  ocBrowserBin?: string
  stateRoot?: string
  existsSync?: (p: string) => boolean
  execFn?: LiveBrowserExecFn
}

function defaultExecFn(
  bin: string,
  args: readonly string[],
  opts: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
): Promise<LiveBrowserExecResult> {
  return new Promise((resolve, reject) => {
    execFileCb(
      bin,
      [...args],
      {
        env: opts.env,
        timeout: opts.timeout,
        maxBuffer: opts.maxBuffer,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message || 'oc-browser failed').trim()
          reject(new Error(detail))
          return
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' })
      },
    )
  })
}

/**
 * Mirrors `/run/oc/platform/current/bin/oc-browser` agent_key derivation:
 *   agent_prefix = tr -c 'A-Za-z0-9._-' '_' | cut -c1-32
 *   agent_hash   = sha256(raw_agent_id).slice(0, 16)
 */
export function ocBrowserAgentKey(agentId: string): string {
  const prefix = agentId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 32) || 'agent'
  const hash = createHash('sha256').update(agentId, 'utf8').digest('hex').slice(0, 16)
  return `${prefix}-${hash}`
}

export function isValidLiveBrowserAgentId(agentId: string): boolean {
  return LIVE_BROWSER_AGENT_ID_RE.test(agentId)
}

export function validateLiveBrowserUrl(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new LiveBrowserError(400, 'INVALID_URL', '请输入有效的 http 或 https 网址')
  }
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > LIVE_BROWSER_MAX_URL_CHARS || /[\r\n\0]/.test(trimmed)) {
    throw new LiveBrowserError(400, 'INVALID_URL', '网址格式无效或长度超限')
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new LiveBrowserError(400, 'INVALID_URL', '无法解析该网址，请包含 http:// 或 https://')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new LiveBrowserError(400, 'UNSAFE_URL_PROTOCOL', `不支持 ${parsed.protocol} 协议，仅允许 http/https`)
  }
  return parsed.toString()
}

function finiteNumber(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new LiveBrowserError(400, 'INVALID_PARAM', `参数 ${field} 必须为有效数字`)
  }
  return v
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

export function validateLiveBrowserAction(raw: unknown): LiveBrowserAction {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LiveBrowserError(400, 'INVALID_BODY', '请求体必须为 JSON 对象')
  }
  const obj = raw as Record<string, unknown>
  const action = typeof obj.action === 'string' ? obj.action.trim() : ''
  switch (action) {
    case 'open':
      return {
        action: 'open',
        ...(obj.url !== undefined && obj.url !== '' ? { url: validateLiveBrowserUrl(obj.url) } : {}),
      }
    case 'goto':
      return { action: 'goto', url: validateLiveBrowserUrl(obj.url) }
    case 'click':
    case 'dblclick': {
      const normalized = obj.normalized === true
      const x = finiteNumber(obj.x, 'x')
      const y = finiteNumber(obj.y, 'y')
      if (normalized && (x < 0 || x > 1 || y < 0 || y > 1)) {
        throw new LiveBrowserError(400, 'INVALID_COORD', '归一化坐标需在 [0, 1] 范围内')
      }
      if (!normalized && (x < 0 || x > 8192 || y < 0 || y > 8192)) {
        throw new LiveBrowserError(400, 'INVALID_COORD', '点击坐标超出合理范围')
      }
      const button = obj.button === 'right' ? 'right' : 'left'
      return { action, x, y, normalized, button }
    }
    case 'wheel': {
      const normalized = obj.normalized === true
      const deltaY = clamp(finiteNumber(obj.deltaY, 'deltaY'), -4000, 4000)
      const deltaX = obj.deltaX === undefined ? 0 : clamp(finiteNumber(obj.deltaX, 'deltaX'), -4000, 4000)
      const x = obj.x === undefined ? undefined : finiteNumber(obj.x, 'x')
      const y = obj.y === undefined ? undefined : finiteNumber(obj.y, 'y')
      return { action: 'wheel', ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}), normalized, deltaX, deltaY }
    }
    case 'type': {
      if (typeof obj.text !== 'string' || obj.text.length === 0 || obj.text.length > LIVE_BROWSER_MAX_TYPE_CHARS) {
        throw new LiveBrowserError(400, 'INVALID_TEXT', `输入文本长度需在 1~${LIVE_BROWSER_MAX_TYPE_CHARS} 字符内`)
      }
      if (obj.text.includes('\0')) {
        throw new LiveBrowserError(400, 'INVALID_TEXT', '输入文本包含非法字符')
      }
      return { action: 'type', text: obj.text, submit: obj.submit === true }
    }
    case 'press': {
      if (typeof obj.key !== 'string' || !ALLOWED_PRESS_KEYS.has(obj.key)) {
        throw new LiveBrowserError(400, 'INVALID_KEY', '不支持该按键指令')
      }
      return { action: 'press', key: obj.key }
    }
    case 'back':
    case 'forward':
    case 'reload':
    case 'close':
      return { action }
    case 'tab_select': {
      const index = finiteNumber(obj.index, 'index')
      if (!Number.isInteger(index) || index < 0 || index > 50) {
        throw new LiveBrowserError(400, 'INVALID_TAB_INDEX', '标签页索引无效')
      }
      return { action: 'tab_select', index }
    }
    case 'tab_new':
      return {
        action: 'tab_new',
        ...(obj.url !== undefined && obj.url !== '' ? { url: validateLiveBrowserUrl(obj.url) } : {}),
      }
    case 'tab_close': {
      if (obj.index !== undefined) {
        const index = finiteNumber(obj.index, 'index')
        if (!Number.isInteger(index) || index < 0 || index > 50) {
          throw new LiveBrowserError(400, 'INVALID_TAB_INDEX', '标签页索引无效')
        }
        return { action: 'tab_close', index }
      }
      return { action: 'tab_close' }
    }
    default:
      throw new LiveBrowserError(400, 'UNSUPPORTED_ACTION', `不支持的浏览器操作: ${action || '(空)'}`)
  }
}

/**
 * Extract the JSON payload emitted by `playwright-cli run-code` under `### Result`.
 */
export function parsePlaywrightRunCodeResult(stdout: string): Record<string, unknown> | null {
  const marker = '### Result'
  const idx = stdout.indexOf(marker)
  if (idx < 0) return null
  const after = stdout.slice(idx + marker.length)
  const nextSection = after.indexOf('\n### ')
  const raw = (nextSection >= 0 ? after.slice(0, nextSection) : after).trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    // `run-code` may double-encode a JSON string if the function returned a string.
    if (typeof parsed === 'string') {
      const inner = JSON.parse(parsed)
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        return inner as Record<string, unknown>
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * Build a fixed, parameter-injected Playwright snippet for `oc-browser run-code`.
 * User inputs are strictly serialized through `JSON.stringify` as a single `PAYLOAD`
 * data object, never interpolated as executable JS code.
 */
export function buildPlaywrightRunCodeScript(
  payload: {
    mode: 'capture' | 'action'
    includeFrame: boolean
    quality: number
    maxBytes: number
    op?: LiveBrowserAction
  },
): string {
  const serialized = JSON.stringify(payload)
  return `async (page) => {
  const P = ${serialized};
  const ctx = page.context();
  const resolveTarget = (p) => {
    const pages = ctx.pages().filter((pg) => !pg.isClosed());
    return pages.includes(p) ? p : (pages[pages.length - 1] || p);
  };
  let activePage = resolveTarget(page);
  if (P.mode === 'action' && P.op) {
    const op = P.op;
    const vp = activePage.viewportSize() || { width: 1280, height: 720 };
    const toPx = (x, y, norm) => ({
      px: Math.max(1, Math.min(vp.width - 1, Math.round(norm ? x * vp.width : x))),
      py: Math.max(1, Math.min(vp.height - 1, Math.round(norm ? y * vp.height : y))),
    });
    if (op.action === 'goto') {
      await activePage.goto(op.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } else if (op.action === 'back') {
      await activePage.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
    } else if (op.action === 'forward') {
      await activePage.goForward({ waitUntil: 'domcontentloaded', timeout: 10000 });
    } else if (op.action === 'reload') {
      await activePage.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    } else if (op.action === 'click' || op.action === 'dblclick') {
      const { px, py } = toPx(op.x, op.y, !!op.normalized);
      const clickOpts = { button: op.button === 'right' ? 'right' : 'left' };
      if (op.action === 'dblclick') await activePage.mouse.dblclick(px, py, clickOpts);
      else await activePage.mouse.click(px, py, clickOpts);
      await activePage.waitForTimeout(140);
    } else if (op.action === 'wheel') {
      if (typeof op.x === 'number' && typeof op.y === 'number') {
        const { px, py } = toPx(op.x, op.y, !!op.normalized);
        await activePage.mouse.move(px, py);
      }
      await activePage.mouse.wheel(op.deltaX || 0, op.deltaY || 0);
      await activePage.waitForTimeout(120);
    } else if (op.action === 'type') {
      await activePage.keyboard.insertText(op.text);
      if (op.submit) await activePage.keyboard.press('Enter');
      await activePage.waitForTimeout(140);
    } else if (op.action === 'press') {
      await activePage.keyboard.press(op.key);
      await activePage.waitForTimeout(120);
    }
  }
  activePage = resolveTarget(activePage);
  const pages = ctx.pages().filter((pg) => !pg.isClosed());
  const tabs = [];
  for (let i = 0; i < Math.min(pages.length, 16); i += 1) {
    const pg = pages[i];
    let t = '';
    try { t = await pg.title(); } catch {}
    tabs.push({ index: i, title: String(t || '').slice(0, 120), url: String(pg.url() || '').slice(0, 512), active: pg === activePage });
  }
  const viewport = activePage.viewportSize() || { width: 1280, height: 720 };
  let title = '';
  try { title = await activePage.title(); } catch {}
  let imageBase64 = undefined;
  if (P.includeFrame) {
    let buf = await activePage.screenshot({ type: 'jpeg', quality: P.quality });
    if (buf.length > P.maxBytes && P.quality > 45) {
      buf = await activePage.screenshot({ type: 'jpeg', quality: 42 });
    }
    if (buf.length <= P.maxBytes) {
      imageBase64 = buf.toString('base64');
    }
  }
  return {
    url: String(activePage.url() || '').slice(0, 2048),
    title: String(title || '').slice(0, 240),
    viewport,
    tabs,
    imageBase64,
    capturedAt: Date.now(),
  };
}`
}

interface AgentQueueState {
  tail: Promise<void>
  pending: number
  inFlightRead: Promise<LiveBrowserState> | null
}

export class LiveBrowserController {
  private readonly bin: string
  private readonly stateRoot: string
  private readonly checkExists: (p: string) => boolean
  private readonly execFn: LiveBrowserExecFn
  private readonly queues = new Map<string, AgentQueueState>()

  constructor(deps: LiveBrowserControllerDeps = {}) {
    this.bin = deps.ocBrowserBin ?? DEFAULT_OC_BROWSER_BIN
    this.stateRoot = deps.stateRoot ?? STATE_ROOT
    this.checkExists = deps.existsSync ?? existsSync
    this.execFn = deps.execFn ?? defaultExecFn
  }

  isAvailable(): boolean {
    return this.checkExists(this.bin)
  }

  private isSessionActive(agentId: string): boolean {
    const key = ocBrowserAgentKey(agentId)
    return this.checkExists(join(this.stateRoot, key, 'activity'))
  }

  private envFor(agentId: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      OPENCLAUDE_AGENT_ID: agentId,
      OC_AGENT_ID: agentId,
    }
  }

  private getQueue(agentId: string): AgentQueueState {
    let q = this.queues.get(agentId)
    if (!q) {
      q = { tail: Promise.resolve(), pending: 0, inFlightRead: null }
      this.queues.set(agentId, q)
    }
    return q
  }

  private enqueue<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    const q = this.getQueue(agentId)
    if (q.pending >= LIVE_BROWSER_MAX_QUEUE_DEPTH) {
      return Promise.reject(new LiveBrowserError(429, 'BROWSER_BUSY', '浏览器操作过于频繁，请稍候再试'))
    }
    q.pending += 1
    const run = q.tail.then(task, task)
    q.tail = run.then(
      () => {
        q.pending = Math.max(0, q.pending - 1)
        if (q.pending === 0 && !q.inFlightRead && this.queues.get(agentId) === q) {
          this.queues.delete(agentId)
        }
      },
      () => {
        q.pending = Math.max(0, q.pending - 1)
        if (q.pending === 0 && !q.inFlightRead && this.queues.get(agentId) === q) {
          this.queues.delete(agentId)
        }
      },
    )
    return run
  }

  private toState(parsed: Record<string, unknown> | null): LiveBrowserState {
    if (!parsed) {
      return { available: true, active: false, reason: 'snapshot_unavailable' }
    }
    const vpRaw = parsed.viewport && typeof parsed.viewport === 'object' ? (parsed.viewport as Record<string, unknown>) : null
    const viewport =
      vpRaw && typeof vpRaw.width === 'number' && typeof vpRaw.height === 'number'
        ? { width: vpRaw.width, height: vpRaw.height }
        : { width: 1280, height: 720 }
    const tabsRaw = Array.isArray(parsed.tabs) ? parsed.tabs : []
    const tabs: LiveBrowserTabInfo[] = tabsRaw
      .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === 'object'))
      .map((t, idx) => ({
        index: typeof t.index === 'number' ? t.index : idx,
        title: typeof t.title === 'string' ? t.title : '',
        url: typeof t.url === 'string' ? t.url : '',
        active: t.active === true,
      }))
    const imageBase64 = typeof parsed.imageBase64 === 'string' && parsed.imageBase64.length > 0 ? parsed.imageBase64 : undefined
    return {
      available: true,
      active: true,
      url: typeof parsed.url === 'string' ? parsed.url : '',
      title: typeof parsed.title === 'string' ? parsed.title : '',
      viewport,
      tabs,
      ...(imageBase64 ? { imageBase64, mimeType: 'image/jpeg' as const } : {}),
      capturedAt: typeof parsed.capturedAt === 'number' ? parsed.capturedAt : Date.now(),
    }
  }

  async getLiveState(agentId: string, opts?: { includeFrame?: boolean; quality?: number }): Promise<LiveBrowserState> {
    if (!isValidLiveBrowserAgentId(agentId)) {
      throw new LiveBrowserError(400, 'INVALID_AGENT_ID', '无效的智能体标识')
    }
    if (!this.isAvailable()) {
      return { available: false, active: false, reason: 'unavailable' }
    }
    if (!this.isSessionActive(agentId)) {
      return { available: true, active: false }
    }

    const includeFrame = opts?.includeFrame !== false
    const quality = clamp(Math.round(opts?.quality ?? 70), 35, 90)
    const q = this.getQueue(agentId)

    // Coalesce concurrent polling reads so multiple tabs/renders share a single screenshot capture.
    if (includeFrame && q.inFlightRead) {
      return q.inFlightRead
    }

    const promise = this.enqueue(agentId, async (): Promise<LiveBrowserState> => {
      if (!this.isSessionActive(agentId)) {
        return { available: true, active: false }
      }
      const script = buildPlaywrightRunCodeScript({
        mode: 'capture',
        includeFrame,
        quality,
        maxBytes: LIVE_BROWSER_MAX_IMAGE_BYTES,
      })
      try {
        const res = await this.execFn(this.bin, ['run-code', script], {
          env: this.envFor(agentId),
          timeout: READ_TIMEOUT_MS,
          maxBuffer: EXEC_MAX_BUFFER,
        })
        return this.toState(parsePlaywrightRunCodeResult(res.stdout))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (SESSION_CLOSED_RE.test(msg)) {
          return { available: true, active: false }
        }
        throw new LiveBrowserError(502, 'BROWSER_CAPTURE_FAILED', msg.slice(0, 240))
      }
    })

    if (includeFrame) {
      q.inFlightRead = promise
      const cleanupRead = () => {
        if (q.inFlightRead === promise) {
          q.inFlightRead = null
          if (q.pending === 0 && this.queues.get(agentId) === q) {
            this.queues.delete(agentId)
          }
        }
      }
      // Attach both fulfillment and rejection handlers so no derived rejected promise is left unhandled.
      promise.then(cleanupRead, cleanupRead)
    }
    return promise
  }

  private async captureCurrentFrame(env: NodeJS.ProcessEnv): Promise<LiveBrowserState> {
    const captureScript = buildPlaywrightRunCodeScript({
      mode: 'capture',
      includeFrame: true,
      quality: 70,
      maxBytes: LIVE_BROWSER_MAX_IMAGE_BYTES,
    })
    const res = await this.execFn(this.bin, ['run-code', captureScript], {
      env,
      timeout: ACTION_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
    })
    return this.toState(parsePlaywrightRunCodeResult(res.stdout))
  }

  private async openAndCapture(env: NodeJS.ProcessEnv, targetUrl: string): Promise<LiveBrowserState> {
    await this.execFn(this.bin, ['open', targetUrl], {
      env,
      timeout: ACTION_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
    })
    return this.captureCurrentFrame(env)
  }

  async performAction(agentId: string, rawAction: unknown): Promise<LiveBrowserState> {
    if (!isValidLiveBrowserAgentId(agentId)) {
      throw new LiveBrowserError(400, 'INVALID_AGENT_ID', '无效的智能体标识')
    }
    const action = validateLiveBrowserAction(rawAction)
    if (!this.isAvailable()) {
      throw new LiveBrowserError(503, 'BROWSER_UNAVAILABLE', '当前环境未启用云端浏览器')
    }

    // Invalidate any pre-action coalesced read so subsequent polls wait for the post-action frame.
    const existingQueue = this.queues.get(agentId)
    if (existingQueue) existingQueue.inFlightRead = null

    return this.enqueue(agentId, async (): Promise<LiveBrowserState> => {
      const env = this.envFor(agentId)
      if (action.action === 'close') {
        if (!this.isSessionActive(agentId)) {
          return { available: true, active: false }
        }
        try {
          await this.execFn(this.bin, ['close'], { env, timeout: ACTION_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER })
          return { available: true, active: false }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (SESSION_CLOSED_RE.test(msg)) {
            return { available: true, active: false }
          }
          throw new LiveBrowserError(502, 'BROWSER_CLOSE_FAILED', msg.slice(0, 240))
        }
      }

      if (action.action === 'open') {
        const targetUrl = action.url ?? 'https://scholar.google.com'
        try {
          if (!this.isSessionActive(agentId)) {
            return await this.openAndCapture(env, targetUrl)
          }
          try {
            if (action.url) {
              await this.execFn(this.bin, ['goto', targetUrl], {
                env,
                timeout: ACTION_TIMEOUT_MS,
                maxBuffer: EXEC_MAX_BUFFER,
              })
            }
            return await this.captureCurrentFrame(env)
          } catch (innerErr) {
            // Activity marker is only a hint: if the daemon died leaving a stale marker, cold-start once.
            const innerMsg = innerErr instanceof Error ? innerErr.message : String(innerErr)
            if (SESSION_CLOSED_RE.test(innerMsg)) {
              return await this.openAndCapture(env, targetUrl)
            }
            throw innerErr
          }
        } catch (err) {
          if (err instanceof LiveBrowserError) throw err
          const msg = err instanceof Error ? err.message : String(err)
          throw new LiveBrowserError(502, 'BROWSER_ACTION_FAILED', msg.slice(0, 240))
        }
      }

      if (!this.isSessionActive(agentId)) {
        if (action.action === 'goto') {
          try {
            return await this.openAndCapture(env, action.url)
          } catch (err) {
            if (err instanceof LiveBrowserError) throw err
            const msg = err instanceof Error ? err.message : String(err)
            throw new LiveBrowserError(502, 'BROWSER_ACTION_FAILED', msg.slice(0, 240))
          }
        }
        throw new LiveBrowserError(409, 'BROWSER_NOT_ACTIVE', '云端浏览器尚未启动，请先打开网页')
      }

      // Tab operations MUST use native playwright-cli commands so the CLI's active tab pointer stays in sync.
      if (action.action === 'tab_select' || action.action === 'tab_new' || action.action === 'tab_close') {
        const cliArgs: string[] =
          action.action === 'tab_select'
            ? ['tab-select', String(action.index)]
            : action.action === 'tab_new'
              ? action.url
                ? ['tab-new', action.url]
                : ['tab-new']
              : typeof action.index === 'number'
                ? ['tab-close', String(action.index)]
                : ['tab-close']
        try {
          await this.execFn(this.bin, cliArgs, { env, timeout: ACTION_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER })
          return await this.captureCurrentFrame(env)
        } catch (err) {
          if (err instanceof LiveBrowserError) throw err
          const msg = err instanceof Error ? err.message : String(err)
          if (SESSION_CLOSED_RE.test(msg)) {
            return { available: true, active: false }
          }
          throw new LiveBrowserError(502, 'BROWSER_ACTION_FAILED', msg.slice(0, 240))
        }
      }

      const script = buildPlaywrightRunCodeScript({
        mode: 'action',
        includeFrame: true,
        quality: 70,
        maxBytes: LIVE_BROWSER_MAX_IMAGE_BYTES,
        op: action,
      })
      try {
        const res = await this.execFn(this.bin, ['run-code', script], {
          env,
          timeout: ACTION_TIMEOUT_MS,
          maxBuffer: EXEC_MAX_BUFFER,
        })
        return this.toState(parsePlaywrightRunCodeResult(res.stdout))
      } catch (err) {
        if (err instanceof LiveBrowserError) throw err
        const msg = err instanceof Error ? err.message : String(err)
        if (SESSION_CLOSED_RE.test(msg)) {
          // If goto hit a stale activity marker where daemon had already exited, cold-start once.
          if (action.action === 'goto') {
            try {
              return await this.openAndCapture(env, action.url)
            } catch (openErr) {
              const openMsg = openErr instanceof Error ? openErr.message : String(openErr)
              throw new LiveBrowserError(502, 'BROWSER_ACTION_FAILED', openMsg.slice(0, 240))
            }
          }
          return { available: true, active: false }
        }
        throw new LiveBrowserError(502, 'BROWSER_ACTION_FAILED', msg.slice(0, 240))
      }
    })
  }
}

export interface LiveBrowserHttpHost {
  controller: LiveBrowserController
  hasAgent: (agentId: string) => Promise<boolean>
  isAgentRunning?: (agentId: string) => boolean
  readBody?: (req: IncomingMessage, maxBytes: number) => Promise<string>
  sendJson: (res: ServerResponse, code: number, body: unknown) => void
  sendError: (res: ServerResponse, code: number, message: string) => void
}

const LIVE_BROWSER_ACTION_MAX_BODY_BYTES = 32 * 1024

/**
 * Read request body up to `maxBytes` WITHOUT destroying the underlying request socket on overflow,
 * ensuring the server can cleanly deliver an HTTP 413 JSON response.
 */
export function readBodyWithinLimit(req: IncomingMessage, maxBytes: number): Promise<string> {
  const rawCl = req.headers?.['content-length']
  const cl = typeof rawCl === 'string' ? Number.parseInt(rawCl, 10) : Number.NaN
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let exceeded = Number.isFinite(cl) && cl > maxBytes
    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      if (size > maxBytes) {
        exceeded = true
        chunks.length = 0
        return
      }
      if (!exceeded) chunks.push(buf)
    })
    req.on('end', () => {
      if (exceeded) {
        reject(new Error('body too large'))
        return
      }
      resolve(chunks.length === 0 ? '' : Buffer.concat(chunks, size).toString('utf8'))
    })
    req.on('error', reject)
  })
}

export async function handleLiveBrowserLiveHttp(
  host: LiveBrowserHttpHost,
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  url: URL,
): Promise<void> {
  if (req.method !== 'GET') {
    host.sendError(res, 405, 'method not allowed')
    return
  }
  if (!(await host.hasAgent(agentId))) {
    host.sendJson(res, 404, { error: '智能体不存在', code: 'AGENT_NOT_FOUND' })
    return
  }
  const includeFrame = url.searchParams.get('frame') !== '0'
  const rawQuality = url.searchParams.get('quality')
  const parsedQuality = rawQuality !== null ? Number(rawQuality) : undefined
  const quality = parsedQuality !== undefined && Number.isFinite(parsedQuality) ? parsedQuality : undefined
  try {
    const state = await host.controller.getLiveState(agentId, { includeFrame, quality })
    const agentBusy = Boolean(host.isAgentRunning?.(agentId))
    res.setHeader('Cache-Control', 'no-store')
    host.sendJson(res, 200, { ...state, agentBusy })
  } catch (err) {
    if (err instanceof LiveBrowserError) {
      host.sendJson(res, err.status, { error: err.message, code: err.code })
      return
    }
    throw err
  }
}

export async function handleLiveBrowserActionHttp(
  host: LiveBrowserHttpHost,
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
): Promise<void> {
  if (req.method !== 'POST') {
    host.sendError(res, 405, 'method not allowed')
    return
  }
  if (!(await host.hasAgent(agentId))) {
    host.sendJson(res, 404, { error: '智能体不存在', code: 'AGENT_NOT_FOUND' })
    return
  }
  if (host.isAgentRunning?.(agentId)) {
    host.sendJson(res, 409, {
      error: '助手正在执行任务，请等待本轮完成或停止后再操作云端浏览器',
      code: 'AGENT_RUNNING',
    })
    return
  }
  let rawBody: string
  try {
    const reader = host.readBody ?? readBodyWithinLimit
    rawBody = await reader(req, LIVE_BROWSER_ACTION_MAX_BODY_BYTES)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('too large')) {
      host.sendJson(res, 413, { error: '请求体过大', code: 'BODY_TOO_LARGE' })
      return
    }
    host.sendJson(res, 400, { error: '无法读取请求体', code: 'INVALID_BODY' })
    return
  }
  let parsed: unknown
  try {
    parsed = rawBody.trim() ? JSON.parse(rawBody) : {}
  } catch {
    host.sendJson(res, 400, { error: '请求体不是有效的 JSON', code: 'INVALID_JSON' })
    return
  }
  try {
    const state = await host.controller.performAction(agentId, parsed)
    res.setHeader('Cache-Control', 'no-store')
    host.sendJson(res, 200, state)
  } catch (err) {
    if (err instanceof LiveBrowserError) {
      host.sendJson(res, err.status, { error: err.message, code: err.code })
      return
    }
    throw err
  }
}
