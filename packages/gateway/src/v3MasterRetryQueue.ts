/**
 * Container-side durable retry queue for the v3 master server-authored
 * sink.
 *
 * Why file-per-entry instead of jsonl rewrite?
 *   The natural shape — append every entry to a single jsonl file and
 *   rewrite the whole file on each successful drain — has a fatal race
 *   under concurrent turn-ends + a long drainer pass:
 *
 *     T0  drainer reads outbox.jsonl (entries A, B)
 *     T1  turn end appends C
 *     T2  drainer rewrites outbox.jsonl with the entries it didn't
 *         drain (let's say B failed) — atomic .tmp rename
 *     T3  C is gone.
 *
 *   File-per-entry sidesteps it: each turn-end writes its own
 *   `<ts>-<rand>.json` (atomic .tmp rename) and the drainer unlinks
 *   files individually after success. Concurrent enqueues can never
 *   collide with a drainer rewrite because there's no rewrite at all —
 *   only per-file unlink and per-file atomic-rename when bumping
 *   attempt count.
 *
 * Why a directory inside HOME instead of paths.msgOutbox?
 *   `msgOutbox` is the legacy local-SQLite outbox (`appendServerAuthored
 *   MessageDurable` falls back there). It uses a single jsonl file +
 *   replayMsgOutbox on startup, which permanently drops session_not_found
 *   entries — exactly the behaviour we're trying to replace for v3
 *   commercial. Mixing the two queues into the same file would mean
 *   v3-sink retries get TTL-dropped with the same logic that broke us
 *   originally. Separate dir = separate semantics.
 *
 * Retention:
 *   Valid paid-turn entries have no age-based deletion. They remain until
 *   master acknowledges the write or explicitly returns 410 SESSION_DELETED.
 *   Only locally malformed bytes are renamed to *.quarantine. Valid entries
 *   remain actively retryable across every non-410 remote response.
 *
 * Single-flight drainer:
 *   In-memory boolean lock. Enqueue can kick a fresh drain attempt that
 *   no-ops if one's already running. The periodic timer kicks one every
 *   30s. Startup also kicks one (boot replay).
 */

import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { paths } from '@openclaude/storage'

import { createLogger } from './logger.js'
import {
  V3SinkError,
  type V3MasterSinkWirePayload,
  type V3SinkErrorClass,
} from './v3MasterSink.js'

const log = createLogger({ module: 'v3MasterRetryQueue' })

/** Kept for source compatibility with older tests/metrics. Valid entries are
 * no longer deleted at this age (lossless paid-output retention policy). */
export const ENTRY_TTL_MS = 24 * 60 * 60 * 1000

/** Periodic drain interval. The drainer is also kicked on enqueue
 *  (post-failure) and on startup. 30s is a compromise between catching
 *  a master that just came back up and not banging on a master that's
 *  still down. */
export const DEFAULT_DRAIN_INTERVAL_MS = 30_000

/**
 * Per-entry 指数退避(基数 / 上限)。
 *
 * 风暴根因(实测 v5):drainer 被频繁 kick —— `enqueueDurable` 每次 turn-end kick()、
 * 且 kick 的 finally 在 pendingKick 时 `setImmediate(kick)` 背靠背重 drain。持续 turn 活动下
 * drainer 对**同一批**未送达 entry 无间隔地一遍遍 attemptSend,把 session_not_found 刷到
 * ~18/s(27k+/25min),旁路了 30s 周期。
 *
 * 对策:每个 entry 失败后按 attempts 退避,未到下次重试时刻就跳过本轮 attemptSend(不调
 * master)。这只**推迟**重试、绝不按年龄删除;有效内容一直保留到 ACK。借鉴 Claude Code AutoCompact
 * 断路器思想(小概率异常路径在规模下也是大浪费)。
 */
export const RETRY_BACKOFF_BASE_MS = 5_000
export const RETRY_BACKOFF_MAX_MS = 5 * 60_000
/** attempts=0 → 0(新 entry 立即可发);1 → 5s;2 → 10s;… 封顶 5min。 */
export function retryBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0
  const exp = Math.min(attempts - 1, 20)
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** exp, RETRY_BACKOFF_MAX_MS)
}

/** 重 kick 最小间隔。pendingKick 时不再 `setImmediate` 背靠背(配合退避后每轮多为
 *  "读文件+跳过",仍会 file-read 自旋占满 event loop → 已知 v3 wedge 类隐患)。
 *  改为延迟重 kick,把 drain 轮次封顶到 ~1/s;新 entry 最多等此值。 */
export const MIN_REKICK_GAP_MS = 1_000

/** Default queue dir = ${HOME}/v3-master-retry.d. Distinct from the
 *  legacy msgOutbox jsonl. Override for tests via deps. */
export function defaultQueueDir(): string {
  return join(paths.home, 'v3-master-retry.d')
}

export interface V3MasterRetryEntry {
  schemaVersion: 1
  /** Wire payload shape — agentId optional so legacy on-disk entries
   *  (pre-2026-05-13, before the agentId disambiguator was added) can
   *  still be drained after a gateway upgrade. New entries always carry
   *  agentId because live callers in sessionManager use the strict
   *  V3MasterSinkPayload variant that requires it. */
  payload: V3MasterSinkWirePayload & { createdAt: number }
  firstSeenAt: number
  attempts: number
  lastErrorClass?: V3SinkErrorClass
  lastErrorAt?: number
  /** Truncated error message; never the bearer / payload body. */
  lastErrorMessage?: string
}

export interface DrainStats {
  considered: number
  drained: number
  retried: number
  ttlDropped: number
  fatalDropped: number
  errors: number
  /** Entry remained queued (transient/session_missing, attempts bumped). */
  pending: number
}

export interface V3MasterRetryQueue {
  /** Persist before the first network attempt. Returns an opaque receipt. */
  stageDurable(entry: V3MasterRetryEntry): Promise<string>
  /** Remove only after master success or an explicit 410 deletion ACK. */
  ackDurable(receipt: string): Promise<void>
  enqueueDurable(entry: V3MasterRetryEntry): Promise<void>
  drainOnce(): Promise<DrainStats>
  /** Fire-and-forget kick. Used by enqueue+post-attempt callers and the
   *  periodic timer. Always single-flight. */
  kick(): void
  startPeriodic(): void
  stopPeriodic(): void
  /** Inspect-only — used by tests + metrics. */
  pendingCount(): Promise<number>
  /** RFC-v5-durable-turn-dispatch §3 boot recovery ① — is there a staged entry
   *  for this (dispatchId, attemptNo)? True = tape was already fsynced before
   *  the crash → the inbox row can safely go sink_staged (the drainer will
   *  deliver it). Scans on-disk entries; ENOENT-tolerant. */
  hasEntryForDispatch(dispatchId: string, attemptNo: number): Promise<boolean>
}

export interface MakeV3MasterRetryQueueDeps {
  /** Where to put files. Defaults to defaultQueueDir(). */
  dir?: string
  /** The single-attempt sender. The queue calls this to drain entries.
   *  Accepts the wire shape (agentId optional) so legacy entries written
   *  by a pre-Fix-A gateway image can still be drained. */
  attemptSend: (payload: V3MasterSinkWirePayload) => Promise<void>
  /** Override only for tests. */
  now?: () => number
  /** Override only for tests. */
  drainIntervalMs?: number
  /** RFC-v5-durable-turn-dispatch §3/§B6 — deferred master ACK for a durable-inbox
   *  entry (first attempt failed, drained later). Fires only for entries whose
   *  payload carries a `dispatchId`; drives the container inbox row to terminal.
   *  M-R1-1 ① — **returns terminal-confirmed**: `true` when the inbox terminal CAS landed
   *  (or is already terminal — idempotent); `false` when the terminal write failed. The drainer
   *  deletes the on-disk entry only on `true`; a `false` keeps the entry (backoff + retry) so a
   *  master-ACK'd tape whose local terminal CAS failed never silently stays `sink_staged`. */
  onDispatchAck?: (
    dispatchId: string,
    attemptNo: number,
    status: 'completed' | 'interrupted' | 'crashed',
  ) => boolean | Promise<boolean>
}

export function makeV3MasterRetryQueue(deps: MakeV3MasterRetryQueueDeps): V3MasterRetryQueue {
  const dir = deps.dir ?? defaultQueueDir()
  const now = deps.now ?? (() => Date.now())
  const drainIntervalMs = deps.drainIntervalMs ?? DEFAULT_DRAIN_INTERVAL_MS

  let draining = false
  let pendingKick = false
  let periodicTimer: ReturnType<typeof setInterval> | null = null

  async function ensureDir(): Promise<void> {
    await mkdir(dir, { recursive: true })
  }

  function entryFilename(): string {
    // 13-digit ms ts + 8 hex bytes random; lex-sortable, collision-free
    // even with multiple turns finishing in the same millisecond.
    return `${now()}-${randomBytes(8).toString('hex')}.json`
  }

  async function atomicWriteJson(filepath: string, data: unknown): Promise<void> {
    const tmp = `${filepath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    const json = JSON.stringify(data)
    // Use open+writeFile+close so we can fsync before rename — without
    // fsync the rename can land before the file content reaches disk on
    // a power loss. Cheap belt-and-braces on a path that runs once per
    // turn-end retry.
    const fh = await open(tmp, 'w')
    try {
      await fh.writeFile(json, 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, filepath)
    await fsyncDir()
  }

  async function fsyncDir(): Promise<void> {
    const fh = await open(dir, 'r')
    try {
      await fh.sync()
    } finally {
      await fh.close()
    }
  }

  async function stageDurable(entry: V3MasterRetryEntry): Promise<string> {
    await ensureDir()
    const receipt = entryFilename()
    const filepath = join(dir, receipt)
    await atomicWriteJson(filepath, entry)
    return receipt
  }

  async function ackDurable(receipt: string): Promise<void> {
    if (!/^[0-9]+-[0-9a-f]+\.json$/.test(receipt)) {
      throw new Error('invalid v3 master retry receipt')
    }
    await unlinkIgnoreEnoent(join(dir, receipt))
    await fsyncDir().catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    })
  }

  async function enqueueDurable(entry: V3MasterRetryEntry): Promise<void> {
    await stageDurable(entry)
    // Don't await the kick — it's single-flight inside the queue and
    // drains in its own promise chain. Awaiting would couple the
    // caller's turn-end to the entire drain pass which can be long.
    kick()
  }

  function kick(): void {
    if (draining) {
      pendingKick = true
      return
    }
    draining = true
    drainOnce()
      .catch((err) => {
        log.error('v3MasterRetryQueue.drainOnce threw', undefined, err)
      })
      .finally(() => {
        draining = false
        if (pendingKick) {
          pendingKick = false
          // 延迟重 kick(非 setImmediate 背靠背):配合 per-entry 退避后,每轮多为"读文件+跳过",
          // setImmediate 会让 drainer 在持续 enqueue 下自旋占满 event loop(已知 v3 wedge 类隐患:
          // healthz timeout)。MIN_REKICK_GAP_MS 把 drain 轮次封顶到 ~1/s。unref 不阻进程退出。
          const t = setTimeout(() => kick(), MIN_REKICK_GAP_MS)
          if (typeof t.unref === 'function') t.unref()
        }
      })
  }

  /**
   * One drain pass. ENOENT-tolerant throughout: entries can vanish under
   * us (concurrent kick, manual ops cleanup, simultaneous gateway
   * instance) and that's fine. Each file independently:
   *   - read JSON; malformed → quarantine + warn (bytes retained).
   *   - call attemptSend(payload):
   *     - success → unlink.
   *     - V3SinkError fatal+410 → unlink (confirmed deleted session).
   *     - any other fatal → quarantine (contract repair required).
   *     - V3SinkError transient/session_missing → bump attempts, rewrite.
   *     - other throw → bump attempts, rewrite (defensive).
   *
   * We do NOT abort the pass on a single failure — other entries may
   * succeed. We do NOT parallelise either: avoid hammering master in
   * an outage. Sequential, one at a time.
   */
  async function drainOnce(): Promise<DrainStats> {
    const stats: DrainStats = {
      considered: 0,
      drained: 0,
      retried: 0,
      ttlDropped: 0,
      fatalDropped: 0,
      errors: 0,
      pending: 0,
    }
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Dir hasn't been created yet (no enqueues yet) — nothing to do.
        return stats
      }
      throw err
    }
    // Only entries — skip stale .tmp-* and anything that isn't *.json.
    const entries = names.filter((n) => n.endsWith('.json') && !n.includes('.tmp-'))
    // Lex sort ≈ time order (filename starts with ms ts) — drain oldest
    // first so a long-pending entry gets a fresh attempt sooner.
    entries.sort()

    for (const name of entries) {
      stats.considered++
      const filepath = join(dir, name)
      let raw: string
      try {
        raw = await readFile(filepath, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // Vanished under us — fine.
          continue
        }
        stats.errors++
        log.warn('v3MasterRetryQueue: read failed', { name }, err)
        continue
      }
      let entry: V3MasterRetryEntry
      try {
        const parsed = JSON.parse(raw) as unknown
        if (!isV3MasterRetryEntry(parsed)) {
          throw new Error('schema mismatch')
        }
        entry = parsed
      } catch (err) {
        stats.fatalDropped++
        log.warn('v3MasterRetryQueue: malformed entry, quarantining', { name }, err)
        await quarantine(filepath, 'malformed')
        await fsyncDir()
        continue
      }
      // Per-entry 指数退避:刚失败过(attempts>0)且未到下次重试时刻 → 跳过本轮 attemptSend
      // (不调 master),计为 pending。这是消除"频繁 kick → 无间隔背靠背重发"风暴的关键;
      // 退避不丢数据且没有 TTL。新 entry(attempts=0)或退避已过 → 正常重试。
      if (entry.attempts > 0 && typeof entry.lastErrorAt === 'number') {
        if (now() < entry.lastErrorAt + retryBackoffMs(entry.attempts)) {
          stats.pending++
          continue
        }
      }
      // Attempt.
      try {
        await deps.attemptSend(entry.payload)
        // M-R1-1 ①:顺序反转 —— master ACK 成功后,**先**驱动 durable inbox 终态(仅 dispatch turn),
        // 终态 CAS 确认(onDispatchAck 返回 true)才 ackDurable 删文件。写失败(返回 false)→ 保留
        // 文件:tape 已在 master(finalize 幂等),下轮 drain 重试终态迁移(inbox CAS 幂等)。bump
        // attempts + lastErrorAt 让退避生效,避免"终态一直写不进"时热重传 tape 打满 master。
        const terminalConfirmed = await driveDispatchTerminal(entry.payload, name)
        if (terminalConfirmed) {
          stats.drained++
          await ackDurable(name)
        } else {
          stats.retried++
          stats.pending++
          await rewriteAfterFailure(
            filepath,
            entry,
            'transient',
            'inbox terminal CAS write failed after master ACK',
            name,
            stats,
          )
        }
      } catch (err) {
        if (
          err instanceof V3SinkError &&
          err.errorClass === 'fatal' &&
          err.httpStatus === 410
        ) {
          stats.fatalDropped++
          log.warn(
            'v3MasterRetryQueue: session deletion acknowledged, unlinking',
            {
              name,
              sessionId: entry.payload.sessionId,
              turnIndex: entry.payload.turnIndex,
              httpStatus: err.httpStatus,
            },
            err,
          )
          await ackDurable(name)
          continue
        }
        // Every non-410 response can be caused by a rolling deployment,
        // migration skew or repaired contract bug. Keep the valid paid tape
        // on the active queue and retry without an age/count cap.
        stats.retried++
        stats.pending++
        const cls: V3SinkErrorClass =
          err instanceof V3SinkError ? err.errorClass : 'transient'
        await rewriteAfterFailure(
          filepath,
          entry,
          cls,
          err instanceof Error ? err.message : String(err),
          name,
          stats,
        )
      }
    }
    return stats
  }

  /**
   * M-R1-1 ① — drive the durable inbox row to terminal after a successful master ACK.
   * Returns `true` when there is nothing to converge (non-dispatch entry) or the terminal
   * migration is confirmed (onDispatchAck resolved `true` / already terminal); `false` when the
   * terminal write failed (hook resolved `false` or threw) so the caller keeps the entry.
   */
  async function driveDispatchTerminal(
    payload: V3MasterSinkWirePayload & { createdAt: number },
    name: string,
  ): Promise<boolean> {
    const { dispatchId, attemptNo, status } = payload
    if (!deps.onDispatchAck || typeof dispatchId !== 'string' || typeof attemptNo !== 'number') {
      return true
    }
    try {
      return await deps.onDispatchAck(dispatchId, attemptNo, status)
    } catch (hookErr) {
      log.warn('v3MasterRetryQueue: onDispatchAck hook threw; retaining entry', { name }, hookErr)
      return false
    }
  }

  /** Bump attempts + lastError* and atomically rewrite the entry so per-entry backoff applies.
   *  Shared by the send-failure path and the M-R1-1 terminal-CAS-unconfirmed path. ENOENT (dir
   *  vanished mid-pass) is tolerated; any other write error counts as an error stat. */
  async function rewriteAfterFailure(
    filepath: string,
    entry: V3MasterRetryEntry,
    lastErrorClass: V3SinkErrorClass,
    lastErrorMessage: string,
    name: string,
    stats: DrainStats,
  ): Promise<void> {
    const updated: V3MasterRetryEntry = {
      ...entry,
      attempts: entry.attempts + 1,
      lastErrorClass,
      lastErrorAt: now(),
      lastErrorMessage,
    }
    try {
      await atomicWriteJson(filepath, updated)
    } catch (writeErr) {
      if ((writeErr as NodeJS.ErrnoException).code === 'ENOENT') {
        // Dir vanished mid-pass. Re-create on next enqueue.
        log.warn('v3MasterRetryQueue: dir vanished during retry rewrite', { name })
      } else {
        stats.errors++
        log.error('v3MasterRetryQueue: retry rewrite failed', { name }, writeErr)
      }
    }
  }

  function startPeriodic(): void {
    if (periodicTimer) return
    periodicTimer = setInterval(() => kick(), drainIntervalMs)
    // Don't keep the event loop alive just for this timer.
    if (typeof periodicTimer.unref === 'function') periodicTimer.unref()
  }

  function stopPeriodic(): void {
    if (periodicTimer) {
      clearInterval(periodicTimer)
      periodicTimer = null
    }
  }

  async function pendingCount(): Promise<number> {
    try {
      const names = await readdir(dir)
      return names.filter((n) => n.endsWith('.json') && !n.includes('.tmp-')).length
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw err
    }
  }

  async function hasEntryForDispatch(dispatchId: string, attemptNo: number): Promise<boolean> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
    for (const name of names.filter((n) => n.endsWith('.json') && !n.includes('.tmp-'))) {
      let raw: string
      try {
        raw = await readFile(join(dir, name), 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
        continue
      }
      try {
        const parsed = JSON.parse(raw) as { payload?: { dispatchId?: unknown; attemptNo?: unknown } }
        if (parsed?.payload?.dispatchId === dispatchId && parsed?.payload?.attemptNo === attemptNo) {
          return true
        }
      } catch {
        // malformed — irrelevant to this lookup
      }
    }
    return false
  }

  return {
    stageDurable,
    ackDurable,
    enqueueDurable,
    drainOnce,
    kick,
    startPeriodic,
    stopPeriodic,
    pendingCount,
    hasEntryForDispatch,
  }
}

async function quarantine(path: string, reason: string): Promise<void> {
  const quarantined = `${path}.quarantine-${reason}-${Date.now()}`
  try {
    await rename(path, quarantined)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}

async function unlinkIgnoreEnoent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}

function isV3MasterRetryEntry(v: unknown): v is V3MasterRetryEntry {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (o.schemaVersion !== 1) return false
  if (typeof o.firstSeenAt !== 'number' || !Number.isFinite(o.firstSeenAt)) return false
  if (typeof o.attempts !== 'number' || !Number.isFinite(o.attempts)) return false
  const p = o.payload as Record<string, unknown> | undefined
  if (!p || typeof p !== 'object') return false
  if (typeof p.sessionId !== 'string' || p.sessionId.length === 0) return false
  if (typeof p.turnIndex !== 'number' || !Number.isInteger(p.turnIndex)) return false
  if (p.status !== 'completed' && p.status !== 'interrupted' && p.status !== 'crashed') return false
  if (typeof p.text !== 'string') return false
  if (typeof p.createdAt !== 'number' || !Number.isFinite(p.createdAt)) return false
  // agentId added 2026-05-13 — optional for legacy on-disk entries. When
  // present it must match the master-side charset
  // (`[A-Za-z0-9_-]{1,64}`) so the resulting messageId is safely embeddable
  // in URLs/log fields and matches what master's BodySchema will accept.
  // A malformed agentId on disk would just get rejected by master with 400
  // INVALID_BODY (fatal classification → drop), so we screen it here to
  // avoid that round trip and the misleading fatal-warn log line.
  if (p.agentId !== undefined) {
    if (typeof p.agentId !== 'string') return false
    if (p.agentId.length === 0 || p.agentId.length > 64) return false
    if (!/^[A-Za-z0-9_-]+$/.test(p.agentId)) return false
  }
  return true
}
