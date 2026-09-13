/** CLI carries locators, never an input ACK or authoritative result text. */
import { createHash, randomBytes } from 'node:crypto'
import { constants, mkdirSync, openSync, closeSync, fsyncSync, writeFileSync, readFileSync, linkSync, unlinkSync, fstatSync } from 'node:fs'
import { join } from 'node:path'
import { gatewayBaseUrl, gatewayDelegateHeaders, postJsonToGateway, DELEGATE_CONTEXT_HEADER } from './gatewayClient.js'

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
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

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
      const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(dir) } finally { closeSync(dir) }
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
  private readonly headers = Object.freeze(gatewayDelegateHeaders())
  private readonly cache: string
  private readonly report: string
  constructor(env: NodeJS.ProcessEnv = process.env, private readonly onReady?: (locator: ReceiptLocator) => void) {
    this.capability = env[RECEIPT_CAP_ENV] || ''
    const root = env[RECEIPT_CACHE_ENV]
    this.report = env[RECEIPT_REPORT_ENV] || ''
    if (!this.capability || !root || (!this.report && !onReady) || !this.headers[DELEGATE_CONTEXT_HEADER]) throw new Error('receipt invocation unavailable')
    this.cache = join(root, hash(this.headers[DELEGATE_CONTEXT_HEADER]))
    mkdirSync(this.cache, { recursive: true, mode: 0o700 })
  }
  enrollment() { return { capability: this.capability, receiptNonce: randomBytes(32).toString('hex') } }
  remember(locator: ReceiptLocator): void {
    const data = JSON.stringify(parseReceiptLocator(locator))
    const file = join(this.cache, locator.jobId + '.json')
    let fd: number
    try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readFileSync(file, 'utf8') !== data) throw error
      return
    }
    try { writeFileSync(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
    const dir = openSync(this.cache, constants.O_RDONLY | constants.O_DIRECTORY)
    try { fsyncSync(dir) } finally { closeSync(dir) }
  }
  lookup(jobId: string): ReceiptLocator | undefined {
    if (!/^dlgjob-[a-z0-9-]{1,150}$/.test(jobId)) throw new Error('invalid receipt job')
    try { return parseReceiptLocator(JSON.parse(readFileSync(join(this.cache, jobId + '.json'), 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  async wait(locator: ReceiptLocator, waitMs: number): Promise<{ statusCode: number; body: string }> {
    const result = await postJsonToGateway(gatewayBaseUrl() + '/api/delegate/receipt-owner/status', {
      headers: this.headers, body: JSON.stringify({ ...locator, capability: this.capability }), timeoutMs: 5000,
    })
    if (result.statusCode !== 200) return result
    const data = JSON.parse(result.body) as { status?: string }
    if (data.status !== 'ready') {
      if (data.status !== 'running') throw new Error('invalid receipt status')
      await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 1000)))
      return { statusCode: 200, body: JSON.stringify({ status: 'running', jobId: locator.jobId }) }
    }
    // Per-invocation records are candidates, never input ACKs or identity.
    if (this.onReady) this.onReady(parseReceiptLocator(locator))
    else publishReceiptReport(this.report, locator)
    return { statusCode: 200, body: JSON.stringify({ status: 'done', httpStatus: 200,
      output: '结果已准备，等待原生持久接收。' }) }
  }
}
