import { existsSync, statSync } from 'node:fs'
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

interface ActiveTerminalSession {
  userId: string
  ws: WebSocket
  pty: PtyLike
  close(reason: string): void
}

function isTruthyDisabled(value: string | undefined): boolean {
  if (!value) return false
  return ['0', 'false', 'no', 'off', 'disabled'].includes(value.trim().toLowerCase())
}

export function isClaudeTerminalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isTruthyDisabled(env.OPENCLAUDE_OFFICIAL_CLAUDE_TERMINAL)
}

export function clampTerminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const c = typeof cols === 'number' && Number.isFinite(cols) ? Math.trunc(cols) : DEFAULT_COLS
  const r = typeof rows === 'number' && Number.isFinite(rows) ? Math.trunc(rows) : DEFAULT_ROWS
  return {
    cols: Math.max(MIN_COLS, Math.min(MAX_COLS, c)),
    rows: Math.max(MIN_ROWS, Math.min(MAX_ROWS, r)),
  }
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

export class ClaudeTerminalManager {
  private readonly spawn: PtySpawn
  private readonly env: NodeJS.ProcessEnv
  private readonly sessions = new Map<string, ActiveTerminalSession>()

  constructor(private readonly opts: ClaudeTerminalManagerOptions) {
    this.spawn = opts.spawn ?? (pty.spawn as unknown as PtySpawn)
    this.env = opts.env ?? process.env
  }

  handleConnection(ws: WebSocket, userId: string): void {
    if (!isClaudeTerminalEnabled(this.env)) {
      sendJson(ws, {
        type: 'status',
        state: 'disabled',
        message: 'Claude Code terminal is disabled',
      })
      ws.close(1013, 'disabled')
      return
    }

    this.sessions.get(userId)?.close('replaced')

    let proc: PtyLike
    let cwd: string
    let command: string
    try {
      command = resolveOfficialClaudePath(this.env)
      if (command.startsWith('/') && !existsSync(command)) {
        throw new Error(`Claude executable not found: ${command}`)
      }
      cwd = resolveOfficialClaudeCwd(this.env)
      proc = this.spawn(command, [], {
        name: 'xterm-256color',
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        cwd,
        env: buildOfficialClaudeEnv(this.env),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.opts.logger.warn('official claude terminal spawn failed', { userId, message })
      sendJson(ws, { type: 'status', state: 'error', message })
      ws.close(1011, 'spawn failed')
      return
    }

    this.opts.logger.info('official claude terminal started', { userId, cwd, command })
    sendJson(ws, {
      type: 'status',
      state: 'running',
      message: `Claude Code terminal started in ${cwd}`,
    })

    let closed = false
    let closeSession: (reason: string, killProcess: boolean) => void = () => {}
    const dataDisposable = proc.onData((data) => {
      sendJson(ws, { type: 'output', data })
    })
    const exitDisposable = proc.onExit((event) => {
      sendJson(ws, { type: 'exit', code: event.exitCode ?? null, signal: event.signal ?? null })
      closeSession('exit', false)
      try {
        ws.close(1000, 'process exited')
      } catch {}
    })

    closeSession = (reason: string, killProcess: boolean) => {
      if (closed) return
      closed = true
      this.sessions.delete(userId)
      try {
        dataDisposable.dispose()
      } catch {}
      try {
        exitDisposable.dispose()
      } catch {}
      if (killProcess) {
        try {
          proc.kill()
        } catch (err) {
          this.opts.logger.warn('official claude terminal kill failed', { userId, reason }, err)
        }
      }
      this.opts.logger.info('official claude terminal closed', { userId, reason })
    }

    const session: ActiveTerminalSession = {
      userId,
      ws,
      pty: proc,
      close: (reason) => {
        sendJson(ws, { type: 'status', state: 'closed', message: reason })
        closeSession(reason, true)
        try {
          ws.close(1000, reason)
        } catch {}
      },
    }
    this.sessions.set(userId, session)

    ws.on('message', (raw) => {
      if (rawDataBytes(raw) > CLAUDE_TERMINAL_MAX_CLIENT_MESSAGE_BYTES) {
        sendJson(ws, { type: 'status', state: 'error', message: 'Terminal message too large' })
        ws.close(1009, 'message too large')
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
      if (message.type === 'input') proc.write(message.data)
      else if (message.type === 'resize') proc.resize(message.cols, message.rows)
      else if (message.type === 'kill') session.close('client kill')
    })

    ws.once('close', () => closeSession('ws close', true))
    ws.once('error', (err) => {
      this.opts.logger.warn('official claude terminal websocket error', { userId }, err)
      closeSession('ws error', true)
    })
  }

  shutdown(reason = 'shutdown'): void {
    for (const session of [...this.sessions.values()]) session.close(reason)
    this.sessions.clear()
  }

  activeCount(): number {
    return this.sessions.size
  }
}

export function createClaudeTerminalManager(
  opts: ClaudeTerminalManagerOptions,
): ClaudeTerminalManager {
  return new ClaudeTerminalManager(opts)
}
