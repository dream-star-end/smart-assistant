/**
 * Bounded JSON-line stdio client to `scripts/agent-remote/core/driver_worker.py`.
 *
 * Enforces:
 * - Bounded in-flight queue (`MAX_INFLIGHT = 64`),
 * - Per-call hard timeout (`default 10_000 ms`),
 * - Bounded response line bytes (`2 MiB`),
 * - Fail-closed fence on worker crash/exit (never silently restarts and replays in-flight commands).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  validatePendingToolRequest,
  validateRemoteProbeSnapshot,
  validateSecurityEvent,
  validateSecurityPayload,
  validateUsagePolicy,
  type RemoteControlReply,
  type RemoteDriverCommand,
  type RemoteDriverUsagePolicy,
  type RemotePendingToolRequest,
  type RemotePresentationItem,
  type RemoteProbeSnapshot,
  type RemoteSecurityEvent,
  type RemoteSecurityPayload,
} from '@openclaude/protocol'
import { remotePoolNeed } from './types.js'

const MAX_LINE_BYTES = 2 * 1024 * 1024
const MAX_INFLIGHT = 64
const DEFAULT_TIMEOUT_MS = 10_000

const DEFAULT_WORKER_SCRIPT = fileURLToPath(
  new URL('../../../../scripts/agent-remote/core/driver_worker.py', import.meta.url),
)

export interface DriverWorkerInfo {
  readonly driverId: string
  readonly engineId: string
  readonly authorityEngine: string
  readonly driverVersion: string
  readonly driverDigest: string
  readonly coreDigest: string
  readonly usagePolicy: RemoteDriverUsagePolicy
  readonly meta: Record<string, unknown>
}

export interface DriverDecodeEnvelopeInput {
  readonly operationId: string
  readonly generation: string
  readonly profileId: string
  readonly authEpoch: string
  readonly authorityTurnId: string
  readonly nativeSessionId?: string
  readonly nativeTurnId?: string
}

export interface DriverDecodeResult<TWrapped extends boolean = false> {
  readonly securityEvents: ReadonlyArray<TWrapped extends true ? RemoteSecurityEvent : RemoteSecurityPayload>
  readonly presentation: readonly RemotePresentationItem[]
  readonly controlReplies: readonly RemoteControlReply[]
  readonly pendingToolRequest?: RemotePendingToolRequest
  readonly nextNativeState: Record<string, unknown>
}

export interface DriverEncodeResult {
  readonly lines: readonly string[]
  readonly nextNativeState: Record<string, unknown>
  readonly immediateControlReplies: readonly RemoteControlReply[]
}

export type DriverProbeStepOrSnapshot =
  | {
      readonly kind: 'step'
      readonly step: {
        readonly argv: readonly string[]
        readonly stdinLines?: readonly string[]
        readonly environment?: Record<string, string>
        readonly timeoutSec?: number
        readonly hashFiles?: Record<string, string>
      }
      readonly nextProbeState?: Record<string, unknown>
    }
  | {
      readonly kind: 'snapshot'
      readonly snapshot: RemoteProbeSnapshot
      readonly driverDigest: string
      readonly coreDigest: string
      readonly probeFingerprint: string
    }

interface PendingRpc {
  readonly resolve: (value: any) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

export interface DriverWorkerClientOptions {
  readonly workerScriptPath?: string
  readonly registryPath?: string
  readonly timeoutMs?: number
  readonly maxInflight?: number
}

export class DriverWorkerClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRpc>()
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly timeoutMs: number
  private readonly maxInflight: number
  private readonly registryPath?: string
  private buffer = ''
  private seq = 0
  private fencedReason?: string
  private closed = false

  constructor(options: DriverWorkerClientOptions = {}) {
    const script = options.workerScriptPath ?? DEFAULT_WORKER_SCRIPT
    const args = ['-I', '-B', script]
    if (options.registryPath) {
      args.push('--registry', options.registryPath)
    }
    this.registryPath = options.registryPath
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxInflight = options.maxInflight ?? MAX_INFLIGHT
    this.child = spawn('/usr/bin/python3', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    })
    this.child.stderr.resume()
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    this.child.once('error', (err) => this.fence(`REMOTE_DRIVER_WORKER_SPAWN_FAILED:${err.message}`))
    this.child.once('close', (code, signal) => {
      if (!this.closed) {
        this.fence(`REMOTE_DRIVER_WORKER_EXITED:${code ?? signal ?? 'unknown'}`)
      }
    })
  }

  get isHealthy(): boolean {
    return !this.closed && !this.fencedReason
  }

  private fence(reason: string): void {
    if (this.fencedReason) return
    this.fencedReason = reason
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reject(new Error(reason))
    }
    try {
      this.child.kill('SIGKILL')
    } catch {
      // Ignore already-dead process.
    }
  }

  private onData(chunk: Buffer): void {
    if (this.fencedReason) return
    try {
      this.buffer += this.decoder.decode(chunk, { stream: true })
      remotePoolNeed(Buffer.byteLength(this.buffer, 'utf8') <= MAX_LINE_BYTES, 'REMOTE_DRIVER_WORKER_OVERFLOW')
      let idx: number
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx)
        this.buffer = this.buffer.slice(idx + 1)
        if (!line) continue
        const msg = JSON.parse(line) as {
          id: number | null
          ok: boolean
          result?: unknown
          error?: { code?: string; message?: string }
        }
        if (typeof msg.id !== 'number') {
          this.fence(msg.error?.code ?? 'REMOTE_DRIVER_WORKER_PROTOCOL_ERROR')
          return
        }
        const entry = this.pending.get(msg.id)
        if (!entry) {
          this.fence('REMOTE_DRIVER_WORKER_UNSOLICITED_REPLY')
          return
        }
        this.pending.delete(msg.id)
        clearTimeout(entry.timer)
        if (msg.ok) {
          entry.resolve(msg.result)
        } else {
          entry.reject(new Error(msg.error?.code || 'REMOTE_DRIVER_WORKER_ERROR'))
        }
      }
    } catch (err) {
      this.fence(err instanceof Error ? err.message : 'REMOTE_DRIVER_WORKER_DECODE_FAILED')
    }
  }

  private request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('REMOTE_DRIVER_WORKER_CLOSED'))
    if (this.fencedReason) return Promise.reject(new Error(this.fencedReason))
    if (this.pending.size >= this.maxInflight) {
      return Promise.reject(new Error('REMOTE_DRIVER_WORKER_BACKPRESSURE'))
    }
    const id = ++this.seq
    const payloadParams =
      this.registryPath && params.registryPath === undefined
        ? { ...params, registryPath: this.registryPath }
        : params
    const line = `${JSON.stringify({ id, method, params: payloadParams })}\n`
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      return Promise.reject(new Error('REMOTE_DRIVER_WORKER_REQUEST_TOO_LARGE'))
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.fence('REMOTE_DRIVER_WORKER_TIMEOUT')
        reject(new Error('REMOTE_DRIVER_WORKER_TIMEOUT'))
      }, this.timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(line, (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          this.fence('REMOTE_DRIVER_WORKER_WRITE_FAILED')
          reject(new Error('REMOTE_DRIVER_WORKER_WRITE_FAILED'))
        }
      })
    })
  }

  async info(driverId: string): Promise<DriverWorkerInfo> {
    const raw = await this.request<Record<string, any>>('info', { driverId })
    return {
      driverId: String(raw.driverId),
      engineId: String(raw.engineId),
      authorityEngine: String(raw.authorityEngine),
      driverVersion: String(raw.driverVersion),
      driverDigest: String(raw.driverDigest),
      coreDigest: String(raw.coreDigest),
      usagePolicy: validateUsagePolicy(raw.usagePolicy),
      meta: (raw.meta ?? {}) as Record<string, unknown>,
    }
  }

  async usagePolicy(driverId: string): Promise<RemoteDriverUsagePolicy> {
    const raw = await this.request<unknown>('usagePolicy', { driverId })
    return validateUsagePolicy(raw)
  }

  async encode(
    driverId: string,
    command: RemoteDriverCommand,
    nativeState: Record<string, unknown> = {},
  ): Promise<DriverEncodeResult> {
    const raw = await this.request<Record<string, any>>('encode', {
      driverId,
      command,
      nativeState,
    })
    remotePoolNeed(
      Array.isArray(raw.lines) &&
        raw.nextNativeState &&
        typeof raw.nextNativeState === 'object' &&
        Array.isArray(raw.immediateControlReplies),
      'REMOTE_DRIVER_ENCODE_RESULT_INVALID',
    )
    return {
      lines: raw.lines as string[],
      nextNativeState: raw.nextNativeState as Record<string, unknown>,
      immediateControlReplies: raw.immediateControlReplies as RemoteControlReply[],
    }
  }

  async decode(
    driverId: string,
    input: {
      channel: 'native' | 'fixed_mcp' | 'probe'
      frameSeq: number
      rawBytes: Uint8Array | Buffer | string
      nativeState: Record<string, unknown>
      envelope: DriverDecodeEnvelopeInput
      eventSeqStart?: number
    },
  ): Promise<DriverDecodeResult<true>>
  async decode(
    driverId: string,
    input: {
      channel: 'native' | 'fixed_mcp' | 'probe'
      frameSeq: number
      rawBytes: Uint8Array | Buffer | string
      nativeState: Record<string, unknown>
      envelope?: undefined
      eventSeqStart?: number
    },
  ): Promise<DriverDecodeResult<false>>
  async decode(
    driverId: string,
    input: {
      channel: 'native' | 'fixed_mcp' | 'probe'
      frameSeq: number
      rawBytes: Uint8Array | Buffer | string
      nativeState: Record<string, unknown>
      envelope?: DriverDecodeEnvelopeInput
      eventSeqStart?: number
    },
  ): Promise<DriverDecodeResult<boolean>> {
    const buf =
      typeof input.rawBytes === 'string' ? Buffer.from(input.rawBytes, 'utf8') : Buffer.from(input.rawBytes)
    const raw = await this.request<Record<string, any>>('decode', {
      driverId,
      channel: input.channel,
      frameSeq: input.frameSeq,
      rawFrameB64: buf.toString('base64'),
      nativeState: input.nativeState,
      ...(input.envelope ? { envelope: input.envelope } : {}),
      ...(input.eventSeqStart !== undefined ? { eventSeqStart: input.eventSeqStart } : {}),
    })

    const secEvents = input.envelope
      ? (raw.securityEvents as unknown[]).map((ev) => validateSecurityEvent(ev))
      : (raw.securityEvents as unknown[]).map((ev) => validateSecurityPayload(ev))

    const pendingToolRequest =
      raw.pendingToolRequest !== undefined && raw.pendingToolRequest !== null
        ? validatePendingToolRequest(raw.pendingToolRequest)
        : undefined

    return {
      securityEvents: secEvents,
      presentation: (raw.presentation ?? []) as RemotePresentationItem[],
      controlReplies: (raw.controlReplies ?? []) as RemoteControlReply[],
      ...(pendingToolRequest ? { pendingToolRequest } : {}),
      nextNativeState: (raw.nextNativeState ?? {}) as Record<string, unknown>,
    }
  }

  async launchSpec(
    driverId: string,
    context: Record<string, unknown>,
    verifiedProbe: RemoteProbeSnapshot,
  ): Promise<Record<string, unknown>> {
    return await this.request<Record<string, unknown>>('launchSpec', {
      driverId,
      context,
      verifiedProbe,
    })
  }

  async probe(
    driverId: string,
    context: Record<string, unknown>,
    previousStepResult?: Record<string, unknown>,
  ): Promise<DriverProbeStepOrSnapshot> {
    const raw = await this.request<Record<string, any>>('probe', {
      driverId,
      context,
      ...(previousStepResult ? { previousStepResult } : {}),
    })
    if (raw.kind === 'step') {
      return {
        kind: 'step',
        step: raw.step,
        ...(raw.nextProbeState ? { nextProbeState: raw.nextProbeState } : {}),
      }
    }
    return {
      kind: 'snapshot',
      snapshot: validateRemoteProbeSnapshot(raw.snapshot),
      driverDigest: String(raw.driverDigest),
      coreDigest: String(raw.coreDigest),
      probeFingerprint: String(raw.probeFingerprint),
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reject(new Error('REMOTE_DRIVER_WORKER_CLOSED'))
    }
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          this.child.kill('SIGKILL')
        } catch {
          // Ignore
        }
        resolve()
      }, 2000)
      killTimer.unref()
      this.child.once('close', () => {
        clearTimeout(killTimer)
        resolve()
      })
      this.child.stdin.end()
    })
  }
}
