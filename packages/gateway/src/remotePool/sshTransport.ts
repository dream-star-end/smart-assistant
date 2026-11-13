/**
 * Shared SSH & sandbox host transport (`remote-driver-v4`) invoking `scripts/agent-remote/core/controller.py`.
 *
 * Security invariants:
 * - SSH transport enforces `ControlMaster=no`, `ControlPath=none`, `BatchMode=yes`, `StrictHostKeyChecking=yes`,
 *   `IdentitiesOnly=yes`, `ForwardAgent=no`, `ClearAllForwardings=yes`.
 * - Stop requires BOTH `fence-stop` and `prove-stopped` with matching `bootId`, empty cgroup (`populated === 0`),
 *   and verified `dev`/`inode` identity before returning `{ remoteStopped: true }`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { validateRemoteProbeSnapshot } from '@openclaude/protocol'
import type { RemoteCcTarget } from '../cc5SshHost.js'
import { isRemoteResourceCode, type RemoteResourceCode } from '../remoteNodeMemory.js'
import {
  remotePoolNeed,
  type RemotePoolHostPort,
  type RemotePoolLaneSpec,
  type RemotePoolPreflight,
  type RemotePoolProbeOutput,
} from './types.js'

const MAX_BUFFER_BYTES = 8 * 1024 * 1024

export function readJsonLines(
  child: ChildProcessWithoutNullStreams,
  handle: (frame: any) => void,
  fail: (error: Error) => void,
): void {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  child.stderr.resume()
  child.stdout.on('data', (chunk: Buffer) => {
    try {
      buffer += decoder.decode(chunk, { stream: true })
      remotePoolNeed(Buffer.byteLength(buffer, 'utf8') <= MAX_BUFFER_BYTES, 'REMOTE_HOST_FRAME_OVERFLOW')
      let split: number
      while ((split = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, split)
        buffer = buffer.slice(split + 1)
        remotePoolNeed(line.length > 0, 'REMOTE_HOST_EMPTY_FRAME')
        handle(JSON.parse(line))
      }
    } catch (err) {
      fail(err instanceof Error ? err : new Error('REMOTE_HOST_FRAME_INVALID'))
    }
  })
  child.once('error', fail)
  child.once('close', () => {
    try {
      if (buffer || decoder.decode()) fail(new Error('REMOTE_HOST_FRAME_TRUNCATED'))
    } catch {
      fail(new Error('REMOTE_HOST_FRAME_TRUNCATED'))
    }
  })
}

export function buildPinnedSshArgs(
  target: RemoteCcTarget,
  controllerPath: string,
  role: string,
  root: string,
): string[] {
  const quote = (val: string) => `'${val.replaceAll("'", "'\\''")}'`
  const remoteCmd = ['/usr/bin/python3', '-I', '-B', controllerPath, role, root].map(quote).join(' ')
  return [
    '-F',
    'none',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${target.knownHostsPath}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'IdentityAgent=none',
    '-o',
    'ForwardAgent=no',
    '-o',
    'ClearAllForwardings=yes',
    '-o',
    'ConnectTimeout=10',
    '-i',
    target.keyPath,
    '-p',
    String(target.port),
    `${target.user}@${target.host}`,
    remoteCmd,
  ]
}

export class RemotePoolSshHost implements RemotePoolHostPort {
  private readonly opened = new Set<string>()
  private revoked = false
  private stopping?: Promise<{ remoteStopped: true; noHostEffect?: boolean }>
  private stopEvidence?: { fence: unknown; proof: unknown }

  constructor(
    private readonly spec: RemotePoolLaneSpec,
    private readonly spawnChannel: (role: string, taskRoot?: string) => ChildProcessWithoutNullStreams,
    private readonly restoreExisting = false,
  ) {}

  static forSshTarget(
    target: RemoteCcTarget,
    spec: RemotePoolLaneSpec,
    spawnSsh: (args: string[]) => ChildProcessWithoutNullStreams = (args) =>
      spawn('/usr/bin/ssh', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      }),
    restoreExisting = false,
  ): RemotePoolSshHost {
    remotePoolNeed(
      /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(target.host) &&
        /^[a-z_][a-z0-9_-]{0,31}$/.test(target.user) &&
        target.user !== 'root' &&
        Number.isInteger(target.port) &&
        target.port > 0 &&
        target.port <= 65535 &&
        spec.manifest.root.startsWith(`/home/${target.user}/oc-remotedrv-`) &&
        /^[a-z0-9-]{16,72}$/.test(spec.manifest.root.split('/').at(-1)!.replace('oc-remotedrv-', '')) &&
        /^\/opt\/openclaude\/remote-driver\/[a-f0-9]{64}\/core\/controller\.py$/.test(spec.controllerPath) &&
        spec.controllerPath.includes(spec.controllerSha256),
      'REMOTE_SSH_TARGET_OR_CONTROLLER_INVALID',
    )
    for (const filePath of [target.keyPath, target.knownHostsPath]) {
      const st = lstatSync(filePath)
      remotePoolNeed(
        isAbsolute(filePath) &&
          st.isFile() &&
          !st.isSymbolicLink() &&
          st.uid === 0 &&
          st.nlink === 1 &&
          !(st.mode & 0o022),
        'REMOTE_SSH_KEY_OR_KNOWN_HOSTS_UNSAFE',
      )
      if (filePath === target.keyPath) {
        remotePoolNeed(!(st.mode & 0o077), 'REMOTE_SSH_KEY_PERMISSIONS_UNSAFE')
      }
    }
    return new RemotePoolSshHost(
      spec,
      (role, taskRoot = spec.manifest.root) =>
        spawnSsh(buildPinnedSshArgs(target, spec.controllerPath, role, taskRoot)),
      restoreExisting,
    )
  }

  /**
   * Direct local controller process transport strictly restricted to `/tmp/oc-drvtest-*` roots
   * for deterministic hermetic integration and conformance tests (no mock execution).
   */
  static forLocalSandbox(
    spec: RemotePoolLaneSpec,
    extraEnv: Record<string, string> = {},
    restoreExisting = false,
  ): RemotePoolSshHost {
    remotePoolNeed(
      spec.manifest.root.startsWith('/tmp/oc-drvtest-'),
      'REMOTE_LOCAL_SANDBOX_ROOT_FORBIDDEN',
    )
    return new RemotePoolSshHost(
      spec,
      (role, taskRoot = spec.manifest.root) =>
        spawn('/usr/bin/python3', ['-I', '-B', spec.controllerPath, role, taskRoot], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            HOME: process.env.HOME ?? '/tmp',
            PATH: '/usr/bin:/bin',
            LANG: 'C.UTF-8',
            ...extraEnv,
          },
        }),
      restoreExisting,
    )
  }

  get verifiedStopEvidence(): unknown {
    return this.stopEvidence ? structuredClone(this.stopEvidence) : undefined
  }

  private control(role: string, packet?: unknown, taskRoot?: string): Promise<any> {
    const child = this.spawnChannel(role, taskRoot)
    const rows: any[] = []
    return new Promise((resolve, reject) => {
      let failed = false
      const fail = (err: Error) => {
        if (failed) return
        failed = true
        reject(err)
        child.kill('SIGTERM')
      }
      const timer = setTimeout(() => fail(new Error('REMOTE_HOST_CONTROL_TIMEOUT')), 30_000)
      timer.unref()
      readJsonLines(
        child,
        (row) => {
          if (rows.length > 0) fail(new Error('REMOTE_HOST_CONTROL_MULTI_ROW'))
          else rows.push(row)
        },
        fail,
      )
      child.once('close', (code) => {
        clearTimeout(timer)
        if (failed) return
        if (code !== 0 || rows.length !== 1) {
          if (rows.length === 1 && rows[0]?.kind === 'error' && isRemoteResourceCode(rows[0].code)) {
            const memErr = new Error(rows[0].code) as Error & { activeSessions?: number }
            memErr.activeSessions = rows[0].activeSessions
            reject(memErr)
            return
          }
          reject(new Error('REMOTE_HOST_CONTROL_FAILED'))
        } else {
          resolve(rows[0])
        }
      })
      child.stdin.end(packet === undefined ? undefined : `${JSON.stringify(packet)}\n`)
    })
  }

  private checkIdentity(row: any): void {
    remotePoolNeed(row?.version === 4, 'REMOTE_HOST_PROTOCOL_MISMATCH')
    for (const k of ['driverId', 'engineId', 'operationId', 'runId', 'generation', 'profileId', 'authEpoch'] as const) {
      remotePoolNeed(row[k] === this.spec.manifest[k], 'REMOTE_HOST_IDENTITY_MISMATCH')
    }
  }

  private checkScopeProofList(row: any, maxScopes: number): void {
    const seenUnits = new Set<string>()
    for (const s of row.scopes) {
      for (const k of ['driverId', 'engineId', 'operationId', 'runId', 'generation', 'profileId', 'authEpoch'] as const) {
        remotePoolNeed(s[k] === this.spec.manifest[k], 'REMOTE_STOP_SCOPE_IDENTITY_MISMATCH')
      }
      remotePoolNeed(
        s.bootId === row.bootId &&
          typeof s.unit === 'string' &&
          s.unit.endsWith('.scope') &&
          !seenUnits.has(s.unit) &&
          typeof s.cgroup === 'string' &&
          s.cgroup.endsWith(`/${s.unit}`) &&
          s.populated === 0 &&
          typeof s.domainRemoved === 'boolean' &&
          Number.isSafeInteger(s.dev) &&
          s.dev > 0 &&
          Number.isSafeInteger(s.inode) &&
          s.inode > 0,
        'REMOTE_STOP_SCOPE_PROOF_INVALID',
      )
      seenUnits.add(s.unit)
    }
    remotePoolNeed(seenUnits.size <= maxScopes, 'REMOTE_STOP_PROOF_INVALID')
  }

  private checkStopProof(row: any): void {
    this.checkIdentity(row)
    remotePoolNeed(
      row.remoteStopped === true &&
        typeof row.bootId === 'string' &&
        /^[a-f0-9-]{36}$/i.test(row.bootId) &&
        Array.isArray(row.scopes) &&
        row.scopes.length <= 2,
      'REMOTE_STOP_PROOF_INVALID',
    )
    this.checkScopeProofList(row, 2)
  }

  private checkAppRecycleProof(row: any): void {
    this.checkIdentity(row)
    remotePoolNeed(
      row.kind === 'app-recycled' &&
        row.appStopped === true &&
        typeof row.bootId === 'string' &&
        /^[a-f0-9-]{36}$/i.test(row.bootId) &&
        Array.isArray(row.scopes) &&
        row.scopes.length <= 1,
      'REMOTE_APP_RECYCLE_PROOF_INVALID',
    )
    this.checkScopeProofList(row, 1)
  }

  async preflight(): Promise<RemotePoolPreflight> {
    remotePoolNeed(!this.opened.size && !this.revoked, 'REMOTE_PREFLIGHT_AFTER_OPEN')
    const sandboxBypassAdmit =
      this.spec.manifest.root.startsWith('/tmp/oc-drvtest-') &&
      this.spec.driverContext?.testFaultBypassAdmit === true
    const row = await this.control('preflight', {
      engineId: this.spec.manifest.engineId,
      ...(this.spec.registryPath ? { registryPath: this.spec.registryPath } : {}),
      ...(sandboxBypassAdmit ? { testFaultBypassAdmit: true } : {}),
    })
    remotePoolNeed(
      row?.version === 4 &&
        row.engineId === this.spec.manifest.engineId &&
        row.kind === 'preflight' &&
        typeof row.memoryOk === 'boolean' &&
        Number.isSafeInteger(row.activeSessions) &&
        row.activeSessions >= 0 &&
        (row.memoryOk === true || isRemoteResourceCode(row.code)),
      'REMOTE_PREFLIGHT_INVALID',
    )
    return {
      memoryOk: row.memoryOk,
      activeSessions: row.activeSessions,
      ...(row.memoryOk ? {} : { code: row.code as RemoteResourceCode }),
    }
  }

  async provision(tools: unknown, defaultsContext?: Readonly<Record<string, unknown>>): Promise<void> {
    remotePoolNeed(!this.opened.size && !this.revoked, 'REMOTE_PROVISION_ALREADY_OPENED')
    this.opened.add('provision')
    const mergedContext = defaultsContext
      ? { ...defaultsContext, ...this.spec.driverContext }
      : this.spec.driverContext
    const row = await this.control('provision', {
      manifest: this.spec.manifest,
      tools,
      driverContext: mergedContext,
      verifiedProbe: this.spec.verifiedProbe,
      ...(this.spec.registryPath ? { registryPath: this.spec.registryPath } : {}),
    })
    this.checkIdentity(row)
    remotePoolNeed(row.kind === 'provisioned', 'REMOTE_PROVISION_ACK_INVALID')
  }

  async recycleApp(): Promise<{ appStopped: true; noHostEffect?: boolean }> {
    remotePoolNeed(this.opened.has('provision') && !this.revoked, 'REMOTE_RECYCLE_INVALID_STATE')
    if (!this.opened.has('launch')) {
      return { appStopped: true, noHostEffect: true }
    }
    const row = await this.control('recycle-app')
    this.checkAppRecycleProof(row)
    this.opened.delete('launch')
    return {
      appStopped: true,
      ...(row.noHostEffect === true ? { noHostEffect: true } : {}),
    }
  }

  async reprovisionApp(tools: unknown, defaultsContext?: Readonly<Record<string, unknown>>): Promise<void> {
    remotePoolNeed(
      this.opened.has('provision') && !this.opened.has('launch') && !this.revoked,
      'REMOTE_REPROVISION_INVALID_STATE',
    )
    const { systemPrompt: _staleSystemPrompt, ...baseDriverContext } = this.spec.driverContext ?? {}
    const mergedContext = defaultsContext
      ? { ...baseDriverContext, ...defaultsContext }
      : baseDriverContext
    const row = await this.control('reprovision-app', {
      manifest: this.spec.manifest,
      tools,
      driverContext: mergedContext,
      verifiedProbe: this.spec.verifiedProbe,
      ...(this.spec.registryPath ? { registryPath: this.spec.registryPath } : {}),
    })
    this.checkIdentity(row)
    remotePoolNeed(row.kind === 'reprovisioned', 'REMOTE_REPROVISION_ACK_INVALID')
  }

  open(role: 'launch' | 'tool-socket'): ChildProcessWithoutNullStreams {
    remotePoolNeed(
      this.opened.has('provision') && !this.opened.has(role) && !this.revoked,
      'REMOTE_OPEN_ORDER_INVALID',
    )
    this.opened.add(role)
    return this.spawnChannel(role)
  }

  async probe(context: Record<string, unknown>, probeRoot?: string): Promise<RemotePoolProbeOutput> {
    const row = await this.control(
      'probe',
      {
        driverId: this.spec.manifest.driverId,
        profileId: this.spec.manifest.profileId,
        context,
        ...(this.spec.registryPath ? { registryPath: this.spec.registryPath } : {}),
      },
      probeRoot,
    )
    remotePoolNeed(row?.version === 4 && row.kind === 'probe-result', 'REMOTE_PROBE_RESULT_INVALID')
    return {
      snapshot: validateRemoteProbeSnapshot(row.snapshot),
      driverDigest: String(row.driverDigest),
      coreDigest: String(row.coreDigest),
      probeFingerprint: String(row.probeFingerprint),
    }
  }

  stop(): Promise<{ remoteStopped: true; noHostEffect?: boolean }> {
    this.revoked = true
    return (this.stopping ??= (async () => {
      if (!this.opened.size && !this.restoreExisting) {
        return { remoteStopped: true as const, noHostEffect: true }
      }
      const fenceRow = await this.control('fence-stop', this.spec.manifest)
      this.checkStopProof(fenceRow)
      const proofRow = await this.control('prove-stopped')
      this.checkStopProof(proofRow)
      remotePoolNeed(proofRow.bootId === fenceRow.bootId, 'REMOTE_STOP_BOOT_MISMATCH')
      this.stopEvidence = structuredClone({ fence: fenceRow, proof: proofRow })
      return { remoteStopped: true as const, noHostEffect: proofRow.scopes.length === 0 }
    })().catch((err) => {
      this.stopping = undefined
      throw err
    }))
  }
}
