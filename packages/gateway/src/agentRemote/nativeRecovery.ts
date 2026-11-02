/** Supervisor-only delivery recovery, independent of execution leases.
 * No HTTP/RPC adapter, process stop, tool/model execution or production caller.
 * peer and handoff must be constructed by trusted authenticated supervisor ingress.
 */
import { randomUUID } from 'node:crypto'
import {
  type AgentRemoteBinding,
  BindingSchema,
  remoteCanonical,
  remoteTerminal,
  requireRemote,
  validateRemote,
} from '@openclaude/protocol/agentRemote'
import { nativeOperationKey, verifyNativeJson } from '@openclaude/protocol/agentRemoteNative'
import {
  type NativeDeliveryWriterProof,
  NativeDeliveryWriterProofSchema,
  verifyNativeDeliveryPreparation,
} from '@openclaude/protocol/agentRemoteNativeDelivery'
import {
  type NativeCheckpoint,
  type NativeCheckpointCapture,
  type NativeCheckpointIdentity,
  NativeCheckpointIdentitySchema,
  type NativeRecoveryOwner,
  NativeRecoveryOwnerSchema,
  type NativeRecoveryPermit,
  type NativeRecoveryToken,
  NativeRecoveryTokenSchema,
  checkpointMatchesIdentity,
  verifyNativeCheckpoint,
} from '@openclaude/protocol/agentRemoteState'
import {
  type NativeJournalEvent,
  NativeJournalEventSchema,
  type NativeJournalRecord,
  nativeJournalKey,
  nativeReceiptHash,
} from './nativeJournal.js'
import {
  applyNativeEvidence,
  commitNativeDelivery,
  prepareNativeDelivery,
} from './nativeService.js'
import type {
  AgentRemoteState,
  AgentRemoteStore,
  JournalSelection,
  RemoteSession,
} from './store.js'

const equal = (a: unknown, b: unknown) => remoteCanonical(a) === remoteCanonical(b)
const next = (value: number) => {
  requireRemote(
    Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER,
    'counter-exhausted',
  )
  return value + 1
}
export interface NativeHandoffTarget {
  permit: NativeRecoveryPermit
  writer?: RemoteSession['nativeWriter']
}
/** Trusted local constructor capability, NEVER accepted in request JSON.
 * Block every writer start, prove all old writers/descendants exited, then hold
 * actual UUID flock and all transcript group locks through capture/copy/commit.
 * Recover every transcript integrity intent before copying; no CLI/EOF/TTL proof.
 */
export interface NativeHandoffLock {
  /** Sync trusted assertion of current UUID/group lock ownership and writer-stop fence. */
  assertHeld: () => true
}
export interface NativeHandoffPort {
  withFreshCheckpoint(
    target: Readonly<NativeHandoffTarget>,
    capture: (locked: NativeHandoffLock) => Promise<NativeCheckpointCapture>,
    commit: (checkpoint: NativeCheckpoint) => Promise<{ checkpointId: string }>,
  ): Promise<unknown>
}
export class NativeRecoveryService {
  private readonly peer: NativeRecoveryOwner
  private readonly handoff?: NativeHandoffPort['withFreshCheckpoint']
  constructor(
    private readonly store: AgentRemoteStore,
    peer: NativeRecoveryOwner,
    private readonly clock: () => number = Date.now,
    handoff?: NativeHandoffPort,
  ) {
    requireRemote(store.durability === 'durable', 'durable-store-required')
    validateRemote<NativeRecoveryOwner>(NativeRecoveryOwnerSchema, peer)
    this.peer = structuredClone(peer)
    // Snapshot function and receiver before asynchronous work.
    this.handoff = handoff?.withFreshCheckpoint.bind(handoff)
  }
  private now(): number {
    const now = this.clock()
    requireRemote(Number.isSafeInteger(now) && now > 0, 'bad-time')
    return now
  }
  private findSession(
    state: AgentRemoteState,
    principalId: string,
    token: NativeRecoveryToken,
    pending = true,
  ): RemoteSession {
    requireRemote(/^[A-Za-z0-9_.:-]{1,160}$/.test(principalId), 'bad-principal')
    validateRemote<NativeRecoveryToken>(NativeRecoveryTokenSchema, token)
    requireRemote(equal(token.owner, this.peer), 'native-recovery-owner')
    const found = state.sessions.find((s) => s.binding.sessionId === token.sessionId)
    requireRemote(
      found?.binding.principalId === principalId &&
        found.nativeRecovery &&
        equal(found.nativeRecovery.token, token),
      'native-recovery-stale',
    )
    if (pending)
      requireRemote(
        found.nativeRecovery.phase === 'pending' && found.nativeRecovery.expiresAtMs > this.now(),
        'native-recovery-expired',
      )
    return found
  }
  private operation(
    state: AgentRemoteState,
    found: RemoteSession,
    operationId: string,
    payloadHash: string,
    binding: AgentRemoteBinding,
    nativeSessionId: string,
  ): NativeJournalRecord {
    const permit = found.nativeRecovery!
    requireRemote(
      equal(binding, permit.sourceBinding) && nativeSessionId === permit.identity.nativeSessionId,
      'native-recovery-source-mismatch',
    )
    const key = nativeOperationKey(
      { binding: permit.sourceBinding, nativeSessionId: permit.identity.nativeSessionId },
      operationId,
    )
    const row = state.nativeJournal.find((r) => nativeJournalKey(r) === key)
    requireRemote(
      row &&
        equal(row.request.binding, permit.sourceBinding) &&
        row.request.nativeSessionId === permit.identity.nativeSessionId &&
        row.request.environmentIncarnation === permit.environmentIncarnation &&
        row.request.body.payloadHash === payloadHash,
      'native-operation-mismatch',
    )
    return row
  }
  private selection(
    token: NativeRecoveryToken,
    binding: AgentRemoteBinding,
    nativeSessionId: string,
    operationId: string,
  ): JournalSelection {
    requireRemote(token.sessionId === binding.sessionId, 'native-recovery-stale')
    return { operationKey: nativeOperationKey({ binding, nativeSessionId }, operationId) }
  }
  /** Caller is trusted supervisor arbitration, not a new Worker claiming an old lease.
   * A retry with the same requestId/connection returns the original unextended permit.
   */
  async claim(
    principalId: string,
    binding: AgentRemoteBinding,
    identity: NativeCheckpointIdentity,
    expectedGeneration: number,
    requestId: string,
    ttlMs: number,
  ): Promise<NativeRecoveryPermit> {
    validateRemote<AgentRemoteBinding>(BindingSchema, binding)
    validateRemote<NativeCheckpointIdentity>(NativeCheckpointIdentitySchema, identity)
    requireRemote(/^[A-Za-z0-9_.:-]{1,160}$/.test(requestId), 'bad-recovery-request')
    requireRemote(
      Number.isSafeInteger(expectedGeneration) &&
        expectedGeneration >= 0 &&
        Number.isSafeInteger(ttlMs) &&
        ttlMs > 0 &&
        ttlMs <= 300000,
      'bad-recovery-claim',
    )
    binding = structuredClone(binding)
    identity = structuredClone(identity)
    return this.store.transact(
      principalId,
      (state) => {
        const now = this.now()
        const found = state.sessions.find((s) => s.binding.sessionId === binding.sessionId)
        requireRemote(
          found && principalId === binding.principalId && equal(found.binding, binding),
          'binding-mismatch',
        )
        requireRemote(
          identity.principalId === principalId &&
            identity.sessionId === binding.sessionId &&
            identity.environmentId === binding.environmentId &&
            identity.environmentGeneration === binding.environmentGeneration &&
            identity.nativeSessionId === found.nativeSessionId,
          'native-recovery-identity',
        )
        const environment = state.environments.find(
          (e) => e.environmentId === binding.environmentId,
        )
        requireRemote(
          environment?.kind === 'container' &&
            environment.generation === binding.environmentGeneration,
          'native-environment-incarnation',
        )
        const old = found.nativeRecovery
        if (old?.requestId === requestId) {
          requireRemote(
            equal(old.token.owner, this.peer) &&
              equal(old.identity, identity) &&
              equal(old.sourceBinding, binding),
            'native-recovery-claim-conflict',
          )
          return old
        }
        requireRemote(!found.lease?.active || found.lease.expiresAtMs <= now, 'lease-busy')
        // This permit handles native journal evidence only. Do not install a gate
        // that would strand legacy execution evidence behind the normal fence.
        requireRemote(
          !state.journal.some(
            (row) =>
              row.request.binding.sessionId === binding.sessionId && !remoteTerminal(row.state),
          ),
          'native-recovery-legacy-inflight',
        )
        requireRemote(found.nativeRecoveryGeneration === expectedGeneration, 'native-recovery-cas')
        requireRemote(
          !old || old.phase === 'completed' || old.expiresAtMs <= now,
          'native-recovery-busy',
        )
        const generation = next(found.nativeRecoveryGeneration)
        const expiresAtMs = now + ttlMs
        requireRemote(Number.isSafeInteger(expiresAtMs), 'bad-time')
        const permit: NativeRecoveryPermit = {
          token: {
            sessionId: binding.sessionId,
            permitId: randomUUID(),
            generation,
            owner: structuredClone(this.peer),
          },
          requestId,
          phase: 'pending',
          sourceBinding: binding,
          identity,
          environmentIncarnation: environment.containerIncarnation,
          sourceWriterGeneration: found.nativeWriterGeneration,
          createdAtMs: now,
          expiresAtMs,
        }
        found.nativeRecoveryGeneration = generation
        found.nativeRecovery = permit
        return permit
      },
      'active',
    )
  }
  /** Read/replay old evidence by its ORIGINAL producer and claim; no new grant. */
  async query(
    principalId: string,
    token: NativeRecoveryToken,
    binding: AgentRemoteBinding,
    nativeSessionId: string,
    operationId: string,
    payloadHash: string,
  ): Promise<NativeJournalRecord> {
    token = structuredClone(token)
    binding = structuredClone(binding)
    return this.store.transact(
      principalId,
      (state) =>
        this.operation(
          state,
          this.findSession(state, principalId, token, false),
          operationId,
          payloadHash,
          binding,
          nativeSessionId,
        ),
      this.selection(token, binding, nativeSessionId, operationId),
    )
  }
  async observe(
    principalId: string,
    token: NativeRecoveryToken,
    binding: AgentRemoteBinding,
    nativeSessionId: string,
    operationId: string,
    payloadHash: string,
    trustedLedger: { hostInstanceId: string; ledgerId: string },
    event: NativeJournalEvent,
  ): Promise<NativeJournalRecord> {
    token = structuredClone(token)
    binding = structuredClone(binding)
    trustedLedger = structuredClone(trustedLedger)
    validateRemote<NativeJournalEvent>(NativeJournalEventSchema, event)
    event = structuredClone(event)
    return this.store.transact(
      principalId,
      (state) => {
        const row = this.operation(
          state,
          this.findSession(state, principalId, token),
          operationId,
          payloadHash,
          binding,
          nativeSessionId,
        )
        return applyNativeEvidence(row, payloadHash, trustedLedger, event, this.now())
      },
      this.selection(token, binding, nativeSessionId, operationId),
    )
  }
  async cancelUnstarted(
    principalId: string,
    token: NativeRecoveryToken,
    binding: AgentRemoteBinding,
    nativeSessionId: string,
    operationId: string,
    payloadHash: string,
  ): Promise<NativeJournalRecord> {
    token = structuredClone(token)
    binding = structuredClone(binding)
    return this.store.transact(
      principalId,
      (state) => {
        const row = this.operation(
          state,
          this.findSession(state, principalId, token),
          operationId,
          payloadHash,
          binding,
          nativeSessionId,
        )
        if (row.receipt) return row
        requireRemote(row.state === 'accepted' && !row.dispatch, 'native-not-unstarted')
        const body = {
          kind: 'native.receipt' as const,
          payloadHash,
          status: 'cancelled' as const,
          code: 'not-started',
        }
        row.cancelRequested = true
        row.receipt = { body, sha256: nativeReceiptHash(payloadHash, body) }
        row.updatedAtMs = this.now()
        return row
      },
      this.selection(token, binding, nativeSessionId, operationId),
    )
  }
  async prepareDelivery(
    principalId: string,
    token: NativeRecoveryToken,
    binding: AgentRemoteBinding,
    nativeSessionId: string,
    operationId: string,
    payloadHash: string,
    input: unknown,
  ): Promise<NativeJournalRecord> {
    token = structuredClone(token)
    binding = structuredClone(binding)
    verifyNativeDeliveryPreparation(input, payloadHash)
    const preparation = structuredClone(input)
    return this.store.transact(
      principalId,
      (state) => {
        const row = this.operation(
          state,
          this.findSession(state, principalId, token),
          operationId,
          payloadHash,
          binding,
          nativeSessionId,
        )
        return prepareNativeDelivery(row, payloadHash, preparation, this.now())
      },
      this.selection(token, binding, nativeSessionId, operationId),
    )
  }
  async commitDelivery(
    principalId: string,
    token: NativeRecoveryToken,
    binding: AgentRemoteBinding,
    nativeSessionId: string,
    operationId: string,
    payloadHash: string,
    preparationHash: string,
    input: NativeDeliveryWriterProof,
  ): Promise<NativeJournalRecord> {
    token = structuredClone(token)
    binding = structuredClone(binding)
    verifyNativeJson(input)
    validateRemote<NativeDeliveryWriterProof>(NativeDeliveryWriterProofSchema, input)
    const proof = structuredClone(input)
    return this.store.transact(
      principalId,
      (state) => {
        const row = this.operation(
          state,
          this.findSession(state, principalId, token),
          operationId,
          payloadHash,
          binding,
          nativeSessionId,
        )
        return commitNativeDelivery(state, row, payloadHash, preparationHash, proof, this.now())
      },
      this.selection(token, binding, nativeSessionId, operationId),
    )
  }
  private clear(state: AgentRemoteState, sessionId: string): void {
    requireRemote(
      ![...state.journal, ...state.nativeJournal].some(
        (r) => r.request.binding.sessionId === sessionId && !remoteTerminal(r.state),
      ),
      'native-recovery-inflight',
    )
  }
  /** No checkpoint/exit claim parameter. Only the constructor-held supervisor port
   * may call capture/commit, while actual writer locks remain held. */
  async finish(principalId: string, token: NativeRecoveryToken): Promise<{ checkpointId: string }> {
    token = structuredClone(token)
    const target = await this.store.transact(
      principalId,
      (state) => {
        const found = this.findSession(state, principalId, token, false)
        if (found.nativeRecovery!.phase === 'completed')
          return { checkpointId: found.nativeRecovery!.checkpointId! }
        this.findSession(state, principalId, token)
        this.clear(state, token.sessionId)
        return {
          permit: found.nativeRecovery!,
          ...(found.nativeWriter ? { writer: found.nativeWriter } : {}),
        }
      },
      'active',
    )
    if (typeof target.checkpointId === 'string') return { checkpointId: target.checkpointId }
    requireRemote(this.handoff, 'native-handoff-port-required')
    let active = true
    let captureStarted = false
    let assertHeld: (() => true) | undefined
    let captured: NativeCheckpointCapture | undefined
    let commitStarted = false
    let result: { checkpointId: string } | undefined
    try {
      await this.handoff(
        structuredClone(target),
        async (locked) => {
          requireRemote(active && !captureStarted, 'native-handoff-capture-scope')
          requireRemote(
            locked && typeof locked.assertHeld === 'function',
            'native-handoff-lock-required',
          )
          assertHeld = locked.assertHeld.bind(locked)
          requireRemote(assertHeld() === true, 'native-handoff-lock-required')
          captureStarted = true
          captured = await this.store.transact(
            principalId,
            (state) => {
              requireRemote(active, 'native-handoff-capture-scope')
              requireRemote(assertHeld?.() === true, 'native-handoff-lock-required')
              const found = this.findSession(state, principalId, token)
              this.clear(state, token.sessionId)
              const capture: NativeCheckpointCapture = {
                captureId: randomUUID(),
                identity: structuredClone(found.nativeRecovery!.identity),
                bindingRevision: found.binding.bindingRevision,
                recovery: token,
                nativeDeliveryWatermark: found.nativeDeliveryWatermark,
                nativeWriterGeneration: found.nativeWriterGeneration,
                createdAtMs: this.now(),
              }
              found.nativeCheckpointCapture = capture
              return capture
            },
            'active',
          )
          return structuredClone(captured)
        },
        async (input) => {
          requireRemote(active && captured && !commitStarted, 'native-handoff-commit-scope')
          commitStarted = true
          verifyNativeCheckpoint(input)
          const checkpoint = structuredClone(input)
          result = await this.store.transact(
            principalId,
            (state) => {
              requireRemote(active, 'native-handoff-commit-scope')
              requireRemote(assertHeld?.() === true, 'native-handoff-lock-required')
              const found = this.findSession(state, principalId, token)
              this.clear(state, token.sessionId)
              requireRemote(
                equal(found.nativeCheckpointCapture, captured) &&
                  checkpoint.checkpointCaptureId === captured!.captureId &&
                  checkpoint.nativeDeliveryWatermark === found.nativeDeliveryWatermark &&
                  checkpoint.nativeDeliveryWatermark === captured!.nativeDeliveryWatermark &&
                  checkpoint.nativeWriterGeneration === found.nativeWriterGeneration &&
                  checkpoint.nativeWriterGeneration === captured!.nativeWriterGeneration &&
                  checkpoint.bindingRevision === found.binding.bindingRevision &&
                  checkpoint.createdAtMs >= captured!.createdAtMs,
                'native-handoff-capture-stale',
              )
              checkpointMatchesIdentity(checkpoint, found.nativeRecovery!.identity)
              found.nativeCheckpoint = checkpoint
              found.nativeCheckpointWatermark = found.nativeDeliveryWatermark
              found.nativeSealedWriterGeneration = found.nativeWriterGeneration
              found.nativeRecovery!.phase = 'completed'
              found.nativeRecovery!.checkpointId = checkpoint.checkpointId
              return { checkpointId: checkpoint.checkpointId }
            },
            'active',
          )
          return result
        },
      )
      requireRemote(result, 'native-handoff-not-committed')
      return result
    } finally {
      active = false
    }
  }
}
