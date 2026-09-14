/** CLI carries locators, never an input ACK or authoritative result text. */
import { parseReceiptHandoff } from './receiptHandoffView.js'
import { randomBytes } from 'node:crypto'
import { ReceiptCandidateLifecycle, receiptReportId } from '@openclaude/storage/receiptCandidateLifecycle'
import { constants, openSync, closeSync, fsyncSync, writeFileSync, readFileSync, readSync, linkSync, unlinkSync, fstatSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { gatewayBaseUrl, postJsonToGateway, describeDelegateTransportError } from './gatewayClient.js'
import { ReceiptConsumerCredentials } from './receiptConsumerCredentials.js'

export const RECEIPT_CAP_ENV = 'OPENCLAUDE_RECEIPT_INVOCATION'
export const RECEIPT_REPORT_ENV = 'OPENCLAUDE_RECEIPT_REPORT'
export const RECEIPT_CACHE_ENV = 'OPENCLAUDE_RECEIPT_LOCATORS'
export type ReceiptLocator = Readonly<{ jobId: string; generation: number; receiptNonce: string }>
export function parseReceiptLocator(value: unknown): ReceiptLocator {
  if (!value || typeof value !== 'object') throw new Error('invalid receipt locator')
  const v = value as Record<string, unknown>
  if (Object.keys(v).sort().join(',') !== 'generation,jobId,receiptNonce' ||
      typeof v.jobId !== 'string' || !/^dlgjob-[a-z0-9-]{1,150}$/.test(v.jobId) ||
      !Number.isSafeInteger(v.generation) || Number(v.generation) < 0 ||
      typeof v.receiptNonce !== 'string' || !/^[a-f0-9]{64}$/.test(v.receiptNonce)) throw new Error('invalid receipt locator')
  return Object.freeze({ jobId: v.jobId, generation: Number(v.generation), receiptNonce: v.receiptNonce })
}
/** Bounded, untrusted MCP candidates. Conflicting identities never replace one another. */
export function parseReceiptLocatorCollection(value: unknown): { locators: ReceiptLocator[]; invalid: boolean } {
  if (!Array.isArray(value) || value.length > 4) return { locators: [], invalid: true }
  const locators = new Map<string, ReceiptLocator>(), conflicts = new Set<string>()
  let invalid = false
  for (const item of value) {
    try {
      const locator = parseReceiptLocator(item)
      if (conflicts.has(locator.jobId)) continue
      const previous = locators.get(locator.jobId)
      if (previous && JSON.stringify(previous) !== JSON.stringify(locator)) {
        invalid = true; locators.delete(locator.jobId); conflicts.add(locator.jobId); continue
      }
      locators.set(locator.jobId, locator)
    } catch { invalid = true }
  }
  return { locators: [...locators.values()], invalid }
}
/** Only a path selector: the gateway still authenticates the whole capability. */
function candidatePartition(capability: string): string {
  if (capability.length > 16384) throw new Error('invalid receipt locator partition')
  const parts = capability.split('.')
  if (parts.length !== 2) throw new Error('invalid receipt locator partition')
  const claims: unknown = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString())
  const partition = claims && typeof claims === 'object'
    ? (claims as Record<string, unknown>).locatorPartition : undefined
  if (typeof partition !== 'string' || !/^[a-f0-9]{64}$/.test(partition)) throw new Error('invalid receipt locator partition')
  return partition
}

function openPrivateDirectory(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error('receipt cache directory must be private and owned')
    }
    return fd
  } catch (error) { closeSync(fd); throw error }
}

function readCacheRecord(file: string, jobId: string): ReceiptLocator {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 4096 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error('invalid receipt cache record')
    }
    const bytes = Buffer.alloc(4097)
    const length = readSync(fd, bytes, 0, bytes.length, 0)
    if (length > 4096) throw new Error('invalid receipt cache record')
    const locator = parseReceiptLocator(JSON.parse(bytes.subarray(0, length).toString()))
    if (locator.jobId !== jobId) throw new Error('receipt cache job mismatch')
    return locator
  } finally { closeSync(fd) }
}

// Closed, fsynced records are atomically published into bounded exclusive slots.
// Concurrent writers cannot overwrite another job or publish partially written JSON.
const REPORT_SLOTS = 64
function readReportSlot(file: string): ReceiptLocator {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 4096) throw new Error('invalid receipt report record')
    return parseReceiptLocator(JSON.parse(readFileSync(fd, 'utf8')))
  } finally { closeSync(fd) }
}
export function publishReceiptReport(directory: string, value: ReceiptLocator): void {
  const fd = openPrivateDirectory(directory)
  try { publishReceiptReportAt(fd, value) } finally { closeSync(fd) }
}
/** Already pinned and validated by the lifecycle writer; never reopen the proc
 * descriptor symlink with O_NOFOLLOW or switch to an unpinned pathname. */
function publishReceiptReportAt(directoryFd: number, value: ReceiptLocator): void {
  const directory = `/proc/self/fd/${directoryFd}`
  const locator = parseReceiptLocator(value), data = JSON.stringify(locator)
  const temp = join(directory, '.pending-' + randomBytes(16).toString('hex'))
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
  try {
    for (let i = 0; i < REPORT_SLOTS; i++) {
      const file = join(directory, String(i).padStart(2, '0') + '.json')
      try { linkSync(temp, file) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = readReportSlot(file)
        if (existing.jobId !== locator.jobId) continue
        if (JSON.stringify(existing) !== data) throw new Error('conflicting receipt report locator')
      }
      fsyncSync(directoryFd)
      return
    }
    throw new Error('receipt report limit exceeded; remaining jobs retain durable recovery')
  } finally { unlinkSync(temp) }
}
export function snapshotReceiptReport(directory: string): { locators: ReceiptLocator[]; invalid: boolean } {
  const locators = new Map<string, ReceiptLocator>()
  let invalid = false
  for (let i = 0; i < REPORT_SLOTS; i++) {
    try {
      const locator = readReportSlot(join(directory, String(i).padStart(2, '0') + '.json'))
      const existing = locators.get(locator.jobId)
      if (existing && JSON.stringify(existing) !== JSON.stringify(locator)) { invalid = true; continue }
      locators.set(locator.jobId, locator)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') invalid = true
    }
  }
  // Shell exit is not descendant death. Keep directory/records for late writers;
  // full lifecycle GC must use its own proven boundary, never an input ACK.
  return { locators: [...locators.values()], invalid }
}

/** Cache is explicitly untrusted. Immutable nonce survives a separate wait CLI;
 * gateway verifies its hash/partition and native independently verifies consumer. */
export class ReceiptCliTransport {
  readonly capability: string
  private readonly credentials: ReceiptConsumerCredentials
  private readonly partition: string
  private readonly report: string
  private readonly lifecycle: ReceiptCandidateLifecycle
  private readonly reportId: string
  constructor(env: NodeJS.ProcessEnv = process.env, private readonly onReady?: (locator: ReceiptLocator) => void) {
    this.capability = env[RECEIPT_CAP_ENV] || ''
    const root = env[RECEIPT_CACHE_ENV]
    this.report = env[RECEIPT_REPORT_ENV] || ''
    if (!this.capability || !root || (!this.report && !onReady)) throw new Error('receipt invocation unavailable')
    this.partition = candidatePartition(this.capability)
    this.credentials = new ReceiptConsumerCredentials(this.capability)
    if (process.platform !== 'linux' || !isAbsolute(root)) throw new Error('receipt cache requires an absolute Linux path')
    this.lifecycle = new ReceiptCandidateLifecycle(root)
    const claims = JSON.parse(Buffer.from(this.capability.split('.')[0]!, 'base64url').toString())
    this.reportId = receiptReportId(claims.consumerToolUseId)
    if (this.report && this.report !== this.lifecycle.reportPath(this.partition, claims.consumerToolUseId)) throw new Error('receipt report scope mismatch')
  }
  /** Lifecycle and publication share the original writer-held FD barrier.
   * Only Gateway registration creates directories; no late mkdir on this path. */
  private async withCache<T>(_create: boolean, fn: (path: string, fd: number) => T): Promise<T> {
    return this.lifecycle.withActive(this.partition, namespace => {
      const fd = openPrivateDirectory(join(namespace, 'cache'))
      try { return fn(`/proc/self/fd/${fd}`, fd) } finally { closeSync(fd) }
    })
  }
  async start(agentId: string, body: Record<string, unknown>) {
    const { headers, capability } = await this.credentials.current()
    const receiptNonce = randomBytes(32).toString('hex')
    // Refresh BEFORE nonce/create. Never retry a failed create or use a stale
    // start closure's context token; one operation owns this exact pair.
    const response = await postJsonToGateway(gatewayBaseUrl() + `/api/agents/${encodeURIComponent(agentId)}/delegate`, {
      headers, body: JSON.stringify({ ...body, receipt: { capability, receiptNonce } }), timeoutMs: 15000,
    })
    return { ...response, receiptNonce }
  }
  async remember(locator: ReceiptLocator): Promise<void> {
    const checked = parseReceiptLocator(locator), data = JSON.stringify(checked)
    await this.withCache(true, (path, directory) => {
      const file = join(path, checked.jobId + '.json')
      const temp = join(path, '.pending-' + randomBytes(16).toString('hex'))
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        try { writeFileSync(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
        try { linkSync(temp, file) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          if (JSON.stringify(readCacheRecord(file, checked.jobId)) !== data) throw new Error('conflicting receipt cache locator')
        }
        fsyncSync(directory)
      } finally { unlinkSync(temp) }
    })
  }
  async lookup(jobId: string): Promise<ReceiptLocator | undefined> {
    if (!/^dlgjob-[a-z0-9-]{1,150}$/.test(jobId)) throw new Error('invalid receipt job')
    return this.withCache(false, path => {
      try { return readCacheRecord(join(path, jobId + '.json'), jobId) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    })
  }
  /** Missing local cache is never a legacy consume fallback. Only another
   * durable source turn may return ordinary handoff text, without a candidate. */
  async handoff(jobId: string): Promise<{ statusCode: number; body: string }> {
    try {
      const { headers, capability } = await this.credentials.current()
      const response = await postJsonToGateway(gatewayBaseUrl() + '/api/delegate/receipt-owner/handoff-status', {
        headers, body: JSON.stringify({ jobId, capability }), timeoutMs: 5000,
      })
      if (response.statusCode !== 200) return response
      const view = parseReceiptHandoff(JSON.parse(response.body))
      if (!view || view.jobId !== jobId) throw new Error('invalid receipt handoff metadata')
      return { statusCode: 200, body: JSON.stringify(view) }
    } catch (error) {
      return { statusCode: 503, body: JSON.stringify({ error:
        `receipt handoff unavailable: ${describeDelegateTransportError(error)}; job retained, do not resubmit` }) }
    }
  }
  async wait(locator: ReceiptLocator, waitMs: number): Promise<{ statusCode: number; body: string }> {
    let result: { statusCode: number; body: string }
    try {
      const { headers, capability } = await this.credentials.current()
      result = await postJsonToGateway(gatewayBaseUrl() + '/api/delegate/receipt-owner/status', {
        headers, body: JSON.stringify({ ...locator, capability }), timeoutMs: 5000,
      })
    } catch (error) {
      // The legacy wait loop retries thrown socket errors. Receipt refresh/status
      // must fail this attempt closed, not silently resend or downgrade identity.
      // This reports an unavailable read, NOT a failed child or a delivery ACK.
      return { statusCode: 503, body: JSON.stringify({ error:
        `receipt status unavailable: ${describeDelegateTransportError(error)}; job retained, do not resubmit` }) }
    }
    if (result.statusCode !== 200) return result
    const data = JSON.parse(result.body) as { status?: string }
    if (data.status !== 'ready') {
      if (data.status !== 'running') throw new Error('invalid receipt status')
      await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 1000)))
      return { statusCode: 200, body: JSON.stringify({ status: 'running', jobId: locator.jobId }) }
    }
    // Per-invocation records are candidates, never input ACKs or identity.
    if (this.onReady) this.onReady(parseReceiptLocator(locator))
    else await this.lifecycle.withActive(this.partition, namespace => {
      const reports = openPrivateDirectory(join(namespace, 'reports'))
      try {
        const report = openPrivateDirectory(`/proc/self/fd/${reports}/${this.reportId}`)
        try { publishReceiptReportAt(report, locator) } finally { closeSync(report) }
      } finally { closeSync(reports) }
    })
    return { statusCode: 200, body: JSON.stringify({ status: 'done', httpStatus: 200,
      output: '结果已准备，等待原生持久接收。' }) }
  }
}
