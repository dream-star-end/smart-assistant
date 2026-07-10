import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Supervises the ChatGPT real-browser screencast sidecar — a headful Chromium
 * (under Xvfb) per user that the frontend drives remotely. See
 * chatgpt-browser-sidecar.mjs for the protocol and why a real browser is the
 * only way to deliver login (OAuth + Arkose) / WebSocket / all features.
 *
 * Same contract as the TLS sidecar: a missing runtime (no venv / no Xvfb) or a
 * crash-looping sidecar NEVER blocks gateway startup — the WS relay just fails
 * the connection.
 */
export interface ChatGptBrowserSidecarOptions {
  enabled?: boolean
  port?: number
  /** Node project with playwright + chromium (setup-chatgpt-browser-sidecar.sh). */
  runtimeDir?: string
  /** Egress proxy the browser dials chatgpt through (sing-box). Default config.proxyUrl. */
  proxyUrl?: string
  /** Per-user persistent profile base (login persists here). */
  profileDir?: string
  /** Stealth init-script path (navigator.webdriver patch, etc.). */
  stealthScript?: string
  viewport?: string // "1280x800"
  browsersPath?: string // PLAYWRIGHT_BROWSERS_PATH
  /** Prefer direct WebRTC video/data transport; JPEG-over-WS stays as fallback. Default true. */
  webrtcEnabled?: boolean
  /** STUN/TURN URLs used for ICE gathering. Default Cloudflare STUN. */
  webrtcIceServers?: string[]
  /** Fixed UDP port range used by server ICE transports. */
  webrtcPortMin?: number
  webrtcPortMax?: number
}

export interface ChatGptBrowserSidecarDialInfo {
  host: string
  port: number
  token: string
}

interface SidecarLogger {
  info?: (msg: string, ctx?: Record<string, unknown>) => void
  warn?: (msg: string, ctx?: Record<string, unknown>, err?: unknown) => void
}

const DEFAULT_PORT = 18994
const DEFAULT_RUNTIME = '/opt/openclaude/chatgpt-browser'
const DEFAULT_PROFILE = '/root/.openclaude/chatgpt-browser'
const DEFAULT_VIEWPORT = '1280x800'
const DEFAULT_BROWSERS_PATH = '/root/.cache/ms-playwright'
const DEFAULT_WEBRTC_ICE_SERVERS = ['stun:stun.cloudflare.com:3478']
const DEFAULT_WEBRTC_PORT_MIN = 19000
const DEFAULT_WEBRTC_PORT_MAX = 19100
const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000
const STABLE_UPTIME_MS = 30_000

export class ChatGptBrowserSidecar {
  private readonly enabled: boolean
  private readonly host = '127.0.0.1'
  private readonly port: number
  private readonly runtimeDir: string
  private readonly proxyUrl: string
  private readonly profileDir: string
  private readonly stealthScript: string
  private readonly viewport: string
  private readonly browsersPath: string
  private readonly webrtcEnabled: boolean
  private readonly webrtcIceServers: string[]
  private readonly webrtcPortMin: number
  private readonly webrtcPortMax: number
  private readonly token = randomBytes(24).toString('hex')
  private readonly srcScript = fileURLToPath(
    new URL('../scripts/chatgpt-browser-sidecar.mjs', import.meta.url),
  )
  private readonly log: SidecarLogger

  private child: ChildProcess | null = null
  private shuttingDown = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private backoffMs = INITIAL_BACKOFF_MS
  private spawnedAt = 0

  constructor(opts: ChatGptBrowserSidecarOptions, log: SidecarLogger) {
    this.enabled = opts.enabled === true
    this.port = opts.port ?? DEFAULT_PORT
    this.runtimeDir = opts.runtimeDir ?? DEFAULT_RUNTIME
    this.proxyUrl = opts.proxyUrl ?? ''
    this.profileDir = opts.profileDir ?? DEFAULT_PROFILE
    this.stealthScript = opts.stealthScript ?? ''
    this.viewport = opts.viewport ?? DEFAULT_VIEWPORT
    this.browsersPath = opts.browsersPath ?? DEFAULT_BROWSERS_PATH
    this.webrtcEnabled = opts.webrtcEnabled !== false
    this.webrtcIceServers = opts.webrtcIceServers ?? DEFAULT_WEBRTC_ICE_SERVERS
    this.webrtcPortMin = opts.webrtcPortMin ?? DEFAULT_WEBRTC_PORT_MIN
    this.webrtcPortMax = opts.webrtcPortMax ?? DEFAULT_WEBRTC_PORT_MAX
    this.log = log
  }

  dialInfo(): ChatGptBrowserSidecarDialInfo | null {
    if (!this.enabled) return null
    return { host: this.host, port: this.port, token: this.token }
  }

  start(): void {
    if (!this.enabled || this.shuttingDown || this.child) return
    if (!existsSync(join(this.runtimeDir, 'node_modules', 'playwright'))) {
      this.log.warn?.(
        'chatgpt browser sidecar enabled but runtime missing; connections will fail until provisioned',
        { runtimeDir: this.runtimeDir },
      )
      return
    }
    if (!existsSync(this.srcScript)) {
      this.log.warn?.('chatgpt browser sidecar script missing', { script: this.srcScript })
      return
    }
    this.spawnChild()
  }

  private spawnChild(): void {
    if (this.shuttingDown) return
    // Copy the repo script into the runtime dir so its bare `import 'playwright'`
    // resolves from the runtime's node_modules (keeps repo as source of truth).
    const runScript = join(this.runtimeDir, 'sidecar.mjs')
    try {
      copyFileSync(this.srcScript, runScript)
    } catch (err) {
      this.log.warn?.('chatgpt browser sidecar: failed to stage script', {}, err)
      this.scheduleRestart()
      return
    }
    const [vw, vh] = this.viewport.split('x')
    // Headful needs a display: xvfb-run gives a throwaway X server. detached so
    // we can SIGTERM the whole group (xvfb-run + Xvfb + node) on stop.
    const child = spawn('xvfb-run', ['-a', '-s', `-screen 0 ${vw}x${vh}x24`, 'node', runScript], {
      cwd: this.runtimeDir,
      detached: true,
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: this.browsersPath,
        OC_CGB_PORT: String(this.port),
        OC_CGB_TOKEN: this.token,
        OC_CGB_PROXY: this.proxyUrl,
        OC_CGB_PROFILE_DIR: this.profileDir,
        OC_CGB_STEALTH_SCRIPT: this.stealthScript,
        OC_CGB_VIEWPORT: this.viewport,
        OC_CGB_WEBRTC_ENABLED: this.webrtcEnabled ? '1' : '0',
        OC_CGB_WEBRTC_ICE_SERVERS: JSON.stringify(this.webrtcIceServers),
        OC_CGB_WEBRTC_PORT_MIN: String(this.webrtcPortMin),
        OC_CGB_WEBRTC_PORT_MAX: String(this.webrtcPortMax),
        // Parent-death watchdog target: the sidecar exits if the gateway dies
        // without a clean stop (SIGKILL), so it never orphans Xvfb + Chromium.
        OC_CGB_PARENT_PID: String(process.pid),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child

    const relay = (buf: unknown) => {
      const line = String(buf).trim()
      if (line) this.log.info?.(line)
    }
    child.stdout?.on('data', relay)
    child.stderr?.on('data', relay)

    child.once('spawn', () => {
      this.spawnedAt = Date.now()
      this.log.info?.('chatgpt browser sidecar started', { port: this.port })
    })
    child.once('error', (err) => {
      this.log.warn?.('chatgpt browser sidecar spawn error', { runtimeDir: this.runtimeDir }, err)
      if (this.child === child) {
        this.child = null
        if (!this.shuttingDown) this.scheduleRestart()
      }
    })
    child.once('exit', (code, signal) => {
      this.child = null
      if (this.shuttingDown) return
      const uptime = this.spawnedAt ? Date.now() - this.spawnedAt : 0
      if (uptime > STABLE_UPTIME_MS) this.backoffMs = INITIAL_BACKOFF_MS
      this.log.warn?.('chatgpt browser sidecar exited; scheduling restart', {
        code,
        signal,
        backoffMs: this.backoffMs,
      })
      this.scheduleRestart()
    })
  }

  private scheduleRestart(): void {
    if (this.shuttingDown || this.restartTimer) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.spawnChild()
    }, delay)
    this.restartTimer.unref?.()
  }

  stop(): void {
    this.shuttingDown = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    this.child = null
    if (child?.pid) {
      // detached → kill the whole process group (xvfb-run + Xvfb + node)
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        try {
          child.kill('SIGTERM')
        } catch {}
      }
    }
  }
}
