import { isRemoteResourceCode, type RemoteResourceCode } from './remoteNodeMemory.js'
/** Trusted master/node contract. Transport never interprets a container command as SSH argv. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { codexNeed } from './codexRemoteContract.js'
import type { RemoteCcTarget } from './cc5SshHost.js'
export interface CodexLaneSpec {
  controllerPath: string
  manifest: { version: 1; engine: 'codex'; root: string; operationId: string; runId: string;
    generation: string; profileId: string; authEpoch: string; model: string; nativeThreadId: string | null;
    codexHome: string; controllerSha256: string; cliSha256: string; nativeSha256: string }
  modelList: Array<Record<string, any>>
  modelCatalog: { models: Array<Record<string, any>> }
}
export interface CodexPreflight {
  memoryOk: boolean
  /** Fixed node label when admission refuses; never a synthesized cause. */
  code?: RemoteResourceCode
  /** Sessions of this engine already running on the node, as observed by the node itself. */
  activeSessions: number
}
export interface CodexHostPort {
  /** Read-only node admission before any session is started; no root, claim or scope exists yet. */
  preflight(): Promise<CodexPreflight>
  provision(tools: unknown): Promise<void>
  open(role: 'launch' | 'tool-socket'): ChildProcessWithoutNullStreams
  stop(): Promise<{ remoteStopped: true; noHostEffect?: boolean }>
}
export function readCodexLines(child: ChildProcessWithoutNullStreams, handle: (frame: any) => void, fail: (error: Error) => void): void {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  child.stderr.resume() // Never relay arbitrary node stderr/credentials.
  child.stdout.on('data', (chunk: Buffer) => {
    try {
      buffer += decoder.decode(chunk, { stream: true })
      codexNeed(Buffer.byteLength(buffer) <= 8 * 1024 * 1024)
      while (buffer.includes('\n')) {
        const split = buffer.indexOf('\n'), line = buffer.slice(0, split)
        buffer = buffer.slice(split + 1)
        codexNeed(line.length > 0)
        handle(JSON.parse(line))
      }
    } catch (e) { fail(e instanceof Error ? e : new Error('CODEX_FRAME_INVALID')) }
  })
  child.once('error', fail)
  child.once('close', () => { try { if (buffer || decoder.decode()) fail(new Error('CODEX_FRAME_TRUNCATED')) } catch { fail(new Error('CODEX_FRAME_TRUNCATED')) } })
}
export class CodexSshHost implements CodexHostPort {
  private readonly opened = new Set<string>()
  private revoked = false
  private stopEvidence?: { fence: unknown; proof: unknown }
  get verifiedStopEvidence(): unknown { return this.stopEvidence ? structuredClone(this.stopEvidence) : undefined }
  private stopping?: Promise<{ remoteStopped: true; noHostEffect?: boolean }>
  constructor(private readonly target: RemoteCcTarget, private readonly spec: CodexLaneSpec,
    private readonly spawnSsh = (args: string[]) => spawn('/usr/bin/ssh', args, { stdio: ['pipe','pipe','pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } }),
    private readonly restoreExisting = false) {
    codexNeed(/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(target.host) && /^[a-z_][a-z0-9_-]{0,31}$/.test(target.user)
      && target.user !== 'root' && Number.isInteger(target.port) && target.port > 0 && target.port <= 65535
      && spec.manifest.root.startsWith(`/home/${target.user}/oc-codexremote-`)
      && /^[a-z0-9-]{16,60}$/.test(spec.manifest.root.split('/').at(-1)!.replace('oc-codexremote-', ''))
      && /^\/opt\/openclaude\/codex-remote\/[a-f0-9]{64}\/codex-host-controller\.py$/.test(spec.controllerPath)
      && spec.controllerPath.includes(spec.manifest.controllerSha256))
    for (const path of [target.keyPath, target.knownHostsPath]) {
      const st = lstatSync(path)
      codexNeed(isAbsolute(path) && st.isFile() && !st.isSymbolicLink() && st.uid === 0 && st.nlink === 1 && !(st.mode & 0o022))
      if (path === target.keyPath) codexNeed(!(st.mode & 0o077))
    }
  }
  private channel(role: string): ChildProcessWithoutNullStreams {
    const t = this.target
    const quote = (x: string) => `'${x.replaceAll("'", "'\\''")}'`
    const command = ['/usr/bin/python3','-I','-B',this.spec.controllerPath,role,this.spec.manifest.root].map(quote).join(' ')
    return this.spawnSsh(['-F','none','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
      '-o',`UserKnownHostsFile=${t.knownHostsPath}`,'-o','GlobalKnownHostsFile=/dev/null',
      '-o','ControlMaster=no','-o','ControlPath=none','-o','IdentitiesOnly=yes','-o','IdentityAgent=none',
      '-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','ConnectTimeout=10',
      '-i',t.keyPath,'-p',String(t.port),`${t.user}@${t.host}`,command])
  }
  private async control(role: string, packet?: unknown): Promise<any> {
    const child = this.channel(role)
    const rows: any[] = []
    return await new Promise((resolve, reject) => {
      let failed = false
      const fail = (e: Error) => { failed = true; reject(e); child.kill('SIGTERM') }
      const timer = setTimeout(() => fail(new Error('CODEX_CONTROL_UNKNOWN')), 30000)
      readCodexLines(child, row => { if (rows.length) fail(new Error('CODEX_CONTROL_INVALID')); else rows.push(row) }, fail)
      child.once('close', code => {
        clearTimeout(timer)
        if (failed) return
        if (code !== 0 || rows.length !== 1) reject(new Error('CODEX_CONTROL_UNKNOWN'))
        else resolve(rows[0])
      })
      child.stdin.end(packet === undefined ? undefined : `${JSON.stringify(packet)}\n`)
    })
  }
  async preflight(): Promise<CodexPreflight> {
    codexNeed(!this.opened.size && !this.revoked)
    const row = await this.control('preflight')
    codexNeed(row?.version === 1 && row.engine === 'codex' && row.kind === 'preflight' &&
      typeof row.memoryOk === 'boolean' && Number.isSafeInteger(row.activeSessions) && row.activeSessions >= 0 &&
      (row.memoryOk === true || isRemoteResourceCode(row.code)))
    return { memoryOk: row.memoryOk, activeSessions: row.activeSessions,
      ...(row.memoryOk ? {} : { code: row.code as RemoteResourceCode }) }
  }
  async provision(tools: unknown): Promise<void> {
    codexNeed(!this.opened.size && !this.revoked)
    this.opened.add('provision')
    const row = await this.control('provision', { ...this.spec, controllerPath: undefined, tools })
    this.checkIdentity(row)
    codexNeed(row.kind === 'provisioned')
  }
  private checkProof(row: any): void {
    this.checkIdentity(row)
    codexNeed(row.remoteStopped === true && typeof row.bootId === 'string' && /^[a-f0-9-]{36}$/.test(row.bootId)
      && Array.isArray(row.scopes) && row.scopes.length <= 2)
    const seen = new Set<string>()
    for (const s of row.scopes) {
      for (const k of ['operationId','runId','generation','profileId','authEpoch'] as const) codexNeed(s[k] === this.spec.manifest[k])
      codexNeed(s.controllerSha256 === this.spec.manifest.controllerSha256 && s.bootId === row.bootId
        && /^oc-codex-[a-f0-9]{32}\.scope$/.test(s.unit) && !seen.has(s.unit)
        && typeof s.cgroup === 'string' && s.cgroup.endsWith('/'+s.unit) && s.populated === 0
        && typeof s.domainRemoved === 'boolean' && Number.isSafeInteger(s.dev) && s.dev > 0 && Number.isSafeInteger(s.inode) && s.inode > 0)
      seen.add(s.unit)
    }
  }
  private checkIdentity(row: any): void {
    codexNeed(row?.version === 1 && row.engine === 'codex')
    for (const k of ['operationId','runId','generation','profileId','authEpoch'] as const) codexNeed(row[k] === this.spec.manifest[k])
  }
  open(role: 'launch' | 'tool-socket'): ChildProcessWithoutNullStreams {
    codexNeed(this.opened.has('provision') && !this.opened.has(role) && !this.revoked)
    this.opened.add(role)
    return this.channel(role)
  }
  stop(): Promise<{ remoteStopped: true; noHostEffect?: boolean }> {
    this.revoked = true
    return this.stopping ??= (async () => {
      // No remote effect was attempted: a local proof is sufficient only in this exact case.
      if (!this.opened.size && !this.restoreExisting) return { remoteStopped: true as const }
      const row = await this.control('fence-stop',this.spec.manifest); this.checkProof(row)
      const proof = await this.control('prove-stopped'); this.checkProof(proof)
      codexNeed(proof.bootId === row.bootId)
      this.stopEvidence = structuredClone({ fence: row, proof })
      return { remoteStopped: true as const, noHostEffect: proof.scopes.length === 0 }
    })().catch(error => { this.stopping = undefined; throw error })
  }
}
