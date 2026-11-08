import { nodeMemoryError } from './remoteNodeMemory.js'
/** Container-side relay client for one Codex remote lane. No credentials, no model transport. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { dirname } from 'node:path'
import type { AuthorityKeyring } from '@openclaude/protocol'
import { CC5_MOUNT, readCc5AuthorityKeyring } from './cc5BridgePort.js'
import {
  type CodexRemoteBinding,
  assertCodexBinding,
  codexNeed,
} from './codexRemoteContract.js'

const LANE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const MAX_FRAME_BYTES = 8 * 1024 * 1024

/** Production mount is the supervisor's read-only view; fixtures may relocate it. */
export function codexMount(): string {
  const value = process.env.OC_CODEX_REMOTE_MOUNT
  return value && value.startsWith('/') && !value.includes('..') ? value.replace(/\/+$/, '') : CC5_MOUNT
}

export function codexLanePaths(
  operationId: string,
  mount = codexMount(),
): { binding: string; socket: string } {
  codexNeed(LANE_ID.test(operationId), 'CODEX_BINDING_PATH_INVALID')
  return { binding: `${mount}/${operationId}/binding.json`, socket: `${mount}/${operationId}/relay.sock` }
}

function isLaneBinding(path: string, mount: string): boolean {
  const escaped = mount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^${escaped}/([a-f0-9-]{36})/binding\\.json$`).exec(path)
  return match !== null && LANE_ID.test(match[1]!)
}

/** Same supervisor-owned file rules as the CC lane: root-owned, single link, no symlink. */
function readSupervisorBinding(path: string, mount: string): unknown {
  codexNeed(isLaneBinding(path, mount), 'CODEX_BINDING_PATH_INVALID')
  const dir = lstatSync(dirname(path))
  codexNeed(dir.isDirectory() && dir.uid === 0 && (dir.mode & 0o027) === 0, 'CODEX_BINDING_PATH_INVALID')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const meta = fstatSync(fd)
    const link = lstatSync(path)
    codexNeed(
      meta.isFile() &&
        !link.isSymbolicLink() &&
        meta.ino === link.ino &&
        meta.dev === link.dev &&
        meta.uid === 0 &&
        meta.nlink === 1 &&
        (meta.mode & 0o027) === 0 &&
        meta.size > 0 &&
        meta.size <= 4096,
      'CODEX_BINDING_PATH_INVALID',
    )
    return JSON.parse(readFileSync(fd, 'utf8'))
  } finally {
    closeSync(fd)
  }
}

export function readCodexBinding(path: string, now = Date.now()): Readonly<CodexRemoteBinding> {
  try {
    const value = readSupervisorBinding(path, codexMount()) as CodexRemoteBinding
    assertCodexBinding(value)
    codexNeed(value.expiresAt > now && path === codexLanePaths(value.operationId).binding, 'CODEX_BINDING_INVALID')
    return Object.freeze({ ...value })
  } catch {
    throw new Error('CODEX_BINDING_INVALID')
  }
}

/** A replaced lane keeps the chat identity; only the capability and expiry may change. */
export function refreshCodexBinding(
  initial: Readonly<CodexRemoteBinding>,
  socketPath: string,
  now = Date.now(),
): Readonly<CodexRemoteBinding> {
  assertCodexBinding(initial)
  try {
    const disk = readCodexBinding(`${dirname(socketPath)}/binding.json`, now)
    for (const key of ['operationId', 'runId', 'uid', 'containerDbId', 'dockerId', 'sessionKey', 'canonicalModel',
      'backendKind', 'generation', 'profileId', 'authEpoch', 'manifestSha256'] as const) {
      codexNeed(disk[key] === initial[key], 'CODEX_BINDING_SCOPE_CHANGED')
    }
    codexNeed(disk.expiresAt >= initial.expiresAt)
    return disk
  } catch {
    return initial
  }
}

/** One request, no retries: a lost ACK is never permission to replay an effect. */
export function codexControlRequest(
  path: string,
  body: Readonly<Record<string, unknown>>,
  socketPath: string,
  timeoutMs = 120000,
): Promise<Record<string, unknown>> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        agent: false,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_FRAME_BYTES) req.destroy(new Error('CODEX_CONTROL_RESPONSE_LIMIT'))
          else chunks.push(chunk)
        })
        res.on('error', reject)
        res.on('aborted', () => reject(new Error('CODEX_CONTROL_RESPONSE_UNKNOWN')))
        res.on('end', () => {
          if (res.statusCode !== 200) {
            try {
              const error = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              if (error.error === 'REMOTE_NODE_MEMORY_EXHAUSTED') return reject(nodeMemoryError(error.activeSessions))
            } catch { /* Untrusted errors retain the fixed generic label. */ }
            return reject(new Error('CODEX_CONTROL_REJECTED'))
          }
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
            if (!value || value.ok !== true) throw new Error('CODEX_CONTROL_REJECTED')
            resolve(value)
          } catch {
            reject(new Error('CODEX_CONTROL_RESPONSE_INVALID'))
          }
        })
      },
    )
    const timer = setTimeout(() => req.destroy(new Error('CODEX_CONTROL_DELIVERY_UNKNOWN')), timeoutMs)
    req.once('close', () => clearTimeout(timer))
    req.once('error', reject)
    req.end(payload)
  })
}

export interface CodexAdmittedTurn {
  readonly authority: string
  readonly lease: string
  readonly turnKey: string
}
export interface CodexAdmittedIdentity extends CodexAdmittedTurn {
  readonly authorityTurnId: string
  /** The current lease and the one a renewal replaced: a delivery in flight still carries it. */
  readonly acceptedLeases?: readonly string[]
}

/** The container half of the lane: every call carries the closed binding scope. */
export class CodexRelayClient {
  readonly bindingId: string
  readonly canonicalModel: string
  private stopped = false
  private startSeq = 0
  private lastTool: { request: Record<string, unknown>; authority: string; lease: string; turnKey: string } | undefined
  constructor(
    private binding: Readonly<CodexRemoteBinding>,
    private readonly call: (path: string, body: Readonly<Record<string, unknown>>) => Promise<Record<string, unknown>> =
      (path, body) => codexControlRequest(path, body, codexLanePaths(binding.operationId).socket),
    private readonly reload: () => Readonly<CodexRemoteBinding> =
      () => readCodexBinding(codexLanePaths(binding.operationId).binding),
  ) {
    assertCodexBinding(binding)
    this.bindingId = binding.operationId
    this.canonicalModel = binding.canonicalModel
  }
  get currentBinding(): Readonly<CodexRemoteBinding> { return this.binding }
  get keyring(): AuthorityKeyring { return readCc5AuthorityKeyring() }
  private scope(): Record<string, unknown> {
    const b = this.binding
    return { capability: b.capability, uid: b.uid, containerDbId: b.containerDbId, dockerId: b.dockerId,
      operationId: b.operationId, sessionKey: b.sessionKey, generation: b.generation }
  }
  private adopt(): void {
    if (this.stopped) throw new Error('CODEX_LANE_CLOSED')
    const next = this.reload()
    if (next.capability !== this.binding.capability) this.binding = next
  }
  async admit(input: { authority: string; lease: string; turnKey: string; catalog: unknown }): Promise<number> {
    this.adopt()
    const reply = await this.call('/admit', { ...this.scope(), ...input })
    // The master answers with this admission's output baseline: everything before it belongs to
    // a turn this container no longer has a kernel for.
    codexNeed(reply.ready === true && Number.isSafeInteger(reply.seq) && (reply.seq as number) >= 0,
      'CODEX_ADMIT_UNKNOWN')
    this.startSeq = reply.seq as number
    return this.startSeq
  }
  /** Frames at or below `startSeq` predate this admission and must never reach the kernel. */
  get admittedBaseline(): number { return this.startSeq }

  /** Mid-turn kernel restart: continue after the frames the master already published. */
  async rebase(): Promise<void> {
    codexNeed(!this.stopped, 'CODEX_LANE_CLOSED')
    const reply = await this.call('/baseline', this.scope())
    codexNeed(Number.isSafeInteger(reply.seq) && (reply.seq as number) >= 0, 'CODEX_CONTROL_RESPONSE_INVALID')
    this.startSeq = Math.max(this.startSeq, reply.seq as number)
  }
  async rpc(frame: unknown): Promise<void> {
    codexNeed(!this.stopped, 'CODEX_LANE_CLOSED')
    await this.call('/rpc', { ...this.scope(), frame })
  }
  async poll(afterSeq: number): Promise<Array<{ seq: number; frame: unknown }>> {
    codexNeed(!this.stopped && Number.isSafeInteger(afterSeq) && afterSeq >= 0, 'CODEX_POLL_INVALID')
    const reply = await this.call('/poll', { ...this.scope(), afterSeq })
    const frames = reply.frames
    codexNeed(Array.isArray(frames) && frames.length <= 100000, 'CODEX_POLL_INVALID')
    for (const row of frames) {
      codexNeed(row && Number.isSafeInteger(row.seq) && row.seq > afterSeq && row.frame !== undefined, 'CODEX_POLL_INVALID')
    }
    return frames as Array<{ seq: number; frame: unknown }>
  }
  async toolNext(): Promise<CodexAdmittedTurn & { request?: Record<string, unknown> }> {
    this.adopt()
    const reply = await this.call('/tool/next', this.scope())
    const delivered = {
      authority: reply.authority, lease: reply.lease, turnKey: reply.turnKey, request: reply.request,
    } as CodexAdmittedTurn & { request?: Record<string, unknown> }
    if (reply.request !== undefined) {
      codexNeed(typeof delivered.authority === 'string' && typeof delivered.lease === 'string' &&
        typeof delivered.turnKey === 'string' && reply.request && typeof reply.request === 'object',
        'CODEX_TOOL_DELIVERY_INVALID')
      this.lastTool = { request: reply.request as Record<string, unknown>, authority: delivered.authority,
        lease: delivered.lease, turnKey: delivered.turnKey }
    }
    return delivered
  }
  async toolResult(callId: string, result: unknown): Promise<void> {
    const reply = await this.call('/tool/result', { ...this.scope(), callId, result })
    codexNeed(reply.callId === callId, 'CODEX_TOOL_RESULT_UNKNOWN')
  }
  async toolAck(callId: string): Promise<void> {
    await this.call('/tool/ack', { ...this.scope(), callId })
  }
  async toolStopped(admitted: CodexAdmittedIdentity): Promise<void> {
    await this.call('/tool/stopped', { ...this.scope(), authorityTurnId: admitted.authorityTurnId,
      turnKey: admitted.turnKey })
  }
  async renew(lease: string): Promise<void> {
    await this.call('/renew', { ...this.scope(), lease })
  }
  /** An admitted turn that never reached `turn/start`: closed by the master without a receipt. */
  async abandon(turnKey: string): Promise<void> {
    const reply = await this.call('/abandon', { ...this.scope(), turnKey })
    codexNeed(reply.abandoned === true, 'CODEX_ABANDON_UNKNOWN')
  }
  /** Lane stop. The master relay requires a prior local `/tool/stopped` proof. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    const reply = await this.call('/stop', this.scope())
    codexNeed(reply.remoteStopped === true, 'CODEX_REMOTE_STOP_UNPROVEN')
  }
  get closed(): boolean { return this.stopped }
  get lastDelivery(): CodexRelayClient['lastTool'] { return this.lastTool }
}
