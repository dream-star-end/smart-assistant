import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import * as pty from 'node-pty'
import type { RawData, WebSocket } from 'ws'
import { resolveOfficialClaudePath } from './claudeCli.js'
import { ClaudeTerminalOwners, resolveClaudeTerminalOwnersPath } from './claudeTerminalOwners.js'
import type { Logger } from './logger.js'
import { PROXY_ENV_KEYS } from './proxyEnv.js'

export { resolveOfficialClaudePath } from './claudeCli.js'

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
const DEFAULT_MAX_SESSIONS_PER_USER = 5

// Thrown when a user targets a session they don't own (and that isn't legacy).
// Mapped to HTTP 403 / a WS error frame at the call site.
export class ClaudeTerminalForbiddenError extends Error {
  constructor(message = 'forbidden') {
    super(message)
    this.name = 'ClaudeTerminalForbiddenError'
  }
}

const EXTRA_PROXY_ENV_KEYS = ['ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']
const LOCALE_ENV_KEYS = ['LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES']

export type ClaudeTerminalConnectAction = 'new' | 'attach'

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
  // Path to the ownership registry. Defaults to <OPENCLAUDE_HOME>/cc-terminal-owners.json.
  // Tests inject a tmp path.
  ownersPath?: string
}

interface OutputChunk {
  data: string
  bytes: number
}

interface ActiveTerminalSession {
  sessionId: string
  userId: string
  createdAt: number
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

export function resolveMaxSessionsPerUser(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCLAUDE_OFFICIAL_CLAUDE_TERMINAL_MAX_SESSIONS?.trim()
  if (!raw) return DEFAULT_MAX_SESSIONS_PER_USER
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_SESSIONS_PER_USER
  return Math.trunc(n)
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

const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_LISTED_CLAUDE_SESSIONS = 60
const MAX_SESSION_TITLE_CHARS = 80
const SESSION_TITLE_SCAN_BYTES = 128 * 1024
const TRANSCRIPT_PAGE_BYTES = 512 * 1024
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')

export interface ClaudeTranscriptEntry {
  id: string
  role: 'user' | 'assistant'
  text: string
  timestamp: string | null
  position: number
}

export interface ClaudeTranscriptPage {
  entries: ClaudeTranscriptEntry[]
  before: number | null
  fileSize: number
}

export function isValidClaudeSessionId(id: unknown): id is string {
  return typeof id === 'string' && CLAUDE_SESSION_ID_RE.test(id.trim())
}

export function buildOfficialClaudeArgs(
  opts: { newSessionId?: string; resumeSessionId?: string } = {},
): string[] {
  const base = ['--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions']
  if (isValidClaudeSessionId(opts.resumeSessionId))
    return ['--resume', opts.resumeSessionId.trim(), ...base]
  // New session: pin the id we generated so the gateway knows it up front and
  // can record ownership before the `<id>.jsonl` transcript even exists.
  if (isValidClaudeSessionId(opts.newSessionId))
    return ['--session-id', opts.newSessionId.trim(), ...base]
  return base
}

export interface ClaudeSessionSummary {
  sessionId: string
  title: string
  cwd: string
  mtimeMs: number
  live: boolean
  // true when the requesting user owns this session; false for legacy (unowned)
  // sessions that are shown to everyone during the transition window.
  owned: boolean
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

function resolveClaudeProjectDir(env: NodeJS.ProcessEnv): string {
  const home = env.HOME || homedir()
  const cwd = resolveOfficialClaudeCwd(env)
  return join(home, '.claude', 'projects', encodeClaudeProjectDir(cwd))
}

// Absolute path of a session transcript. sessionId is validated against the
// UUID whitelist before it touches the filesystem, so it can never traverse.
export function resolveClaudeSessionTranscriptPath(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isValidClaudeSessionId(sessionId)) throw new Error('invalid Claude session id')
  return join(resolveClaudeProjectDir(env), `${sessionId.trim()}.jsonl`)
}

function transcriptText(record: Record<string, unknown>): string {
  const message = record.message
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  const parts: string[] = []
  if (typeof content === 'string') parts.push(content)
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const typed = block as { type?: unknown; text?: unknown }
      if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
    }
  }
  return parts.join('\n\n').replace(ANSI_ESCAPE_RE, '').replace(/\r\n?/g, '\n').trim()
}

function isSyntheticClaudeUserText(text: string): boolean {
  return /^(?:<command-name>|<local-command-|<system-reminder>|<task-notification>)/.test(text)
}

export function parseClaudeTranscriptRecord(
  raw: unknown,
  position: number,
): ClaudeTranscriptEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (record.type !== 'user' && record.type !== 'assistant') return null
  if (record.isMeta === true) return null
  const text = transcriptText(record)
  if (!text || (record.type === 'user' && isSyntheticClaudeUserText(text))) return null
  const message = record.message as { id?: unknown } | undefined
  const idCandidate =
    typeof record.uuid === 'string'
      ? record.uuid
      : typeof message?.id === 'string'
        ? message.id
        : `${record.type}:${position}`
  return {
    id: idCandidate,
    role: record.type,
    text,
    timestamp: typeof record.timestamp === 'string' ? record.timestamp : null,
    position,
  }
}

export function readClaudeSessionTranscriptPage(
  sessionId: string,
  before: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeTranscriptPage {
  const filePath = resolveClaudeSessionTranscriptPath(sessionId, env)
  const fileSize = statSync(filePath).size
  const end = before === undefined ? fileSize : Math.min(fileSize, Math.max(0, before))
  if (end === 0) return { entries: [], before: null, fileSize }

  const rawStart = Math.max(0, end - TRANSCRIPT_PAGE_BYTES)
  const length = end - rawStart
  const buffer = Buffer.alloc(length)
  let fd: number | null = null
  let bytesRead = 0
  try {
    fd = openSync(filePath, 'r')
    bytesRead = readSync(fd, buffer, 0, length, rawStart)
  } finally {
    if (fd !== null) closeSync(fd)
  }
  const page = buffer.subarray(0, bytesRead)
  const firstNewline = rawStart > 0 ? page.indexOf(0x0a) : -1
  if (rawStart > 0 && firstNewline < 0) {
    return { entries: [], before: rawStart, fileSize }
  }
  const pageOffset = rawStart > 0 ? firstNewline + 1 : 0
  const alignedStart = rawStart + pageOffset
  const completeEnd = page.lastIndexOf(0x0a)
  if (completeEnd < pageOffset) {
    // The only newline can be the terminator of an oversized record that began
    // before this bounded window. Skip that unrenderable record while still
    // moving the backward cursor; returning alignedStart here could equal end.
    return { entries: [], before: rawStart > 0 ? rawStart : null, fileSize }
  }

  const entries: ClaudeTranscriptEntry[] = []
  let lineStart = pageOffset
  while (lineStart <= completeEnd) {
    const lineEnd = page.indexOf(0x0a, lineStart)
    if (lineEnd < 0 || lineEnd > completeEnd) break
    const line = page.subarray(lineStart, lineEnd).toString('utf8').trim()
    if (line) {
      try {
        const entry = parseClaudeTranscriptRecord(JSON.parse(line), rawStart + lineStart)
        if (entry) entries.push(entry)
      } catch {}
    }
    lineStart = lineEnd + 1
  }
  return {
    entries,
    before: alignedStart > 0 ? alignedStart : null,
    fileSize,
  }
}

export interface ListClaudeSessionsParams {
  userId: string
  // sessionId -> owner userId, or undefined for legacy/unowned (visible to all).
  ownerOf: (sessionId: string) => string | undefined
  // Session ids the gateway currently runs a live PTY for (already owner-scoped).
  liveIds: Set<string>
  env?: NodeJS.ProcessEnv
}

export function listClaudeSessions(params: ListClaudeSessionsParams): ClaudeSessionSummary[] {
  const env = params.env ?? process.env
  let cwd: string
  let projectDir: string
  try {
    cwd = resolveOfficialClaudeCwd(env)
    projectDir = resolveClaudeProjectDir(env)
  } catch {
    return []
  }
  let files: string[] = []
  try {
    files = readdirSync(projectDir).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return []
  }
  // Stat is cheap; pick the newest N first, then only read transcript titles for those —
  // avoids reading head bytes for every historical session when there are many.
  const candidates: Array<{
    sessionId: string
    filePath: string
    mtimeMs: number
    owned: boolean
  }> = []
  for (const file of files) {
    const sessionId = file.slice(0, -'.jsonl'.length)
    if (!isValidClaudeSessionId(sessionId)) continue
    const owner = params.ownerOf(sessionId)
    // Show owned sessions to their owner and legacy (unowned) sessions to all.
    if (owner !== undefined && owner !== params.userId) continue
    const filePath = join(projectDir, file)
    try {
      candidates.push({
        sessionId,
        filePath,
        mtimeMs: statSync(filePath).mtimeMs,
        owned: owner === params.userId,
      })
    } catch {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates.slice(0, MAX_LISTED_CLAUDE_SESSIONS).map((c) => ({
    sessionId: c.sessionId,
    title: extractSessionTitle(c.filePath) || '(无标题会话)',
    cwd,
    mtimeMs: c.mtimeMs,
    live: params.liveIds.has(c.sessionId),
    owned: c.owned,
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
  private readonly owners: ClaudeTerminalOwners
  // Keyed by sessionId: a user may hold several concurrent sessions (up to the
  // per-user cap), so userId can no longer be the key.
  private readonly sessions = new Map<string, ActiveTerminalSession>()

  constructor(private readonly opts: ClaudeTerminalManagerOptions) {
    this.spawn = opts.spawn ?? (pty.spawn as unknown as PtySpawn)
    this.env = opts.env ?? process.env
    this.owners = new ClaudeTerminalOwners(
      opts.ownersPath ?? resolveClaudeTerminalOwnersPath(this.env),
      opts.logger,
    )
  }

  handleConnection(
    ws: WebSocket,
    userId: string,
    opts: { action?: ClaudeTerminalConnectAction; sessionId?: string } = {},
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

    let action = opts.action
    const sessionId = opts.sessionId

    // Cold start (no action, no target): re-attach the user's most recent live
    // session if any, otherwise start a fresh one.
    if (!action && !sessionId) {
      const recent = this.mostRecentLiveSession(userId)
      if (recent) {
        this.attachClient(recent, ws)
        return
      }
      action = 'new'
    }

    if (action === 'attach' || (!action && sessionId)) {
      this.handleAttach(ws, userId, sessionId)
      return
    }
    this.handleNew(ws, userId)
  }

  // Attach to a session: re-attach if it has a live PTY, otherwise `claude --resume` it.
  private handleAttach(ws: WebSocket, userId: string, sessionId: string | undefined): void {
    if (!isValidClaudeSessionId(sessionId)) {
      sendJson(ws, { type: 'status', state: 'error', message: 'Invalid Claude session id' })
      ws.close(1008, 'invalid session id')
      return
    }
    const id = sessionId.trim()
    const existing = this.sessions.get(id)
    if (existing && !existing.closed) {
      // A live PTY is held by whoever spawned it; only that user may re-attach,
      // otherwise two users would share one process writing one transcript.
      if (existing.userId !== userId) {
        sendJson(ws, { type: 'status', state: 'error', message: '该会话正被其他用户使用' })
        ws.close(1008, 'forbidden')
        return
      }
      this.attachClient(existing, ws)
      return
    }
    // Resume from disk — allowed for the owner or any legacy (unowned) session.
    if (!this.owners.isVisibleTo(id, userId)) {
      sendJson(ws, { type: 'status', state: 'error', message: '无权访问该会话' })
      ws.close(1008, 'forbidden')
      return
    }
    if (!this.underCap(userId)) {
      this.rejectCap(ws, userId)
      return
    }
    const session = this.startSession(ws, userId, { resumeSessionId: id })
    if (session) this.attachClient(session, ws)
  }

  private handleNew(ws: WebSocket, userId: string): void {
    if (!this.underCap(userId)) {
      this.rejectCap(ws, userId)
      return
    }
    const session = this.startSession(ws, userId, { newSessionId: randomUUID() })
    if (session) this.attachClient(session, ws)
  }

  private rejectCap(ws: WebSocket, userId: string): void {
    const max = resolveMaxSessionsPerUser(this.env)
    this.opts.logger.info('official claude terminal session cap reached', { userId, max })
    sendJson(ws, {
      type: 'status',
      state: 'error',
      message: `最多同时运行 ${max} 个会话，请先终止或删除一个`,
    })
    ws.close(1013, 'session limit')
  }

  // Spawn + register a session; on failure send an error frame and return null.
  private startSession(
    ws: WebSocket,
    userId: string,
    spawnOpts: { newSessionId?: string; resumeSessionId?: string },
  ): ActiveTerminalSession | null {
    try {
      const session = this.createSession(userId, spawnOpts)
      this.sessions.set(session.sessionId, session)
      this.opts.logger.info('official claude terminal started', {
        userId,
        sessionId: session.sessionId,
        cwd: session.cwd,
        command: session.command,
        resume: spawnOpts.resumeSessionId,
      })
      return session
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.opts.logger.warn('official claude terminal spawn failed', { userId, message })
      sendJson(ws, { type: 'status', state: 'error', message })
      ws.close(1011, 'spawn failed')
      return null
    }
  }

  terminate(userId: string, sessionId: string): boolean {
    if (!isValidClaudeSessionId(sessionId)) return false
    const session = this.sessions.get(sessionId.trim())
    if (!session || session.closed) return false
    if (session.userId !== userId) return false
    this.closeSession(session, 'client terminate', true, true)
    return true
  }

  // Kill any live PTY and delete the on-disk transcript + ownership record.
  deleteSession(userId: string, sessionId: string): { deleted: boolean; terminated: boolean } {
    if (!isValidClaudeSessionId(sessionId)) throw new Error('invalid Claude session id')
    const id = sessionId.trim()
    const live = this.sessions.get(id)
    const isLive = !!live && !live.closed
    if (isLive) {
      // A running session belongs to whoever spawned it.
      if (live.userId !== userId) throw new ClaudeTerminalForbiddenError()
    } else if (!this.owners.isVisibleTo(id, userId)) {
      throw new ClaudeTerminalForbiddenError()
    }
    let terminated = false
    if (isLive) {
      this.closeSession(live, 'client delete', true, true)
      terminated = true
    }
    try {
      unlinkSync(resolveClaudeSessionTranscriptPath(id, this.env))
    } catch (err) {
      // Only a missing file counts as "already gone"; any other error must NOT
      // drop ownership, or an owned session would silently downgrade to legacy.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    this.owners.remove(id)
    this.opts.logger.info('official claude terminal deleted', { userId, sessionId: id, terminated })
    return { deleted: true, terminated }
  }

  ownerOf(sessionId: string): string | undefined {
    return this.owners.ownerOf(sessionId)
  }

  // Session ids with a live PTY, optionally scoped to one owner.
  liveSessionIds(userId?: string): Set<string> {
    const ids = new Set<string>()
    for (const session of this.sessions.values()) {
      if (session.closed) continue
      if (userId !== undefined && session.userId !== userId) continue
      ids.add(session.sessionId)
    }
    return ids
  }

  private liveCountForUser(userId: string): number {
    let n = 0
    for (const session of this.sessions.values()) {
      if (!session.closed && session.userId === userId) n++
    }
    return n
  }

  private underCap(userId: string): boolean {
    return this.liveCountForUser(userId) < resolveMaxSessionsPerUser(this.env)
  }

  private mostRecentLiveSession(userId: string): ActiveTerminalSession | null {
    let best: ActiveTerminalSession | null = null
    for (const session of this.sessions.values()) {
      if (session.closed || session.userId !== userId) continue
      if (!best || session.createdAt > best.createdAt) best = session
    }
    return best
  }

  workingDirectory(_userId: string): string {
    // All terminals share one cwd, so the result is the same for every user.
    return resolveOfficialClaudeCwd(this.env)
  }

  readTranscript(userId: string, sessionId: string, before?: number): ClaudeTranscriptPage {
    if (!isValidClaudeSessionId(sessionId)) throw new Error('invalid Claude session id')
    const id = sessionId.trim()
    const live = this.sessions.get(id)
    if (live && !live.closed) {
      if (live.userId !== userId) throw new ClaudeTerminalForbiddenError()
    } else if (!this.owners.isVisibleTo(id, userId)) {
      throw new ClaudeTerminalForbiddenError()
    }
    try {
      return readClaudeSessionTranscriptPage(id, before, this.env)
    } catch (err) {
      // A newly spawned official CLI does not create its JSONL until the first prompt.
      if (live && !live.closed && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { entries: [], before: null, fileSize: 0 }
      }
      throw err
    }
  }

  shutdown(reason = 'shutdown'): void {
    for (const session of [...this.sessions.values()])
      this.closeSession(session, reason, true, true)
    this.sessions.clear()
  }

  activeCount(): number {
    return this.sessions.size
  }

  private createSession(
    userId: string,
    spawnOpts: { newSessionId?: string; resumeSessionId?: string },
  ): ActiveTerminalSession {
    const sessionId = (spawnOpts.newSessionId ?? spawnOpts.resumeSessionId ?? '').trim()
    if (!isValidClaudeSessionId(sessionId)) throw new Error('missing Claude session id')
    const command = resolveOfficialClaudePath(this.env)
    if (command.startsWith('/') && !existsSync(command)) {
      throw new Error(`Claude executable not found: ${command}`)
    }
    const cwd = resolveOfficialClaudeCwd(this.env)
    // Record ownership of a NEW session BEFORE spawning: if the registry write
    // fails we abort here rather than leave a live, unowned (world-visible) PTY.
    if (spawnOpts.newSessionId) this.owners.record(sessionId, userId)
    const proc = this.spawn(command, buildOfficialClaudeArgs(spawnOpts), {
      name: 'xterm-256color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
      env: buildOfficialClaudeEnv(this.env),
    })

    const session: ActiveTerminalSession = {
      sessionId,
      userId,
      createdAt: Date.now(),
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
      sessionId: session.sessionId,
      message: `Claude Code terminal ${session.outputBytes > 0 ? 'resumed' : 'started'} in ${session.cwd}`,
    })
    const replay = this.replayOutput(session)
    if (replay) sendJson(ws, { type: 'replay', data: replay })
    session.ws = ws
  }

  private isActiveClient(session: ActiveTerminalSession, ws: WebSocket): boolean {
    return this.sessions.get(session.sessionId) === session && session.ws === ws && !session.closed
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
      if (this.sessions.get(session.sessionId) !== session) return
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
    // Drop the live PTY; ownership of the on-disk transcript persists (only
    // deleteSession removes it) so the session stays listable as history.
    if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId)

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
          { userId: session.userId, sessionId: session.sessionId, reason },
          err,
        )
      }
    }
    this.opts.logger.info('official claude terminal closed', {
      userId: session.userId,
      sessionId: session.sessionId,
      reason,
    })
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
