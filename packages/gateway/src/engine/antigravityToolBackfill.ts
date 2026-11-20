/**
 * Incremental read-only backfiller for Antigravity CLI file edit/write tool arguments (OCV5-812).
 *
 * Antigravity CLI's stream-json `tool_info.parameters` trims file body payloads
 * (`Target` / `Replacement` / `Content` / `TargetContent` / `ReplacementContent` / `CodeContent`)
 * and emits only the file path, which caused the product Outputs/Changes panel to show `+0 -0`
 * with empty diffs. However, the CLI writes the complete `tool_calls` arguments into
 * `<sessionBrainDir>/<conversationId>/.system_generated/logs/transcript_full.jsonl`.
 *
 * Security & correctness invariants:
 * - Strictly read-only, rejecting symlinks at every path segment (`lstatSync` + `O_NOFOLLOW`).
 * - B2 (resumed long conversations): `captureStartOffset()` records the pre-spawn file size/inode
 *   before the CLI launches, so resumed turns start reading strictly at this turn's appended bytes
 *   instead of re-scanning tens of MiB of prior history.
 * - B1 (1-to-1 slot attribution): every planner file call for `(kind, path)` occupies an immutable
 *   ordinal slot in `slotsByKey` (even when oversized or body-less, with `fields: null`), and every
 *   observed stream tool invocation is permanently bound to its own ordinal via `registerCall`.
 *   Slot `k` can ONLY backfill call `k` (with `minStepIndex <= plannerStepIndex < stepIndex`),
 *   so an oversized, pre-populated, or late-flushed call can NEVER borrow a neighbor's body.
 * - Per-field and per-call character caps prevent oversized files from inflating WS frames or DB rows.
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Max bytes read per incremental refresh to keep the adapter event loop responsive. */
export const MAX_BACKFILL_READ_CHUNK_BYTES = 4 * 1024 * 1024
/** Max characters allowed for a single backfilled text field (old_string / new_string / content). */
export const MAX_BACKFILL_FIELD_CHARS = 128 * 1024
/** Max combined characters allowed across one backfilled tool invocation. */
export const MAX_BACKFILL_TOTAL_CHARS = 256 * 1024
/** Upper bound on recorded planner slots per turn to prevent unbounded memory growth. */
const MAX_RECORDED_SLOTS = 512

type FileBackfillKind = 'edit' | 'write'

const FILE_TOOL_KIND: Readonly<Record<string, FileBackfillKind>> = {
  edit_file: 'edit',
  replace_file_content: 'edit',
  write_file: 'write',
  write_to_file: 'write',
}

interface PlannerFileSlot {
  plannerStepIndex: number
  kind: FileBackfillKind
  path: string
  /** Non-null only when the body passed size/validity checks; null preserves ordinal alignment. */
  fields: Record<string, string> | null
}

interface BoundToolCall {
  key: string
  ordinal: number
  resolved: boolean
}

export interface AntigravityToolBackfillerOptions {
  brainDir: string
  conversationId: string
  /** Optional override limits for deterministic unit testing. */
  maxFieldChars?: number
  maxTotalChars?: number
  maxReadChunkBytes?: number
}

function isSafeSegment(seg: string): boolean {
  return (
    seg.length > 0 &&
    seg !== '.' &&
    seg !== '..' &&
    !seg.includes('/') &&
    !seg.includes('\\') &&
    !seg.includes('\0')
  )
}

function resolveTranscriptFullPath(brainDir: string, conversationId: string): string | null {
  if (!CONVERSATION_ID_RE.test(conversationId)) return null
  const segments = [conversationId, '.system_generated', 'logs', 'transcript_full.jsonl']
  try {
    const rootStat = lstatSync(brainDir)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null
    let cur = brainDir
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i]!
      if (!isSafeSegment(seg)) return null
      cur = join(cur, seg)
      const st = lstatSync(cur)
      if (st.isSymbolicLink() || !st.isDirectory()) return null
    }
    const leaf = segments[segments.length - 1]!
    const fullPath = join(cur, leaf)
    const leafStat = lstatSync(fullPath)
    if (leafStat.isSymbolicLink() || !leafStat.isFile()) return null
    return fullPath
  } catch {
    return null
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function firstNonEmptyString(obj: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const val = obj[key]
    if (typeof val === 'string' && val.length > 0) return val
  }
  return ''
}

function stringProp(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const val = obj[key]
    if (typeof val === 'string') return val
  }
  return undefined
}

export function isBackfillableAntigravityFileTool(nativeName: string): boolean {
  return Object.prototype.hasOwnProperty.call(FILE_TOOL_KIND, nativeName.trim())
}

/** True when normalized product input already contains non-empty body fields. */
export function hasFileDiffBody(nativeName: string, productInput: unknown): boolean {
  const kind = FILE_TOOL_KIND[nativeName.trim()]
  if (!kind) return true
  const obj = recordOf(productInput)
  if (!obj) return false
  if (kind === 'write') {
    return typeof obj.content === 'string' && obj.content.length > 0
  }
  const hasOld = typeof obj.old_string === 'string' && obj.old_string.length > 0
  const hasNew = typeof obj.new_string === 'string' && obj.new_string.length > 0
  return hasOld || hasNew
}

export function extractProductFilePath(productInput: unknown): string {
  const obj = recordOf(productInput)
  if (!obj) return ''
  return firstNonEmptyString(obj, ['file_path', 'path', 'Path', 'TargetFile'])
}

/**
 * Parse one planner tool_call into an ordinal-preserving slot.
 * Always returns a slot for recognized file edit/write calls with a valid path;
 * `fields` is `null` if body is missing or exceeds size caps so ordinal alignment never drifts.
 */
function extractPlannerSlot(
  tc: Record<string, unknown>,
  plannerStepIndex: number,
  maxFieldChars: number,
  maxTotalChars: number,
): PlannerFileSlot | null {
  const rawName = typeof tc.name === 'string' ? tc.name.trim() : ''
  const kind = FILE_TOOL_KIND[rawName]
  if (!kind) return null
  const args = recordOf(tc.args) ?? recordOf(tc.arguments)
  if (!args) return null
  const path = firstNonEmptyString(args, ['Path', 'TargetFile', 'file_path', 'path'])
  if (!path) return null

  if (kind === 'write') {
    const content = stringProp(args, ['Content', 'CodeContent', 'content'])
    const valid =
      content !== undefined &&
      content.length > 0 &&
      content.length <= maxFieldChars &&
      content.length <= maxTotalChars
    return {
      plannerStepIndex,
      kind,
      path,
      fields: valid ? { content } : null,
    }
  }

  const oldStr = stringProp(args, ['Target', 'TargetContent', 'old_string'])
  const newStr = stringProp(args, ['Replacement', 'ReplacementContent', 'new_string'])
  if ((oldStr === undefined || oldStr.length === 0) && (newStr === undefined || newStr.length === 0)) {
    return { plannerStepIndex, kind, path, fields: null }
  }
  const fields: Record<string, string> = {}
  let total = 0
  if (oldStr !== undefined) {
    if (oldStr.length > maxFieldChars) return { plannerStepIndex, kind, path, fields: null }
    fields.old_string = oldStr
    total += oldStr.length
  }
  if (newStr !== undefined) {
    if (newStr.length > maxFieldChars) return { plannerStepIndex, kind, path, fields: null }
    fields.new_string = newStr
    total += newStr.length
  }
  if (total === 0 || total > maxTotalChars) {
    return { plannerStepIndex, kind, path, fields: null }
  }
  return {
    plannerStepIndex,
    kind,
    path,
    fields,
  }
}

export class AntigravityToolBackfiller {
  private readonly brainDir: string
  private readonly conversationId: string
  private readonly maxFieldChars: number
  private readonly maxTotalChars: number
  private readonly maxReadChunkBytes: number

  private fileIno: number | null = null
  private byteOffset = 0
  private pendingTail = Buffer.alloc(0)
  private totalSlots = 0
  private readonly slotsByKey = new Map<string, PlannerFileSlot[]>()
  private readonly nextCallOrdinalByKey = new Map<string, number>()
  private readonly boundCalls = new Map<string, BoundToolCall>()
  private disposed = false

  constructor(opts: AntigravityToolBackfillerOptions) {
    this.brainDir = opts.brainDir
    this.conversationId = opts.conversationId
    this.maxFieldChars = opts.maxFieldChars ?? MAX_BACKFILL_FIELD_CHARS
    this.maxTotalChars = opts.maxTotalChars ?? MAX_BACKFILL_TOTAL_CHARS
    this.maxReadChunkBytes = opts.maxReadChunkBytes ?? MAX_BACKFILL_READ_CHUNK_BYTES
  }

  /**
   * Snapshot the existing transcript_full.jsonl EOF before spawning a resumed CLI turn.
   * All bytes written by this launch appear strictly after this watermark, avoiding
   * re-reading megabytes of historical turns (B2).
   */
  captureStartOffset(): void {
    if (this.disposed) return
    const fullPath = resolveTranscriptFullPath(this.brainDir, this.conversationId)
    if (!fullPath) return
    let fd: number | null = null
    try {
      const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
      fd = openSync(fullPath, flags)
      const st = fstatSync(fd)
      if (!st.isFile()) return
      this.fileIno = st.ino
      this.byteOffset = st.size
      this.pendingTail = Buffer.alloc(0)
    } catch {
      // Missing or inaccessible file before launch is normal; start at offset 0.
    } finally {
      if (fd !== null) {
        try { closeSync(fd) } catch { /* ignore */ }
      }
    }
  }

  /**
   * Bind a stream tool invocation to its permanent ordinal slot for `(kind, path)`.
   * Must be called once per file edit/write tool even when body is already present,
   * so subsequent calls on the same file never shift onto an earlier slot (B1).
   */
  private bindCall(toolUseId: string, kind: FileBackfillKind, filePath: string): BoundToolCall {
    const existing = this.boundCalls.get(toolUseId)
    if (existing) return existing
    const key = `${kind}\0${filePath}`
    const ordinal = this.nextCallOrdinalByKey.get(key) ?? 0
    this.nextCallOrdinalByKey.set(key, ordinal + 1)
    const binding: BoundToolCall = { key, ordinal, resolved: false }
    this.boundCalls.set(toolUseId, binding)
    return binding
  }

  /**
   * Attempt to backfill missing diff/content fields for an Antigravity file tool call.
   * Returns a shallow-merged new input object when matched, or null if unavailable/skipped.
   */
  tryBackfill(params: {
    toolUseId: string
    nativeName: string
    productInput: unknown
    stepIndex: number | null
    minStepIndex: number
  }): Record<string, unknown> | null {
    if (this.disposed) return null
    const { toolUseId, nativeName, productInput, stepIndex, minStepIndex } = params
    const kind = FILE_TOOL_KIND[nativeName.trim()]
    if (!kind) return null
    const filePath = extractProductFilePath(productInput)
    if (!filePath) return null

    // Always reserve this call's permanent ordinal before any early return (B1).
    const binding = this.bindCall(toolUseId, kind, filePath)
    if (binding.resolved) return null
    if (hasFileDiffBody(nativeName, productInput)) {
      binding.resolved = true
      return null
    }

    this.refreshFromDisk(minStepIndex)

    const slots = this.slotsByKey.get(binding.key)
    if (!slots || binding.ordinal >= slots.length) return null

    const slot = slots[binding.ordinal]!
    // Strict ownership check: slot must belong to this turn and precede this tool step.
    if (slot.plannerStepIndex < minStepIndex) return null
    if (stepIndex !== null && slot.plannerStepIndex >= stepIndex) return null

    // Permanently resolve this call against its exact ordinal slot:
    // if the slot was oversized/empty (`fields === null`), leave empty and NEVER borrow slot+1.
    binding.resolved = true
    if (!slot.fields) return null

    const base = recordOf(productInput) ? { ...(productInput as Record<string, unknown>) } : {}
    return {
      ...base,
      file_path: filePath,
      ...slot.fields,
    }
  }

  dispose(): void {
    this.disposed = true
    this.slotsByKey.clear()
    this.nextCallOrdinalByKey.clear()
    this.boundCalls.clear()
    this.pendingTail = Buffer.alloc(0)
    this.totalSlots = 0
  }

  private refreshFromDisk(minStepIndex: number): void {
    const fullPath = resolveTranscriptFullPath(this.brainDir, this.conversationId)
    if (!fullPath) return

    let fd: number | null = null
    try {
      const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
      fd = openSync(fullPath, flags)
      const st = fstatSync(fd)
      if (!st.isFile()) return

      if (this.fileIno !== null && (st.ino !== this.fileIno || st.size < this.byteOffset)) {
        if (this.totalSlots > 0 || this.boundCalls.size > 0) {
          // File was rotated/truncated mid-turn after slots were already recorded;
          // fail closed for the remainder of this turn rather than risking misaligned re-ingestion.
          this.dispose()
          return
        }
        this.byteOffset = 0
        this.pendingTail = Buffer.alloc(0)
      }
      this.fileIno = st.ino

      const available = st.size - this.byteOffset
      if (available <= 0) return

      const toRead = Math.min(available, this.maxReadChunkBytes)
      const chunk = Buffer.allocUnsafe(toRead)
      const bytesRead = readSync(fd, chunk, 0, toRead, this.byteOffset)
      if (bytesRead <= 0) return
      this.byteOffset += bytesRead

      const combined = this.pendingTail.length > 0
        ? Buffer.concat([this.pendingTail, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead)

      const lastNewline = combined.lastIndexOf(0x0a)
      if (lastNewline < 0) {
        this.pendingTail = combined.length <= this.maxReadChunkBytes ? Buffer.from(combined) : Buffer.alloc(0)
        return
      }

      const completeText = combined.subarray(0, lastNewline).toString('utf8')
      const trailing = combined.subarray(lastNewline + 1)
      this.pendingTail = trailing.length > 0 && trailing.length <= this.maxReadChunkBytes
        ? Buffer.from(trailing)
        : Buffer.alloc(0)

      for (const rawLine of completeText.split('\n')) {
        const line = rawLine.trim()
        if (!line) continue
        this.ingestLine(line, minStepIndex)
      }
    } catch {
      // Best-effort sideband telemetry must never disrupt tool execution or turn delivery.
    } finally {
      if (fd !== null) {
        try { closeSync(fd) } catch { /* ignore */ }
      }
    }
  }

  private ingestLine(line: string, minStepIndex: number): void {
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = recordOf(JSON.parse(line))
    } catch {
      return
    }
    if (!parsed) return
    const stepIndex = parsed.step_index
    if (typeof stepIndex !== 'number' || !Number.isSafeInteger(stepIndex) || stepIndex < minStepIndex) {
      return
    }
    const toolCalls = parsed.tool_calls
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return

    for (const rawTc of toolCalls) {
      const tc = recordOf(rawTc)
      if (!tc) continue
      const slot = extractPlannerSlot(tc, stepIndex, this.maxFieldChars, this.maxTotalChars)
      if (!slot) continue
      if (this.totalSlots >= MAX_RECORDED_SLOTS) return
      const key = `${slot.kind}\0${slot.path}`
      const list = this.slotsByKey.get(key)
      if (list) list.push(slot)
      else this.slotsByKey.set(key, [slot])
      this.totalSlots += 1
    }
  }
}
