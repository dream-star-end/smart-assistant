/** Receipt-only capability, separate from delegate v1 and advisor v2.
 * It attests a current native consumer, NOT consumption, a job, or a notify ACK.
 * A lost signing key is unknown, never evidence that a parent is inactive.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ReceiptToolOwner } from './engine/engineAdapter.js'
import { DELEGATE_CONTEXT_TTL_MS } from './delegateContext.js'
import { checkedReceiptParentProcess } from './receiptParentProcess.js'

export const RECEIPT_OWNER_PREFIX = '/api/delegate/receipt-owner/'

export interface ReceiptOwnerClaims extends ReceiptToolOwner {
  v: 1
  purpose: 'receipt-consumer'
  userId: string
  agentId: string
  sessionKey: string
  contextHash: string
  /** Signed locator namespace, not an input capability or delivery ACK. */
  locatorPartition: string
  iat: number
  exp: number
}

export function receiptContextHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function receiptLocatorPartition(owner: Pick<ReceiptOwnerClaims, 'userId' | 'agentId' | 'sessionKey' |
  'adapterInstanceId' | 'parentOwnerEpoch' | 'turnKey' | 'nativeSessionId'>): string {
  return receiptContextHash('receipt-locator-v1\0' + JSON.stringify([
    owner.userId, owner.agentId, owner.sessionKey, owner.adapterInstanceId,
    owner.parentOwnerEpoch, owner.turnKey, owner.nativeSessionId,
  ]))
}

const DEFERRED_RECEIPT_TARGETS = [
  'mcp__openclaude-memory__delegate_task', 'mcp__openclaude-memory__delegate_wait',
  'mcp__openclaude-memory__delegate_tasks',
] as const
/** Only from the actual SDK tool_use block, never an HTTP body assertion. */
export function receiptMcpTargetForSdk(name: string, input: unknown): string | undefined {
  if (name !== 'ExecuteExtraTool' || !input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const target = (input as Record<string, unknown>).tool_name
  return typeof target === 'string' && (DEFERRED_RECEIPT_TARGETS as readonly string[]).includes(target) ? target : undefined
}

export function isReceiptConsumerTool(name: string, receiptMcpTarget?: string): boolean {
  if (name === 'ExecuteExtraTool') return !!receiptMcpTarget && (DEFERRED_RECEIPT_TARGETS as readonly string[]).includes(receiptMcpTarget)
  if (receiptMcpTarget !== undefined) return false
  return name === 'Bash' || [
    // CCB preserves hyphens; Codex's normalized namespace uses underscores.
    'mcp__openclaude-memory__delegate_task',
    'mcp__openclaude-memory__delegate_tasks',
    'mcp__openclaude-memory__delegate_wait',
    'mcp__openclaude_memory__delegate_task',
    'mcp__openclaude_memory__delegate_tasks',
    'mcp__openclaude_memory__delegate_wait',
  ].includes(name)
}

/** Whitelist a persisted owner descriptor; never retain bearer/context tokens. */
export function checkedReceiptToolOwner(value: unknown): ReceiptToolOwner {
  const owner = value as ReceiptToolOwner | null
  const copy: Record<string, unknown> = {}
  for (const key of ['adapterInstanceId', 'parentOwnerEpoch', 'turnKey', 'nativeSessionId', 'consumerToolUseId', 'toolName'] as const) {
    if (!owner || typeof owner[key] !== 'string' || !owner[key] || owner[key].length > 256) throw new Error('invalid receipt parent owner')
    copy[key] = owner[key]
  }
  if (!isReceiptConsumerTool(owner!.toolName, owner!.receiptMcpTarget)) throw new Error('invalid receipt parent tool')
  if (owner!.receiptMcpTarget !== undefined) copy.receiptMcpTarget = owner!.receiptMcpTarget
  if (owner!.parentProcess !== undefined) copy.parentProcess = checkedReceiptParentProcess(owner!.parentProcess)
  return Object.freeze(copy) as unknown as ReceiptToolOwner
}

/** One key per gateway instance. No disk/env key, no signing material in the child. */
export class ReceiptOwnerCapabilities {
  private readonly key = randomBytes(32)

  issue(input: Omit<ReceiptOwnerClaims, 'v' | 'purpose' | 'iat' | 'exp' | 'locatorPartition'>, now = Date.now()): string {
    const claims: ReceiptOwnerClaims = {
      ...input, locatorPartition: receiptLocatorPartition(input),
      v: 1, purpose: 'receipt-consumer', iat: now, exp: now + DELEGATE_CONTEXT_TTL_MS,
    }
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `${payload}.${this.sign(payload)}`
  }

  verify(token: unknown, now = Date.now()): ReceiptOwnerClaims | null {
    return this.verifySigned(token, now, false)
  }

  /** Identity witness ONLY. Refresh must additionally authenticate the new
   * context and attest this exact original owner active before issuing anything. */
  verifyForRefresh(token: unknown, now = Date.now()): ReceiptOwnerClaims | null {
    return this.verifySigned(token, now, true)
  }

  private verifySigned(token: unknown, now: number, expiredWitness: boolean): ReceiptOwnerClaims | null {
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
          c.iat > now || (!expiredWitness && c.exp <= now) || c.exp - c.iat !== DELEGATE_CONTEXT_TTL_MS) return null
      for (const key of ['userId', 'agentId', 'sessionKey', 'contextHash', 'adapterInstanceId',
        'parentOwnerEpoch', 'turnKey', 'nativeSessionId', 'consumerToolUseId', 'toolName'] as const) {
        if (typeof c[key] !== 'string' || !c[key]) return null
      }
      checkedReceiptToolOwner(c)
      if (c.locatorPartition !== receiptLocatorPartition(c)) return null
      return c
    } catch { return null }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key).update('receipt-owner-v1\0').update(payload).digest('base64url')
  }
}
