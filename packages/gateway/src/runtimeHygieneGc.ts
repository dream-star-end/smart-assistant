/**
 * OCV5-883: Deterministic runtime hygiene GC (zero LLM cost).
 *
 * Cleans up bounded runtime debris safely with strict fail-open semantics:
 *   1. Stale terminal cron occurrence tapes (`cron/occurrence-tapes/<id>.jsonl`)
 *   2. Stale / over-budget v3 master retry queue dead-letters (`v3-master-retry.d/<entry>.quarantine*`)
 *   3. Stale terminal rows + WAL truncation in `delegate-inflight-surface.db`
 *   4. Stale backup files (`.bak`, `.bak.*`) at top-level homeDir and `agents/<id>/`
 *
 * Safety invariants:
 *   - `dryRun: true` performs zero unlinks, zero file writes, and zero DB mutations.
 *   - Every intermediate directory from root to target is verified non-symlink with
 *     `realpath` strictly inside the trusted root; symlinks are never followed or deleted.
 *   - Single-item errors are collected into `errors[]` without aborting sibling items.
 *   - Paid retry queue entries (`.json`) and active cron/delegate records are never touched.
 */
import type { Stats } from 'node:fs'
import { lstat, open, readdir, readFile, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'
import { paths } from '@openclaude/storage'

import {
  resolveDelegateInflightSurfaceDbPath,
  type DelegateInflightSurfaceStore,
} from './delegateInflightSurface.js'

const DAY_MS = 24 * 3600_000

export const DEFAULT_CRON_TAPE_MAX_AGE_MS = 7 * DAY_MS
export const DEFAULT_RETRY_QUARANTINE_MAX_AGE_MS = 14 * DAY_MS
export const DEFAULT_RETRY_QUARANTINE_MAX_BYTES = 50 * 1024 * 1024
export const DEFAULT_INFLIGHT_SURFACE_MAX_AGE_MS = 24 * 3600_000
export const DEFAULT_STALE_BAK_MAX_AGE_MS = 30 * DAY_MS

/** Terminal states allowed for active dir, occurrences.json index, and standalone .jsonl tail. */
const CRON_TERMINAL_STATES = new Set(['delivery_terminal', 'execution_terminal'])
/** States reclaimable ONLY when persisted in `cron/occurrences-settled/<id>.json` and absent from active `occurrences/`. */
const CRON_SETTLED_RECLAIMABLE_STATES = new Set([
  'delivered',
  'delivery_terminal',
  'execution_terminal',
])
const INFLIGHT_TERMINAL_SQL = `'completed','failed','cancelled','killed_by_cutover'`
const TAIL_READ_BYTES = 64 * 1024

export const DEFAULT_BAK_WHITELIST: ReadonlySet<string> = new Set([
  'resume-map.json.bak',
  'MEMORY.md.pre-memdir.bak',
])

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isEnoent(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT')
}

function isWithinRealRoot(realRoot: string, realCandidate: string, allowEqual: boolean): boolean {
  if (allowEqual && realCandidate === realRoot) return true
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
  return realCandidate.startsWith(prefix)
}

export type SafeSubdirResult =
  | { ok: true; realDir: string; realHomeDir: string }
  | { ok: false; missing: true }
  | { ok: false; missing: false; error: string }

/**
 * Verifies `homeDir` is a non-symlink directory and walks every intermediate
 * segment from `homeDir` to `targetDir`, rejecting any symlink, non-directory,
 * or `realpath` escape outside `realHomeDir + sep`.
 */
export async function verifySafeSubdirWithinRoot(
  homeDir: string,
  targetDir: string,
): Promise<SafeSubdirResult> {
  const absHome = resolve(homeDir)
  const absTarget = resolve(targetDir)

  let homeStat: Stats
  try {
    homeStat = await lstat(absHome)
  } catch (err) {
    if (isEnoent(err)) return { ok: false, missing: true }
    return { ok: false, missing: false, error: `lstat root ${absHome}: ${formatErr(err)}` }
  }
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    return {
      ok: false,
      missing: false,
      error: `unsafe root (symlink or non-directory): ${absHome}`,
    }
  }

  let realHomeDir: string
  try {
    realHomeDir = await realpath(absHome)
  } catch (err) {
    if (isEnoent(err)) return { ok: false, missing: true }
    return { ok: false, missing: false, error: `realpath root ${absHome}: ${formatErr(err)}` }
  }

  const rel = relative(absHome, absTarget)
  if (rel === '') {
    return { ok: true, realDir: realHomeDir, realHomeDir }
  }
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return {
      ok: false,
      missing: false,
      error: `target directory escapes root: ${absTarget} (root: ${absHome})`,
    }
  }

  const segments = rel.split(sep).filter(Boolean)
  let cursor = absHome
  let realCursor = realHomeDir
  for (const segment of segments) {
    cursor = join(cursor, segment)
    let st: Stats
    try {
      st = await lstat(cursor)
    } catch (err) {
      if (isEnoent(err)) return { ok: false, missing: true }
      return { ok: false, missing: false, error: `lstat ${cursor}: ${formatErr(err)}` }
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return {
        ok: false,
        missing: false,
        error: `unsafe directory segment (symlink or non-directory): ${cursor}`,
      }
    }
    try {
      realCursor = await realpath(cursor)
    } catch (err) {
      if (isEnoent(err)) return { ok: false, missing: true }
      return { ok: false, missing: false, error: `realpath ${cursor}: ${formatErr(err)}` }
    }
    if (!isWithinRealRoot(realHomeDir, realCursor, false)) {
      return {
        ok: false,
        missing: false,
        error: `directory escapes root via realpath: ${cursor} -> ${realCursor}`,
      }
    }
  }

  return { ok: true, realDir: realCursor, realHomeDir }
}

type SafeFileResult =
  | { ok: true; stat: Stats; realFile: string }
  | { ok: false; missing: boolean; skipSilently: boolean; error?: string }

async function verifySafeFileWithinDir(
  realTrustedDir: string,
  filePath: string,
): Promise<SafeFileResult> {
  let st: Stats
  try {
    st = await lstat(filePath)
  } catch (err) {
    if (isEnoent(err)) return { ok: false, missing: true, skipSilently: true }
    return {
      ok: false,
      missing: false,
      skipSilently: false,
      error: `lstat ${filePath}: ${formatErr(err)}`,
    }
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { ok: false, missing: false, skipSilently: true }
  }
  let realFile: string
  try {
    realFile = await realpath(filePath)
  } catch (err) {
    if (isEnoent(err)) return { ok: false, missing: true, skipSilently: true }
    return {
      ok: false,
      missing: false,
      skipSilently: false,
      error: `realpath ${filePath}: ${formatErr(err)}`,
    }
  }
  if (!isWithinRealRoot(realTrustedDir, realFile, false)) {
    return {
      ok: false,
      missing: false,
      skipSilently: false,
      error: `file escapes trusted directory: ${filePath} -> ${realFile}`,
    }
  }
  return { ok: true, stat: st, realFile }
}

async function unlinkIfNotDryRun(filepath: string, dryRun: boolean): Promise<boolean> {
  if (dryRun) return true
  try {
    await unlink(filepath)
    return true
  } catch (err) {
    if (isEnoent(err)) return false
    throw err
  }
}

// ---------------------------------------------------------------------------
// 1. Cron occurrence tapes GC
// ---------------------------------------------------------------------------

export interface GcCronOccurrenceTapesOptions {
  homeDir?: string
  tapesDir?: string
  occurrencesDir?: string
  occurrencesSettledDir?: string
  occurrencesIndexFile?: string
  maxAgeMs?: number
  nowMs?: number
  dryRun?: boolean
}

export interface GcCronOccurrenceTapesReport {
  scannedFiles: number
  deletedFiles: number
  reclaimedBytes: number
  skippedActive: number
  skippedFresh: number
  skippedUnknown: number
  errors: string[]
}

function isTerminalTapePayload(value: unknown, depth = 0): boolean {
  if (depth > 2 || value == null) return false
  if (typeof value === 'string') return CRON_TERMINAL_STATES.has(value)
  if (typeof value !== 'object' || Array.isArray(value)) return false
  const rec = value as Record<string, unknown>
  for (const key of ['state', 'kind', 'type', 'status'] as const) {
    const field = rec[key]
    if (typeof field === 'string' && CRON_TERMINAL_STATES.has(field)) return true
  }
  if ('event' in rec && rec.event !== undefined) {
    return isTerminalTapePayload(rec.event, depth + 1)
  }
  return false
}

async function readLastValidJsonLine(filepath: string, fileSize: number): Promise<unknown | undefined> {
  if (fileSize <= 0) return undefined
  const readLen = Math.min(fileSize, TAIL_READ_BYTES)
  const startOffset = fileSize - readLen
  const fh = await open(filepath, 'r')
  try {
    const buf = Buffer.allocUnsafe(readLen)
    const { bytesRead } = await fh.read(buf, 0, readLen, startOffset)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    const lines = text.split('\n')
    const minIdx = startOffset > 0 && lines.length > 1 ? 1 : 0
    for (let i = lines.length - 1; i >= minIdx; i--) {
      const line = lines[i]?.trim()
      if (!line) continue
      try {
        return JSON.parse(line) as unknown
      } catch {
        // Ignore truncated/corrupt trailing line and inspect earlier valid JSON line.
      }
    }
    return undefined
  } finally {
    await fh.close()
  }
}

type OccurrenceIndexLookup = {
  available: boolean
  corrupt: boolean
  unsafeError?: string
  states: Map<string, string>
}

async function loadOccurrencesIndexFile(
  rootDir: string,
  indexPath: string,
): Promise<OccurrenceIndexLookup> {
  const states = new Map<string, string>()
  const parentCheck = await verifySafeSubdirWithinRoot(rootDir, dirname(indexPath))
  if (!parentCheck.ok) {
    if (parentCheck.missing) return { available: false, corrupt: false, states }
    return { available: true, corrupt: true, unsafeError: parentCheck.error, states }
  }
  const fileCheck = await verifySafeFileWithinDir(parentCheck.realDir, indexPath)
  if (!fileCheck.ok) {
    if (fileCheck.missing) return { available: false, corrupt: false, states }
    return {
      available: true,
      corrupt: true,
      unsafeError: fileCheck.error ?? `unsafe occurrences index file: ${indexPath}`,
      states,
    }
  }
  try {
    const raw = JSON.parse(await readFile(fileCheck.realFile, 'utf8')) as unknown
    const ingestRecord = (key: string | undefined, value: unknown): void => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      const rec = value as Record<string, unknown>
      const id = typeof rec.deliveryId === 'string' && rec.deliveryId ? rec.deliveryId : key
      if (!id) return
      const state = typeof rec.state === 'string' ? rec.state : 'unknown'
      states.set(id, state)
    }
    if (Array.isArray(raw)) {
      for (const item of raw) ingestRecord(undefined, item)
    } else if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>
      if (obj.occurrences && typeof obj.occurrences === 'object') {
        if (Array.isArray(obj.occurrences)) {
          for (const item of obj.occurrences) ingestRecord(undefined, item)
        } else {
          for (const [k, v] of Object.entries(obj.occurrences as Record<string, unknown>)) {
            ingestRecord(k, v)
          }
        }
      } else {
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'string') {
            states.set(k, v)
          } else {
            ingestRecord(k, v)
          }
        }
      }
    } else {
      return { available: true, corrupt: true, states }
    }
    return { available: true, corrupt: false, states }
  } catch (err) {
    if (isEnoent(err)) return { available: false, corrupt: false, states }
    return { available: true, corrupt: true, states }
  }
}

async function readOccurrenceStateFromSafeDir(
  realDir: string | null,
  deliveryId: string,
): Promise<{ exists: boolean; state: string | null; corrupt: boolean }> {
  if (!realDir) return { exists: false, state: null, corrupt: false }
  const filepath = join(realDir, `${deliveryId}.json`)
  const fileCheck = await verifySafeFileWithinDir(realDir, filepath)
  if (!fileCheck.ok) {
    if (fileCheck.missing) return { exists: false, state: null, corrupt: false }
    // Symlink or boundary escape inside occurrence dir -> fail closed.
    return { exists: true, state: null, corrupt: true }
  }
  try {
    const parsed = JSON.parse(await readFile(fileCheck.realFile, 'utf8')) as Record<string, unknown>
    const state = typeof parsed?.state === 'string' ? parsed.state : null
    return { exists: true, state, corrupt: state === null }
  } catch (err) {
    if (isEnoent(err)) return { exists: false, state: null, corrupt: false }
    return { exists: true, state: null, corrupt: true }
  }
}

export async function gcCronOccurrenceTapes(
  opts: GcCronOccurrenceTapesOptions = {},
): Promise<GcCronOccurrenceTapesReport> {
  const hasExplicitHome = opts.homeDir !== undefined
  const homeDir = opts.homeDir ?? paths.home
  const tapesDir = opts.tapesDir ?? join(homeDir, 'cron', 'occurrence-tapes')
  const occurrencesDir = opts.occurrencesDir ?? join(homeDir, 'cron', 'occurrences')
  const occurrencesSettledDir = opts.occurrencesSettledDir ?? join(homeDir, 'cron', 'occurrences-settled')
  const occurrencesIndexFile = opts.occurrencesIndexFile ?? join(homeDir, 'cron', 'occurrences.json')
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_CRON_TAPE_MAX_AGE_MS
  const nowMs = opts.nowMs ?? Date.now()
  const dryRun = opts.dryRun === true
  const cutoff = nowMs - maxAgeMs

  const report: GcCronOccurrenceTapesReport = {
    scannedFiles: 0,
    deletedFiles: 0,
    reclaimedBytes: 0,
    skippedActive: 0,
    skippedFresh: 0,
    skippedUnknown: 0,
    errors: [],
  }

  const tapesRoot = !hasExplicitHome && opts.tapesDir ? opts.tapesDir : homeDir
  const tapesCheck = await verifySafeSubdirWithinRoot(tapesRoot, tapesDir)
  if (!tapesCheck.ok) {
    if (!tapesCheck.missing) report.errors.push(tapesCheck.error)
    return report
  }

  // Verify sibling occurrence directories step-by-step before touching any tape; fail closed on symlink escape.
  const occRoot = !hasExplicitHome && opts.occurrencesDir ? opts.occurrencesDir : homeDir
  const occCheck = await verifySafeSubdirWithinRoot(occRoot, occurrencesDir)
  if (!occCheck.ok && !occCheck.missing) {
    report.errors.push(occCheck.error)
    return report
  }

  const settledRoot =
    !hasExplicitHome && opts.occurrencesSettledDir ? opts.occurrencesSettledDir : homeDir
  const settledCheck = await verifySafeSubdirWithinRoot(settledRoot, occurrencesSettledDir)
  if (!settledCheck.ok && !settledCheck.missing) {
    report.errors.push(settledCheck.error)
    return report
  }

  const indexRoot =
    !hasExplicitHome && opts.occurrencesIndexFile ? dirname(opts.occurrencesIndexFile) : homeDir
  const indexLookup = await loadOccurrencesIndexFile(indexRoot, occurrencesIndexFile)
  if (indexLookup.corrupt) {
    report.errors.push(
      indexLookup.unsafeError ?? `corrupt occurrences index: ${occurrencesIndexFile}`,
    )
  }

  let names: string[]
  try {
    names = await readdir(tapesCheck.realDir)
  } catch (err) {
    if (isEnoent(err)) return report
    report.errors.push(`readdir ${tapesDir}: ${formatErr(err)}`)
    return report
  }

  const realOccDir = occCheck.ok ? occCheck.realDir : null
  const realSettledDir = settledCheck.ok ? settledCheck.realDir : null

  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const fullPath = join(tapesCheck.realDir, name)
    try {
      const fileCheck = await verifySafeFileWithinDir(tapesCheck.realDir, fullPath)
      if (!fileCheck.ok) {
        if (!fileCheck.skipSilently && fileCheck.error) report.errors.push(fileCheck.error)
        continue
      }
      const st = fileCheck.stat
      report.scannedFiles++

      if (st.mtimeMs >= cutoff) {
        report.skippedFresh++
        continue
      }

      const deliveryId = name.slice(0, -'.jsonl'.length)
      if (!deliveryId || deliveryId.includes('/') || deliveryId.includes('\\') || deliveryId.includes('..')) {
        report.skippedUnknown++
        continue
      }

      // 1. Check active occurrence directory (`cron/occurrences/<deliveryId>.json`).
      const activeRec = await readOccurrenceStateFromSafeDir(realOccDir, deliveryId)
      if (activeRec.exists) {
        if (activeRec.corrupt || !activeRec.state || !CRON_TERMINAL_STATES.has(activeRec.state)) {
          report.skippedActive++
          continue
        }
        if (await unlinkIfNotDryRun(fileCheck.realFile, dryRun)) {
          report.deletedFiles++
          report.reclaimedBytes += st.size
        }
        continue
      }

      // 2. Check optional `cron/occurrences.json` index.
      if (indexLookup.corrupt) {
        report.skippedUnknown++
        continue
      }
      if (indexLookup.available && indexLookup.states.has(deliveryId)) {
        const indexedState = indexLookup.states.get(deliveryId)!
        if (!CRON_TERMINAL_STATES.has(indexedState)) {
          report.skippedActive++
          continue
        }
        if (await unlinkIfNotDryRun(fileCheck.realFile, dryRun)) {
          report.deletedFiles++
          report.reclaimedBytes += st.size
        }
        continue
      }

      // 3. Check settled occurrence directory (`cron/occurrences-settled/<deliveryId>.json`).
      // Normal cron completion writes `state: 'delivered'` here after moving out of active `occurrences/`.
      const settledRec = await readOccurrenceStateFromSafeDir(realSettledDir, deliveryId)
      if (settledRec.exists) {
        if (
          settledRec.corrupt ||
          !settledRec.state ||
          !CRON_SETTLED_RECLAIMABLE_STATES.has(settledRec.state)
        ) {
          report.skippedActive++
          continue
        }
        if (await unlinkIfNotDryRun(fileCheck.realFile, dryRun)) {
          report.deletedFiles++
          report.reclaimedBytes += st.size
        }
        continue
      }

      // 4. No occurrence record found: require explicit terminal event (`delivery_terminal` / `execution_terminal`)
      // on the last valid JSON line (never accept `delivered` unconditionally on standalone tapes).
      const lastEvent = await readLastValidJsonLine(fileCheck.realFile, st.size)
      if (!isTerminalTapePayload(lastEvent)) {
        report.skippedUnknown++
        continue
      }

      if (await unlinkIfNotDryRun(fileCheck.realFile, dryRun)) {
        report.deletedFiles++
        report.reclaimedBytes += st.size
      }
    } catch (err) {
      report.errors.push(`${name}: ${formatErr(err)}`)
    }
  }

  return report
}

// ---------------------------------------------------------------------------
// 2. v3 master retry queue quarantine GC
// ---------------------------------------------------------------------------

export interface GcRetryQueueQuarantineOptions {
  homeDir?: string
  queueDir?: string
  maxAgeMs?: number
  maxTotalBytes?: number
  nowMs?: number
  dryRun?: boolean
}

export interface GcRetryQueueQuarantineReport {
  scannedFiles: number
  deletedFiles: number
  deletedByAge: number
  deletedByBudget: number
  reclaimedBytes: number
  remainingFiles: number
  remainingBytes: number
  quarantineBudgetExceeded: boolean
  errors: string[]
}

/**
 * Matches both `.quarantine` and `v3MasterRetryQueue.ts`'s actual suffix
 * `.quarantine-<reason>-<ts>`. Never matches active `.json` queue entries or
 * `.tmp-*` atomic writes.
 */
export function isRetryQueueQuarantineFileName(name: string): boolean {
  return /\.quarantine(?:-[A-Za-z0-9_-]+)?$/.test(name)
}

export async function gcRetryQueueQuarantine(
  opts: GcRetryQueueQuarantineOptions = {},
): Promise<GcRetryQueueQuarantineReport> {
  const hasExplicitHome = opts.homeDir !== undefined
  const homeDir = opts.homeDir ?? paths.home
  const queueDir = opts.queueDir ?? join(homeDir, 'v3-master-retry.d')
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_RETRY_QUARANTINE_MAX_AGE_MS
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_RETRY_QUARANTINE_MAX_BYTES
  const nowMs = opts.nowMs ?? Date.now()
  const dryRun = opts.dryRun === true
  const cutoff = nowMs - maxAgeMs

  const report: GcRetryQueueQuarantineReport = {
    scannedFiles: 0,
    deletedFiles: 0,
    deletedByAge: 0,
    deletedByBudget: 0,
    reclaimedBytes: 0,
    remainingFiles: 0,
    remainingBytes: 0,
    quarantineBudgetExceeded: false,
    errors: [],
  }

  const queueRoot = !hasExplicitHome && opts.queueDir ? opts.queueDir : homeDir
  const dirCheck = await verifySafeSubdirWithinRoot(queueRoot, queueDir)
  if (!dirCheck.ok) {
    if (!dirCheck.missing) report.errors.push(dirCheck.error)
    return report
  }

  let names: string[]
  try {
    names = await readdir(dirCheck.realDir)
  } catch (err) {
    if (isEnoent(err)) return report
    report.errors.push(`readdir ${queueDir}: ${formatErr(err)}`)
    return report
  }

  interface QuarantineCandidate {
    name: string
    fullPath: string
    mtimeMs: number
    size: number
  }

  const remaining: QuarantineCandidate[] = []

  for (const name of names) {
    if (!isRetryQueueQuarantineFileName(name)) continue
    const fullPath = join(dirCheck.realDir, name)
    try {
      const fileCheck = await verifySafeFileWithinDir(dirCheck.realDir, fullPath)
      if (!fileCheck.ok) {
        if (!fileCheck.skipSilently && fileCheck.error) report.errors.push(fileCheck.error)
        continue
      }
      const st = fileCheck.stat
      report.scannedFiles++

      if (st.mtimeMs < cutoff) {
        if (await unlinkIfNotDryRun(fileCheck.realFile, dryRun)) {
          report.deletedFiles++
          report.deletedByAge++
          report.reclaimedBytes += st.size
        }
        continue
      }
      remaining.push({ name, fullPath: fileCheck.realFile, mtimeMs: st.mtimeMs, size: st.size })
    } catch (err) {
      report.errors.push(`${name}: ${formatErr(err)}`)
    }
  }

  let remainingBytes = remaining.reduce((sum, item) => sum + item.size, 0)
  if (remainingBytes > maxTotalBytes) {
    report.quarantineBudgetExceeded = true
    remaining.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
    const kept: QuarantineCandidate[] = []
    for (const item of remaining) {
      if (remainingBytes > maxTotalBytes) {
        try {
          if (await unlinkIfNotDryRun(item.fullPath, dryRun)) {
            report.deletedFiles++
            report.deletedByBudget++
            report.reclaimedBytes += item.size
          }
          remainingBytes -= item.size
        } catch (err) {
          report.errors.push(`${item.name}: ${formatErr(err)}`)
          kept.push(item)
        }
      } else {
        kept.push(item)
      }
    }
    report.remainingFiles = kept.length
    report.remainingBytes = kept.reduce((sum, item) => sum + item.size, 0)
  } else {
    report.remainingFiles = remaining.length
    report.remainingBytes = remainingBytes
  }

  return report
}

// ---------------------------------------------------------------------------
// 3. Delegate inflight surface SQLite GC
// ---------------------------------------------------------------------------

export interface GcDelegateInflightSurfaceOptions {
  inflightSurface?: Pick<DelegateInflightSurfaceStore, 'pruneStaleTerminalRows'> | null
  dbPath?: string
  homeDir?: string
  maxAgeMs?: number
  nowMs?: number
  dryRun?: boolean
  busyTimeoutMs?: number
}

export interface GcDelegateInflightSurfaceReport {
  deletedRows: number
  checkpointed: boolean
  skipped: boolean
  errors: string[]
}

export async function gcDelegateInflightSurface(
  opts: GcDelegateInflightSurfaceOptions = {},
): Promise<GcDelegateInflightSurfaceReport> {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_INFLIGHT_SURFACE_MAX_AGE_MS
  const nowMs = opts.nowMs ?? Date.now()
  const dryRun = opts.dryRun === true
  const report: GcDelegateInflightSurfaceReport = {
    deletedRows: 0,
    checkpointed: false,
    skipped: false,
    errors: [],
  }

  if (opts.inflightSurface) {
    try {
      const res = opts.inflightSurface.pruneStaleTerminalRows({ maxAgeMs, nowMs, dryRun })
      report.deletedRows = res.deleted
      report.checkpointed = res.checkpointed
    } catch (err) {
      report.errors.push(`inflightSurface.pruneStaleTerminalRows: ${formatErr(err)}`)
    }
    return report
  }

  const dbPath =
    opts.dbPath ??
    (opts.homeDir
      ? join(opts.homeDir, 'delegate-inflight-surface.db')
      : resolveDelegateInflightSurfaceDbPath())
  const dbParent = dirname(dbPath)
  const dbRoot = opts.homeDir ?? dbParent

  const parentCheck = await verifySafeSubdirWithinRoot(dbRoot, dbParent)
  if (!parentCheck.ok) {
    report.skipped = true
    if (!parentCheck.missing) report.errors.push(parentCheck.error)
    return report
  }

  const fileCheck = await verifySafeFileWithinDir(parentCheck.realDir, dbPath)
  if (!fileCheck.ok) {
    report.skipped = true
    if (!fileCheck.skipSilently && fileCheck.error) report.errors.push(fileCheck.error)
    return report
  }

  const busyTimeoutMs = Math.max(0, Math.min(opts.busyTimeoutMs ?? 1_000, 10_000))
  const cutoff = nowMs - maxAgeMs
  let db: InstanceType<typeof Database> | null = null
  try {
    db = new Database(fileCheck.realFile, { fileMustExist: true, readonly: dryRun })
    db.pragma(`busy_timeout = ${busyTimeoutMs}`)
    const table = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inflight_delegate_surface'`,
      )
      .get() as { name?: string } | undefined
    if (!table?.name) {
      report.skipped = true
      return report
    }
    if (dryRun) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM inflight_delegate_surface
           WHERE state IN (${INFLIGHT_TERMINAL_SQL}) AND updated_at < ?`,
        )
        .get(cutoff) as { cnt?: number } | undefined
      report.deletedRows = Number(row?.cnt ?? 0)
      return report
    }
    const info = db
      .prepare(
        `DELETE FROM inflight_delegate_surface
         WHERE state IN (${INFLIGHT_TERMINAL_SQL}) AND updated_at < ?`,
      )
      .run(cutoff)
    report.deletedRows = info.changes
    try {
      const ckpt = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy?: number }> | undefined
      report.checkpointed = Array.isArray(ckpt) && ckpt.length > 0 ? Number(ckpt[0]?.busy ?? 0) === 0 : true
    } catch (ckptErr) {
      report.errors.push(`wal_checkpoint: ${formatErr(ckptErr)}`)
    }
  } catch (err) {
    report.errors.push(`sqlite ${dbPath}: ${formatErr(err)}`)
  } finally {
    if (db) {
      try {
        db.close()
      } catch {
        /* ignore close errors */
      }
    }
  }
  return report
}

// ---------------------------------------------------------------------------
// 4. Stale .bak / .bak.* files GC (shallow homeDir + agents/<id>/)
// ---------------------------------------------------------------------------

export interface GcStaleBakFilesOptions {
  homeDir?: string
  maxAgeMs?: number
  nowMs?: number
  dryRun?: boolean
  whitelist?: readonly string[]
}

export interface GcStaleBakFilesReport {
  scannedFiles: number
  deletedFiles: number
  whitelistedSkipped: number
  reclaimedBytes: number
  errors: string[]
}

export function isStaleBakFileName(name: string): boolean {
  return /^.+\.bak(?:\..+)?$/.test(name)
}

export function isWhitelistedBakFileName(name: string, extraWhitelist?: ReadonlySet<string>): boolean {
  if (DEFAULT_BAK_WHITELIST.has(name)) return true
  if (name.endsWith('.pre-memdir.bak')) return true
  if (extraWhitelist?.has(name)) return true
  return false
}

async function scanSafeDirForStaleBak(
  realDir: string,
  cutoff: number,
  dryRun: boolean,
  extraWhitelist: ReadonlySet<string> | undefined,
  report: GcStaleBakFilesReport,
): Promise<void> {
  let names: string[]
  try {
    names = await readdir(realDir)
  } catch (err) {
    if (isEnoent(err)) return
    report.errors.push(`readdir ${realDir}: ${formatErr(err)}`)
    return
  }

  for (const name of names) {
    if (!isStaleBakFileName(name)) continue
    const fullPath = join(realDir, name)
    try {
      const fileCheck = await verifySafeFileWithinDir(realDir, fullPath)
      if (!fileCheck.ok) {
        if (!fileCheck.skipSilently && fileCheck.error) report.errors.push(fileCheck.error)
        continue
      }
      const st = fileCheck.stat
      report.scannedFiles++

      if (isWhitelistedBakFileName(name, extraWhitelist)) {
        report.whitelistedSkipped++
        continue
      }
      if (st.mtimeMs >= cutoff) continue

      if (await unlinkIfNotDryRun(fileCheck.realFile, dryRun)) {
        report.deletedFiles++
        report.reclaimedBytes += st.size
      }
    } catch (err) {
      report.errors.push(`${fullPath}: ${formatErr(err)}`)
    }
  }
}

export async function gcStaleBakFiles(
  opts: GcStaleBakFilesOptions = {},
): Promise<GcStaleBakFilesReport> {
  const homeDir = opts.homeDir ?? paths.home
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_STALE_BAK_MAX_AGE_MS
  const nowMs = opts.nowMs ?? Date.now()
  const dryRun = opts.dryRun === true
  const cutoff = nowMs - maxAgeMs
  const extraWhitelist = opts.whitelist?.length ? new Set(opts.whitelist) : undefined

  const report: GcStaleBakFilesReport = {
    scannedFiles: 0,
    deletedFiles: 0,
    whitelistedSkipped: 0,
    reclaimedBytes: 0,
    errors: [],
  }

  // Level 0: top-level homeDir only (never recurse into workspace/, uploads/, generated/, skills/, etc.).
  const homeCheck = await verifySafeSubdirWithinRoot(homeDir, homeDir)
  if (!homeCheck.ok) {
    if (!homeCheck.missing) report.errors.push(homeCheck.error)
    return report
  }
  await scanSafeDirForStaleBak(homeCheck.realDir, cutoff, dryRun, extraWhitelist, report)

  // Level 1: agents/<id>/ only (direct children of each agent dir, no deeper recursion).
  const agentsDir = join(homeDir, 'agents')
  const agentsCheck = await verifySafeSubdirWithinRoot(homeDir, agentsDir)
  if (!agentsCheck.ok) {
    if (!agentsCheck.missing) report.errors.push(agentsCheck.error)
    return report
  }

  let agentNames: string[]
  try {
    agentNames = await readdir(agentsCheck.realDir)
  } catch (err) {
    if (!isEnoent(err)) report.errors.push(`readdir ${agentsDir}: ${formatErr(err)}`)
    return report
  }

  for (const agentName of agentNames) {
    const agentPath = join(agentsDir, agentName)
    let entryStat: Stats
    try {
      entryStat = await lstat(agentPath)
    } catch (err) {
      if (!isEnoent(err)) report.errors.push(`lstat ${agentPath}: ${formatErr(err)}`)
      continue
    }
    if (entryStat.isSymbolicLink()) {
      report.errors.push(`unsafe agent directory symlink skipped: ${agentPath}`)
      continue
    }
    if (!entryStat.isDirectory()) continue

    const agentCheck = await verifySafeSubdirWithinRoot(homeDir, agentPath)
    if (!agentCheck.ok) {
      if (!agentCheck.missing) report.errors.push(agentCheck.error)
      continue
    }
    await scanSafeDirForStaleBak(agentCheck.realDir, cutoff, dryRun, extraWhitelist, report)
  }

  return report
}

// ---------------------------------------------------------------------------
// Unified Runtime Hygiene GC Entrypoint
// ---------------------------------------------------------------------------

export interface RuntimeHygieneGcOptions {
  homeDir?: string
  nowMs?: number
  dryRun?: boolean
  inflightSurface?: Pick<DelegateInflightSurfaceStore, 'pruneStaleTerminalRows'> | null
  inflightSurfaceDbPath?: string
  cronTapes?: Omit<GcCronOccurrenceTapesOptions, 'homeDir' | 'nowMs' | 'dryRun'>
  retryQuarantine?: Omit<GcRetryQueueQuarantineOptions, 'homeDir' | 'nowMs' | 'dryRun'>
  inflight?: Omit<
    GcDelegateInflightSurfaceOptions,
    'homeDir' | 'nowMs' | 'dryRun' | 'inflightSurface' | 'dbPath'
  >
  staleBak?: Omit<GcStaleBakFilesOptions, 'homeDir' | 'nowMs' | 'dryRun'>
  log?: (event: string, fields: Record<string, unknown>) => void
}

export interface RuntimeHygieneGcReport {
  dryRun: boolean
  startedAt: number
  finishedAt: number
  cronTapes: GcCronOccurrenceTapesReport
  retryQuarantine: GcRetryQueueQuarantineReport
  inflightSurface: GcDelegateInflightSurfaceReport
  staleBak: GcStaleBakFilesReport
  totalDeletedFiles: number
  totalDeletedRows: number
  totalReclaimedBytes: number
  walCheckpointed: boolean
  warnings: string[]
  errors: string[]
}

export async function runRuntimeHygieneGc(
  opts: RuntimeHygieneGcOptions = {},
): Promise<RuntimeHygieneGcReport> {
  const startedAt = opts.nowMs ?? Date.now()
  const homeDir = opts.homeDir ?? paths.home
  const dryRun = opts.dryRun === true

  const cronTapes = await gcCronOccurrenceTapes({
    ...opts.cronTapes,
    homeDir,
    nowMs: startedAt,
    dryRun,
  }).catch((err): GcCronOccurrenceTapesReport => ({
    scannedFiles: 0,
    deletedFiles: 0,
    reclaimedBytes: 0,
    skippedActive: 0,
    skippedFresh: 0,
    skippedUnknown: 0,
    errors: [formatErr(err)],
  }))

  const retryQuarantine = await gcRetryQueueQuarantine({
    ...opts.retryQuarantine,
    homeDir,
    nowMs: startedAt,
    dryRun,
  }).catch((err): GcRetryQueueQuarantineReport => ({
    scannedFiles: 0,
    deletedFiles: 0,
    deletedByAge: 0,
    deletedByBudget: 0,
    reclaimedBytes: 0,
    remainingFiles: 0,
    remainingBytes: 0,
    quarantineBudgetExceeded: false,
    errors: [formatErr(err)],
  }))

  const inflightSurface = await gcDelegateInflightSurface({
    ...opts.inflight,
    homeDir,
    dbPath: opts.inflightSurfaceDbPath,
    inflightSurface: opts.inflightSurface,
    nowMs: startedAt,
    dryRun,
  }).catch((err): GcDelegateInflightSurfaceReport => ({
    deletedRows: 0,
    checkpointed: false,
    skipped: false,
    errors: [formatErr(err)],
  }))

  const staleBak = await gcStaleBakFiles({
    ...opts.staleBak,
    homeDir,
    nowMs: startedAt,
    dryRun,
  }).catch((err): GcStaleBakFilesReport => ({
    scannedFiles: 0,
    deletedFiles: 0,
    whitelistedSkipped: 0,
    reclaimedBytes: 0,
    errors: [formatErr(err)],
  }))

  const warnings: string[] = []
  if (retryQuarantine.quarantineBudgetExceeded) {
    warnings.push('retry_queue_quarantine_budget_exceeded')
  }

  const errors: string[] = [
    ...cronTapes.errors.map((e) => `cronTapes: ${e}`),
    ...retryQuarantine.errors.map((e) => `retryQuarantine: ${e}`),
    ...inflightSurface.errors.map((e) => `inflightSurface: ${e}`),
    ...staleBak.errors.map((e) => `staleBak: ${e}`),
  ]

  const report: RuntimeHygieneGcReport = {
    dryRun,
    startedAt,
    finishedAt: Date.now(),
    cronTapes,
    retryQuarantine,
    inflightSurface,
    staleBak,
    totalDeletedFiles: cronTapes.deletedFiles + retryQuarantine.deletedFiles + staleBak.deletedFiles,
    totalDeletedRows: inflightSurface.deletedRows,
    totalReclaimedBytes:
      cronTapes.reclaimedBytes + retryQuarantine.reclaimedBytes + staleBak.reclaimedBytes,
    walCheckpointed: inflightSurface.checkpointed,
    warnings,
    errors,
  }

  if (
    report.totalDeletedFiles > 0 ||
    report.totalDeletedRows > 0 ||
    report.warnings.length > 0 ||
    report.errors.length > 0
  ) {
    opts.log?.('runtime_hygiene_gc', {
      dryRun: report.dryRun,
      totalDeletedFiles: report.totalDeletedFiles,
      totalDeletedRows: report.totalDeletedRows,
      totalReclaimedBytes: report.totalReclaimedBytes,
      walCheckpointed: report.walCheckpointed,
      warnings: report.warnings,
      errorCount: report.errors.length,
    })
  }

  return report
}
