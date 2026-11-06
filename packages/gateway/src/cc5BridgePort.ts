/** Task-only live-web transport. No CLI, provider credentials or remote shell here. */
import { createHash } from 'node:crypto'
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { request } from 'node:http'
import { dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type AuthorityKeyring,
  type Cc5ExecutionBackend,
  CC5_INTERACTIVE_BACKEND,
  isCc5BackendAuthority,
  isCc5CanonicalModel,
  parseCc5ExecutionBackend,
  parseAuthorityKeyring,
} from '@openclaude/protocol'
import type { TurnModelAuthority } from './subprocessSpawnConfig.js'
import type { SpawnOpts } from './terminalBackend.js'

export const CC5_MOUNT = '/run/oc/cc5-remote-t1555u'
export const CC5_AUTHORITY_KEYRING_FILE = `${CC5_MOUNT}/authority-public.json`
const LANE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
/** One remote chat lane per operation: its binding and relay live in the supervisor's lane dir. */
export function cc5LanePaths(operationId: string, mount = CC5_MOUNT): { binding: string; socket: string } {
  requireCc5(LANE_ID.test(operationId))
  return { binding: `${mount}/${operationId}/binding.json`, socket: `${mount}/${operationId}/relay.sock` }
}
function isLaneBinding(path: string): boolean {
  const match = /^\/run\/oc\/cc5-remote-t1555u\/([a-f0-9-]{36})\/binding\.json$/.exec(path)
  return match !== null && LANE_ID.test(match[1]!)
}
export const CC5_BRIDGE_MAX_FRAME_BYTES = 8 * 1024 * 1024
export const CC5_BINDING_SLIDING_TTL_MS = 24 * 60 * 60 * 1000
export interface Cc5BridgeBinding {
  version: 2
  backendKind: typeof CC5_INTERACTIVE_BACKEND
  canonicalModel: string
  sessionKey: string
  runId: string
  uid: string
  containerDbId: string
  dockerId: string
  operationId: string
  capability: string
  expiresAt: number
}

/** The same closed v2 binding is consumed by the child, relay and fixed tool. */
export function assertCc5BindingScope(binding: Readonly<Cc5BridgeBinding>): void {
  requireCc5(binding && typeof binding === 'object' &&
    Object.keys(binding).sort().join(',') === 'backendKind,canonicalModel,capability,containerDbId,dockerId,expiresAt,operationId,runId,sessionKey,uid,version' &&
    binding.version === 2 && binding.backendKind === CC5_INTERACTIVE_BACKEND &&
    isCc5CanonicalModel(binding.canonicalModel) &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/.test(binding.runId) &&
    /^[1-9][0-9]{0,18}$/.test(binding.uid) && /^[1-9][0-9]{0,18}$/.test(binding.containerDbId) &&
    /^[a-f0-9]{64}$/.test(binding.dockerId) && /^[a-f0-9]{64}$/.test(binding.capability) &&
    Number.isSafeInteger(binding.expiresAt))
  parseCc5ExecutionBackend({ kind: binding.backendKind, sessionKey: binding.sessionKey,
    operationId: binding.operationId })
}

export function cc5AuthorityMatchesBinding(binding: Readonly<Cc5BridgeBinding>, authority: {
  uid: number; containerId: number; canonicalModel: string; engine: string
  executionBackend?: Cc5ExecutionBackend
}): boolean {
  assertCc5BindingScope(binding)
  return isCc5BackendAuthority(authority) && String(authority.uid) === binding.uid &&
    String(authority.containerId) === binding.containerDbId &&
    authority.canonicalModel === binding.canonicalModel &&
    authority.executionBackend!.sessionKey === binding.sessionKey &&
    authority.executionBackend!.operationId === binding.operationId
}

function requireCc5(value: unknown): asserts value {
  if (!value) throw new Error('CC5_BRIDGE_BINDING_INVALID')
}

/** No user/env path may select a supervisor-owned file. Errors never echo JSON. */
function readSupervisorJson(path: string): unknown {
  const binding = isLaneBinding(path)
  requireCc5(binding || path === CC5_AUTHORITY_KEYRING_FILE)
  const dir = lstatSync(dirname(path))
  requireCc5(dir.isDirectory() && dir.uid === 0 && (dir.mode & 0o027) === 0)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const meta = fstatSync(fd)
    const link = lstatSync(path)
    requireCc5(
      meta.isFile() &&
        !link.isSymbolicLink() &&
        meta.ino === link.ino &&
        meta.dev === link.dev &&
        meta.uid === 0 &&
        meta.nlink === 1 &&
        (meta.mode & 0o027) === 0 &&
        meta.size > 0 &&
        meta.size <= (binding ? 4096 : 16384),
    )
    return JSON.parse(readFileSync(fd, 'utf8'))
  } finally {
    closeSync(fd)
  }
}

/** Only the supervisor's root-owned read-only bind may select a relay. */
export function readCc5Binding(
  path: string,
  now = Date.now(),
): Readonly<Cc5BridgeBinding> {
  try {
    requireCc5(isLaneBinding(path))
    const b = readSupervisorJson(path) as Cc5BridgeBinding
    requireCc5(
      b.version === 2 &&
        /^[1-9][0-9]*$/.test(b.uid) &&
        /^[1-9][0-9]*$/.test(b.containerDbId) &&
        /^[a-f0-9]{64}$/.test(b.dockerId) &&
        /^[a-f0-9-]{36}$/.test(b.operationId) &&
        /^[a-f0-9]{64}$/.test(b.capability) &&
        Number.isSafeInteger(b.expiresAt) &&
        b.expiresAt > now,
    )
    assertCc5BindingScope(b)
    requireCc5(path === cc5LanePaths(b.operationId).binding)
    return Object.freeze(b)
  } catch {
    throw new Error('CC5_BRIDGE_BINDING_INVALID')
  }
}

/**
 * Re-read a supervisor-updated `binding.json` adjacent to the lane's `socketPath`,
 * verifying that every immutable identity field matches `initial` before accepting an extended `expiresAt`.
 */
export function refreshCc5Binding(
  initial: Readonly<Cc5BridgeBinding>,
  socketPath: string,
  now = Date.now(),
): Readonly<Cc5BridgeBinding> {
  assertCc5BindingScope(initial)
  const candidatePath = `${dirname(socketPath)}/binding.json`
  try {
    const dir = lstatSync(dirname(candidatePath))
    requireCc5(
      dir.isDirectory() &&
        (dir.uid === 0 || dir.uid === process.getuid?.()) &&
        (dir.mode & 0o027) === 0,
    )
    const fd = openSync(candidatePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const meta = fstatSync(fd)
      const link = lstatSync(candidatePath)
      requireCc5(
        meta.isFile() &&
          !link.isSymbolicLink() &&
          meta.ino === link.ino &&
          meta.dev === link.dev &&
          (meta.uid === 0 || meta.uid === process.getuid?.()) &&
          meta.nlink === 1 &&
          (meta.mode & 0o027) === 0 &&
          meta.size > 0 &&
          meta.size <= 4096,
      )
      const disk = JSON.parse(readFileSync(fd, 'utf8')) as Cc5BridgeBinding
      assertCc5BindingScope(disk)
      requireCc5(
        disk.capability === initial.capability &&
          disk.uid === initial.uid &&
          disk.containerDbId === initial.containerDbId &&
          disk.dockerId === initial.dockerId &&
          disk.operationId === initial.operationId &&
          disk.runId === initial.runId &&
          disk.sessionKey === initial.sessionKey &&
          disk.canonicalModel === initial.canonicalModel &&
          disk.backendKind === initial.backendKind &&
          disk.expiresAt >= initial.expiresAt &&
          disk.expiresAt > now,
      )
      return Object.freeze(disk)
    } finally {
      closeSync(fd)
    }
  } catch {
    return initial
  }
}

export function readCc5AuthorityKeyring(): AuthorityKeyring {
  try {
    const value = readSupervisorJson(CC5_AUTHORITY_KEYRING_FILE) as {
      version: number
      keyring: string
    }
    requireCc5(value.version === 1 && typeof value.keyring === 'string')
    const keys = parseAuthorityKeyring(value.keyring)
    requireCc5(keys.size > 0)
    return keys
  } catch {
    throw new Error('CC5_BRIDGE_AUTHORITY_KEYS_INVALID')
  }
}

export interface Cc5BridgePort {
  readonly bindingId: string
  readonly executionBackend: Cc5ExecutionBackend
  readonly canonicalModel: string
  prepare(input?: { cwd: string }): Promise<SpawnOpts>
  admit(input: { authority: TurnModelAuthority; turnKey: string; model: string }): Promise<void>
  renew(leaseEnvelope: string): Promise<void>
  interrupt?(): Promise<void>
  close(): Promise<void>
}

/** One request, no transport retries. A lost ACK is not permission to resubmit. */
export function cc5ControlRequest(
  path: '/admit' | '/renew' | '/interrupt' | '/stop' | '/tool/register' | '/tool/stopped',
  body: Readonly<Record<string, unknown>>,
  socketPath: string,
): Promise<Record<string, unknown>> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        agent: false,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 65536) req.destroy(new Error('CC5_CONTROL_RESPONSE_LIMIT'))
          else chunks.push(chunk)
        })
        res.on('error', reject)
        res.on('aborted', () => reject(new Error('CC5_CONTROL_RESPONSE_UNKNOWN')))
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error('CC5_CONTROL_REJECTED'))
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
              string,
              unknown
            >
            if (!value || value.ok !== true) throw new Error('CC5_CONTROL_REJECTED')
            resolve(value)
          } catch {
            reject(new Error('CC5_CONTROL_RESPONSE_INVALID'))
          }
        })
      },
    )
    const timer = setTimeout(() => req.destroy(new Error('CC5_CONTROL_DELIVERY_UNKNOWN')), 90000)
    req.once('close', () => clearTimeout(timer))
    req.once('error', reject)
    req.end(payload)
  })
}

export class UnixCc5BridgePort implements Cc5BridgePort {
  readonly bindingId: string
  readonly executionBackend: Cc5ExecutionBackend
  readonly canonicalModel: string
  private stopPromise?: Promise<void>
  private closed = false
  private active = false
  private admitting = false
  private mutableExpiresAt: number
  constructor(
    private readonly binding: Readonly<Cc5BridgeBinding>,
    private readonly sessionKey: string,
    private readonly call: (
      path: Parameters<typeof cc5ControlRequest>[0],
      body: Readonly<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>> = (path, body) =>
      cc5ControlRequest(path, body, cc5LanePaths(binding.operationId).socket),
  ) {
    this.bindingId = binding.operationId
    assertCc5BindingScope(binding)
    requireCc5(sessionKey === binding.sessionKey)
    this.executionBackend = Object.freeze({ kind: binding.backendKind, sessionKey,
      operationId: binding.operationId })
    this.canonicalModel = binding.canonicalModel
    this.mutableExpiresAt = binding.expiresAt
  }
  private effectiveExpiresAt(): number {
    return Math.max(this.binding.expiresAt, this.mutableExpiresAt)
  }
  async prepare(input?: { cwd: string }): Promise<SpawnOpts> {
    requireCc5(!this.closed && this.effectiveExpiresAt() > Date.now())
    const entry = fileURLToPath(new URL('../dist/cc5StdioBridge.js', import.meta.url))
    const cwd = input?.cwd ?? dirname(entry)
    requireCc5(isAbsolute(cwd) && statSync(cwd).isDirectory())
    try {
      const meta = statSync(entry)
      if (!meta.isFile() || meta.size === 0) throw new Error('empty')
    } catch {
      throw new Error('CC5_BRIDGE_MISSING')
    }
    return {
      command: process.execPath,
      args: ['--conditions=openclaude-precompiled', entry, this.sessionKey, this.binding.operationId],
      ccbBinaryDir: dirname(entry),
      subprocessCwd: cwd,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    }
  }
  private scope(): Record<string, unknown> {
    return {
      capability: this.binding.capability,
      uid: this.binding.uid,
      containerDbId: this.binding.containerDbId,
      dockerId: this.binding.dockerId,
      operationId: this.binding.operationId,
      sessionKey: this.sessionKey,
    }
  }
  async admit(input: {
    authority: TurnModelAuthority
    turnKey: string
    model: string
  }): Promise<void> {
    // Snapshot before the first await: a rolling lease owner is mutable.
    const authority = input.authority.authorityEnvelope
    const lease = input.authority.leaseEnvelope
    const turnKey = input.turnKey
    requireCc5(
      !this.closed &&
        !this.admitting &&
        input.model === this.binding.canonicalModel &&
        input.authority.executionDescriptor.canonicalModel === this.binding.canonicalModel &&
        input.authority.executionDescriptor.executionBackend?.kind === this.binding.backendKind &&
        input.authority.executionDescriptor.executionBackend.sessionKey === this.binding.sessionKey &&
        input.authority.executionDescriptor.executionBackend.operationId === this.binding.operationId &&
        this.effectiveExpiresAt() > Date.now() &&
        authority &&
        lease &&
        turnKey,
    )
    // The relay owns the per-turn fence. A lost ACK closes this port; it is never replayed.
    this.admitting = true
    this.active = true
    const expected = createHash('sha256').update(authority).update('\0').update(lease).digest('hex')
    const response = await this.call('/admit', { ...this.scope(), authority, lease, turnKey })
    requireCc5(!this.closed && response.admissionHash === expected && response.ready === true)
    if (typeof response.expiresAt === 'number' && Number.isSafeInteger(response.expiresAt)) {
      this.mutableExpiresAt = Math.max(this.mutableExpiresAt, response.expiresAt)
    }
    this.admitting = false
  }
  async renew(leaseEnvelope: string): Promise<void> {
    requireCc5(!this.closed && this.active && this.effectiveExpiresAt() > Date.now())
    const response = await this.call('/renew', { ...this.scope(), lease: leaseEnvelope })
    if (typeof response.expiresAt === 'number' && Number.isSafeInteger(response.expiresAt)) {
      this.mutableExpiresAt = Math.max(this.mutableExpiresAt, response.expiresAt)
    }
  }
  async interrupt(): Promise<void> {
    if (this.closed || !this.active) return
    await this.call('/interrupt', this.scope())
  }
  close(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.closed = true // admission is revoked before awaiting remote stop.
    this.stopPromise = this.call('/stop', this.scope()).then((response) => {
      requireCc5(response.remoteStopped === true)
    })
    return this.stopPromise
  }
}

export function createCc5BridgePort(
  sessionKey: string,
  executionBackend: Cc5ExecutionBackend,
  canonicalModel: string,
  env: NodeJS.ProcessEnv = process.env,
): Cc5BridgePort {
  const expected = parseCc5ExecutionBackend(executionBackend)
  const binding = readCc5Binding(cc5LanePaths(expected.operationId).binding)
  requireCc5(binding.uid === env.OC_USER_ID && binding.containerDbId === env.OC_CONTAINER_ID &&
    expected.sessionKey === sessionKey && expected.sessionKey === binding.sessionKey &&
    expected.operationId === binding.operationId && canonicalModel === binding.canonicalModel)
  return new UnixCc5BridgePort(binding, sessionKey)
}
