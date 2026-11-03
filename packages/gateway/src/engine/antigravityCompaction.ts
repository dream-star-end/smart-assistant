/**
 * Read-only Antigravity CLI native compaction reader and checkpoint step gate (OCV5-680).
 *
 * Antigravity CLI (>= 1.3.5 / 1.4.0) auto-compacts long `--conversation` sessions
 * (around 256k tokens; 840k for Claude 1M variants) using the conversation model,
 * persisting a `CortexTrajectoryStep` row (`step_type = 23`, `status = 3` DONE)
 * into `<OPENCLAUDE_HOME>/antigravity-cli/home/.gemini/antigravity-cli/conversations/<uuid>.db`.
 *
 * Wire layout of `steps.step_payload` (`step_format = 0`, protobuf):
 *   - field 1 (varint): 23 (`CORTEX_STEP_TYPE_CHECKPOINT`)
 *   - field 4 (varint): status (`3` = DONE; `5` = cancelled/failed without summary)
 *   - field 30 (length-delimited): `CortexStepCheckpoint`
 *       - field 5 (length-delimited UTF-8): `session_summary` (`<summary>...</summary>`)
 *       - field 26 (length-delimited): file/artifact snapshot diffs (excluded from handoff)
 */
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { resolveAntigravityOpenClaudeHome } from './antigravityPlatform.js'
import type { EngineAdapter, NativeModelHandoffArtifact } from './engineAdapter.js'

export { resolveAntigravityOpenClaudeHome }

export const ANTIGRAVITY_CONVERSATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const ANTIGRAVITY_CONVERSATION_DB_MAX_BYTES = 64 * 1024 * 1024
export const ANTIGRAVITY_HANDOFF_MAX_CHARS = 256_000
const CORTEX_STEP_TYPE_CHECKPOINT = 23
const CORTEX_STEP_STATUS_DONE = 3
const CORTEX_STEP_CHECKPOINT_FIELD = 30
const CORTEX_CHECKPOINT_SESSION_SUMMARY_FIELD = 5

function readVarint(buf: Uint8Array, start: number): [bigint, number] | null {
  let result = 0n
  let shift = 0n
  let pos = start
  for (let i = 0; i < 10; i += 1) {
    if (pos >= buf.length) return null
    const byte = buf[pos]!
    pos += 1
    result |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return [result, pos]
    shift += 7n
  }
  return null
}

function extractLengthDelimitedFields(
  buf: Uint8Array,
  targetFieldNumber: number,
): Uint8Array[] | null {
  const matches: Uint8Array[] = []
  let pos = 0
  while (pos < buf.length) {
    const tagPair = readVarint(buf, pos)
    if (!tagPair) return null
    const [tagBig, afterTag] = tagPair
    if (tagBig <= 0n || tagBig > 0xffffffffn) return null
    pos = afterTag
    const tag = Number(tagBig)
    const fieldNumber = tag >>> 3
    const wireType = tag & 0x7
    if (fieldNumber === 0) return null
    if (wireType === 0) {
      const skipped = readVarint(buf, pos)
      if (!skipped) return null
      pos = skipped[1]
    } else if (wireType === 1) {
      if (pos + 8 > buf.length) return null
      pos += 8
    } else if (wireType === 2) {
      const lenPair = readVarint(buf, pos)
      if (!lenPair) return null
      const [lenBig, afterLen] = lenPair
      pos = afterLen
      if (lenBig < 0n || lenBig > BigInt(buf.length - pos)) return null
      const len = Number(lenBig)
      if (fieldNumber === targetFieldNumber) {
        matches.push(buf.subarray(pos, pos + len))
      }
      pos += len
    } else if (wireType === 5) {
      if (pos + 4 > buf.length) return null
      pos += 4
    } else {
      return null
    }
  }
  return matches
}

function unwrapSummaryTag(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const openTag = '<summary>'
  const closeTag = '</summary>'
  const openIdx = trimmed.indexOf(openTag)
  const closeIdx = trimmed.lastIndexOf(closeTag)
  if (openIdx === -1 || closeIdx <= openIdx) return null
  const inner = trimmed.slice(openIdx + openTag.length, closeIdx).trim()
  if (!inner || inner.length > ANTIGRAVITY_HANDOFF_MAX_CHARS) return null
  return inner
}

function extractJsonCheckpointSummary(rawText: string): string | null {
  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') return null
    const checkpoint =
      parsed.checkpoint && typeof parsed.checkpoint === 'object'
        ? (parsed.checkpoint as Record<string, unknown>)
        : parsed
    const candidate =
      typeof checkpoint.session_summary === 'string'
        ? checkpoint.session_summary
        : typeof checkpoint.sessionSummary === 'string'
          ? checkpoint.sessionSummary
          : null
    return candidate ? unwrapSummaryTag(candidate) : null
  } catch {
    return null
  }
}

export function extractAntigravityCheckpointSummary(
  payload: unknown,
  stepFormat = 0,
): string | null {
  if (typeof payload === 'string') {
    return extractJsonCheckpointSummary(payload) ?? unwrapSummaryTag(payload)
  }
  if (!(payload instanceof Uint8Array)) return null
  if (payload.byteLength === 0) return null
  if (stepFormat !== 0) {
    const asUtf8 = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString(
      'utf8',
    )
    const fromJson = extractJsonCheckpointSummary(asUtf8)
    if (fromJson) return fromJson
  }
  const checkpoints = extractLengthDelimitedFields(payload, CORTEX_STEP_CHECKPOINT_FIELD)
  if (!checkpoints || checkpoints.length === 0) return null
  for (let i = checkpoints.length - 1; i >= 0; i -= 1) {
    const summaries = extractLengthDelimitedFields(
      checkpoints[i]!,
      CORTEX_CHECKPOINT_SESSION_SUMMARY_FIELD,
    )
    if (!summaries || summaries.length === 0) continue
    for (let j = summaries.length - 1; j >= 0; j -= 1) {
      const slice = summaries[j]!
      const text = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength).toString('utf8')
      const summary = unwrapSummaryTag(text)
      if (summary) return summary
    }
  }
  return null
}

export function readLatestAntigravityCheckpointSummary(
  openclaudeHome: string,
  conversationId: string | null | undefined,
): string | null {
  if (!conversationId || !ANTIGRAVITY_CONVERSATION_ID_RE.test(conversationId)) return null
  try {
    const conversationsDir = join(
      openclaudeHome,
      'antigravity-cli',
      'home',
      '.gemini',
      'antigravity-cli',
      'conversations',
    )
    if (!existsSync(conversationsDir)) return null
    const conversationsRoot = realpathSync(conversationsDir)
    const dbFile = resolve(conversationsRoot, `${conversationId}.db`)
    if (!dbFile.startsWith(`${conversationsRoot}/`) || !existsSync(dbFile)) return null
    const info = lstatSync(dbFile)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size <= 0 ||
      info.size > ANTIGRAVITY_CONVERSATION_DB_MAX_BYTES
    ) {
      return null
    }
    if (realpathSync(dbFile) !== dbFile) return null
    const db = new Database(dbFile, { readonly: true, fileMustExist: true })
    try {
      const rows = db
        .prepare(
          'SELECT idx, status, step_format, step_payload FROM steps WHERE step_type = ? ORDER BY idx DESC',
        )
        .all(CORTEX_STEP_TYPE_CHECKPOINT) as Array<{
        status?: unknown
        step_format?: unknown
        step_payload?: unknown
      }>
      for (const row of rows) {
        if (
          typeof row.status === 'number' &&
          row.status !== CORTEX_STEP_STATUS_DONE &&
          row.status !== 0
        ) {
          continue
        }
        const stepFormat = typeof row.step_format === 'number' ? row.step_format : 0
        const summary = extractAntigravityCheckpointSummary(row.step_payload, stepFormat)
        if (summary) return summary
      }
      return null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

export async function readLatestAntigravityNativeHandoff(
  openclaudeHome: string,
  conversationId: string,
  compactStartedAt = Date.now(),
): Promise<NativeModelHandoffArtifact | null> {
  const summaryText = readLatestAntigravityCheckpointSummary(openclaudeHome, conversationId)
  if (!summaryText) return null
  return { summaryText, source: 'antigravity', compactStartedAt }
}

/**
 * Only this launch's own completed (`DONE`) checkpoint steps emit an internal
 * `context_compacted` observation event. Historical checkpoints replayed on
 * `--conversation` resume (`stepIndex < firstOwnStepIndex`) or non-terminal
 * updates (`ACTIVE`, `ERROR`, duplicate `DONE`) are suppressed.
 */
export function shouldEmitAntigravityCheckpointCompacted(opts: {
  state: string
  stepIndex: number | null
  firstOwnStepIndex: number | null
  emittedStepIndices: Set<number>
}): boolean {
  if (opts.state !== 'DONE' || opts.firstOwnStepIndex === null) return false
  if (opts.stepIndex !== null) {
    if (opts.stepIndex < opts.firstOwnStepIndex) return false
    if (opts.emittedStepIndices.has(opts.stepIndex)) return false
    opts.emittedStepIndices.add(opts.stepIndex)
  }
  return true
}

export interface PendingAntigravitySwitchHandoff {
  id: string
  summaryText: string
  summaryInjected?: boolean
}

const pendingSwitchHandoffs = new WeakMap<EngineAdapter, PendingAntigravitySwitchHandoff>()

export function captureAntigravitySwitchHandoff(opts: {
  targetRunner: EngineAdapter
  previousEngine: string | undefined
  targetEngine: string
  hasPreparedTransition: boolean
  hermeticNoTools?: boolean
  existingProviderTag?: string
  existingNativeSessionId?: string | null
  mappedResumeProviderTag?: string
  mappedResumeId?: string | null
  openclaudeHome?: string
}): void {
  if (
    opts.hermeticNoTools ||
    opts.hasPreparedTransition ||
    opts.previousEngine !== 'antigravity' ||
    opts.targetEngine === 'antigravity'
  ) {
    return
  }
  const liveId = opts.existingProviderTag === 'antigravity' ? opts.existingNativeSessionId : null
  const mappedId = opts.mappedResumeProviderTag === 'antigravity' ? opts.mappedResumeId : null
  const conversationId =
    (liveId && ANTIGRAVITY_CONVERSATION_ID_RE.test(liveId) ? liveId : null) ??
    (mappedId && ANTIGRAVITY_CONVERSATION_ID_RE.test(mappedId) ? mappedId : null)
  if (!conversationId) return
  const summaryText = readLatestAntigravityCheckpointSummary(
    opts.openclaudeHome ?? resolveAntigravityOpenClaudeHome(),
    conversationId,
  )
  if (!summaryText) return
  pendingSwitchHandoffs.set(opts.targetRunner, {
    id: `agy-checkpoint:${conversationId}`,
    summaryText,
    summaryInjected: false,
  })
}

export function consumeAntigravitySwitchHandoff(
  runner: EngineAdapter,
  eligible: boolean,
): PendingAntigravitySwitchHandoff | null {
  if (!eligible) return null
  const pending = pendingSwitchHandoffs.get(runner)
  if (!pending) return null
  pendingSwitchHandoffs.delete(runner)
  return pending
}
