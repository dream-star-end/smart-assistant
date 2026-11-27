/**
 * Antigravity swarm deadlock guard, route heartbeat state machine, closed-turn
 * orphan reaper, and adapter swarm-lifecycle helpers (OCV5-923).
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { SWARM_BOARD_TOOL_NAME, type SwarmPhase, type SwarmSnapshot } from '@openclaude/protocol'
import {
  renewAntigravityRouteLeaseDetailed,
  type AntigravityRouteRenewResult,
} from '../delegateAntigravityRoute.js'
import {
  mergeProcessTreeSnapshots,
  snapshotDescendantProcessGroups,
  type ProcessTreeSnapshot,
} from '../processGroupShutdown.js'
import { lookupRemoteSwarmMcpContext } from '../remoteSwarmRuntime.js'
import { injectSwarmDirective } from '../swarmCommand.js'
import type { EngineBillingEvent, EngineExternalBillingEvent, TurnToolEntry } from './engineEvents.js'
import {
  buildAntigravityDurableBillingEvent,
  hasAnyTrackedProcessGroupAlive,
  reapLingeringCliProcessGroup,
} from './antigravitySwarmConcurrency.js'
import {
  buildDurableSwarmBoardInput,
  formatSwarmWorkingDetail,
} from './antigravitySwarmFormat.js'
import type { AntigravitySwarmWatcher } from './antigravitySwarmWatcher.js'
import { GATEWAY_STALL_MONITOR_AGENT, type SwarmStallAlert } from './swarmStallTypes.js'

export const ANTIGRAVITY_SWARM_DEADLOCKED_DETAIL =
  'ANTIGRAVITY_SWARM_DEADLOCKED: 蜂群长时间无进展且多次催促无响应，已自动终止并回收进程组'

async function normalizeRouteRenewHook(
  onRenewRoute: () => Promise<boolean | AntigravityRouteRenewResult>,
): Promise<AntigravityRouteRenewResult> {
  try {
    const res = await onRenewRoute()
    if (res === true || res === 'ok') return 'ok'
    if (res === 'unconfigured') return 'unconfigured'
    if (res === false || res === 'revoked') return 'revoked'
    return 'transient_error'
  } catch {
    return 'transient_error'
  }
}

export async function probeAntigravityRouteHeartbeat(
  routeToken: string,
  testHook?: (routeToken: string) => Promise<boolean | AntigravityRouteRenewResult>,
): Promise<AntigravityRouteRenewResult> {
  if (testHook) {
    return normalizeRouteRenewHook(() => testHook(routeToken))
  }
  return renewAntigravityRouteLeaseDetailed(routeToken)
}

export function advanceAntigravityRouteHeartbeatCounters(
  state: { routeRenewRevokedCount: number; routeRenewFailureCount: number },
  outcome: AntigravityRouteRenewResult,
  stalledAllParked: boolean,
): { degraded: boolean; fastKillReason: 'stalled_swarm_route_revoked' | 'stalled_swarm_route_failed' | null } {
  if (outcome === 'ok' || outcome === 'unconfigured') {
    state.routeRenewRevokedCount = 0
    state.routeRenewFailureCount = 0
    return { degraded: false, fastKillReason: null }
  }
  state.routeRenewFailureCount += 1
  if (outcome === 'revoked') {
    state.routeRenewRevokedCount += 1
  }
  const fastKillReason =
    stalledAllParked && state.routeRenewRevokedCount >= 2
      ? 'stalled_swarm_route_revoked'
      : stalledAllParked && state.routeRenewFailureCount >= 3
        ? 'stalled_swarm_route_failed'
        : null
  return { degraded: true, fastKillReason }
}

/**
 * Bounded non-blocking reap after a CLI process has already closed, catching
 * orphaned PGID members (such as `oc-memory-mcp.cjs` after a non-zero exit)
 * or previously captured escaped descendant PGIDs. Zero-cost synchronous no-op
 * when no lingering process group is alive.
 */
export function reapClosedTurnLingeringProcessGroup(
  proc: ChildProcess | null,
  snapshot?: ProcessTreeSnapshot | null,
  opts?: { termGraceMs?: number; killGraceMs?: number },
): void {
  if (!proc || !hasAnyTrackedProcessGroupAlive(proc.pid, snapshot)) return
  void reapLingeringCliProcessGroup(proc, () => true, {
    naturalExitGraceMs: 0,
    termGraceMs: opts?.termGraceMs ?? 300,
    killGraceMs: opts?.killGraceMs ?? 300,
    snapshot,
  })
}

export function captureProcessTreeSnapshot(
  proc: ChildProcess | null,
  prevSnapshot: ProcessTreeSnapshot | null,
): ProcessTreeSnapshot | null {
  const pid = proc?.pid
  if (typeof pid !== 'number' || pid <= 1) return prevSnapshot
  return mergeProcessTreeSnapshots(prevSnapshot, snapshotDescendantProcessGroups(pid))
}

/**
 * B3/B4: Start idempotent, bounded process-tree reclamation immediately upon
 * abnormal CLI `exit` (or interrupted / deadlock-terminating exit), without
 * waiting for `close` (which can deadlock when an orphaned child inherits stdio).
 * Uses a brief natural-exit grace (20ms) so clean non-zero exits with no
 * lingering children settle via `close` immediately without spurious signals.
 */
export function scheduleAbnormalExitProcessTreeReap(args: {
  proc: ChildProcess
  isClosed: () => boolean
  getSnapshot: () => ProcessTreeSnapshot | null
  setSnapshot: (snap: ProcessTreeSnapshot | null) => void
  getReapPromise: () => Promise<void> | null
  setReapPromise: (p: Promise<void>) => void
  naturalExitGraceMs?: number
  termGraceMs?: number
  killGraceMs?: number
}): void {
  if (args.getReapPromise()) return
  const merged = captureProcessTreeSnapshot(args.proc, args.getSnapshot())
  args.setSnapshot(merged)
  if (args.isClosed() && !hasAnyTrackedProcessGroupAlive(args.proc.pid, merged)) return
  const reapPromise = reapLingeringCliProcessGroup(args.proc, args.isClosed, {
    naturalExitGraceMs: args.naturalExitGraceMs ?? 20,
    termGraceMs: Math.max(20, args.termGraceMs ?? 300),
    killGraceMs: Math.max(20, args.killGraceMs ?? 300),
    snapshot: merged,
  }).catch(() => {
    /* bounded reap errors must never surface as unhandled rejections */
  })
  args.setReapPromise(reapPromise)
}

export async function reapDeadlockedSwarmProcess(
  proc: ChildProcess | null,
  isClosed: () => boolean,
  prevSnapshot: ProcessTreeSnapshot | null,
  onSnapshot: (snap: ProcessTreeSnapshot | null) => void,
  opts?: { termGraceMs?: number; killGraceMs?: number },
): Promise<void> {
  if (!proc) return
  const snap =
    typeof proc.pid === 'number' && proc.pid > 1
      ? mergeProcessTreeSnapshots(prevSnapshot, snapshotDescendantProcessGroups(proc.pid))
      : prevSnapshot
  onSnapshot(snap)
  await reapLingeringCliProcessGroup(proc, isClosed, {
    naturalExitGraceMs: 0,
    termGraceMs: Math.max(20, opts?.termGraceMs ?? 800),
    killGraceMs: Math.max(20, opts?.killGraceMs ?? 400),
    snapshot: snap,
  })
}

export function dispatchAntigravitySwarmStallAlert(args: {
  brainDir: string
  conversationId: string
  sessionKey: string
  alert: SwarmStallAlert
  isAborted: () => boolean
  getWatcher: () => AntigravitySwarmWatcher | null
  log: {
    info: (msg: string, fields?: Record<string, unknown>) => void
    warn: (msg: string, fields?: Record<string, unknown>) => void
  }
}): void {
  if (args.isAborted()) return
  void injectSwarmDirective({
    brainDir: args.brainDir,
    conversationId: args.conversationId,
    target: args.alert.target,
    message: args.alert.message,
    channel: args.alert.channel,
    sender: GATEWAY_STALL_MONITOR_AGENT,
    controlKind: 'stall',
    shouldAbort: args.isAborted,
  })
    .then((res) => {
      if (args.isAborted()) return
      if (res.ok) {
        args.log.info('antigravity_swarm_stall_alert', {
          sessionKey: args.sessionKey,
          conversationId: args.conversationId,
          target: args.alert.target,
          reason: args.alert.reason,
          attempt: args.alert.attempt,
          idleMs: args.alert.idleMs,
          seq: res.seq,
        })
        args.getWatcher()?.kick()
      } else if (res.code !== 'ABORTED') {
        args.getWatcher()?.rollbackStallAlert(args.alert)
        args.log.warn('antigravity_swarm_stall_alert_failed', {
          sessionKey: args.sessionKey,
          conversationId: args.conversationId,
          target: args.alert.target,
          reason: args.alert.reason,
          code: res.code,
          error: res.error,
        })
      }
    })
    .catch((err) => {
      if (args.isAborted()) return
      args.getWatcher()?.rollbackStallAlert(args.alert)
      args.log.warn('antigravity_swarm_stall_alert_failed', {
        sessionKey: args.sessionKey,
        conversationId: args.conversationId,
        target: args.alert.target,
        reason: args.alert.reason,
        error: String((err as Error)?.message ?? err),
      })
    })
}

export function buildAntigravitySwarmTerminalToolEntry(args: {
  swarmBlockId: string
  finalSwarm: SwarmSnapshot
  phase: SwarmPhase
  turnStartedAt: number
  eventOrdinal: number | undefined
}): TurnToolEntry {
  const durableInput = buildDurableSwarmBoardInput(args.finalSwarm)
  const swarmSummary = formatSwarmWorkingDetail(args.finalSwarm)
  const swarmStartedAt = args.finalSwarm.startedAt ?? args.turnStartedAt
  return {
    toolUseId: args.swarmBlockId,
    blockId: args.swarmBlockId,
    toolName: SWARM_BOARD_TOOL_NAME,
    inputJson: durableInput,
    inputPreview: durableInput.title.slice(0, 500),
    output: swarmSummary,
    completed: true,
    isError: args.phase === 'error',
    durationMs: Math.max(0, Date.now() - swarmStartedAt),
    ts: Date.now(),
    arrivedAt: swarmStartedAt,
    eventOrdinal: args.eventOrdinal,
  }
}

export function buildAntigravityTurnBillingPair(args: {
  requestId: string
  sessionKey: string
  turnKey?: string
  parentTurnKey?: string
  parentSessionId?: string
  delegateAgentId?: string
  isError: boolean
  interrupted: boolean
  interruptReason: 'user' | 'system' | null
  errorDetail: string | null
  isAuthError: boolean
  isBudgetExhausted: boolean
  isQuotaError: boolean
  durationMs: number
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
  }
}): { external: EngineExternalBillingEvent; durable: EngineBillingEvent } {
  const budgetStop = args.isError && !args.interrupted && args.isBudgetExhausted
  const cls =
    !args.isError || args.interrupted || budgetStop
      ? null
      : args.isAuthError
        ? ('auth' as const)
        : args.isQuotaError
          ? ('quota' as const)
          : null
  const status: EngineExternalBillingEvent['status'] =
    budgetStop || !args.isError ? 'success' : cls ? 'unavailable' : 'error'
  const terminalCode: EngineExternalBillingEvent['terminalCode'] =
    budgetStop || !args.isError
      ? undefined
      : args.interruptReason === 'user'
        ? 'USER_CANCELLED'
        : cls === 'auth'
          ? 'AUTH_UNAVAILABLE'
          : cls === 'quota'
            ? 'QUOTA_UNAVAILABLE'
            : 'ENGINE_ERROR'
  const external: EngineExternalBillingEvent = {
    requestId: args.requestId,
    engine: 'antigravity',
    status,
    durationMs: args.durationMs,
    ...(terminalCode ? { terminalCode } : {}),
  }
  const durable = buildAntigravityDurableBillingEvent({
    requestId: args.requestId,
    sessionKey: args.sessionKey,
    turnKey: args.turnKey,
    parentTurnKey: args.parentTurnKey,
    parentSessionId: args.parentSessionId,
    delegateAgentId: args.delegateAgentId,
    status,
    terminalCode,
    interrupted: args.interrupted,
    budgetStop,
    durationMs: args.durationMs,
    usage: args.usage,
  })
  return { external, durable }
}

export function applyRemoteSwarmMcpEnvToProfile(args: {
  sessionKey: string
  env: NodeJS.ProcessEnv
  mcpConfigPath: string | undefined
  promptOnly?: boolean
}): NodeJS.ProcessEnv {
  const swarmCtx = lookupRemoteSwarmMcpContext(args.sessionKey)
  const swarmEnv: Record<string, string> = swarmCtx
    ? {
        OPENCLAUDE_REMOTE_SWARM_ENABLED: '1',
        OPENCLAUDE_REMOTE_SWARM_SESSION_KEY: swarmCtx.coordinatorSessionKey,
        OPENCLAUDE_REMOTE_SWARM_MEMBER: swarmCtx.memberName,
        OPENCLAUDE_REMOTE_SWARM_TOKEN: swarmCtx.callerToken,
      }
    : {}
  const mergedEnv: NodeJS.ProcessEnv = { ...args.env, ...swarmEnv }
  if (!args.promptOnly && swarmCtx && args.mcpConfigPath && existsSync(args.mcpConfigPath)) {
    try {
      const rawCfg = JSON.parse(readFileSync(args.mcpConfigPath, 'utf8')) as {
        mcpServers?: Record<string, { env?: Record<string, string> }>
      }
      if (rawCfg?.mcpServers?.['openclaude-memory']) {
        rawCfg.mcpServers['openclaude-memory'].env = {
          ...(rawCfg.mcpServers['openclaude-memory'].env ?? {}),
          ...swarmEnv,
        }
        writeFileSync(args.mcpConfigPath, JSON.stringify(rawCfg, null, 2), { mode: 0o600 })
      }
    } catch {
      /* keep original mcp config if unreadable */
    }
  }
  return mergedEnv
}
