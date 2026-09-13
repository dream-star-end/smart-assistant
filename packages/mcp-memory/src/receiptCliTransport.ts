/** CLI carries locators, never an input ACK or authoritative result text. */
import { createHash, randomBytes } from 'node:crypto'
import { constants, mkdirSync, openSync, closeSync, fsyncSync, writeFileSync, readFileSync } from 'node:fs'
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

/** Cache is explicitly untrusted. Immutable nonce survives a separate wait CLI;
 * gateway verifies its hash/partition and native independently verifies consumer. */
export class ReceiptCliTransport {
  readonly capability: string
  private readonly headers = Object.freeze(gatewayDelegateHeaders())
  private readonly cache: string
  private readonly report: string
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.capability = env[RECEIPT_CAP_ENV] || ''
    const root = env[RECEIPT_CACHE_ENV]
    this.report = env[RECEIPT_REPORT_ENV] || ''
    if (!this.capability || !root || !this.report || !this.headers[DELEGATE_CONTEXT_HEADER]) throw new Error('receipt invocation unavailable')
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
    // A per-invocation file is a candidate channel, not stdout parsing and not
    // identity. O_EXCL prevents silently replacing another result in one tool.
    const fd = openSync(this.report, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, JSON.stringify(locator)); fsyncSync(fd) } finally { closeSync(fd) }
    return { statusCode: 200, body: JSON.stringify({ status: 'done', httpStatus: 200,
      output: '结果已准备，等待原生持久接收。' }) }
  }
}
