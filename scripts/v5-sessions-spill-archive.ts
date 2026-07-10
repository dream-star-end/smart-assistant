#!/usr/bin/env -S npx tsx
/**
 * v5-sessions-spill-archive.ts — One-shot ops script that spills the oldest
 * messages out of over-sized `client_sessions.messages` rows into the archive
 * chunk tables, leaving each row with only a bounded "hot tail".
 *
 * Why this exists: `client_sessions.messages` is a single JSON blob capped at
 * `MAX_SESSION_BYTES = 4MB` (added 2026-05-08 to stop a single huge row from
 * stalling the Node event loop on JSON.parse). Once a row hits the cap every
 * server-authored append is rejected and silently dropped — the user pays but
 * never sees the answer (2026-07-10 uid4 incident). The long-session hot-tail +
 * archive redesign moves the oldest messages into `client_session_archive_chunks`
 * so the row body stays bounded and the write path never rejects again.
 *
 * The prod DB still holds historical rows accumulated before that landed:
 *   - uid4's 4.19MB row
 *   - 4-5 月 legacy rows at 8-9MB
 * This script brings them into the new hot-tail regime.
 *
 * What it does, per row whose serialized UTF-8 byte length exceeds
 * `--threshold-bytes` (default `SESSION_SOFT_TRIM_BYTES` = 2.5MB):
 *   1. Wraps the row in a `BEGIN IMMEDIATE` transaction (acquires the write
 *      lock up front so concurrent gateway writes can't race the
 *      read-modify-write) and re-SELECTs the row body inside the txn.
 *   2. Backfills `_seq` via `normalizeAndAssignSeqs` (legacy 8-9MB rows have no
 *      `_seq`; the archive/incremental cursor requires every message to carry
 *      one). Persists the resulting `next_seq`.
 *   3. Calls the SAME `_spillOverflowCore` the live write paths use (no copy of
 *      the spill logic) to move the oldest messages into the archive chunk
 *      tables, keeping the hot tail (≤ 2MB, ≥ 64 msgs).
 *   4. Persists the tail back to `messages`, updates `message_count`
 *      (= tail + archived_count), `next_seq`, `archived_through_seq`,
 *      `archived_count`, and bumps `updated_at = now` so the next client
 *      `meta.updatedAt > local._syncedAt` check fires a fresh GET.
 *
 * Media base64 is NOT specially handled — the archive stores messages verbatim
 * (unlike the old sessions-fix-oversized.ts strip logic, which we do NOT carry
 * over: we MOVE content, we don't DROP it).
 *
 * Idempotency:
 *   - Re-runs find no rows past the threshold and exit clean.
 *   - Re-spilling a row whose oldest span is already archived collides on the
 *     chunk PK `(session_id, first_seq)` → `INSERT OR IGNORE` no-ops and
 *     `archivedDelta` doesn't double count.
 *
 * The 8-9MB `JSON.parse` will block the main thread; this is a dedicated
 * one-shot process so that's fine.
 *
 * Usage:
 *   npx tsx scripts/v5-sessions-spill-archive.ts \
 *     [--db <path>]            (default: $OPENCLAUDE_HOME/sessions.db)
 *     [--threshold-bytes N]    (default: 2621440 — SESSION_SOFT_TRIM_BYTES)
 *     [--dry-run]              (no writes; reports what WOULD spill)
 *     [--id <session-id>]      (process exactly one row, ignores threshold)
 *     [--limit N]              (cap rows processed per run)
 *
 * Recommended deploy sequence:
 *   1. Deploy storage (hot-tail + archive) to prod → restart gateway (creates
 *      the archive schema on boot).
 *   2. Dry-run:  npx tsx scripts/v5-sessions-spill-archive.ts --dry-run
 *   3. Real run: npx tsx scripts/v5-sessions-spill-archive.ts
 *   4. (Optional) sqlite3 sessions.db 'PRAGMA wal_checkpoint(TRUNCATE);'
 *
 * Exit codes:
 *   0 = all rows processed cleanly (dry-run also returns 0 when no exceptions)
 *   1 = at least one row failed unexpectedly
 *   2 = usage error (bad CLI arg, db not found)
 */

import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  _spillOverflowCore,
  normalizeAndAssignSeqs,
  SESSION_SOFT_TRIM_BYTES,
  type MessageLike,
} from '../packages/storage/src/sessionsDb.js'

// ── CLI parsing ──────────────────────────────────────────────────────────────
type Args = {
  db: string
  thresholdBytes: number
  dryRun: boolean
  id: string | null
  limit: number | null
}

function parseArgs(argv: string[]): Args {
  const home = process.env.OPENCLAUDE_HOME ?? join(homedir(), '.openclaude')
  const out: Args = {
    db: join(home, 'sessions.db'),
    thresholdBytes: SESSION_SOFT_TRIM_BYTES,
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
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--id') out.id = next()
    else if (a === '--limit') out.limit = parseInt(next(), 10)
    else if (a === '-h' || a === '--help') {
      console.log(
        `Usage: npx tsx scripts/v5-sessions-spill-archive.ts [--db PATH] [--threshold-bytes N] [--dry-run] [--id ID] [--limit N]`,
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
  return out
}

// ── Schema guard ─────────────────────────────────────────────────────────────
// The script opens the DB directly (not via getSessionsDb), so make sure the
// archive tables + columns exist before we spill. Mirrors getSessionsDb's DDL,
// honouring the sessionsdb-migration 铁律: the index that references the new
// table goes AFTER the guarded ALTER TABLEs.
function ensureArchiveSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_session_archive_chunks (
      session_id TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      first_seq  INTEGER NOT NULL,
      last_seq   INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      messages   TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, first_seq)
    );
    CREATE TABLE IF NOT EXISTS client_session_archived_ids (
      session_id TEXT NOT NULL,
      msg_id     TEXT NOT NULL,
      PRIMARY KEY (session_id, msg_id)
    );
  `)
  try {
    const cols = db.pragma('table_info(client_sessions)') as Array<{ name: string }>
    if (!cols.some(c => c.name === 'archived_through_seq')) {
      db.exec('ALTER TABLE client_sessions ADD COLUMN archived_through_seq INTEGER NOT NULL DEFAULT 0')
    }
    if (!cols.some(c => c.name === 'archived_count')) {
      db.exec('ALTER TABLE client_sessions ADD COLUMN archived_count INTEGER NOT NULL DEFAULT 0')
    }
  } catch { /* table just created with columns already */ }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_csa_chunks_last ON client_session_archive_chunks(session_id, last_seq)',
  )
}

// ── Per-row processor ────────────────────────────────────────────────────────
type Outcome =
  | { kind: 'spill'; originalBytes: number; tailBytes: number; tailCount: number; spilledCount: number }
  | { kind: 'noop'; originalBytes: number; reason: string }
  | { kind: 'fail'; originalBytes: number; reason: string }

// Sentinel thrown to roll back the whole txn under --dry-run (the spill has
// already INSERTed into the archive tables inside the txn; a rollback undoes
// them so a dry-run leaves the DB untouched).
const DRY_RUN_ROLLBACK = new Error('__dry_run_rollback__')

function processRow(
  db: Database.Database,
  rowKey: { id: string; user_id: string },
  args: Args,
  selectStmt: Database.Statement<unknown[]>,
  updateStmt: Database.Statement<unknown[]>,
): Outcome {
  let outcome: Outcome | null = null
  const txn = db.transaction(() => {
    const fresh = selectStmt.get(rowKey.id, rowKey.user_id) as
      | { messages: string; next_seq: number | null; archived_through_seq: number | null; archived_count: number | null }
      | undefined
    if (!fresh) {
      outcome = { kind: 'noop', originalBytes: 0, reason: 'row missing or soft-deleted at txn time' }
      return
    }
    const originalBytes = Buffer.byteLength(fresh.messages, 'utf8')
    if (originalBytes <= args.thresholdBytes && !args.id) {
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
    const oldMsgs = parsed as MessageLike[]

    // 1. Backfill `_seq` (legacy rows have none). Passing (oldMsgs, oldMsgs)
    //    inherits existing _seq where present and reassigns 1..N in array order
    //    where absent — exactly the backfill semantics the write paths rely on.
    const currentNextSeq =
      typeof fresh.next_seq === 'number' && fresh.next_seq > 0 ? fresh.next_seq : 1
    const { messages: seqedMessages, nextSeq } = normalizeAndAssignSeqs(
      oldMsgs,
      oldMsgs,
      currentNextSeq,
    )

    // 2. Spill via the SAME core the live write paths use.
    const now = Date.now()
    const spill = _spillOverflowCore(db, rowKey.id, rowKey.user_id, seqedMessages, {
      currentArchivedThroughSeq: fresh.archived_through_seq ?? 0,
      now,
    })
    const newArchivedCount = (fresh.archived_count ?? 0) + spill.archivedDelta
    const tail = spill.tail
    const tailJson = JSON.stringify(tail)
    const tailBytes = Buffer.byteLength(tailJson, 'utf8')

    outcome = {
      kind: 'spill',
      originalBytes,
      tailBytes,
      tailCount: tail.length,
      spilledCount: spill.archivedDelta,
    }

    if (args.dryRun) {
      // Roll back the spill INSERTs done inside this txn — dry-run must not
      // persist anything. The outcome is already captured above.
      throw DRY_RUN_ROLLBACK
    }

    const updateRes = updateStmt.run({
      messages: tailJson,
      message_count: tail.length + newArchivedCount,
      next_seq: nextSeq,
      archived_through_seq: spill.archivedThroughSeq,
      archived_count: newArchivedCount,
      updated_at: now,
      id: rowKey.id,
      user_id: rowKey.user_id,
    })
    if (updateRes.changes !== 1) {
      throw new Error(`UPDATE main row affected ${updateRes.changes} rows (expected 1)`)
    }
  })

  try {
    txn.immediate()
  } catch (err) {
    if (err === DRY_RUN_ROLLBACK) {
      // outcome already captured; the archive INSERTs were rolled back.
      return outcome ?? { kind: 'fail', originalBytes: 0, reason: 'dry-run produced no outcome' }
    }
    return {
      kind: 'fail',
      originalBytes: 0,
      reason: `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (outcome === null) {
    return { kind: 'fail', originalBytes: 0, reason: 'txn body did not produce outcome' }
  }
  return outcome
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main(): number {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(args.db)) {
    console.error(`db not found: ${args.db}`)
    process.exit(2)
  }
  const db = new Database(args.db)
  ensureArchiveSchema(db)

  const selectStmt = db.prepare(
    `SELECT messages, next_seq, archived_through_seq, archived_count FROM client_sessions
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
  )
  const updateStmt = db.prepare(`
    UPDATE client_sessions
    SET messages = @messages,
        message_count = @message_count,
        next_seq = @next_seq,
        archived_through_seq = @archived_through_seq,
        archived_count = @archived_count,
        updated_at = @updated_at
    WHERE id = @id AND user_id = @user_id AND deleted_at IS NULL
  `)

  let rowKeys: Array<{ id: string; user_id: string }>
  if (args.id) {
    rowKeys = db
      .prepare(`SELECT id, user_id FROM client_sessions WHERE id = ? AND deleted_at IS NULL`)
      .all(args.id) as typeof rowKeys
  } else {
    // length(CAST(messages AS BLOB)) counts UTF-8 bytes, matching the storage
    // guard (Buffer.byteLength). Plain length(messages) counts characters and
    // would skip rows oversized due to non-ASCII text.
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
    `[v5-sessions-spill-archive] db=${args.db} threshold=${args.thresholdBytes} dry-run=${args.dryRun} candidate_rows=${rowKeys.length}`,
  )
  if (rowKeys.length === 0) {
    db.close()
    return 0
  }

  let okCount = 0
  let failCount = 0
  let totalSpilled = 0

  for (const rk of rowKeys) {
    let outcome: Outcome
    try {
      outcome = processRow(db, rk, args, selectStmt, updateStmt)
    } catch (err) {
      outcome = {
        kind: 'fail',
        originalBytes: 0,
        reason: `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    if (outcome.kind === 'spill') {
      okCount++
      totalSpilled += outcome.spilledCount
      console.log(
        `[SPILL] ${rk.id}  ${outcome.originalBytes} → ${outcome.tailBytes} bytes tail (tail msgs: ${outcome.tailCount}, spilled: ${outcome.spilledCount})${args.dryRun ? ' [dry-run]' : ''}`,
      )
    } else if (outcome.kind === 'noop') {
      console.log(`[NOOP]  ${rk.id}  ${outcome.originalBytes} bytes — ${outcome.reason}`)
    } else {
      failCount++
      console.log(`[FAIL]  ${rk.id}  ${outcome.originalBytes} bytes — ${outcome.reason}`)
    }
  }

  console.log(
    `\n[v5-sessions-spill-archive] done. ok=${okCount} fail=${failCount} spilled_msgs=${totalSpilled}${args.dryRun ? ' (dry-run, no writes)' : ''}`,
  )
  db.close()
  return failCount > 0 ? 1 : 0
}

const code = main()
process.exit(code)
