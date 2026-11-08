/** The app-server boundary of a remote lane: a child-process shape fed by the master relay. */
import { EventEmitter } from 'node:events'
import { PassThrough, type Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { CodexRelayClient } from './codexRemotePort.js'

const POLL_IDLE_MS = 20
const POLL_BUSY_MS = 2
const MAX_LINE_BYTES = 8 * 1024 * 1024

export interface CodexRelayChildOptions {
  /** Every relayed native frame, in order, before it reaches the protocol kernel. */
  onFrame?: (frame: unknown) => void
}

/**
 * A `ChildProcessWithoutNullStreams`-compatible handle whose bytes come from the master relay.
 * `stdin` lines become `/rpc`; relayed frames become `stdout` lines. It never spawns a process.
 */
export class CodexRelayChild extends EventEmitter {
  readonly stdin: Writable
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  /** No local process exists. A group kill on this id can only ever fail with ESRCH. */
  readonly pid = 1 << 30
  killed = false
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  private closed = false
  private afterSeq = 0
  /** Unset until the turn is admitted: a frame written earlier could only be rejected. */
  private gate?: Promise<void>
  private admitted = false
  private readonly input: string[] = []
  private draining = false
  private readonly pollLoop: Promise<void>

  constructor(private readonly client: CodexRelayClient, private readonly options: CodexRelayChildOptions = {}) {
    super()
    const stdin = new PassThrough()
    stdin.on('data', (chunk: Buffer) => this.accept(chunk.toString('utf8')))
    stdin.on('error', () => this.fail('CODEX_INPUT_FAILED'))
    this.stdin = stdin
    this.pollLoop = this.poll()
  }

  /** Holds every `/rpc` until the turn's admission has been proven by the master. */
  setGate(gate: Promise<void>): void {
    const held = gate.catch((error) => {
      this.fail(error instanceof Error && /^CODEX_/.test(error.message) ? error.message : 'CODEX_ADMIT_FAILED')
      throw error
    })
    // The kernel awaits the same promise through `drain`; keep Node from calling it unhandled.
    held.catch(() => {})
    this.gate = held
  }

  private accept(text: string): void {
    if (this.closed) return
    let index: number
    while ((index = text.indexOf('\n')) >= 0) {
      const line = text.slice(0, index).trim()
      text = text.slice(index + 1)
      if (line) this.input.push(line)
    }
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      if (!this.gate) throw new Error('CODEX_ADMIT_REQUIRED')
      await this.gate
      while (this.input.length > 0 && !this.closed) {
        const line = this.input.shift()!
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('CODEX_INPUT_LIMIT')
        let frame: unknown
        try {
          frame = JSON.parse(line)
        } catch {
          throw new Error('CODEX_INPUT_INVALID')
        }
        await this.client.rpc(frame)
      }
    } catch (error) {
      this.fail(error instanceof Error && /^CODEX_[A-Z_]+$/.test(error.message) ? error.message : 'CODEX_RPC_FAILED')
    } finally {
      this.draining = false
    }
  }

  private async poll(): Promise<void> {
    while (!this.closed) {
      if (!this.gate || !this.admitted) {
        // Nothing may reach the kernel before this turn's admission, and the admission also sets
        // the baseline: frames published before it belong to a turn this kernel never had.
        if (this.gate) {
          try {
            await this.gate
          } catch {
            return
          }
          this.afterSeq = Math.max(this.afterSeq, this.client.admittedBaseline)
          this.admitted = true
        } else {
          await new Promise<void>((resolve) => setTimeout(resolve, POLL_IDLE_MS).unref())
        }
        continue
      }
      let frames: Array<{ seq: number; frame: unknown }>
      try {
        frames = await this.client.poll(this.afterSeq)
      } catch {
        this.fail('CODEX_OUTPUT_DELIVERY_UNKNOWN')
        return
      }
      if (this.closed) return
      for (const row of frames) {
        this.afterSeq = row.seq
        try {
          this.options.onFrame?.(row.frame)
        } catch (error) {
          this.fail(error instanceof Error ? error.message : 'CODEX_ORIGINAL_OBSERVATION_INVALID')
          return
        }
        let line: string
        try {
          line = `${JSON.stringify(row.frame)}\n`
        } catch {
          this.fail('CODEX_FRAME_INVALID')
          return
        }
        if (!this.stdout.write(line)) await this.drained()
      }
      await new Promise<void>((resolve) => setTimeout(resolve, frames.length ? POLL_BUSY_MS : POLL_IDLE_MS).unref())
    }
  }

  private drained(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.stdout.removeListener('drain', done)
        resolve()
      }
      this.stdout.once('drain', done)
    })
  }

  private fail(code: string): void {
    if (this.closed) return
    this.close(1, null)
    if (this.listenerCount('error') > 0) this.emit('error', new Error(code))
  }

  private close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return
    this.closed = true
    this.exitCode = code
    this.signalCode = signal
    this.stdout.end()
    this.stderr.end()
    this.stdin.destroy()
    queueMicrotask(() => this.emit('close', code, signal))
  }

  /** Mirrors a process kill: ends the relay child. The lane stop itself is the adapter's job. */
  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.killed) return false
    this.killed = true
    const name = typeof signal === 'string' ? signal : undefined
    this.close(null, name ?? 'SIGTERM')
    return true
  }

  /** Test/teardown helper: the poll loop ends with the child. */
  async finished(): Promise<void> { await this.pollLoop }
}

export function asRelayChild(child: CodexRelayChild): ChildProcessWithoutNullStreams {
  return child as unknown as ChildProcessWithoutNullStreams
}
