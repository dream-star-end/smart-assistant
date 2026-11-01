/** Control-side native journal. Transport must supply its authenticated scope and
 * peer ledger; caller JSON never selects the trusted peer. This does not execute
 * tools or claim that control and execution-side SQLite commits are atomic.
 */
import {
  agentRemoteContentHash,
  remoteCanonical,
  remoteTerminal,
  requireRemote,
  validateRemote,
} from '@openclaude/protocol/agentRemote'
import {
  type NativeScope,
  NativeScopeSchema,
  nativeOperationKey,
  verifyNativeBodySemantics,
  verifyNativeFrame,
  verifyNativeJson,
} from '@openclaude/protocol/agentRemoteNative'
import {
  type NativeDeliveryWriterProof,
  NativeDeliveryWriterProofSchema,
  nativeDeliveryCommitHash,
  verifyNativeDeliveryCommit,
  verifyNativeDeliveryPreparation,
} from '@openclaude/protocol/agentRemoteNativeDelivery'
import {
  type NativeIntent,
  type NativeJournalEvent,
  NativeJournalEventSchema,
  type NativeJournalRecord,
  nativeJournalEventHash,
  nativeJournalKey,
  nativeReceiptHash,
  verifyNativeDeliveryEvidence,
} from './nativeJournal.js'
import { pinAgentRemoteNativeSession, requireAgentRemoteControlFence } from './service.js'
import type { AgentRemoteState, AgentRemoteStore } from './store.js'

type Executor = { hostInstanceId: string; ledgerId: string; grantId: string }
const terminal = (row: NativeJournalRecord) => remoteTerminal(row.state)
const equal = (a: unknown, b: unknown) => remoteCanonical(a) === remoteCanonical(b)
function find(
  state: AgentRemoteState,
  scope: NativeScope,
  operationId: string,
  payloadHash: string,
): NativeJournalRecord {
  const key = nativeOperationKey(scope, operationId)
  const row = state.nativeJournal.find((row) => nativeJournalKey(row) === key)
  requireRemote(
    row &&
      equal(row.request.binding, scope.binding) &&
      row.request.environmentIncarnation === scope.environmentIncarnation &&
      row.request.body.payloadHash === payloadHash,
    'native-operation-mismatch',
  )
  return row
}
export class NativeJournalService {
  constructor(
    private readonly store: AgentRemoteStore,
    private readonly clock: () => number = Date.now,
  ) {
    requireRemote(store.durability === 'durable', 'durable-store-required')
  }
  private now(): number {
    const now = this.clock()
    requireRemote(Number.isSafeInteger(now) && now >= 0, 'bad-time')
    return now
  }
  private fence(
    state: AgentRemoteState,
    principalId: string,
    scope: NativeScope,
    now: number,
  ): void {
    validateRemote<NativeScope>(NativeScopeSchema, scope)
    requireRemote(principalId === scope.binding.principalId, 'principal-mismatch')
    requireAgentRemoteControlFence(state, scope.binding, scope.lease, now)
    const environment = state.environments.find(
      (row) => row.environmentId === scope.binding.environmentId,
    )
    requireRemote(
      environment?.kind === 'container' &&
        environment.containerIncarnation === scope.environmentIncarnation,
      'native-environment-incarnation',
    )
  }
  async admit(
    principalId: string,
    expected: NativeScope,
    input: unknown,
  ): Promise<NativeJournalRecord> {
    expected = structuredClone(expected)
    verifyNativeFrame(input, expected, 'worker')
    requireRemote(input.body.kind === 'native.execute', 'native-admission-kind')
    const request: NativeIntent = {
      binding: structuredClone(expected.binding),
      nativeSessionId: expected.nativeSessionId,
      environmentIncarnation: expected.environmentIncarnation,
      operationId: input.operationId,
      body: structuredClone(input.body),
    }
    return this.store.transact(
      principalId,
      (state) => {
        const now = this.now()
        this.fence(state, principalId, expected, now)
        pinAgentRemoteNativeSession(
          state.sessions.find((item) => item.binding.sessionId === expected.binding.sessionId)!,
          expected.nativeSessionId,
        )
        const key = nativeOperationKey(expected, request.operationId)
        const old = state.nativeJournal.find((row) => nativeJournalKey(row) === key)
        if (old) {
          requireRemote(equal(old.request, request), 'native-operation-conflict')
          return old
        }
        requireRemote(request.body.deadlineAtMs > now, 'deadline-exceeded')
        requireRemote(state.nativeJournal.length < 10000, 'reference-capacity')
        const row: NativeJournalRecord = {
          recordVersion: 1,
          request,
          claim: structuredClone(expected.lease),
          state: 'accepted',
          cancelRequested: false,
          events: [],
          createdAtMs: now,
          updatedAtMs: now,
        }
        state.nativeJournal.push(row)
        return row
      },
      { operationKey: nativeOperationKey(expected, request.operationId) },
    )
  }
  /** Commit one grant when its actual pipeline is about to start, never a whole
   * queued batch. A grant replay only returns evidence; it is not permission to
   * execute twice. The execution ledger must consume its grant exactly once.
   */
  async grant(
    principalId: string,
    scope: NativeScope,
    operationId: string,
    payloadHash: string,
    executor: Executor,
  ): Promise<NativeJournalRecord> {
    scope = structuredClone(scope)
    executor = structuredClone(executor)
    return this.store.transact(
      principalId,
      (state) => {
        const now = this.now()
        this.fence(state, principalId, scope, now)
        const row = find(state, scope, operationId, payloadHash)
        if (row.dispatch) {
          requireRemote(equal(row.dispatch, executor), 'native-grant-conflict')
          requireRemote(
            ['dispatched', 'started'].includes(row.state) &&
              !row.cancelRequested &&
              !row.receipt &&
              row.request.body.deadlineAtMs > now &&
              equal(row.claim, scope.lease),
            'native-not-startable',
          )
          return row
        }
        requireRemote(
          row.state === 'accepted' && !row.cancelRequested && !row.receipt,
          'native-not-startable',
        )
        requireRemote(row.request.body.deadlineAtMs > now, 'deadline-exceeded')
        requireRemote(equal(row.claim, scope.lease), 'native-claim-mismatch')
        requireRemote(
          !state.nativeJournal.some(
            (other) =>
              other !== row &&
              other.request.binding.sessionId === scope.binding.sessionId &&
              !terminal(other) &&
              other.dispatch &&
              !equal(other.claim, scope.lease),
          ),
          'native-old-execution-unresolved',
        )
        row.dispatch = structuredClone(executor)
        row.state = 'dispatched'
        row.updatedAtMs = now
        return row
      },
      { operationKey: nativeOperationKey(scope, operationId) },
    )
  }
  /** The Host uses this immediately at the canonical call site, after hooks and
   * permission have produced their final input. It must also commit its own
   * durable consume/start record BEFORE invoking the actual tool.
   */
  async started(
    principalId: string,
    scope: NativeScope,
    operationId: string,
    payloadHash: string,
    executor: Executor,
    input: unknown,
    policyRevision: number,
  ): Promise<NativeJournalRecord> {
    scope = structuredClone(scope)
    executor = structuredClone(executor)
    verifyNativeJson(input)
    const effectiveInput = {
      sha256: agentRemoteContentHash(remoteCanonical(input)),
      policyRevision,
    }
    return this.store.transact(
      principalId,
      (state) => {
        const now = this.now()
        this.fence(state, principalId, scope, now)
        const row = find(state, scope, operationId, payloadHash)
        requireRemote(
          equal(row.claim, scope.lease) && equal(row.dispatch, executor),
          'native-executor-mismatch',
        )
        requireRemote(
          !row.cancelRequested && !row.receipt && row.request.body.deadlineAtMs > now,
          'native-not-startable',
        )
        if (row.effectiveInput) {
          requireRemote(row.state === 'started', 'native-start-state')
          requireRemote(
            equal(row.effectiveInput, effectiveInput),
            'native-effective-input-conflict',
          )
          return row
        }
        requireRemote(row.state === 'dispatched', 'native-start-state')
        row.effectiveInput = effectiveInput
        row.state = 'started'
        row.updatedAtMs = now
        return row
      },
      { operationKey: nativeOperationKey(scope, operationId) },
    )
  }
  /** Evidence is supplied only by the authenticated ledger channel. Its original
   * producer/epoch survives reconnect; connection challenge is never dedup data.
   */
  async observe(
    principalId: string,
    scope: NativeScope,
    operationId: string,
    payloadHash: string,
    trustedLedger: { hostInstanceId: string; ledgerId: string },
    event: NativeJournalEvent,
  ): Promise<NativeJournalRecord> {
    scope = structuredClone(scope)
    trustedLedger = structuredClone(trustedLedger)
    validateRemote<NativeJournalEvent>(NativeJournalEventSchema, event)
    event = structuredClone(event)
    return this.store.transact(
      principalId,
      (state) => {
        const now = this.now()
        this.fence(state, principalId, scope, now)
        const row = find(state, scope, operationId, payloadHash)
        requireRemote(
          event.sender === 'execution' &&
            row.dispatch?.hostInstanceId === trustedLedger.hostInstanceId &&
            row.dispatch.ledgerId === trustedLedger.ledgerId &&
            event.producerInstanceId === trustedLedger.hostInstanceId &&
            event.ledgerId === trustedLedger.ledgerId &&
            event.epoch === row.claim.epoch,
          'native-evidence-producer',
        )
        verifyNativeJson(event.body)
        verifyNativeBodySemantics(row.request, operationId, event.sender, event.body)
        requireRemote(
          event.sha256 === nativeJournalEventHash(payloadHash, event),
          'native-evidence-hash',
        )
        if (event.sequence <= row.events.length) {
          requireRemote(equal(row.events[event.sequence - 1], event), 'native-event-conflict')
          return row
        }
        requireRemote(
          !terminal(row) && event.sequence === row.events.length + 1,
          'native-event-sequence',
        )
        requireRemote(!row.receipt, 'native-execution-already-finished')
        if (event.body.kind === 'native.receipt') {
          requireRemote(event.body.payloadHash === payloadHash, 'native-payload-hash')
          if (event.body.status === 'unknown') row.state = 'unknown'
          else {
            const receipt = {
              body: { ...event.body, status: event.body.status },
              sha256: nativeReceiptHash(payloadHash, event.body),
            }
            requireRemote(!row.receipt || equal(row.receipt, receipt), 'native-receipt-conflict')
            row.receipt = receipt
          }
        }
        row.events.push(event)
        row.updatedAtMs = now
        return row
      },
      { operationKey: nativeOperationKey(scope, operationId) },
    )
  }
  /** Trusted Writer connection only. This metadata pins stable identities and
   * source references before the actual Writer touches its transcript. */
  async prepareDelivery(
    principalId: string,
    expected: NativeScope,
    operationId: string,
    payloadHash: string,
    input: unknown,
  ): Promise<NativeJournalRecord> {
    expected = structuredClone(expected)
    verifyNativeDeliveryPreparation(input, payloadHash)
    const preparation = structuredClone(input)
    return this.store.transact(
      principalId,
      (state) => {
        const now = this.now()
        this.fence(state, principalId, expected, now)
        const row = find(state, expected, operationId, payloadHash)
        requireRemote(row.receipt?.sha256 === preparation.receiptHash, 'native-delivery-mismatch')
        verifyNativeDeliveryEvidence(row, preparation)
        if (row.deliveryPreparation) {
          requireRemote(
            equal(row.deliveryPreparation, preparation),
            'native-delivery-prepare-conflict',
          )
          return row
        }
        requireRemote(!terminal(row), 'native-delivery-already-finished')
        row.deliveryPreparation = preparation
        row.updatedAtMs = now
        return row
      },
      { operationKey: nativeOperationKey(expected, operationId) },
    )
  }
  /** Must be called by the authenticated actual Writer after its streaming
   * lock-held readback. JSON/model-produced claims cannot select this peer role.
   * Network adapters are deliberately absent from this foundation module. */
  async commitDelivery(
    principalId: string,
    expected: NativeScope,
    operationId: string,
    payloadHash: string,
    preparationHash: string,
    input: NativeDeliveryWriterProof,
  ): Promise<NativeJournalRecord> {
    expected = structuredClone(expected)
    verifyNativeJson(input)
    validateRemote<NativeDeliveryWriterProof>(NativeDeliveryWriterProofSchema, input)
    const proof = structuredClone(input)
    return this.store.transact(
      principalId,
      (state) => {
        const now = this.now()
        this.fence(state, principalId, expected, now)
        const row = find(state, expected, operationId, payloadHash)
        requireRemote(
          row.deliveryPreparation?.preparationHash === preparationHash && row.receipt,
          'native-delivery-not-prepared',
        )
        // Commit is the durable result of the first proof. Later appends never
        // replace its original head/hash/ACK on retry.
        if (row.deliveryCommit) return row
        const body = {
          version: 1 as const,
          preparationHash,
          receiptHash: row.receipt!.sha256,
          proof,
          ack: {
            kind: 'native.delivery.ack' as const,
            receiptHash: row.receipt!.sha256,
            nativeHeadRevision: proof.main.headUuid,
            nativeHeadHash: proof.main.prefixHash,
            artifactManifestHash: proof.artifactManifestHash,
          },
          committedAtMs: now,
        }
        const commit = { ...body, commitHash: nativeDeliveryCommitHash(payloadHash, body) }
        verifyNativeDeliveryCommit(
          commit,
          payloadHash,
          row.deliveryPreparation!,
          row.request.nativeSessionId,
        )
        const session = state.sessions.find(
          (item) => item.binding.sessionId === expected.binding.sessionId,
        )!
        requireRemote(
          Number.isSafeInteger(session.nativeDeliveryWatermark) &&
            session.nativeDeliveryWatermark >= 0 &&
            session.nativeDeliveryWatermark < Number.MAX_SAFE_INTEGER,
          'counter-exhausted',
        )
        session.nativeDeliveryWatermark++
        row.deliveryCommit = commit
        row.deliveryAck = structuredClone(commit.ack)
        row.state = row.receipt!.body.status
        row.updatedAtMs = now
        return row
      },
      { operationKey: nativeOperationKey(expected, operationId) },
    )
  }
  /** Validates ACK replay against the already durable delivery commit. This
   * ingress cannot create a commit or turn an uncommitted operation terminal. */
  async acknowledge(
    principalId: string,
    expected: NativeScope,
    input: unknown,
  ): Promise<NativeJournalRecord> {
    expected = structuredClone(expected)
    verifyNativeFrame(input, expected, 'worker')
    requireRemote(input.body.kind === 'native.delivery.ack', 'native-delivery-kind')
    const ack = structuredClone(input.body)
    const operationId = input.operationId
    return this.store.transact(
      principalId,
      (state) => {
        const now = this.now()
        this.fence(state, principalId, expected, now)
        const key = nativeOperationKey(expected, operationId)
        const row = state.nativeJournal.find((row) => nativeJournalKey(row) === key)
        requireRemote(
          row &&
            equal(row.request.binding, expected.binding) &&
            row.receipt?.body.kind === 'native.receipt' &&
            row.receipt.sha256 === ack.receiptHash,
          'native-delivery-mismatch',
        )
        requireRemote(row.deliveryCommit && row.deliveryAck, 'native-delivery-not-committed')
        requireRemote(
          equal(row.deliveryAck, ack) && equal(row.deliveryCommit.ack, ack),
          'native-delivery-conflict',
        )
        return row
      },
      { operationKey: nativeOperationKey(expected, operationId) },
    )
  }
  async query(
    principalId: string,
    scope: NativeScope,
    operationId: string,
    payloadHash: string,
  ): Promise<NativeJournalRecord> {
    scope = structuredClone(scope)
    return this.store.transact(
      principalId,
      (state) => {
        this.fence(state, principalId, scope, this.now())
        return find(state, scope, operationId, payloadHash)
      },
      { operationKey: nativeOperationKey(scope, operationId) },
    )
  }
  async cancel(
    principalId: string,
    scope: NativeScope,
    operationId: string,
    payloadHash: string,
  ): Promise<NativeJournalRecord> {
    scope = structuredClone(scope)
    return this.store.transact(
      principalId,
      (state) => {
        const now = this.now()
        this.fence(state, principalId, scope, now)
        const row = find(state, scope, operationId, payloadHash)
        if (terminal(row) || row.receipt || row.cancelRequested) return row
        row.cancelRequested = true
        row.updatedAtMs = now
        // Only an ungranted accepted operation can prove non-execution locally.
        if (row.state === 'accepted' && !row.dispatch && !row.receipt) {
          const body = {
            kind: 'native.receipt' as const,
            payloadHash,
            status: 'cancelled' as const,
            code: 'not-started',
          }
          row.receipt = { body, sha256: nativeReceiptHash(payloadHash, body) }
        }
        return row
      },
      { operationKey: nativeOperationKey(scope, operationId) },
    )
  }
  async recover(
    principalId: string,
    scope: NativeScope,
    operationId: string,
    payloadHash: string,
  ): Promise<NativeJournalRecord> {
    scope = structuredClone(scope)
    return this.store.transact(
      principalId,
      (state) => {
        const now = this.now()
        this.fence(state, principalId, scope, now)
        const row = find(state, scope, operationId, payloadHash)
        if (terminal(row) || row.state === 'unknown' || row.receipt) return row
        requireRemote(scope.lease.epoch > row.claim.epoch, 'recovery-requires-new-epoch')
        if (row.state === 'accepted' && !row.dispatch) row.claim = structuredClone(scope.lease)
        else row.state = 'unknown'
        row.updatedAtMs = now
        return row
      },
      { operationKey: nativeOperationKey(scope, operationId) },
    )
  }
}
