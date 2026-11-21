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
import { execFileSync } from 'node:child_process'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import {
  SWARM_MAX_CHANNELS,
  SWARM_MAX_MEMBERS,
  extractSwarmMentions,
} from '@openclaude/protocol'
import { antigravityRoot } from './engine/antigravityPlatform.js'

const MEMBER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const RESERVED_MEMBER_NAMES = new Set(['all', 'coordinator'])
const DEFAULT_MAX_PARALLEL_WORKERS = 3
const DEFAULT_WAIT_TIMEOUT_MS = 180_000
const MAX_WAIT_TIMEOUT_MS = 300_000
const DEFAULT_READ_BOARD_LIMIT = 50
const MAX_READ_BOARD_LIMIT = 200
const DEFAULT_CALLER_TOKEN_TTL_MS = 12 * 60 * 60_000
const BOARD_LOCK_MAX_WAIT_MS = 5_000
const BOARD_LOCK_STALE_MS = 30_000
const MAX_SHARD_ADD = 8

export interface RemoteSwarmMcpContext {
  readonly coordinatorSessionKey: string
  readonly memberName: string
  readonly callerToken: string
}

/** Process-local registry binding active coordinator & worker sessions to their
 *  HMAC-signed RemoteSwarm caller tokens for MCP subprocess env injection. */
const activeMcpContexts = new Map<string, RemoteSwarmMcpContext>()
const activeRuntimeBySession = new Map<string, RemoteSwarmRuntime>()

export function lookupRemoteSwarmMcpContext(sessionKey: string): RemoteSwarmMcpContext | undefined {
  return activeMcpContexts.get(sessionKey.trim())
}

export function lookupRemoteSwarmRuntimeForSession(
  sessionKey: string,
): RemoteSwarmRuntime | undefined {
  return activeRuntimeBySession.get(sessionKey.trim())
}

export interface RemoteSwarmLocation {
  readonly brainDir: string
  readonly swarmId: string
  readonly swarmDir: string
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
  readonly type: 'PLANNER_RESPONSE' | 'TOOL_CALL' | 'ERROR'
  readonly status: 'ACTIVE' | 'DONE' | 'ERROR'
  readonly toolName?: string
  readonly toolArgs?: Record<string, unknown>
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly error?: string
}

export interface RemoteSwarmWorkerTurnResult {
  readonly text: string
  readonly error?: string
  readonly inputTokens?: number
  readonly outputTokens?: number
}

export interface RemoteSwarmWorkerExecutor {
  runWorkerTurn(input: RemoteSwarmWorkerTurnInput): Promise<RemoteSwarmWorkerTurnResult>
  releaseWorkerSession(
    workerSessionKey: string,
  ): Promise<{ released: boolean; state: string } | void>
}

interface RosterMemberRecord {
  conversation_id: string
  role: 'coordinator' | 'worker' | 'verifier' | 'narrator' | 'monitor'
  model: string
  phase: 'RUNNING' | 'WAITING' | 'STOPPED' | 'KILLED'
  wake_mode: 'mentions' | 'all'
  wait_since: number
  last_read_seq: number
  killed: boolean
  channels: string[]
  workspace?: {
    mode: 'inherit' | 'share' | 'branch'
    path?: string
    branch?: string
  }
  added_by?: string
}

interface RosterChannelRecord {
  topic?: string
  creator?: string
  archived?: boolean
}

interface RosterFile {
  title: string
  members: Record<string, RosterMemberRecord>
  channels: Record<string, RosterChannelRecord>
}

export interface BoardPostRecord {
  seq: number
  agent: string
  channel: string
  text: string
  time: string
  kind?: string
  request_id?: string
  control?: Record<string, unknown>
}

interface WaiterEntry {
  readonly memberName: string
  readonly since: number
  readonly mentionsOnly: boolean
  readonly channel?: string
  readonly resolve: (result: { woke: boolean; posts: BoardPostRecord[]; headSeq: number; reason: string }) => void
  readonly timer: NodeJS.Timeout
}

interface WorkerRuntimeState {
  readonly name: string
  readonly sessionSlug: string
  workerSessionKey: string
  turnSeq: number
  running: boolean
  pendingWake: boolean
  abortController: AbortController | null
  runPromise: Promise<void> | null
  stepCounter: number
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
  boardSeqKnown: number
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

function formatBoardTimestamp(now = new Date()): string {
  return now.toISOString().replace('T', ' ').slice(0, 19)
}

function inferMemberRole(name: string): RosterMemberRecord['role'] {
  const lower = name.toLowerCase()
  if (lower === 'coordinator') return 'coordinator'
  if (/^narrator(?:-\d+)?$/.test(lower)) return 'narrator'
  if (/^monitor(?:-\d+)?$/.test(lower)) return 'monitor'
  if (/verif|review|audit|qa|test/.test(lower)) return 'verifier'
  return 'worker'
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`
  const payload = JSON.stringify(data, null, 2)
  writeFileSync(tmpPath, payload, { mode: 0o600 })
  renameSync(tmpPath, filePath)
}

function withBoardFileLock<T>(swarmDir: string, fn: () => T): T {
  ensurePrivateDir(swarmDir)
  const lockPath = join(swarmDir, '.board.lock')
  const deadline = Date.now() + BOARD_LOCK_MAX_WAIT_MS
  let fd: number | null = null
  while (fd === null) {
    try {
      const flags =
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)
      fd = openSync(lockPath, flags, 0o600)
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err
      try {
        const st = statSync(lockPath)
        if (Date.now() - st.mtimeMs > BOARD_LOCK_STALE_MS) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error('SWARM_BOARD_LOCK_TIMEOUT')
      }
      const until = Date.now() + 15
      while (Date.now() < until) {
        // bounded short spin for lock file release
      }
    }
  }
  try {
    return fn()
  } finally {
    try {
      closeSync(fd)
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(lockPath)
    } catch {
      /* ignore */
    }
  }
}

function readBoardPostsFromDisk(swarmDir: string): BoardPostRecord[] {
  const boardPath = join(swarmDir, 'board.jsonl')
  if (!existsSync(boardPath)) return []
  const raw = readFileSync(boardPath, 'utf8')
  const posts: BoardPostRecord[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>
      if (!obj || typeof obj !== 'object') continue
      const seq = typeof obj.seq === 'number' && Number.isFinite(obj.seq) ? Math.floor(obj.seq) : posts.length + 1
      posts.push({
        seq,
        agent: typeof obj.agent === 'string' && obj.agent.trim() ? obj.agent.trim() : 'unknown',
        channel: typeof obj.channel === 'string' && obj.channel.trim() ? obj.channel.trim() : 'main',
        text: typeof obj.text === 'string' ? obj.text : '',
        time: typeof obj.time === 'string' ? obj.time : formatBoardTimestamp(),
        ...(typeof obj.kind === 'string' ? { kind: obj.kind } : {}),
        ...(typeof obj.request_id === 'string' ? { request_id: obj.request_id } : {}),
        ...(obj.control && typeof obj.control === 'object' && !Array.isArray(obj.control)
          ? { control: obj.control as Record<string, unknown> }
          : {}),
      })
    } catch {
      // skip torn line
    }
  }
  return posts
}

function findGitRepoTopLevel(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim()
    return out || null
  } catch {
    return null
  }
}

function isGitWorktreeDirty(wtPath: string): boolean {
  try {
    const out = execFileSync('git', ['-C', wtPath, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim()
    return out.length > 0
  } catch {
    return true
  }
}

/**
 * Check whether a worktree's HEAD commit is unmerged into the main repository's HEAD (I6).
 * In `share` (detached HEAD) mode, a worker can commit changes leaving porcelain clean;
 * deleting the worktree without proving its commit is reachable from main HEAD orphans work.
 */
function hasUnmergedGitWorktreeCommits(repoTop: string, wtPath: string): boolean {
  try {
    const wtHead = execFileSync('git', ['-C', wtPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim()
    if (!wtHead) return true
    execFileSync('git', ['-C', repoTop, 'merge-base', '--is-ancestor', wtHead, 'HEAD'], {
      stdio: 'ignore',
      timeout: 5_000,
    })
    return false
  } catch {
    return true
  }
}

function isGitWorktreeUnsafeToDelete(repoTop: string, wtPath: string): boolean {
  return isGitWorktreeDirty(wtPath) || hasUnmergedGitWorktreeCommits(repoTop, wtPath)
}

function createWorkerGitWorktree(
  baseCwd: string,
  swarmId: string,
  workerName: string,
  mode: 'share' | 'branch',
): { mode: 'share' | 'branch'; path: string; branch?: string } {
  const repoTop = findGitRepoTopLevel(baseCwd)
  if (!repoTop) {
    throw new Error(`SWARM_WORKTREE_CREATE_FAILED: workspace is not a git repository (${baseCwd})`)
  }
  const wtBase = join(repoTop, '.oc-swarm-worktrees')
  ensurePrivateDir(wtBase)
  const slug = `${swarmId.slice(0, 8)}-${workerName}`
  const wtPath = resolve(wtBase, slug)
  if (!wtPath.startsWith(`${resolve(wtBase)}/`)) {
    throw new Error(`SWARM_WORKTREE_CREATE_FAILED: invalid worktree path (${slug})`)
  }
  try {
    if (existsSync(wtPath)) {
      if (isGitWorktreeUnsafeToDelete(repoTop, wtPath)) {
        throw new Error(`existing worktree has uncommitted or unmerged changes (${wtPath})`)
      }
      execFileSync('git', ['-C', repoTop, 'worktree', 'remove', '--force', wtPath], {
        stdio: 'ignore',
        timeout: 10_000,
      })
    }
    if (mode === 'branch') {
      const branchName = `swarm/${slug}-${Date.now().toString(36)}`
      execFileSync('git', ['-C', repoTop, 'worktree', 'add', '-b', branchName, wtPath, 'HEAD'], {
        stdio: 'ignore',
        timeout: 15_000,
      })
      return { mode: 'branch', path: wtPath, branch: branchName }
    }
    execFileSync('git', ['-C', repoTop, 'worktree', 'add', '--detach', wtPath, 'HEAD'], {
      stdio: 'ignore',
      timeout: 15_000,
    })
    return { mode: 'share', path: wtPath }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`SWARM_WORKTREE_CREATE_FAILED: ${detail}`)
  }
}

function removeWorkerGitWorktree(
  baseCwd: string,
  wtPath: string | undefined,
  opts?: { forceDirty?: boolean },
): { removed: boolean; preservedDirtyPath?: string } {
  if (!wtPath) return { removed: false }
  const repoTop = findGitRepoTopLevel(baseCwd)
  const wtBase = repoTop ? resolve(repoTop, '.oc-swarm-worktrees') : null
  const resolvedWt = resolve(wtPath)
  if (!wtBase || !resolvedWt.startsWith(`${wtBase}/`)) {
    return { removed: false }
  }
  if (!existsSync(resolvedWt)) {
    return { removed: true }
  }
  if (!opts?.forceDirty && isGitWorktreeUnsafeToDelete(repoTop!, resolvedWt)) {
    return { removed: false, preservedDirtyPath: resolvedWt }
  }
  try {
    execFileSync('git', ['-C', repoTop!, 'worktree', 'remove', '--force', resolvedWt], {
      stdio: 'ignore',
      timeout: 10_000,
    })
    return { removed: true }
  } catch {
    try {
      rmSync(resolvedWt, { recursive: true, force: true })
      return { removed: true }
    } catch {
      return { removed: false, preservedDirtyPath: resolvedWt }
    }
  }
}

function memberMatchesMention(memberName: string, mention: string, memberChannels: string[], postChannel: string): boolean {
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
    const configured = opts?.maxParallelWorkers ?? (Number.isFinite(envCap) ? envCap : DEFAULT_MAX_PARALLEL_WORKERS)
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
    const payload = Buffer.from(`${cleanSession}\n${cleanMember}\n${exp}`, 'utf8').toString('base64url')
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
    const roster = this.ensureRoster(state)
    const memberRec = roster.members[cleanMember]
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
        boardSeqKnown: 0,
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
    activeMcpContexts.set(key, {
      coordinatorSessionKey: key,
      memberName: 'coordinator',
      callerToken: this.mintCallerToken(key, 'coordinator'),
    })
    activeRuntimeBySession.set(key, this)
    return state
  }

  getActiveSwarmLocation(sessionKey: string): RemoteSwarmLocation | null {
    const loc = this.locationFor(sessionKey)
    if (existsSync(join(loc.swarmDir, 'members.json'))) {
      return loc
    }
    return null
  }

  private ensureRoster(state: SwarmSessionState): RosterFile {
    ensurePrivateDir(state.location.swarmDir)
    const membersPath = join(state.location.swarmDir, 'members.json')
    if (existsSync(membersPath)) {
      try {
        const parsed = JSON.parse(readFileSync(membersPath, 'utf8')) as Partial<RosterFile>
        const members = parsed.members && typeof parsed.members === 'object' ? { ...parsed.members } : {}
        const channels =
          parsed.channels && typeof parsed.channels === 'object'
            ? { ...parsed.channels }
            : { main: { topic: '主频道' } }
        if (!members.coordinator) {
          members.coordinator = {
            conversation_id: state.location.swarmId,
            role: 'coordinator',
            model: state.model,
            phase: 'RUNNING',
            wake_mode: 'mentions',
            wait_since: 0,
            last_read_seq: 0,
            killed: false,
            channels: ['main'],
          }
        }
        return {
          title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title : '蜂群协作',
          members,
          channels,
        }
      } catch {
        // fall through to fresh roster
      }
    }
    const fresh: RosterFile = {
      title: '蜂群协作',
      members: {
        coordinator: {
          conversation_id: state.location.swarmId,
          role: 'coordinator',
          model: state.model,
          phase: 'RUNNING',
          wake_mode: 'mentions',
          wait_since: 0,
          last_read_seq: 0,
          killed: false,
          channels: ['main'],
        },
      },
      channels: {
        main: { topic: '主频道' },
      },
    }
    atomicWriteJson(membersPath, fresh)
    return fresh
  }

  private saveRoster(state: SwarmSessionState, roster: RosterFile): void {
    ensurePrivateDir(state.location.swarmDir)
    atomicWriteJson(join(state.location.swarmDir, 'members.json'), roster)
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
      if (ev.inputTokens !== undefined || ev.outputTokens !== undefined) {
        record.usage = {
          input_tokens: Math.max(0, Math.floor(ev.inputTokens ?? 0)),
          output_tokens: Math.max(0, Math.floor(ev.outputTokens ?? 0)),
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

  private appendBoardPost(
    state: SwarmSessionState,
    input: {
      agent: string
      text: string
      channel?: string
      kind?: string
      control?: Record<string, unknown>
    },
  ): BoardPostRecord {
    const channel = (input.channel || 'main').trim() || 'main'
    const post = withBoardFileLock(state.location.swarmDir, () => {
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
      appendFileSync(join(state.location.swarmDir, 'board.jsonl'), `${JSON.stringify(next)}\n`, {
        mode: 0o600,
      })
      return next
    })
    state.boardSeqKnown = Math.max(state.boardSeqKnown, post.seq)
    this.notifyAfterBoardPost(state, post)
    return post
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
      this.appendBoardPost(state, {
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
  executeOperatorSteer(
    sessionKey: string,
    targetName: string,
    directive: string,
    channel = 'main',
  ): BoardPostRecord {
    const state = this.sessions.get(sessionKey.trim())
    if (!state) throw new Error('REMOTE_SWARM_SESSION_NOT_REGISTERED')
    const cleanTarget = targetName.trim().toLowerCase()
    if (!cleanTarget) throw new Error('SWARM_MEMBER_NAME_REQUIRED')
    return this.appendBoardPost(state, {
      agent: 'operator',
      channel,
      kind: 'control',
      control: { kind: 'steer', target: cleanTarget },
      text: `@${cleanTarget} ${directive.trim()}`,
    })
  }

  /** Called when a trusted external API (e.g. `swarmCommand.ts`) appended to `board.jsonl`. */
  onExternalBoardWrite(sessionKey: string): void {
    const state = this.sessions.get(sessionKey.trim())
    if (!state || state.shuttingDown) return
    const posts = readBoardPostsFromDisk(state.location.swarmDir)
    const fresh = posts.filter((p) => p.seq > state.boardSeqKnown)
    for (const post of fresh) {
      state.boardSeqKnown = Math.max(state.boardSeqKnown, post.seq)
      this.notifyAfterBoardPost(state, post)
    }
  }

  private notifyAfterBoardPost(state: SwarmSessionState, post: BoardPostRecord): void {
    // Ordinary board messages NEVER parse or execute kill directives (BLOCKER 4).
    // Destructive kills go exclusively through `swarm{action:"kill"}` (ownership-checked)
    // or trusted `executeOperatorKill(...)`.
    const roster = this.ensureRoster(state)
    const mentions = extractSwarmMentions(post.text)

    // 1. Wake matching swarm_wait waiters
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
      const mentioned = mentions.some((m) =>
        memberMatchesMention(waiter.memberName, m, memberChannels, post.channel),
      )
      if (!waiter.mentionsOnly ? inChannel || mentioned : mentioned) {
        state.waiters.delete(waiter)
        clearTimeout(waiter.timer)
        const allPosts = readBoardPostsFromDisk(state.location.swarmDir)
        const delta = allPosts.filter((p) => p.seq > waiter.since)
        waiter.resolve({
          woke: true,
          posts: delta,
          headSeq: allPosts.reduce((m, p) => Math.max(m, p.seq), 0),
          reason: 'new_post',
        })
      }
    }

    // 2. Wake matching non-killed workers
    for (const [name, member] of Object.entries(roster.members)) {
      if (name === 'coordinator' || member.killed) continue
      if (name.toLowerCase() === post.agent.toLowerCase()) continue
      const mentioned = mentions.some((m) =>
        memberMatchesMention(name, m, member.channels ?? ['main'], post.channel),
      )
      const channelMatch =
        member.wake_mode === 'all' &&
        (post.channel === 'main' || (member.channels ?? ['main']).includes(post.channel))
      if (mentioned || channelMatch) {
        this.scheduleWorkerRun(state, name)
      }
    }
  }

  /** Runtime-wide concurrency semaphore shared across ALL coordinator sessions (IMPORTANT 5). */
  private async acquireWorkerSlot(state: SwarmSessionState, signal: AbortSignal): Promise<boolean> {
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

  private scheduleWorkerRun(state: SwarmSessionState, workerName: string): void {
    if (state.shuttingDown || !this.executor) return
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
    rt.running = true
    rt.pendingWake = false
    const run = this.runWorkerLoop(state, rt).finally(() => {
      if (rt && rt.runPromise === run) rt.runPromise = null
    })
    rt.runPromise = run
  }

  private async runWorkerLoop(state: SwarmSessionState, rt: WorkerRuntimeState): Promise<void> {
    try {
      while (!state.shuttingDown) {
        const roster = this.ensureRoster(state)
        const member = roster.members[rt.name]
        if (!member || member.killed) return

        const allPosts = readBoardPostsFromDisk(state.location.swarmDir)
        const unread = allPosts.filter((p) => p.seq > (member.last_read_seq ?? 0))
        if (unread.length === 0 && !rt.pendingWake) return
        rt.pendingWake = false

        const relevant = unread.filter((p) => {
          if (p.agent.toLowerCase() === rt.name.toLowerCase()) return false
          const mentions = extractSwarmMentions(p.text)
          return (
            mentions.some((m) => memberMatchesMention(rt.name, m, member.channels ?? ['main'], p.channel)) ||
            (member.wake_mode === 'all' &&
              (p.channel === 'main' || (member.channels ?? ['main']).includes(p.channel)))
          )
        })
        // Cursor of posts actually inspected/consumed in this turn (NEVER advance past
        // newer messages that arrive while `runWorkerTurn` is executing — IMPORTANT 3).
        const consumedSeq = unread.reduce((m, p) => Math.max(m, p.seq), member.last_read_seq ?? 0)
        if (relevant.length === 0) {
          member.last_read_seq = Math.max(member.last_read_seq ?? 0, consumedSeq)
          this.saveRoster(state, roster)
          return
        }

        const ac = new AbortController()
        rt.abortController = ac
        const gotSlot = await this.acquireWorkerSlot(state, ac.signal)
        if (!gotSlot) {
          rt.abortController = null
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

        try {
          const freshRoster = this.ensureRoster(state)
          const freshMember = freshRoster.members[rt.name]
          if (!freshMember || freshMember.killed) return
          if (
            freshMember.workspace?.path &&
            freshMember.workspace.mode !== 'inherit' &&
            !existsSync(freshMember.workspace.path)
          ) {
            throw new Error(`SWARM_WORKTREE_MISSING:${freshMember.workspace.path}`)
          }
          freshMember.phase = 'RUNNING'
          freshMember.last_read_seq = Math.max(freshMember.last_read_seq ?? 0, consumedSeq)
          this.saveRoster(state, freshRoster)

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
            signal: ac.signal,
            onTelemetry: (ev) => {
              rt.stepCounter += 1
              this.appendTranscriptStep(state, freshMember.conversation_id, rt.stepCounter, ev)
            },
          })

          // Check if worker posted on the board during its turn; if not, post its summary/error so coordinator is never stuck.
          const afterPosts = readBoardPostsFromDisk(state.location.swarmDir)
          const ownPostsDuringTurn = afterPosts.filter(
            (p) => p.seq > consumedSeq && p.agent.toLowerCase() === rt.name.toLowerCase(),
          )
          const latestRoster = this.ensureRoster(state)
          const latestMember = latestRoster.members[rt.name]
          if (latestMember && !latestMember.killed && !ac.signal.aborted) {
            let postedFallbackSeq = 0
            if (ownPostsDuringTurn.length === 0) {
              const fallbackText = result.error
                ? `@coordinator [worker-error] ${result.error}`
                : result.text.trim()
                  ? `@coordinator ${result.text.trim().slice(0, 6000)}`
                  : '@coordinator 已完成本轮执行（无额外文本输出）。'
              const posted = this.appendBoardPost(state, {
                agent: rt.name,
                channel: (latestMember.channels ?? ['main']).find((c) => c !== 'main') ?? 'main',
                text: fallbackText,
              })
              postedFallbackSeq = posted.seq
            }
            // Only advance `last_read_seq` to `consumedSeq` (NOT whole-board headSeq!),
            // so any directed message from another member that arrived mid-turn remains
            // unread and is delivered on the next loop iteration (IMPORTANT 3).
            const refreshedRoster = this.ensureRoster(state)
            const refreshedMember = refreshedRoster.members[rt.name]
            if (refreshedMember && !refreshedMember.killed) {
              refreshedMember.phase = 'WAITING'
              refreshedMember.wait_since = Math.max(
                consumedSeq,
                postedFallbackSeq,
                ...ownPostsDuringTurn.map((p) => p.seq),
              )
              refreshedMember.last_read_seq = Math.max(refreshedMember.last_read_seq ?? 0, consumedSeq)
              this.saveRoster(state, refreshedRoster)
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          rt.stepCounter += 1
          const errRoster = this.ensureRoster(state)
          const errMember = errRoster.members[rt.name]
          if (errMember) {
            this.appendTranscriptStep(state, errMember.conversation_id, rt.stepCounter, {
              type: 'ERROR',
              status: 'ERROR',
              error: msg,
            })
            if (!errMember.killed && !ac.signal.aborted && !state.shuttingDown) {
              errMember.phase = 'WAITING'
              this.saveRoster(state, errRoster)
              this.appendBoardPost(state, {
                agent: rt.name,
                channel: 'main',
                text: `@coordinator [worker-error] ${msg.slice(0, 500)}`,
              })
            }
          }
        } finally {
          activeMcpContexts.delete(turnSessionKey)
          rt.abortController = null
          this.releaseWorkerSlot()
        }

        // Re-check unread messages in case a new directed post arrived during the turn.
        const postTurnRoster = this.ensureRoster(state)
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
    } finally {
      rt.running = false
      this.checkIdleWaiters(state)
    }
  }

  private checkIdleWaiters(state: SwarmSessionState): void {
    const anyRunning = [...state.workers.values()].some((w) => w.running)
    if (anyRunning) return
    const allPosts = readBoardPostsFromDisk(state.location.swarmDir)
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

  private async killMemberInternal(
    state: SwarmSessionState,
    targetName: string,
    _reason: string,
    opts?: { forceDirtyWorktree?: boolean; stopWaitTimeoutMs?: number },
  ): Promise<{
    killed: string[]
    unconfirmed: string[]
    alreadyKilled: string[]
    notFound: boolean
    preservedDirtyWorktrees: string[]
  }> {
    const roster = this.ensureRoster(state)
    const lower = targetName.toLowerCase()
    const matchedNames = Object.keys(roster.members).filter((name) => {
      const n = name.toLowerCase()
      if (n === 'coordinator') return false
      return n === lower || (n.startsWith(`${lower}-`) && /^\d+$/.test(n.slice(lower.length + 1)))
    })
    if (matchedNames.length === 0) {
      return { killed: [], unconfirmed: [], alreadyKilled: [], notFound: true, preservedDirtyWorktrees: [] }
    }
    const killed: string[] = []
    const unconfirmed: string[] = []
    const alreadyKilled: string[] = []
    const preservedDirtyWorktrees: string[] = []
    const waitMs = Math.max(50, opts?.stopWaitTimeoutMs ?? 5_000)

    for (const name of matchedNames) {
      const rec = roster.members[name]!
      if (rec.killed) {
        alreadyKilled.push(name)
        continue
      }
      rec.killed = true
      rec.phase = 'KILLED'
      // Persist killed=true and revoke active MCP token immediately so concurrent wakes/calls fail closed.
      this.saveRoster(state, roster)
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
      if (rec.workspace?.path && rec.workspace.mode !== 'inherit') {
        const wtRes = removeWorkerGitWorktree(state.workspaceCwd, rec.workspace.path, {
          forceDirty: opts?.forceDirtyWorktree,
        })
        if (wtRes.preservedDirtyPath) {
          preservedDirtyWorktrees.push(wtRes.preservedDirtyPath)
        }
      }
      killed.push(name)
    }
    this.saveRoster(state, roster)
    return { killed, unconfirmed, alreadyKilled, notFound: false, preservedDirtyWorktrees }
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

    if (input.tool === 'post_message') {
      const text = typeof input.args.text === 'string' ? input.args.text.trim() : ''
      if (!text) throw new Error('SWARM_POST_EMPTY')
      const roster = this.ensureRoster(state)
      const requestedCh = typeof input.args.channel === 'string' ? input.args.channel.trim() : ''
      const defaultCh =
        caller === 'coordinator'
          ? 'main'
          : (roster.members[caller]?.channels ?? ['main']).find((c) => c !== 'main') ?? 'main'
      const channel = requestedCh || defaultCh
      if (channel !== 'main' && roster.channels[channel]?.archived) {
        throw new Error(`SWARM_CHANNEL_ARCHIVED:${channel}`)
      }
      const post = this.appendBoardPost(state, { agent: caller, channel, text })
      return { ok: true, seq: post.seq, channel: post.channel, time: post.time }
    }

    if (input.tool === 'read_board') {
      const since =
        typeof input.args.since === 'number' && Number.isFinite(input.args.since) && input.args.since >= 0
          ? Math.floor(input.args.since)
          : 0
      const rawLimit =
        typeof input.args.limit === 'number' && Number.isFinite(input.args.limit)
          ? Math.floor(input.args.limit)
          : DEFAULT_READ_BOARD_LIMIT
      const limit = Math.max(1, Math.min(MAX_READ_BOARD_LIMIT, rawLimit))
      const channelFilter = typeof input.args.channel === 'string' ? input.args.channel.trim() : ''
      const roster = this.ensureRoster(state)
      const memberChannels = roster.members[caller]?.channels ?? ['main']
      const allPosts = readBoardPostsFromDisk(state.location.swarmDir)
      const filtered = allPosts.filter((p) => {
        if (p.seq <= since) return false
        if (channelFilter === '*') return true
        if (channelFilter) return p.channel === channelFilter
        if (caller === 'coordinator') return true
        return p.channel === 'main' || memberChannels.includes(p.channel)
      })
      const truncated = filtered.length > limit
      const boundedPosts = truncated ? filtered.slice(filtered.length - limit) : filtered
      const headSeq = allPosts.reduce((m, p) => Math.max(m, p.seq), 0)
      const readCursor = boundedPosts.reduce((m, p) => Math.max(m, p.seq), since)
      if (roster.members[caller]) {
        roster.members[caller]!.last_read_seq = Math.max(roster.members[caller]!.last_read_seq ?? 0, readCursor)
        this.saveRoster(state, roster)
      }
      return {
        ok: true,
        head_seq: headSeq,
        truncated,
        total_matching: filtered.length,
        posts: boundedPosts,
      }
    }

    if (input.tool === 'swarm_wait') {
      const since =
        typeof input.args.since === 'number' && Number.isFinite(input.args.since) && input.args.since >= 0
          ? Math.floor(input.args.since)
          : 0
      const mentionsOnly = input.args.mentions_only !== false
      const channel = typeof input.args.channel === 'string' ? input.args.channel.trim() : undefined
      const rawTimeout =
        typeof input.args.timeout_ms === 'number' && Number.isFinite(input.args.timeout_ms)
          ? Math.floor(input.args.timeout_ms)
          : typeof input.args.timeout_seconds === 'number' && Number.isFinite(input.args.timeout_seconds)
            ? Math.floor(input.args.timeout_seconds * 1_000)
            : DEFAULT_WAIT_TIMEOUT_MS
      const timeoutMs = Math.max(1_000, Math.min(MAX_WAIT_TIMEOUT_MS, rawTimeout))

      const roster = this.ensureRoster(state)
      const memberChannels = roster.members[caller]?.channels ?? ['main']
      const existing = readBoardPostsFromDisk(state.location.swarmDir)
      const headSeq = existing.reduce((m, p) => Math.max(m, p.seq), 0)
      const alreadyMatching = existing.filter((p) => {
        if (p.seq <= since) return false
        if (p.agent.toLowerCase() === caller.toLowerCase()) return false
        if (channel && channel !== '*' && p.channel !== channel) return false
        const mentions = extractSwarmMentions(p.text)
        const mentioned = mentions.some((m) => memberMatchesMention(caller, m, memberChannels, p.channel))
        const inChannel = caller === 'coordinator' || p.channel === 'main' || memberChannels.includes(p.channel)
        return mentionsOnly ? mentioned : inChannel || mentioned
      })
      if (alreadyMatching.length > 0) {
        return { ok: true, woke: true, head_seq: headSeq, posts: alreadyMatching, reason: 'already_available' }
      }

      const anyRunning = [...state.workers.values()].some((w) => w.running)
      if (!anyRunning && caller === 'coordinator') {
        const delta = existing.filter((p) => p.seq > since)
        return { ok: true, woke: false, head_seq: headSeq, posts: delta, reason: 'no_working_members' }
      }

      const waited = await new Promise<{ woke: boolean; posts: BoardPostRecord[]; headSeq: number; reason: string }>(
        (resolveWait) => {
          const timer = setTimeout(() => {
            state.waiters.delete(entry)
            const cur = readBoardPostsFromDisk(state.location.swarmDir)
            resolveWait({
              woke: false,
              posts: cur.filter((p) => p.seq > since),
              headSeq: cur.reduce((m, p) => Math.max(m, p.seq), 0),
              reason: 'timeout',
            })
          }, timeoutMs)
          timer.unref?.()
          const entry: WaiterEntry = {
            memberName: caller,
            since,
            mentionsOnly,
            channel,
            resolve: resolveWait,
            timer,
          }
          state.waiters.add(entry)
        },
      )
      return { ok: true, woke: waited.woke, head_seq: waited.headSeq, posts: waited.posts, reason: waited.reason }
    }

    // tool === 'swarm'
    const action = typeof input.args.action === 'string' ? input.args.action.trim().toLowerCase() : ''
    const roster = this.ensureRoster(state)

    if (action === 'title') {
      if (caller !== 'coordinator') throw new Error('SWARM_TITLE_COORDINATOR_ONLY')
      const title = typeof input.args.title === 'string' ? input.args.title.trim().slice(0, 120) : ''
      if (!title) throw new Error('SWARM_TITLE_REQUIRED')
      roster.title = title
      this.saveRoster(state, roster)
      return { ok: true, title }
    }

    if (action === 'status') {
      const allPosts = readBoardPostsFromDisk(state.location.swarmDir)
      const headSeq = allPosts.reduce((m, p) => Math.max(m, p.seq), 0)
      const members = Object.entries(roster.members).map(([name, m]) => ({
        name,
        role: m.role,
        model: m.model,
        status: m.killed
          ? 'killed'
          : state.workers.get(name)?.running || (name === 'coordinator' && m.phase === 'RUNNING')
            ? 'working'
            : 'waiting',
        channels: m.channels,
        workspace: m.workspace?.path ?? state.workspaceCwd,
        workspace_mode: m.workspace?.mode ?? 'inherit',
      }))
      return {
        ok: true,
        swarm_id: state.location.swarmId,
        title: roster.title,
        head_seq: headSeq,
        members,
        channels: Object.entries(roster.channels).map(([name, ch]) => ({
          name,
          ...(ch.topic ? { topic: ch.topic } : {}),
          ...(ch.archived ? { archived: true } : {}),
        })),
      }
    }

    if (action === 'models') {
      return {
        ok: true,
        current_model: state.model,
        note: 'Leave model omitted on add so workers inherit the active session model.',
      }
    }

    if (action === 'channel') {
      const op = typeof input.args.op === 'string' ? input.args.op.trim().toLowerCase() : 'list'
      if (op === 'list') {
        return {
          ok: true,
          channels: Object.entries(roster.channels).map(([name, ch]) => ({
            name,
            ...(ch.topic ? { topic: ch.topic } : {}),
            ...(ch.archived ? { archived: true } : {}),
            subscribers: Object.values(roster.members).filter((m) => !m.killed && (m.channels ?? []).includes(name))
              .length,
          })),
        }
      }
      const chName = typeof input.args.channel === 'string' ? input.args.channel.trim().toLowerCase() : ''
      if (!CHANNEL_NAME_RE.test(chName) || chName === 'main') {
        throw new Error('SWARM_CHANNEL_NAME_INVALID')
      }
      if (op === 'create') {
        if (Object.keys(roster.channels).length >= SWARM_MAX_CHANNELS && !roster.channels[chName]) {
          throw new Error('SWARM_CHANNEL_LIMIT_REACHED')
        }
        const topic = typeof input.args.topic === 'string' ? input.args.topic.trim().slice(0, 160) : undefined
        roster.channels[chName] = { ...(topic ? { topic } : {}), creator: caller, archived: false }
        this.saveRoster(state, roster)
        return { ok: true, channel: chName, topic }
      }
      if (op === 'archive') {
        if (!roster.channels[chName]) throw new Error('SWARM_CHANNEL_NOT_FOUND')
        roster.channels[chName]!.archived = true
        this.saveRoster(state, roster)
        return { ok: true, channel: chName, archived: true }
      }
      if (op === 'subscribe' || op === 'unsubscribe' || op === 'join' || op === 'leave') {
        const target =
          typeof input.args.name === 'string' && input.args.name.trim()
            ? input.args.name.trim().toLowerCase()
            : caller
        const member = roster.members[target]
        if (!member) throw new Error('SWARM_MEMBER_NOT_FOUND')
        if (!roster.channels[chName]) throw new Error('SWARM_CHANNEL_NOT_FOUND')
        const set = new Set(member.channels ?? ['main'])
        if (op === 'subscribe' || op === 'join') set.add(chName)
        else set.delete(chName)
        set.add('main')
        member.channels = [...set]
        this.saveRoster(state, roster)
        return { ok: true, name: target, channels: member.channels }
      }
      throw new Error(`SWARM_CHANNEL_OP_UNSUPPORTED:${op}`)
    }

    if (action === 'add') {
      const baseName = typeof input.args.name === 'string' ? input.args.name.trim().toLowerCase() : ''
      const brief = typeof input.args.brief === 'string' ? input.args.brief.trim() : ''
      if (!MEMBER_NAME_RE.test(baseName) || RESERVED_MEMBER_NAMES.has(baseName)) {
        throw new Error('SWARM_MEMBER_NAME_INVALID')
      }
      if (!brief) throw new Error('SWARM_BRIEF_REQUIRED')

      const tasksArr = Array.isArray(input.args.tasks)
        ? input.args.tasks.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        : null
      const nRaw = typeof input.args.n === 'number' && Number.isInteger(input.args.n) ? input.args.n : 1
      const count = tasksArr ? Math.min(tasksArr.length, MAX_SHARD_ADD) : Math.max(1, Math.min(nRaw, MAX_SHARD_ADD))
      const requestedWorkspace =
        input.args.workspace === 'share' || input.args.workspace === 'branch' ? input.args.workspace : 'inherit'
      const requestedChannels = Array.isArray(input.args.channels)
        ? input.args.channels
            .filter((c): c is string => typeof c === 'string' && CHANNEL_NAME_RE.test(c.trim().toLowerCase()))
            .map((c) => c.trim().toLowerCase())
        : []
      const workerModel =
        typeof input.args.model === 'string' && input.args.model.trim() ? input.args.model.trim() : state.model

      const specs: Array<{ name: string; fullBrief: string }> =
        count === 1 && !tasksArr
          ? [{ name: baseName, fullBrief: brief }]
          : Array.from({ length: count }, (_, idx) => ({
              name: `${baseName}-${idx + 1}`,
              fullBrief: tasksArr ? `${brief}\n\n[Shard Target]: ${tasksArr[idx]}` : brief,
            }))

      if (Object.keys(roster.members).length + specs.length > SWARM_MAX_MEMBERS) {
        throw new Error('SWARM_MEMBER_LIMIT_REACHED')
      }

      const added: Array<{ name: string; workspace_mode: string; workspace: string; seq: number }> = []
      const primaryChannel = requestedChannels[0] || 'main'
      if (primaryChannel !== 'main' && !roster.channels[primaryChannel]) {
        roster.channels[primaryChannel] = { creator: caller }
      }
      const memberChannels = [...new Set(['main', ...requestedChannels])]

      for (const spec of specs) {
        if (roster.members[spec.name]) {
          throw new Error(`SWARM_MEMBER_EXISTS:${spec.name}`)
        }
        const convId = randomUUID()
        const ws =
          requestedWorkspace === 'inherit'
            ? { mode: 'inherit' as const }
            : createWorkerGitWorktree(state.workspaceCwd, state.location.swarmId, spec.name, requestedWorkspace)
        const existingHead = readBoardPostsFromDisk(state.location.swarmDir).reduce((m, p) => Math.max(m, p.seq), 0)
        roster.members[spec.name] = {
          conversation_id: convId,
          role: inferMemberRole(spec.name),
          model: workerModel,
          phase: 'RUNNING',
          wake_mode: 'mentions',
          wait_since: existingHead,
          last_read_seq: existingHead,
          killed: false,
          channels: memberChannels,
          workspace: ws,
          added_by: caller,
        }
        this.saveRoster(state, roster)
        const post = this.appendBoardPost(state, {
          agent: caller,
          channel: primaryChannel,
          text: `@${spec.name} ${spec.fullBrief}`,
          kind: 'brief',
        })
        added.push({
          name: spec.name,
          workspace_mode: ws.mode,
          workspace: 'path' in ws ? ws.path : state.workspaceCwd,
          seq: post.seq,
        })
      }
      return { ok: true, added }
    }

    if (action === 'kill') {
      const target = typeof input.args.name === 'string' ? input.args.name.trim().toLowerCase() : ''
      if (!target) throw new Error('SWARM_MEMBER_NAME_REQUIRED')
      if (caller !== 'coordinator') {
        const rec = roster.members[target]
        if (!rec || rec.added_by !== caller) {
          throw new Error('SWARM_KILL_FORBIDDEN')
        }
      }
      const res = await this.killMemberInternal(state, target, 'tool_kill')
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
      const rec = roster.members[target]
      if (!rec) throw new Error(`SWARM_MEMBER_NOT_FOUND:${target}`)
      if (state.workers.get(target)?.running) {
        throw new Error(`SWARM_MEMBER_BUSY:${target}`)
      }
      rec.model = nextModel
      this.saveRoster(state, roster)
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
      waiter.resolve({ woke: false, posts: [], headSeq: state.boardSeqKnown, reason: 'session_shutdown' })
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
      const roster = this.ensureRoster(state)
      for (const rec of Object.values(roster.members)) {
        if (rec.workspace?.path && rec.workspace.mode !== 'inherit') {
          const wtRes = removeWorkerGitWorktree(state.workspaceCwd, rec.workspace.path)
          if (wtRes.preservedDirtyPath) {
            preservedDirtyWorktrees.push(wtRes.preservedDirtyPath)
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
