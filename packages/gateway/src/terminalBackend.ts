/**
 * Terminal Backend abstraction.
 *
 * Defines how CCB subprocesses are spawned — on the local machine or
 * inside a Docker container. The default is `local` which preserves
 * current behavior exactly.
 *
 * Future backends (ssh, remote node) can implement the same interface.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createLogger } from './logger.js'
import { PROXY_ENV_KEYS } from './proxyEnv.js'

const backendLog = createLogger({ module: 'terminalBackend' })

export interface TerminalBackendConfig {
  type: string // 'local' | 'docker' | future: 'ssh', 'remote'
  // ── Remote host (future extension point) ──
  // When type='ssh' or 'remote', specifies the target machine.
  // Not implemented yet — here to ensure config schema won't break when added.
  host?: string // e.g. "worker-1.example.com"
  port?: number // e.g. 22 for SSH
  user?: string // remote user
  keyPath?: string // SSH private key path
  // Docker-specific
  image?: string // e.g. "node:20-slim"
  volumes?: string[] // e.g. ["/home/user/projects:/workspace"]
  envAllowlist?: string[] // env vars to pass through
  timeoutMs?: number // container kill timeout
}

export interface SpawnOpts {
  command: string
  args: string[]
  cwd: string // CCB install path (used as container entrypoint cwd)
  env: Record<string, string>
  stdio: ['pipe', 'pipe', 'pipe']
  detached?: boolean
  agentCwd?: string // agent working directory (the real project dir)
}

export interface TerminalBackend {
  spawn(opts: SpawnOpts): ChildProcessWithoutNullStreams
}

// ── Local backend (default) ──

export class LocalBackend implements TerminalBackend {
  spawn(opts: SpawnOpts): ChildProcessWithoutNullStreams {
    return spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: opts.stdio,
      detached: opts.detached,
    })
  }
}

// ── Docker backend ──

/**
 * Pure docker-run argv builder, extracted from `DockerBackend.spawn` so it
 * can be unit-tested without monkey-patching `child_process` (whose ESM
 * exports are read-only). Mirrors the codebase convention of `buildCcbCliArgs`
 * and `buildCodexEnv`.
 *
 * Load-bearing invariant: proxy keys are forwarded as `-e KEY` (no value) so
 * the `user:pass` credential never appears in `docker run` argv (and hence
 * `ps` / `/proc/PID/cmdline`). Docker reads the value from its own env (set
 * via the `env:` field of the subsequent spawn call).
 */
export function buildDockerArgs(config: TerminalBackendConfig, opts: SpawnOpts): string[] {
  const dockerArgs = ['run', '--rm', '-i']

  // Working directory: mount CCB install path so the binary can run
  dockerArgs.push('-v', `${opts.cwd}:/opt/ccb`)
  // Mount agent working directory as /workspace (the real project dir)
  const agentDir = opts.agentCwd || opts.cwd
  dockerArgs.push('-v', `${agentDir}:/workspace`)
  dockerArgs.push('-w', '/workspace')

  // Extra volumes from config
  if (config.volumes) {
    for (const v of config.volumes) dockerArgs.push('-v', v)
  }

  // Environment variables
  // Proxy keys are checked FIRST so an operator who adds e.g. HTTPS_PROXY to
  // `envAllowlist` cannot accidentally re-introduce the `-e KEY=value` argv
  // leak. Inherit via `-e KEY` (no value) from docker CLI's own env.
  const proxyPassthrough = new Set<string>(PROXY_ENV_KEYS)
  const allowlist = new Set(config.envAllowlist ?? [])
  for (const [key, val] of Object.entries(opts.env)) {
    if (proxyPassthrough.has(key)) {
      dockerArgs.push('-e', key)
    } else if (
      // Always pass through essential OpenClaude env vars
      key.startsWith('OPENCLAUDE_') ||
      key === 'PATH' ||
      key === 'HOME' ||
      key === 'NODE_ENV' ||
      allowlist.has(key)
    ) {
      dockerArgs.push('-e', `${key}=${val}`)
    }
  }

  // Timeout
  if (config.timeoutMs) {
    dockerArgs.push('--stop-timeout', String(Math.ceil(config.timeoutMs / 1000)))
  }

  // Resource limits
  dockerArgs.push('--memory', '2g')
  dockerArgs.push('--cpus', '1.0')
  dockerArgs.push('--pids-limit', '512')

  // Image
  dockerArgs.push(config.image || 'node:20-slim')

  // Command
  dockerArgs.push(opts.command, ...opts.args)

  return dockerArgs
}

export class DockerBackend implements TerminalBackend {
  constructor(private config: TerminalBackendConfig) {}

  spawn(opts: SpawnOpts): ChildProcessWithoutNullStreams {
    return spawn('docker', buildDockerArgs(this.config, opts), {
      cwd: opts.cwd,
      env: opts.env,
      stdio: opts.stdio,
      detached: opts.detached,
    })
  }
}

// ── Factory ──

export function createBackend(config?: TerminalBackendConfig): TerminalBackend {
  if (!config || config.type === 'local') return new LocalBackend()
  if (config.type === 'docker') return new DockerBackend(config)
  backendLog.warn('unknown backend type, falling back to local', { type: config.type })
  return new LocalBackend()
}
