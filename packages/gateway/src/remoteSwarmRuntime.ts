/**
 * Container-side Remote Swarm Runtime for remote Antigravity (`remote-driver-v4`) sessions (OCV5-835).
 *
 * Why this lives in the container gateway instead of on the remote VPS:
 *   1. Official Antigravity CLI built-in swarm workers do NOT receive MCP tools (`ocbridge`),
 *      while remote VPS nodes forbid native host tools — so remote-CLI workers have zero hands.
 *   2. Running Swarm orchestration in the container gateway while executing each worker's LLM
 *      turns via Master's verified `remote-driver-v4` lane gives 100% feature parity with local
 *      Antigravity Swarm:
 *        - Full local workspace tools (`Bash`/`Read`/`Edit`/`Write`/`Grep`/`Glob`/MCP) per worker
 *        - Real local git worktree isolation (`workspace: "share" | "branch"`)
 *        - Identical on-disk layout (`members.json`, `board.jsonl`, `<conv>/transcript.jsonl`) so
 *          `AntigravitySwarmWatcher` & `swarmCommand.ts` (live SwarmBoard UI, delta frames,
 *          telemetry, human steer, honest `[control:kill]`, playbooks) work seamlessly
 *        - Full Master-side billing & audit via `remoteDriverTurnBilling`
 *        - Bounded concurrency semaphore (default 3 parallel workers) protecting remote node lane caps
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { extractSwarmMentions } from '@openclaude/protocol'
import { antigravityRoot } from './engine/antigravityPlatform.js'
import { GATEWAY_STALL_MONITOR_AGENT } from './engine/swarmStallMonitor.js'
import {
  type BoardPostRecord,
  type RemoteSwarmLocation,
  type RosterChannelRecord,
  type RosterFile,
  type RosterMemberRecord,
  appendBoardLineNoSymlink,
  assertSafeSwarmDir,
  atomicWriteJson,
  ensurePrivateDir,
  formatBoardTimestamp,
  readBoardPostsFromDisk,
  readOrInitRosterStrict,
  readRosterStrict,
  withAsyncSwarmFileLock,
  withSwarmFileLockNonBlocking,
} from './remoteSwarmLocks.js'
import {
  reconcileRemoteSwarmOnBoot,
  removeWorkerGitWorktree,
} from './remoteSwarmReconcile.js'
import {
  DEFAULT_READ_BOARD_MAX_BYTES,
  MAX_READ_BOARD_MAX_BYTES,
  MAX_SWARM_POST_CHARS,
  type RemoteSwarmToolHost,
  executePostMessageTool,
  executeReadBoardTool,
  executeSwarmAddAction,
  executeSwarmChannelAction,
  executeSwarmStatusAction,
} from './remoteSwarmTools.js'

export type {
  BoardPostRecord,
  RemoteSwarmLocation,
  RosterChannelRecord,
  RosterFile,
  RosterMemberRecord,
}
export {
  DEFAULT_READ_BOARD_MAX_BYTES,
  MAX_READ_BOARD_MAX_BYTES,
  MAX_SWARM_POST_CHARS,
  reconcileRemoteSwarmOnBoot,
}

const DEFAULT_MAX_PARALLEL_WORKERS = 3
/** Staggered away from SwarmStallMonitor's 180s quiet threshold (P1-4). */
export const DEFAULT_WAIT_TIMEOUT_MS = 240_000
const MAX_WAIT_TIMEOUT_MS = 300_000
const DEFAULT_CALLER_TOKEN_TTL_MS = 12 * 60 * 60_000

export interface RemoteSwarmMcpContext {
  readonly coordinatorSessionKey: string
  readonly memberName: string
  readonly callerToken: string
}

/** Process-local registry binding active coordinator & worker sessions to their
 *  HMAC-signed RemoteSwarm caller tokens for MCP subprocess env injection. */
const activeMcpContexts = new Map<string, RemoteSwarmMcpContext>()
const activeRuntimeBySession = new Map<string, RemoteSwarmRuntime>()
let defaultRuntimeFactory: (() => RemoteSwarmRuntime) | null = null

export function setDefaultRemoteSwarmRuntimeFactory(
  factory: (() => RemoteSwarmRuntime) | null,
): void {
  defaultRuntimeFactory = factory
}

export function resolveDefaultRemoteSwarmRuntime(): RemoteSwarmRuntime | null {
  return defaultRuntimeFactory ? defaultRuntimeFactory() : null
}

export function lookupRemoteSwarmMcpContext(sessionKey: string): RemoteSwarmMcpContext | undefined {
  return activeMcpContexts.get(sessionKey.trim())
}

/**
 * Revoke the coordinator's MCP swarm context when the user turns OFF the Swarm
 * toggle on a follow-up turn (OCV5-842). Leaves worker MCP contexts and session
 * state intact so existing SwarmBoard views and later re-enabling still work.
 */
export function disableRemoteSwarmCoordinatorMcp(sessionKey: string): void {
  const key = sessionKey.trim()
  const existing = activeMcpContexts.get(key)
  if (existing && existing.memberName === 'coordinator') {
    activeMcpContexts.delete(key)
  }
}

export function lookupRemoteSwarmRuntimeForSession(
  sessionKey: string,
): RemoteSwarmRuntime | undefined {
  return activeRuntimeBySession.get(sessionKey.trim())
}

export interface RemoteSwarmWorkerTurnInput {
  readonly coordinatorSessionKey: string
  readonly workerSessionKey: string
  readonly workerName: string
  readonly workerTurnSeq: number
  readonly workerTurnNonce: string
  readonly workerConversationId: string
  readonly parentAgentId: string
  readonly allowedToolsets?: readonly string[]
  readonly callerToken: string
  readonly model: string
  readonly effort?: string
  readonly workspaceCwd: string
  readonly prompt: string
  readonly signal: AbortSignal
  readonly onTelemetry: (step: RemoteSwarmTelemetryEvent) => void
}

export interface RemoteSwarmTelemetryEvent {
  readonly type: 'USER_INPUT' | 'PLANNER_RESPONSE' | 'TOOL_CALL' | 'ERROR'
  readonly status: 'ACTIVE' | 'DONE' | 'ERROR'
  readonly toolName?: string
  readonly toolArgs?: Record<string, unknown>
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly thinkingTokens?: number
  readonly error?: string
}

export interface RemoteSwarmWorkerTurnResult {
  readonly text: string
  readonly error?: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly thinkingTokens?: number
}

export interface RemoteSwarmWorkerExecutor {
  runWorkerTurn(input: RemoteSwarmWorkerTurnInput): Promise<RemoteSwarmWorkerTurnResult>
  releaseWorkerSession(
    workerSessionKey: string,
  ): Promise<{ released: boolean; state: string } | void>
}

interface WaiterEntry {
  readonly memberName: string
  readonly since: number
  readonly mentionsOnly: boolean
  readonly channel?: string
  readonly resolve: (result: {
    woke: boolean
    posts: BoardPostRecord[]
    headSeq: number
    reason: string
  }) => void
  readonly timer: NodeJS.Timeout
}

interface WorkerRuntimeState {
  readonly name: string
  readonly sessionSlug: string
  workerSessionKey: string
  turnSeq: number
  running: boolean
  pendingWake: boolean
  runGeneration: number
  abortController: AbortController | null
  runPromise: Promise<void> | null
  stepCounter: number
  lastKnownConvId?: string
}

interface SwarmSessionState {
  readonly sessionKey: string
  readonly location: RemoteSwarmLocation
  model: string
  effort?: string
  workspaceCwd: string
  parentAgentId: string
  allowedToolsets?: readonly string[]
  readonly workers: Map<string, WorkerRuntimeState>
  readonly waiters: Set<WaiterEntry>
  shuttingDown: boolean
  interruptGeneration: number
  boardSeqKnown: number
  coordinatorStepCounter: number
}

export function deterministicSwarmUuid(seed: string): string {
  const hex = createHash('sha256').update(`remote-swarm-v1:${seed}`, 'utf8').digest('hex')
  const p1 = hex.slice(0, 8)
  const p2 = hex.slice(8, 12)
  const p3 = `4${hex.slice(13, 16)}`
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')
  const p4 = `${variant}${hex.slice(18, 20)}`
  const p5 = hex.slice(20, 32)
  return `${p1}-${p2}-${p3}-${p4}-${p5}`
}

export function remoteSwarmLocationForSession(
  sessionKey: string,
  rootBase: string = antigravityRoot(),
): RemoteSwarmLocation {
  const slot = `s-${createHash('sha256').update(sessionKey.trim(), 'utf8').digest('hex').slice(0, 16)}`
  const brainDir = join(rootBase, 'remote-swarm', slot, 'brain')
  const swarmId = deterministicSwarmUuid(sessionKey.trim())
  const swarmDir = join(brainDir, swarmId, '.system_generated', 'swarm')
  return { brainDir, swarmId, swarmDir }
}

function trustedStallAlertTarget(post: BoardPostRecord): string | null {
  if (
    post.agent === GATEWAY_STALL_MONITOR_AGENT &&
    post.kind === 'control' &&
    post.control?.kind === 'stall' &&
    typeof post.control.target === 'string'
  ) {
    const clean = post.control.target.trim().toLowerCase()
    if (clean && clean !== 'all') return clean
  }
  return null
}

function memberMatchesMention(
  memberName: string,
  mention: string,
  memberChannels: string[],
  postChannel: string,
): boolean {
  const m = mention.toLowerCase()
  const lower = memberName.toLowerCase()
  if (m === 'all') return true
  if (m === lower) return true
  if (lower.startsWith(`${m}-`) && /^\d+$/.test(lower.slice(m.length + 1))) return true
  if (m.startsWith('#')) {
    const ch = m.slice(1)
    if (ch && ch !== 'main' && memberChannels.includes(ch)) return true
  }
  void postChannel
  return false
}

function isAbortInterruptReason(signal: AbortSignal): boolean {
  const r = signal.reason
  const msg = r instanceof Error ? r.message : typeof r === 'string' ? r : ''
  return msg.startsWith('SWARM_INTERRUPTED:')
}

export class RemoteSwarmRuntime {
  private readonly sessions = new Map<string, SwarmSessionState>()
  private readonly maxParallelWorkers: number
  private readonly rootBase: string
  private readonly hmacSecret: Buffer
  private activeWorkerSlots = 0
  private readonly slotQueue: Array<() => void> = []
  private executor?: RemoteSwarmWorkerExecutor

  constructor(opts?: {
    rootBase?: string
    maxParallelWorkers?: number
    executor?: RemoteSwarmWorkerExecutor
    hmacSecret?: Buffer
  }) {
    this.rootBase = opts?.rootBase ?? antigravityRoot()
    const envCap = Number.parseInt(process.env.OC_REMOTE_SWARM_MAX_WORKERS ?? '', 10)
    const configured =
      opts?.maxParallelWorkers ?? (Number.isFinite(envCap) ? envCap : DEFAULT_MAX_PARALLEL_WORKERS)
    this.maxParallelWorkers = Math.max(1, Math.min(4, configured))
    this.executor = opts?.executor
    this.hmacSecret = opts?.hmacSecret ?? randomBytes(32)
  }

  /** Mint an HMAC-signed caller token strictly binding (sessionKey, memberName, expiresAt). */
  mintCallerToken(
    sessionKey: string,
    memberName: string,
    ttlMs: number = DEFAULT_CALLER_TOKEN_TTL_MS,
  ): string {
    const cleanSession = sessionKey.trim()
    const cleanMember = memberName.trim().toLowerCase()
    const exp = Date.now() + Math.max(1_000, Math.floor(ttlMs))
    const payload = Buffer.from(`${cleanSession}\n${cleanMember}\n${exp}`, 'utf8').toString(
      'base64url',
    )
    const sig = createHmac('sha256', this.hmacSecret).update(payload, 'utf8').digest('base64url')
    return `rsw1.${payload}.${sig}`
  }

  /**
   * Verify a caller token against the claimed sessionKey and memberName (constant-time)
   * AND verify the session/member turn is currently live (B4: token is revoked immediately
   * when the member's turn finishes, the member is killed, or the session shuts down).
   */
  verifyCallerToken(
    token: string | undefined,
    expectedSessionKey: string,
    expectedMemberName: string,
    now: number = Date.now(),
  ): boolean {
    if (typeof token !== 'string' || !token.startsWith('rsw1.')) return false
    const parts = token.split('.')
    if (parts.length !== 3) return false
    const [, payloadB64, sigB64] = parts
    if (!payloadB64 || !sigB64) return false
    const expectedSig = createHmac('sha256', this.hmacSecret)
      .update(payloadB64, 'utf8')
      .digest('base64url')
    const sigBuf = Buffer.from(sigB64, 'utf8')
    const expBuf = Buffer.from(expectedSig, 'utf8')
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return false
    let decoded: string
    try {
      decoded = Buffer.from(payloadB64, 'base64url').toString('utf8')
    } catch {
      return false
    }
    const lines = decoded.split('\n')
    if (lines.length !== 3) return false
    const [tokSession, tokMember, expStr] = lines
    const exp = Number.parseInt(expStr ?? '', 10)
    if (!Number.isFinite(exp) || exp <= now) return false
    const cleanSession = expectedSessionKey.trim()
    const cleanMember = expectedMemberName.trim().toLowerCase()
    if (tokSession !== cleanSession || tokMember !== cleanMember) return false

    const state = this.sessions.get(cleanSession)
    if (!state || state.shuttingDown) return false
    if (cleanMember === 'coordinator') {
      return activeMcpContexts.get(cleanSession)?.callerToken === token
    }
    const rt = state.workers.get(cleanMember)
    if (!rt || !rt.running) return false
    let roster: RosterFile | null = null
    try {
      roster = readRosterStrict(state.location)
    } catch {
      return false
    }
    const memberRec = roster?.members[cleanMember]
    if (!memberRec || memberRec.killed) return false
    return activeMcpContexts.get(rt.workerSessionKey)?.callerToken === token
  }

  setExecutor(executor: RemoteSwarmWorkerExecutor): void {
    this.executor = executor
  }

  locationFor(sessionKey: string): RemoteSwarmLocation {
    return remoteSwarmLocationForSession(sessionKey, this.rootBase)
  }

  /** Register/update coordinator metadata for an active remote Antigravity session. */
  registerSession(input: {
    sessionKey: string
    model: string
    effort?: string
    workspaceCwd: string
    parentAgentId?: string
    allowedToolsets?: readonly string[]
  }): SwarmSessionState {
    const key = input.sessionKey.trim()
    const inferredAgent = /^agent:([A-Za-z0-9_-]{1,64}):/.exec(key)?.[1] ?? 'main'
    const parentAgentId = (input.parentAgentId ?? inferredAgent).trim() || 'main'
    let state = this.sessions.get(key)
    if (!state) {
      const location = this.locationFor(key)
      state = {
        sessionKey: key,
        location,
        model: input.model,
        effort: input.effort,
        workspaceCwd: input.workspaceCwd,
        parentAgentId,
        allowedToolsets: input.allowedToolsets ? [...input.allowedToolsets] : undefined,
        workers: new Map(),
        waiters: new Set(),
        shuttingDown: false,
        interruptGeneration: 0,
        boardSeqKnown: 0,
        coordinatorStepCounter: 0,
      }
      this.sessions.set(key, state)
    } else {
      state.model = input.model
      if (input.effort !== undefined) state.effort = input.effort
      if (input.workspaceCwd) state.workspaceCwd = input.workspaceCwd
      if (input.parentAgentId) state.parentAgentId = parentAgentId
      if (input.allowedToolsets !== undefined) state.allowedToolsets = [...input.allowedToolsets]
      state.shuttingDown = false
    }
    const existingCtx = activeMcpContexts.get(key)
    const reuseExisting =
      existingCtx !== undefined &&
      existingCtx.memberName === 'coordinator' &&
      this.verifyCallerToken(existingCtx.callerToken, key, 'coordinator', Date.now() + 60 * 60_000)
    if (!reuseExisting) {
      activeMcpContexts.set(key, {
        coordinatorSessionKey: key,
        memberName: 'coordinator',
        callerToken: this.mintCallerToken(key, 'coordinator'),
      })
    }
    activeRuntimeBySession.set(key, this)
    return state
  }

  /**
   * Lazily hydrate an in-memory control handle for an existing on-disk remote swarm
   * (e.g., after a gateway restart) WITHOUT minting coordinator MCP tokens (P2-1).
   * Returns `null` fail-closed if no valid `members.json` exists on disk.
   */
  hydrateSessionFromDisk(input: {
    sessionKey: string
    workspaceCwd?: string
    model?: string
    parentAgentId?: string
  }): SwarmSessionState | null {
    const key = input.sessionKey.trim()
    if (!key) return null
    const existing = this.sessions.get(key)
    if (existing && !existing.shuttingDown) {
      activeRuntimeBySession.set(key, this)
      return existing
    }
    const location = this.locationFor(key)
    let roster: RosterFile | null = null
    try {
      assertSafeSwarmDir(location)
      roster = readRosterStrict(location)
    } catch {
      return null
    }
    if (!roster) return null

    const inferredAgent = /^agent:([A-Za-z0-9_-]{1,64}):/.exec(key)?.[1] ?? 'main'
    const parentAgentId = (input.parentAgentId ?? inferredAgent).trim() || 'main'
    const resolvedModel =
      input.model?.trim() || roster.members.coordinator?.model?.trim() || 'antigravity-gemini-4-neon-remote'
    const resolvedCwd = input.workspaceCwd?.trim() || roster.workspace_cwd?.trim() || process.cwd()

    let headSeq = 0
    try {
      const posts = readBoardPostsFromDisk(location.swarmDir)
      headSeq = posts.reduce((m, p) => Math.max(m, p.seq), 0)
    } catch {
      headSeq = 0
    }

    const state: SwarmSessionState = {
      sessionKey: key,
      location,
      model: resolvedModel,
      workspaceCwd: resolvedCwd,
      parentAgentId,
      workers: new Map(),
      waiters: new Set(),
      shuttingDown: false,
      interruptGeneration: 0,
      boardSeqKnown: headSeq,
      coordinatorStepCounter: 0,
    }
    this.sessions.set(key, state)
    activeRuntimeBySession.set(key, this)
    return state
  }

  disableCoordinatorMcp(sessionKey: string): void {
    disableRemoteSwarmCoordinatorMcp(sessionKey)
  }

  getActiveSwarmLocation(sessionKey: string): RemoteSwarmLocation | null {
    const loc = this.locationFor(sessionKey)
    if (existsSync(join(loc.swarmDir, 'members.json'))) {
      return loc
    }
    return null
  }

  /**
   * Serialized per-session roster transaction guarded by in-process Promise queue +
   * `.roster.lock` (P0-3). Fail-closed on corrupt/unreadable/symlink `members.json`;
   * initializes default roster ONLY on `ENOENT`.
   */
  private mutateRoster<T>(
    state: SwarmSessionState,
    fn: (roster: RosterFile) => T,
    opts?: { persist?: boolean },
  ): Promise<T> {
    const persist = opts?.persist !== false
    return withAsyncSwarmFileLock(state.location, '.roster.lock', () => {
      const { roster } = readOrInitRosterStrict(state.location, {
        model: state.model,
        sessionKey: state.sessionKey,
        workspaceCwd: state.workspaceCwd,
      })
      const result = fn(roster)
      if (persist) {
        roster.runtime = 'remote'
        roster.session_key = state.sessionKey
        if (state.workspaceCwd) roster.workspace_cwd = state.workspaceCwd
        atomicWriteJson(join(state.location.swarmDir, 'members.json'), roster)
      }
      return result
    })
  }

  /**
   * Read-only strict roster snapshot (initializes ONLY on `ENOENT` under `.roster.lock`,
   * never silently overwrites corrupt/unreadable `members.json`).
   */
  private readRoster(state: SwarmSessionState): Promise<RosterFile> {
    return this.mutateRoster(state, (roster) => roster, { persist: false })
  }

  private appendTranscriptStep(
    state: SwarmSessionState,
    memberConvId: string,
    stepIndex: number,
    ev: RemoteSwarmTelemetryEvent,
  ): void {
    try {
      const logsDir = join(state.location.brainDir, memberConvId, '.system_generated', 'logs')
      ensurePrivateDir(logsDir)
      const transcriptPath = join(logsDir, 'transcript.jsonl')
      const record: Record<string, unknown> = {
        step_index: stepIndex,
        type: ev.type,
        status: ev.status,
        created_at: new Date().toISOString(),
      }
      if (ev.toolName) {
        record.tool_calls = [{ name: ev.toolName, arguments: ev.toolArgs ?? {} }]
      }
      if (
        ev.inputTokens !== undefined ||
        ev.outputTokens !== undefined ||
        ev.cacheReadTokens !== undefined ||
        ev.thinkingTokens !== undefined
      ) {
        record.usage = {
          input_tokens: Math.max(0, Math.floor(ev.inputTokens ?? 0)),
          output_tokens: Math.max(0, Math.floor(ev.outputTokens ?? 0)),
          ...(ev.cacheReadTokens !== undefined
            ? { cache_read_tokens: Math.max(0, Math.floor(ev.cacheReadTokens)) }
            : {}),
          ...(ev.thinkingTokens !== undefined
            ? { thinking_tokens: Math.max(0, Math.floor(ev.thinkingTokens)) }
            : {}),
        }
      }
      if (ev.error) {
        record.content = ev.error
      }
      appendFileSync(transcriptPath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    } catch {
      // telemetry best-effort
    }
  }

  /** Record a telemetry step into the coordinator's `transcript.jsonl` (P1-3). */
  recordCoordinatorTelemetry(sessionKey: string, ev: RemoteSwarmTelemetryEvent): void {
    const state = this.sessions.get(sessionKey.trim())
    if (!state) return
    state.coordinatorStepCounter += 1
    this.appendTranscriptStep(state, state.location.swarmId, state.coordinatorStepCounter, ev)
  }

  private async appendBoardPost(
    state: SwarmSessionState,
    input: {
      agent: string
      text: string
      channel?: string
      kind?: string
      control?: Record<string, unknown>
      expectedGeneration?: number
    },
  ): Promise<BoardPostRecord | null> {
    const expectedGen = input.expectedGeneration
    const isStaleGeneration = () =>
      expectedGen !== undefined &&
      (state.shuttingDown || state.interruptGeneration !== expectedGen)
    if (isStaleGeneration()) return null
    const channel = (input.channel || 'main').trim() || 'main'
    const writeRes = await withAsyncSwarmFileLock(
      state.location,
      '.board.lock',
      () => {
        // B4: Re-check generation AFTER acquiring `.board.lock` so a Stop arriving while
        // queued on `.board.lock` prevents the stale brief post and worker wake.
        if (isStaleGeneration()) return null
        const existing = readBoardPostsFromDisk(state.location.swarmDir)
        const headSeq = existing.reduce((max, p) => Math.max(max, p.seq), 0)
        const next: BoardPostRecord = {
          seq: headSeq + 1,
          agent: input.agent,
          channel,
          text: input.text,
          time: formatBoardTimestamp(),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.control ? { control: input.control } : {}),
          request_id: randomUUID(),
        }
        appendBoardLineNoSymlink(state.location.swarmDir, `${JSON.stringify(next)}\n`)
        return { post: next, allPosts: [...existing, next] }
      },
    )
    if (!writeRes) return null
    state.boardSeqKnown = Math.max(state.boardSeqKnown, writeRes.post.seq)
    this.notifyAfterBoardPost(state, writeRes.post, writeRes.allPosts, expectedGen)
    return writeRes.post
  }

  /**
   * Cascade-interrupt all active workers and unblock waiters for a session on user Stop
   * or Swarm toggle-off (P0-2). Aborts running workers, clears `pendingWake`, unblocks
   * `waiters`, releases remote lanes, and transitions active workers to `STOPPED`, while
   * strictly preserving `members.json` history and all worktrees (never deletes user work).
   */
  async interruptSessionWorkers(
    sessionKey: string,
    reason = 'user_stop',
    opts?: { stopWaitTimeoutMs?: number },
  ): Promise<{
    interrupted: boolean
    abortedWorkers: string[]
    unblockedWaiters: number
  }> {
    const cleanKey = sessionKey.trim()
    const state = this.sessions.get(cleanKey)
    if (!state) {
      return { interrupted: false, abortedWorkers: [], unblockedWaiters: 0 }
    }

    // B4: Immediately bump interruptGeneration synchronously BEFORE any await so any
    // scheduled worker still in its pre-executor startup window cannot proceed or re-arm.
    state.interruptGeneration += 1

    let unblockedWaiters = 0
    for (const waiter of [...state.waiters]) {
      state.waiters.delete(waiter)
      clearTimeout(waiter.timer)
      unblockedWaiters += 1
      waiter.resolve({
        woke: false,
        posts: [],
        headSeq: state.boardSeqKnown,
        reason,
      })
    }

    const waitMs = Math.max(50, opts?.stopWaitTimeoutMs ?? 3_000)
    const abortedWorkers: string[] = []
    const abortedSet = new Set<string>()
    const activeWaits: Promise<void>[] = []

    for (const rt of state.workers.values()) {
      const wasActive = rt.running || rt.pendingWake || rt.abortController !== null
      rt.pendingWake = false
      activeMcpContexts.delete(rt.workerSessionKey)
      if (wasActive) {
        abortedWorkers.push(rt.name)
        abortedSet.add(rt.name)
      }
      rt.abortController?.abort(new Error(`SWARM_INTERRUPTED:${reason}`))
      if (rt.runPromise) {
        activeWaits.push(
          Promise.race([
            rt.runPromise.catch(() => {}),
            new Promise<void>((r) => setTimeout(r, waitMs).unref?.()),
          ]),
        )
      }
    }
    await Promise.allSettled(activeWaits)

    const releases: Promise<unknown>[] = []
    for (const rt of state.workers.values()) {
      activeMcpContexts.delete(rt.workerSessionKey)
      if (this.executor && (abortedSet.has(rt.name) || rt.turnSeq > 0)) {
        releases.push(this.executor.releaseWorkerSession(rt.workerSessionKey).catch(() => {}))
      }
    }
    await Promise.allSettled(releases)

    if (abortedWorkers.length > 0 || unblockedWaiters > 0) {
      try {
        await this.mutateRoster(state, (roster) => {
          for (const [name, member] of Object.entries(roster.members)) {
            if (name === 'coordinator' || member.killed) continue
            if (abortedSet.has(name) || member.phase === 'RUNNING') {
              member.phase = 'STOPPED'
            }
          }
        })
      } catch {
        // Do not mask interrupt success if roster is unreadable/missing.
      }
    }

    return {
      interrupted: abortedWorkers.length > 0 || unblockedWaiters > 0,
      abortedWorkers,
      unblockedWaiters,
    }
  }

  /**
   * Trusted operator kill channel (wired to `swarmCommand.ts` `executeKill` or authenticated
   * operator HTTP routes). Ordinary board messages NEVER trigger kills — only this explicit
   * structured control entrypoint does. Waits for the target worker to stop, confirms kill,
   * cleans clean worktrees while preserving dirty ones, and posts a structured `control` receipt.
   */
  async executeOperatorKill(
    sessionKey: string,
    targetName: string,
    reason = 'operator_kill',
  ): Promise<{
    ok: boolean
    confirmed: boolean
    killed: string[]
    unconfirmed: string[]
    alreadyKilled: string[]
    notFound: boolean
    preservedDirtyWorktrees: string[]
  }> {
    const state = this.sessions.get(sessionKey.trim())
    if (!state) {
      return {
        ok: false,
        confirmed: false,
        killed: [],
        unconfirmed: [],
        alreadyKilled: [],
        notFound: true,
        preservedDirtyWorktrees: [],
      }
    }
    const res = await this.killMemberInternal(state, targetName, reason)
    const confirmed = !res.notFound && res.unconfirmed.length === 0
    if (!res.notFound && (res.killed.length > 0 || res.unconfirmed.length > 0)) {
      await this.appendBoardPost(state, {
        agent: 'operator',
        channel: 'main',
        kind: 'control',
        control: {
          kind: 'kill',
          target: targetName.trim().toLowerCase(),
          killed: res.killed,
          ...(res.unconfirmed.length > 0 ? { unconfirmed: res.unconfirmed } : {}),
          state: confirmed ? 'confirmed' : 'pending',
          reason,
        },
        text: confirmed
          ? `[control:kill:confirmed] target=${res.killed.join(',')} (${reason})`
          : `[control:kill:pending] target=${res.unconfirmed.join(',')} (${reason})`,
      })
    }
    return { ok: !res.notFound && confirmed, confirmed, ...res }
  }

  /**
   * Trusted operator steer channel: appends an authenticated operator directive to `board.jsonl`
   * and wakes the targeted member(s) without letting untrusted posts trigger destructive actions.
   */
  async executeOperatorSteer(
    sessionKey: string,
    targetName: string,
    directive: string,
    channel = 'main',
  ): Promise<BoardPostRecord> {
    const state = this.sessions.get(sessionKey.trim())
    if (!state) throw new Error('REMOTE_SWARM_SESSION_NOT_REGISTERED')
    const cleanTarget = targetName.trim().toLowerCase()
    if (!cleanTarget) throw new Error('SWARM_MEMBER_NAME_REQUIRED')
    const post = await this.appendBoardPost(state, {
      agent: 'operator',
      channel,
      kind: 'control',
      control: { kind: 'steer', target: cleanTarget },
      text: `@${cleanTarget} ${directive.trim()}`,
    })
    return post!
  }

  /**
   * Trusted gateway stall-monitor channel: appends a deterministic zero-token
   * stall alert to `board.jsonl` and wakes the targeted waiting member or coordinator.
   * Uses non-blocking lock acquire (ZERO busy-wait) so synchronous watcher callbacks
   * never freeze the event loop or emit unhandled rejections.
   */
  postGatewayStallAlert(
    sessionKey: string,
    alert: { target: string; channel?: string; message: string; reason?: string; attempt?: number },
  ): BoardPostRecord | null {
    const state = this.sessions.get(sessionKey.trim())
    if (!state || state.shuttingDown) return null
    const cleanTarget = alert.target.trim().toLowerCase()
    if (!cleanTarget || cleanTarget === 'all') return null
    const { roster } = readOrInitRosterStrict(state.location, {
      model: state.model,
      sessionKey: state.sessionKey,
      workspaceCwd: state.workspaceCwd,
    })
    const targetRec = roster.members[cleanTarget]
    if (cleanTarget !== 'coordinator' && (!targetRec || targetRec.killed)) return null
    const requestedCh = (alert.channel ?? 'main').trim() || 'main'
    const channel = roster.channels[requestedCh]?.archived ? 'main' : requestedCh
    const text = alert.message.trim()
    if (!text) return null

    const { post, allPosts } = withSwarmFileLockNonBlocking(
      state.location,
      '.board.lock',
      () => {
        const existing = readBoardPostsFromDisk(state.location.swarmDir)
        const headSeq = existing.reduce((max, p) => Math.max(max, p.seq), 0)
        const next: BoardPostRecord = {
          seq: headSeq + 1,
          agent: GATEWAY_STALL_MONITOR_AGENT,
          channel,
          text,
          time: formatBoardTimestamp(),
          kind: 'control',
          control: {
            kind: 'stall',
            target: cleanTarget,
            ...(alert.reason ? { reason: alert.reason } : {}),
            ...(alert.attempt !== undefined ? { attempt: alert.attempt } : {}),
          },
          request_id: randomUUID(),
        }
        appendBoardLineNoSymlink(state.location.swarmDir, `${JSON.stringify(next)}\n`)
        return { post: next, allPosts: [...existing, next] }
      },
    )
    state.boardSeqKnown = Math.max(state.boardSeqKnown, post.seq)
    this.notifyAfterBoardPost(state, post, allPosts)
    return post
  }

  /** Called when a trusted external API (e.g. `swarmCommand.ts`) appended to `board.jsonl`. */
  onExternalBoardWrite(sessionKey: string): void {
    const state = this.sessions.get(sessionKey.trim())
    if (!state || state.shuttingDown) return
    const posts = readBoardPostsFromDisk(state.location.swarmDir)
    const fresh = posts.filter((p) => p.seq > state.boardSeqKnown)
    for (const post of fresh) {
      state.boardSeqKnown = Math.max(state.boardSeqKnown, post.seq)
      this.notifyAfterBoardPost(state, post, posts)
    }
  }

  private notifyAfterBoardPost(
    state: SwarmSessionState,
    post: BoardPostRecord,
    preloadedPosts?: BoardPostRecord[],
    expectedGeneration?: number,
  ): void {
    // Ordinary board messages NEVER parse or execute kill directives (BLOCKER 4).
    // Destructive kills go exclusively through `swarm{action:"kill"}` (ownership-checked)
    // or trusted `executeOperatorKill(...)`.
    let roster: RosterFile | null = null
    try {
      roster = readRosterStrict(state.location, {
        defaultModel: state.model,
        sessionKey: state.sessionKey,
        workspaceCwd: state.workspaceCwd,
      })
    } catch {
      return
    }
    if (!roster) return

    const trustedStallTarget = trustedStallAlertTarget(post)
    const mentions = trustedStallTarget ? [trustedStallTarget] : extractSwarmMentions(post.text)

    // 1. Wake matching swarm_wait waiters — reuse preloadedPosts / read disk at most ONCE (P1-4).
    let cachedAllPosts: BoardPostRecord[] | null = preloadedPosts ?? null
    let cachedHeadSeq: number | null =
      preloadedPosts !== undefined
        ? preloadedPosts.reduce((m, p) => Math.max(m, p.seq), post.seq)
        : null

    for (const waiter of [...state.waiters]) {
      if (post.seq <= waiter.since) continue
      if (post.agent.toLowerCase() === waiter.memberName.toLowerCase()) continue
      const memberRec = roster.members[waiter.memberName]
      const memberChannels = memberRec?.channels ?? ['main']
      if (waiter.channel && waiter.channel !== '*' && post.channel !== waiter.channel) continue
      const inChannel =
        waiter.memberName === 'coordinator' ||
        post.channel === 'main' ||
        memberChannels.includes(post.channel)
      const mentioned = trustedStallTarget
        ? waiter.memberName.toLowerCase() === trustedStallTarget
        : mentions.some((m) =>
            memberMatchesMention(waiter.memberName, m, memberChannels, post.channel),
          )
      if (
        trustedStallTarget
          ? mentioned
          : !waiter.mentionsOnly
            ? inChannel || mentioned
            : mentioned
      ) {
        state.waiters.delete(waiter)
        clearTimeout(waiter.timer)
        let delta: BoardPostRecord[]
        let headSeq: number
        if (waiter.since === post.seq - 1 && !cachedAllPosts) {
          delta = [post]
          headSeq = Math.max(state.boardSeqKnown, post.seq)
        } else {
          if (cachedAllPosts === null) {
            cachedAllPosts = readBoardPostsFromDisk(state.location.swarmDir)
          }
          if (cachedHeadSeq === null) {
            cachedHeadSeq = cachedAllPosts.reduce((m, p) => Math.max(m, p.seq), post.seq)
          }
          delta = cachedAllPosts.filter((p) => p.seq > waiter.since)
          headSeq = cachedHeadSeq
        }
        waiter.resolve({
          woke: true,
          posts: delta,
          headSeq,
          reason: 'new_post',
        })
      }
    }

    // 2. Wake matching non-killed workers
    if (
      expectedGeneration !== undefined &&
      (state.shuttingDown || state.interruptGeneration !== expectedGeneration)
    ) {
      return
    }
    for (const [name, member] of Object.entries(roster.members)) {
      if (name === 'coordinator' || member.killed) continue
      if (name.toLowerCase() === post.agent.toLowerCase()) continue
      if (trustedStallTarget) {
        if (name.toLowerCase() === trustedStallTarget) {
          this.scheduleWorkerRun(state, name, expectedGeneration)
        }
        continue
      }
      const mentioned = mentions.some((m) =>
        memberMatchesMention(name, m, member.channels ?? ['main'], post.channel),
      )
      const channelMatch =
        member.wake_mode === 'all' &&
        (post.channel === 'main' || (member.channels ?? ['main']).includes(post.channel))
      if (mentioned || channelMatch) {
        this.scheduleWorkerRun(state, name, expectedGeneration)
      }
    }
  }

  /** Runtime-wide concurrency semaphore shared across ALL coordinator sessions (IMPORTANT 5). */
  private async acquireWorkerSlot(
    state: SwarmSessionState,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted || state.shuttingDown) return false
    if (this.activeWorkerSlots < this.maxParallelWorkers) {
      this.activeWorkerSlots += 1
      return true
    }
    return new Promise<boolean>((resolveSlot) => {
      const wake = () => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted || state.shuttingDown) {
          resolveSlot(false)
          return
        }
        this.activeWorkerSlots += 1
        resolveSlot(true)
      }
      const onAbort = () => {
        const idx = this.slotQueue.indexOf(wake)
        if (idx >= 0) this.slotQueue.splice(idx, 1)
        resolveSlot(false)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.slotQueue.push(wake)
    })
  }

  private releaseWorkerSlot(): void {
    this.activeWorkerSlots = Math.max(0, this.activeWorkerSlots - 1)
    while (this.activeWorkerSlots < this.maxParallelWorkers && this.slotQueue.length > 0) {
      const next = this.slotQueue.shift()
      if (next) next()
    }
  }

  private handleBackgroundWorkerFatal(
    state: SwarmSessionState,
    rt: WorkerRuntimeState,
    err: unknown,
  ): void {
    const msg = err instanceof Error ? err.message : String(err)
    if (rt.lastKnownConvId) {
      rt.stepCounter += 1
      this.appendTranscriptStep(state, rt.lastKnownConvId, rt.stepCounter, {
        type: 'ERROR',
        status: 'ERROR',
        error: msg,
      })
    }
    // Wake waiting coordinators on this session so a background roster/IO fault never hangs them.
    for (const waiter of [...state.waiters]) {
      if (waiter.memberName !== 'coordinator') continue
      state.waiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve({
        woke: false,
        posts: [],
        headSeq: state.boardSeqKnown,
        reason: `worker_error:${rt.name}`,
      })
    }
  }

  private scheduleWorkerRun(
    state: SwarmSessionState,
    workerName: string,
    expectedGeneration?: number,
  ): void {
    if (state.shuttingDown || !this.executor) return
    if (expectedGeneration !== undefined && state.interruptGeneration !== expectedGeneration) return
    let rt = state.workers.get(workerName)
    if (!rt) {
      const cleanName = workerName.replace(/[^a-zA-Z0-9_-]/g, '_')
      const suffix = createHash('sha256')
        .update(`${state.sessionKey}:${workerName}`, 'utf8')
        .digest('hex')
        .slice(0, 12)
      const sessionSlug = `${suffix}_${cleanName}`
      rt = {
        name: workerName,
        sessionSlug,
        workerSessionKey: `agent:${state.parentAgentId}:swarm:dm:${sessionSlug}_r0`,
        turnSeq: 0,
        running: false,
        pendingWake: false,
        runGeneration: state.interruptGeneration,
        abortController: null,
        runPromise: null,
        stepCounter: 0,
      }
      state.workers.set(workerName, rt)
    }
    if (rt.running) {
      rt.pendingWake = true
      return
    }
    // B4: Bind cancelable generation & AbortController synchronously BEFORE any await.
    const myGeneration = state.interruptGeneration
    const runAc = new AbortController()
    rt.running = true
    rt.pendingWake = false
    rt.runGeneration = myGeneration
    rt.abortController = runAc
    // B8: Catch all background rejections at the scheduling boundary so a roster/IO fault
    // NEVER escapes as an unhandledRejection and crashes the Gateway process.
    const run = this.runWorkerLoop(state, rt, myGeneration, runAc)
      .catch((err) => {
        this.handleBackgroundWorkerFatal(state, rt, err)
      })
      .finally(() => {
        if (rt && rt.runPromise === run) rt.runPromise = null
      })
    rt.runPromise = run
  }

  private async runWorkerLoop(
    state: SwarmSessionState,
    rt: WorkerRuntimeState,
    myGeneration: number,
    runAc: AbortController,
  ): Promise<void> {
    let lastInterrupted = false
    const isCancelled = (): boolean => {
      if (state.interruptGeneration !== myGeneration || isAbortInterruptReason(runAc.signal)) {
        lastInterrupted = true
        return true
      }
      return state.shuttingDown || runAc.signal.aborted
    }
    try {
      while (!isCancelled()) {
        const roster = await this.readRoster(state)
        if (isCancelled()) return
        const member = roster.members[rt.name]
        if (!member || member.killed) return
        rt.lastKnownConvId = member.conversation_id

        const allPosts = readBoardPostsFromDisk(state.location.swarmDir)
        const unread = allPosts.filter((p) => p.seq > (member.last_read_seq ?? 0))
        if (unread.length === 0 && !rt.pendingWake) return
        rt.pendingWake = false

        const relevant = unread.filter((p) => {
          if (p.agent.toLowerCase() === rt.name.toLowerCase()) return false
          const stallTarget = trustedStallAlertTarget(p)
          if (stallTarget !== null) {
            return stallTarget === rt.name.toLowerCase()
          }
          const mentions = extractSwarmMentions(p.text)
          return (
            mentions.some((m) =>
              memberMatchesMention(rt.name, m, member.channels ?? ['main'], p.channel),
            ) ||
            (member.wake_mode === 'all' &&
              (p.channel === 'main' || (member.channels ?? ['main']).includes(p.channel)))
          )
        })
        // Cursor of posts actually inspected/consumed in this turn (NEVER advance past
        // newer messages that arrive while `runWorkerTurn` is executing — IMPORTANT 3).
        const consumedSeq = unread.reduce((m, p) => Math.max(m, p.seq), member.last_read_seq ?? 0)
        if (relevant.length === 0) {
          if (isCancelled()) return
          await this.mutateRoster(state, (r) => {
            const m = r.members[rt.name]
            if (m && !m.killed) {
              m.last_read_seq = Math.max(m.last_read_seq ?? 0, consumedSeq)
            }
          })
          return
        }

        if (isCancelled()) return
        const gotSlot = await this.acquireWorkerSlot(state, runAc.signal)
        if (!gotSlot || isCancelled()) {
          if (gotSlot) this.releaseWorkerSlot()
          return
        }

        // Per-turn unique session key + random nonce avoids `assertFreshCc5Session` history
        // collisions even across runtime restarts with a persisted roster (B1 & B3).
        rt.turnSeq += 1
        const turnNonce = randomBytes(4).toString('hex')
        const turnSessionKey = `agent:${state.parentAgentId}:swarm:dm:${rt.sessionSlug}_r${rt.turnSeq}_${turnNonce}`
        rt.workerSessionKey = turnSessionKey
        const workerCallerToken = this.mintCallerToken(state.sessionKey, rt.name)
        activeMcpContexts.set(turnSessionKey, {
          coordinatorSessionKey: state.sessionKey,
          memberName: rt.name,
          callerToken: workerCallerToken,
        })

        let activeMemberConvId: string | null = member.conversation_id
        try {
          const freshMember = await this.mutateRoster(state, (freshRoster) => {
            if (isCancelled()) return null
            const m = freshRoster.members[rt.name]
            if (!m || m.killed) return null
            if (
              m.workspace?.path &&
              m.workspace.mode !== 'inherit' &&
              !existsSync(m.workspace.path)
            ) {
              throw new Error(`SWARM_WORKTREE_MISSING:${m.workspace.path}`)
            }
            m.phase = 'RUNNING'
            m.last_read_seq = Math.max(m.last_read_seq ?? 0, consumedSeq)
            return { ...m, channels: [...(m.channels ?? ['main'])] }
          })
          if (!freshMember || isCancelled()) return
          activeMemberConvId = freshMember.conversation_id
          rt.lastKnownConvId = freshMember.conversation_id

          // Mark a new USER_INPUT turn boundary in transcript.jsonl so an ERROR
          // from a previous failed attempt cannot bleed into this healthy retry.
          rt.stepCounter += 1
          this.appendTranscriptStep(state, freshMember.conversation_id, rt.stepCounter, {
            type: 'USER_INPUT',
            status: 'DONE',
          })

          const digest = relevant
            .map((p) => `[#${p.seq} #${p.channel} ${p.agent}]: ${p.text}`)
            .join('\n\n')
          const wsNote =
            freshMember.workspace?.path && freshMember.workspace.mode !== 'inherit'
              ? `你的独立 Git Worktree 工作目录是: ${freshMember.workspace.path}（模式: ${freshMember.workspace.mode}）。请只在此目录内修改并提交你的变更。`
              : `当前工作目录: ${state.workspaceCwd}。`
          const workerPrompt = [
            `<swarm_worker name="${rt.name}" role="${freshMember.role}">`,
            `你是 OpenClaude 远端蜂群成员「${rt.name}」（角色: ${freshMember.role}）。`,
            wsNote,
            '你可以直接使用所有工作区工具（读取/编辑/执行命令/检索）完成任务，并通过 `post_message` 向讨论板汇报进展与最终交付（汇报完毕后请 `@coordinator` 或下一个交接成员）。',
            '完成当前任务并调用 `post_message` 后直接结束本轮，等待下一次 `@` 唤醒即可（无需空等）。',
            '</swarm_worker>',
            '',
            '以下是你收到的最新讨论板消息：',
            digest,
          ].join('\n')

          const targetCwd = freshMember.workspace?.path || state.workspaceCwd
          if (isCancelled()) return
          let emittedErrorThisTurn = false
          const result = await this.executor!.runWorkerTurn({
            coordinatorSessionKey: state.sessionKey,
            workerSessionKey: turnSessionKey,
            workerName: rt.name,
            workerTurnSeq: rt.turnSeq,
            workerTurnNonce: turnNonce,
            workerConversationId: freshMember.conversation_id,
            parentAgentId: state.parentAgentId,
            allowedToolsets: state.allowedToolsets,
            callerToken: workerCallerToken,
            model: freshMember.model || state.model,
            effort: state.effort,
            workspaceCwd: targetCwd,
            prompt: workerPrompt,
            signal: runAc.signal,
            onTelemetry: (ev) => {
              if (ev.type === 'ERROR' || ev.status === 'ERROR') {
                emittedErrorThisTurn = true
              }
              rt.stepCounter += 1
              this.appendTranscriptStep(state, freshMember.conversation_id, rt.stepCounter, ev)
            },
          })

          // P1-3: Any returned `result.error` (including early-return failures before submit)
          // MUST write an ERROR transcript step so SwarmBoard & SwarmStallMonitor(member_failed)
          // observe it reliably.
          if (result.error && !emittedErrorThisTurn && !isCancelled()) {
            rt.stepCounter += 1
            this.appendTranscriptStep(state, freshMember.conversation_id, rt.stepCounter, {
              type: 'ERROR',
              status: 'ERROR',
              error: result.error,
            })
          }

          if (isCancelled()) return

          // Check if worker posted on the board during its turn; if not, post its summary/error so coordinator is never stuck.
          const afterPosts = readBoardPostsFromDisk(state.location.swarmDir)
          const ownPostsDuringTurn = afterPosts.filter(
            (p) => p.seq > consumedSeq && p.agent.toLowerCase() === rt.name.toLowerCase(),
          )
          const latestRoster = await this.readRoster(state)
          if (isCancelled()) return
          const latestMember = latestRoster.members[rt.name]
          if (latestMember && !latestMember.killed && !isCancelled()) {
            let postedFallbackSeq = 0
            if (ownPostsDuringTurn.length === 0) {
              const fallbackText = result.error
                ? `@coordinator [worker-error] ${result.error}`
                : result.text.trim()
                  ? `@coordinator ${result.text.trim().slice(0, 6000)}`
                  : '@coordinator 已完成本轮执行（无额外文本输出）。'
              const preferredChannel =
                (latestMember.channels ?? ['main']).find(
                  (c) => c !== 'main' && latestRoster.channels[c] && !latestRoster.channels[c]?.archived,
                ) ?? 'main'
              const posted = await this.appendBoardPost(state, {
                agent: rt.name,
                channel: preferredChannel,
                text: fallbackText,
                expectedGeneration: myGeneration,
              })
              if (!posted) return
              postedFallbackSeq = posted.seq
            }
            // Only advance `last_read_seq` to `consumedSeq` (NOT whole-board headSeq!),
            // so any directed message from another member that arrived mid-turn remains
            // unread and is delivered on the next loop iteration (IMPORTANT 3).
            await this.mutateRoster(state, (refreshedRoster) => {
              const refreshedMember = refreshedRoster.members[rt.name]
              if (refreshedMember && !refreshedMember.killed) {
                refreshedMember.phase = isCancelled() ? 'STOPPED' : 'WAITING'
                refreshedMember.wait_since = Math.max(
                  consumedSeq,
                  postedFallbackSeq,
                  ...ownPostsDuringTurn.map((p) => p.seq),
                )
                refreshedMember.last_read_seq = Math.max(
                  refreshedMember.last_read_seq ?? 0,
                  consumedSeq,
                )
              }
            })
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (isCancelled()) return
          try {
            let convId = activeMemberConvId
            let shouldPostFallback = false
            await this.mutateRoster(state, (errRoster) => {
              const errMember = errRoster.members[rt.name]
              if (!errMember) return
              convId = errMember.conversation_id
              if (!errMember.killed && !isCancelled()) {
                errMember.phase = 'WAITING'
                shouldPostFallback = true
              }
            })
            if (convId) {
              rt.stepCounter += 1
              this.appendTranscriptStep(state, convId, rt.stepCounter, {
                type: 'ERROR',
                status: 'ERROR',
                error: msg,
              })
            }
            if (shouldPostFallback && !isCancelled()) {
              await this.appendBoardPost(state, {
                agent: rt.name,
                channel: 'main',
                text: `@coordinator [worker-error] ${msg.slice(0, 500)}`,
                expectedGeneration: myGeneration,
              })
            }
          } catch {
            // Best-effort error reporting if roster itself is corrupt/unavailable.
          }
        } finally {
          activeMcpContexts.delete(turnSessionKey)
          this.releaseWorkerSlot()
        }

        if (isCancelled()) break

        // Re-check unread messages in case a new directed post arrived during the turn.
        const postTurnRoster = await this.readRoster(state)
        if (isCancelled()) break
        const postTurnMember = postTurnRoster.members[rt.name]
        const hasMoreUnread =
          Boolean(postTurnMember && !postTurnMember.killed) &&
          readBoardPostsFromDisk(state.location.swarmDir).some(
            (p) =>
              p.seq > (postTurnMember!.last_read_seq ?? 0) &&
              p.agent.toLowerCase() !== rt.name.toLowerCase(),
          )
        if (!rt.pendingWake && !hasMoreUnread) break
      }
    } catch (err) {
      // B8: Catch loop-level readRoster / board IO / lock timeout failures without crashing Gateway.
      if (!isCancelled()) {
        this.handleBackgroundWorkerFatal(state, rt, err)
      }
    } finally {
      rt.running = false
      if (rt.abortController === runAc) {
        rt.abortController = null
      }
      try {
        await this.mutateRoster(state, (settleRoster) => {
          const settleMember = settleRoster.members[rt.name]
          if (settleMember && !settleMember.killed && settleMember.phase === 'RUNNING') {
            settleMember.phase = lastInterrupted ? 'STOPPED' : 'WAITING'
          }
        })
      } catch {
        /* ignore settle error during teardown */
      }
      this.checkIdleWaiters(state)
      // If a brand-new post arrived AFTER an interrupt while this stale generation was still exiting,
      // re-schedule cleanly on the current generation.
      if (
        !state.shuttingDown &&
        rt.pendingWake &&
        state.interruptGeneration !== myGeneration
      ) {
        this.scheduleWorkerRun(state, rt.name)
      }
    }
  }

  private checkIdleWaiters(state: SwarmSessionState): void {
    const anyRunning = [...state.workers.values()].some((w) => w.running)
    if (anyRunning) return
    let allPosts: BoardPostRecord[]
    try {
      allPosts = readBoardPostsFromDisk(state.location.swarmDir)
    } catch {
      return
    }
    const headSeq = allPosts.reduce((m, p) => Math.max(m, p.seq), 0)
    for (const waiter of [...state.waiters]) {
      if (waiter.memberName !== 'coordinator') continue
      const delta = allPosts.filter((p) => p.seq > waiter.since)
      if (delta.length > 0) {
        state.waiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.resolve({ woke: true, posts: delta, headSeq, reason: 'workers_settled' })
      }
    }
  }

  /**
   * Three-phase lock-safe kill (P0-3 + P2-3):
   *   1. Under `mutateRoster`: resolve prefix-matched members, enforce per-member `added_by`
   *      authorization BEFORE mutating anything, mark `killed = true / phase = 'KILLED'`, and
   *      release `.roster.lock` before any `await`.
   *   2. Outside any lock: abort workers, revoke tokens, await exit + lane release, remove clean
   *      worktrees while preserving dirty/unmerged worktrees.
   *   3. Under `mutateRoster`: re-read latest `members.json` and confirm terminal state without
   *      clobbering concurrent `add`/`channel`/`title`/`last_read_seq` updates.
   */
  private async killMemberInternal(
    state: SwarmSessionState,
    targetName: string,
    _reason: string,
    opts?: { forceDirtyWorktree?: boolean; stopWaitTimeoutMs?: number; caller?: string },
  ): Promise<{
    killed: string[]
    unconfirmed: string[]
    alreadyKilled: string[]
    notFound: boolean
    preservedDirtyWorktrees: string[]
  }> {
    const lower = targetName.toLowerCase()
    const caller = opts?.caller?.trim().toLowerCase()

    // Phase 1: atomic authorization + mark KILLED under `.roster.lock` (no `await` inside).
    const phase1 = await this.mutateRoster(state, (roster) => {
      if (caller && caller !== 'coordinator' && lower === 'coordinator') {
        throw new Error('SWARM_KILL_FORBIDDEN')
      }
      const matchedNames = Object.keys(roster.members).filter((name) => {
        const n = name.toLowerCase()
        if (n === 'coordinator') return false
        return n === lower || (n.startsWith(`${lower}-`) && /^\d+$/.test(n.slice(lower.length + 1)))
      })
      if (matchedNames.length === 0) {
        return {
          notFound: true as const,
          alreadyKilled: [] as string[],
          toKill: [] as Array<{ name: string; workspace?: RosterMemberRecord['workspace'] }>,
        }
      }
      if (caller && caller !== 'coordinator') {
        for (const name of matchedNames) {
          if (roster.members[name]?.added_by?.toLowerCase() !== caller) {
            throw new Error('SWARM_KILL_FORBIDDEN')
          }
        }
      }
      const alreadyKilled: string[] = []
      const toKill: Array<{ name: string; workspace?: RosterMemberRecord['workspace'] }> = []
      for (const name of matchedNames) {
        const rec = roster.members[name]!
        if (rec.killed) {
          alreadyKilled.push(name)
          continue
        }
        rec.killed = true
        rec.phase = 'KILLED'
        toKill.push({
          name,
          workspace: rec.workspace ? { ...rec.workspace } : undefined,
        })
      }
      return { notFound: false as const, alreadyKilled, toKill }
    })

    if (phase1.notFound) {
      return {
        killed: [],
        unconfirmed: [],
        alreadyKilled: [],
        notFound: true,
        preservedDirtyWorktrees: [],
      }
    }

    // Phase 2: stop running workers, release remote lanes, clean clean worktrees (NO lock held).
    const killed: string[] = []
    const unconfirmed: string[] = []
    const preservedDirtyWorktrees: string[] = []
    const waitMs = Math.max(50, opts?.stopWaitTimeoutMs ?? 5_000)

    for (const item of phase1.toKill) {
      const { name, workspace } = item
      const rt = state.workers.get(name)
      let stopConfirmed = true
      if (rt) {
        activeMcpContexts.delete(rt.workerSessionKey)
        rt.pendingWake = false
        rt.abortController?.abort(new Error('SWARM_MEMBER_KILLED'))
        if (rt.runPromise) {
          let settled = false
          await Promise.race([
            rt.runPromise
              .catch(() => {})
              .then(() => {
                settled = true
              }),
            new Promise<void>((r) => setTimeout(r, waitMs).unref?.()),
          ])
          if (!settled) stopConfirmed = false
        }
        if (this.executor) {
          try {
            const rel = await this.executor.releaseWorkerSession(rt.workerSessionKey)
            if (rel && rel.released === false && rel.state !== 'not_found') {
              stopConfirmed = false
            }
          } catch {
            stopConfirmed = false
          }
        }
      }
      if (!stopConfirmed) {
        // Honest status (I4/I7): never claim confirmed or delete a worktree while stop is unproven.
        unconfirmed.push(name)
        continue
      }
      if (workspace?.path && workspace.mode !== 'inherit') {
        const wtRes = removeWorkerGitWorktree(state.workspaceCwd, workspace.path, {
          forceDirty: opts?.forceDirtyWorktree,
        })
        if (wtRes.preservedDirtyPath) {
          preservedDirtyWorktrees.push(wtRes.preservedDirtyPath)
        }
      }
      killed.push(name)
    }

    // Phase 3: re-read latest roster under `.roster.lock` and seal terminal state
    // without overwriting any concurrent add/channel/title/last_read_seq mutations.
    if (killed.length > 0 || unconfirmed.length > 0) {
      await this.mutateRoster(state, (latestRoster) => {
        for (const name of [...killed, ...unconfirmed]) {
          const rec = latestRoster.members[name]
          if (rec) {
            rec.killed = true
            rec.phase = 'KILLED'
          }
        }
      })
    }

    return {
      killed,
      unconfirmed,
      alreadyKilled: phase1.alreadyKilled,
      notFound: false,
      preservedDirtyWorktrees,
    }
  }

  /** Execute one of the 4 Swarm MCP tools (`swarm`, `post_message`, `read_board`, `swarm_wait`). */
  async handleToolCall(input: {
    sessionKey: string
    callerMember?: string
    tool: 'swarm' | 'post_message' | 'read_board' | 'swarm_wait'
    args: Record<string, unknown>
  }): Promise<Record<string, unknown>> {
    // Fail-closed: only explicitly registered active coordinator sessions may use the runtime (BLOCKER 4).
    const state = this.sessions.get(input.sessionKey.trim())
    if (!state || state.shuttingDown) {
      throw new Error('REMOTE_SWARM_SESSION_NOT_REGISTERED')
    }
    const caller = (input.callerMember || 'coordinator').trim() || 'coordinator'

    // P1-3: Record coordinator swarm tool invocations in coordinator's transcript.jsonl.
    if (caller === 'coordinator') {
      this.recordCoordinatorTelemetry(state.sessionKey, {
        type: 'TOOL_CALL',
        status: 'ACTIVE',
        toolName: input.tool,
        toolArgs: input.args,
      })
    }

    const toolHost: RemoteSwarmToolHost = {
      location: state.location,
      model: state.model,
      workspaceCwd: state.workspaceCwd,
      isWorkerRunning: (name) => Boolean(state.workers.get(name)?.running),
      getInterruptGeneration: () => state.interruptGeneration,
      isSessionStopped: (expectedGen) =>
        state.shuttingDown || state.interruptGeneration !== expectedGen,
      readRoster: () => this.readRoster(state),
      mutateRoster: (fn) => this.mutateRoster(state, fn),
      appendBoardPost: (postInput) => this.appendBoardPost(state, postInput),
    }

    if (input.tool === 'post_message') {
      return executePostMessageTool(toolHost, caller, input.args)
    }

    if (input.tool === 'read_board') {
      return executeReadBoardTool(toolHost, caller, input.args)
    }

    if (input.tool === 'swarm_wait') {
      const since =
        typeof input.args.since === 'number' &&
        Number.isFinite(input.args.since) &&
        input.args.since >= 0
          ? Math.floor(input.args.since)
          : 0
      const mentionsOnly = input.args.mentions_only !== false
      const channel = typeof input.args.channel === 'string' ? input.args.channel.trim() : undefined
      const rawTimeout =
        typeof input.args.timeout_ms === 'number' && Number.isFinite(input.args.timeout_ms)
          ? Math.floor(input.args.timeout_ms)
          : typeof input.args.timeout_seconds === 'number' &&
              Number.isFinite(input.args.timeout_seconds)
            ? Math.floor(input.args.timeout_seconds * 1_000)
            : DEFAULT_WAIT_TIMEOUT_MS
      const timeoutMs = Math.max(1_000, Math.min(MAX_WAIT_TIMEOUT_MS, rawTimeout))

      const matchWaitPosts = (posts: BoardPostRecord[]): BoardPostRecord[] =>
        posts.filter((p) => {
          if (p.seq <= since) return false
          if (p.agent.toLowerCase() === caller.toLowerCase()) return false
          if (channel && channel !== '*' && p.channel !== channel) return false
          const stallTarget = trustedStallAlertTarget(p)
          if (stallTarget !== null) {
            return stallTarget === caller.toLowerCase()
          }
          const mentions = extractSwarmMentions(p.text)
          const mentioned = mentions.some((m) =>
            memberMatchesMention(caller, m, memberChannels, p.channel),
          )
          const inChannel =
            caller === 'coordinator' || p.channel === 'main' || memberChannels.includes(p.channel)
          return mentionsOnly ? mentioned : inChannel || mentioned
        })

      const roster = await this.readRoster(state)
      const memberChannels = roster.members[caller]?.channels ?? ['main']
      const existing = readBoardPostsFromDisk(state.location.swarmDir)
      const headSeq = existing.reduce((m, p) => Math.max(m, p.seq), 0)
      const alreadyMatching = matchWaitPosts(existing)
      if (alreadyMatching.length > 0) {
        return {
          ok: true,
          woke: true,
          head_seq: headSeq,
          posts: alreadyMatching,
          reason: 'already_available',
        }
      }

      const anyRunning = [...state.workers.values()].some((w) => w.running)
      if (!anyRunning && caller === 'coordinator') {
        const delta = existing.filter((p) => p.seq > since)
        return {
          ok: true,
          woke: false,
          head_seq: headSeq,
          posts: delta,
          reason: 'no_working_members',
        }
      }

      const waitStartGen = state.interruptGeneration
      await this.mutateRoster(state, (r) => {
        const m = r.members[caller]
        if (m && !m.killed) {
          // Only update transient `phase` and `wait_since`; NEVER overwrite persistent
          // `wake_mode` so a one-shot `mentions_only:false` wait cannot change future routing.
          m.phase = 'WAITING'
          m.wait_since = since
        }
      })

      let waited: { woke: boolean; posts: BoardPostRecord[]; headSeq: number; reason: string }
      try {
        waited = await new Promise<{
          woke: boolean
          posts: BoardPostRecord[]
          headSeq: number
          reason: string
        }>((resolveWait, rejectWait) => {
          let settled = false
          const settle = (res: {
            woke: boolean
            posts: BoardPostRecord[]
            headSeq: number
            reason: string
          }) => {
            if (settled) return
            settled = true
            state.waiters.delete(entry)
            clearTimeout(timer)
            resolveWait(res)
          }
          const timer = setTimeout(() => {
            if (settled) return
            try {
              const cur = readBoardPostsFromDisk(state.location.swarmDir)
              settle({
                woke: false,
                posts: cur.filter((p) => p.seq > since),
                headSeq: cur.reduce((m, p) => Math.max(m, p.seq), 0),
                reason: 'timeout',
              })
            } catch (err) {
              settled = true
              state.waiters.delete(entry)
              clearTimeout(timer)
              rejectWait(err)
            }
          }, timeoutMs)
          timer.unref?.()
          const entry: WaiterEntry = {
            memberName: caller,
            since,
            mentionsOnly,
            channel,
            resolve: settle,
            timer,
          }
          state.waiters.add(entry)

          // B7: Synchronously re-check board posts, interrupt/shutdown, and worker idle state
          // AFTER registering `entry` so posts written during the `WAITING` roster await can
          // NEVER be lost.
          if (state.shuttingDown) {
            settle({
              woke: false,
              posts: [],
              headSeq: state.boardSeqKnown,
              reason: 'session_shutdown',
            })
            return
          }
          if (state.interruptGeneration !== waitStartGen) {
            settle({
              woke: false,
              posts: [],
              headSeq: state.boardSeqKnown,
              reason: 'interrupted',
            })
            return
          }
          try {
            const rechecked = readBoardPostsFromDisk(state.location.swarmDir)
            const recheckHead = rechecked.reduce((m, p) => Math.max(m, p.seq), 0)
            const recheckMatched = matchWaitPosts(rechecked)
            if (recheckMatched.length > 0) {
              settle({
                woke: true,
                posts: recheckMatched,
                headSeq: recheckHead,
                reason: 'already_available',
              })
              return
            }
            if (caller === 'coordinator' && ![...state.workers.values()].some((w) => w.running)) {
              const delta = rechecked.filter((p) => p.seq > since)
              settle({
                woke: delta.length > 0,
                posts: delta,
                headSeq: recheckHead,
                reason: delta.length > 0 ? 'workers_settled' : 'no_working_members',
              })
            }
          } catch (err) {
            settled = true
            state.waiters.delete(entry)
            clearTimeout(timer)
            rejectWait(err)
          }
        })
      } finally {
        if (!state.shuttingDown) {
          try {
            await this.mutateRoster(state, (resumeRoster) => {
              const resumeMember = resumeRoster.members[caller]
              if (resumeMember && !resumeMember.killed) {
                resumeMember.phase = 'RUNNING'
              }
            })
          } catch {
            /* ignore resume settle error */
          }
        }
      }
      return {
        ok: true,
        woke: waited.woke,
        head_seq: waited.headSeq,
        posts: waited.posts,
        reason: waited.reason,
      }
    }

    // tool === 'swarm'
    const action =
      typeof input.args.action === 'string' ? input.args.action.trim().toLowerCase() : ''

    if (action === 'title') {
      if (caller !== 'coordinator') throw new Error('SWARM_TITLE_COORDINATOR_ONLY')
      const title = typeof input.args.title === 'string' ? input.args.title.trim().slice(0, 120) : ''
      if (!title) throw new Error('SWARM_TITLE_REQUIRED')
      await this.mutateRoster(state, (roster) => {
        roster.title = title
      })
      return { ok: true, title }
    }

    if (action === 'status') {
      return executeSwarmStatusAction(toolHost)
    }

    if (action === 'models') {
      return {
        ok: true,
        current_model: state.model,
        note: 'Leave model omitted on add so workers inherit the active session model.',
      }
    }

    if (action === 'channel') {
      return executeSwarmChannelAction(toolHost, caller, input.args)
    }

    if (action === 'add') {
      return executeSwarmAddAction(toolHost, caller, input.args)
    }

    if (action === 'kill') {
      const target =
        typeof input.args.name === 'string' ? input.args.name.trim().toLowerCase() : ''
      if (!target) throw new Error('SWARM_MEMBER_NAME_REQUIRED')
      const res = await this.killMemberInternal(state, target, 'tool_kill', { caller })
      if (res.notFound) throw new Error(`SWARM_MEMBER_NOT_FOUND:${target}`)
      return {
        ok: true,
        killed: res.killed,
        already_killed: res.alreadyKilled,
        ...(res.preservedDirtyWorktrees.length > 0
          ? { preserved_dirty_worktrees: res.preservedDirtyWorktrees }
          : {}),
      }
    }

    if (action === 'model') {
      const target =
        typeof input.args.name === 'string' && input.args.name.trim()
          ? input.args.name.trim().toLowerCase()
          : caller
      const nextModel = typeof input.args.model === 'string' ? input.args.model.trim() : ''
      if (!nextModel) throw new Error('SWARM_MODEL_REQUIRED')
      if (state.workers.get(target)?.running) {
        throw new Error(`SWARM_MEMBER_BUSY:${target}`)
      }
      await this.mutateRoster(state, (roster) => {
        const rec = roster.members[target]
        if (!rec) throw new Error(`SWARM_MEMBER_NOT_FOUND:${target}`)
        rec.model = nextModel
      })
      return { ok: true, name: target, model: nextModel }
    }

    throw new Error(`SWARM_ACTION_UNSUPPORTED:${action}`)
  }

  /**
   * Abort all in-flight workers, await their exit, release lanes, remove CLEAN isolated
   * worktrees (preserving dirty worktrees with uncommitted changes), wake pending waiters,
   * and remove session state from memory (IMPORTANT 6 & 7).
   */
  async shutdownSession(sessionKey: string): Promise<{ preservedDirtyWorktrees: string[] }> {
    const cleanKey = sessionKey.trim()
    const state = this.sessions.get(cleanKey)
    if (!state) return { preservedDirtyWorktrees: [] }
    state.shuttingDown = true
    activeMcpContexts.delete(cleanKey)
    if (activeRuntimeBySession.get(cleanKey) === this) {
      activeRuntimeBySession.delete(cleanKey)
    }

    for (const waiter of [...state.waiters]) {
      state.waiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve({
        woke: false,
        posts: [],
        headSeq: state.boardSeqKnown,
        reason: 'session_shutdown',
      })
    }

    const activeWaits: Promise<void>[] = []
    for (const rt of state.workers.values()) {
      rt.pendingWake = false
      rt.abortController?.abort(new Error('SWARM_SESSION_SHUTDOWN'))
      if (rt.runPromise) {
        activeWaits.push(
          Promise.race([
            rt.runPromise.catch(() => {}),
            new Promise<void>((r) => setTimeout(r, 5_000).unref?.()),
          ]),
        )
      }
    }
    await Promise.allSettled(activeWaits)

    const releases: Promise<unknown>[] = []
    for (const rt of state.workers.values()) {
      activeMcpContexts.delete(rt.workerSessionKey)
      if (this.executor) {
        releases.push(this.executor.releaseWorkerSession(rt.workerSessionKey).catch(() => {}))
      }
    }
    await Promise.allSettled(releases)

    const preservedDirtyWorktrees: string[] = []
    try {
      const roster = readRosterStrict(state.location)
      if (roster) {
        for (const rec of Object.values(roster.members)) {
          if (rec.workspace?.path && rec.workspace.mode !== 'inherit') {
            const wtRes = removeWorkerGitWorktree(state.workspaceCwd, rec.workspace.path)
            if (wtRes.preservedDirtyPath) {
              preservedDirtyWorktrees.push(wtRes.preservedDirtyPath)
            }
          }
        }
      }
    } catch {
      /* ignore unreadable roster during teardown */
    }

    this.sessions.delete(cleanKey)
    return { preservedDirtyWorktrees }
  }

  async shutdownAll(): Promise<{ preservedDirtyWorktrees: string[] }> {
    const results = await Promise.allSettled(
      [...this.sessions.keys()].map((k) => this.shutdownSession(k)),
    )
    const preservedDirtyWorktrees: string[] = []
    for (const r of results) {
      if (r.status === 'fulfilled') {
        preservedDirtyWorktrees.push(...r.value.preservedDirtyWorktrees)
      }
    }
    return { preservedDirtyWorktrees }
  }
}
