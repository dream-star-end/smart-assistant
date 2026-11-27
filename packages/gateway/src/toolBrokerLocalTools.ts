/**
 * OCV5-915 P3-2 — Default Local MCP Tool Handlers for `GatewayToolBrokerRuntime` (`rt-misc` rank 2).
 *
 * Enforces Steward S2: every local MCP tool (`oc_bash`, `oc_read`, `oc_grep`, `oc_glob`,
 * `oc_find`, `oc_tree`) resolves default `cwd` and relative `cwd`/`path` arguments strictly
 * against the authoritative turn/session `workspaceCwd`, never leaking Gateway's `process.cwd()`.
 * Zero syncIo / process.env / emptyCatch / typeEscape.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { JobLifecycleClass } from '@openclaude/protocol'
import { scrubToolBrokerEnv } from '@openclaude/protocol/exec-env'
import type { RegisteredToolDefinition, ToolExecutionContext } from './execEnv/index.js'
import { killJobGroup, type BrokerBashJobManager } from './toolBrokerBashJobs.js'

const MAX_LOCAL_TOOL_OUTPUT_BYTES = 1024 * 1024
const VALID_LIFECYCLE_CLASSES: ReadonlySet<string> = new Set([
  'ephemeral_turn',
  'managed_job',
  'daemon_service',
])

export function resolveBrokerWorkspacePath(
  rawPath: unknown,
  workspaceCwd: string | undefined,
): string | undefined {
  const trimmed = typeof rawPath === 'string' ? rawPath.trim() : ''
  if (trimmed.length > 0) {
    return workspaceCwd ? resolve(workspaceCwd, trimmed) : trimmed
  }
  return workspaceCwd
}

function appendCappedBytes(chunk: Buffer, arr: Buffer[], cur: number): number {
  if (cur >= MAX_LOCAL_TOOL_OUTPUT_BYTES) return cur
  const room = MAX_LOCAL_TOOL_OUTPUT_BYTES - cur
  const slice = chunk.byteLength <= room ? chunk : chunk.subarray(0, room)
  arr.push(slice)
  return cur + slice.byteLength
}

async function runSpawnCaptured(
  bin: string,
  args: readonly string[],
  opts: {
    readonly cwd?: string
    readonly env: Record<string, string>
    readonly signal: AbortSignal
    readonly timeoutMs: number
    readonly onStdout?: (chunk: string) => void
    readonly onStderr?: (chunk: string) => void
  },
): Promise<{
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
  readonly signal: string | null
}> {
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true
        fn()
      }
    }
    let child: ChildProcess
    try {
      child = spawn(bin, [...args], {
        cwd: opts.cwd,
        env: opts.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      rejectPromise(err instanceof Error ? err : new Error(String(err)))
      return
    }
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes = appendCappedBytes(chunk, outChunks, outBytes)
      opts.onStdout?.(chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      errBytes = appendCappedBytes(chunk, errChunks, errBytes)
      opts.onStderr?.(chunk.toString('utf8'))
    })
    const terminate = (reason: string) => {
      killJobGroup(child, 'SIGTERM')
      setTimeout(() => killJobGroup(child, 'SIGKILL'), 1500).unref()
      finish(() => rejectPromise(new Error(reason)))
    }
    const onAbort = () => terminate(String(opts.signal.reason ?? 'TOOL_CALL_CANCELLED'))
    if (opts.signal.aborted) {
      onAbort()
      return
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => terminate(`TOOL_CALL_TIMEOUT:${opts.timeoutMs}ms`), opts.timeoutMs)
    timer.unref()
    child.on('error', (err) => {
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
      finish(() => rejectPromise(err))
    })
    child.on('close', (code, sig) => {
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
      finish(() =>
        resolvePromise({
          stdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
          exitCode: code,
          signal: sig,
        }),
      )
    })
  })
}

async function walkDirectoryEntries(
  rootDir: string,
  maxDepth: number,
  maxEntries: number,
): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || out.length >= maxEntries) return
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const ent of entries) {
      if (out.length >= maxEntries) break
      if (ent.name === '.git' || ent.name === 'node_modules') continue
      const full = join(dir, ent.name)
      out.push(ent.isDirectory() ? `${relative(rootDir, full)}/` : relative(rootDir, full))
      if (ent.isDirectory() && !ent.isSymbolicLink() && depth < maxDepth) {
        await walk(full, depth + 1)
      }
    }
  }
  await walk(rootDir, 0)
  return out
}

export interface BrokerLocalToolsDeps {
  readonly registerTool: (def: RegisteredToolDefinition) => void
  readonly bashJobs: BrokerBashJobManager
  readonly baseToolEnv: Readonly<Record<string, string | undefined>>
  readonly resolveWorkspaceCwd: (ctx: ToolExecutionContext) => string | undefined
}

function clampBrokerInt(val: unknown, fallback: number, min: number, max: number): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback
  return Math.max(min, Math.min(max, Math.floor(val)))
}

function buildOcBashTool(deps: BrokerLocalToolsDeps): RegisteredToolDefinition {
  return {
    canonicalName: 'oc_bash',
    description: 'Broker-governed resumable shell command execution with scrubbed broker env',
    readOnly: false,
    isShell: true,
    handler: async (args, ctx) => {
      const command = typeof args.command === 'string' ? args.command.trim() : ''
      const jobId = typeof args.job_id === 'string' ? args.job_id.trim() : ''
      if (!command && !jobId) throw new Error('oc_bash: command or job_id is required')
      const rawAction = typeof args.action === 'string' ? args.action.trim() : 'wait'
      const action: 'wait' | 'status' | 'kill' =
        rawAction === 'status' || rawAction === 'kill' ? rawAction : 'wait'
      const cwd = resolveBrokerWorkspacePath(args.cwd, deps.resolveWorkspaceCwd(ctx))
      const timeoutMs = clampBrokerInt(args.timeout_ms, 60_000, 50, 600_000)
      const rawLc = typeof args.lifecycle_class === 'string' ? args.lifecycle_class.trim() : ''
      const lifecycleClass: JobLifecycleClass = VALID_LIFECYCLE_CLASSES.has(rawLc)
        ? (rawLc as JobLifecycleClass)
        : 'ephemeral_turn'
      return await deps.bashJobs.execute({
        sessionKey: ctx.sessionKey,
        turnId: ctx.turnId,
        leaseId: ctx.leaseId,
        ...(command ? { command } : {}),
        ...(jobId ? { jobId } : {}),
        action,
        cwd,
        timeoutMs,
        killOnTimeout: args.kill_on_timeout === true,
        lifecycleClass,
        env: scrubToolBrokerEnv(deps.baseToolEnv),
        signal: ctx.signal,
        onStdout: ctx.emitStdout,
        onStderr: ctx.emitStderr,
      })
    },
  }
}

function buildOcReadTool(deps: BrokerLocalToolsDeps): RegisteredToolDefinition {
  return {
    canonicalName: 'oc_read',
    description: 'Broker-governed file read',
    readOnly: true,
    handler: async (args, ctx) => {
      const rawTarget = typeof args.path === 'string' ? args.path.trim() : ''
      if (!rawTarget) throw new Error('oc_read: path is required')
      const target = resolveBrokerWorkspacePath(rawTarget, deps.resolveWorkspaceCwd(ctx)) ?? rawTarget
      const st = await lstat(target)
      if (!st.isFile() || st.isSymbolicLink()) throw new Error('oc_read: not a regular file')
      return await readFile(target, 'utf8')
    },
  }
}

function buildOcGrepTool(deps: BrokerLocalToolsDeps): RegisteredToolDefinition {
  return {
    canonicalName: 'oc_grep',
    description: 'Broker-governed ripgrep content search',
    readOnly: true,
    handler: async (args, ctx) => {
      const pattern = typeof args.pattern === 'string' ? args.pattern : ''
      if (!pattern) throw new Error('oc_grep: pattern is required')
      const maxMatches = clampBrokerInt(args.max_matches, 80, 1, 200)
      const workspaceCwd = deps.resolveWorkspaceCwd(ctx)
      const argv = ['--line-number', '--no-heading', '--color', 'never', '--max-count', String(maxMatches)]
      if (typeof args.glob === 'string' && args.glob.trim()) argv.push('--glob', args.glob.trim())
      argv.push('--', pattern)
      if (typeof args.path === 'string' && args.path.trim()) {
        const resolved = resolveBrokerWorkspacePath(args.path, workspaceCwd)
        if (resolved) argv.push(resolved)
      }
      const res = await runSpawnCaptured('rg', argv, {
        cwd: workspaceCwd,
        env: scrubToolBrokerEnv(deps.baseToolEnv),
        signal: ctx.signal,
        timeoutMs: 60_000,
      })
      if (res.exitCode === 1) return 'no matches'
      if (res.exitCode !== 0) {
        throw new Error((res.stderr || res.stdout || `rg exit=${res.exitCode ?? 'none'}`).trim())
      }
      return res.stdout.replace(/\s+$/, '') || 'no matches'
    },
  }
}

function buildOcGlobTool(deps: BrokerLocalToolsDeps): RegisteredToolDefinition {
  return {
    canonicalName: 'oc_glob',
    description: 'Broker-governed ripgrep file glob',
    readOnly: true,
    handler: async (args, ctx) => {
      const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : ''
      if (!pattern) throw new Error('oc_glob: pattern is required')
      const maxResults = clampBrokerInt(args.max_results, 200, 1, 500)
      const workspaceCwd = deps.resolveWorkspaceCwd(ctx)
      const argv = ['--files', '--hidden', '--iglob', pattern, '--glob', '!.git/**', '--color', 'never']
      if (typeof args.path === 'string' && args.path.trim()) {
        const resolved = resolveBrokerWorkspacePath(args.path, workspaceCwd)
        if (resolved) argv.push('--', resolved)
      }
      const res = await runSpawnCaptured('rg', argv, {
        cwd: workspaceCwd,
        env: scrubToolBrokerEnv(deps.baseToolEnv),
        signal: ctx.signal,
        timeoutMs: 60_000,
      })
      if (res.exitCode === 1) return 'no matches'
      if (res.exitCode !== 0) {
        throw new Error((res.stderr || res.stdout || `rg exit=${res.exitCode ?? 'none'}`).trim())
      }
      const lines = res.stdout.replace(/\s+$/, '').split('\n').filter(Boolean)
      return lines.length > maxResults
        ? `${lines.slice(0, maxResults).join('\n')}\n[truncated]`
        : lines.join('\n') || 'no matches'
    },
  }
}

function buildOcFindTool(deps: BrokerLocalToolsDeps): RegisteredToolDefinition {
  return {
    canonicalName: 'oc_find',
    description: 'Broker-governed recursive file discovery',
    readOnly: true,
    handler: async (args, ctx) => {
      const rootDir = resolve(resolveBrokerWorkspacePath(args.path, deps.resolveWorkspaceCwd(ctx)) ?? '.')
      const maxDepth = clampBrokerInt(args.max_depth, 4, 0, 8)
      const maxResults = clampBrokerInt(args.max_results, 200, 1, 500)
      return (await walkDirectoryEntries(rootDir, maxDepth, maxResults)).join('\n') || 'no matches'
    },
  }
}

function buildOcTreeTool(deps: BrokerLocalToolsDeps): RegisteredToolDefinition {
  return {
    canonicalName: 'oc_tree',
    description: 'Broker-governed workspace tree listing',
    readOnly: true,
    handler: async (args, ctx) => {
      const rootDir = resolve(resolveBrokerWorkspacePath(args.path, deps.resolveWorkspaceCwd(ctx)) ?? '.')
      const maxDepth = clampBrokerInt(args.max_depth, 3, 0, 6)
      return (await walkDirectoryEntries(rootDir, maxDepth, 250)).join('\n') || '(empty)'
    },
  }
}

export function registerDefaultBrokerLocalTools(deps: BrokerLocalToolsDeps): void {
  deps.registerTool(buildOcBashTool(deps))
  deps.registerTool(buildOcReadTool(deps))
  deps.registerTool(buildOcGrepTool(deps))
  deps.registerTool(buildOcGlobTool(deps))
  deps.registerTool(buildOcFindTool(deps))
  deps.registerTool(buildOcTreeTool(deps))
}
