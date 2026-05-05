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
 * TTL:
 *   24h for both `transient` and `session_missing` (Codex review tweak,
 *   Plan v2.1). Beyond that the entry is unlinked with a structured warn
 *   so ops sees we lost data — but at least the loss is loud.
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
  type V3MasterSinkPayload,
  type V3SinkErrorClass,
} from './v3MasterSink.js'

const log = createLogger({ module: 'v3MasterRetryQueue' })

/** Per-entry TTL. Beyond this the entry is unlinked with a structured
 *  warn. 24h covers most operational glitches (long master outage,
 *  prolonged auth misconfig, etc.) without keeping bytes around forever. */
export const ENTRY_TTL_MS = 24 * 60 * 60 * 1000

/** Periodic drain interval. The drainer is also kicked on enqueue
 *  (post-failure) and on startup. 30s is a compromise between catching
 *  a master that just came back up and not banging on a master that's
 *  still down. */
export const DEFAULT_DRAIN_INTERVAL_MS = 30_000

/** Default queue dir = ${HOME}/v3-master-retry.d. Distinct from the
 *  legacy msgOutbox jsonl. Override for tests via deps. */
export function defaultQueueDir(): string {
  return join(paths.home, 'v3-master-retry.d')
}

export interface V3MasterRetryEntry {
  schemaVersion: 1
  payload: V3MasterSinkPayload & { createdAt: number }
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
  enqueueDurable(entry: V3MasterRetryEntry): Promise<void>
  drainOnce(): Promise<DrainStats>
  /** Fire-and-forget kick. Used by enqueue+post-attempt callers and the
   *  periodic timer. Always single-flight. */
  kick(): void
  startPeriodic(): void
  stopPeriodic(): void
  /** Inspect-only — used by tests + metrics. */
  pendingCount(): Promise<number>
}

export interface MakeV3MasterRetryQueueDeps {
  /** Where to put files. Defaults to defaultQueueDir(). */
  dir?: string
  /** The single-attempt sender. The queue calls this to drain entries. */
  attemptSend: (payload: V3MasterSinkPayload) => Promise<void>
  /** Override only for tests. */
  now?: () => number
  /** Override only for tests. */
  drainIntervalMs?: number
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
  }

  async function enqueueDurable(entry: V3MasterRetryEntry): Promise<void> {
    await ensureDir()
    const filepath = join(dir, entryFilename())
    await atomicWriteJson(filepath, entry)
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
          // Schedule a fresh drain after current event-loop tick — avoids
          // unbounded recursion if drain finishes synchronously.
          setImmediate(() => kick())
        }
      })
  }

  /**
   * One drain pass. ENOENT-tolerant throughout: entries can vanish under
   * us (concurrent kick, manual ops cleanup, simultaneous gateway
   * instance) and that's fine. Each file independently:
   *   - read JSON; malformed → unlink + warn (it'll never parse).
   *   - TTL-check by firstSeenAt → unlink + warn if exceeded.
   *   - call attemptSend(payload):
   *     - success → unlink.
   *     - V3SinkError fatal → unlink + warn.
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
        log.warn('v3MasterRetryQueue: malformed entry, unlinking', { name }, err)
        await unlinkIgnoreEnoent(filepath)
        continue
      }
      // TTL check.
      if (now() - entry.firstSeenAt > ENTRY_TTL_MS) {
        stats.ttlDropped++
        log.warn('v3MasterRetryQueue: entry TTL exceeded, dropping', {
          name,
          sessionId: entry.payload.sessionId,
          turnIndex: entry.payload.turnIndex,
          attempts: entry.attempts,
          lastErrorClass: entry.lastErrorClass,
          firstSeenAt: entry.firstSeenAt,
        })
        await unlinkIgnoreEnoent(filepath)
        continue
      }
      // Attempt.
      try {
        await deps.attemptSend(entry.payload)
        stats.drained++
        await unlinkIgnoreEnoent(filepath)
      } catch (err) {
        if (err instanceof V3SinkError && err.errorClass === 'fatal') {
          stats.fatalDropped++
          log.warn(
            'v3MasterRetryQueue: fatal sink error, unlinking',
            {
              name,
              sessionId: entry.payload.sessionId,
              turnIndex: entry.payload.turnIndex,
              httpStatus: err.httpStatus,
            },
            err,
          )
          await unlinkIgnoreEnoent(filepath)
          continue
        }
        // transient / session_missing / unknown — bump attempts + rewrite.
        stats.retried++
        stats.pending++
        const cls: V3SinkErrorClass =
          err instanceof V3SinkError ? err.errorClass : 'transient'
        const updated: V3MasterRetryEntry = {
          ...entry,
          attempts: entry.attempts + 1,
          lastErrorClass: cls,
          lastErrorAt: now(),
          lastErrorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
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
    }
    return stats
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

  return {
    enqueueDurable,
    drainOnce,
    kick,
    startPeriodic,
    stopPeriodic,
    pendingCount,
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
  return true
}

