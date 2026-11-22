/**
 * Async file-lock, symlink-safe IO, and fail-closed roster persistence helpers
 * for `RemoteSwarmRuntime` (OCV5-835 / P0-3 / P1-1).
 *
 * Key invariants:
 *   1. Zero synchronous busy-wait: `.board.lock` and `.roster.lock` use an in-process
 *      per-lock-path Promise queue combined with async jittered `setTimeout` backoff.
 *   2. Compatible with `swarmCommand.ts` `.board.lock` (`O_CREAT | O_EXCL | O_NOFOLLOW`,
 *      `${pid}:${ts}\n` payload, stale lock eviction, pre/post `assertSafeSwarmDir` dev/ino check).
 *   3. Fail-closed roster reads: `members.json` is ONLY initialized on `ENOENT`. Corrupt JSON,
 *      permission errors, symlinks, or transient IO errors ALWAYS throw instead of silently
 *      overwriting `members.json` with an empty roster.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join, sep } from 'node:path'

export interface RemoteSwarmLocation {
  readonly brainDir: string
  readonly swarmId: string
  readonly swarmDir: string
}

export interface RosterMemberRecord {
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

export interface RosterChannelRecord {
  topic?: string
  creator?: string
  archived?: boolean
}

export interface RosterPendingAddRecord {
  op_id: string
  created_at: number
}

export interface RosterFile {
  runtime?: 'remote'
  title: string
  session_key?: string
  workspace_cwd?: string
  members: Record<string, RosterMemberRecord>
  channels: Record<string, RosterChannelRecord>
  pending_adds?: Record<string, RosterPendingAddRecord>
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

export const BOARD_LOCK_MAX_WAIT_MS = 5_000
export const BOARD_LOCK_STALE_MS = 30_000
export const ROSTER_LOCK_MAX_WAIT_MS = 5_000
export const ROSTER_LOCK_STALE_MS = 30_000

const lockQueues = new Map<string, Promise<void>>()

export function formatBoardTimestamp(now = new Date()): string {
  return now.toISOString().replace('T', ' ').slice(0, 19)
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

export function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`
  const payload = JSON.stringify(data, null, 2)
  try {
    writeFileSync(tmpPath, payload, { mode: 0o600 })
    renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {
      /* ignore cleanup failure */
    }
    throw err
  }
}

export function assertSafeSwarmDir(location: RemoteSwarmLocation): { dev: number; ino: number } {
  const rootStat = lstatSync(location.brainDir)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('SWARM_BOARD_SYMLINK_REJECTED')
  }
  const realRoot = realpathSync(location.brainDir)
  let cur = location.brainDir
  let lastStat = rootStat
  for (const seg of [location.swarmId, '.system_generated', 'swarm']) {
    cur = join(cur, seg)
    const st = lstatSync(cur)
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error('SWARM_BOARD_SYMLINK_REJECTED')
    }
    lastStat = st
  }
  const realSwarm = realpathSync(cur)
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
  if (!realSwarm.startsWith(prefix)) {
    throw new Error('SWARM_BOARD_SYMLINK_REJECTED')
  }
  return { dev: lastStat.dev, ino: lastStat.ino }
}

export function appendBoardLineNoSymlink(swarmDir: string, line: string): void {
  const boardPath = join(swarmDir, 'board.jsonl')
  let fd: number | null = null
  try {
    const flags =
      fsConstants.O_WRONLY |
      fsConstants.O_APPEND |
      fsConstants.O_CREAT |
      (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)
    fd = openSync(boardPath, flags, 0o600)
    const fst = fstatSync(fd)
    if (!fst.isFile()) {
      throw new Error('SWARM_BOARD_SYMLINK_REJECTED')
    }
    writeSync(fd, line, null, 'utf8')
  } catch (err: any) {
    if (err?.code === 'ELOOP') throw new Error('SWARM_BOARD_SYMLINK_REJECTED')
    throw err
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

export function readBoardPostsFromDisk(swarmDir: string): BoardPostRecord[] {
  const boardPath = join(swarmDir, 'board.jsonl')
  let fd: number | null = null
  let raw = ''
  try {
    const lst = lstatSync(boardPath)
    if (lst.isSymbolicLink() || !lst.isFile()) {
      throw new Error('SWARM_BOARD_SYMLINK_REJECTED')
    }
    const flags =
      fsConstants.O_RDONLY |
      (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)
    fd = openSync(boardPath, flags)
    const fst = fstatSync(fd)
    if (!fst.isFile() || fst.dev !== lst.dev || fst.ino !== lst.ino) {
      throw new Error('SWARM_BOARD_SYMLINK_REJECTED')
    }
    raw = readFileSync(fd, 'utf8')
  } catch (err: any) {
    if (err?.code === 'ENOENT') return []
    if (err?.code === 'ELOOP') throw new Error('SWARM_BOARD_SYMLINK_REJECTED')
    throw err
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
  const posts: BoardPostRecord[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>
      if (!obj || typeof obj !== 'object') continue
      const seq =
        typeof obj.seq === 'number' && Number.isFinite(obj.seq)
          ? Math.floor(obj.seq)
          : posts.length + 1
      posts.push({
        seq,
        agent: typeof obj.agent === 'string' && obj.agent.trim() ? obj.agent.trim() : 'unknown',
        channel:
          typeof obj.channel === 'string' && obj.channel.trim() ? obj.channel.trim() : 'main',
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

function lockErrorCodes(lockFileName: '.board.lock' | '.roster.lock') {
  return lockFileName === '.roster.lock'
    ? {
        symlink: 'SWARM_ROSTER_SYMLINK_REJECTED',
        timeout: 'SWARM_ROSTER_LOCK_TIMEOUT',
        defaultMaxWaitMs: ROSTER_LOCK_MAX_WAIT_MS,
        defaultStaleMs: ROSTER_LOCK_STALE_MS,
      }
    : {
        symlink: 'SWARM_BOARD_SYMLINK_REJECTED',
        timeout: 'SWARM_BOARD_LOCK_TIMEOUT',
        defaultMaxWaitMs: BOARD_LOCK_MAX_WAIT_MS,
        defaultStaleMs: BOARD_LOCK_STALE_MS,
      }
}

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(1, ms))
  })
}

function tryCreateExclusiveLockFile(lockPath: string, symlinkCode: string): boolean {
  const flags =
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_WRONLY |
    (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)
  let fd: number | null = null
  try {
    fd = openSync(lockPath, flags, 0o600)
    writeSync(fd, `${process.pid}:${Date.now()}\n`, null, 'utf8')
    return true
  } catch (err: any) {
    if (err?.code === 'ELOOP') throw new Error(symlinkCode)
    if (err?.code === 'EEXIST') return false
    throw err
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

function inspectAndMaybeEvictStaleLock(
  lockPath: string,
  staleMs: number,
  symlinkCode: string,
): boolean {
  try {
    const st = lstatSync(lockPath)
    if (st.isSymbolicLink()) throw new Error(symlinkCode)
    if (Date.now() - st.mtimeMs > staleMs) {
      unlinkSync(lockPath)
      return true
    }
    return false
  } catch (err: any) {
    if (err?.message === symlinkCode) throw err
    // Lock disappeared or raced with another unlinker
    return false
  }
}

function enqueueLockTask<T>(queueKey: string, task: () => Promise<T>): Promise<T> {
  const prev = lockQueues.get(queueKey) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(task)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  lockQueues.set(queueKey, tail)
  void tail.finally(() => {
    if (lockQueues.get(queueKey) === tail) {
      lockQueues.delete(queueKey)
    }
  })
  return run
}

/**
 * In-process per-lock-file Promise queue + async jittered backoff exclusive file lock.
 * Never blocks the Node.js event loop (zero synchronous busy-wait).
 */
export function withAsyncSwarmFileLock<T>(
  location: RemoteSwarmLocation,
  lockFileName: '.board.lock' | '.roster.lock',
  fn: () => T | Promise<T>,
  opts?: { maxWaitMs?: number; staleMs?: number },
): Promise<T> {
  const codes = lockErrorCodes(lockFileName)
  const lockPath = join(location.swarmDir, lockFileName)
  const maxWaitMs = Math.max(20, opts?.maxWaitMs ?? codes.defaultMaxWaitMs)
  const staleMs = Math.max(100, opts?.staleMs ?? codes.defaultStaleMs)

  return enqueueLockTask(lockPath, async () => {
    ensurePrivateDir(location.swarmDir)
    const dirId = assertSafeSwarmDir(location)
    const deadline = Date.now() + maxWaitMs
    let acquired = false
    let attempt = 0

    while (!acquired) {
      acquired = tryCreateExclusiveLockFile(lockPath, codes.symlink)
      if (acquired) break

      const evictedStale = inspectAndMaybeEvictStaleLock(lockPath, staleMs, codes.symlink)
      if (evictedStale) continue

      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error(codes.timeout)
      }
      attempt += 1
      const baseDelay = Math.min(40, 8 + attempt * 4)
      const jitter = Math.floor(Math.random() * 12)
      await sleepAsync(Math.min(remaining, baseDelay + jitter))
    }

    try {
      const afterId = assertSafeSwarmDir(location)
      if (afterId.dev !== dirId.dev || afterId.ino !== dirId.ino) {
        throw new Error(codes.symlink)
      }
      return await fn()
    } finally {
      try {
        unlinkSync(lockPath)
      } catch {
        /* ignore */
      }
    }
  })
}

/**
 * Non-blocking exclusive file lock (single acquire + at most one retry after stale eviction).
 * Used ONLY by synchronous callbacks (such as `postGatewayStallAlert` invoked from
 * `AntigravitySwarmWatcher.onStallDetected`) where awaiting is impossible and event-loop
 * spinning is strictly forbidden.
 */
export function withSwarmFileLockNonBlocking<T>(
  location: RemoteSwarmLocation,
  lockFileName: '.board.lock' | '.roster.lock',
  fn: () => T,
  opts?: { staleMs?: number },
): T {
  const codes = lockErrorCodes(lockFileName)
  const staleMs = Math.max(100, opts?.staleMs ?? codes.defaultStaleMs)
  ensurePrivateDir(location.swarmDir)
  const dirId = assertSafeSwarmDir(location)
  const lockPath = join(location.swarmDir, lockFileName)

  let acquired = tryCreateExclusiveLockFile(lockPath, codes.symlink)
  if (!acquired) {
    const evictedStale = inspectAndMaybeEvictStaleLock(lockPath, staleMs, codes.symlink)
    if (evictedStale) {
      acquired = tryCreateExclusiveLockFile(lockPath, codes.symlink)
    }
  }
  if (!acquired) {
    throw new Error(codes.timeout)
  }

  try {
    const afterId = assertSafeSwarmDir(location)
    if (afterId.dev !== dirId.dev || afterId.ino !== dirId.ino) {
      throw new Error(codes.symlink)
    }
    return fn()
  } finally {
    try {
      unlinkSync(lockPath)
    } catch {
      /* ignore */
    }
  }
}

function makeDefaultCoordinatorRecord(swarmId: string, model: string): RosterMemberRecord {
  return {
    conversation_id: swarmId,
    role: 'coordinator',
    model,
    phase: 'RUNNING',
    wake_mode: 'mentions',
    wait_since: 0,
    last_read_seq: 0,
    killed: false,
    channels: ['main'],
  }
}

/**
 * Strictly read `members.json` with `O_NOFOLLOW` and dev/ino verification.
 * Returns `null` ONLY on `ENOENT`. Any symlink, corrupt JSON, invalid schema,
 * or permission/IO error throws fail-closed and NEVER overwrites disk state.
 */
export function readRosterStrict(
  location: RemoteSwarmLocation,
  opts?: { defaultModel?: string; sessionKey?: string; workspaceCwd?: string },
): RosterFile | null {
  const membersPath = join(location.swarmDir, 'members.json')
  let fd: number | null = null
  let raw = ''
  try {
    const lst = lstatSync(membersPath)
    if (lst.isSymbolicLink() || !lst.isFile()) {
      throw new Error('SWARM_ROSTER_SYMLINK_REJECTED')
    }
    const flags =
      fsConstants.O_RDONLY |
      (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)
    fd = openSync(membersPath, flags)
    const fst = fstatSync(fd)
    if (!fst.isFile() || fst.dev !== lst.dev || fst.ino !== lst.ino) {
      throw new Error('SWARM_ROSTER_SYMLINK_REJECTED')
    }
    raw = readFileSync(fd, 'utf8')
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null
    if (err?.code === 'ELOOP' || err?.message === 'SWARM_ROSTER_SYMLINK_REJECTED') {
      throw new Error('SWARM_ROSTER_SYMLINK_REJECTED')
    }
    const code = typeof err?.code === 'string' ? err.code : 'UNKNOWN'
    throw new Error(`SWARM_ROSTER_IO_ERROR:${code}:${err instanceof Error ? err.message : String(err)}`)
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`SWARM_ROSTER_CORRUPT:${err instanceof Error ? err.message : String(err)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SWARM_ROSTER_CORRUPT:root_not_object')
  }
  const obj = parsed as Record<string, unknown>
  // NB4: A valid roster MUST explicitly contain a plain `members` object; never fabricate
  // a default coordinator from a truncated/unknown JSON object like `{}` or `{"title":"x"}`.
  if (
    !obj.members ||
    typeof obj.members !== 'object' ||
    Array.isArray(obj.members)
  ) {
    throw new Error('SWARM_ROSTER_CORRUPT:members_not_object')
  }
  if (
    obj.channels !== undefined &&
    (!obj.channels || typeof obj.channels !== 'object' || Array.isArray(obj.channels))
  ) {
    throw new Error('SWARM_ROSTER_CORRUPT:channels_not_object')
  }
  if (
    obj.pending_adds !== undefined &&
    (!obj.pending_adds || typeof obj.pending_adds !== 'object' || Array.isArray(obj.pending_adds))
  ) {
    throw new Error('SWARM_ROSTER_CORRUPT:pending_adds_not_object')
  }

  const members: Record<string, RosterMemberRecord> = {
    ...(obj.members as Record<string, RosterMemberRecord>),
  }
  const channels: Record<string, RosterChannelRecord> = obj.channels
    ? { ...(obj.channels as Record<string, RosterChannelRecord>) }
    : { main: { topic: '主频道' } }
  if (!channels.main) {
    channels.main = { topic: '主频道' }
  }
  if (!members.coordinator) {
    members.coordinator = makeDefaultCoordinatorRecord(
      location.swarmId,
      opts?.defaultModel ?? '',
    )
  }
  const pendingAdds = obj.pending_adds
    ? { ...(obj.pending_adds as Record<string, RosterPendingAddRecord>) }
    : undefined
  const sessionKey =
    typeof obj.session_key === 'string' && obj.session_key.trim()
      ? obj.session_key.trim()
      : opts?.sessionKey
  const workspaceCwd =
    typeof obj.workspace_cwd === 'string' && obj.workspace_cwd.trim()
      ? obj.workspace_cwd.trim()
      : opts?.workspaceCwd

  return {
    runtime: 'remote',
    title: typeof obj.title === 'string' && obj.title.trim() ? obj.title : '蜂群协作',
    ...(sessionKey ? { session_key: sessionKey } : {}),
    ...(workspaceCwd ? { workspace_cwd: workspaceCwd } : {}),
    members,
    channels,
    ...(pendingAdds && Object.keys(pendingAdds).length > 0 ? { pending_adds: pendingAdds } : {}),
  }
}

/**
 * Read an existing `members.json` strictly or initialize a brand-new roster ONLY on `ENOENT`.
 * Must be invoked while holding `.roster.lock` for mutating paths.
 */
export function readOrInitRosterStrict(
  location: RemoteSwarmLocation,
  init: { model: string; sessionKey?: string; workspaceCwd?: string },
): { roster: RosterFile; initialized: boolean } {
  ensurePrivateDir(location.swarmDir)
  assertSafeSwarmDir(location)
  const existing = readRosterStrict(location, {
    defaultModel: init.model,
    sessionKey: init.sessionKey,
    workspaceCwd: init.workspaceCwd,
  })
  if (existing) {
    return { roster: existing, initialized: false }
  }
  const fresh: RosterFile = {
    runtime: 'remote',
    title: '蜂群协作',
    ...(init.sessionKey ? { session_key: init.sessionKey } : {}),
    ...(init.workspaceCwd ? { workspace_cwd: init.workspaceCwd } : {}),
    members: {
      coordinator: makeDefaultCoordinatorRecord(location.swarmId, init.model),
    },
    channels: {
      main: { topic: '主频道' },
    },
  }
  atomicWriteJson(join(location.swarmDir, 'members.json'), fresh)
  return { roster: fresh, initialized: true }
}
