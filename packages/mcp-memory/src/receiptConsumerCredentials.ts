/** Per-operation coherent credentials. Locally decoded claims are consistency
 * checks only: every operation and refresh is authorized by the gateway. */
import { createHash } from 'node:crypto'
import type { ReceiptOwnerClaims } from '../../gateway/src/receiptOwnerCapability.js'
import { gatewayBaseUrl, gatewayDelegateHeaders, postJsonToGateway, DELEGATE_CONTEXT_HEADER } from './gatewayClient.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function decode(token: string): ReceiptOwnerClaims {
  if (token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('invalid receipt credential')
  const c = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()) as ReceiptOwnerClaims
  if (!c || c.v !== 1 || c.purpose !== 'receipt-consumer' || !Number.isSafeInteger(c.iat) ||
      !Number.isSafeInteger(c.exp) || c.exp <= c.iat || c.iat > Date.now()) throw new Error('invalid receipt credential claims')
  for (const field of ['userId', 'agentId', 'sessionKey', 'contextHash', 'adapterInstanceId', 'parentOwnerEpoch',
    'turnKey', 'nativeSessionId', 'consumerToolUseId', 'toolName', 'locatorPartition'] as const) {
    if (typeof c[field] !== 'string' || !c[field]) throw new Error('invalid receipt credential identity')
  }
  return c
}
function identity(c: ReceiptOwnerClaims): string {
  const p = c.parentProcess
  return JSON.stringify([c.v, c.purpose, c.userId, c.agentId, c.sessionKey, c.adapterInstanceId, c.parentOwnerEpoch,
    c.turnKey, c.nativeSessionId, c.consumerToolUseId, c.toolName, c.receiptMcpTarget, c.locatorPartition,
    p ? [p.pid, p.startTicks, p.bootId, p.pidNamespace] : null])
}

export type ReceiptCredentialPair = Readonly<{ headers: Readonly<Record<string, string>>; capability: string }>
export class ReceiptConsumerCredentials {
  private capability: string
  private readonly originalIdentity: string
  constructor(capability: string) {
    this.originalIdentity = identity(decode(capability))
    this.capability = capability
  }
  async current(): Promise<ReceiptCredentialPair> {
    const headers = Object.freeze({ ...gatewayDelegateHeaders() })
    const context = headers[DELEGATE_CONTEXT_HEADER]
    if (!context || !headers.Authorization?.replace(/^Bearer\s*/, '')) throw new Error('receipt HTTP credentials unavailable')
    const contextHash = hash(context)
    // Capture before await: reversed refresh responses may replace the cache,
    // but can never change the immutable pair owned by another operation.
    let capability = this.capability
    const claims = decode(capability)
    if (claims.contextHash !== contextHash || claims.exp <= Date.now()) {
      const response = await postJsonToGateway(gatewayBaseUrl() + '/api/delegate/receipt-owner/refresh', {
        headers, body: JSON.stringify({ capability }), timeoutMs: 5000,
      })
      if (response.statusCode !== 200) throw new Error(`receipt refresh rejected (${response.statusCode})`)
      const result: unknown = JSON.parse(response.body)
      const renewed = result as { capability?: unknown; ownerState?: unknown } | null
      if (!renewed || typeof renewed.capability !== 'string' || renewed.ownerState !== 'active') throw new Error('missing receipt refresh capability')
      const next = decode(renewed.capability)
      if (identity(next) !== this.originalIdentity || next.contextHash !== contextHash || next.exp <= Date.now()) {
        throw new Error('receipt refresh identity mismatch')
      }
      capability = renewed.capability
      this.capability = capability
    }
    return Object.freeze({ headers, capability })
  }
}
