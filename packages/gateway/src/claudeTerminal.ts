import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import * as pty from 'node-pty'
import type { RawData, WebSocket } from 'ws'
import type { Logger } from './logger.js'
import { PROXY_ENV_KEYS } from './proxyEnv.js'

export const CLAUDE_TERMINAL_WS_PATH = '/ws/claude-terminal'
export const CLAUDE_TERMINAL_MAX_CLIENT_MESSAGE_BYTES = 64 * 1024

const MAX_INPUT_BYTES = 32 * 1024
const DEFAULT_COLS = 100
const DEFAULT_ROWS = 30
const MIN_COLS = 20
const MAX_COLS = 240
const MIN_ROWS = 5
const MAX_ROWS = 80
const OUTPUT_REPLAY_MAX_BYTES = 1024 * 1024
const DEFAULT_DETACHED_TTL_MS = 6 * 60 * 60_000
const MAX_DETACHED_TTL_MS = 24 * 60 * 60_000

const EXTRA_PROXY_ENV_KEYS = ['ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']
const LOCALE_ENV_KEYS = ['LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES']

type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'kill' }

type PtyExit = { exitCode?: number; signal?: number | string }

type PtyDisposable = { dispose(): void }

type PtyLike = {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(callback: (data: string) => void): PtyDisposable
  onExit(callback: (event: PtyExit) => void): PtyDisposable
}

type PtySpawn = (
  file: string,
  args: string[],
  opts: {
    name: string
    cols: number
    rows: number
    cwd: string
    env: Record<string, string>
  },
) => PtyLike

export interface ClaudeTerminalManagerOptions {
  logger: Logger
  spawn?: PtySpawn
  env?: NodeJS.ProcessEnv
}

interface OutputChunk {
  data: string
  bytes: number
}

interface ActiveTerminalSession {
  userId: string
  ws: WebSocket | null
  pty: PtyLike
  cwd: string
  command: string
  outputChunks: OutputChunk[]
  outputBytes: number
  cleanupTimer: ReturnType<typeof setTimeout> | null
  dataDisposable: PtyDisposable
  exitDisposable: PtyDisposable
  closed: boolean
}

function isTruthyDisabled(value: string | undefined): boolean {
  if (!value) return false
  return ['0', 'false', 'no', 'off', 'disabled'].includes(value.trim().toLowerCase())
}

export function isClaudeTerminalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isTruthyDisabled(env.OPENCLAUDE_OFFICIAL_CLAUDE_TERMINAL)
}

export function resolveClaudeTerminalUserIdForAuth(input: {
  jwtUserId: string | null
  jwtUserAllowed: boolean
  rawTokenValid: boolean
  hasConfiguredUsers: boolean
}): string | null {
  if (input.jwtUserId && input.jwtUserAllowed) return input.jwtUserId
  if (!input.hasConfiguredUsers && input.rawTokenValid) return 'default'
  return null
}

export function clampTerminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const c = typeof cols === 'number' && Number.isFinite(cols) ? Math.trunc(cols) : DEFAULT_COLS
  const r = typeof rows === 'number' && Number.isFinite(rows) ? Math.trunc(rows) : DEFAULT_ROWS
  return {
    cols: Math.max(MIN_COLS, Math.min(MAX_COLS, c)),
    rows: Math.max(MIN_ROWS, Math.min(MAX_ROWS, r)),
  }
}

export function resolveDetachedTerminalTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCLAUDE_OFFICIAL_CLAUDE_TERMINAL_DETACHED_TTL_MS?.trim()
  if (!raw) return DEFAULT_DETACHED_TTL_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DETACHED_TTL_MS
  return Math.min(MAX_DETACHED_TTL_MS, Math.trunc(n))
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

export function isAllowedClaudeTerminalOrigin(
  originHeader: string | string[] | undefined,
  hostHeader: string | string[] | undefined,
  expectedProtocol: 'http:' | 'https:',
): boolean {
  const originValue = firstHeader(originHeader).trim()
  if (!originValue) return true
  const hostValue = firstHeader(hostHeader).split(',')[0]?.trim() ?? ''
  if (!hostValue) return false
  try {
    const origin = new URL(originValue)
    return origin.protocol === expectedProtocol && origin.host === hostValue
  } catch {
    return false
  }
}

export function resolveOfficialClaudePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCLAUDE_OFFICIAL_CLAUDE_PATH?.trim()
  if (configured) return configured
  const localClaude = join(homedir(), '.local/bin/claude')
  return existsSync(localClaude) ? localClaude : 'claude'
}

const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_LISTED_CLAUDE_SESSIONS = 60
const MAX_SESSION_TITLE_CHARS = 80
const SESSION_TITLE_SCAN_BYTES = 128 * 1024

export function isValidClaudeSessionId(id: unknown): id is string {
  return typeof id === 'string' && CLAUDE_SESSION_ID_RE.test(id.trim())
}

export function buildOfficialClaudeArgs(resumeSessionId?: string): string[] {
  const base = ['--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions']
  if (isValidClaudeSessionId(resumeSessionId)) return ['--resume', resumeSessionId.trim(), ...base]
  return base
}

export interface ClaudeSessionSummary {
  sessionId: string
  title: string
  cwd: string
  mtimeMs: number
  live: boolean
}

// Claude Code stores per-cwd session transcripts under ~/.claude/projects/<encoded-cwd>/<id>.jsonl,
// where the cwd is encoded by replacing `/` and `.` with `-` (e.g. /root -> -root).
function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

function readFileHead(filePath: string, maxBytes: number): string {
  let fd: number | null = null
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(maxBytes)
    const n = readSync(fd, buf, 0, maxBytes, 0)
    return buf.subarray(0, n).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd != null) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

function cleanSessionTitle(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!trimmed) return ''
  // Skip Claude Code's synthetic first messages: slash-command wrappers and caveats.
  if (trimmed.startsWith('<') || trimmed.startsWith('Caveat:')) return ''
  return trimmed.length > MAX_SESSION_TITLE_CHARS
    ? `${trimmed.slice(0, MAX_SESSION_TITLE_CHARS - 1)}…`
    : trimmed
}

function extractSessionTitle(filePath: string): string {
  const head = readFileHead(filePath, SESSION_TITLE_SCAN_BYTES)
  if (!head) return ''
  for (const line of head.split('\n')) {
    if (!line.trim()) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Last line may be truncated by the bounded read; skip and keep scanning earlier lines.
      continue
    }
    if (record.type !== 'user' || record.isMeta === true) continue
    const content = (record.message as { content?: unknown } | undefined)?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
          text = String((block as { text?: unknown }).text ?? '')
          break
        }
      }
    }
    const title = cleanSessionTitle(text)
    if (title) return title
  }
  return ''
}

function readLiveClaudeSessionIds(home: string): Set<string> {
  const ids = new Set<string>()
  const dir = join(home, '.claude', 'sessions')
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return ids
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>
      if (isValidClaudeSessionId(record.sessionId)) ids.add(record.sessionId.trim())
    } catch {}
  }
  return ids
}

export function listClaudeSessions(env: NodeJS.ProcessEnv = process.env): ClaudeSessionSummary[] {
  const home = env.HOME || homedir()
  let cwd: string
  try {
    cwd = resolveOfficialClaudeCwd(env)
  } catch {
    return []
  }
  const projectDir = join(home, '.claude', 'projects', encodeClaudeProjectDir(cwd))
  let files: string[] = []
  try {
    files = readdirSync(projectDir).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return []
  }
  // Stat is cheap; pick the newest N first, then only read transcript titles for those —
  // avoids reading head bytes for every historical session when there are many.
  const candidates: Array<{ sessionId: string; filePath: string; mtimeMs: number }> = []
  for (const file of files) {
    const sessionId = file.slice(0, -'.jsonl'.length)
    if (!isValidClaudeSessionId(sessionId)) continue
    const filePath = join(projectDir, file)
    try {
      candidates.push({ sessionId, filePath, mtimeMs: statSync(filePath).mtimeMs })
    } catch {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const liveIds = readLiveClaudeSessionIds(home)
  return candidates.slice(0, MAX_LISTED_CLAUDE_SESSIONS).map((c) => ({
    sessionId: c.sessionId,
    title: extractSessionTitle(c.filePath) || '(无标题会话)',
    cwd,
    mtimeMs: c.mtimeMs,
    live: liveIds.has(c.sessionId),
  }))
}

export function resolveOfficialClaudeCwd(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCLAUDE_OFFICIAL_CLAUDE_CWD?.trim()
  const cwd = configured ? resolve(configured) : homedir()
  const stat = statSync(cwd)
  if (!stat.isDirectory()) throw new Error(`Claude terminal cwd is not a directory: ${cwd}`)
  return cwd
}

export function buildOfficialClaudeEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result: Record<string, string> = {}
  const home = env.HOME || homedir()
  result.HOME = home
  result.TERM = env.TERM || 'xterm-256color'
  result.SHELL = env.SHELL || '/bin/bash'

  const pathParts = [join(home, '.local/bin')]
  if (env.PATH) pathParts.push(env.PATH)
  result.PATH = [...new Set(pathParts.join(':').split(':').filter(Boolean))].join(':')

  for (const key of LOCALE_ENV_KEYS) {
    const value = env[key]
    if (typeof value === 'string' && value.length > 0) result[key] = value
  }
  for (const key of [...PROXY_ENV_KEYS, ...EXTRA_PROXY_ENV_KEYS]) {
    const value = env[key]
    if (typeof value === 'string' && value.length > 0) result[key] = value
  }
  // The browser terminal is an explicitly trusted personal PTY. Claude Code's
  // dangerous-skip root guard accepts root only when it knows it is sandboxed.
  result.IS_SANDBOX = '1'
  return result
}

function rawDataBytes(raw: RawData): number {
  if (typeof raw === 'string') return Buffer.byteLength(raw)
  if (Buffer.isBuffer(raw)) return raw.length
  if (raw instanceof ArrayBuffer) return raw.byteLength
  return raw.reduce((sum, part) => sum + part.length, 0)
}

function rawDataToString(raw: RawData): string {
  if (typeof raw === 'string') return raw
  if (Buffer.isBuffer(raw)) return raw.toString('utf8')
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8')
  return Buffer.concat(raw).toString('utf8')
}

function parseClientMessage(raw: RawData): TerminalClientMessage | null {
  const parsed = JSON.parse(rawDataToString(raw)) as unknown
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (obj.type === 'input' && typeof obj.data === 'string') {
    if (Buffer.byteLength(obj.data) > MAX_INPUT_BYTES) return null
    return { type: 'input', data: obj.data }
  }
  if (obj.type === 'resize') {
    const { cols, rows } = clampTerminalSize(obj.cols, obj.rows)
    return { type: 'resize', cols, rows }
  }
  if (obj.type === 'kill') return { type: 'kill' }
  return null
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== 1) return
  ws.send(JSON.stringify(payload))
}

function safeClose(ws: WebSocket, code?: number, reason?: string): void {
  try {
    if (ws.readyState === 0 || ws.readyState === 1) ws.close(code, reason)
  } catch {}
}

export class ClaudeTerminalManager {
  private readonly spawn: PtySpawn
  private readonly env: NodeJS.ProcessEnv
  private readonly sessions = new Map<string, ActiveTerminalSession>()

  constructor(private readonly opts: ClaudeTerminalManagerOptions) {
    this.spawn = opts.spawn ?? (pty.spawn as unknown as PtySpawn)
    this.env = opts.env ?? process.env
  }

  handleConnection(
    ws: WebSocket,
    userId: string,
    opts: { action?: 'new' | 'resume'; resumeSessionId?: string } = {},
  ): void {
    if (!isClaudeTerminalEnabled(this.env)) {
      sendJson(ws, {
        type: 'status',
        state: 'disabled',
        message: 'Claude Code terminal is disabled',
      })
      ws.close(1013, 'disabled')
      return
    }

    const action = opts.action
    if (action === 'resume' && !isValidClaudeSessionId(opts.resumeSessionId)) {
      sendJson(ws, { type: 'status', state: 'error', message: 'Invalid Claude session id' })
      ws.close(1008, 'invalid session id')
      return
    }

    // Plain reconnects reuse the live PTY; an explicit new/resume always replaces it so the
    // user gets a fresh process (or a `claude --resume` of the chosen historical session).
    if (action === 'new' || action === 'resume') {
      const existing = this.sessions.get(userId)
      if (existing) this.closeSession(existing, `switch:${action}`, true, true)
    }

    let session = this.sessions.get(userId)
    if (!session || session.closed) {
      try {
        session = this.createSession(userId, action === 'resume' ? opts.resumeSessionId : undefined)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.opts.logger.warn('official claude terminal spawn failed', { userId, message })
        sendJson(ws, { type: 'status', state: 'error', message })
        ws.close(1011, 'spawn failed')
        return
      }
      this.sessions.set(userId, session)
      this.opts.logger.info('official claude terminal started', {
        userId,
        cwd: session.cwd,
        command: session.command,
        resume: action === 'resume' ? opts.resumeSessionId : undefined,
      })
    }

    this.attachClient(session, ws)
  }

  terminate(userId: string): boolean {
    const session = this.sessions.get(userId)
    if (!session || session.closed) return false
    this.closeSession(session, 'client terminate', true, true)
    return true
  }

  workingDirectory(userId: string): string {
    const session = this.sessions.get(userId)
    if (session && !session.closed) return session.cwd
    return resolveOfficialClaudeCwd(this.env)
  }

  shutdown(reason = 'shutdown'): void {
    for (const session of [...this.sessions.values()])
      this.closeSession(session, reason, true, true)
    this.sessions.clear()
  }

  activeCount(): number {
    return this.sessions.size
  }

  private createSession(userId: string, resumeSessionId?: string): ActiveTerminalSession {
    const command = resolveOfficialClaudePath(this.env)
    if (command.startsWith('/') && !existsSync(command)) {
      throw new Error(`Claude executable not found: ${command}`)
    }
    const cwd = resolveOfficialClaudeCwd(this.env)
    const proc = this.spawn(command, buildOfficialClaudeArgs(resumeSessionId), {
      name: 'xterm-256color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
      env: buildOfficialClaudeEnv(this.env),
    })

    const session: ActiveTerminalSession = {
      userId,
      ws: null,
      pty: proc,
      cwd,
      command,
      outputChunks: [],
      outputBytes: 0,
      cleanupTimer: null,
      dataDisposable: { dispose: () => {} },
      exitDisposable: { dispose: () => {} },
      closed: false,
    }

    session.dataDisposable = proc.onData((data) => {
      this.appendOutput(session, data)
      const client = session.ws
      if (!session.closed && client?.readyState === 1) sendJson(client, { type: 'output', data })
    })
    session.exitDisposable = proc.onExit((event) => {
      const client = session.ws
      if (!session.closed && client?.readyState === 1) {
        sendJson(client, {
          type: 'exit',
          code: event.exitCode ?? null,
          signal: event.signal ?? null,
        })
      }
      this.closeSession(session, 'exit', false, true)
    })

    return session
  }

  private attachClient(session: ActiveTerminalSession, ws: WebSocket): void {
    this.clearCleanupTimer(session)

    const previous = session.ws
    if (previous && previous !== ws) {
      session.ws = null
      sendJson(previous, { type: 'status', state: 'closed', message: 'replaced' })
      safeClose(previous, 1000, 'replaced')
    }

    ws.on('message', (raw) => {
      if (!this.isActiveClient(session, ws)) return
      if (rawDataBytes(raw) > CLAUDE_TERMINAL_MAX_CLIENT_MESSAGE_BYTES) {
        sendJson(ws, { type: 'status', state: 'error', message: 'Terminal message too large' })
        safeClose(ws, 1009, 'message too large')
        return
      }
      let message: TerminalClientMessage | null = null
      try {
        message = parseClientMessage(raw)
      } catch {
        sendJson(ws, { type: 'status', state: 'error', message: 'Invalid terminal message JSON' })
        return
      }
      if (!message) {
        sendJson(ws, { type: 'status', state: 'error', message: 'Unsupported terminal message' })
        return
      }
      if (message.type === 'input') session.pty.write(message.data)
      else if (message.type === 'resize') session.pty.resize(message.cols, message.rows)
      else if (message.type === 'kill') this.closeSession(session, 'client kill', true, true)
    })

    ws.once('close', () => {
      if (!this.isActiveClient(session, ws)) return
      this.detachClient(session, ws, 'ws close')
    })
    ws.once('error', (err) => {
      if (!this.isActiveClient(session, ws)) return
      this.opts.logger.warn(
        'official claude terminal websocket error',
        { userId: session.userId },
        err,
      )
      this.detachClient(session, ws, 'ws error')
    })

    sendJson(ws, {
      type: 'status',
      state: 'running',
      message: `Claude Code terminal ${session.outputBytes > 0 ? 'resumed' : 'started'} in ${session.cwd}`,
    })
    const replay = this.replayOutput(session)
    if (replay) sendJson(ws, { type: 'replay', data: replay })
    session.ws = ws
  }

  private isActiveClient(session: ActiveTerminalSession, ws: WebSocket): boolean {
    return this.sessions.get(session.userId) === session && session.ws === ws && !session.closed
  }

  private detachClient(session: ActiveTerminalSession, ws: WebSocket, reason: string): void {
    if (!this.isActiveClient(session, ws)) return
    session.ws = null
    this.opts.logger.info('official claude terminal detached', { userId: session.userId, reason })
    this.scheduleDetachedCleanup(session)
  }

  private scheduleDetachedCleanup(session: ActiveTerminalSession): void {
    this.clearCleanupTimer(session)
    const ttlMs = resolveDetachedTerminalTtlMs(this.env)
    if (ttlMs <= 0) {
      this.closeSession(session, 'detached timeout', true, false)
      return
    }
    const timer = setTimeout(() => {
      if (this.sessions.get(session.userId) !== session) return
      if (session.cleanupTimer !== timer || session.ws !== null || session.closed) return
      session.cleanupTimer = null
      this.closeSession(session, 'detached timeout', true, false)
    }, ttlMs)
    session.cleanupTimer = timer
    ;(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
  }

  private clearCleanupTimer(session: ActiveTerminalSession): void {
    if (!session.cleanupTimer) return
    clearTimeout(session.cleanupTimer)
    session.cleanupTimer = null
  }

  private closeSession(
    session: ActiveTerminalSession,
    reason: string,
    killProcess: boolean,
    closeClient: boolean,
  ): void {
    if (session.closed) return
    session.closed = true
    this.clearCleanupTimer(session)
    if (this.sessions.get(session.userId) === session) this.sessions.delete(session.userId)

    const client = session.ws
    session.ws = null
    try {
      session.dataDisposable.dispose()
    } catch {}
    try {
      session.exitDisposable.dispose()
    } catch {}

    if (closeClient && client?.readyState === 1) {
      if (reason !== 'exit') sendJson(client, { type: 'status', state: 'closed', message: reason })
      safeClose(client, 1000, reason)
    }

    if (killProcess) {
      try {
        session.pty.kill()
      } catch (err) {
        this.opts.logger.warn(
          'official claude terminal kill failed',
          { userId: session.userId, reason },
          err,
        )
      }
    }
    this.opts.logger.info('official claude terminal closed', { userId: session.userId, reason })
  }

  private appendOutput(session: ActiveTerminalSession, data: string): void {
    if (!data) return
    let chunk = data
    let bytes = Buffer.byteLength(chunk)
    if (bytes > OUTPUT_REPLAY_MAX_BYTES) {
      chunk = Buffer.from(chunk)
        .subarray(bytes - OUTPUT_REPLAY_MAX_BYTES)
        .toString('utf8')
      bytes = Buffer.byteLength(chunk)
      session.outputChunks = []
      session.outputBytes = 0
    }
    session.outputChunks.push({ data: chunk, bytes })
    session.outputBytes += bytes
    while (session.outputBytes > OUTPUT_REPLAY_MAX_BYTES && session.outputChunks.length > 1) {
      const removed = session.outputChunks.shift()
      if (removed) session.outputBytes -= removed.bytes
    }
  }

  private replayOutput(session: ActiveTerminalSession): string {
    if (session.outputChunks.length === 0) return ''
    return session.outputChunks.map((chunk) => chunk.data).join('')
  }
}

export function createClaudeTerminalManager(
  opts: ClaudeTerminalManagerOptions,
): ClaudeTerminalManager {
  return new ClaudeTerminalManager(opts)
}
