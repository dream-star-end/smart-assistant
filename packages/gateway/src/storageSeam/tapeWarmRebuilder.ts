/**
 * OCV5-890 Wave 1B — Layer 1 Deterministic PG Tape Warm Rebuilder.
 *
 * Covers:
 * - Tier 2A: Same-engine deterministic native transcript archive rebuild
 *   (CCB JSONL, Codex rollout JSONL, Antigravity step replay archive JSON,
 *   plus table-driven generic JSONL for Grok / Cursor / Zcode).
 * - Tier 2B: Cross-engine / major-version `anchored_v2` handoff package
 *   retaining first-turn goal, latest plan/decision anchors, last 2 turns of
 *   full tool outputs, and all ArtifactBlobRef media references.
 * - Tier 3: Cold degraded suffix with `[4, 16, 64]` ladder truncation and
 *   transparent `sys.context_rebuilt` notification payload.
 *
 * V5 guardrails: zero `process.env`, zero special-case engine equality checks
 * (all dispatch via `Record<AuthorityEngineKind, ...>`).
 */
import { createHash } from 'node:crypto'
import type {
  ArtifactBlobPutInput,
  ArtifactBlobRef,
  ArtifactBlobStore,
  AuthoritativeRollingCheckpoint,
  AuthorityEngineKind,
} from '@openclaude/protocol/storage-seam'

export interface TapeRecordInput {
  readonly seq: number
  readonly role: 'user' | 'assistant' | 'system' | 'tool'
  readonly text: string
  readonly toolName?: string
  readonly toolCallId?: string
  readonly mediaRefs?: readonly ArtifactBlobRef[]
  readonly runtimeSource?: string
  readonly rawEvent?: Readonly<Record<string, unknown>>
  readonly timestampMs?: number
}

export type NativeTranscriptArchiveFormat =
  | 'ccb_jsonl'
  | 'codex_rollout_jsonl'
  | 'antigravity_step_archive_json'
  | 'generic_jsonl'

export interface RebuildNativeTranscriptArchiveInput {
  readonly engine: AuthorityEngineKind
  readonly nativeSessionId: string
  readonly cwd: string
  readonly records: readonly TapeRecordInput[]
  readonly promptCacheMeta?: Readonly<Record<string, unknown>> | null
  readonly createdAt?: string
}

export interface NativeTranscriptArchiveResult {
  readonly engine: AuthorityEngineKind
  readonly nativeSessionId: string
  readonly format: NativeTranscriptArchiveFormat
  readonly mimeType: string
  readonly logicalPath: string
  readonly contentText: string
  readonly bytes: Uint8Array
  readonly sha256: string
  readonly sizeBytes: number
  readonly recordCount: number
  readonly lastSeq: number
  readonly headRecordId: string | null
  readonly mediaRefs: readonly ArtifactBlobRef[]
  readonly toBlobPutInput: (tenantId: string) => ArtifactBlobPutInput
}

export interface BuildAnchoredV2HandoffInput {
  readonly records: readonly TapeRecordInput[]
  readonly targetContextWindowTokens: number
  readonly existingCheckpoint?: AuthoritativeRollingCheckpoint | null
  readonly maxRecentToolTurns?: number
}

export interface AnchoredToolOutputEntry {
  readonly seq: number
  readonly toolName?: string
  readonly toolCallId?: string
  readonly text: string
}

export interface AnchoredV2HandoffPackage {
  readonly mode: 'anchored_v2'
  readonly anchorSeq: number
  readonly firstTurnGoal: string | null
  readonly latestPlanAnchors: readonly string[]
  readonly recentToolOutputs: readonly AnchoredToolOutputEntry[]
  readonly mediaRefs: readonly ArtifactBlobRef[]
  readonly summary: string
  readonly estimatedTokens: number
  readonly targetContextWindowTokens: number
  readonly includedRecordCount: number
  readonly truncatedRecordCount: number
}

export interface BuildColdDegradedSuffixInput {
  readonly records: readonly TapeRecordInput[]
  readonly ladderSteps?: readonly number[]
  readonly maxBytes: number
  readonly reason?: string
  readonly sessionKey?: string
  readonly engine?: AuthorityEngineKind
}

export interface ContextRebuiltNoticePayload {
  readonly type: 'sys.context_rebuilt'
  readonly tier: 'cold_degraded'
  readonly reason: string
  readonly sessionKey?: string
  readonly engine?: AuthorityEngineKind
  readonly selectedStep: number
  readonly includedRecords: number
  readonly totalRecords: number
  readonly truncatedRecords: number
  readonly bytesUsed: number
  readonly maxBytes: number
  readonly anchorSeq: number
  readonly mediaRefCount: number
}

export interface ColdDegradedSuffixResult {
  readonly tier: 'cold_degraded'
  readonly selectedStep: number
  readonly records: readonly TapeRecordInput[]
  readonly mediaRefs: readonly ArtifactBlobRef[]
  readonly suffixText: string
  readonly bytesUsed: number
  readonly truncatedRecords: number
  readonly anchorSeq: number
  readonly notice: ContextRebuiltNoticePayload
}

const DEFAULT_LADDER_STEPS = [4, 16, 64] as const
const DEFAULT_BASE_TIMESTAMP_MS = Date.UTC(2026, 0, 1, 0, 0, 0)
const CHARS_PER_TOKEN_ESTIMATE = 4
const PLAN_ANCHOR_RE =
  /(?:\b(?:plan|decision|milestone|architecture|todo|next\s+steps?|summary|goal)\b|计划|方案|决策|结论|里程碑|待办)/i

interface GeneratedArchiveBody {
  readonly format: NativeTranscriptArchiveFormat
  readonly mimeType: string
  readonly logicalPath: string
  readonly contentText: string
  readonly headRecordId: string | null
}

type NativeArchiveGenerator = (
  input: RebuildNativeTranscriptArchiveInput,
  sortedRecords: readonly TapeRecordInput[],
  allMediaRefs: readonly ArtifactBlobRef[],
) => GeneratedArchiveBody

function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

function deterministicUuid(seed: string): string {
  const hex = sha256Hex(seed)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Encode a workspace cwd into a deterministic safe CCB projects directory slug. */
export function encodeCcbProjectDir(cwd: string): string {
  const normalized = cwd.trim().replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  const slug = normalized.replace(/[^A-Za-z0-9._-]/g, '-')
  return slug.length > 0 && slug !== '.' && slug !== '..' ? slug : 'root'
}

function sanitizeIdSegment(raw: string): string {
  const cleaned = raw.trim().replace(/[^A-Za-z0-9._:-]/g, '_')
  return cleaned.length > 0 ? cleaned : 'session'
}

function normalizeAndSortRecords(records: readonly TapeRecordInput[]): TapeRecordInput[] {
  const bySeq = new Map<number, TapeRecordInput>()
  for (const rec of records) {
    bySeq.set(rec.seq, rec)
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

function collectUniqueMediaRefs(records: readonly TapeRecordInput[]): ArtifactBlobRef[] {
  const seen = new Set<string>()
  const out: ArtifactBlobRef[] = []
  for (const rec of records) {
    if (!rec.mediaRefs) continue
    for (const ref of rec.mediaRefs) {
      if (seen.has(ref.blobId)) continue
      seen.add(ref.blobId)
      out.push(ref)
    }
  }
  return out
}

function recordIsoTime(rec: TapeRecordInput | undefined, fallbackIso?: string): string {
  if (rec && typeof rec.timestampMs === 'number' && Number.isFinite(rec.timestampMs)) {
    return new Date(rec.timestampMs).toISOString()
  }
  if (fallbackIso) return fallbackIso
  const offset = rec ? Math.max(0, rec.seq) * 1000 : 0
  return new Date(DEFAULT_BASE_TIMESTAMP_MS + offset).toISOString()
}

function buildCcbArchive(
  input: RebuildNativeTranscriptArchiveInput,
  sortedRecords: readonly TapeRecordInput[],
): GeneratedArchiveBody {
  const safeSessionId = sanitizeIdSegment(input.nativeSessionId)
  const lines: string[] = []
  let parentUuid: string | null = null

  for (const rec of sortedRecords) {
    const uuid = deterministicUuid(`ccb:${input.nativeSessionId}:${rec.seq}:${rec.role}`)
    const timestamp = recordIsoTime(rec, input.createdAt)
    const contentBlocks: Array<Record<string, unknown>> = []

    if (rec.role === 'tool') {
      contentBlocks.push({
        type: 'tool_result',
        tool_use_id:
          rec.toolCallId ?? deterministicUuid(`tool:${input.nativeSessionId}:${rec.seq}`),
        ...(rec.toolName ? { name: rec.toolName } : {}),
        content: rec.text,
      })
    } else {
      contentBlocks.push({ type: 'text', text: rec.text })
    }

    if (rec.mediaRefs && rec.mediaRefs.length > 0) {
      for (const media of rec.mediaRefs) {
        contentBlocks.push({
          type: 'artifact_ref',
          blobId: media.blobId,
          sha256: media.sha256,
          mimeType: media.mimeType,
          sizeBytes: media.sizeBytes,
          ...(media.logicalName ? { logicalName: media.logicalName } : {}),
        })
      }
    }

    const messageRole = rec.role === 'tool' ? 'user' : rec.role
    const entryType =
      rec.role === 'assistant' ? 'assistant' : rec.role === 'system' ? 'system' : 'user'

    lines.push(
      JSON.stringify({
        uuid,
        parentUuid,
        sessionId: input.nativeSessionId,
        cwd: input.cwd,
        type: entryType,
        timestamp,
        seq: rec.seq,
        ...(rec.runtimeSource ? { runtimeSource: rec.runtimeSource } : {}),
        message: {
          role: messageRole,
          content: contentBlocks,
        },
      }),
    )
    parentUuid = uuid
  }

  return {
    format: 'ccb_jsonl',
    mimeType: 'application/x-ndjson',
    logicalPath: `projects/${encodeCcbProjectDir(input.cwd)}/${safeSessionId}.jsonl`,
    contentText: lines.length > 0 ? `${lines.join('\n')}\n` : '',
    headRecordId: parentUuid,
  }
}

function buildCodexArchive(
  input: RebuildNativeTranscriptArchiveInput,
  sortedRecords: readonly TapeRecordInput[],
): GeneratedArchiveBody {
  const safeSessionId = sanitizeIdSegment(input.nativeSessionId)
  const firstIso = recordIsoTime(sortedRecords[0], input.createdAt)
  const dateObj = new Date(firstIso)
  const yyyy = String(dateObj.getUTCFullYear()).padStart(4, '0')
  const mm = String(dateObj.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dateObj.getUTCDate()).padStart(2, '0')
  const compactTs = firstIso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

  const lines: string[] = [
    JSON.stringify({
      type: 'session_meta',
      timestamp: firstIso,
      payload: {
        id: input.nativeSessionId,
        cwd: input.cwd,
        originator: 'openclaude-tape-warm-rebuilder',
        timestamp: firstIso,
      },
    }),
  ]

  let turnIndex = 0
  let headRecordId: string | null = null

  for (const rec of sortedRecords) {
    const itemId = deterministicUuid(`codex:${input.nativeSessionId}:${rec.seq}:${rec.role}`)
    const timestamp = recordIsoTime(rec, input.createdAt)

    if (rec.role === 'user') {
      turnIndex += 1
      lines.push(
        JSON.stringify({
          type: 'turn_context',
          timestamp,
          payload: {
            turn_id: `turn_${turnIndex}`,
            seq: rec.seq,
            cwd: input.cwd,
          },
        }),
      )
    }

    const mediaRefs =
      rec.mediaRefs && rec.mediaRefs.length > 0
        ? rec.mediaRefs.map((m) => ({
            blob_id: m.blobId,
            sha256: m.sha256,
            mime_type: m.mimeType,
            size_bytes: m.sizeBytes,
            ...(m.logicalName ? { logical_name: m.logicalName } : {}),
          }))
        : undefined

    const payload =
      rec.role === 'tool'
        ? {
            type: 'function_call_output',
            id: itemId,
            call_id: rec.toolCallId ?? itemId,
            name: rec.toolName ?? 'tool',
            output: rec.text,
            seq: rec.seq,
            ...(mediaRefs ? { media_refs: mediaRefs } : {}),
          }
        : {
            type: 'message',
            id: itemId,
            role: rec.role,
            content: [
              {
                type: rec.role === 'assistant' ? 'output_text' : 'input_text',
                text: rec.text,
              },
            ],
            seq: rec.seq,
            ...(mediaRefs ? { media_refs: mediaRefs } : {}),
          }

    lines.push(
      JSON.stringify({
        type: 'response_item',
        timestamp,
        payload,
      }),
    )
    headRecordId = itemId
  }

  return {
    format: 'codex_rollout_jsonl',
    mimeType: 'application/x-ndjson',
    logicalPath: `sessions/${yyyy}/${mm}/${dd}/rollout-${compactTs}-${safeSessionId}.jsonl`,
    contentText: `${lines.join('\n')}\n`,
    headRecordId,
  }
}

const ANTIGRAVITY_STEP_TYPE_BY_ROLE: Readonly<Record<TapeRecordInput['role'], string>> =
  Object.freeze({
    user: 'USER_INPUT',
    assistant: 'MODEL_RESPONSE',
    tool: 'TOOL_RESULT',
    system: 'SYSTEM_CONTEXT',
  })

function buildAntigravityArchive(
  input: RebuildNativeTranscriptArchiveInput,
  sortedRecords: readonly TapeRecordInput[],
  allMediaRefs: readonly ArtifactBlobRef[],
): GeneratedArchiveBody {
  const safeSessionId = sanitizeIdSegment(input.nativeSessionId)
  const steps = sortedRecords.map((rec, index) => ({
    idx: index + 1,
    seq: rec.seq,
    step_id: deterministicUuid(`antigravity:${input.nativeSessionId}:${rec.seq}:${rec.role}`),
    step_type: ANTIGRAVITY_STEP_TYPE_BY_ROLE[rec.role],
    role: rec.role,
    text: rec.text,
    ...(rec.toolName ? { tool_name: rec.toolName } : {}),
    ...(rec.toolCallId ? { tool_call_id: rec.toolCallId } : {}),
    ...(rec.mediaRefs && rec.mediaRefs.length > 0 ? { media_refs: rec.mediaRefs } : {}),
    ...(rec.runtimeSource ? { runtime_source: rec.runtimeSource } : {}),
    timestamp_ms:
      typeof rec.timestampMs === 'number' && Number.isFinite(rec.timestampMs)
        ? rec.timestampMs
        : DEFAULT_BASE_TIMESTAMP_MS + Math.max(0, rec.seq) * 1000,
  }))

  const lastStep = steps.at(-1)
  const archiveObject = {
    schemaVersion: 1,
    conversation_id: input.nativeSessionId,
    cwd: input.cwd,
    promptCacheMeta: {
      ...(input.promptCacheMeta ?? {}),
      injectedAfterBaseline:
        typeof input.promptCacheMeta?.injectedAfterBaseline === 'number'
          ? input.promptCacheMeta.injectedAfterBaseline
          : steps.length,
    },
    baselineStepIndex: steps.length,
    mediaRefs: allMediaRefs,
    steps,
  }

  return {
    format: 'antigravity_step_archive_json',
    mimeType: 'application/json',
    logicalPath: `conversations/${safeSessionId}.replay.json`,
    contentText: `${JSON.stringify(archiveObject, null, 2)}\n`,
    headRecordId: lastStep ? lastStep.step_id : null,
  }
}

function buildGenericJsonlArchive(
  input: RebuildNativeTranscriptArchiveInput,
  sortedRecords: readonly TapeRecordInput[],
): GeneratedArchiveBody {
  const safeSessionId = sanitizeIdSegment(input.nativeSessionId)
  const lines: string[] = []
  let headRecordId: string | null = null
  for (const rec of sortedRecords) {
    const id = deterministicUuid(`${input.engine}:${input.nativeSessionId}:${rec.seq}:${rec.role}`)
    lines.push(
      JSON.stringify({
        id,
        sessionId: input.nativeSessionId,
        engine: input.engine,
        cwd: input.cwd,
        seq: rec.seq,
        role: rec.role,
        text: rec.text,
        ...(rec.toolName ? { toolName: rec.toolName } : {}),
        ...(rec.toolCallId ? { toolCallId: rec.toolCallId } : {}),
        ...(rec.mediaRefs && rec.mediaRefs.length > 0 ? { mediaRefs: rec.mediaRefs } : {}),
        timestamp: recordIsoTime(rec, input.createdAt),
      }),
    )
    headRecordId = id
  }
  return {
    format: 'generic_jsonl',
    mimeType: 'application/x-ndjson',
    logicalPath: `sessions/${safeSessionId}.jsonl`,
    contentText: lines.length > 0 ? `${lines.join('\n')}\n` : '',
    headRecordId,
  }
}

const ARCHIVE_GENERATORS_BY_ENGINE: Readonly<Record<AuthorityEngineKind, NativeArchiveGenerator>> =
  Object.freeze({
    ccb: buildCcbArchive,
    codex: buildCodexArchive,
    antigravity: buildAntigravityArchive,
    grok: buildGenericJsonlArchive,
    cursor: buildGenericJsonlArchive,
    zcode: buildGenericJsonlArchive,
  })

/**
 * Tier 2A: Deterministically rebuild a same-engine native transcript archive
 * from authoritative PG tape records.
 */
export function rebuildNativeTranscriptArchive(
  input: RebuildNativeTranscriptArchiveInput,
): NativeTranscriptArchiveResult {
  const generator = ARCHIVE_GENERATORS_BY_ENGINE[input.engine]
  if (!generator) {
    throw new Error(`TAPE_REBUILD_UNSUPPORTED_ENGINE:${String(input.engine)}`)
  }
  const sortedRecords = normalizeAndSortRecords(input.records)
  const mediaRefs = collectUniqueMediaRefs(sortedRecords)
  const generated = generator(input, sortedRecords, mediaRefs)
  const bytes = new TextEncoder().encode(generated.contentText)
  const sha256 = sha256Hex(bytes)
  const lastSeq = sortedRecords.at(-1)?.seq ?? 0

  return {
    engine: input.engine,
    nativeSessionId: input.nativeSessionId,
    format: generated.format,
    mimeType: generated.mimeType,
    logicalPath: generated.logicalPath,
    contentText: generated.contentText,
    bytes,
    sha256,
    sizeBytes: bytes.byteLength,
    recordCount: sortedRecords.length,
    lastSeq,
    headRecordId: generated.headRecordId,
    mediaRefs,
    toBlobPutInput: (tenantId: string): ArtifactBlobPutInput => ({
      tenantId,
      kind: 'tape_archive',
      mimeType: generated.mimeType,
      bytes,
      logicalName: `${input.engine}-${sanitizeIdSegment(input.nativeSessionId)}-tape`,
      containerRelativePath: generated.logicalPath,
    }),
  }
}

/** Persist a rebuilt Tier 2A archive into an ArtifactBlobStore (`kind: 'tape_archive'`). */
export async function persistNativeTranscriptArchive(
  blobStore: ArtifactBlobStore,
  tenantId: string,
  archive: NativeTranscriptArchiveResult,
): Promise<ArtifactBlobRef> {
  return blobStore.put(archive.toBlobPutInput(tenantId))
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE)
}

function truncateToCharBudget(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (text.length <= maxChars) return text
  if (maxChars <= 24) return text.slice(0, maxChars)
  return `${text.slice(0, maxChars - 16)}\n...[truncated]`
}

function extractPlanDecisionAnchors(records: readonly TapeRecordInput[]): string[] {
  const anchors: string[] = []
  for (const rec of records) {
    const rawKind = typeof rec.rawEvent?.kind === 'string' ? rec.rawEvent.kind.toLowerCase() : ''
    const isTagged = rawKind === 'plan' || rawKind === 'decision' || rawKind === 'checkpoint'
    if (isTagged || PLAN_ANCHOR_RE.test(rec.text)) {
      const compact = rec.text.trim()
      if (compact.length > 0) {
        anchors.push(`[seq=${rec.seq} ${rec.role}] ${compact}`)
      }
    }
  }
  // Keep latest 5 plan/decision anchors in chronological order.
  return anchors.slice(-5)
}

function extractRecentTurnToolOutputs(
  sortedRecords: readonly TapeRecordInput[],
  maxRecentToolTurns: number,
): AnchoredToolOutputEntry[] {
  if (maxRecentToolTurns <= 0) return []
  // Partition records into turns starting at each 'user' record (or initial turn 0).
  const turns: TapeRecordInput[][] = []
  let currentTurn: TapeRecordInput[] = []
  for (const rec of sortedRecords) {
    if (rec.role === 'user' && currentTurn.length > 0) {
      turns.push(currentTurn)
      currentTurn = [rec]
    } else {
      currentTurn.push(rec)
    }
  }
  if (currentTurn.length > 0) turns.push(currentTurn)

  // Find the last `maxRecentToolTurns` turns that actually contain tool records.
  const turnsWithTools = turns.filter((t) => t.some((r) => r.role === 'tool'))
  const selectedTurns = turnsWithTools.slice(-maxRecentToolTurns)
  const out: AnchoredToolOutputEntry[] = []
  for (const turn of selectedTurns) {
    for (const rec of turn) {
      if (rec.role !== 'tool') continue
      out.push({
        seq: rec.seq,
        ...(rec.toolName ? { toolName: rec.toolName } : {}),
        ...(rec.toolCallId ? { toolCallId: rec.toolCallId } : {}),
        text: rec.text,
      })
    }
  }
  return out
}

/**
 * Tier 2B: Cross-engine / major-version `anchored_v2` deterministic handoff summary.
 * Retains first-turn goal, latest plan/decision anchors, last 2 turns of full
 * tool outputs, and all ArtifactBlobRef media references.
 */
export function buildAnchoredV2HandoffPackage(
  input: BuildAnchoredV2HandoffInput,
): AnchoredV2HandoffPackage {
  const sortedRecords = normalizeAndSortRecords(input.records)
  const existing = input.existingCheckpoint ?? null
  const maxRecentToolTurns = input.maxRecentToolTurns ?? 2
  const maxRecordSeq = sortedRecords.at(-1)?.seq ?? 0
  const anchorSeq = Math.max(maxRecordSeq, existing?.anchorSeq ?? 0)

  const firstUserRecord = sortedRecords.find((r) => r.role === 'user')
  const firstTurnGoal = firstUserRecord?.text.trim() || existing?.summary.trim() || null
  const latestPlanAnchors = extractPlanDecisionAnchors(sortedRecords)
  const recentToolOutputs = extractRecentTurnToolOutputs(sortedRecords, maxRecentToolTurns)
  const mediaRefs = collectUniqueMediaRefs(sortedRecords)

  const safeWindowTokens = Math.max(512, Math.floor(input.targetContextWindowTokens))
  // Reserve at most 40% of target context window for the handoff envelope.
  const maxSummaryChars = Math.max(
    1024,
    Math.floor(safeWindowTokens * 0.4) * CHARS_PER_TOKEN_ESTIMATE,
  )

  const sections: string[] = [`# Anchored Handoff (anchored_v2, anchorSeq=${anchorSeq})`]

  if (existing && existing.summary.trim().length > 0) {
    sections.push(
      `## Prior Checkpoint (gen=${existing.checkpointGeneration}, anchorSeq=${existing.anchorSeq})\n${existing.summary.trim()}`,
    )
  }
  if (firstTurnGoal) {
    sections.push(`## First-Turn Goal\n${firstTurnGoal}`)
  }
  if (latestPlanAnchors.length > 0) {
    sections.push(
      `## Latest Plan & Decision Anchors\n${latestPlanAnchors.map((a) => `- ${a}`).join('\n')}`,
    )
  }
  if (recentToolOutputs.length > 0) {
    const toolLines = recentToolOutputs.map(
      (t) =>
        `### Tool Output [seq=${t.seq}${t.toolName ? ` tool=${t.toolName}` : ''}${t.toolCallId ? ` call=${t.toolCallId}` : ''}]\n${t.text}`,
    )
    sections.push(
      `## Recent Full Tool Outputs (Last ${maxRecentToolTurns} Turns)\n${toolLines.join('\n\n')}`,
    )
  }

  // Recent non-tool dialogue tail for continuity within remaining budget.
  const recentDialogue = sortedRecords
    .filter((r) => r.role === 'user' || r.role === 'assistant')
    .slice(-6)
  if (recentDialogue.length > 0) {
    const dialogueLines = recentDialogue.map((r) => `- [seq=${r.seq} ${r.role}] ${r.text.trim()}`)
    sections.push(`## Recent Dialogue Tail\n${dialogueLines.join('\n')}`)
  }

  if (mediaRefs.length > 0) {
    const mediaLines = mediaRefs.map(
      (m) =>
        `- blobId=${m.blobId} sha256=${m.sha256} mimeType=${m.mimeType} sizeBytes=${m.sizeBytes}${m.logicalName ? ` name=${m.logicalName}` : ''}`,
    )
    sections.push(`## Media & Artifact References (${mediaRefs.length})\n${mediaLines.join('\n')}`)
  }

  // Fit cleanly inside maxSummaryChars while preserving mediaRefs section at the end.
  let summary = sections.join('\n\n')
  if (summary.length > maxSummaryChars) {
    const mediaSection = mediaRefs.length > 0 ? sections.at(-1)! : ''
    const bodyWithoutMedia = mediaRefs.length > 0 ? sections.slice(0, -1).join('\n\n') : summary
    const bodyBudget = Math.max(256, maxSummaryChars - mediaSection.length - 4)
    summary = mediaSection
      ? `${truncateToCharBudget(bodyWithoutMedia, bodyBudget)}\n\n${mediaSection}`
      : truncateToCharBudget(summary, maxSummaryChars)
  }

  const representedSeqs = new Set<number>()
  if (firstUserRecord) representedSeqs.add(firstUserRecord.seq)
  for (const t of recentToolOutputs) representedSeqs.add(t.seq)
  for (const d of recentDialogue) representedSeqs.add(d.seq)

  const includedRecordCount = representedSeqs.size
  const truncatedRecordCount = Math.max(0, sortedRecords.length - includedRecordCount)

  return {
    mode: 'anchored_v2',
    anchorSeq,
    firstTurnGoal,
    latestPlanAnchors,
    recentToolOutputs,
    mediaRefs,
    summary,
    estimatedTokens: estimateTokens(summary),
    targetContextWindowTokens: safeWindowTokens,
    includedRecordCount,
    truncatedRecordCount,
  }
}

function formatColdRecord(rec: TapeRecordInput): string {
  const header = `[seq=${rec.seq} role=${rec.role}${rec.toolName ? ` tool=${rec.toolName}` : ''}]`
  const mediaSuffix =
    rec.mediaRefs && rec.mediaRefs.length > 0
      ? ` [media:${rec.mediaRefs.map((m) => m.blobId).join(',')}]`
      : ''
  return `${header} ${rec.text.trim()}${mediaSuffix}`
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function truncateUtf8ToMaxBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (utf8ByteLength(text) <= maxBytes) return text
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const encoded = encoder.encode(text)
  return decoder.decode(encoded.subarray(0, maxBytes)).replace(/\uFFFD+$/, '')
}

/**
 * Tier 3: Cold degraded suffix builder using `[4, 16, 64]` ladder steps and
 * byte-bounded truncation, emitting a `sys.context_rebuilt` notice payload.
 */
export function buildColdDegradedSuffix(
  input: BuildColdDegradedSuffixInput,
): ColdDegradedSuffixResult {
  const sortedRecords = normalizeAndSortRecords(input.records)
  const rawSteps =
    input.ladderSteps && input.ladderSteps.length > 0 ? input.ladderSteps : DEFAULT_LADDER_STEPS
  const normalizedSteps = [...new Set(rawSteps.filter((s) => Number.isInteger(s) && s > 0))].sort(
    (a, b) => b - a,
  )
  const stepsDesc = normalizedSteps.length > 0 ? normalizedSteps : [64, 16, 4]
  const maxBytes = Math.max(64, Math.floor(input.maxBytes))
  const anchorSeq = sortedRecords.at(-1)?.seq ?? 0

  let selectedStep = stepsDesc.at(-1)!
  let chosenRecords: TapeRecordInput[] = []
  let suffixText = ''
  let matchedWithinBudget = false

  for (const step of stepsDesc) {
    const slice = sortedRecords.slice(-step)
    const rendered = slice.map(formatColdRecord).join('\n')
    if (utf8ByteLength(rendered) <= maxBytes) {
      selectedStep = step
      chosenRecords = slice
      suffixText = rendered
      matchedWithinBudget = true
      break
    }
  }

  if (!matchedWithinBudget) {
    selectedStep = stepsDesc.at(-1)!
    chosenRecords = sortedRecords.slice(-selectedStep)
    const rendered = chosenRecords.map(formatColdRecord).join('\n')
    suffixText = truncateUtf8ToMaxBytes(rendered, maxBytes)
  }

  const bytesUsed = utf8ByteLength(suffixText)
  const mediaRefs = collectUniqueMediaRefs(chosenRecords)
  const truncatedRecords = Math.max(0, sortedRecords.length - chosenRecords.length)

  const notice: ContextRebuiltNoticePayload = {
    type: 'sys.context_rebuilt',
    tier: 'cold_degraded',
    reason: input.reason ?? 'capsule_and_warm_rebuild_unavailable',
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
    ...(input.engine ? { engine: input.engine } : {}),
    selectedStep,
    includedRecords: chosenRecords.length,
    totalRecords: sortedRecords.length,
    truncatedRecords,
    bytesUsed,
    maxBytes,
    anchorSeq,
    mediaRefCount: mediaRefs.length,
  }

  return {
    tier: 'cold_degraded',
    selectedStep,
    records: chosenRecords,
    mediaRefs,
    suffixText,
    bytesUsed,
    truncatedRecords,
    anchorSeq,
    notice,
  }
}
