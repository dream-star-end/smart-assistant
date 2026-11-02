/** Task-only live-web transport. No CLI, provider credentials or remote shell here. */
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CC5_TEST_MODEL_ID, canUseCc5TestModel } from '@openclaude/protocol'
import type { TurnModelAuthority } from './subprocessSpawnConfig.js'
import type { SpawnOpts } from './terminalBackend.js'

export const CC5_BINDING_FILE = '/run/oc/cc5-remote-t1555u/binding.json'
export const CC5_RELAY_SOCKET = '/run/oc/cc5-remote-t1555u/relay.sock'
export const CC5_BRIDGE_MAX_FRAME_BYTES = 8 * 1024 * 1024
export interface Cc5BridgeBinding {
  version: 1
  uid: string
  containerDbId: string
  dockerId: string
  operationId: string
  capability: string
  expiresAt: number
}

function requireCc5(value: unknown): asserts value {
  if (!value) throw new Error('CC5_BRIDGE_BINDING_INVALID')
}

/** Only the supervisor's root-owned read-only bind may select a relay. */
export function readCc5Binding(
  path = CC5_BINDING_FILE,
  now = Date.now(),
): Readonly<Cc5BridgeBinding> {
  requireCc5(path === CC5_BINDING_FILE)
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
        meta.size <= 4096,
    )
    const b = JSON.parse(readFileSync(fd, 'utf8')) as Cc5BridgeBinding
    requireCc5(
      b.version === 1 &&
        /^[1-9][0-9]*$/.test(b.uid) &&
        /^[1-9][0-9]*$/.test(b.containerDbId) &&
        /^[a-f0-9]{64}$/.test(b.dockerId) &&
        /^[a-f0-9-]{36}$/.test(b.operationId) &&
        /^[a-f0-9]{64}$/.test(b.capability) &&
        Number.isSafeInteger(b.expiresAt) &&
        b.expiresAt > now,
    )
    return Object.freeze(b)
  } finally {
    closeSync(fd)
  }
}

export interface Cc5BridgePort {
  readonly bindingId: string
  prepare(): Promise<SpawnOpts>
  admit(input: { authority: TurnModelAuthority; turnKey: string; model: string }): Promise<void>
  renew(leaseEnvelope: string): Promise<void>
  close(): Promise<void>
}

/** One request, no transport retries. A lost ACK is not permission to resubmit. */
export function cc5ControlRequest(
  path: '/admit' | '/renew' | '/stop',
  body: Readonly<Record<string, unknown>>,
  socketPath = CC5_RELAY_SOCKET,
): Promise<Record<string, unknown>> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
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
  private stopPromise?: Promise<void>
  private closed = false
  private active = false
  constructor(
    private readonly binding: Readonly<Cc5BridgeBinding>,
    private readonly sessionKey: string,
    private readonly call = cc5ControlRequest,
  ) {
    this.bindingId = binding.operationId
    requireCc5(sessionKey.length > 0 && sessionKey.length <= 512)
  }
  async prepare(): Promise<SpawnOpts> {
    requireCc5(!this.closed && this.binding.expiresAt > Date.now())
    const entry = fileURLToPath(new URL('./cc5StdioBridge.js', import.meta.url))
    return {
      command: process.execPath,
      args: [entry, this.sessionKey],
      ccbBinaryDir: dirname(entry),
      subprocessCwd: dirname(entry),
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
        !this.active &&
        input.model === CC5_TEST_MODEL_ID &&
        input.authority.executionDescriptor.canonicalModel === CC5_TEST_MODEL_ID &&
        this.binding.expiresAt > Date.now() &&
        authority &&
        lease &&
        turnKey,
    )
    // This one-round test profile never opens a second admission, even on a lost ACK.
    this.active = true
    const expected = createHash('sha256').update(authority).update('\0').update(lease).digest('hex')
    const response = await this.call('/admit', { ...this.scope(), authority, lease, turnKey })
    requireCc5(!this.closed && response.admissionHash === expected && response.ready === true)
  }
  async renew(leaseEnvelope: string): Promise<void> {
    requireCc5(!this.closed && this.active && this.binding.expiresAt > Date.now())
    await this.call('/renew', { ...this.scope(), lease: leaseEnvelope })
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
  env: NodeJS.ProcessEnv = process.env,
): Cc5BridgePort {
  requireCc5(canUseCc5TestModel(env.OC_USER_ID, env))
  const binding = readCc5Binding()
  requireCc5(binding.uid === env.OC_USER_ID && binding.containerDbId === env.OC_CONTAINER_ID)
  return new UnixCc5BridgePort(binding, sessionKey)
}
