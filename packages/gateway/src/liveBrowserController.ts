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
import { execFile as execFileCb, spawn } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createConnection } from 'node:net'
import { basename, dirname, join } from 'node:path'

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

const DAEMON_SOCKET_DEAD_RE =
  /\b(?:ENOENT|ECONNREFUSED|ECONNRESET|EPIPE)\b|daemon socket closed/i

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
  mimeType?: 'image/jpeg' | 'image/png'
  capturedAt?: number
  reason?: string
}

export type LiveBrowserAction =
  | { action: 'open'; url?: string; ifIdle?: boolean }
  | { action: 'goto'; url: string }
  | { action: 'click'; x: number; y: number; normalized?: boolean; button?: 'left' | 'right'; expectedOrigin?: string }
  | { action: 'dblclick'; x: number; y: number; normalized?: boolean; button?: 'left' | 'right'; expectedOrigin?: string }
  | { action: 'wheel'; x?: number; y?: number; normalized?: boolean; deltaX?: number; deltaY: number; expectedOrigin?: string }
  | { action: 'type'; text: string; submit?: boolean; expectedOrigin?: string }
  | { action: 'press'; key: string; expectedOrigin?: string }
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

export interface PlaywrightDaemonEndpoint {
  socketPath: string
  version: string
  stateDir: string
}

export interface PlaywrightDaemonRpcResult {
  text: string
  isError?: boolean
}

export type PlaywrightDaemonRpcFn = (
  endpoint: PlaywrightDaemonEndpoint,
  args: Record<string, unknown>,
  opts: { cwd: string; timeoutMs: number },
) => Promise<PlaywrightDaemonRpcResult>

export type PlaywrightLockFn = <T>(stateDir: string, fn: () => Promise<T>) => Promise<T>

export interface LiveBrowserControllerDeps {
  ocBrowserBin?: string
  stateRoot?: string
  browserHome?: string
  existsSync?: (p: string) => boolean
  execFn?: LiveBrowserExecFn
  resolveDaemonEndpoint?: (stateDir: string) => PlaywrightDaemonEndpoint | null
  daemonRpcFn?: PlaywrightDaemonRpcFn
  withLock?: PlaywrightLockFn
  readFrameFile?: (filePath: string) => Buffer
  unlinkFrameFile?: (filePath: string) => void
}

const DAEMON_RPC_MAX_BYTES = 4 * 1024 * 1024
const FLOCK_BIN = '/usr/bin/flock'
const FLOCK_WAIT_SEC = '8'

/**
 * Acquire the exact same POSIX `flock` (`<stateDir>/activity.lock`) used by `oc-browser.sh`
 * and its idle reaper so multi-step daemon RPCs (mousemove/down/up/screenshot) never interleave
 * with external CLI invocations or idle reaping (~9ms acquire overhead).
 */
export async function withPlaywrightActivityLock<T>(
  stateDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!existsSync(FLOCK_BIN) || !existsSync(stateDir)) {
    return fn()
  }
  const lockFile = join(stateDir, 'activity.lock')
  const activityFile = join(stateDir, 'activity')
  const pendingFile = join(stateDir, `pending.${process.pid}`)
  // Mirror oc-browser.sh: record pending.<pid> & refresh activity BEFORE waiting on flock
  // so an idle reaper waking first sees a live waiting consumer and will not close the session.
  try {
    writeFileSync(pendingFile, '')
  } catch {}
  try {
    const now = new Date()
    utimesSync(activityFile, now, now)
  } catch {}

  const child = spawn(FLOCK_BIN, ['-w', FLOCK_WAIT_SEC, lockFile, '/bin/sh', '-c', 'printf 1; exec cat'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const done = (err?: Error) => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve()
      }
      child.stdout.once('data', () => done())
      child.once('error', (err) => done(err))
      child.once('exit', (code) => done(new Error(`activity lock busy (flock exit ${code ?? 'signal'})`)))
    })
    return await fn()
  } finally {
    try {
      unlinkSync(pendingFile)
    } catch {}
    try {
      child.stdin.end()
    } catch {}
    try {
      child.kill('SIGTERM')
    } catch {}
  }
}

const CLI_OWNER_PID_RE = /^(?:cli-active|pending)\.(\d+)$/
const BROWSER_CLI_CMDLINE_RE = /(?:^|\/|\0)(?:oc-browser(?:\.sh)?|playwright-cli)(?:\0|$|\s)/

/**
 * Returns true if an external `oc-browser` CLI process (PID !== selfPid) is currently
 * waiting on OR actively executing under the per-agent activity lock, verified via signal-0
 * liveness probe plus `/proc/<pid>/cmdline` identity verification on Linux (preventing
 * recycled PID false positives). Ignores stale marker files left behind by crashed processes.
 */
export function isExternalBrowserCliActive(
  stateDir: string,
  selfPid: number = process.pid,
  probePid: (pid: number) => boolean = defaultProbePid,
): boolean {
  let entries: string[]
  try {
    entries = readdirSync(stateDir)
  } catch {
    return false
  }
  for (const name of entries) {
    const m = CLI_OWNER_PID_RE.exec(name)
    if (!m) continue
    const pid = Number.parseInt(m[1], 10)
    if (!Number.isFinite(pid) || pid <= 0 || pid === selfPid) continue
    if (probePid(pid)) return true
  }
  return false
}

function defaultProbePid(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'EPERM') return false
  }
  // On Linux, verify process identity via /proc/<pid>/cmdline when readable so a recycled
  // PID belonging to an unrelated process cannot falsely hold the browser lock.
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    if (cmdline.length > 0 && !BROWSER_CLI_CMDLINE_RE.test(cmdline)) {
      return false
    }
  } catch {
    // Non-Linux or unreadable /proc (e.g. hidepid / EPERM): fall back to signal-0 liveness.
  }
  return true
}

/**
 * Discover the live per-agent playwright-cli Unix domain socket inside `stateDir`.
 * Strictly enforces:
 * - `stateDir` itself is a real non-symlink directory whose realpath equals `join(realRoot, basename(stateDir))`
 *   (strictly bound to this single agent, never another agent's directory);
 * - the socket path itself is NOT a symlink (`!lstat.isSymbolicLink()`) and IS a Unix socket (`lstat.isSocket()`);
 * - the socket's real parent directory stays strictly inside `realStateDir`.
 */
export function resolvePlaywrightDaemonEndpoint(
  stateDir: string,
  stateRoot?: string,
): PlaywrightDaemonEndpoint | null {
  if (!existsSync(stateDir)) return null
  let realStateDir: string
  try {
    const dirStat = lstatSync(stateDir)
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null
    realStateDir = realpathSync(stateDir)
    if (stateRoot && existsSync(stateRoot)) {
      const realRoot = realpathSync(stateRoot)
      const expectedDir = join(realRoot, basename(stateDir))
      if (realStateDir !== expectedDir) {
        return null
      }
    }
  } catch {
    return null
  }
  const isValidSocketInsideStateDir = (candidate: string): boolean => {
    try {
      const st = lstatSync(candidate)
      if (st.isSymbolicLink() || !st.isSocket()) return false
      const realDir = realpathSync(dirname(candidate))
      return realDir === realStateDir || realDir.startsWith(`${realStateDir}/`)
    } catch {
      return false
    }
  }

  // Prefer the structured daemon session file which carries both socketPath and protocol version.
  const daemonRoot = join(stateDir, 'cache', 'ms-playwright', 'daemon')
  try {
    if (existsSync(daemonRoot)) {
      for (const entry of readdirSync(daemonRoot)) {
        const sub = join(daemonRoot, entry)
        let files: string[]
        try {
          files = readdirSync(sub)
        } catch {
          continue
        }
        for (const f of files) {
          if (!f.endsWith('.session')) continue
          try {
            const raw = JSON.parse(readFileSync(join(sub, f), 'utf8')) as {
              socketPath?: unknown
              version?: unknown
            }
            if (
              typeof raw.socketPath === 'string' &&
              raw.socketPath.endsWith('.sock') &&
              isValidSocketInsideStateDir(raw.socketPath)
            ) {
              return {
                socketPath: raw.socketPath,
                version: typeof raw.version === 'string' && raw.version ? raw.version : '0.1.14',
                stateDir: realStateDir,
              }
            }
          } catch {
            // Skip malformed session file and try fallback socket scan.
          }
        }
      }
    }
  } catch {
    // Ignore scan errors and try sockets/cli fallback.
  }

  const cliSockDir = join(stateDir, 'sockets', 'cli')
  try {
    if (existsSync(cliSockDir)) {
      for (const f of readdirSync(cliSockDir)) {
        if (!f.endsWith('-browser.sock')) continue
        const sockPath = join(cliSockDir, f)
        if (isValidSocketInsideStateDir(sockPath)) {
          return { socketPath: sockPath, version: '0.1.14', stateDir: realStateDir }
        }
      }
    }
  } catch {
    // No socket available.
  }
  return null
}

/**
 * Direct newline-delimited JSON RPC over playwright-cli's local Unix socket.
 * Accumulates raw Buffers up to `DAEMON_RPC_MAX_BYTES`, decodes UTF-8 ONLY after a complete
 * newline frame arrives (preserving multi-byte characters split across TCP/Unix chunks),
 * and verifies response `id`.
 */
export function sendPlaywrightDaemonRpc(
  endpoint: PlaywrightDaemonEndpoint,
  args: Record<string, unknown>,
  opts: { cwd: string; timeoutMs: number; maxBytes?: number },
): Promise<PlaywrightDaemonRpcResult> {
  const maxBytes = opts.maxBytes ?? DAEMON_RPC_MAX_BYTES
  const reqId = 1
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint.socketPath)
    let settled = false
    const chunks: Buffer[] = []
    let totalBytes = 0
    const finish = (err: Error | null, res?: PlaywrightDaemonRpcResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (err) reject(err)
      else resolve(res ?? { text: '' })
    }
    const timer = setTimeout(() => {
      finish(new Error('playwright daemon rpc timed out'))
    }, opts.timeoutMs)

    socket.once('error', (err) => finish(err))
    socket.once('close', () => {
      if (!settled) finish(new Error('daemon socket closed'))
    })
    socket.once('connect', () => {
      const payload = JSON.stringify({
        id: reqId,
        method: 'run',
        params: { args, cwd: opts.cwd, version: endpoint.version },
      })
      socket.write(`${payload}\n`)
    })
    socket.on('data', (chunk: Buffer) => {
      if (settled) return
      let remaining = chunk
      while (remaining.length > 0 && !settled) {
        const nlIdx = remaining.indexOf(0x0a)
        const frameLen = nlIdx >= 0 ? totalBytes + nlIdx : totalBytes + remaining.length
        if (frameLen > maxBytes) {
          finish(new Error('playwright daemon response too large'))
          return
        }
        if (nlIdx < 0) {
          chunks.push(remaining)
          totalBytes += remaining.length
          return
        }
        if (nlIdx > 0) chunks.push(remaining.subarray(0, nlIdx))
        const line = Buffer.concat(chunks, frameLen).toString('utf8')
        chunks.length = 0
        totalBytes = 0
        remaining = remaining.subarray(nlIdx + 1)
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line) as {
            id?: unknown
            error?: unknown
            result?: { text?: unknown; isError?: unknown }
          }
          // Strictly pair on exact reqId; skip unsolicited notifications or mismatched frames
          // and keep scanning any sticky frames in the same buffer.
          if (msg.id !== reqId) {
            continue
          }
          if (msg.error) {
            finish(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)))
            return
          }
          const text = typeof msg.result?.text === 'string' ? msg.result.text : ''
          const isError = msg.result?.isError === true
          if (isError) {
            finish(new Error(text.slice(0, 400) || 'playwright daemon command failed'))
            return
          }
          finish(null, { text, isError: false })
          return
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)))
          return
        }
      }
    })
  })
}

const TAB_URL_SEP_RE = /\]\((?=(?:https?:|about:|chrome:|chrome-error:|file:|data:|blob:))/g

/**
 * Parse `playwright-cli tab-list` output lines: `- 0: (current) [Title](https://...)`.
 * Picks the rightmost `](<scheme>` separator whose RHS is a valid URL, handling BOTH
 * markdown links inside the page title AND `](` inside query parameters (`?q=a](b)`).
 */
export function parsePlaywrightTabList(text: string): LiveBrowserTabInfo[] {
  const tabs: LiveBrowserTabInfo[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    const prefix = line.match(/^-\s+(\d+):\s+(?:(\(current\))\s+)?\[/)
    if (!prefix || !line.endsWith(')')) continue
    const rest = line.slice(prefix[0].length, -1)
    let sep = -1
    TAB_URL_SEP_RE.lastIndex = 0
    for (let m = TAB_URL_SEP_RE.exec(rest); m !== null; m = TAB_URL_SEP_RE.exec(rest)) {
      const candidateUrl = rest.slice(m.index + 2)
      try {
        // Ensure candidateUrl starts with a real parseable URL (not a fragment like `b)`).
        // eslint-disable-next-line no-new
        new URL(candidateUrl)
        sep = m.index
      } catch {
        // Not a standalone URL — keep looking.
      }
    }
    if (sep < 0) sep = rest.lastIndexOf('](')
    if (sep < 0) continue
    const index = Number.parseInt(prefix[1], 10)
    if (!Number.isFinite(index)) continue
    tabs.push({
      index,
      active: Boolean(prefix[2]),
      title: rest.slice(0, sep).slice(0, 120),
      url: rest.slice(sep + 2).slice(0, 512),
    })
  }
  return tabs
}

function detectImageMime(buf: Buffer): 'image/png' | 'image/jpeg' {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png'
  }
  return 'image/jpeg'
}

/** Extract exact viewport pixel dimensions from a PNG IHDR chunk (0 extra RPCs). */
export function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[12] === 0x49 && // 'I'
    buf[13] === 0x48 && // 'H'
    buf[14] === 0x44 && // 'D'
    buf[15] === 0x52 // 'R'
  ) {
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    if (width >= 64 && width <= 8192 && height >= 64 && height <= 8192) {
      return { width, height }
    }
  }
  return null
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

function optionalExpectedOrigin(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') return undefined
  try {
    const u = new URL(v.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined
  } catch {
    return undefined
  }
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
        ...(obj.ifIdle === true ? { ifIdle: true } : {}),
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
      const expectedOrigin = optionalExpectedOrigin(obj.expectedOrigin)
      return { action, x, y, normalized, button, ...(expectedOrigin ? { expectedOrigin } : {}) }
    }
    case 'wheel': {
      const normalized = obj.normalized === true
      const deltaY = clamp(finiteNumber(obj.deltaY, 'deltaY'), -4000, 4000)
      const deltaX = obj.deltaX === undefined ? 0 : clamp(finiteNumber(obj.deltaX, 'deltaX'), -4000, 4000)
      const x = obj.x === undefined ? undefined : finiteNumber(obj.x, 'x')
      const y = obj.y === undefined ? undefined : finiteNumber(obj.y, 'y')
      const expectedOrigin = optionalExpectedOrigin(obj.expectedOrigin)
      return {
        action: 'wheel',
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
        normalized,
        deltaX,
        deltaY,
        ...(expectedOrigin ? { expectedOrigin } : {}),
      }
    }
    case 'type': {
      if (typeof obj.text !== 'string' || obj.text.length === 0 || obj.text.length > LIVE_BROWSER_MAX_TYPE_CHARS) {
        throw new LiveBrowserError(400, 'INVALID_TEXT', `输入文本长度需在 1~${LIVE_BROWSER_MAX_TYPE_CHARS} 字符内`)
      }
      if (obj.text.includes('\0')) {
        throw new LiveBrowserError(400, 'INVALID_TEXT', '输入文本包含非法字符')
      }
      const expectedOrigin = optionalExpectedOrigin(obj.expectedOrigin)
      return { action: 'type', text: obj.text, submit: obj.submit === true, ...(expectedOrigin ? { expectedOrigin } : {}) }
    }
    case 'press': {
      if (typeof obj.key !== 'string' || !ALLOWED_PRESS_KEYS.has(obj.key)) {
        throw new LiveBrowserError(400, 'INVALID_KEY', '不支持该按键指令')
      }
      const expectedOrigin = optionalExpectedOrigin(obj.expectedOrigin)
      return { action: 'press', key: obj.key, ...(expectedOrigin ? { expectedOrigin } : {}) }
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

interface AgentMetaCache {
  viewport: { width: number; height: number }
  tabs: LiveBrowserTabInfo[]
  url: string
  title: string
}

export class LiveBrowserController {
  private readonly bin: string
  private readonly stateRoot: string
  private readonly browserHome: string
  private readonly checkExists: (p: string) => boolean
  private readonly execFn: LiveBrowserExecFn
  private readonly resolveDaemon: (stateDir: string) => PlaywrightDaemonEndpoint | null
  private readonly daemonRpc: PlaywrightDaemonRpcFn
  private readonly lockFn: PlaywrightLockFn
  private readonly readFrame: (filePath: string) => Buffer
  private readonly unlinkFrame: (filePath: string) => void
  private readonly queues = new Map<string, AgentQueueState>()
  private readonly metaCache = new Map<string, AgentMetaCache>()
  private shotSeq = 0

  constructor(deps: LiveBrowserControllerDeps = {}) {
    this.bin = deps.ocBrowserBin ?? DEFAULT_OC_BROWSER_BIN
    this.stateRoot = deps.stateRoot ?? STATE_ROOT
    this.browserHome = deps.browserHome ?? process.env.OPENCLAUDE_HOME ?? '/home/agent/.openclaude'
    this.checkExists = deps.existsSync ?? existsSync
    this.execFn = deps.execFn ?? defaultExecFn
    // When tests inject a mock execFn without a daemon socket hook, stay on the mock CLI path.
    this.resolveDaemon =
      deps.resolveDaemonEndpoint ??
      (deps.execFn && !deps.daemonRpcFn
        ? () => null
        : (stateDir) => resolvePlaywrightDaemonEndpoint(stateDir, this.stateRoot))
    this.daemonRpc = deps.daemonRpcFn ?? sendPlaywrightDaemonRpc
    this.lockFn = deps.withLock ?? (deps.daemonRpcFn ? (_d, fn) => fn() : withPlaywrightActivityLock)
    this.readFrame = deps.readFrameFile ?? ((p) => readFileSync(p))
    this.unlinkFrame =
      deps.unlinkFrameFile ??
      ((p) => {
        try {
          unlinkSync(p)
        } catch {
          // Best-effort temp cleanup.
        }
      })
  }

  isAvailable(): boolean {
    return this.checkExists(this.bin)
  }

  /**
   * Returns true only when an external `oc-browser` CLI process is genuinely operating on
   * this agent's browser state directory (not merely when the agent is running an unrelated chat turn).
   */
  isExternalCliActive(agentId: string): boolean {
    return isExternalBrowserCliActive(this.stateDirFor(agentId))
  }

  private stateDirFor(agentId: string): string {
    return join(this.stateRoot, ocBrowserAgentKey(agentId))
  }

  private isSessionActive(agentId: string): boolean {
    return this.checkExists(join(this.stateDirFor(agentId), 'activity'))
  }

  private touchActivity(agentId: string): void {
    try {
      const now = new Date()
      utimesSync(join(this.stateDirFor(agentId), 'activity'), now, now)
    } catch {
      // Best-effort keepalive for oc-browser idle reaper.
    }
  }

  private daemonEndpointFor(agentId: string): PlaywrightDaemonEndpoint | null {
    return this.resolveDaemon(this.stateDirFor(agentId))
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

  private async captureViaDaemonLocked(
    agentId: string,
    endpoint: PlaywrightDaemonEndpoint,
    opts: { includeFrame: boolean; quality: number; reuseTabs?: boolean; timeoutMs: number },
  ): Promise<LiveBrowserState> {
    this.touchActivity(agentId)
    const rpcOpts = { cwd: this.browserHome, timeoutMs: opts.timeoutMs }
    const cached = this.metaCache.get(agentId)
    let tabs = cached?.tabs ?? []
    let url = cached?.url ?? ''
    let title = cached?.title ?? ''
    let viewport = cached?.viewport ?? { width: 1280, height: 720 }

    if (!opts.reuseTabs || !cached) {
      const tabRes = await this.daemonRpc(endpoint, { _: ['tab-list'] }, rpcOpts)
      const parsedTabs = parsePlaywrightTabList(tabRes.text)
      if (parsedTabs.length > 0) {
        tabs = parsedTabs
        const activeTab = parsedTabs.find((t) => t.active) ?? parsedTabs[0]
        url = activeTab.url
        title = activeTab.title
      }
      this.metaCache.set(agentId, { viewport, tabs, url, title })
    }

    let imageBase64: string | undefined
    let mimeType: 'image/jpeg' | 'image/png' | undefined
    if (opts.includeFrame) {
      // Sweep any stale `.live-frame-*.png` left by a previously timed-out capture, then write to
      // a fresh per-request filename so late daemon writes can never clobber the next request's frame.
      try {
        if (existsSync(endpoint.stateDir)) {
          for (const f of readdirSync(endpoint.stateDir)) {
            if (f.startsWith('.live-frame-') && f.endsWith('.png')) {
              this.unlinkFrame(join(endpoint.stateDir, f))
            }
          }
        }
      } catch {
        // Best-effort sweep.
      }
      const shotPath = join(endpoint.stateDir, `.live-frame-${++this.shotSeq}.png`)
      try {
        await this.daemonRpc(endpoint, { _: ['screenshot'], filename: shotPath }, rpcOpts)
        const buf = this.readFrame(shotPath)
        const pngDims = readPngDimensions(buf)
        if (pngDims) {
          viewport = pngDims
          this.metaCache.set(agentId, { viewport, tabs, url, title })
        }
        if (buf.length > 0 && buf.length <= LIVE_BROWSER_MAX_IMAGE_BYTES) {
          imageBase64 = buf.toString('base64')
          mimeType = detectImageMime(buf)
        } else if (buf.length > LIVE_BROWSER_MAX_IMAGE_BYTES) {
          // Oversized PNG on image-heavy pages: step down to compressed JPEG over the same fast socket.
          const script = buildPlaywrightRunCodeScript({
            mode: 'capture',
            includeFrame: true,
            quality: Math.min(opts.quality, 62),
            maxBytes: LIVE_BROWSER_MAX_IMAGE_BYTES,
          })
          const jpegRes = await this.daemonRpc(endpoint, { _: ['run-code', script] }, rpcOpts)
          const parsed = parsePlaywrightRunCodeResult(jpegRes.text)
          if (parsed) {
            const state = this.toState(parsed)
            if (state.viewport && state.tabs) {
              this.metaCache.set(agentId, {
                viewport: state.viewport,
                tabs: state.tabs,
                url: state.url ?? url,
                title: state.title ?? title,
              })
            }
            this.touchActivity(agentId)
            return state
          }
        }
      } finally {
        this.unlinkFrame(shotPath)
      }
    }

    this.touchActivity(agentId)
    return {
      available: true,
      active: true,
      url,
      title,
      viewport,
      tabs,
      ...(imageBase64 && mimeType ? { imageBase64, mimeType } : {}),
      capturedAt: Date.now(),
    }
  }

  private captureViaDaemon(
    agentId: string,
    endpoint: PlaywrightDaemonEndpoint,
    opts: { includeFrame: boolean; quality: number; reuseTabs?: boolean; timeoutMs: number },
  ): Promise<LiveBrowserState> {
    return this.lockFn(endpoint.stateDir, () => this.captureViaDaemonLocked(agentId, endpoint, opts))
  }

  private performActionViaDaemon(
    agentId: string,
    endpoint: PlaywrightDaemonEndpoint,
    action: Exclude<LiveBrowserAction, { action: 'close' | 'open' }>,
  ): Promise<LiveBrowserState> {
    return this.lockFn(endpoint.stateDir, async () => {
      // Re-verify external CLI ownership AFTER acquiring cross-process flock so a CLI
      // command that raced ahead before flock acquisition blocks stale human input.
      if (this.isExternalCliActive(agentId)) {
        throw new LiveBrowserError(409, 'AGENT_RUNNING', '助手正在操作浏览器，请等待当前浏览器操作完成后再接管')
      }
      this.touchActivity(agentId)
      const rpcOpts = { cwd: this.browserHome, timeoutMs: ACTION_TIMEOUT_MS }
      if ('expectedOrigin' in action && action.expectedOrigin) {
        const tabRes = await this.daemonRpc(endpoint, { _: ['tab-list'] }, rpcOpts)
        const parsedTabs = parsePlaywrightTabList(tabRes.text)
        const activeTab = parsedTabs.find((t) => t.active) ?? parsedTabs[0]
        const liveOrigin = optionalExpectedOrigin(activeTab?.url)
        if (liveOrigin && liveOrigin !== action.expectedOrigin) {
          throw new LiveBrowserError(409, 'PAGE_ORIGIN_CHANGED', '页面已跳转到其他站点，请核对地址栏后再操作')
        }
      }
      const vp = this.metaCache.get(agentId)?.viewport ?? { width: 1280, height: 720 }
      const toPx = (x: number, y: number, norm?: boolean) => ({
        px: clamp(Math.round(norm ? x * vp.width : x), 1, Math.max(1, vp.width - 1)),
        py: clamp(Math.round(norm ? y * vp.height : y), 1, Math.max(1, vp.height - 1)),
      })

      // Authentic DOM dblclick (clickCount=2): run via Playwright run-code over the fast socket.
      if (action.action === 'dblclick') {
        const script = buildPlaywrightRunCodeScript({
          mode: 'action',
          includeFrame: true,
          quality: 70,
          maxBytes: LIVE_BROWSER_MAX_IMAGE_BYTES,
          op: action,
        })
        const res = await this.daemonRpc(endpoint, { _: ['run-code', script] }, rpcOpts)
        const state = this.toState(parsePlaywrightRunCodeResult(res.text))
        if (state.active && state.viewport && state.tabs) {
          this.metaCache.set(agentId, {
            viewport: state.viewport,
            tabs: state.tabs,
            url: state.url ?? '',
            title: state.title ?? '',
          })
        }
        this.touchActivity(agentId)
        return state
      }

      let reuseTabs = false
      switch (action.action) {
        case 'goto':
          await this.daemonRpc(endpoint, { _: ['goto', action.url] }, rpcOpts)
          break
        case 'back':
          await this.daemonRpc(endpoint, { _: ['go-back'] }, rpcOpts)
          break
        case 'forward':
          await this.daemonRpc(endpoint, { _: ['go-forward'] }, rpcOpts)
          break
        case 'reload':
          await this.daemonRpc(endpoint, { _: ['reload'] }, rpcOpts)
          break
        case 'click': {
          const { px, py } = toPx(action.x, action.y, action.normalized)
          const btn = action.button === 'right' ? 'right' : 'left'
          await this.daemonRpc(endpoint, { _: ['mousemove', String(px), String(py)] }, rpcOpts)
          await this.daemonRpc(endpoint, { _: btn === 'right' ? ['mousedown', 'right'] : ['mousedown'] }, rpcOpts)
          await this.daemonRpc(endpoint, { _: btn === 'right' ? ['mouseup', 'right'] : ['mouseup'] }, rpcOpts)
          break
        }
        case 'wheel': {
          if (typeof action.x === 'number' && typeof action.y === 'number') {
            const { px, py } = toPx(action.x, action.y, action.normalized)
            await this.daemonRpc(endpoint, { _: ['mousemove', String(px), String(py)] }, rpcOpts)
          }
          await this.daemonRpc(
            endpoint,
            { _: ['mousewheel', String(Math.round(action.deltaX ?? 0)), String(Math.round(action.deltaY))] },
            rpcOpts,
          )
          reuseTabs = true
          break
        }
        case 'type': {
          await this.daemonRpc(endpoint, { _: ['type', action.text] }, rpcOpts)
          if (action.submit) {
            await this.daemonRpc(endpoint, { _: ['press', 'Enter'] }, rpcOpts)
          } else {
            reuseTabs = true
          }
          break
        }
        case 'press': {
          await this.daemonRpc(endpoint, { _: ['press', action.key] }, rpcOpts)
          reuseTabs = action.key !== 'Enter'
          break
        }
        case 'tab_select':
          await this.daemonRpc(endpoint, { _: ['tab-select', String(action.index)] }, rpcOpts)
          break
        case 'tab_new':
          await this.daemonRpc(endpoint, { _: action.url ? ['tab-new', action.url] : ['tab-new'] }, rpcOpts)
          break
        case 'tab_close':
          await this.daemonRpc(
            endpoint,
            { _: typeof action.index === 'number' ? ['tab-close', String(action.index)] : ['tab-close'] },
            rpcOpts,
          )
          break
      }

      return this.captureViaDaemonLocked(agentId, endpoint, {
        includeFrame: true,
        quality: 70,
        reuseTabs,
        timeoutMs: ACTION_TIMEOUT_MS,
      })
    })
  }

  async getLiveState(agentId: string, opts?: { includeFrame?: boolean; quality?: number }): Promise<LiveBrowserState> {
    if (!isValidLiveBrowserAgentId(agentId)) {
      throw new LiveBrowserError(400, 'INVALID_AGENT_ID', '无效的智能体标识')
    }
    if (!this.isAvailable()) {
      return { available: false, active: false, reason: 'unavailable' }
    }
    if (!this.isSessionActive(agentId)) {
      this.metaCache.delete(agentId)
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
        this.metaCache.delete(agentId)
        return { available: true, active: false }
      }
      const endpoint = this.daemonEndpointFor(agentId)
      if (endpoint) {
        try {
          return await this.captureViaDaemon(agentId, endpoint, {
            includeFrame,
            quality,
            reuseTabs: false,
            timeoutMs: READ_TIMEOUT_MS,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (SESSION_CLOSED_RE.test(msg) || DAEMON_SOCKET_DEAD_RE.test(msg)) {
            this.metaCache.delete(agentId)
            return { available: true, active: false }
          }
          throw new LiveBrowserError(502, 'BROWSER_CAPTURE_FAILED', msg.slice(0, 240))
        }
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
          this.metaCache.delete(agentId)
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

  private async captureCurrentFrame(agentId: string, env: NodeJS.ProcessEnv): Promise<LiveBrowserState> {
    const endpoint = this.daemonEndpointFor(agentId)
    if (endpoint) {
      return this.captureViaDaemon(agentId, endpoint, {
        includeFrame: true,
        quality: 70,
        reuseTabs: false,
        timeoutMs: ACTION_TIMEOUT_MS,
      })
    }
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

  private async openAndCapture(
    agentId: string,
    env: NodeJS.ProcessEnv,
    targetUrl: string,
    ifIdle = false,
  ): Promise<LiveBrowserState> {
    this.metaCache.delete(agentId)
    const openEnv = ifIdle ? { ...env, OPENCLAUDE_BROWSER_OPEN_IF_IDLE: '1' } : env
    await this.execFn(this.bin, ['open', targetUrl], {
      env: openEnv,
      timeout: ACTION_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
    })
    return this.captureCurrentFrame(agentId, env)
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
      // Re-verify external CLI ownership right at the serialized execution boundary so a
      // queued human action cannot slip onto a page that the assistant just started navigating.
      if (this.isExternalCliActive(agentId)) {
        throw new LiveBrowserError(409, 'AGENT_RUNNING', '助手正在操作浏览器，请等待当前浏览器操作完成后再接管')
      }
      const env = this.envFor(agentId)
      if (action.action === 'close') {
        this.metaCache.delete(agentId)
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
        const ifIdle = action.ifIdle === true
        try {
          if (!this.isSessionActive(agentId)) {
            return await this.openAndCapture(agentId, env, targetUrl, ifIdle)
          }
          try {
            const endpoint = this.daemonEndpointFor(agentId)
            if (endpoint) {
              return await this.lockFn(endpoint.stateDir, async () => {
                this.touchActivity(agentId)
                // When `ifIdle: true` (e.g. handoff card auto-open), never clobber an
                // already-active page (such as a login/2FA challenge opened by the assistant).
                if (action.url && !ifIdle) {
                  await this.daemonRpc(endpoint, { _: ['goto', targetUrl] }, {
                    cwd: this.browserHome,
                    timeoutMs: ACTION_TIMEOUT_MS,
                  })
                }
                return this.captureViaDaemonLocked(agentId, endpoint, {
                  includeFrame: true,
                  quality: 70,
                  reuseTabs: false,
                  timeoutMs: ACTION_TIMEOUT_MS,
                })
              })
            }
            if (action.url && !ifIdle) {
              await this.execFn(this.bin, ['goto', targetUrl], {
                env,
                timeout: ACTION_TIMEOUT_MS,
                maxBuffer: EXEC_MAX_BUFFER,
              })
            }
            return await this.captureCurrentFrame(agentId, env)
          } catch (innerErr) {
            // Activity marker is only a hint: if the daemon died leaving a stale marker, cold-start once.
            const innerMsg = innerErr instanceof Error ? innerErr.message : String(innerErr)
            if (SESSION_CLOSED_RE.test(innerMsg) || DAEMON_SOCKET_DEAD_RE.test(innerMsg)) {
              return await this.openAndCapture(agentId, env, targetUrl, ifIdle)
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
            return await this.openAndCapture(agentId, env, action.url)
          } catch (err) {
            if (err instanceof LiveBrowserError) throw err
            const msg = err instanceof Error ? err.message : String(err)
            throw new LiveBrowserError(502, 'BROWSER_ACTION_FAILED', msg.slice(0, 240))
          }
        }
        throw new LiveBrowserError(409, 'BROWSER_NOT_ACTIVE', '云端浏览器尚未启动，请先打开网页')
      }

      // Fast path: talk directly to the per-agent playwright-cli Unix domain socket (~200-350ms vs ~1.2s CLI spawn).
      const endpoint = this.daemonEndpointFor(agentId)
      if (endpoint) {
        try {
          return await this.performActionViaDaemon(agentId, endpoint, action)
        } catch (err) {
          if (err instanceof LiveBrowserError) throw err
          const msg = err instanceof Error ? err.message : String(err)
          if (SESSION_CLOSED_RE.test(msg) || DAEMON_SOCKET_DEAD_RE.test(msg)) {
            this.metaCache.delete(agentId)
            if (action.action === 'goto') {
              try {
                return await this.openAndCapture(agentId, env, action.url)
              } catch (openErr) {
                const openMsg = openErr instanceof Error ? openErr.message : String(openErr)
                throw new LiveBrowserError(502, 'BROWSER_ACTION_FAILED', openMsg.slice(0, 240))
              }
            }
            return { available: true, active: false }
          }
          throw new LiveBrowserError(502, 'BROWSER_ACTION_FAILED', msg.slice(0, 240))
        }
      }

      // Fallback CLI path (e.g. when daemon socket hasn't been created yet or in CLI-mocked unit tests).
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
          return await this.captureCurrentFrame(agentId, env)
        } catch (err) {
          if (err instanceof LiveBrowserError) throw err
          const msg = err instanceof Error ? err.message : String(err)
          if (SESSION_CLOSED_RE.test(msg)) {
            this.metaCache.delete(agentId)
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
          this.metaCache.delete(agentId)
          // If goto hit a stale activity marker where daemon had already exited, cold-start once.
          if (action.action === 'goto') {
            try {
              return await this.openAndCapture(agentId, env, action.url)
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
    const agentBusy = Boolean(host.isAgentRunning?.(agentId)) || host.controller.isExternalCliActive(agentId)
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
  if (host.isAgentRunning?.(agentId) || host.controller.isExternalCliActive(agentId)) {
    host.sendJson(res, 409, {
      error: '助手正在操作浏览器，请等待当前浏览器操作完成后再接管',
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
