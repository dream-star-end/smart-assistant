#!/usr/bin/env -S npx tsx
/**
 * sessions-fix-oversized.ts — One-shot ops script that strips inline base64
 * media (and, if needed, truncates client-authored history) from
 * `client_sessions.messages` rows whose serialized JSON exceeds the storage
 * cap (`MAX_SESSION_BYTES = 4MB`).
 *
 * Why this exists: the cap was added in 2026-05-08 alongside the gateway PUT
 * 2MB body cap and the client 1.25MB attachment cap. Every WRITE path now
 * rejects oversized bodies, but the prod DB still has historical rows
 * accumulated before those guards landed. They cause:
 *   - main-thread stalls on each gateway boot (outbox replay JSON.parse)
 *   - permanent client `_oversized` toasts (preflight rejects every PUT)
 *   - server-authored writes blocked because finalized merged JSON > 4MB
 *
 * What it does, per row whose serialized UTF-8 byte length exceeds
 * `--threshold-bytes`:
 *   1. Wraps the entire row in a `BEGIN IMMEDIATE` SQLite transaction so
 *      concurrent gateway writes can't race the read-modify-write. Acquires
 *      the write lock up front to avoid `db.transaction(fn)`'s default
 *      DEFERRED mode (Codex P1).
 *   2. Archives the original `messages` JSON to `client_sessions_archive`
 *      keyed by `(id, archived_at)`. Lets us roll a row back manually if
 *      stripping turns out to have dropped something the user wanted.
 *   3. Stage 1 — strip media: walks every message, replaces each `_media[i]`
 *      entry with a metadata-only stub (`{kind, mimeType, filename, size,
 *      base64Stripped: true, _strippedAt}`) and runs a defensive deep-walk
 *      that catches any other `data:…;base64,…` data URI (>4KB) anywhere
 *      under the message, replacing it with a `[stripped:base64,bytes=N]`
 *      placeholder. The deep walk catches places `_media`-only stripping
 *      misses (legacy `dataUrl` field, childBlocks images, tool-result
 *      base64).
 *   4. Stage 2 — truncate (only if Stage 1 didn't get the row under the
 *      threshold): keeps every `_source === 'server'` message verbatim
 *      because they're load-bearing for `server_authored_request_map` and
 *      `pending_usage_patches`. Drops oldest non-server-authored messages
 *      until the row fits the budget. Replaces the dropped span with a
 *      single synthetic system message (`role: 'system'`, `_truncated: true`)
 *      whose ts is the earliest dropped message's ts so it sorts to the
 *      original position.
 *   5. Re-runs `normalizeAndAssignSeqs(oldMsgs, finalMsgs, currentNextSeq)`
 *      so every message we touched (content changed → fresh `_seq`) and the
 *      new placeholder (new id → fresh `_seq`) get monotonic seq numbers
 *      strictly greater than anything the client may have cached. Without
 *      this the partial-GET protocol (`?since=<seq>` in sync.js) would
 *      serve an empty tail back to the client and the bloated local IDB
 *      copy would never be replaced. (Codex P1 from plan review.)
 *   6. Persists `messages`, `message_count`, `next_seq`, and bumps
 *      `updated_at = now` so the next client `meta.updatedAt > local._syncedAt`
 *      check fires a fresh GET. Does NOT touch `last_at` (nothing
 *      conversation-wise actually happened on the user's behalf).
 *
 * Idempotency:
 *   - Re-runs find no rows past the threshold and exit clean.
 *   - Each row's archive carries a unique `archived_at` timestamp so reruns
 *     don't violate the archive PK.
 *
 * Refusal path:
 *   - If `_source === 'server'` messages alone exceed the threshold (which
 *     means a write-path guard was bypassed in the past — should be
 *     unreachable), the script ROLLBACKs that row and prints `[FAIL]`. We
 *     never silently delete server-authored rows.
 *
 * Usage:
 *   npx tsx scripts/sessions-fix-oversized.ts \
 *     [--db <path>]            (default: $OPENCLAUDE_HOME/sessions.db)
 *     [--threshold-bytes N]    (default: 4194304 — MAX_SESSION_BYTES)
 *     [--target-bytes N]       (default: 2097152 — Stage-2 truncation budget)
 *     [--dry-run]              (no UPDATE/INSERT; archive table created if missing)
 *     [--id <session-id>]      (process exactly one row, ignores threshold filter)
 *     [--limit N]              (cap rows processed per run)
 *
 * Recommended deploy sequence (per Codex plan-review):
 *   1. Deploy A.1+A.2+A.4+A.5 to prod (already-passed reviews) → restart gateway
 *   2. Stop gateway: `systemctl stop openclaude-gateway` (or v3 commercial equivalent)
 *   3. Dry-run: `npx tsx scripts/sessions-fix-oversized.ts --dry-run`
 *   4. Real run: `npx tsx scripts/sessions-fix-oversized.ts`
 *   5. (Optional) `sqlite3 sessions.db 'PRAGMA wal_checkpoint(TRUNCATE);'`
 *   6. Start gateway
 *
 * Exit codes:
 *   0 = all rows processed cleanly (dry-run also returns 0 when no exceptions)
 *   1 = at least one row failed (server-authored alone too large, or unexpected)
 *   2 = usage error (bad CLI arg, db not found)
 */

import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeAndAssignSeqs } from '../packages/storage/src/sessionsDb.js'

// ── CLI parsing ──────────────────────────────────────────────────────────────
type Args = {
  db: string
  thresholdBytes: number
  targetBytes: number
  dryRun: boolean
  id: string | null
  limit: number | null
}

function parseArgs(argv: string[]): Args {
  const home = process.env.OPENCLAUDE_HOME ?? join(homedir(), '.openclaude')
  const out: Args = {
    db: join(home, 'sessions.db'),
    thresholdBytes: 4 * 1024 * 1024,
    targetBytes: 2 * 1024 * 1024,
    dryRun: false,
    id: null,
    limit: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) {
        console.error(`missing value for ${a}`)
        process.exit(2)
      }
      return v
    }
    if (a === '--db') out.db = next()
    else if (a === '--threshold-bytes') out.thresholdBytes = parseInt(next(), 10)
    else if (a === '--target-bytes') out.targetBytes = parseInt(next(), 10)
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--id') out.id = next()
    else if (a === '--limit') out.limit = parseInt(next(), 10)
    else if (a === '-h' || a === '--help') {
      console.log(
        `Usage: npx tsx scripts/sessions-fix-oversized.ts [--db PATH] [--threshold-bytes N] [--target-bytes N] [--dry-run] [--id ID] [--limit N]`
      )
      process.exit(0)
    } else {
      console.error(`unknown arg: ${a}`)
      process.exit(2)
    }
  }
  if (!Number.isFinite(out.thresholdBytes) || out.thresholdBytes <= 0) {
    console.error('--threshold-bytes must be a positive integer')
    process.exit(2)
  }
  if (!Number.isFinite(out.targetBytes) || out.targetBytes <= 0) {
    console.error('--target-bytes must be a positive integer')
    process.exit(2)
  }
  if (out.targetBytes > out.thresholdBytes) {
    console.error('--target-bytes must be ≤ --threshold-bytes')
    process.exit(2)
  }
  return out
}

// ── Stripping helpers ────────────────────────────────────────────────────────

// Permissive on data: URI parameter list — historical data may include
// formats like `data:image/svg+xml;charset=utf-8;base64,…`. The original
// `^data:[\w/+.\-]+;base64,` rejected those. (Codex review-2 suggestion.)
const DATA_URI_RE = /^data:[^,;]+(?:;[^,;]+)*;base64,/
// Below this size we don't bother stripping a data URI — small inline pixels
// (placeholders, tiny icons) are not the source of the bloat and stripping
// them confuses message rendering with nothing meaningful to gain.
const DATA_URI_MIN_STRIP_BYTES = 4 * 1024

type Counters = {
  mediaStripped: number
  inlineBase64Stripped: number
}

/**
 * Recursively walk an arbitrary value, replacing any string leaf that looks
 * like an inline `data:…;base64,…` URI (and is large enough to matter) with a
 * `[stripped:…]` placeholder. Mutates objects/arrays in place because the
 * caller already cloned via JSON.parse and only uses the resulting value
 * once. Returns the (possibly replaced) value so it can be reassigned for
 * string inputs.
 *
 * Only strips strings; numbers/booleans/null untouched. Skips known small
 * dimensions (size < DATA_URI_MIN_STRIP_BYTES).
 */
function deepStripInlineBase64(value: unknown, counters: Counters): unknown {
  if (typeof value === 'string') {
    if (value.length >= DATA_URI_MIN_STRIP_BYTES && DATA_URI_RE.test(value)) {
      counters.inlineBase64Stripped++
      return `[stripped:base64,bytes=${value.length}]`
    }
    return value
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = deepStripInlineBase64(value[i], counters)
    }
    return value
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const k of Object.keys(obj)) {
      obj[k] = deepStripInlineBase64(obj[k], counters)
    }
    return value
  }
  return value
}

/**
 * Strip every `_media[i]` entry inside a single message to a metadata stub.
 * Returns the count of entries stripped (so the report can show "media
 * stripped: N"). Mutates the message in place.
 */
function stripMediaArrayInPlace(msg: Record<string, unknown>, now: number): number {
  const media = msg._media
  if (!Array.isArray(media)) return 0
  let count = 0
  for (let i = 0; i < media.length; i++) {
    const entry = media[i]
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    // Only count + replace if there's actually heavy data here. If a previous
    // strip already ran (`base64Stripped: true`), keep the stub as-is so we
    // don't bump archive count or _strippedAt unnecessarily.
    const hasHeavy =
      (typeof e.base64 === 'string' && e.base64.length > 0) ||
      (typeof e.dataUrl === 'string' && e.dataUrl.length > 0)
    if (!hasHeavy) continue
    const origSize =
      typeof e.size === 'number'
        ? e.size
        : typeof e.base64 === 'string'
          ? e.base64.length
          : typeof e.dataUrl === 'string'
            ? e.dataUrl.length
            : 0
    media[i] = {
      kind: e.kind ?? 'file',
      mimeType: e.mimeType ?? null,
      filename: e.filename ?? null,
      size: origSize,
      base64Stripped: true,
      _strippedAt: now,
    }
    count++
  }
  return count
}

// ── Stage 2 truncation ───────────────────────────────────────────────────────

type Msg = Record<string, unknown> & { id?: string; ts?: number; role?: string; _source?: string; _seq?: number }

/**
 * Decide which non-server-authored messages to keep so the final serialized
 * JSON fits within `targetBytes` (soft budget) while respecting
 * `thresholdBytes` (hard ceiling). Returns the kept message array (in
 * original order) plus diagnostics about what was dropped.
 *
 * Algorithm:
 *   1. Always keep all `_source === 'server'` messages.
 *   2. For the remaining (client-authored) messages, scan newest→oldest and
 *      include each one until the running serialized-budget would exceed
 *      `targetBytes`.
 *   3. The dropped span is replaced by ONE synthetic placeholder system
 *      message located at the earliest-dropped ts (so it sorts to the
 *      correct position when we re-sort).
 *
 * Hard-fail condition: the only state we refuse to handle is when
 * `_source === 'server'` messages alone exceed `thresholdBytes` (Codex
 * review-2). Earlier this gated on `targetBytes` which was too strict —
 * a 2.5MB server + 5.5MB client row should drop all client and ship at
 * 2.5MB, even if 2.5MB > target (2MB). The script only refuses to delete
 * server-authored rows.
 */
function truncateToFitBudget(
  msgs: Msg[],
  targetBytes: number,
  thresholdBytes: number,
  sessionId: string,
): { finalMsgs: Msg[]; droppedCount: number; droppedBytes: number } | null {
  // Conservative budget headroom: each kept item also costs the array
  // separator (`,`). 2 bytes per message is plenty even with surrounding `[]`.
  const SEPARATOR_BYTES = 2

  // Partition by authorship
  const serverKept: Msg[] = []
  const clientCandidates: Array<{ msg: Msg; bytes: number }> = []
  let serverBytes = 0
  for (const m of msgs) {
    const bytes = Buffer.byteLength(JSON.stringify(m), 'utf8') + SEPARATOR_BYTES
    if (m && m._source === 'server') {
      serverKept.push(m)
      serverBytes += bytes
    } else {
      clientCandidates.push({ msg: m, bytes })
    }
  }

  if (serverBytes >= thresholdBytes) {
    // Even after dropping every client-authored message we'd be over the
    // hard cap. Refuse — see header comment.
    return null
  }

  // Sort candidates newest→oldest by ts (fallback to original order via
  // index for stable behavior on missing ts)
  const idxOf = new Map<Msg, number>()
  msgs.forEach((m, i) => idxOf.set(m, i))
  const sorted = clientCandidates.slice().sort((a, b) => {
    const ta = typeof a.msg.ts === 'number' ? a.msg.ts : 0
    const tb = typeof b.msg.ts === 'number' ? b.msg.ts : 0
    if (tb !== ta) return tb - ta
    // Tie: later original index wins (treat "later" as newer)
    return (idxOf.get(b.msg) ?? 0) - (idxOf.get(a.msg) ?? 0)
  })

  let used = serverBytes
  const keptClient = new Set<Msg>()
  for (const c of sorted) {
    if (used + c.bytes <= targetBytes) {
      keptClient.add(c.msg)
      used += c.bytes
    }
  }

  // Build dropped list (in original order) for the placeholder
  const dropped: Msg[] = []
  for (const c of clientCandidates) {
    if (!keptClient.has(c.msg)) dropped.push(c.msg)
  }

  if (dropped.length === 0) {
    // Stage 1 already got us under budget; return msgs as-is (sorted by ts).
    return {
      finalMsgs: sortByTsStable(msgs),
      droppedCount: 0,
      droppedBytes: 0,
    }
  }

  const earliestDroppedTs = dropped.reduce(
    (acc, m) => Math.min(acc, typeof m.ts === 'number' ? m.ts : Number.POSITIVE_INFINITY),
    Number.POSITIVE_INFINITY,
  )
  const droppedBytes = dropped.reduce(
    (acc, m) => acc + Buffer.byteLength(JSON.stringify(m), 'utf8'),
    0,
  )
  const placeholder: Msg = {
    id: `truncated-${sessionId}-${Date.now()}`,
    role: 'system',
    text: `[${dropped.length} earlier client-authored message${dropped.length === 1 ? '' : 's'} truncated to fit storage budget. Server-authored rows preserved. Original archived in client_sessions_archive.]`,
    ts: Number.isFinite(earliestDroppedTs) ? earliestDroppedTs : Date.now(),
    _truncated: true,
    _truncatedCount: dropped.length,
    _truncatedBytes: droppedBytes,
  }

  const finalMsgs = sortByTsStable([...serverKept, ...Array.from(keptClient), placeholder])
  return { finalMsgs, droppedCount: dropped.length, droppedBytes }
}

function sortByTsStable<T extends { ts?: number }>(arr: T[]): T[] {
  return arr.slice().sort((a, b) => {
    const ta = typeof a.ts === 'number' ? a.ts : 0
    const tb = typeof b.ts === 'number' ? b.ts : 0
    return ta - tb
  })
}

// ── Per-row processor ────────────────────────────────────────────────────────

type Outcome =
  | { kind: 'strip'; originalBytes: number; finalBytes: number; mediaStripped: number; inlineBase64Stripped: number }
  | { kind: 'truncate'; originalBytes: number; finalBytes: number; mediaStripped: number; inlineBase64Stripped: number; droppedCount: number; droppedBytes: number }
  | { kind: 'fail'; originalBytes: number; reason: string }
  | { kind: 'noop'; originalBytes: number; reason: string }

function processRow(
  db: Database.Database,
  rowKey: { id: string; user_id: string },
  args: Args,
  selectStmt: Database.Statement<unknown[]>,
  archiveStmt: Database.Statement<unknown[]>,
  updateStmt: Database.Statement<unknown[]>,
  archivedAtMonotonic: () => number,
): Outcome {
  // Critical (Codex review-2 P1): SELECT and UPDATE must happen in the same
  // BEGIN IMMEDIATE transaction. Earlier draft did the SELECT outside the
  // transaction during the initial candidate scan, so a concurrent gateway
  // write between scan and txn would let the script clobber a fresher row
  // with a stale stripped version. By re-SELECTing inside the txn we either
  //   (a) see the same row → process normally, or
  //   (b) see a different row → re-validate it's still over threshold; if
  //       not, exit as 'noop' and skip the write.
  let outcome: Outcome | null = null
  const txn = db.transaction(() => {
    const fresh = selectStmt.get(rowKey.id, rowKey.user_id) as
      | { messages: string; next_seq: number | null }
      | undefined
    if (!fresh) {
      outcome = { kind: 'noop', originalBytes: 0, reason: 'row missing or soft-deleted at txn time' }
      return
    }
    const originalBytes = Buffer.byteLength(fresh.messages, 'utf8')
    if (originalBytes <= args.thresholdBytes && !args.id) {
      // Concurrent write already shrank this row past the threshold (or
      // someone else ran the strip). Skip — but only when the user is doing
      // a bulk run; --id explicitly requested this row even if small.
      outcome = {
        kind: 'noop',
        originalBytes,
        reason: `row already ≤ threshold (${originalBytes} ≤ ${args.thresholdBytes})`,
      }
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(fresh.messages)
    } catch (err) {
      outcome = { kind: 'fail', originalBytes, reason: `messages JSON parse failed: ${err}` }
      return
    }
    if (!Array.isArray(parsed)) {
      outcome = { kind: 'fail', originalBytes, reason: 'messages root is not an array' }
      return
    }
    const oldMsgs = parsed as Msg[]
    const now = Date.now()

    // Stage 1 — strip media on a fresh deep clone (so oldMsgs stays
    // untouched for normalizeAndAssignSeqs equality comparison).
    const stage1 = JSON.parse(fresh.messages) as Msg[]
    const counters: Counters = { mediaStripped: 0, inlineBase64Stripped: 0 }
    for (const m of stage1) {
      if (!m || typeof m !== 'object') continue
      counters.mediaStripped += stripMediaArrayInPlace(m as Record<string, unknown>, now)
    }
    for (const m of stage1) {
      deepStripInlineBase64(m, counters)
    }

    let stageJson = JSON.stringify(stage1)
    let stageBytes = Buffer.byteLength(stageJson, 'utf8')

    let finalMsgs: Msg[]
    let outcomeKind: 'strip' | 'truncate'
    let droppedCount = 0
    let droppedBytes = 0

    if (stageBytes <= args.thresholdBytes) {
      finalMsgs = stage1
      outcomeKind = 'strip'
    } else {
      const truncResult = truncateToFitBudget(stage1, args.targetBytes, args.thresholdBytes, rowKey.id)
      if (truncResult === null) {
        outcome = {
          kind: 'fail',
          originalBytes,
          reason: 'server-authored messages alone exceed threshold — refuse to drop server-authored rows',
        }
        return
      }
      finalMsgs = truncResult.finalMsgs
      droppedCount = truncResult.droppedCount
      droppedBytes = truncResult.droppedBytes
      outcomeKind = droppedCount > 0 ? 'truncate' : 'strip'
      stageJson = JSON.stringify(finalMsgs)
      stageBytes = Buffer.byteLength(stageJson, 'utf8')
      if (stageBytes > args.thresholdBytes) {
        outcome = {
          kind: 'fail',
          originalBytes,
          reason: `even after truncation final bytes ${stageBytes} > threshold ${args.thresholdBytes}`,
        }
        return
      }
    }

    // _seq normalization — see header comment for rationale.
    const currentNextSeq =
      typeof fresh.next_seq === 'number' && fresh.next_seq > 0 ? fresh.next_seq : 1
    const { messages: seqedMessages, nextSeq } = normalizeAndAssignSeqs(
      oldMsgs,
      finalMsgs,
      currentNextSeq,
    )

    const finalJson = JSON.stringify(seqedMessages)
    const finalBytes = Buffer.byteLength(finalJson, 'utf8')
    if (finalBytes > args.thresholdBytes) {
      outcome = {
        kind: 'fail',
        originalBytes,
        reason: `post-_seq-normalize bytes ${finalBytes} > threshold ${args.thresholdBytes}`,
      }
      return
    }

    if (args.dryRun) {
      outcome =
        outcomeKind === 'strip'
          ? {
              kind: 'strip',
              originalBytes,
              finalBytes,
              mediaStripped: counters.mediaStripped,
              inlineBase64Stripped: counters.inlineBase64Stripped,
            }
          : {
              kind: 'truncate',
              originalBytes,
              finalBytes,
              mediaStripped: counters.mediaStripped,
              inlineBase64Stripped: counters.inlineBase64Stripped,
              droppedCount,
              droppedBytes,
            }
      // Throw to roll back any phantom writes — txn body returns void; we
      // want the entire txn body to be a no-op when --dry-run. We've also
      // skipped all archiveStmt/updateStmt calls below, so simply returning
      // commits an empty txn (fine).
      return
    }

    archiveStmt.run({
      id: rowKey.id,
      user_id: rowKey.user_id,
      archived_at: archivedAtMonotonic(),
      archive_reason: outcomeKind === 'truncate' ? 'oversized_truncate' : 'oversized_strip',
      original_messages: fresh.messages,
      original_bytes: originalBytes,
    })
    const updateRes = updateStmt.run({
      messages: finalJson,
      message_count: seqedMessages.length,
      next_seq: nextSeq,
      updated_at: now,
      id: rowKey.id,
      user_id: rowKey.user_id,
    })
    if (updateRes.changes !== 1) {
      // Unreachable under BEGIN IMMEDIATE since we just SELECTed the row in
      // the same txn, but defend against future refactors. Throwing here
      // rolls the archive INSERT back too.
      throw new Error(`UPDATE main row affected ${updateRes.changes} rows (expected 1)`)
    }
    outcome =
      outcomeKind === 'strip'
        ? {
            kind: 'strip',
            originalBytes,
            finalBytes,
            mediaStripped: counters.mediaStripped,
            inlineBase64Stripped: counters.inlineBase64Stripped,
          }
        : {
            kind: 'truncate',
            originalBytes,
            finalBytes,
            mediaStripped: counters.mediaStripped,
            inlineBase64Stripped: counters.inlineBase64Stripped,
            droppedCount,
            droppedBytes,
          }
  })
  txn.immediate()

  if (outcome === null) {
    // Defensive — txn body always assigns. Treat as fail.
    return { kind: 'fail', originalBytes: 0, reason: 'txn body did not produce outcome' }
  }
  return outcome
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(args.db)) {
    console.error(`db not found: ${args.db}`)
    process.exit(2)
  }
  const db = new Database(args.db)
  // Don't pragma WAL here — the existing journal mode is whatever the
  // gateway set up. Touching journal_mode requires no other connections
  // open, which we can't guarantee.

  // Ensure archive table exists (CREATE IF NOT EXISTS — safe to run live).
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_sessions_archive (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      archived_at INTEGER NOT NULL,
      archive_reason TEXT NOT NULL,
      original_messages TEXT NOT NULL,
      original_bytes INTEGER NOT NULL,
      PRIMARY KEY (id, archived_at)
    );
  `)

  const selectStmt = db.prepare(
    `SELECT messages, next_seq FROM client_sessions
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
  )
  const archiveStmt = db.prepare(`
    INSERT INTO client_sessions_archive
      (id, user_id, archived_at, archive_reason, original_messages, original_bytes)
    VALUES
      (@id, @user_id, @archived_at, @archive_reason, @original_messages, @original_bytes)
  `)
  const updateStmt = db.prepare(`
    UPDATE client_sessions
    SET messages = @messages,
        message_count = @message_count,
        next_seq = @next_seq,
        updated_at = @updated_at
    WHERE id = @id AND user_id = @user_id AND deleted_at IS NULL
  `)

  // Monotonic `archived_at` allocator (Codex review-2). Same-millisecond
  // collisions on the (id, archived_at) PK are unlikely (one row per txn,
  // ms-resolution clock) but not zero — bursting through 7 small rows
  // could fall inside one ms. Allocator returns max(now, prev+1).
  let _lastArchivedAt = 0
  const archivedAtMonotonic = () => {
    const now = Date.now()
    _lastArchivedAt = Math.max(now, _lastArchivedAt + 1)
    return _lastArchivedAt
  }

  // Select rows. By id when --id given (ignores threshold), otherwise by
  // length(messages) > threshold. We only fetch (id, user_id) here; the
  // body of the row gets re-SELECTed inside each txn (see processRow).
  let rowKeys: Array<{ id: string; user_id: string }>
  if (args.id) {
    rowKeys = db
      .prepare(`SELECT id, user_id FROM client_sessions WHERE id = ? AND deleted_at IS NULL`)
      .all(args.id) as typeof rowKeys
  } else {
    // length(CAST(messages AS BLOB)) counts UTF-8 bytes, matching the storage
    // guard (`Buffer.byteLength`). Plain `length(messages)` counts characters,
    // which would skip rows oversized due to non-ASCII text. (Codex review-3.)
    const limitClause = args.limit ? ` LIMIT ${args.limit}` : ''
    rowKeys = db
      .prepare(
        `SELECT id, user_id FROM client_sessions
         WHERE deleted_at IS NULL AND length(CAST(messages AS BLOB)) > ?
         ORDER BY length(CAST(messages AS BLOB)) DESC${limitClause}`,
      )
      .all(args.thresholdBytes) as typeof rowKeys
  }

  console.log(
    `[sessions-fix-oversized] db=${args.db} threshold=${args.thresholdBytes} target=${args.targetBytes} dry-run=${args.dryRun} candidate_rows=${rowKeys.length}`,
  )
  if (rowKeys.length === 0) {
    db.close()
    return 0
  }

  let okCount = 0
  let failCount = 0
  let totalSaved = 0

  for (const rk of rowKeys) {
    let outcome: Outcome
    try {
      outcome = processRow(db, rk, args, selectStmt, archiveStmt, updateStmt, archivedAtMonotonic)
    } catch (err) {
      outcome = {
        kind: 'fail',
        originalBytes: 0,
        reason: `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    const tag =
      outcome.kind === 'strip'
        ? '[STRIP]'
        : outcome.kind === 'truncate'
          ? '[TRUNC]'
          : outcome.kind === 'noop'
            ? '[NOOP] '
            : '[FAIL] '

    if (outcome.kind === 'strip' || outcome.kind === 'truncate') {
      okCount++
      totalSaved += outcome.originalBytes - outcome.finalBytes
      const dropInfo =
        outcome.kind === 'truncate'
          ? `, msgs truncated: ${outcome.droppedCount} (-${outcome.droppedBytes}B)`
          : ''
      console.log(
        `${tag} ${rk.id}  ${outcome.originalBytes} → ${outcome.finalBytes} bytes (media stripped: ${outcome.mediaStripped}, inline-b64: ${outcome.inlineBase64Stripped}${dropInfo})${args.dryRun ? ' [dry-run]' : ''}`,
      )
    } else if (outcome.kind === 'noop') {
      console.log(`${tag} ${rk.id}  ${outcome.originalBytes} bytes — ${outcome.reason}`)
    } else {
      failCount++
      console.log(`${tag} ${rk.id}  ${outcome.originalBytes} bytes — ${outcome.reason}`)
    }
  }

  console.log(
    `\n[sessions-fix-oversized] done. ok=${okCount} fail=${failCount} saved=${(totalSaved / 1024 / 1024).toFixed(2)}MB${args.dryRun ? ' (dry-run, no writes)' : ''}`,
  )
  db.close()
  return failCount > 0 ? 1 : 0
}

const code = main()
process.exit(code)
