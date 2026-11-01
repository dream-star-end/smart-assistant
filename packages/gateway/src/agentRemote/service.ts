import {
  type AgentRemoteBinding,
  type AgentRemoteEnvironment,
  type AgentRemoteEvent,
  type AgentRemoteLeaseToken,
  type AgentRemoteRequest,
  type AgentRemoteWorker,
  BindingSchema,
  EnvironmentSchema,
  EventSchema,
  LeaseSchema,
  WorkerSchema,
  agentRemoteContentHash,
  agentRemoteOperationKey,
  remoteCanonical,
  remoteTerminal,
  requireRemote,
  requiredRemoteCapabilities,
  validateRemote,
  verifyRemoteRequest,
} from '@openclaude/protocol/agentRemote'
import {
  type NativeCheckpoint,
  type NativeCheckpointIdentity,
  checkpointMatchesIdentity,
  verifyNativeCheckpoint,
} from '@openclaude/protocol/agentRemoteState'
import type {
  AgentRemoteState,
  AgentRemoteStore,
  JournalRecord,
  JournalSelection,
  RemoteSession,
} from './store.js'

const MAX_ITEMS = 10000
function time(value: number): number {
  requireRemote(Number.isSafeInteger(value) && value >= 0, 'bad-time')
  return value
}
function expiry(now: number, ttl: number): number {
  requireRemote(Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 300000, 'bad-ttl')
  return time(now + ttl)
}
function next(value: number): number {
  requireRemote(
    Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER,
    'counter-exhausted',
  )
  return value + 1
}
function equal(a: unknown, b: unknown): boolean {
  return remoteCanonical(a) === remoteCanonical(b)
}
function bounded(items: unknown[]): void {
  requireRemote(items.length < MAX_ITEMS, 'reference-capacity')
}
function unresolved(record: Pick<JournalRecord, 'state'>): boolean {
  return !remoteTerminal(record.state)
}
function session(state: AgentRemoteState, binding: AgentRemoteBinding): RemoteSession {
  validateRemote<AgentRemoteBinding>(BindingSchema, binding)
  const found = state.sessions.find((item) => item.binding.sessionId === binding.sessionId)
  requireRemote(found && equal(found.binding, binding), 'binding-mismatch')
  return found
}
function resources(
  state: AgentRemoteState,
  binding: AgentRemoteBinding,
  now: number,
): AgentRemoteEnvironment {
  const worker = state.workers.find((item) => item.workerId === binding.workerId)
  requireRemote(
    worker && worker.workerInstanceId === binding.workerInstanceId && worker.expiresAtMs > now,
    'worker-unavailable',
  )
  const environment = state.environments.find(
    (item) => item.environmentId === binding.environmentId,
  )
  requireRemote(
    environment && environment.generation === binding.environmentGeneration,
    'environment-mismatch',
  )
  return environment
}
function fence(
  state: AgentRemoteState,
  binding: AgentRemoteBinding,
  token: AgentRemoteLeaseToken,
  now: number,
): RemoteSession {
  validateRemote<AgentRemoteLeaseToken>(LeaseSchema, token)
  const found = session(state, binding)
  resources(state, binding, now)
  requireRemote(
    found.lease?.active &&
      found.lease.expiresAtMs > now &&
      found.lease.ownerInstanceId === token.ownerInstanceId &&
      found.lease.epoch === token.epoch,
    'stale-lease',
  )
  return found
}
function findRecord(
  state: AgentRemoteState,
  binding: AgentRemoteBinding,
  operationId: string,
): JournalRecord {
  const key = agentRemoteOperationKey(binding, operationId)
  const record = state.journal.find(
    (item) => agentRemoteOperationKey(item.request.binding, item.request.operationId) === key,
  )
  requireRemote(record && equal(record.request.binding, binding), 'unknown-operation')
  return record
}

function validateResult(
  request: AgentRemoteRequest,
  receipt: Extract<
    import('@openclaude/protocol/agentRemote').AgentRemoteReceipt,
    { status: 'completed' }
  >,
): void {
  const command = request.command
  const result = receipt.result
  if (command.kind === 'process.exec') {
    requireRemote(receipt.exitCode !== undefined && result === undefined, 'invalid-process-result')
    return
  }
  requireRemote(
    result && result.kind === command.kind && receipt.exitCode === undefined,
    'result-kind-mismatch',
  )
  if (command.kind === 'file.read' && result.kind === 'file.read') {
    const bytes = Buffer.byteLength(result.contentUtf8, 'utf8')
    requireRemote(
      result.path === command.path &&
        result.offsetBytes === command.offsetBytes &&
        bytes <= command.limitBytes &&
        result.nextOffsetBytes === time(result.offsetBytes + bytes) &&
        result.nextOffsetBytes <= result.totalBytes &&
        result.eof === (result.nextOffsetBytes === result.totalBytes) &&
        result.contentSha256 === agentRemoteContentHash(result.contentUtf8) &&
        (result.eof || bytes > 0) &&
        (result.offsetBytes !== 0 || !result.eof || result.fileSha256 === result.contentSha256),
      'invalid-file-result',
    )
  } else if (
    (command.kind === 'file.write' || command.kind === 'file.edit') &&
    (result.kind === 'file.write' || result.kind === 'file.edit')
  ) {
    requireRemote(result.path === command.path, 'invalid-file-result')
    if (command.kind === 'file.write')
      requireRemote(
        result.totalBytes === Buffer.byteLength(command.contentUtf8, 'utf8') &&
          result.sha256 === agentRemoteContentHash(command.contentUtf8),
        'invalid-file-result',
      )
    if (command.kind === 'file.edit' && result.kind === 'file.edit')
      requireRemote(
        result.previousSha256 === command.expectedSha256 && result.replacements === 1,
        'invalid-file-result',
      )
  } else if ('jobId' in command && 'job' in result) {
    requireRemote(
      equal(result.job, { jobId: command.jobId, sourceOperationId: command.sourceOperationId }),
      'job-scope-mismatch',
    )
    if (command.kind === 'process.logs' && result.kind === 'process.logs') {
      requireRemote(
        command.stream === result.stream &&
          command.offsetBytes === result.offsetBytes &&
          Buffer.byteLength(result.text, 'utf8') <= command.limitBytes &&
          result.nextOffsetBytes ===
            time(result.offsetBytes + Buffer.byteLength(result.text, 'utf8')),
        'invalid-log-result',
      )
    } else if (command.kind === 'process.status' && result.kind === 'process.status') {
      requireRemote(
        (result.state === 'completed') === (result.exitCode !== undefined),
        'invalid-status-result',
      )
    } else if (command.kind === 'process.stop' && result.kind === 'process.stop') {
      requireRemote(command.scope === result.stopScope, 'invalid-stop-result')
    }
  }
}

/** No constructor side effects. principalId must come from existing authenticated
 * authority, NEVER directly from an untrusted request field. This module has no
 * transport/authentication handler and is not wired into production.
 */
class AgentRemoteService {
  constructor(
    private readonly store: AgentRemoteStore,
    private readonly clock: () => number,
  ) {}
  get durability(): AgentRemoteStore['durability'] {
    return this.store.durability
  }
  private tx<T>(
    principalId: string,
    change: (state: AgentRemoteState, now: number) => T,
    journal: JournalSelection = 'active',
  ): Promise<T> {
    requireRemote(/^[A-Za-z0-9_.:-]{1,160}$/.test(principalId), 'bad-principal')
    return this.store.transact(principalId, (state) => change(state, time(this.clock())), journal)
  }
  private owner(principalId: string, supplied: string): void {
    requireRemote(principalId === supplied, 'principal-mismatch')
  }
  async registerWorker(
    principalId: string,
    input: AgentRemoteWorker,
    ttlMs: number,
  ): Promise<void> {
    validateRemote<AgentRemoteWorker>(WorkerSchema, input)
    this.owner(principalId, input.principalId)
    const copy = structuredClone(input)
    return this.tx(principalId, (state, now) => {
      const previous = state.workers.find((item) => item.workerId === copy.workerId)
      if (previous && previous.workerInstanceId !== copy.workerInstanceId) {
        requireRemote(
          ![...state.journal, ...state.nativeJournal].some(
            (item) => unresolved(item) && item.request.binding.workerId === copy.workerId,
          ),
          'inflight-worker',
        )
      }
      if (!previous) bounded(state.workers)
      state.workers = state.workers.filter((item) => item.workerId !== copy.workerId)
      state.workers.push({ ...copy, expiresAtMs: expiry(now, ttlMs) })
    })
  }
  async registerEnvironment(principalId: string, input: AgentRemoteEnvironment): Promise<void> {
    validateRemote<AgentRemoteEnvironment>(EnvironmentSchema, input)
    this.owner(principalId, input.principalId)
    const copy = structuredClone(input)
    return this.tx(principalId, (state) => {
      const previous = state.environments.find((item) => item.environmentId === copy.environmentId)
      if (previous) {
        if (equal(previous, copy)) return
        requireRemote(copy.generation > previous.generation, 'environment-generation')
        requireRemote(
          ![...state.journal, ...state.nativeJournal].some(
            (item) => unresolved(item) && item.request.binding.environmentId === copy.environmentId,
          ),
          'inflight-environment',
        )
      } else bounded(state.environments)
      state.environments = state.environments.filter(
        (item) => item.environmentId !== copy.environmentId,
      )
      state.environments.push(copy)
    })
  }
  async bind(
    principalId: string,
    input: { sessionId: string; workerId: string; environmentId: string },
  ): Promise<AgentRemoteBinding> {
    const copy = structuredClone(input)
    return this.tx(principalId, (state, now) => {
      const worker = state.workers.find((item) => item.workerId === copy.workerId)
      const environment = state.environments.find(
        (item) => item.environmentId === copy.environmentId,
      )
      requireRemote(worker && environment, 'registry-missing')
      const previous = state.sessions.find((item) => item.binding.sessionId === copy.sessionId)
      const binding: AgentRemoteBinding = {
        principalId,
        sessionId: copy.sessionId,
        workerId: copy.workerId,
        workerInstanceId: worker.workerInstanceId,
        environmentId: copy.environmentId,
        environmentGeneration: environment.generation,
        bindingRevision: previous?.binding.bindingRevision ?? 1,
      }
      validateRemote<AgentRemoteBinding>(BindingSchema, binding)
      resources(state, binding, now)
      if (previous && equal(previous.binding, binding)) return previous.binding
      requireRemote(
        ![...state.journal, ...state.nativeJournal].some(
          (item) => item.request.binding.sessionId === copy.sessionId && unresolved(item),
        ),
        'inflight-session',
      )
      if (previous) {
        binding.bindingRevision = next(previous.binding.bindingRevision)
        previous.binding = binding
        if (previous.lease) previous.lease.active = false
      } else {
        bounded(state.sessions)
        state.sessions.push({ binding, epochWatermark: 0 })
      }
      return binding
    })
  }
  async claim(
    principalId: string,
    binding: AgentRemoteBinding,
    ttlMs: number,
  ): Promise<AgentRemoteLeaseToken> {
    this.owner(principalId, binding.principalId)
    const copy = structuredClone(binding)
    return this.tx(principalId, (state, now) => {
      const found = session(state, copy)
      resources(state, copy, now)
      requireRemote(!found.lease?.active || found.lease.expiresAtMs <= now, 'lease-busy')
      found.epochWatermark = next(found.epochWatermark)
      found.lease = {
        ownerInstanceId: copy.workerInstanceId,
        epoch: found.epochWatermark,
        expiresAtMs: expiry(now, ttlMs),
        active: true,
      }
      return { ownerInstanceId: found.lease.ownerInstanceId, epoch: found.lease.epoch }
    })
  }
  async renew(
    principalId: string,
    binding: AgentRemoteBinding,
    token: AgentRemoteLeaseToken,
    ttlMs: number,
  ): Promise<void> {
    this.owner(principalId, binding.principalId)
    binding = structuredClone(binding)
    token = structuredClone(token)
    return this.tx(principalId, (state, now) => {
      const found = fence(state, binding, token, now)
      found.lease!.expiresAtMs = expiry(now, ttlMs)
    })
  }
  async release(
    principalId: string,
    binding: AgentRemoteBinding,
    token: AgentRemoteLeaseToken,
  ): Promise<void> {
    this.owner(principalId, binding.principalId)
    binding = structuredClone(binding)
    token = structuredClone(token)
    return this.tx(principalId, (state, now) => {
      fence(state, binding, token, now).lease!.active = false
    })
  }
  async accept(principalId: string, input: AgentRemoteRequest): Promise<JournalRecord> {
    verifyRemoteRequest(input)
    this.owner(principalId, input.binding.principalId)
    const request = structuredClone(input)
    return this.tx(
      principalId,
      (state, now) => {
        fence(state, request.binding, request.lease, now)
        const key = agentRemoteOperationKey(request.binding, request.operationId)
        const previous = state.journal.find(
          (item) => agentRemoteOperationKey(item.request.binding, item.request.operationId) === key,
        )
        if (previous) {
          requireRemote(previous.request.payloadHash === request.payloadHash, 'operation-conflict')
          return previous
        }
        requireRemote(request.deadlineAtMs > now, 'deadline-expired')
        const environment = resources(state, request.binding, now)
        requireRemote(
          requiredRemoteCapabilities(request.command).every((capability) =>
            environment.capabilities.includes(capability),
          ),
          'unsupported-capability',
        )
        if ('jobId' in request.command) {
          const command = request.command
          const source = findRecord(state, request.binding, command.sourceOperationId)
          requireRemote(
            source.request.command.kind === 'process.exec' &&
              source.job &&
              equal(source.job, {
                jobId: command.jobId,
                sourceOperationId: command.sourceOperationId,
              }),
            'job-scope-mismatch',
          )
        }
        // Memory cannot attest durable execution, even if an environment advertises it.
        bounded(state.journal)
        const record: JournalRecord = {
          request,
          claim: request.lease,
          state: 'accepted',
          cancelRequested: false,
          events: [],
          cursor: { stdout: 0, stderr: 0 },
          createdAtMs: now,
          updatedAtMs: now,
        }
        state.journal.push(record)
        return record
      },
      {
        operationKey: agentRemoteOperationKey(request.binding, request.operationId),
        includeOperationKeys:
          'jobId' in request.command
            ? [agentRemoteOperationKey(request.binding, request.command.sourceOperationId)]
            : [],
      },
    )
  }
  /** Atomic start intent, committed BEFORE any execution message is sent.
   * A dispatched intent may already have caused a side effect: never auto-replay.
   * Real executors must independently fence/consume this intent before execution.
   */
  async authorizeStart(
    principalId: string,
    binding: AgentRemoteBinding,
    operationId: string,
    token: AgentRemoteLeaseToken,
  ): Promise<JournalRecord> {
    this.owner(principalId, binding.principalId)
    binding = structuredClone(binding)
    token = structuredClone(token)
    return this.tx(
      principalId,
      (state, now) => {
        fence(state, binding, token, now)
        const record = findRecord(state, binding, operationId)
        requireRemote(equal(record.claim, token), 'stale-operation-claim')
        requireRemote(record.state === 'accepted', 'already-dispatched')
        requireRemote(!record.cancelRequested, 'cancel-pending')
        requireRemote(record.request.deadlineAtMs > now, 'deadline-expired')
        record.state = 'dispatched'
        return record
      },
      { operationKey: agentRemoteOperationKey(binding, operationId) },
    )
  }
  async observe(principalId: string, input: AgentRemoteEvent): Promise<JournalRecord> {
    validateRemote<AgentRemoteEvent>(EventSchema, input)
    this.owner(principalId, input.binding.principalId)
    remoteCanonical(input) // Reject lone surrogates/non-JSON before byte accounting.
    const event = structuredClone(input)
    return this.tx(
      principalId,
      (state, now) => {
        fence(state, event.binding, event.lease, now)
        const record = findRecord(state, event.binding, event.operationId)
        requireRemote(
          event.payloadHash === record.request.payloadHash && equal(event.lease, record.claim),
          'observation-mismatch',
        )
        const previous = record.events[event.sequence - 1]
        if (previous) {
          requireRemote(equal(previous, event), 'event-conflict')
          return record
        }
        requireRemote(event.sequence === record.events.length + 1, 'event-gap')
        requireRemote(
          !remoteTerminal(record.state) && record.state !== 'unknown',
          'operation-closed',
        )
        if (event.body.type === 'started') {
          requireRemote(record.state === 'dispatched', 'not-dispatched')
          record.state = 'started'

          if (record.request.command.kind === 'process.exec') {
            requireRemote(
              event.body.job && event.body.job.sourceOperationId === record.request.operationId,
              'missing-job-reference',
            )
            record.job = event.body.job
          } else requireRemote(!event.body.job, 'unexpected-job-reference')
        } else {
          requireRemote(record.state === 'started', 'not-started')
          if (event.body.type === 'output') {
            requireRemote(record.request.command.kind === 'process.exec', 'output-not-process')
            const body = event.body
            requireRemote(
              Buffer.byteLength(body.text, 'utf8') <= 262144 &&
                body.offsetBytes === record.cursor[body.stream],
              'cursor-mismatch',
            )
            record.cursor[body.stream] = time(
              body.offsetBytes + Buffer.byteLength(body.text, 'utf8'),
            )
          } else {
            const receipt = event.body.receipt
            if (receipt.status === 'cancelled') {
              requireRemote(receipt.stopScope !== 'not-started', 'invalid-stop-evidence')
              requireRemote(record.request.command.kind === 'process.exec', 'stop-not-process')
              if (receipt.stopScope === 'process-tree')
                requireRemote(
                  resources(state, event.binding, now).capabilities.includes('process.stop-tree'),
                  'unsupported-stop-evidence',
                )
            }
            if (receipt.status === 'completed') validateResult(record.request, receipt)
            record.state = receipt.status
            record.receipt = receipt
          }
        }
        bounded(record.events)
        record.events.push(event)
        record.updatedAtMs = now
        return record
      },
      { operationKey: agentRemoteOperationKey(event.binding, event.operationId) },
    )
  }
  async requestCancel(
    principalId: string,
    binding: AgentRemoteBinding,
    operationId: string,
    token: AgentRemoteLeaseToken,
  ): Promise<JournalRecord> {
    this.owner(principalId, binding.principalId)
    binding = structuredClone(binding)
    token = structuredClone(token)
    return this.tx(
      principalId,
      (state, now) => {
        fence(state, binding, token, now)
        const record = findRecord(state, binding, operationId)
        requireRemote(equal(record.claim, token), 'stale-operation-claim')
        requireRemote(
          !remoteTerminal(record.state) && record.state !== 'unknown',
          'operation-closed',
        )
        record.cancelRequested = true
        return record
      },
      { operationKey: agentRemoteOperationKey(binding, operationId) },
    )
  }
  /** Trusted user/control-plane cancellation; accepted means NO grant exists.
   * The CAS and receipt commit together, so a late worker cannot dispatch it.
   */
  async cancelQueued(
    principalId: string,
    binding: AgentRemoteBinding,
    operationId: string,
  ): Promise<JournalRecord> {
    this.owner(principalId, binding.principalId)
    binding = structuredClone(binding)
    return this.tx(
      principalId,
      (state, now) => {
        session(state, binding)
        const record = findRecord(state, binding, operationId)
        if (
          record.state === 'cancelled' &&
          record.receipt?.status === 'cancelled' &&
          record.receipt.stopScope === 'not-started'
        )
          return record
        requireRemote(record.state === 'accepted', 'not-queued')
        record.cancelRequested = true
        record.state = 'cancelled'
        record.updatedAtMs = now
        record.receipt = { status: 'cancelled', stopScope: 'not-started' }
        return record
      },
      { operationKey: agentRemoteOperationKey(binding, operationId) },
    )
  }
  async expireQueued(
    principalId: string,
    binding: AgentRemoteBinding,
    operationId: string,
  ): Promise<JournalRecord> {
    this.owner(principalId, binding.principalId)
    binding = structuredClone(binding)
    return this.tx(
      principalId,
      (state, now) => {
        session(state, binding)
        const record = findRecord(state, binding, operationId)
        if (
          record.state === 'failed' &&
          record.receipt?.status === 'failed' &&
          record.receipt.code === 'deadline-before-dispatch'
        )
          return record
        requireRemote(
          record.state === 'accepted' && record.request.deadlineAtMs <= now,
          'not-expired-queued',
        )
        record.state = 'failed'
        record.updatedAtMs = now
        record.receipt = { status: 'failed', code: 'deadline-before-dispatch' }
        return record
      },
      { operationKey: agentRemoteOperationKey(binding, operationId) },
    )
  }
  async query(
    principalId: string,
    binding: AgentRemoteBinding,
    operationId: string,
  ): Promise<JournalRecord> {
    this.owner(principalId, binding.principalId)
    binding = structuredClone(binding)
    return this.tx(principalId, (state) => findRecord(state, binding, operationId), {
      operationKey: agentRemoteOperationKey(binding, operationId),
    })
  }
  /** Recovery NEVER runs a command. Only never-started work can receive a new claim.
   * started without a trustworthy receipt becomes unknown and blocks rebinding.
   * Unknown reconciliation/force-discard policy is intentionally not provided.
   */
  async recover(
    principalId: string,
    binding: AgentRemoteBinding,
    operationId: string,
    token: AgentRemoteLeaseToken,
  ): Promise<JournalRecord> {
    this.owner(principalId, binding.principalId)
    binding = structuredClone(binding)
    token = structuredClone(token)
    return this.tx(
      principalId,
      (state, now) => {
        fence(state, binding, token, now)
        const record = findRecord(state, binding, operationId)
        if (
          record.state === 'accepted' ||
          record.state === 'dispatched' ||
          record.state === 'started'
        )
          requireRemote(token.epoch > record.claim.epoch, 'recovery-requires-new-epoch')
        if (record.state === 'accepted') {
          requireRemote(!record.cancelRequested, 'cancel-pending')
          record.claim = structuredClone(token)
        } else if (record.state === 'dispatched' || record.state === 'started')
          record.state = 'unknown'
        return record
      },
      { operationKey: agentRemoteOperationKey(binding, operationId) },
    )
  }
  /** Internal publication only: caller is the quiescent native checkpoint task,
   * holding the actual session writer lock through file fsync AND this commit.
   * Not a handler for a caller-supplied claim of quiescence.
   */
  async publishNativeCheckpoint(
    principalId: string,
    binding: AgentRemoteBinding,
    token: AgentRemoteLeaseToken,
    input: NativeCheckpoint,
  ): Promise<NativeCheckpoint> {
    this.owner(principalId, binding.principalId)
    verifyNativeCheckpoint(input)
    binding = structuredClone(binding)
    token = structuredClone(token)
    const checkpoint = structuredClone(input)
    return this.tx(principalId, (state, now) => {
      const current = fence(state, binding, token, now)
      requireRemote(
        checkpoint.principalId === principalId &&
          checkpoint.sessionId === binding.sessionId &&
          checkpoint.environmentId === binding.environmentId &&
          checkpoint.environmentGeneration === binding.environmentGeneration &&
          checkpoint.bindingRevision === binding.bindingRevision,
        'checkpoint-binding',
      )
      requireRemote(
        ![...state.journal, ...state.nativeJournal].some(
          (row) => row.request.binding.sessionId === binding.sessionId && unresolved(row),
        ),
        'checkpoint-inflight',
      )
      current.nativeCheckpoint = checkpoint
      return checkpoint
    })
  }
  async nativeCheckpoint(
    principalId: string,
    binding: AgentRemoteBinding,
    expected: NativeCheckpointIdentity,
  ): Promise<NativeCheckpoint | undefined> {
    this.owner(principalId, binding.principalId)
    binding = structuredClone(binding)
    expected = structuredClone(expected)
    return this.tx(principalId, (state) => {
      const checkpoint = session(state, binding).nativeCheckpoint
      if (!checkpoint) return undefined
      verifyNativeCheckpoint(checkpoint)
      checkpointMatchesIdentity(checkpoint, expected)
      return checkpoint
    })
  }
}

/** Default OFF; do not even construct a store unless explicitly enabled.
 * Volatile mode must also be explicitly opted into by tests/experiments.
 */
export function createAgentRemoteService(options: {
  env: Readonly<Record<string, string | undefined>>
  createStore: () => AgentRemoteStore
  clock?: () => number
  allowVolatileReference?: boolean
}): AgentRemoteService | undefined {
  if (options.env.OC_AGENT_REMOTE_ENABLED !== '1') return undefined
  const store = options.createStore()
  requireRemote(
    store.durability === 'durable' || options.allowVolatileReference === true,
    'durable-store-required',
  )
  return new AgentRemoteService(store, options.clock ?? Date.now)
}

/** Internal shared control fence; not a transport handler or caller-asserted lease. */
export { fence as requireAgentRemoteControlFence }
