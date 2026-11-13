import type {
  AgentRemoteBinding,
  AgentRemoteEnvironment,
  AgentRemoteEvent,
  AgentRemoteJobRef,
  AgentRemoteLeaseToken,
  AgentRemoteOperationState,
  AgentRemoteReceipt,
  AgentRemoteRequest,
  AgentRemoteWorker,
} from '@openclaude/protocol/agentRemote'
import type { NativeCheckpoint } from '@openclaude/protocol/agentRemoteState'

export interface JournalRecord {
  request: AgentRemoteRequest
  claim: AgentRemoteLeaseToken
  state: AgentRemoteOperationState
  cancelRequested: boolean
  events: AgentRemoteEvent[]
  receipt?: AgentRemoteReceipt
  job?: AgentRemoteJobRef
  cursor: { stdout: number; stderr: number }
  createdAtMs?: number
  updatedAtMs?: number
}
export interface RemoteSession {
  binding: AgentRemoteBinding
  lease?: AgentRemoteLeaseToken & { expiresAtMs: number; active: boolean }
  epochWatermark: number
  nativeCheckpoint?: NativeCheckpoint
}
export interface AgentRemoteState {
  workers: (AgentRemoteWorker & { expiresAtMs: number })[]
  environments: AgentRemoteEnvironment[]
  sessions: RemoteSession[]
  journal: JournalRecord[]
}
/**
 * Trusted control-plane storage boundary. transact MUST serialize/atomically commit
 * the whole principal aggregate, including binding, lease fence, journal and event.
 * Callbacks are synchronous/pure: no execution/network side effects inside them.
 * A durable implementation must fsync/commit before resolving, preserve watermark
 * and dedup records across restart, and return detached snapshots. Journal selections
 * include ALL unresolved records plus requested historical operations/dependencies; omitted
 * selection means all history. Metadata/fences still share the same transaction.
 * Executor-side fencing is also required before real integration.
 */
export type JournalSelection =
  | 'all'
  | 'active'
  | { operationKey: string; includeOperationKeys?: string[] }

export interface AgentRemoteStore {
  readonly durability: 'volatile' | 'durable'
  transact<T>(
    principalId: string,
    change: (draft: AgentRemoteState) => T,
    journal?: JournalSelection,
  ): Promise<T>
}
/** Test/reference only: process death loses all authority. Never resume live jobs. */
export class VolatileAgentRemoteStore implements AgentRemoteStore {
  readonly durability = 'volatile' as const
  private readonly states = new Map<string, AgentRemoteState>()
  async transact<T>(principalId: string, change: (draft: AgentRemoteState) => T): Promise<T> {
    const draft = structuredClone(
      this.states.get(principalId) ?? {
        workers: [],
        environments: [],
        sessions: [],
        journal: [],
      },
    )
    // No await between read, change and commit; single JS isolate reference only.
    const result = change(draft)
    this.states.set(principalId, structuredClone(draft))
    return structuredClone(result)
  }
}
