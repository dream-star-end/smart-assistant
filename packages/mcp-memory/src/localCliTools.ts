/**
 * Synchronous local CLI tools for Antigravity (OCV5-522).
 *
 * Antigravity's native `run_command` backgrounds after at most 10s
 * (`WaitMsBeforeAsync` 500–10000). These handlers run in the MCP process and
 * return stdout/stderr/exit in the same `tools/call`, so a command can finish
 * inside the turn. `oc_grep` / `oc_glob` call `rg` with an argv array — the
 * pattern is never interpolated into a shell.
 *
 * A stdio MCP server handles one request at a time, so the timeout is capped.
 * index.ts lists and dispatches these tools only when isLocalCliToolEnabled
 * is true (OPENCLAUDE_ENGINE=antigravity). Other engines keep their native
 * shell so this path cannot bypass PreToolUse.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter } from 'node:path'

export const OC_BASH_DEFAULT_TIMEOUT_MS = 60_000
export const OC_BASH_MIN_TIMEOUT_MS = 1_000
/** Antigravity CLI 1.4.0 cancels an MCP tools/call at 180s. Stay under that so our timeout fires first and returns partial output. */
export const OC_BASH_MAX_TIMEOUT_MS = 170_000
export const OC_BASH_MAX_OUTPUT_BYTES = 200 * 1024
export const OC_GREP_DEFAULT_MAX_MATCHES = 80
export const OC_GREP_MAX_MATCHES = 200
export const OC_GLOB_DEFAULT_MAX_RESULTS = 200
export const OC_GLOB_MAX_RESULTS = 500

/** Names gated by isLocalCliToolEnabled. Keep in lockstep with toolDefs. */
export const LOCAL_CLI_TOOL_NAMES = ['oc_bash', 'oc_grep', 'oc_glob'] as const

export type LocalCliToolName = (typeof LOCAL_CLI_TOOL_NAMES)[number]

const LOCAL_CLI_TOOL_NAME_SET: ReadonlySet<string> = new Set(LOCAL_CLI_TOOL_NAMES)

export function isLocalCliToolName(name: string): name is LocalCliToolName {
  return LOCAL_CLI_TOOL_NAME_SET.has(name)
}

/** True only for the already-normalized engine id `antigravity`. */
export function isLocalCliToolEnabled(engineId: string): boolean {
  return engineId === 'antigravity'
}

const RG_CANDIDATES = ['/usr/bin/rg', '/usr/local/bin/rg', '/run/oc/platform/current/bin/rg']
const KILL_GRACE_MS = 400

export interface ToolTextResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface RunCapturedSpec {
  bin: string
  args: string[]
  cwd?: string
  timeoutMs: number
  maxBytes: number
}

export interface RunCapturedResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  truncated: boolean
  spawnError?: string
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function textResult(text: string, isError = false): ToolTextResult {
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] }
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {}
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function resolveRgBin(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  for (const candidate of RG_CANDIDATES) {
    if (await isExecutable(candidate)) return candidate
  }
  const pathValue = env.PATH ?? ''
  for (const dir of pathValue.split(delimiter)) {
    if (!dir.startsWith('/')) continue
    const candidate = `${dir.replace(/\/+$/, '')}/rg`
    if (await isExecutable(candidate)) return candidate
  }
  return null
}

export function ocGrepArgv(
  rg: string,
  input: { pattern: string; path?: string; glob?: string; maxMatches: number },
): string[] {
  const args = [
    rg,
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--max-count',
    String(input.maxMatches),
  ]
  if (input.glob) args.push('--glob', input.glob)
  args.push('--', input.pattern)
  if (input.path) args.push(input.path)
  return args
}

export function ocGlobArgv(rg: string, input: { pattern: string; path?: string }): string[] {
  const args = [
    rg,
    '--files',
    '--hidden',
    '--iglob',
    input.pattern,
    '--glob',
    '!.git/**',
    '--color',
    'never',
  ]
  if (input.path) args.push('--', input.path)
  return args
}

function takeBytes(buf: Buffer, acc: Buffer[], count: number, maxBytes: number): { count: number; truncated: boolean } {
  if (count >= maxBytes) return { count, truncated: true }
  const room = maxBytes - count
  if (buf.length <= room) {
    acc.push(buf)
    return { count: count + buf.length, truncated: false }
  }
  acc.push(buf.subarray(0, room))
  return { count: maxBytes, truncated: true }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (!pid || pid <= 0) return
  try {
    process.kill(-pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* already gone */ }
  }
}

/** Group leaders of detached oc_* children. The MCP timer dies with this process. */
const activeProcessGroups = new Set<number>()
let processGroupCleanupInstalled = false

function killTrackedProcessGroups(signal: NodeJS.Signals): void {
  for (const pid of activeProcessGroups) {
    try {
      process.kill(-pid, signal)
    } catch {
      /* already gone */
    }
  }
}

function installProcessGroupCleanup(): void {
  if (processGroupCleanupInstalled) return
  processGroupCleanupInstalled = true
  process.on('exit', () => {
    killTrackedProcessGroups('SIGKILL')
  })
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const onSignal = () => {
      killTrackedProcessGroups('SIGKILL')
      process.removeListener(sig, onSignal)
      process.kill(process.pid, sig)
    }
    process.on(sig, onSignal)
  }
}

function trackProcessGroup(pid: number): void {
  activeProcessGroups.add(pid)
  installProcessGroupCleanup()
}

function untrackProcessGroup(pid: number | undefined): void {
  if (pid && pid > 0) activeProcessGroups.delete(pid)
}

/** `detached` puts the child in its own process group so a timeout can signal `bash -lc` and its sleep/rg child. */
export function runCaptured(spec: RunCapturedSpec): Promise<RunCapturedResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: RunCapturedResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let child: ChildProcess
    try {
      child = spawn(spec.bin, spec.args, {
        cwd: spec.cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      })
      if (child.pid && child.pid > 0) trackProcessGroup(child.pid)
    } catch (err) {
      finish({
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
        timedOut: false,
        truncated: false,
        spawnError: err instanceof Error ? err.message : String(err),
      })
      return
    }

    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let truncated = false
    // Keep reading after the cap. Pausing the pipe would stall the child and the timeout would fire late.
    child.stdout?.on('data', (chunk: Buffer) => {
      const next = takeBytes(chunk, outChunks, outBytes, spec.maxBytes)
      outBytes = next.count
      if (next.truncated) truncated = true
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const next = takeBytes(chunk, errChunks, errBytes, spec.maxBytes)
      errBytes = next.count
      if (next.truncated) truncated = true
    })

    let timedOut = false
    let killTimer: NodeJS.Timeout | null = null
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child, 'SIGTERM')
      killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS)
    }, spec.timeoutMs)

    const snapshot = (extra: Partial<RunCapturedResult>): RunCapturedResult => ({
      stdout: Buffer.concat(outChunks).toString('utf8'),
      stderr: Buffer.concat(errChunks).toString('utf8'),
      exitCode: null,
      signal: null,
      timedOut,
      truncated,
      ...extra,
    })

    const forget = () => untrackProcessGroup(child.pid)
    child.on('error', (err) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      forget()
      finish(snapshot({ spawnError: err.message }))
    })
    child.on('close', (code, signal) => {
      // The shell can close while a TERM-ignoring descendant has redirected its pipes.
      // Finish timeout escalation before dropping this process group.
      if (timedOut) killGroup(child, 'SIGKILL')
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      forget()
      finish(snapshot({ exitCode: code, signal }))
    })
  })
}

function optionalCwd(value: unknown): string | undefined {
  const cwd = asText(value).trim()
  return cwd || undefined
}

export async function handleOcBash(args: unknown): Promise<ToolTextResult> {
  const input = asRecord(args)
  const command = asText(input.command).trim()
  if (!command) return textResult('oc_bash: command 不能为空', true)
  const timeoutMs = clampInt(
    input.timeout_ms,
    OC_BASH_DEFAULT_TIMEOUT_MS,
    OC_BASH_MIN_TIMEOUT_MS,
    OC_BASH_MAX_TIMEOUT_MS,
  )
  const outcome = await runCaptured({
    bin: '/bin/bash',
    args: ['-lc', command],
    cwd: optionalCwd(input.cwd),
    timeoutMs,
    maxBytes: OC_BASH_MAX_OUTPUT_BYTES,
  })
  if (outcome.spawnError && !outcome.timedOut) {
    return textResult(`oc_bash: 启动失败: ${outcome.spawnError}`, true)
  }
  const bits = [`exit=${outcome.exitCode ?? 'none'}`]
  if (outcome.signal) bits.push(`signal=${outcome.signal}`)
  if (outcome.timedOut) bits.push(`timed out after ${timeoutMs}ms`)
  if (outcome.truncated) bits.push('truncated')
  const stdout = outcome.stdout.replace(/\s+$/, '')
  const stderr = outcome.stderr.replace(/\s+$/, '')
  let text = bits.join(' ')
  if (stdout) text += `\n${stdout}`
  if (stderr) text += `\n--- stderr ---\n${stderr}`
  return textResult(text, outcome.timedOut || Boolean(outcome.spawnError))
}

async function rgBinOrError(
  deps: { rgBin?: string | null } | undefined,
): Promise<string | ToolTextResult> {
  const rg = deps && 'rgBin' in deps ? deps.rgBin ?? null : await resolveRgBin()
  if (!rg) return textResult('找不到 rg', true)
  return rg
}

function clipLines(text: string, maxLines: number): { text: string; clipped: boolean } {
  const lines = text.replace(/\s+$/, '').split('\n').filter((line) => line.length > 0)
  if (lines.length <= maxLines) return { text: lines.join('\n'), clipped: false }
  return { text: lines.slice(0, maxLines).join('\n'), clipped: true }
}

export async function handleOcGrep(
  args: unknown,
  deps?: { rgBin?: string | null },
): Promise<ToolTextResult> {
  const input = asRecord(args)
  const pattern = asText(input.pattern)
  if (!pattern) return textResult('oc_grep: pattern 不能为空', true)
  const rg = await rgBinOrError(deps)
  if (typeof rg !== 'string') return rg
  const maxMatches = clampInt(
    input.max_matches,
    OC_GREP_DEFAULT_MAX_MATCHES,
    1,
    OC_GREP_MAX_MATCHES,
  )
  const path = asText(input.path).trim()
  const glob = asText(input.glob).trim()
  const argv = ocGrepArgv(rg, {
    pattern,
    maxMatches,
    ...(path ? { path } : {}),
    ...(glob ? { glob } : {}),
  })
  const outcome = await runCaptured({
    bin: argv[0]!,
    args: argv.slice(1),
    timeoutMs: OC_BASH_DEFAULT_TIMEOUT_MS,
    maxBytes: OC_BASH_MAX_OUTPUT_BYTES,
  })
  if (outcome.spawnError) return textResult(`oc_grep: 启动失败: ${outcome.spawnError}`, true)
  if (outcome.timedOut) return textResult('oc_grep: timed out', true)
  if (outcome.exitCode === 1) return textResult('no matches')
  if (outcome.exitCode !== 0) {
    const detail = (outcome.stderr || outcome.stdout || `exit=${outcome.exitCode ?? 'none'}`).trim()
    return textResult(`oc_grep: ${detail}`, true)
  }
  const clipped = clipLines(outcome.stdout, maxMatches)
  const truncated = outcome.truncated || clipped.clipped
  const body = clipped.text || 'no matches'
  return textResult(truncated ? `${body}\n[truncated]` : body)
}

export async function handleOcGlob(
  args: unknown,
  deps?: { rgBin?: string | null },
): Promise<ToolTextResult> {
  const input = asRecord(args)
  const pattern = asText(input.pattern).trim()
  if (!pattern) return textResult('oc_glob: pattern 不能为空', true)
  const rg = await rgBinOrError(deps)
  if (typeof rg !== 'string') return rg
  const maxResults = clampInt(
    input.max_results,
    OC_GLOB_DEFAULT_MAX_RESULTS,
    1,
    OC_GLOB_MAX_RESULTS,
  )
  const path = asText(input.path).trim()
  const argv = ocGlobArgv(rg, { pattern, ...(path ? { path } : {}) })
  const outcome = await runCaptured({
    bin: argv[0]!,
    args: argv.slice(1),
    timeoutMs: OC_BASH_DEFAULT_TIMEOUT_MS,
    maxBytes: OC_BASH_MAX_OUTPUT_BYTES,
  })
  if (outcome.spawnError) return textResult(`oc_glob: 启动失败: ${outcome.spawnError}`, true)
  if (outcome.timedOut) return textResult('oc_glob: timed out', true)
  if (outcome.exitCode === 1) return textResult('no matches')
  if (outcome.exitCode !== 0) {
    const detail = (outcome.stderr || outcome.stdout || `exit=${outcome.exitCode ?? 'none'}`).trim()
    return textResult(`oc_glob: ${detail}`, true)
  }
  const clipped = clipLines(outcome.stdout, maxResults)
  const truncated = outcome.truncated || clipped.clipped
  const body = clipped.text || 'no matches'
  return textResult(truncated ? `${body}\n[truncated]` : body)
}
