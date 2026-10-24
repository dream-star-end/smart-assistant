/** Inert host-only supervisor. Not registered with any operation, HTTP route, user runtime or container. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdtemp, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { findProfileControlGenerationReceipt, type ProfileGenerationReceipt } from './authorityGeneration.js'
import { parseProfileControlVersion } from './profileControlVersion.js'
import { exactKeys, parseProfileControlRequest, PROFILE_WORKER_MAX_BYTES, type ProfileControlRequest } from './profileControlWire.js'
import type { SystemActionControlRecoveryRecord, SystemActionReceiptBinding, SystemActionStore } from './systemActions.js'
const fail = () => new Error('Profile control unavailable; outcome may be unknown')
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
type Options = Readonly<{
  ledger: SystemActionStore; nodeExecutable?: string; hostRoot: string; runtimeRoot: string; workerSha256: string; currentExecutorId: string
  /** Trusted current account/role check, never passed into the worker. */
  authorizeActor(binding: Readonly<SystemActionReceiptBinding>): Promise<void>
  /** Trusted supervisor proof for the original host executor. Missing in-memory child data is not proof. */
  executorProvenGone(executorId: string): Promise<boolean>
}>
type ObservedChild = { executorId: string; token: string; binding: Readonly<SystemActionReceiptBinding>; jobId: string; pid: number | undefined; exited: boolean }
async function directory(path: string, privateMode = false) {
  const s = await lstat(path)
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & (privateMode ? 0o077 : 0o022)) !== 0 || await realpath(path) !== path) throw fail()
}
/** A root-owned child is still replaceable when an untrusted user owns/writes its parent. */
async function trustedAncestors(path: string) {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const stat = await lstat(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== process.getuid?.()) || await realpath(dir) !== dir
      || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) throw fail()
    if (dir === '/') break
  }
}
async function artifact(root: string, expected: string) {
  if (!isAbsolute(root) || resolve(root) !== root || root === '/' || expected.length !== 64 || !/^[a-f0-9]{64}$/.test(expected)) throw fail()
  await trustedAncestors(root)
  const file = join(root, 'packages/storage/dist/profile-control-worker.mjs')
  for (let dir = dirname(file); ; dir = dirname(dir)) { await directory(dir); if (dir === root) break; if (!relative(root, dir) || relative(root, dir).startsWith('..')) throw fail() }
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || stat.size > 1048576 || await realpath(file) !== file || hash(await readFile(file)) !== expected) throw fail()
  return file
}
function validReceipt(value: unknown, binding: Readonly<SystemActionReceiptBinding>): value is ProfileGenerationReceipt {
  if (!exactKeys(value, ['binding', 'generation', 'result']) || !same(value.binding, binding) || typeof value.generation !== 'string'
    || value.generation.length !== 36 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.generation)
    || !exactKeys(value.result, ['version']) || typeof value.result.version !== 'string' || value.result.version.length !== 16 || !/^[a-f0-9]{16}$/.test(value.result.version)) return false
  return true
}
export class ProfileControlBroker {
  private closed = false
  private readonly jobs = new Set<Promise<unknown>>()
  private readonly reserved = new Set<string>()
  private readonly observed = new Map<string, ObservedChild>()
  private constructor(private readonly options: Options, private readonly entry: string, private readonly node: string) {}
  static async create(input: Options) {
    const options = Object.freeze({ ledger: input.ledger, hostRoot: input.hostRoot, runtimeRoot: input.runtimeRoot,
      workerSha256: input.workerSha256, nodeExecutable: input.nodeExecutable, currentExecutorId: input.currentExecutorId, authorizeActor: input.authorizeActor,
      executorProvenGone: input.executorProvenGone })
    if (process.platform !== 'linux' || !isAbsolute(options.hostRoot) || resolve(options.hostRoot) !== options.hostRoot || options.hostRoot === '/' || !options.currentExecutorId || options.currentExecutorId.length > 256) throw fail()
    await directory(options.hostRoot, true)
    await trustedAncestors(options.hostRoot)
    const entry = await artifact(options.runtimeRoot, options.workerSha256)
    if (options.nodeExecutable !== undefined && (!isAbsolute(options.nodeExecutable) || resolve(options.nodeExecutable) !== options.nodeExecutable)) throw fail()
    const node = await realpath(options.nodeExecutable ?? process.execPath)
    await trustedAncestors(node)
    const stat = await lstat(node)
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw fail()
    return new ProfileControlBroker(options, entry, node)
  }
  private track<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(fail())
    const job = fn(); this.jobs.add(job)
    void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job))
    return job
  }
  private record(userId: string, id: string) {
    const r = this.options.ledger.controlRecoveryRecord(userId, id)
    if (!r) throw fail()
    return r
  }
  private assertCurrent(expected: SystemActionControlRecoveryRecord, recovering: boolean) {
    const now = this.record(expected.binding.userId, expected.binding.id)
    if (this.closed || !same(now, expected) || (recovering ? !['unknown', 'succeeded'].includes(now.state) : now.state !== 'executing' || now.executorId !== this.options.currentExecutorId)) throw fail()
  }
  private async stopped(record: SystemActionControlRecoveryRecord) {
    const prior = this.observed.get(`${record.binding.userId}:${record.binding.id}`)
    if (record.executorId === this.options.currentExecutorId) {
      if (!prior?.exited || prior.executorId !== record.executorId || prior.token !== record.expectedVersion || !same(prior.binding, record.binding)) throw fail()
    } else if (!await this.options.executorProvenGone(record.executorId)) throw fail()
  }
  publish(userId: string, id: string, text: string): Promise<ProfileGenerationReceipt> {
    return this.track(async () => {
      const key = `${userId}:${id}`
      if (this.reserved.has(key) || this.observed.has(key)) throw fail()
      this.reserved.add(key)
      try {
        const record = this.record(userId, id)
        this.assertCurrent(record, false)
        const condition = parseProfileControlVersion(record.expectedVersion)!
        if (typeof text !== 'string' || Buffer.byteLength(text) > 1048576 || hash(Buffer.from(text, 'utf8')) !== condition.targetProfileSha256) throw fail()
        await this.options.authorizeActor(record.binding)
        this.assertCurrent(record, false)
        return await this.run(record, false, text)
      } finally { this.reserved.delete(key) }
    })
  }
  recover(userId: string, id: string): Promise<ProfileGenerationReceipt> {
    return this.track(async () => {
      const key = `${userId}:${id}`
      if (this.reserved.has(key)) throw fail()
      this.reserved.add(key)
      try {
        const record = this.record(userId, id)
        this.assertCurrent(record, true)
        await this.options.authorizeActor(record.binding)
        this.assertCurrent(record, true)
        // Positive already-sealed exact receipt lookup makes no durability/business writes.
        let receipt: ProfileGenerationReceipt | null = null
        try { receipt = await findProfileControlGenerationReceipt({ hostRoot: this.options.hostRoot, userId }, record.binding, record.expectedVersion) } catch { /* Strict selected candidate must prove any unsealed recovery. */ }
        this.assertCurrent(record, true)
        if (receipt) return receipt
        await this.stopped(record)
        this.assertCurrent(record, true)
        return await this.run(record, true)
      } finally { this.reserved.delete(key) }
    })
  }
  private async run(record: SystemActionControlRecoveryRecord, recovering: boolean, text?: string): Promise<ProfileGenerationReceipt> {
    const key = `${record.binding.userId}:${record.binding.id}`
    const request = parseProfileControlRequest({ v: 1, jobId: randomUUID(), kind: recovering ? 'recover-profile' : 'publish-profile',
      binding: record.binding, token: record.expectedVersion, ...(!recovering ? { text } : {}) })
    if (!request) throw fail()
    const encoded = `${JSON.stringify(request)}\n`
    if (Buffer.byteLength(encoded) > PROFILE_WORKER_MAX_BYTES) throw fail()
    if (await artifact(this.options.runtimeRoot, this.options.workerSha256) !== this.entry) throw fail()
    const home = await mkdtemp(join(this.options.hostRoot, '.worker-'))
    this.assertCurrent(record, recovering)
    const child = spawn(this.node, [this.entry, this.options.hostRoot], { cwd: this.options.runtimeRoot,
      env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home, LANG: 'C', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'ignore'] })
    const observation: ObservedChild = { executorId: record.executorId, token: record.expectedVersion, binding: record.binding, jobId: request.jobId, pid: child.pid, exited: false }
    if (!recovering) this.observed.set(key, observation) // Preserve the original execution stop proof during recovery.
    let result: ProfileGenerationReceipt | undefined
    let ready = false
    let go = false
    let problem = false
    let bytes = 0
    let processing = Promise.resolve()
    child.stdin.on('error', () => { problem = true })
    child.stdout.on('data', (buffer: Buffer) => { bytes += buffer.length; if (bytes > 65536) { problem = true; child.kill('SIGKILL') } })
    const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })
    const stop = () => { problem = true; child.stdin.end(); if (go) child.kill('SIGKILL') }
    lines.on('line', line => {
      processing = processing.then(async () => {
        const reply: unknown = JSON.parse(line)
        if (!reply || typeof reply !== 'object') throw fail()
        const value = reply as Record<string, unknown>
        if (value.v !== 1 || value.jobId !== request.jobId) throw fail()
        if (value.type === 'ready' && exactKeys(value, ['v', 'jobId', 'type']) && !ready && !result) {
          ready = true
          this.assertCurrent(record, recovering)
          if (recovering) await this.stopped(record)
          await this.options.authorizeActor(record.binding)
          this.assertCurrent(record, recovering)
          if (observation.exited || problem) throw fail()
          go = true
          child.stdin.write(`${JSON.stringify({ v: 1, jobId: request.jobId, type: 'go' })}\n`)
        } else if (value.type === 'result' && exactKeys(value, ['v', 'jobId', 'type', 'receipt']) && !result && validReceipt(value.receipt, request.binding)) {
          if (!go && (recovering || ready)) throw fail()
          result = value.receipt
        } else throw fail()
      }).catch(stop)
    })
    const timer = setTimeout(() => { problem = true; child.kill('SIGKILL') }, 30000)
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
      child.once('error', () => { problem = true })
      child.once('close', (code, signal) => { observation.exited = true; clearTimeout(timer); resolveExit({ code, signal }) })
      child.stdin.write(encoded)
    })
    await processing
    lines.close(); child.stdin.destroy()
    if (problem || exit.code !== 0 || exit.signal !== null || !result) throw fail()
    this.assertCurrent(record, recovering)
    return result
  }
  async drain(): Promise<void> { this.closed = true; await Promise.allSettled([...this.jobs]) }
}
