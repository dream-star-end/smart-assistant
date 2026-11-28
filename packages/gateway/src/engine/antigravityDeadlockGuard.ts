/**
 * Antigravity swarm deadlock guard, route heartbeat state machine, closed-turn
 * orphan reaper, and adapter swarm-lifecycle helpers (OCV5-923).
 *
 * Pure L2 engine helper: cross-layer dependencies (`renewAntigravityRouteLeaseDetailed`,
 * `injectSwarmDirective`, `lookupRemoteSwarmMcpContext`) are injected via callbacks from
 * `AntigravityAdapter` so zero upward edges originate here.
 */
import type { ChildProcess } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import {
  isParsedProcAlive,
  parseProcStatFull,
  SWARM_BOARD_TOOL_NAME,
  type SwarmPhase,
  type SwarmSnapshot,
} from '@openclaude/protocol'
import type { AntigravityRouteRenewResult } from '../delegateAntigravityRoute.js'
import {
  snapshotDescendantProcessGroupsAsync,
  type ProcessTreeSnapshot,
} from '../processGroupShutdown.js'
import type { EngineBillingEvent, EngineExternalBillingEvent, TurnToolEntry } from './engineEvents.js'
import {
  buildAntigravityDurableBillingEvent,
  hasAnyTrackedProcessGroupAlive,
  probeRouteLease,
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

export async function probeAntigravityRouteHeartbeat(
  routeToken: string,
  defaultRenew: (routeToken: string) => Promise<AntigravityRouteRenewResult>,
  testHook?: (routeToken: string) => Promise<boolean | AntigravityRouteRenewResult>,
): Promise<AntigravityRouteRenewResult> {
  if (testHook) {
    return probeRouteLease(() => testHook(routeToken))
  }
  return defaultRenew(routeToken)
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

export function reapClosedTurnLingeringProcessGroup(
  proc: ChildProcess | null,
  snapshot?: ProcessTreeSnapshot | null,
  opts?: { termGraceMs?: number; killGraceMs?: number; turnReapTag?: string },
): Promise<boolean> {
  if (!proc) return Promise.resolve(true)
  if (!opts?.turnReapTag && !hasAnyTrackedProcessGroupAlive(proc.pid, snapshot)) {
    return Promise.resolve(true)
  }
  return reapLingeringCliProcessGroup(proc, () => true, {
    naturalExitGraceMs: 0,
    termGraceMs: opts?.termGraceMs ?? 300,
    killGraceMs: opts?.killGraceMs ?? 300,
    snapshot,
    ...(opts?.turnReapTag ? { treeOpts: { turnReapTag: opts.turnReapTag } } : {}),
  })
}

export interface SeedProcessIdentityDeps {
  platform?: NodeJS.Platform
  readStat?: (pid: number) => Promise<string | null>
  readEnviron?: (pid: number) => Promise<string | null>
}

function isChildProcessUnreaped(proc: Pick<ChildProcess, 'exitCode' | 'signalCode'>): boolean {
  return proc.exitCode === null && proc.signalCode === null
}

function rawEnvironMatchesTurnTag(rawEnviron: string | null, turnReapTag: string): boolean {
  if (!rawEnviron) return false
  return rawEnviron.split('\0').includes(`OPENCLAUDE_TURN_REAP_TAG=${turnReapTag}`)
}

async function verifyTurnTagUnchangedDuringProbe(
  proc: Pick<ChildProcess, 'exitCode' | 'signalCode'>,
  pid: number,
  expectedStartTicks: number,
  turnReapTag: string,
  readStat: (pid: number) => Promise<string | null>,
  readEnviron: (pid: number) => Promise<string | null>,
): Promise<boolean> {
  const envRaw = await readEnviron(pid)
  if (!isChildProcessUnreaped(proc) || !rawEnvironMatchesTurnTag(envRaw, turnReapTag)) return false
  const statAfterRaw = await readStat(pid)
  const statAfter = statAfterRaw ? parseProcStatFull(statAfterRaw) : null
  return (
    isChildProcessUnreaped(proc) &&
    isParsedProcAlive(statAfter) &&
    statAfter.startTimeTicks === expectedStartTicks
  )
}

export async function probeSpawnedTurnProcessIdentity(
  proc: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>,
  turnReapTag: string | undefined,
  deps?: SeedProcessIdentityDeps,
): Promise<ProcessTreeSnapshot | null> {
  const pid = proc.pid
  const platform = deps?.platform ?? process.platform
  if (platform !== 'linux' || typeof pid !== 'number' || pid <= 1 || !isChildProcessUnreaped(proc)) {
    return null
  }
  const readStat = deps?.readStat ?? ((p: number) => readFile(`/proc/${p}/stat`, 'utf8').catch(() => null))
  const readEnviron = deps?.readEnviron ?? ((p: number) => readFile(`/proc/${p}/environ`, 'utf8').catch(() => null))

  const statBeforeRaw = await readStat(pid)
  const statBefore = statBeforeRaw ? parseProcStatFull(statBeforeRaw) : null
  if (!isChildProcessUnreaped(proc) || !isParsedProcAlive(statBefore) || statBefore.pgrp !== pid) {
    return null
  }
  if (
    turnReapTag &&
    !(await verifyTurnTagUnchangedDuringProbe(proc, pid, statBefore.startTimeTicks, turnReapTag, readStat, readEnviron))
  ) {
    return null
  }
  const tagFields = turnReapTag ? { turnReapTag } : {}
  return {
    rootPid: pid,
    rootIdentity: {
      pgid: pid,
      minStartTicks: statBefore.startTimeTicks,
      memberStartTicks: [[pid, statBefore.startTimeTicks]],
      ...(turnReapTag ? { turnReapTag, provenByTurnTag: true } : {}),
    },
    rootAlive: true,
    ...tagFields,
    descendantPgids: [],
    descendantGroups: [],
    descendantPids: [],
  }
}

export function seedSpawnedTurnProcessIdentity(
  proc: ChildProcess,
  turnReapTag: string | undefined,
  onSeeded: (snap: ProcessTreeSnapshot) => void,
  deps?: SeedProcessIdentityDeps,
): void {
  void probeSpawnedTurnProcessIdentity(proc, turnReapTag, deps)
    .then((snap) => {
      if (snap && isChildProcessUnreaped(proc)) onSeeded(snap)
    })
    .catch((err) => {
      void err
    })
}

export async function captureProcessTreeSnapshotAsync(
  proc: ChildProcess | null,
  prevSnapshot: ProcessTreeSnapshot | null,
  turnReapTag?: string,
): Promise<ProcessTreeSnapshot | null> {
  const pid = proc?.pid
  if (typeof pid !== 'number' || pid <= 1) return prevSnapshot
  return snapshotDescendantProcessGroupsAsync(pid, {
    prevSnapshot,
    ...(turnReapTag ? { turnReapTag } : {}),
  })
}

export async function awaitPendingTurnSettlement(state: {
  settling: boolean
  settlingDone: Promise<void> | null
  interruptSnapDone?: Promise<void> | null
  deadlockReapDone: Promise<void> | null
}): Promise<void> {
  if (state.interruptSnapDone) await state.interruptSnapDone
  if (state.settling && state.settlingDone) await state.settlingDone
  if (state.deadlockReapDone) await state.deadlockReapDone
}

export function scheduleAbnormalExitProcessTreeReap(args: {
  proc: ChildProcess
  isClosed: () => boolean
  getSnapshot: () => ProcessTreeSnapshot | null
  setSnapshot: (snap: ProcessTreeSnapshot | null) => void
  getReapPromise: () => Promise<void> | null
  setReapPromise: (p: Promise<void>) => void
  turnReapTag?: string
  naturalExitGraceMs?: number
  termGraceMs?: number
  killGraceMs?: number
}): void {
  if (args.getReapPromise()) return
  const reapPromise = (async () => {
    const merged = await captureProcessTreeSnapshotAsync(
      args.proc,
      args.getSnapshot(),
      args.turnReapTag,
    )
    args.setSnapshot(merged)
    if (args.isClosed() && !hasAnyTrackedProcessGroupAlive(args.proc.pid, merged)) return
    await reapLingeringCliProcessGroup(args.proc, args.isClosed, {
      naturalExitGraceMs: args.naturalExitGraceMs ?? 20,
      termGraceMs: Math.max(20, args.termGraceMs ?? 300),
      killGraceMs: Math.max(20, args.killGraceMs ?? 300),
      snapshot: merged,
      ...(args.turnReapTag ? { treeOpts: { turnReapTag: args.turnReapTag } } : {}),
    })
  })().catch((err) => {
    void err
  })
  args.setReapPromise(reapPromise)
}

export async function reapDeadlockedSwarmProcess(
  proc: ChildProcess | null,
  isClosed: () => boolean,
  prevSnapshot: ProcessTreeSnapshot | null,
  onSnapshot: (snap: ProcessTreeSnapshot | null) => void,
  opts?: { termGraceMs?: number; killGraceMs?: number; turnReapTag?: string },
): Promise<void> {
  if (!proc) return
  const snap = await captureProcessTreeSnapshotAsync(proc, prevSnapshot, opts?.turnReapTag)
  onSnapshot(snap)
  await reapLingeringCliProcessGroup(proc, isClosed, {
    naturalExitGraceMs: 0,
    termGraceMs: Math.max(20, opts?.termGraceMs ?? 800),
    killGraceMs: Math.max(20, opts?.killGraceMs ?? 400),
    snapshot: snap,
    ...(opts?.turnReapTag ? { treeOpts: { turnReapTag: opts.turnReapTag } } : {}),
  })
}

export interface SwarmDirectiveInjectResult {
  readonly ok: boolean
  readonly seq?: number
  readonly code?: string
  readonly error?: string
}

export function dispatchAntigravitySwarmStallAlert(args: {
  brainDir: string
  conversationId: string
  sessionKey: string
  alert: SwarmStallAlert
  isAborted: () => boolean
  getWatcher: () => AntigravitySwarmWatcher | null
  injectDirective: (input: {
    brainDir: string
    conversationId: string
    target: string
    message: string
    channel: string
    sender: string
    controlKind: 'stall'
    shouldAbort: () => boolean
  }) => Promise<SwarmDirectiveInjectResult>
  log: {
    info: (msg: string, fields?: Record<string, unknown>) => void
    warn: (msg: string, fields?: Record<string, unknown>) => void
  }
}): void {
  if (args.isAborted()) return
  void args
    .injectDirective({
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

export async function applyRemoteSwarmMcpEnvToProfile(args: {
  swarmCtx: {
    coordinatorSessionKey: string
    memberName: string
    callerToken: string
  } | null | undefined
  env: NodeJS.ProcessEnv
  mcpConfigPath: string | undefined
  promptOnly?: boolean
}): Promise<NodeJS.ProcessEnv> {
  const swarmCtx = args.swarmCtx
  const swarmEnv: Record<string, string> = swarmCtx
    ? {
        OPENCLAUDE_REMOTE_SWARM_ENABLED: '1',
        OPENCLAUDE_REMOTE_SWARM_SESSION_KEY: swarmCtx.coordinatorSessionKey,
        OPENCLAUDE_REMOTE_SWARM_MEMBER: swarmCtx.memberName,
        OPENCLAUDE_REMOTE_SWARM_TOKEN: swarmCtx.callerToken,
      }
    : {}
  const mergedEnv: NodeJS.ProcessEnv = { ...args.env, ...swarmEnv }
  if (!args.promptOnly && swarmCtx && args.mcpConfigPath) {
    try {
      const rawText = await readFile(args.mcpConfigPath, 'utf8')
      const rawCfg = JSON.parse(rawText) as {
        mcpServers?: Record<string, { env?: Record<string, string> }>
      }
      if (rawCfg?.mcpServers?.['openclaude-memory']) {
        rawCfg.mcpServers['openclaude-memory'].env = {
          ...(rawCfg.mcpServers['openclaude-memory'].env ?? {}),
          ...swarmEnv,
        }
        await writeFile(args.mcpConfigPath, JSON.stringify(rawCfg, null, 2), { mode: 0o600 })
      }
    } catch (err) {
      void err
    }
  }
  return mergedEnv
}
