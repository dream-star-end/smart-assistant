/** Composition takes an explicit master-private ledger; importing this module creates no state. */
import { createHash } from 'node:crypto'
import { systemActionRequestHash, type SystemActionStore, type SystemActionReceiptBinding } from '@openclaude/storage'
import type { SystemActionDetail, SystemActionSummary, SystemActionResult } from '@openclaude/protocol'
import type { BrowserConfirmationPrincipal } from '../auth/browserConfirmation.js'
import { type SystemOperationRegistry, SystemOperationRejected, type SystemActor } from './operations.js'
function boundDevice(principal: BrowserConfirmationPrincipal, deviceId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) throw new SystemOperationRejected('INVALID_INPUT')
  return createHash('sha256').update(JSON.stringify([principal.id, principal.refreshFamilyId, principal.accessJti, deviceId])).digest('hex')
}
export class SystemActionsService {
  private accepting = true
  private readonly inFlight = new Set<Promise<SystemActionSummary>>()
  /** Composition persists this new process-incarnation ID for a trusted supervisor to recover after proven exit. */
  constructor(private readonly ledger: SystemActionStore, readonly registry: SystemOperationRegistry, readonly executorId: string,
    private readonly lookupReceipt?: (binding: SystemActionReceiptBinding) => Promise<SystemActionResult | null>) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(executorId)) throw new Error('Invalid executor incarnation')
  }
  async drain(): Promise<void> {
    this.accepting = false
    await Promise.allSettled([...this.inFlight])
  }
  async prepare(actor: SystemActor, operationId: string, raw: unknown, idempotencyKey: string): Promise<SystemActionSummary> {
    await this.registry.authorizePreparation(actor, operationId, raw)
    const requestHash = systemActionRequestHash({ sessionId: actor.sessionId, agentId: actor.agentId, operationId, args: raw })
    const replay = this.ledger.replayPrepared(actor.userId, idempotencyKey, requestHash)
    if (replay) return replay
    const { operation, prepared } = await this.registry.prepare(actor, operationId, raw)
    return this.ledger.prepare({ userId: actor.userId, sessionId: actor.sessionId, agentId: actor.agentId,
      operationId, operationTitle: operation.title, operationVersion: operation.version, executor: operation.executor,
      idempotencyKey, requestHash, args: prepared.args, resourceKey: prepared.resourceKey, preview: prepared.preview,
      expectedVersion: prepared.expectedVersion, quoteHash: prepared.quoteHash })
  }
  detail(userId: string, id: string): SystemActionDetail { return this.ledger.detail(userId, id) }
  result(userId: string, id: string): SystemActionSummary { return this.ledger.get(userId, id) }
  /** First-party owner gesture only. A missing receipt never permits another business execution. */
  async reconcile(userId: string, id: string): Promise<SystemActionSummary> {
    const current = this.ledger.get(userId, id)
    if (current.state !== 'unknown' || !this.lookupReceipt) return current
    const binding = this.ledger.unknownReceiptBinding(userId, id)
    if (!binding) return current
    const result = await this.lookupReceipt(binding)
    if (!result) return this.ledger.get(userId, id)
    try { return this.ledger.reconcileUnknownFromReceipt(binding, result) }
    catch (error) {
      const latest = this.ledger.get(userId, id)
      if (latest.state === 'succeeded') return latest
      throw error
    }
  }
  challenge(principal: BrowserConfirmationPrincipal, id: string, deviceId: string, previewHash: string): { detail: SystemActionDetail; nonce: string } {
    const nonce = this.ledger.issueChallenge(principal.id, id, boundDevice(principal, deviceId), previewHash)
    return { detail: this.ledger.detail(principal.id, id), nonce }
  }
  deny(principal: BrowserConfirmationPrincipal, id: string): SystemActionSummary { return this.ledger.deny(principal.id, id) }
  /** Call only after the independent browser principal was freshly verified for this actual request. */
  async confirm(principal: BrowserConfirmationPrincipal, id: string, proof: { deviceId: string; previewHash: string; nonce: string }): Promise<SystemActionSummary | { browserGrant: string; action: SystemActionSummary }> {
    if (!this.accepting) throw new SystemOperationRejected('UNAVAILABLE')
    let claim: ReturnType<SystemActionStore['confirm']>
    try {
      claim = this.ledger.confirm(principal.id, id, { ...proof, deviceId: boundDevice(principal, proof.deviceId) }, this.executorId)
    } catch (error) {
      const current = this.ledger.get(principal.id, id)
      // Only the redacted owner-readable receipt is replayed. Never reconstruct a browser grant.
      if (!['prepared', 'approved_waiting_browser'].includes(current.state)) return current
      throw error
    }
    // A grant is approval only. The future browser-claim endpoint must recheck registry/ACL
    // and frozen version before releasing arguments; it cannot execute from this grant alone.
    if ('browserGrant' in claim) return claim
    const work = this.executeClaim(principal, claim)
    this.inFlight.add(work)
    try { return await work } finally { this.inFlight.delete(work) }
  }
  private async executeClaim(principal: BrowserConfirmationPrincipal, claim: import('@openclaude/storage').SystemActionExecution): Promise<SystemActionSummary> {
    const actor: SystemActor = { userId: principal.id, role: principal.role, sessionId: claim.sessionId, agentId: claim.agentId }
    try {
      const result = await this.registry.execute(actor, claim)
      return this.ledger.finish(claim, 'succeeded', result)
    } catch (error) {
      if (error instanceof SystemOperationRejected) return this.ledger.finish(claim, 'failed', {
        summary: error.code === 'CONFLICT' ? '状态已变化，请重新查看并确认。' : '本次操作未执行，请检查权限或稍后重试。',
        completion: 'done', code: error.code,
      })
      // No automatic retry. A business receipt/reconciliation is required before another write.
      return this.ledger.finish(claim, 'unknown', { summary: '执行结果待核对，请勿重复执行。', completion: 'accepted', code: 'RECONCILIATION_REQUIRED' })
    }
  }
}
