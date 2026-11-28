/**
 * Bounded read-only filesystem containment & incremental transcript telemetry
 * helpers for Antigravity CLI native swarm watching (split out of
 * `antigravitySwarmWatcher.ts` to keep each module well below the 2,000-line
 * yellow-zone limit).
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs'
import { lstat as lstatAsync, open as openAsync, realpath as realpathAsync } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  applyTranscriptStepToBgTasks,
  createBackgroundTaskState,
  reconcileOverflowBgTasksFromJsonlBuffer,
  summarizeBackgroundTaskState,
  type BackgroundTaskTelemetrySummary,
  type MutableBackgroundTaskState,
} from './antigravitySwarmBgTasks.js'

export const MAX_TELEMETRY_DELTA_BYTES = 128 * 1024
export const MAX_TELEMETRY_DRAIN_BYTES = 16 * 1024 * 1024
const MAX_TELEMETRY_REMAINDER_BYTES = 2 * 1024 * 1024
export const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface MemberTelemetrySnapshot {
  firstStepAt?: number
  lastActiveAt?: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  thinkingTokens: number
  toolCalls: number
  windowInputTokens?: number
  windowOutputTokens?: number
  windowCacheReadTokens?: number
  windowThinkingTokens?: number
  partial?: boolean
  hasBacklog?: boolean
  /** Incremental byte-0..offset background-task lifecycle state (internal; never sent over wire). */
  bgTasks?: BackgroundTaskTelemetrySummary
}

interface TelemetryCursor extends MemberTelemetrySnapshot {
  dev: number
  ino: number
  byteOffset: number
  lastSeenSize: number
  mutationEpoch: number
  remainder: string
  decoder: StringDecoder
  droppedOversizedLine: boolean
  hadMalformedLine: boolean
  bgEpochIncomplete: boolean
  bgResetByteOffset: number
  bgReverifiedAtOffset: number
  bgTaskState: MutableBackgroundTaskState
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function recordOf(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function firstNonNegInt(...candidates: unknown[]): number {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
      return Math.floor(c)
    }
  }
  return 0
}

function isSafePathSegment(seg: string): boolean {
  return (
    seg.length > 0 &&
    seg !== '.' &&
    seg !== '..' &&
    !seg.includes('/') &&
    !seg.includes('\\') &&
    !seg.includes('\0')
  )
}

const REAL_ROOT_CACHE_MAX_ENTRIES = 128
const realRootCache = new Map<string, { realRoot: string; dev: number; ino: number }>()
let realRootResolveCount = 0

/** Test/diagnostic helper: clears the cached `realRoot` map. */
export function resetSwarmRealRootCache(): void {
  realRootCache.clear()
  realRootResolveCount = 0
}

/** Test/diagnostic helper: returns how many times `realpath(rootDir)` was resolved. */
export function getSwarmRealRootResolveCount(): number {
  return realRootResolveCount
}

function storeRealRootCache(rootDir: string, realRoot: string, rootStat: Stats): string {
  if (realRootCache.size >= REAL_ROOT_CACHE_MAX_ENTRIES) {
    const oldestKey = realRootCache.keys().next().value
    if (oldestKey !== undefined) realRootCache.delete(oldestKey)
  }
  realRootCache.set(rootDir, { realRoot, dev: rootStat.dev, ino: rootStat.ino })
  return realRoot
}

function resolveCachedRealRootSync(rootDir: string, rootStat: Stats): string {
  const cached = realRootCache.get(rootDir)
  if (cached && cached.dev === rootStat.dev && cached.ino === rootStat.ino) {
    return cached.realRoot
  }
  realRootResolveCount += 1
  return storeRealRootCache(rootDir, realpathSync(rootDir), rootStat)
}

async function resolveCachedRealRootAsync(rootDir: string, rootStat: Stats): Promise<string> {
  const cached = realRootCache.get(rootDir)
  if (cached && cached.dev === rootStat.dev && cached.ino === rootStat.ino) {
    return cached.realRoot
  }
  realRootResolveCount += 1
  const realRoot = await realpathAsync(rootDir)
  return storeRealRootCache(rootDir, realRoot, rootStat)
}

/**
 * Walk every path component under `rootDir` rejecting symlinks at EVERY level
 * (root, intermediate directories, and leaf). Returns the verified path and
 * lstat result for a regular file, or null on any symlink/traversal/missing node.
 */
export function resolveRegularFileWithinRoot(
  rootDir: string,
  segments: readonly string[],
): { fullPath: string; stat: Stats; rootStat: Stats } | null {
  if (segments.length === 0) return null
  try {
    const rootStat = lstatSync(rootDir)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null
    let cur = rootDir
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i]!
      if (!isSafePathSegment(seg)) return null
      cur = join(cur, seg)
      const st = lstatSync(cur)
      if (st.isSymbolicLink() || !st.isDirectory()) return null
    }
    const leaf = segments[segments.length - 1]!
    if (!isSafePathSegment(leaf)) return null
    const fullPath = join(cur, leaf)
    const leafStat = lstatSync(fullPath)
    if (leafStat.isSymbolicLink() || !leafStat.isFile()) return null
    return { fullPath, stat: leafStat, rootStat }
  } catch {
    return null
  }
}

export async function resolveRegularFileWithinRootAsync(
  rootDir: string,
  segments: readonly string[],
): Promise<{ fullPath: string; stat: Stats; rootStat: Stats } | null> {
  if (segments.length === 0) return null
  try {
    const rootStat = await lstatAsync(rootDir)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null
    let cur = rootDir
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i]!
      if (!isSafePathSegment(seg)) return null
      cur = join(cur, seg)
      const st = await lstatAsync(cur)
      if (st.isSymbolicLink() || !st.isDirectory()) return null
    }
    const leaf = segments[segments.length - 1]!
    if (!isSafePathSegment(leaf)) return null
    const fullPath = join(cur, leaf)
    const leafStat = await lstatAsync(fullPath)
    if (leafStat.isSymbolicLink() || !leafStat.isFile()) return null
    return { fullPath, stat: leafStat, rootStat }
  } catch {
    return null
  }
}

export function statSignatureWithinRoot(rootDir: string, segments: readonly string[]): string {
  const resolved = resolveRegularFileWithinRoot(rootDir, segments)
  if (!resolved) return '-'
  const st = resolved.stat
  return `${st.dev}:${st.ino}:${st.size}:${Math.trunc(st.mtimeMs)}`
}

export async function statSignatureWithinRootAsync(
  rootDir: string,
  segments: readonly string[],
): Promise<string> {
  const resolved = await resolveRegularFileWithinRootAsync(rootDir, segments)
  if (!resolved) return '-'
  const st = resolved.stat
  return `${st.dev}:${st.ino}:${st.size}:${Math.trunc(st.mtimeMs)}`
}

export interface BoundedTailReadOptions {
  /** Widen once up to this byte ceiling if a single tail line exceeds `maxBytes`. */
  maxAdaptiveBytes?: number
  /** Invoked when the read started mid-file (`st.size > readWindow`), indicating omitted prefix bytes. */
  onTruncated?: () => void
}

function readSyncSliceWithBoundary(
  fd: number,
  startOffset: number,
  size: number,
): { text: string; atLineStart: boolean } {
  const extra = startOffset > 0 ? 1 : 0
  const readLen = size + extra
  const buf = Buffer.allocUnsafe(readLen)
  let offset = 0
  while (offset < readLen) {
    const n = readSync(fd, buf, offset, readLen - offset, startOffset - extra + offset)
    if (n <= 0) break
    offset += n
  }
  const atLineStart = extra === 0 || (offset > 0 && buf[0] === 0x0a)
  const text = offset > extra ? buf.subarray(extra, offset).toString('utf8') : ''
  return { text, atLineStart }
}

async function readAsyncSliceWithBoundary(
  fh: Awaited<ReturnType<typeof openAsync>>,
  startOffset: number,
  size: number,
): Promise<{ text: string; atLineStart: boolean }> {
  const extra = startOffset > 0 ? 1 : 0
  const readLen = size + extra
  const buf = Buffer.allocUnsafe(readLen)
  let offset = 0
  while (offset < readLen) {
    const { bytesRead } = await fh.read(buf, offset, readLen - offset, startOffset - extra + offset)
    if (bytesRead <= 0) break
    offset += bytesRead
  }
  const atLineStart = extra === 0 || (offset > 0 && buf[0] === 0x0a)
  const text = offset > extra ? buf.subarray(extra, offset).toString('utf8') : ''
  return { text, atLineStart }
}

function trimTailToCompleteLines(slice: { text: string; atLineStart: boolean }): string | null {
  if (slice.atLineStart) {
    return slice.text.trim().length > 0 ? slice.text : null
  }
  const firstNewline = slice.text.indexOf('\n')
  if (firstNewline < 0) return null
  const sliced = slice.text.slice(firstNewline + 1)
  return sliced.trim().length > 0 ? sliced : null
}

export function readBoundedFileWithinRoot(
  rootDir: string,
  segments: readonly string[],
  maxBytes: number,
  opts?: BoundedTailReadOptions,
): string | null {
  const resolved = resolveRegularFileWithinRoot(rootDir, segments)
  if (!resolved) return null
  let fd: number | null = null
  try {
    const flags =
      fsConstants.O_RDONLY |
      (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0) |
      (typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0)
    fd = openSync(resolved.fullPath, flags)
    const st = fstatSync(fd)
    if (!st.isFile() || st.dev !== resolved.stat.dev || st.ino !== resolved.stat.ino || st.size <= 0) return null
    // Defense-in-depth containment verification against cached realpath of trusted rootDir.
    const realRoot = resolveCachedRealRootSync(rootDir, resolved.rootStat)
    const realFile = realpathSync(resolved.fullPath)
    if (!realFile.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)) return null
    const size = Math.min(st.size, maxBytes)
    const startOffset = st.size > maxBytes ? st.size - maxBytes : 0
    const slice = readSyncSliceWithBoundary(fd, startOffset, size)
    if (startOffset > 0) {
      const complete = trimTailToCompleteLines(slice)
      if (complete !== null) { opts?.onTruncated?.(); return complete }
      const adaptiveCap = opts?.maxAdaptiveBytes ? Math.max(maxBytes, opts.maxAdaptiveBytes) : maxBytes
      if (adaptiveCap > maxBytes) {
        const widerSize = Math.min(st.size, adaptiveCap)
        const widerStart = st.size > adaptiveCap ? st.size - adaptiveCap : 0
        const wider = readSyncSliceWithBoundary(fd, widerStart, widerSize)
        if (widerStart === 0) return wider.text
        opts?.onTruncated?.()
        const widerComplete = trimTailToCompleteLines(wider)
        if (widerComplete !== null) return widerComplete
        if (widerStart > 0) {
          const lookbackSize = Math.min(widerStart, 256 * 1024)
          const lookbackStart = widerStart - lookbackSize
          const prev = readSyncSliceWithBoundary(fd, lookbackStart, lookbackSize)
          const lastNl = prev.text.lastIndexOf('\n')
          if (lastNl >= 0) {
            const bounded = prev.text.slice(0, lastNl + 1)
            if (prev.atLineStart) return bounded
            const firstNl = bounded.indexOf('\n')
            return firstNl >= 0 ? bounded.slice(firstNl + 1) : ''
          }
        }
      }
      opts?.onTruncated?.()
      return ''
    }
    return slice.text
  } catch {
    return null
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* ignore */ } }
  }
}

export async function readBoundedFileWithinRootAsync(
  rootDir: string,
  segments: readonly string[],
  maxBytes: number,
  opts?: BoundedTailReadOptions,
): Promise<string | null> {
  const resolved = await resolveRegularFileWithinRootAsync(rootDir, segments)
  if (!resolved) return null
  let fh: Awaited<ReturnType<typeof openAsync>> | null = null
  try {
    const flags =
      fsConstants.O_RDONLY |
      (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0) |
      (typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0)
    fh = await openAsync(resolved.fullPath, flags)
    const st = await fh.stat()
    if (!st.isFile() || st.dev !== resolved.stat.dev || st.ino !== resolved.stat.ino || st.size <= 0) return null
    const [realRoot, realFile] = await Promise.all([
      resolveCachedRealRootAsync(rootDir, resolved.rootStat),
      realpathAsync(resolved.fullPath),
    ])
    if (!realFile.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)) return null
    const size = Math.min(st.size, maxBytes)
    const startOffset = st.size > maxBytes ? st.size - maxBytes : 0
    const slice = await readAsyncSliceWithBoundary(fh, startOffset, size)
    if (startOffset > 0) {
      const complete = trimTailToCompleteLines(slice)
      if (complete !== null) { opts?.onTruncated?.(); return complete }
      const adaptiveCap = opts?.maxAdaptiveBytes ? Math.max(maxBytes, opts.maxAdaptiveBytes) : maxBytes
      if (adaptiveCap > maxBytes) {
        const widerSize = Math.min(st.size, adaptiveCap)
        const widerStart = st.size > adaptiveCap ? st.size - adaptiveCap : 0
        const wider = await readAsyncSliceWithBoundary(fh, widerStart, widerSize)
        if (widerStart === 0) return wider.text
        opts?.onTruncated?.()
        const widerComplete = trimTailToCompleteLines(wider)
        if (widerComplete !== null) return widerComplete
        if (widerStart > 0) {
          const lookbackSize = Math.min(widerStart, 256 * 1024)
          const lookbackStart = widerStart - lookbackSize
          const prev = await readAsyncSliceWithBoundary(fh, lookbackStart, lookbackSize)
          const lastNl = prev.text.lastIndexOf('\n')
          if (lastNl >= 0) {
            const bounded = prev.text.slice(0, lastNl + 1)
            if (prev.atLineStart) return bounded
            const firstNl = bounded.indexOf('\n')
            return firstNl >= 0 ? bounded.slice(firstNl + 1) : ''
          }
        }
      }
      opts?.onTruncated?.()
      return ''
    }
    return slice.text
  } catch {
    return null
  } finally {
    if (fh !== null) { try { await fh.close() } catch { /* ignore */ } }
  }
}

/** Extract token usage and tool-call counts from a single transcript JSONL step. */
export function extractStepTelemetry(step: Record<string, unknown>): {
  ts?: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  thinkingTokens: number
  toolCalls: number
} {
  let ts: number | undefined
  const createdAt = asStr(step.created_at)
  if (createdAt) {
    const parsedTs = Date.parse(createdAt)
    if (Number.isFinite(parsedTs)) ts = parsedTs
  }

  const meta = recordOf(step.metadata)
  const usage =
    recordOf(step.usage) ??
    recordOf(step.token_usage) ??
    recordOf(step.metrics) ??
    recordOf(meta?.usage) ??
    recordOf(meta?.token_usage)

  const inputTokens = firstNonNegInt(
    usage?.input_tokens,
    usage?.inputTokens,
    usage?.prompt_tokens,
    usage?.promptTokens,
    usage?.promptTokenCount,
    step.input_tokens,
    step.inputTokens,
  )
  const outputTokens = firstNonNegInt(
    usage?.output_tokens,
    usage?.outputTokens,
    usage?.completion_tokens,
    usage?.completionTokens,
    usage?.candidatesTokenCount,
    step.output_tokens,
    step.outputTokens,
  )
  const cacheReadTokens = firstNonNegInt(
    usage?.cache_read_input_tokens,
    usage?.cache_read_tokens,
    usage?.cacheReadTokens,
    usage?.cached_content_token_count,
    usage?.cachedContentTokenCount,
    step.cache_read_input_tokens,
    step.cache_read_tokens,
    step.cacheReadTokens,
  )
  const thinkingTokens = firstNonNegInt(
    usage?.thinking_tokens,
    usage?.thinkingTokens,
    usage?.thoughts_tokens,
    usage?.thoughtsTokens,
    usage?.thoughts_token_count,
    usage?.thoughtsTokenCount,
    step.thinking_tokens,
    step.thinkingTokens,
    step.thoughts_tokens,
    step.thoughtsTokens,
  )

  let toolCalls = 0
  const stepType = asStr(step.type).toUpperCase()
  if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
    toolCalls = step.tool_calls.length
  } else if (stepType === 'TOOL_CALL' || stepType === 'TOOL_USE') {
    toolCalls = 1
  }

  return { ts, inputTokens, outputTokens, cacheReadTokens, thinkingTokens, toolCalls }
}

function applyTelemetryLine(
  cursor: TelemetryCursor,
  line: string,
  turnWindowStartMs?: number,
): 'ok' | 'restart' | 'malformed' {
  const trimmed = line.trim()
  if (!trimmed) return 'ok'
  try {
    const obj = recordOf(JSON.parse(trimmed))
    if (!obj) return 'malformed'
    const sawRestart = applyTranscriptStepToBgTasks(cursor.bgTaskState, obj)
    const delta = extractStepTelemetry(obj)
    if (delta.ts !== undefined) {
      if (cursor.firstStepAt === undefined || delta.ts < cursor.firstStepAt) cursor.firstStepAt = delta.ts
      if (cursor.lastActiveAt === undefined || delta.ts > cursor.lastActiveAt) cursor.lastActiveAt = delta.ts
    }
    cursor.inputTokens += delta.inputTokens
    cursor.outputTokens += delta.outputTokens
    cursor.cacheReadTokens += delta.cacheReadTokens
    cursor.thinkingTokens += delta.thinkingTokens
    cursor.toolCalls += delta.toolCalls
    if (turnWindowStartMs === undefined || (delta.ts !== undefined && delta.ts >= turnWindowStartMs)) {
      cursor.windowInputTokens = (cursor.windowInputTokens ?? 0) + delta.inputTokens
      cursor.windowOutputTokens = (cursor.windowOutputTokens ?? 0) + delta.outputTokens
      cursor.windowCacheReadTokens = (cursor.windowCacheReadTokens ?? 0) + delta.cacheReadTokens
      cursor.windowThinkingTokens = (cursor.windowThinkingTokens ?? 0) + delta.thinkingTokens
    }
    return sawRestart ? 'restart' : 'ok'
  } catch {
    return 'malformed'
  }
}

export class IncrementalTranscriptTelemetryCache {
  private readonly cursors = new Map<string, TelemetryCursor>()
  private readonly maxChunkBytes: number
  private readonly maxDrainBytes: number
  private readonly turnWindowStartMs?: number

  constructor(maxChunkBytes = MAX_TELEMETRY_DELTA_BYTES, maxDrainBytes = MAX_TELEMETRY_DRAIN_BYTES, turnWindowStartMs?: number) {
    this.maxChunkBytes = Math.max(4096, maxChunkBytes)
    this.maxDrainBytes = Math.max(this.maxChunkBytes, maxDrainBytes)
    this.turnWindowStartMs = turnWindowStartMs
  }

  hasAnyBacklog(): boolean {
    for (const c of this.cursors.values()) {
      if (c.hasBacklog) return true
    }
    return false
  }

  private createCursor(st: Stats): TelemetryCursor {
    return {
      dev: st.dev, ino: st.ino, byteOffset: 0, lastSeenSize: st.size, mutationEpoch: 0,
      remainder: '', decoder: new StringDecoder('utf8'), droppedOversizedLine: false, hadMalformedLine: false,
      bgEpochIncomplete: false, bgResetByteOffset: 0, bgReverifiedAtOffset: -1, bgTaskState: createBackgroundTaskState(),
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, thinkingTokens: 0, toolCalls: 0,
      windowInputTokens: 0, windowOutputTokens: 0, windowCacheReadTokens: 0, windowThinkingTokens: 0,
      hasBacklog: st.size > 0, partial: st.size > 0,
    }
  }

  private snapshotOf(c: TelemetryCursor): MemberTelemetrySnapshot {
    const bgIncomplete = Boolean(c.hasBacklog || c.remainder.trim().length > 0 || c.bgEpochIncomplete || c.bgTaskState.overflowed)
    return {
      firstStepAt: c.firstStepAt, lastActiveAt: c.lastActiveAt,
      inputTokens: c.inputTokens, outputTokens: c.outputTokens,
      cacheReadTokens: c.cacheReadTokens, thinkingTokens: c.thinkingTokens, toolCalls: c.toolCalls,
      windowInputTokens: c.windowInputTokens ?? 0, windowOutputTokens: c.windowOutputTokens ?? 0,
      windowCacheReadTokens: c.windowCacheReadTokens ?? 0, windowThinkingTokens: c.windowThinkingTokens ?? 0,
      hasBacklog: c.hasBacklog, partial: c.partial, bgTasks: summarizeBackgroundTaskState(c.bgTaskState, bgIncomplete),
    }
  }

  private computePartial(c: TelemetryCursor): boolean {
    return Boolean(c.hasBacklog || c.droppedOversizedLine || c.hadMalformedLine || c.remainder.trim().length > 0)
  }

  private applyLineWithEpoch(cursor: TelemetryCursor, line: string, lineOriginOffset: number): boolean {
    const outcome = applyTelemetryLine(cursor, line, this.turnWindowStartMs)
    if (outcome === 'malformed') { cursor.hadMalformedLine = true; cursor.bgEpochIncomplete = true; return false }
    if (outcome === 'restart') { cursor.bgEpochIncomplete = false; cursor.bgResetByteOffset = lineOriginOffset; cursor.bgReverifiedAtOffset = -1 }
    return true
  }

  private needsOverflowReverify(c: TelemetryCursor): boolean {
    return !c.hasBacklog && c.bgTaskState.overflowed && c.bgTaskState.active.size === 0 && !c.bgEpochIncomplete && c.remainder.trim().length === 0 && c.bgReverifiedAtOffset !== c.byteOffset
  }

  private reverifyOverflowSync(fd: number, c: TelemetryCursor): void {
    if (!this.needsOverflowReverify(c)) return
    c.bgReverifiedAtOffset = c.byteOffset
    const span = c.byteOffset - c.bgResetByteOffset
    if (span <= 0 || span > this.maxDrainBytes) return
    const slice = readSyncSliceWithBoundary(fd, c.bgResetByteOffset, span)
    reconcileOverflowBgTasksFromJsonlBuffer(c.bgTaskState, slice.text, { truncatedStart: c.bgResetByteOffset > 0 })
  }

  private async reverifyOverflowAsync(fh: Awaited<ReturnType<typeof openAsync>>, c: TelemetryCursor, isStale: () => boolean): Promise<void> {
    if (!this.needsOverflowReverify(c)) return
    const targetOffset = c.byteOffset
    const resetOffset = c.bgResetByteOffset
    const span = targetOffset - resetOffset
    if (span <= 0 || span > this.maxDrainBytes) { c.bgReverifiedAtOffset = targetOffset; return }
    const slice = await readAsyncSliceWithBoundary(fh, resetOffset, span)
    if (isStale()) return
    c.bgReverifiedAtOffset = targetOffset
    reconcileOverflowBgTasksFromJsonlBuffer(c.bgTaskState, slice.text, { truncatedStart: resetOffset > 0 })
  }

  private consumeTextChunk(cursor: TelemetryCursor, decoded: string, atEof: boolean, chunkStartOffset: number): void {
    const lineOrigin = Math.max(0, chunkStartOffset - Buffer.byteLength(cursor.remainder, 'utf8'))
    const combined = cursor.remainder + decoded
    const lastNewline = combined.lastIndexOf('\n')
    if (lastNewline >= 0) {
      const completePart = combined.slice(0, lastNewline)
      const trailing = combined.slice(lastNewline + 1)
      for (const line of completePart.split('\n')) this.applyLineWithEpoch(cursor, line, lineOrigin)
      if (trailing.length > MAX_TELEMETRY_REMAINDER_BYTES) { cursor.remainder = ''; cursor.droppedOversizedLine = true; cursor.bgEpochIncomplete = true }
      else cursor.remainder = trailing
    } else if (combined.length > MAX_TELEMETRY_REMAINDER_BYTES) {
      cursor.remainder = ''; cursor.droppedOversizedLine = true; cursor.bgEpochIncomplete = true
    } else {
      cursor.remainder = combined
    }
    if (atEof && cursor.remainder.trim().endsWith('}')) {
      const outcome = applyTelemetryLine(cursor, cursor.remainder, this.turnWindowStartMs)
      if (outcome !== 'malformed') {
        if (outcome === 'restart') { cursor.bgEpochIncomplete = false; cursor.bgResetByteOffset = lineOrigin; cursor.bgReverifiedAtOffset = -1 }
        cursor.remainder = ''
      }
    }
  }

  scan(
    brainDir: string,
    memberConvId: string,
    opts?: { drainAll?: boolean; maxBytesBudget?: number },
  ): MemberTelemetrySnapshot | null {
    if (!CONVERSATION_ID_RE.test(memberConvId)) return null
    const resolved = resolveRegularFileWithinRoot(brainDir, [
      memberConvId,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    ])
    if (!resolved) {
      this.cursors.delete(memberConvId)
      return null
    }

    const st = resolved.stat
    let cursor = this.cursors.get(memberConvId)
    if (!cursor || cursor.dev !== st.dev || cursor.ino !== st.ino || st.size < cursor.byteOffset) {
      cursor = this.createCursor(st)
      this.cursors.set(memberConvId, cursor)
    }
    const c = cursor!
    c.lastSeenSize = st.size

    if (st.size === c.byteOffset) {
      c.hasBacklog = false
      c.partial = this.computePartial(c)
      return this.snapshotOf(c)
    }

    let fd: number | null = null
    try {
      const flags =
        fsConstants.O_RDONLY |
        (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0) |
        (typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0)
      fd = openSync(resolved.fullPath, flags)
      const fst = fstatSync(fd)
      if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino) {
        return null
      }
      const realRoot = resolveCachedRealRootSync(brainDir, resolved.rootStat)
      const realFile = realpathSync(resolved.fullPath)
      if (!realFile.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)) {
        return null
      }
      c.lastSeenSize = fst.size

      const budget = opts?.drainAll
        ? Math.max(this.maxChunkBytes, opts.maxBytesBudget ?? this.maxDrainBytes)
        : Math.max(4096, opts?.maxBytesBudget ?? this.maxChunkBytes)
      let bytesBudgetLeft = budget

      while (c.byteOffset < fst.size && bytesBudgetLeft > 0) {
        const toRead = Math.min(fst.size - c.byteOffset, this.maxChunkBytes, bytesBudgetLeft)
        if (toRead <= 0) break
        const buf = Buffer.allocUnsafe(toRead)
        let readTotal = 0
        while (readTotal < toRead) {
          const n = readSync(fd, buf, readTotal, toRead - readTotal, c.byteOffset + readTotal)
          if (n <= 0) break
          readTotal += n
        }
        if (readTotal <= 0) break
        const chunkStartOffset = c.byteOffset
        c.byteOffset += readTotal
        c.mutationEpoch += 1
        bytesBudgetLeft -= readTotal
        const atEof = c.byteOffset >= fst.size
        const decoded = c.decoder.write(buf.subarray(0, readTotal))
        this.consumeTextChunk(c, decoded, atEof, chunkStartOffset)
      }

      if (opts?.drainAll && c.byteOffset >= fst.size) {
        const flushed = c.decoder.end()
        if (flushed) {
          c.mutationEpoch += 1
          this.consumeTextChunk(c, flushed, true, c.byteOffset)
        }
        // Re-initialize fresh decoder in case more bytes are appended later.
        c.decoder = new StringDecoder('utf8')
      }

      c.hasBacklog = c.byteOffset < fst.size
      this.reverifyOverflowSync(fd, c)
      c.partial = this.computePartial(c)
    } catch {
      return null
    } finally {
      if (fd !== null) {
        try { closeSync(fd) } catch { /* ignore */ }
      }
    }

    return this.snapshotOf(c)
  }

  /** Read a member's latest cached snapshot without performing disk I/O. */
  peek(memberConvId: string): MemberTelemetrySnapshot | null {
    const c = this.cursors.get(memberConvId)
    return c ? this.snapshotOf(c) : null
  }

  async scanAsync(
    brainDir: string,
    memberConvId: string,
    opts?: { drainAll?: boolean; maxBytesBudget?: number },
  ): Promise<MemberTelemetrySnapshot | null> {
    if (!CONVERSATION_ID_RE.test(memberConvId)) return null
    // Capture cursor & mutationEpoch BEFORE the first await (`lstatAsync`) so a
    // concurrent sync `scan()` advancing the cursor while `lstatAsync` is in flight
    // can NEVER make the stale `st.size < cursor.byteOffset` look like a truncation/reset.
    const preCursor = this.cursors.get(memberConvId)
    const preEpoch = preCursor?.mutationEpoch
    const resolved = await resolveRegularFileWithinRootAsync(brainDir, [
      memberConvId,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    ])
    const postLstatCursor = this.cursors.get(memberConvId)
    if (
      (preCursor && (postLstatCursor !== preCursor || postLstatCursor.mutationEpoch !== preEpoch)) ||
      (!preCursor && postLstatCursor)
    ) {
      return postLstatCursor ? this.snapshotOf(postLstatCursor) : null
    }
    if (!resolved) {
      this.cursors.delete(memberConvId)
      return null
    }

    const st = resolved.stat
    let cursor = postLstatCursor
    if (!cursor || cursor.dev !== st.dev || cursor.ino !== st.ino || st.size < cursor.byteOffset) {
      cursor = this.createCursor(st)
      this.cursors.set(memberConvId, cursor)
    }
    const c = cursor!
    c.lastSeenSize = st.size

    if (st.size === c.byteOffset) {
      c.hasBacklog = false
      c.partial = this.computePartial(c)
      return this.snapshotOf(c)
    }

    const startCursor = c
    let expectedOffset = c.byteOffset
    let expectedEpoch = c.mutationEpoch
    const isStale = (): boolean =>
      this.cursors.get(memberConvId) !== startCursor ||
      startCursor.byteOffset !== expectedOffset ||
      startCursor.mutationEpoch !== expectedEpoch

    let fh: Awaited<ReturnType<typeof openAsync>> | null = null
    try {
      const flags =
        fsConstants.O_RDONLY |
        (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0) |
        (typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0)
      fh = await openAsync(resolved.fullPath, flags)
      if (isStale()) return this.snapshotOf(this.cursors.get(memberConvId) ?? startCursor)
      const fst = await fh.stat()
      if (isStale()) return this.snapshotOf(this.cursors.get(memberConvId) ?? startCursor)
      if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino) {
        return null
      }
      const [realRoot, realFile] = await Promise.all([
        resolveCachedRealRootAsync(brainDir, resolved.rootStat),
        realpathAsync(resolved.fullPath),
      ])
      if (isStale()) return this.snapshotOf(this.cursors.get(memberConvId) ?? startCursor)
      if (!realFile.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)) {
        return null
      }
      c.lastSeenSize = fst.size

      const budget = opts?.drainAll
        ? Math.max(this.maxChunkBytes, opts.maxBytesBudget ?? this.maxDrainBytes)
        : Math.max(4096, opts?.maxBytesBudget ?? this.maxChunkBytes)
      let bytesBudgetLeft = budget

      while (c.byteOffset < fst.size && bytesBudgetLeft > 0) {
        const toRead = Math.min(fst.size - c.byteOffset, this.maxChunkBytes, bytesBudgetLeft)
        if (toRead <= 0) break
        const buf = Buffer.allocUnsafe(toRead)
        let readTotal = 0
        const chunkStartOffset = c.byteOffset
        while (readTotal < toRead) {
          const { bytesRead } = await fh.read(buf, readTotal, toRead - readTotal, chunkStartOffset + readTotal)
          // Fence against concurrent sync `scan()` advancing the shared cursor while `fh.read` awaited.
          if (isStale()) return this.snapshotOf(this.cursors.get(memberConvId) ?? startCursor)
          if (bytesRead <= 0) break
          readTotal += bytesRead
        }
        if (readTotal <= 0) break
        c.byteOffset += readTotal
        c.mutationEpoch += 1
        expectedOffset = c.byteOffset
        expectedEpoch = c.mutationEpoch
        bytesBudgetLeft -= readTotal
        const atEof = c.byteOffset >= fst.size
        const decoded = c.decoder.write(buf.subarray(0, readTotal))
        this.consumeTextChunk(c, decoded, atEof, chunkStartOffset)
      }

      if (opts?.drainAll && c.byteOffset >= fst.size) {
        const flushed = c.decoder.end()
        if (flushed) {
          c.mutationEpoch += 1
          this.consumeTextChunk(c, flushed, true, c.byteOffset)
        }
        c.decoder = new StringDecoder('utf8')
      }

      c.hasBacklog = c.byteOffset < fst.size
      await this.reverifyOverflowAsync(fh, c, isStale)
      c.partial = this.computePartial(c)
    } catch {
      return null
    } finally {
      if (fh !== null) {
        try { await fh.close() } catch { /* ignore */ }
      }
    }

    return this.snapshotOf(this.cursors.get(memberConvId) ?? c)
  }

  prune(activeMemberConvIds: ReadonlySet<string>): void {
    for (const key of this.cursors.keys()) {
      if (!activeMemberConvIds.has(key)) this.cursors.delete(key)
    }
  }
}
