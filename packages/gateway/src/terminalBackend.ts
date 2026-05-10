/**
 * Terminal Backend abstraction.
 *
 * Defines how CCB subprocesses are spawned — on the local machine or
 * inside a Docker container. The default is `local` which preserves
 * current behavior exactly.
 *
 * Future backends (ssh, remote node) can implement the same interface.
 *
 * Phase 5 字段语义(三个 dir 的角色,易混要点):
 *   - ccbBinaryDir   : CCB(claude-code-best)二进制 / 入口文件所在目录。
 *                      Local 模式回退 cwd(若 caller 未给 subprocessCwd 时);
 *                      Docker 模式挂为 /opt/ccb,容器内进程从这里读 entry 文件。
 *   - workspaceHostDir: 项目工作目录(host 上的绝对路径)。
 *                      Docker 模式挂为 /workspace 并设为容器内默认 -w 目录。
 *                      Local 模式 caller 通常会同时把它作为 subprocessCwd 传入。
 *   - subprocessCwd  : (Phase 5 v1.0.x 新增)Local 模式子进程的真 cwd。
 *                      caller(SubprocessRunner / Codex 系 runner)负责按 repo
 *                      binding ready/未 ready 决定该值是 workspaceDir 还是
 *                      agentBaseDir。缺省回退 ccbBinaryDir(老行为)。
 *                      Docker 模式忽略此字段(容器 cwd 由 -w 控制)。
 *
 * 历史遗留:旧版 LocalBackend 把 cwd 硬编码为 ccbBinaryDir,导致 CCB / codex
 * 子进程的 process.cwd() 永远指向二进制所在目录,与系统提示中"Bash 默认 cwd
 * 已指向项目目录"自相矛盾。Phase 5 通过 subprocessCwd 字段修正这个语义错位。
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createLogger } from './logger.js'

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
  /** CCB 二进制 / 入口文件所在目录。Local: 子进程真 cwd;Docker: 挂为 /opt/ccb。 */
  ccbBinaryDir: string
  env: Record<string, string>
  stdio: ['pipe', 'pipe', 'pipe']
  detached?: boolean
  /** 项目工作目录(host 路径)。Docker 挂为 /workspace + -w。Local 模式由 CCB
   *  通过 --add-dir 等 CLI 参数识别为项目根,本身不作为 cwd(见 subprocessCwd)。 */
  workspaceHostDir?: string
  /** Local 模式子进程的真 cwd(host 路径)。caller 负责按 repo binding
   *  ready/未 ready 选择 workspaceDir 或 agentBaseDir。缺省 = ccbBinaryDir
   *  (老行为)。Docker 模式忽略(容器 cwd 由 -w 控制)。 */
  subprocessCwd?: string
}

export interface TerminalBackend {
  spawn(opts: SpawnOpts): ChildProcessWithoutNullStreams
}

// ── Local backend (default) ──

export class LocalBackend implements TerminalBackend {
  spawn(opts: SpawnOpts): ChildProcessWithoutNullStreams {
    // subprocessCwd 优先(Phase 5 caller 显式指定项目目录);缺省退回 ccbBinaryDir
    // 保持老行为,避免不传 subprocessCwd 的 caller(若有)出现意外破坏。
    return spawn(opts.command, opts.args, {
      cwd: opts.subprocessCwd ?? opts.ccbBinaryDir,
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

    // Mount CCB install path so the binary can run
    dockerArgs.push('-v', `${opts.ccbBinaryDir}:/opt/ccb`)
    // Mount agent working directory as /workspace (the real project dir)
    const workspaceDir = opts.workspaceHostDir || opts.ccbBinaryDir
    dockerArgs.push('-v', `${workspaceDir}:/workspace`)
    dockerArgs.push('-w', '/workspace')

    // Extra volumes from config
    if (this.config.volumes) {
      for (const v of this.config.volumes) dockerArgs.push('-v', v)
    }

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

    // Resource limits
    dockerArgs.push('--memory', '2g')
    dockerArgs.push('--cpus', '1.0')
    dockerArgs.push('--pids-limit', '512')

    // Image
    dockerArgs.push(this.config.image || 'node:20-slim')

    // Command
    dockerArgs.push(opts.command, ...opts.args)

    return spawn('docker', dockerArgs, {
      cwd: opts.ccbBinaryDir,
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
