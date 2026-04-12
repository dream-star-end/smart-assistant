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
  cwd: string
  env: Record<string, string>
  stdio: ['pipe', 'pipe', 'pipe']
  detached?: boolean
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

export class DockerBackend implements TerminalBackend {
  constructor(private config: TerminalBackendConfig) {}

  spawn(opts: SpawnOpts): ChildProcessWithoutNullStreams {
    const dockerArgs = ['run', '--rm', '-i']

    // Working directory
    dockerArgs.push('-w', '/workspace')

    // Volumes
    if (this.config.volumes) {
      for (const v of this.config.volumes) dockerArgs.push('-v', v)
    }
    // Always mount cwd as /workspace
    dockerArgs.push('-v', `${opts.cwd}:/workspace`)

    // Environment variables
    const allowlist = new Set(this.config.envAllowlist ?? [])
    for (const [key, val] of Object.entries(opts.env)) {
      // Always pass through essential OpenClaude env vars
      if (
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
    if (this.config.timeoutMs) {
      dockerArgs.push('--stop-timeout', String(Math.ceil(this.config.timeoutMs / 1000)))
    }

    // Image
    dockerArgs.push(this.config.image || 'node:20-slim')

    // Command
    dockerArgs.push(opts.command, ...opts.args)

    return spawn('docker', dockerArgs, {
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
  console.warn(`[terminal] unknown backend type "${config.type}", falling back to local`)
  return new LocalBackend()
}
