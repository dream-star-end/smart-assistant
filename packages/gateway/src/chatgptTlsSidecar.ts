import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Supervises the Chrome-TLS-impersonation sidecar (Python + curl_cffi) that the
 * ChatGPT web proxy dials its upstream leg through. See `chatgpt_tls_sidecar.py`
 * for why this exists (Cloudflare managed challenge fingerprints Node's TLS).
 *
 * Design contract: a missing venv or a crash-looping sidecar must NEVER block
 * gateway startup. When the sidecar can't run, `dialInfo()` still returns the
 * dial target and the proxy handler simply 502s — the rest of the gateway is
 * unaffected.
 */
export interface ChatGptTlsSidecarOptions {
  enabled?: boolean
  port?: number
  pythonPath?: string
  scriptPath?: string
  proxyUrl?: string
  impersonate?: string
}

export interface ChatGptTlsSidecarDialInfo {
  host: string
  port: number
  token: string
}

interface SidecarLogger {
  info?: (msg: string, ctx?: Record<string, unknown>) => void
  warn?: (msg: string, ctx?: Record<string, unknown>, err?: unknown) => void
}

const DEFAULT_PORT = 18992
const DEFAULT_PYTHON = '/opt/openclaude/chatgpt-tls/venv/bin/python'
const INITIAL_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000
/** Uptime past which a crash is treated as a fresh failure (reset backoff). */
const STABLE_UPTIME_MS = 30_000

export class ChatGptTlsSidecar {
  private readonly enabled: boolean
  private readonly host = '127.0.0.1'
  private readonly port: number
  private readonly pythonPath: string
  private readonly scriptPath: string
  private readonly proxyUrl: string
  private readonly impersonate: string
  private readonly token = randomBytes(24).toString('hex')
  private readonly log: SidecarLogger

  private child: ChildProcess | null = null
  private shuttingDown = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private backoffMs = INITIAL_BACKOFF_MS
  private spawnedAt = 0

  constructor(opts: ChatGptTlsSidecarOptions, log: SidecarLogger) {
    this.enabled = opts.enabled === true
    this.port = opts.port ?? DEFAULT_PORT
    this.pythonPath = opts.pythonPath ?? DEFAULT_PYTHON
    this.scriptPath =
      opts.scriptPath ??
      fileURLToPath(new URL('../scripts/chatgpt_tls_sidecar.py', import.meta.url))
    this.proxyUrl = opts.proxyUrl ?? ''
    this.impersonate = opts.impersonate ?? 'chrome'
    this.log = log
  }

  /** Dial target for the proxy handler, or null when the feature is disabled. */
  dialInfo(): ChatGptTlsSidecarDialInfo | null {
    if (!this.enabled) return null
    return { host: this.host, port: this.port, token: this.token }
  }

  start(): void {
    if (!this.enabled || this.shuttingDown || this.child) return
    if (!existsSync(this.pythonPath)) {
      this.log.warn?.(
        'chatgpt tls sidecar enabled but venv python missing; /api/chatgpt-web will 502 until provisioned',
        { pythonPath: this.pythonPath },
      )
      return
    }
    if (!existsSync(this.scriptPath)) {
      this.log.warn?.('chatgpt tls sidecar script missing; /api/chatgpt-web will 502', {
        scriptPath: this.scriptPath,
      })
      return
    }
    this.spawnChild()
  }

  private spawnChild(): void {
    if (this.shuttingDown) return
    const child = spawn(this.pythonPath, [this.scriptPath], {
      // argv array, never a shell. PYTHONSAFEPATH keeps the script dir / cwd off
      // sys.path so a stray sibling module can't shadow stdlib and break the
      // curl_cffi import.
      env: {
        ...process.env,
        PYTHONSAFEPATH: '1',
        PYTHONUNBUFFERED: '1',
        OC_CHATGPT_SIDECAR_PORT: String(this.port),
        OC_CHATGPT_SIDECAR_TOKEN: this.token,
        OC_CHATGPT_SIDECAR_PROXY: this.proxyUrl,
        OC_CHATGPT_SIDECAR_IMPERSONATE: this.impersonate,
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
      this.log.info?.('chatgpt tls sidecar started', { port: this.port })
    })
    child.once('error', (err) => {
      this.log.warn?.('chatgpt tls sidecar spawn error', { pythonPath: this.pythonPath }, err)
      // A spawn failure (e.g. python present but not executable) may emit only
      // 'error' and never 'exit', so converge the restart path here too. The
      // child-identity guard + restartTimer guard make a paired error+exit safe.
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
      this.log.warn?.('chatgpt tls sidecar exited; scheduling restart', {
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
    if (this.child) {
      this.child.kill('SIGTERM')
      this.child = null
    }
  }
}
