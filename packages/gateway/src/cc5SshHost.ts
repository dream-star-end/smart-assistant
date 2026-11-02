/** v5-dev host-only transport. SSH exec stdio; Claude's PTY is created by the original host/tmux. */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, isAbsolute } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Cc5InteractiveHostPort } from './cc5Relay.js'

const CONTROLLER_SHA = '3f0ca5bfd44af013a7c056eb4305dbddd6713da586db097172b564ee39c0baa1'
const MAX_BODY = 131072
const MAX_FRAME = 262144
const FAILED = 'CC5_INTERACTIVE_SSH_FAILED_OR_UNKNOWN'
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
function requireHost(ok: unknown): asserts ok {
  if (!ok) throw new Error(FAILED)
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
function object(bytes: Buffer): Record<string, unknown> {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  requireHost(value && typeof value === 'object' && !Array.isArray(value))
  return value
}
function decode(value: unknown): Buffer {
  requireHost(typeof value === 'string' && value.length <= MAX_FRAME)
  const bytes = Buffer.from(value, 'base64')
  requireHost(bytes.length > 0 && bytes.length <= MAX_BODY && bytes.toString('base64') === value)
  return bytes
}

export interface Cc5SshHostConfig {
  /** Trusted deployment metadata, never populated from a container or web request. */
  user: string
  taskRoot: string
  operationId: string
  runId: string
  privateKeyPath: string
  knownHostsPath: string
  controllerPath: string
  /** Private v5-dev Unix endpoint of this operation's Cc5Relay.toolServer. */
  toolSocketPath: string
}
export type Cc5SshSpawn = (argv: string[]) => ChildProcessWithoutNullStreams
interface Channel {
  child: ChildProcessWithoutNullStreams
  closed: Promise<void>
}
interface FixtureDependencies {
  /** Ordinary child processes in tests; production always uses the fixed SSH binary below. */
  spawn?: Cc5SshSpawn
  startupMs?: number
  controlMs?: number
  toolMs?: number
  stopMs?: number
}

export class Cc5SshHost implements Cc5InteractiveHostPort {
  private readonly input = new PassThrough()
  private readonly output = new PassThrough()
  private readonly abort = new AbortController()
  private readonly channels: Channel[] = []
  private readonly source: string
  private readonly spawnSsh: Cc5SshSpawn
  private readonly ready: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (reason: Error) => void
  private cancelSocketReady?: () => void
  private started = false
  private closing = false
  private originalReady = false
  private stopPromise?: Promise<{ remoteStopped: true }>
  private toolChannel?: Channel
  private hostChannel?: Channel
  private toolSeen = false
  private startupTimer?: ReturnType<typeof setTimeout>

  constructor(
    private readonly config: Readonly<Cc5SshHostConfig>,
    private readonly fixture: FixtureDependencies = {},
  ) {
    this.config = Object.freeze({ ...config })
    requireHost(
      /^[a-z_][a-z0-9_-]{0,31}$/.test(config.user) &&
        config.user !== 'root' &&
        /^\/home\/[a-z_][a-z0-9_-]{0,31}\/oc-agentremote-t1555u-[a-z0-9-]{16,40}$/.test(
          config.taskRoot,
        ) &&
        UUID.test(config.operationId) &&
        UUID.test(config.runId) &&
        isAbsolute(config.toolSocketPath) &&
        Buffer.byteLength(config.toolSocketPath) <= 100,
    )
    // No private key contents are opened/read. Only metadata of the new dedicated key is checked.
    for (const [path, privateKey] of [
      [config.privateKeyPath, true],
      [config.knownHostsPath, false],
    ] as const) {
      requireHost(isAbsolute(path))
      const st = lstatSync(path)
      requireHost(
        st.isFile() &&
          st.uid === process.getuid?.() &&
          st.nlink === 1 &&
          st.size > 0 &&
          (privateKey ? (st.mode & 0o777) === 0o600 : (st.mode & 0o022) === 0),
      )
      if (privateKey) {
        const parent = lstatSync(dirname(path))
        requireHost(parent.isDirectory() && parent.uid === st.uid && (parent.mode & 0o077) === 0)
      }
    }
    requireHost(isAbsolute(config.controllerPath))
    const fd = openSync(
      config.controllerPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const st = fstatSync(fd)
      requireHost(
        st.isFile() &&
          st.uid === process.getuid?.() &&
          st.nlink === 1 &&
          (st.mode & 0o022) === 0 &&
          st.size > 0 &&
          st.size <= MAX_BODY,
      )
      const bytes = readFileSync(fd)
      requireHost(createHash('sha256').update(bytes).digest('hex') === CONTROLLER_SHA)
      this.source = bytes.toString('base64')
    } finally {
      closeSync(fd)
    }
    this.spawnSsh =
      fixture.spawn ??
      ((argv) =>
        spawn('/usr/bin/ssh', argv, {
          stdio: 'pipe',
          env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        }))
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // stop-before-start and failed construction never produce an unhandled rejection.
    void this.ready.catch(() => {})
  }
  private deadline(name: 'startupMs' | 'controlMs' | 'toolMs' | 'stopMs', normal: number): number {
    const value = this.fixture[name] ?? normal
    requireHost(Number.isInteger(value) && value > 0 && value <= normal)
    return value
  }
  private argv(
    role: 'launch' | 'tool-socket' | 'stop' | 'stop-socket' | 'prove-stopped',
  ): string[] {
    const command = `exec(compile(__import__('base64').b64decode('${this.source}'),'cc5-task-controller','exec'))`
    return [
      '-F',
      'none',
      '-T',
      '-p',
      '22',
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'IdentityAgent=none',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ControlMaster=no',
      '-o',
      'ControlPath=none',
      '-o',
      'ConnectionAttempts=1',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'ServerAliveInterval=10',
      '-o',
      'ServerAliveCountMax=2',
      '-i',
      this.config.privateKeyPath,
      '-o',
      `UserKnownHostsFile=${this.config.knownHostsPath}`,
      '-l',
      this.config.user,
      '136.86.172.84',
      ['/usr/bin/python3', '-I', '-B', '-c', command, role, this.config.taskRoot]
        .map(quote)
        .join(' '),
    ]
  }
  private channel(role: 'launch' | 'tool-socket'): Channel {
    requireHost(!this.closing)
    const child = this.spawnSsh(this.argv(role))
    const channel = {
      child,
      closed: new Promise<void>((resolve) => child.once('close', () => resolve())),
    }
    this.channels.push(channel)
    child.once('error', () => this.fail())
    child.once('close', () => {
      if (!this.closing) this.fail()
    })
    child.stdin.on('error', () => {
      if (!this.closing) this.fail()
    })
    child.stdout.on('error', () => {
      if (!this.closing) this.fail()
    })
    child.stderr.on('error', () => {
      if (!this.closing) this.fail()
    })
    return channel
  }
  start(): ReturnType<Cc5InteractiveHostPort['start']> {
    requireHost(!this.started && !this.closing)
    this.started = true
    this.startupTimer = setTimeout(() => this.fail(), this.deadline('startupMs', 65000))
    void Promise.resolve()
      .then(() => this.initialize())
      .catch(() => this.fail())
    return { stdin: this.input, stdout: this.output, ready: this.ready }
  }
  private fail(): void {
    this.rejectReady(new Error(FAILED))
    if (!this.closing) {
      this.output.destroy(new Error(FAILED))
      void this.stop().catch(() => {})
    }
  }
  private async initialize(): Promise<void> {
    requireHost(!this.closing)
    this.toolChannel = this.channel('tool-socket')
    // Never expose the helper's raw stderr: it may contain remote exception text.
    this.toolChannel.child.stderr.resume()
    await new Promise<void>((resolve, reject) => {
      this.cancelSocketReady = () => reject(new Error(FAILED))
      let ready = false
      let pending = Buffer.alloc(0)
      this.toolChannel!.child.stdout.on('data', (chunk: Buffer) => {
        try {
          pending = Buffer.concat([pending, chunk])
          requireHost(pending.length <= MAX_FRAME)
          while (pending.includes(10)) {
            const index = pending.indexOf(10)
            const row = object(pending.subarray(0, index))
            pending = pending.subarray(index + 1)
            requireHost(!this.closing && row.version === 1)
            if (!ready) {
              requireHost(
                Object.keys(row).sort().join(',') ===
                  'kind,operationId,pid,runId,startTicks,version' &&
                  row.kind === 'socket-ready' &&
                  row.runId === this.config.runId &&
                  row.operationId === this.config.operationId &&
                  Number.isSafeInteger(row.pid) &&
                  (row.pid as number) > 1 &&
                  typeof row.startTicks === 'string' &&
                  /^\d+$/.test(row.startTicks),
              )
              ready = true
              resolve()
            } else {
              requireHost(
                Object.keys(row).sort().join(',') === 'body,kind,seq,version' &&
                  row.kind === 'tool-request' &&
                  row.seq === 1 &&
                  !this.toolSeen,
              )
              this.toolSeen = true // Burn before any HTTP delivery; no retry on unknown.
              const body = decode(row.body)
              void this.forwardTool(body).catch(() => this.fail())
            }
          }
        } catch {
          reject(new Error(FAILED))
          this.fail()
        }
      })
    })
    this.cancelSocketReady = undefined
    requireHost(!this.closing) // A late helper READY cannot launch a TUI after cancellation.
    this.hostChannel = this.channel('launch')
    this.input.pipe(this.hostChannel.child.stdin)
    this.hostChannel.child.stdout.pipe(this.output, { end: false })
    let pending = Buffer.alloc(0)
    this.hostChannel.child.stderr.on('data', (chunk: Buffer) => {
      if (this.closing) return
      try {
        pending = Buffer.concat([pending, chunk])
        requireHost(pending.length <= 16384)
        while (pending.includes(10)) {
          const index = pending.indexOf(10)
          const line = new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(0, index))
          pending = pending.subarray(index + 1)
          // All other stderr, especially NOT_READY's following raw pane, is discarded.
          if (line.startsWith('BOX_INTERACTIVE_NOT_READY')) throw new Error(FAILED)
          const match = /^BOX_INTERACTIVE_READY plugins=([^\s]+) version=([^\s]+)$/.exec(line)
          if (match) {
            requireHost(!this.originalReady && match[1].split(',').includes('oc-bridge'))
            this.originalReady = true
            clearTimeout(this.startupTimer)
            this.resolveReady()
          }
        }
      } catch {
        this.fail()
      }
    })
  }
  private async forwardTool(body: Buffer): Promise<void> {
    requireHost(!this.closing && this.originalReady)
    const receipt = await new Promise<Buffer>((resolve, reject) => {
      const req = request(
        {
          socketPath: this.config.toolSocketPath,
          method: 'POST',
          path: '/roundtrip',
          headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
          signal: this.abort.signal,
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_BODY) req.destroy(new Error(FAILED))
            else chunks.push(chunk)
          })
          res.once('error', () => reject(new Error(FAILED)))
          res.once('aborted', () => reject(new Error(FAILED)))
          res.once('end', () => {
            if (res.statusCode !== 200 || size === 0 || size > MAX_BODY) reject(new Error(FAILED))
            else resolve(Buffer.concat(chunks))
          })
        },
      )
      const timer = setTimeout(() => req.destroy(new Error(FAILED)), this.deadline('toolMs', 45000))
      req.once('error', () => reject(new Error(FAILED)))
      req.once('close', () => clearTimeout(timer))
      req.end(body)
    })
    requireHost(!this.closing)
    const response = Buffer.from(
      `${JSON.stringify({
        version: 1,
        kind: 'tool-response',
        seq: 1,
        status: 200,
        body: receipt.toString('base64'),
      })}\n`,
    )
    requireHost(response.length <= MAX_FRAME)
    await new Promise<void>((resolve, reject) =>
      this.toolChannel!.child.stdin.write(response, (error) =>
        error ? reject(new Error(FAILED)) : resolve(),
      ),
    )
  }
  private async control(
    role: 'stop' | 'stop-socket' | 'prove-stopped',
    remaining: number,
  ): Promise<Record<string, unknown>> {
    const child = this.spawnSsh(this.argv(role))
    child.stderr.resume() // Never return remote errors, pane contents or argv.
    child.stdin.on('error', () => {})
    child.stdin.end()
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      const timer = setTimeout(
        () => {
          child.kill('SIGKILL')
          reject(new Error(FAILED))
        },
        Math.min(remaining, this.deadline('controlMs', 15000)),
      )
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY) {
          child.kill('SIGKILL')
          reject(new Error(FAILED))
        } else chunks.push(chunk)
      })
      child.stdout.once('error', () => reject(new Error(FAILED)))
      child.once('error', () => {
        clearTimeout(timer)
        reject(new Error(FAILED))
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        try {
          requireHost(code === 0 && size > 0 && size <= MAX_BODY)
          resolve(object(Buffer.concat(chunks)))
        } catch {
          reject(new Error(FAILED))
        }
      })
    })
  }
  stop(): Promise<{ remoteStopped: true }> {
    if (this.stopPromise) return this.stopPromise
    this.closing = true // No later READY/continuation can spawn another launch.
    clearTimeout(this.startupTimer)
    this.abort.abort()
    this.cancelSocketReady?.()
    this.rejectReady(new Error(FAILED))
    this.input.unpipe()
    this.input.destroy()
    this.stopPromise = this.stopOnce()
    return this.stopPromise
  }
  private async stopOnce(): Promise<{ remoteStopped: true }> {
    const end = Date.now() + this.deadline('stopMs', 65000)
    try {
      try {
        await this.control('stop', Math.max(1, end - Date.now()))
      } catch {
        /* Still clean both own channels. */
      }
      for (const channel of this.channels) channel.child.stdin.end()
      try {
        await this.control('stop-socket', Math.max(1, end - Date.now()))
      } catch {
        /* Proof remains mandatory. */
      }
      for (const channel of this.channels) {
        if (channel.child.exitCode === null) channel.child.kill('SIGTERM')
      }
      // Only an independent remote proof can return true; local SSH EOF/exit/signals cannot.
      while (Date.now() < end) {
        try {
          const proof = await this.control('prove-stopped', Math.max(1, end - Date.now()))
          requireHost(
            proof.remoteStopped === true &&
              proof.kind === 'verified-task-runtime-absent' &&
              proof.root === this.config.taskRoot,
          )
          return { remoteStopped: true }
        } catch {
          if (Date.now() + 250 >= end) break
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
      throw new Error(FAILED)
    } finally {
      for (const channel of this.channels) {
        channel.child.stdin.destroy()
        channel.child.stdout.destroy()
        channel.child.stderr.destroy()
        if (channel.child.exitCode === null) channel.child.kill('SIGKILL')
      }
      this.output.end()
      await Promise.race([
        Promise.all(this.channels.map((channel) => channel.closed)),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ])
    }
  }
}
