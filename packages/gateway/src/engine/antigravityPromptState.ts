/**
 * OCV5-781: Deduplicate platform context across resumed Antigravity CLI turns.
 *
 * On turn 1 (fresh conversation), AntigravityAdapter injects the ~32 KB
 * `ANTIGRAVITY_PREAMBLE + platformContent` into the initial `USER_INPUT` step,
 * which the CLI persists at the head of `conversations/<uuid>.db`. Resumed
 * `--conversation <uuid>` turns replay that full native history to the model.
 * Re-injecting the identical 32 KB platform envelope into every resumed user
 * message wastes ~10k uncached input tokens per turn and bloats history toward
 * the CLI's ~253k auto-compaction cliff (`step_type = 23`), which wipes the
 * implicit prompt cache.
 *
 * Elision is fail-open to full injection: we elide the repeated platform
 * envelope ONLY when all gates hold:
 *   1. Deduplication runtime flag is enabled (default `on`; `off` disables).
 *   2. The turn is a native `--conversation <uuid>` resume.
 *   3. A durable state record written after an earlier clean `deliveredSuccess`
 *      turn matches `(sessionKey, conversationId)` and `inputsKey`.
 *   4. `conversations/<uuid>.db` is readable, has steps beyond
 *      `injectedAfterBaseline` (proving the injected turn landed in SQLite),
 *      and has NO native compaction step (`step_type = 23`) after
 *      `injectedAfterBaseline`. If the CLI compacted earlier turns, we
 *      automatically re-inject fresh full platform context once and advance
 *      `injectedAfterBaseline` after that turn succeeds.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { PromptSlotApplied } from '../promptSlots.js'
import { ANTIGRAVITY_PREAMBLE } from './antigravityPlatform.js'

export type AntigravityDedupMode = 'on' | 'off'

const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STATE_DIR = 'prompt-state'
const FLAG_REL_PATH = ['runtime-flags', 'antigravity-dedup-context'] as const
/** Native CLI checkpoint / trajectory summary step emitted at ~253k tokens. */
export const ANTIGRAVITY_COMPACTION_STEP_TYPE = 23
/** Prune untouched state files older than 7 days. */
const STATE_KEEP_MS = 7 * 24 * 60 * 60_000

/** Slots whose change alters active instructions/capabilities and requires re-injection.
 *  Excludes `ENV` (container snap SHA), `MEMORY` (rules fingerprinted separately; index churns),
 *  `MEMORY_INDEX`, `AGENTS_DYNAMIC` (collaborator roster / delegate model catalog churn),
 *  `PROJECT_MEMORY`, and `SKILLS` index churn. */
const INSTRUCTION_SLOT_NAMES = new Set([
  'SOUL',
  'USER',
  'PROJECT',
  'INTELLIGENT_UI',
  'AGENTS',
  'AGENTS_STATIC',
  'SKILLS_LITERATURE',
  'TOOLS',
  'MODEL_HINT',
  'RESEARCH',
  'REPO',
])

export interface AntigravityPromptInputsKeyArgs {
  agentId: string
  projectId?: string | null
  sessionId?: string
  cwd: string
  cwdSource: string
  sessionRepoOverlay?: unknown
  availableMcpTools: readonly string[]
  identityCompatFingerprint?: string | null
  repoSnapshot?: unknown
  skillEvalMode?: boolean
  skillEvalExclude?: string
  skillEvalDraft?: unknown
  intelligentUi?: unknown
  promptPolicyFingerprint?: string
  frozenProjectContext?: unknown
  applied: readonly PromptSlotApplied[]
  /** Fingerprint of the MEMORY rules (index churn excluded). */
  memoryInstructionsFingerprint?: string | null
  /** Optional explicit fingerprint of AGENTS static capabilities (dynamic roster/catalog excluded). */
  agentsStaticFingerprint?: string | null
}

export interface AntigravityInjectedContextState {
  v: 1
  sessionKey: string
  conversationId: string
  inputsKey: string
  /** Inclusive pre-spawn `MAX(idx)` of the turn that injected full context. */
  injectedAfterBaseline: number
  updatedAt: number
}

export type AntigravityPromptElideReason =
  | 'elided'
  | 'flag_off'
  | 'fresh_conversation'
  | 'fallback_prompt'
  | 'no_prior_state'
  | 'conversation_changed'
  | 'inputs_changed'
  | 'db_missing_or_unsafe'
  | 'db_unverified_baseline'
  | 'compacted_since_injection'
  | 'db_error'

export interface AntigravityPromptElideDecision {
  elide: boolean
  reason: AntigravityPromptElideReason
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function stateFilePath(antigravityRootDir: string, sessionKey: string): string {
  return path.join(antigravityRootDir, STATE_DIR, `${sha256Hex(sessionKey).slice(0, 32)}.json`)
}

/** `OC_ANTIGRAVITY_DEDUP_CONTEXT` wins; else `<openClaudeHome>/runtime-flags/antigravity-dedup-context`; default `on`. */
export function resolveAntigravityDedupMode(
  openClaudeHome: string,
  env: NodeJS.ProcessEnv = process.env,
): AntigravityDedupMode {
  let raw = env.OC_ANTIGRAVITY_DEDUP_CONTEXT
  if (raw === undefined || raw.trim() === '') {
    try {
      raw = readFileSync(path.join(openClaudeHome, ...FLAG_REL_PATH), 'utf8')
    } catch {
      raw = undefined
    }
  }
  const normalized = raw?.trim().toLowerCase()
  if (normalized === 'off' || normalized === '0' || normalized === 'false') return 'off'
  return 'on'
}

export function buildAntigravityPromptInputsKey(args: AntigravityPromptInputsKeyArgs): string {
  const instructionSlots = args.applied
    .filter((slot) => INSTRUCTION_SLOT_NAMES.has(slot.name))
    .map((slot) => {
      if (slot.name === 'AGENTS') {
        const staticSha = args.agentsStaticFingerprint ?? slot.meta?.static_sha256
        if (staticSha) {
          return ['AGENTS', staticSha, null] as const
        }
      }
      if (slot.name === 'AGENTS_STATIC') {
        return ['AGENTS', slot.sha256, null] as const
      }
      return [slot.name, slot.sha256, slot.meta ?? null] as const
    })
  return sha256Hex(
    JSON.stringify([
      'ocv5-781-v1',
      sha256Hex(ANTIGRAVITY_PREAMBLE),
      args.agentId,
      args.projectId ?? null,
      args.sessionId ?? null,
      args.cwd,
      args.cwdSource,
      args.sessionRepoOverlay ?? null,
      [...args.availableMcpTools].sort(),
      args.identityCompatFingerprint ?? null,
      args.repoSnapshot ?? null,
      Boolean(args.skillEvalMode),
      args.skillEvalExclude ?? null,
      args.skillEvalDraft ?? null,
      args.intelligentUi ?? false,
      args.promptPolicyFingerprint ?? null,
      args.frozenProjectContext ?? null,
      instructionSlots,
      args.memoryInstructionsFingerprint ?? null,
    ]),
  )
}

export function readAntigravityPromptState(
  antigravityRootDir: string,
  sessionKey: string,
): AntigravityInjectedContextState | null {
  try {
    const raw = readFileSync(stateFilePath(antigravityRootDir, sessionKey), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AntigravityInjectedContextState>
    if (
      !parsed ||
      parsed.v !== 1 ||
      parsed.sessionKey !== sessionKey ||
      typeof parsed.conversationId !== 'string' ||
      !CONVERSATION_ID_RE.test(parsed.conversationId) ||
      typeof parsed.inputsKey !== 'string' ||
      parsed.inputsKey.length !== 64 ||
      typeof parsed.injectedAfterBaseline !== 'number' ||
      !Number.isSafeInteger(parsed.injectedAfterBaseline) ||
      parsed.injectedAfterBaseline < -1 ||
      typeof parsed.updatedAt !== 'number' ||
      !Number.isFinite(parsed.updatedAt)
    ) {
      return null
    }
    return parsed as AntigravityInjectedContextState
  } catch {
    return null
  }
}

let lastPruneAt = 0

function pruneStaleStates(stateDir: string, now: number): void {
  if (now - lastPruneAt < 60 * 60_000) return
  lastPruneAt = now
  let entries: string[]
  try {
    entries = readdirSync(stateDir)
  } catch {
    return
  }
  for (const name of entries) {
    const full = path.join(stateDir, name)
    try {
      if (now - statSync(full).mtimeMs > STATE_KEEP_MS) {
        rmSync(full, { force: true })
      }
    } catch {
      /* best effort */
    }
  }
}

export function writeAntigravityPromptState(
  antigravityRootDir: string,
  state: AntigravityInjectedContextState,
  now = Date.now(),
): void {
  invalidateConversationInspectCacheForId(state.conversationId)
  const dir = path.join(antigravityRootDir, STATE_DIR)
  const target = stateFilePath(antigravityRootDir, state.sessionKey)
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, target)
  } catch {
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
  }
  pruneStaleStates(dir, now)
}

export function clearAntigravityPromptState(antigravityRootDir: string, sessionKey: string): void {
  const existing = readAntigravityPromptState(antigravityRootDir, sessionKey)
  if (existing) invalidateConversationInspectCacheForId(existing.conversationId)
  try {
    rmSync(stateFilePath(antigravityRootDir, sessionKey), { force: true })
  } catch {
    /* best effort */
  }
}

interface ConversationInspectCacheEntry {
  conversationId: string
  injectedAfterBaseline: number
  mtimeMs: number
  ctimeMs: number
  size: number
  ino: number
  walMtimeMs: number
  walCtimeMs: number
  walSize: number
  walIno: number
  result: { ok: true } | { ok: false; reason: AntigravityPromptElideReason }
}

const CONVERSATION_INSPECT_CACHE_MAX_ENTRIES = 256
const conversationInspectCache = new Map<string, ConversationInspectCacheEntry>()
let conversationDbScanCount = 0

/** Test/diagnostic helper: clears the `(mtimeMs, size)` SQLite inspection cache. */
export function resetAntigravityConversationInspectCache(): void {
  conversationInspectCache.clear()
  conversationDbScanCount = 0
}

/** Test/diagnostic helper: returns how many times `conversations/<uuid>.db` was opened for SQLite scan. */
export function getAntigravityConversationDbScanCount(): number {
  return conversationDbScanCount
}

function invalidateConversationInspectCacheForId(conversationId: string): void {
  for (const [key, entry] of conversationInspectCache) {
    if (entry.conversationId === conversationId) {
      conversationInspectCache.delete(key)
    }
  }
}

function statWalStamp(filename: string): { mtimeMs: number; ctimeMs: number; size: number; ino: number } {
  try {
    const st = lstatSync(`${filename}-wal`)
    if (st.isFile()) {
      return { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino }
    }
  } catch {
    /* no active WAL sidecar */
  }
  return { mtimeMs: -1, ctimeMs: -1, size: -1, ino: -1 }
}

function inspectConversationSinceInjection(
  conversationsDir: string,
  conversationId: string,
  injectedAfterBaseline: number,
): { ok: true } | { ok: false; reason: AntigravityPromptElideReason } {
  if (!CONVERSATION_ID_RE.test(conversationId)) {
    return { ok: false, reason: 'db_missing_or_unsafe' }
  }
  let resolvedDir: string
  try {
    if (!existsSync(conversationsDir)) return { ok: false, reason: 'db_missing_or_unsafe' }
    resolvedDir = realpathSync(conversationsDir)
  } catch {
    return { ok: false, reason: 'db_missing_or_unsafe' }
  }
  const filename = path.join(resolvedDir, `${conversationId}.db`)
  let db: Database.Database | null = null
  try {
    const st = lstatSync(filename)
    if (!st.isFile() || realpathSync(filename) !== filename) {
      conversationInspectCache.delete(filename)
      return { ok: false, reason: 'db_missing_or_unsafe' }
    }
    const wal = statWalStamp(filename)
    const cached = conversationInspectCache.get(filename)
    if (
      cached &&
      cached.injectedAfterBaseline === injectedAfterBaseline &&
      cached.mtimeMs === st.mtimeMs &&
      cached.ctimeMs === st.ctimeMs &&
      cached.size === st.size &&
      cached.ino === st.ino &&
      cached.walMtimeMs === wal.mtimeMs &&
      cached.walCtimeMs === wal.ctimeMs &&
      cached.walSize === wal.size &&
      cached.walIno === wal.ino
    ) {
      return cached.result
    }

    conversationDbScanCount += 1
    db = new Database(filename, { readonly: true, fileMustExist: true, timeout: 1000 })
    db.pragma('query_only = ON')
    // Keep the two indexed lookups so cache misses stay O(log N) on large conversation DBs.
    const maxRow = db.prepare('SELECT MAX(idx) AS maxIdx FROM steps').get() as
      | { maxIdx: unknown }
      | undefined
    const maxIdx = maxRow?.maxIdx
    let result: { ok: true } | { ok: false; reason: AntigravityPromptElideReason }
    if (typeof maxIdx !== 'number' || !Number.isSafeInteger(maxIdx) || maxIdx <= injectedAfterBaseline) {
      result = { ok: false, reason: 'db_unverified_baseline' }
    } else {
      const compacted = db
        .prepare('SELECT 1 AS hit FROM steps WHERE idx > ? AND step_type = ? LIMIT 1')
        .get(injectedAfterBaseline, ANTIGRAVITY_COMPACTION_STEP_TYPE) as { hit?: number } | undefined
      result = compacted ? { ok: false, reason: 'compacted_since_injection' } : { ok: true }
    }
    if (conversationInspectCache.size >= CONVERSATION_INSPECT_CACHE_MAX_ENTRIES) {
      const oldestKey = conversationInspectCache.keys().next().value
      if (oldestKey !== undefined) conversationInspectCache.delete(oldestKey)
    }
    conversationInspectCache.set(filename, {
      conversationId,
      injectedAfterBaseline,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
      size: st.size,
      ino: st.ino,
      walMtimeMs: wal.mtimeMs,
      walCtimeMs: wal.ctimeMs,
      walSize: wal.size,
      walIno: wal.ino,
      result,
    })
    return result
  } catch {
    conversationInspectCache.delete(filename)
    return { ok: false, reason: 'db_error' }
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

export function decideAntigravityPromptElision(args: {
  openClaudeHome: string
  antigravityRootDir: string
  conversationsDir: string
  sessionKey: string
  requestedConversationId: string | null
  inputsKey: string | null
  env?: NodeJS.ProcessEnv
}): AntigravityPromptElideDecision {
  if (resolveAntigravityDedupMode(args.openClaudeHome, args.env) === 'off') {
    return { elide: false, reason: 'flag_off' }
  }
  if (!args.requestedConversationId || !CONVERSATION_ID_RE.test(args.requestedConversationId)) {
    return { elide: false, reason: 'fresh_conversation' }
  }
  if (!args.inputsKey) {
    return { elide: false, reason: 'fallback_prompt' }
  }
  const prior = readAntigravityPromptState(args.antigravityRootDir, args.sessionKey)
  if (!prior) {
    return { elide: false, reason: 'no_prior_state' }
  }
  if (prior.conversationId !== args.requestedConversationId) {
    return { elide: false, reason: 'conversation_changed' }
  }
  if (prior.inputsKey !== args.inputsKey) {
    return { elide: false, reason: 'inputs_changed' }
  }
  const historyCheck = inspectConversationSinceInjection(
    args.conversationsDir,
    args.requestedConversationId,
    prior.injectedAfterBaseline,
  )
  if (!historyCheck.ok) {
    return { elide: false, reason: historyCheck.reason }
  }
  return { elide: true, reason: 'elided' }
}
