/**
 * Shared types for gateway session management, submit orchestration, and turn execution.
 * Type-only module: zero runtime imports, zero cycles.
 */
import type {
  DurableAgentGroup,
  GoalStateSnapshot,
  GrokExecutionDescriptor,
  OutboundContentBlock,
  RemoteExecutionBackend,
  ServiceTier,
  SessionWorkspaceMode,
} from '@openclaude/protocol'
import type { AgentDef, FrozenProjectContext } from '@openclaude/storage'
import type { AdvisorConsultExecution } from '../advisorMode.js'
import type { CrossPoolMigrationGrant } from '../cc5SessionBackend.js'
import type { AntigravityRouteOverride } from '../engine/antigravityAdapter.js'
import type { AntigravitySwarmCompactionContext } from '../engine/antigravitySwarmDirective.js'
import type { CodexProviderConfigOverride } from '../engine/codexShared.js'
import type { AutomaticRetryState, CollabAgentPolicy } from '../engine/engineAdapter.js'
import type { DurableRuntimeEvent, SessionStreamEvent } from '../engine/engineEvents.js'
import type { GrokRouteOverride } from '../engine/grokAdapter.js'
import type { ZcodeRouteOverride } from '../engine/zcodeAdapter.js'
import type { RunContextDescriptor } from '../runContextPersist.js'
import type { AgentSession } from '../sessionTypes.js'
import type { TurnModelAuthority, UsageAttributionTag } from '../subprocessRunner.js'

export interface PromptQueueExternalTurnReservation {
  turnIndex: number
  turnKey: string
}

export type ChatHistoryMessage = {
  id?: unknown
  role?: unknown
  text?: unknown
  content?: unknown
  status?: unknown
  system?: unknown
}

export type PendingExternalExchange = {
  user: { id: string; role: 'user'; text: string; status: 'completed'; ts: number }
  assistant: { id: string; role: 'assistant'; text: string; status: 'completed'; ts: number }
}

/** OCV5-180 B1 — `_pendingAgentGroups` entry: completed team card + frozen owner turnKey. */
export interface PendingAgentGroupEntry {
  group: DurableAgentGroup
  ownerTurnKey?: string
}

/** Structured outcome of `preheatRunner` (engine_preheat observability). */
export type PreheatOutcome =
  | 'started'
  | 'already_running'
  | 'failed'
  | 'skipped_engine'
  | 'skipped_teardown'
  | 'skipped_busy'
  | 'skipped_cap'

export interface CronBridgeEvent {
  action: 'create' | 'delete' | 'list'
  agentId: string
  cron?: string
  prompt?: string
  recurring?: boolean
  durable?: boolean
  id?: string
}

/** Four-state persistence outcome for server-authored / post-terminal turns. */
export type TapePersistResult = 'acked' | 'queued' | 'dropped' | 'skipped'

/** OCV5-180 B1 — shared exact-owner logical-run ledger state. */
export type ExactOwnerRunState = 'buffered' | 'inflight' | 'queued' | 'acked' | 'session_deleted'

export interface ExactOwnerRunRecord {
  identity: string
  state: ExactOwnerRunState
}

export interface TailFoldItem {
  event: DurableRuntimeEvent
  block: OutboundContentBlock
  hash: string
  ownerTurnKey: string
  ownerSessionId: string
  turnIndex: number
  toolUseId: string
  parentToolUseId: string
  onEvent: (e: SessionStreamEvent) => void
}

export interface TailFoldStreamState {
  lastPersistedHash: string | null
  lastPersistAt: number
  persistedCount: number
  pending: TailFoldItem | null
  timer: ReturnType<typeof setTimeout> | null
  capped: boolean
  markerEvent: DurableRuntimeEvent | null
}

export interface TailPersistQueueItem {
  st: TailFoldStreamState
  item: TailFoldItem
}

export interface TailOwnerBudget {
  persistedCount: number
  capped: boolean
  markerEvent: DurableRuntimeEvent | null
  chain: Promise<void>
}

export interface PromptQueueExecutionFence {
  readonly sessionKey: string
  readonly token: symbol
  release(): void
}

export interface TurnQueueLifecycle {
  readonly queueTurn: true
  onTurnReserved(reservation: {
    turnIndex: number
    turnKey: string
    traceId?: string
  }): Promise<void>
}

export interface SubmitReplayLifecycle {
  clientMessageId: string
  onStart: () => void
  onBeforeRelease: (unhandledError: unknown | undefined) => void
  onEnd: () => void
}

export interface SessionExecutionAuthority {
  executionBackend?: RemoteExecutionBackend
  canonicalModel: string
  engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode' | 'antigravity'
  source?: 'bridge_signed' | 'local_catalog'
}

export interface GetOrCreateOpts {
  sessionKey: string
  agent: AgentDef
  channel?: string
  peerId?: string
  model?: string
  modelSwitchId?: string
  executionAuthority?: SessionExecutionAuthority
  userId?: string
  repoSessionId?: string
  workspaceMode?: SessionWorkspaceMode
  workspaceCwd?: string
  projectId?: string | null
  contextFingerprint?: string
  assetsRevision?: number
  runContext?: RunContextDescriptor
  frozenProjectContext?: FrozenProjectContext | null
  parentSessionKey?: string
  title?: string
  delegationDepth?: number
  preheatOnly?: boolean
  effortLevel?: string | null
  promptQueueExecutionFence?: PromptQueueExecutionFence
  workload?: string
  skillTrainRunId?: string
  skillEvalMode?: boolean
  skillEvalExclude?: string
  skillEvalDraft?: { name: string; dir: string }
  hermeticNoTools?: boolean
  advisorExecutionLock?: AdvisorConsultExecution
  structuredOutputSchema?: Readonly<Record<string, unknown>>
  usageAttribution?: UsageAttributionTag
  poolMigration?: CrossPoolMigrationGrant
}

export interface SubmitOpts {
  historicalMessages?: unknown[]
  codexRoute?: CodexProviderConfigOverride | null
  grokRoute?: GrokRouteOverride | null
  grokExecutionDescriptor?: GrokExecutionDescriptor
  resetNativeSession?: boolean
  zcodeRoute?: ZcodeRouteOverride | null
  antigravityRoute?: AntigravityRouteOverride | null
  antigravitySwarmCompaction?: AntigravitySwarmCompactionContext
  serviceTier?: ServiceTier | null
  platformGoal?: GoalStateSnapshot | null
  turnChatProjectId?: string | null
  toolsets?: string[]
  collabAgentPolicy?: CollabAgentPolicy
  readOnly?: boolean
  modelAuthority?: TurnModelAuthority
  systemHelpBootstrap?: string
  creditBudgetFen?: bigint
  emitContextRebuilt?: (info: {
    messageCount: number
    reason?: 'engine-switch' | 'native-resume-loss'
  }) => void
  replayLifecycle?: SubmitReplayLifecycle
  dispatchContext?: AgentSession['_currentDispatch']
  queueLifecycle?: TurnQueueLifecycle
  queueExecutionFence?: PromptQueueExecutionFence
  automaticRetryState?: AutomaticRetryState
  modelSwitchId?: string
  modelSwitchInternal?: string
  _internalCompact?: boolean
}

export interface ParsedVerdict {
  verdict: 'PASS' | 'FAIL' | 'PARTIAL' | 'NEEDS_FIX'
  passed: boolean
  evidence: Array<{ check: string; passed: boolean; detail?: string }>
}

export type TurnUserInput = string | Array<{ type: string; [key: string]: unknown }>

export interface PreStartStopEntry {
  expiresAt: number
  sendAttempt?: number
}
