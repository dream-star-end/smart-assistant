/** Receipt-only capability, separate from delegate v1 and advisor v2.
 * It attests a current native consumer, NOT consumption, a job, or a notify ACK.
 * A lost signing key is unknown, never evidence that a parent is inactive.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ReceiptToolOwner } from './engine/engineAdapter.js'
import { DELEGATE_CONTEXT_TTL_MS } from './delegateContext.js'

export const RECEIPT_OWNER_PREFIX = '/api/delegate/receipt-owner/'

export interface ReceiptOwnerClaims extends ReceiptToolOwner {
  v: 1
  purpose: 'receipt-consumer'
  userId: string
  agentId: string
  sessionKey: string
  contextHash: string
  iat: number
  exp: number
}

export function receiptContextHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function isReceiptConsumerTool(name: string): boolean {
  return name === 'Bash' || [
    'mcp__openclaude_memory__delegate_task',
    'mcp__openclaude_memory__delegate_tasks',
    'mcp__openclaude_memory__delegate_wait',
  ].includes(name)
}

/** One key per gateway instance. No disk/env key, no signing material in the child. */
export class ReceiptOwnerCapabilities {
  private readonly key = randomBytes(32)

  issue(input: Omit<ReceiptOwnerClaims, 'v' | 'purpose' | 'iat' | 'exp'>, now = Date.now()): string {
    const claims: ReceiptOwnerClaims = {
      ...input, v: 1, purpose: 'receipt-consumer', iat: now, exp: now + DELEGATE_CONTEXT_TTL_MS,
    }
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${payload}.${this.sign(payload)}`
  }

  verify(token: unknown, now = Date.now()): ReceiptOwnerClaims | null {
    if (typeof token !== 'string' || token.length > 16384) return null
    const parts = token.split('.')
    if (parts.length !== 2) return null
    const [payload, sig] = parts
    if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return null
    const expected = this.sign(payload)
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
    try {
      const c = JSON.parse(Buffer.from(payload, 'base64url').toString()) as ReceiptOwnerClaims
      if (!c || c.v !== 1 || c.purpose !== 'receipt-consumer' ||
          !Number.isSafeInteger(c.iat) || !Number.isSafeInteger(c.exp) ||
          c.iat > now || c.exp <= now || c.exp - c.iat !== DELEGATE_CONTEXT_TTL_MS) return null
      for (const key of ['userId', 'agentId', 'sessionKey', 'contextHash', 'adapterInstanceId',
        'parentOwnerEpoch', 'turnKey', 'nativeSessionId', 'consumerToolUseId', 'toolName'] as const) {
        if (typeof c[key] !== 'string' || !c[key]) return null
      }
      return isReceiptConsumerTool(c.toolName) ? c : null
    } catch { return null }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key).update('receipt-owner-v1\0').update(payload).digest('base64url')
  }
}
