/** Grok Bot box-resident official Claude Code, selected through the Cursor account pool.
 * The pool still picks the account. This module only decides when that
 * account's sandbox should own the CLI, and how stdin/stdout cross the exec
 * daemon without putting the user line on the command line. */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CursorCredentialSelection } from './cursorCredentialSelection.js'
import { readCursorApiKey } from './cursorSandRelay.js'
import {
  CursorSandBoxResolver,
  type CursorSandBoxPolicy,
} from './cursorSandBox.js'

export const BOX_CC_REMOTE_CLAUDE = '/home/box/.local/bin/claude'
export const BOX_CC_CWD = '/workspace'
export const BOX_CC_HOME = '/home/box'

const SAFE_FLAG = new Set(['--model', '--resume', '--permission-mode'])

export function cursorBoxCcEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OC_CURSOR_SAND_BOX_CC === '1'
}

/** Session slots are the logged-in Cursor accounts that own a Grok Bot box.
 * API-key slots stay on the existing in-container Sand loop. */
export function cursorBoxCcSelectionEligible(selection: CursorCredentialSelection): boolean {
  return selection.sandEnabled
    && selection.credentialKind === 'session'
    && selection.machineId !== null
}

export function boxCcFifoPath(sessionKey: string): string {
  const id = createHash('sha256').update(sessionKey).digest('hex').slice(0, 16)
  return `/tmp/oc-box-cc-${id}.fifo`
}

export function boxCcBridgePath(): string {
  const self = fileURLToPath(import.meta.url)
  return self.replace(/cursorBoxCc\.(ts|js)$/, 'cursorBoxCcBridge.$1')
}

/** Official stream-json argv that is safe to run inside the box.
 * Container paths (--add-dir, --settings, --mcp-config, prompt files) are dropped. */
export function remoteClaudeArgs(argv: readonly string[]): string[] {
  const out = [
    '-p',
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-prompt-tool',
    'stdio',
  ]
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!flag || !SAFE_FLAG.has(flag)) continue
    const value = argv[i + 1]
    if (!value || value.startsWith('-')) continue
    out.push(flag, value)
    i++
    if (flag === '--permission-mode' && value === 'bypassPermissions') {
      out.push('--dangerously-skip-permissions')
    }
  }
  return out
}

export const BOX_CC_LAUNCH_SCRIPT = [
  'set -eu',
  'fifo="$1"',
  'claude="$2"',
  'shift 2',
  'rm -f "$fifo"',
  'mkfifo -m 600 "$fifo"',
  'exec "$claude" "$@" < "$fifo"',
].join('\n')

export interface BoxCcExecRequest {
  command: string
  args: string[]
  cwd: string
  environment: Record<string, string>
}

export function boxCcLaunchExec(
  control: BoxCcControl,
  remoteArgs: readonly string[],
): BoxCcExecRequest {
  return {
    command: 'sh',
    args: ['-c', BOX_CC_LAUNCH_SCRIPT, 'sh', control.fifo, control.remoteClaude, ...remoteArgs],
    cwd: control.cwd,
    environment: {
      HOME: BOX_CC_HOME,
      PATH: '/home/box/.local/bin:/home/box/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      LANG: 'C.UTF-8',
    },
  }
}

export function boxCcWriteExec(control: BoxCcControl, line: string): BoxCcExecRequest {
  const text = line.endsWith('\n') ? line : `${line}\n`
  return {
    command: 'python3',
    args: ['-c', 'import os; open(os.environ["OC_BOX_CC_FIFO"], "a", encoding="utf-8").write(os.environ["OC_BOX_CC_LINE"])'],
    cwd: control.cwd,
    environment: {
      HOME: BOX_CC_HOME,
      OC_BOX_CC_FIFO: control.fifo,
      OC_BOX_CC_LINE: text,
    },
  }
}

const STRIPPED_PARENT_AUTH = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_CUSTOM_HEADERS',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
] as const

/** The local bridge must not inherit the container's Anthropic route.
 * The box process uses the login the user configures inside the box. */
export function stripBoxCcParentAuth(
  env: Record<string, string>,
  controlPath: string,
): Record<string, string> {
  const next = { ...env }
  for (const key of STRIPPED_PARENT_AUTH) delete next[key]
  next.OC_BOX_CC_CONTROL = controlPath
  return next
}

export interface BoxCcControl {
  execUrl: string
  execToken: string
  networkToken: string
  remoteClaude: string
  fifo: string
  cwd: string
}

export function boxCcControlSummary(control: BoxCcControl): {
  execHost: string
  remoteClaude: string
  fifo: string
  cwd: string
} {
  const host = new URL(control.execUrl).host
  return {
    execHost: host,
    remoteClaude: control.remoteClaude,
    fifo: control.fifo,
    cwd: control.cwd,
  }
}

export interface ExecFrame {
  kind: 'stdout' | 'stderr' | 'exit'
  data?: string
  code?: number
}

export function parseExecFrames(buffer: Buffer): { events: ExecFrame[]; rest: Buffer } {
  const events: ExecFrame[] = []
  let offset = 0
  while (offset + 5 <= buffer.length) {
    const length = buffer.readUInt32BE(offset + 1)
    if (length > 8 * 1024 * 1024) break
    if (offset + 5 + length > buffer.length) break
    const payload = buffer.subarray(offset + 5, offset + 5 + length)
    offset += 5 + length
    let parsed: unknown
    try {
      parsed = JSON.parse(payload.toString('utf8'))
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    const record = parsed as Record<string, unknown>
    const stdout = record.stdoutEvent ?? record.stdout_event
    const stderr = record.stderrEvent ?? record.stderr_event
    const exit = record.exitEvent ?? record.exit_event
    if (stdout && typeof stdout === 'object' && typeof (stdout as { data?: unknown }).data === 'string') {
      events.push({ kind: 'stdout', data: (stdout as { data: string }).data })
    } else if (stderr && typeof stderr === 'object' && typeof (stderr as { data?: unknown }).data === 'string') {
      events.push({ kind: 'stderr', data: (stderr as { data: string }).data })
    } else if (exit && typeof exit === 'object') {
      const code = (exit as { exitCode?: unknown; exit_code?: unknown }).exitCode
        ?? (exit as { exit_code?: unknown }).exit_code
      events.push({ kind: 'exit', code: typeof code === 'number' ? code : 0 })
    }
  }
  return { events, rest: buffer.subarray(offset) }
}

export function encodeExecRequest(body: BoxCcExecRequest): Buffer {
  const payload = Buffer.from(JSON.stringify(body))
  const out = Buffer.alloc(5 + payload.length)
  out[0] = 0
  out.writeUInt32BE(payload.length, 1)
  payload.copy(out, 5)
  return out
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export async function writeBoxCcControlFile(input: {
  selection: CursorCredentialSelection
  sessionKey: string
  dir?: string
  fetchImpl?: FetchFn
  readPolicy?: () => CursorSandBoxPolicy | null
  readToken?: () => Buffer
}): Promise<string> {
  if (!cursorBoxCcSelectionEligible(input.selection)) {
    throw new Error('BOX_CC_SESSION_REQUIRED')
  }
  const generation = input.selection.poolGeneration.startsWith('gen-')
    ? input.selection.poolGeneration
    : undefined
  const token = (input.readToken ?? (() => readCursorApiKey(
    input.selection.keyName,
    generation,
    input.selection.keyFingerprint,
  )))().toString('utf8').trim()
  const resolver = new CursorSandBoxResolver({
    accountId: input.selection.accountId,
    credentialKind: 'session',
    fetchImpl: input.fetchImpl ?? fetch,
    ...(input.readPolicy ? { readPolicy: input.readPolicy } : {}),
  })
  const execTarget = await resolver.resolveExec(
    token,
    input.selection.machineId as string,
    new AbortController().signal,
  )
  const control: BoxCcControl = {
    execUrl: execTarget.execUrl,
    execToken: execTarget.execToken,
    networkToken: execTarget.networkToken,
    remoteClaude: BOX_CC_REMOTE_CLAUDE,
    fifo: boxCcFifoPath(input.sessionKey),
    cwd: BOX_CC_CWD,
  }
  const dir = input.dir ?? join(tmpdir(), 'oc-box-cc')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `control-${createHash('sha256').update(input.sessionKey).digest('hex').slice(0, 12)}.json`)
  writeFileSync(path, JSON.stringify(control), { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

export function bridgeDirForLogs(): string {
  return dirname(boxCcBridgePath())
}
