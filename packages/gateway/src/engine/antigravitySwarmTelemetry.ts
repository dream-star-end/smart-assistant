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

/** Max bytes parsed per member per tick by the incremental telemetry scanner so large bursts never block the event loop. */
export const MAX_TELEMETRY_DELTA_BYTES = 128 * 1024
/** Max total bytes drained per member during terminal `stopAndReadFinal` before marking `telemetryPartial: true`. */
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
  /** Tokens observed on steps within the active turn window (`ts >= turnWindowStartMs`). */
  windowInputTokens?: number
  windowOutputTokens?: number
  windowCacheReadTokens?: number
  windowThinkingTokens?: number
  /** True when unread bytes remain (`byteOffset < fileSize`) or an oversized line/budget cap prevented complete counting. */
  partial?: boolean
  hasBacklog?: boolean
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
  /** If a tail slice starts mid-file and contains no `\n` (single line > `maxBytes`),
   *  widen once up to this byte ceiling, then fall back to scanning backward for the
   *  previous complete line so oversized steps never zero out `stepCount` or mask `ERROR`. */
  maxAdaptiveBytes?: number
}

function readSyncSliceUtf8(fd: number, startOffset: number, size: number): string {
  const buf = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const n = readSync(fd, buf, offset, size - offset, startOffset + offset)
    if (n <= 0) break
    offset += n
  }
  return buf.subarray(0, offset).toString('utf8')
}

async function readAsyncSliceUtf8(
  fh: Awaited<ReturnType<typeof openAsync>>,
  startOffset: number,
  size: number,
): Promise<string> {
  const buf = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const { bytesRead } = await fh.read(buf, offset, size - offset, startOffset + offset)
    if (bytesRead <= 0) break
    offset += bytesRead
  }
  return buf.subarray(0, offset).toString('utf8')
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
    if (!st.isFile() || st.dev !== resolved.stat.dev || st.ino !== resolved.stat.ino || st.size <= 0) {
      return null
    }
    // Defense-in-depth containment verification against cached realpath of trusted rootDir.
    const realRoot = resolveCachedRealRootSync(rootDir, resolved.rootStat)
    const realFile = realpathSync(resolved.fullPath)
    if (!realFile.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)) {
      return null
    }
    const size = Math.min(st.size, maxBytes)
    const startOffset = st.size > maxBytes ? st.size - maxBytes : 0
    const text = readSyncSliceUtf8(fd, startOffset, size)
    if (startOffset > 0) {
      const firstNewline = text.indexOf('\n')
      if (firstNewline >= 0) {
        const sliced = text.slice(firstNewline + 1)
        if (sliced.trim().length > 0) return sliced
      }
      const adaptiveCap = opts?.maxAdaptiveBytes ? Math.max(maxBytes, opts.maxAdaptiveBytes) : maxBytes
      if (adaptiveCap > maxBytes) {
        const widerSize = Math.min(st.size, adaptiveCap)
        const widerStart = st.size > adaptiveCap ? st.size - adaptiveCap : 0
        const widerText = readSyncSliceUtf8(fd, widerStart, widerSize)
        if (widerStart === 0) return widerText
        const widerFirstNl = widerText.indexOf('\n')
        if (widerFirstNl >= 0) {
          const widerSliced = widerText.slice(widerFirstNl + 1)
          if (widerSliced.trim().length > 0) return widerSliced
        }
        // Final line alone exceeds `adaptiveCap`: scan up to 256 KB immediately before `widerStart`
        // to recover the preceding complete JSONL lines rather than returning empty string (N1).
        if (widerStart > 0) {
          const lookbackSize = Math.min(widerStart, 256 * 1024)
          const lookbackStart = widerStart - lookbackSize
          const prevText = readSyncSliceUtf8(fd, lookbackStart, lookbackSize)
          const lastNl = prevText.lastIndexOf('\n')
          if (lastNl >= 0) {
            const bounded = prevText.slice(0, lastNl + 1)
            if (lookbackStart === 0) return bounded
            const firstNl = bounded.indexOf('\n')
            return firstNl >= 0 ? bounded.slice(firstNl + 1) : ''
          }
        }
      }
      return ''
    }
    return text
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
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
    if (!st.isFile() || st.dev !== resolved.stat.dev || st.ino !== resolved.stat.ino || st.size <= 0) {
      return null
    }
    const [realRoot, realFile] = await Promise.all([
      resolveCachedRealRootAsync(rootDir, resolved.rootStat),
      realpathAsync(resolved.fullPath),
    ])
    if (!realFile.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)) {
      return null
    }
    const size = Math.min(st.size, maxBytes)
    const startOffset = st.size > maxBytes ? st.size - maxBytes : 0
    const text = await readAsyncSliceUtf8(fh, startOffset, size)
    if (startOffset > 0) {
      const firstNewline = text.indexOf('\n')
      if (firstNewline >= 0) {
        const sliced = text.slice(firstNewline + 1)
        if (sliced.trim().length > 0) return sliced
      }
      const adaptiveCap = opts?.maxAdaptiveBytes ? Math.max(maxBytes, opts.maxAdaptiveBytes) : maxBytes
      if (adaptiveCap > maxBytes) {
        const widerSize = Math.min(st.size, adaptiveCap)
        const widerStart = st.size > adaptiveCap ? st.size - adaptiveCap : 0
        const widerText = await readAsyncSliceUtf8(fh, widerStart, widerSize)
        if (widerStart === 0) return widerText
        const widerFirstNl = widerText.indexOf('\n')
        if (widerFirstNl >= 0) {
          const widerSliced = widerText.slice(widerFirstNl + 1)
          if (widerSliced.trim().length > 0) return widerSliced
        }
        if (widerStart > 0) {
          const lookbackSize = Math.min(widerStart, 256 * 1024)
          const lookbackStart = widerStart - lookbackSize
          const prevText = await readAsyncSliceUtf8(fh, lookbackStart, lookbackSize)
          const lastNl = prevText.lastIndexOf('\n')
          if (lastNl >= 0) {
            const bounded = prevText.slice(0, lastNl + 1)
            if (lookbackStart === 0) return bounded
            const firstNl = bounded.indexOf('\n')
            return firstNl >= 0 ? bounded.slice(firstNl + 1) : ''
          }
        }
      }
      return ''
    }
    return text
  } catch {
    return null
  } finally {
    if (fh !== null) {
      try { await fh.close() } catch { /* ignore */ }
    }
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
  cursor: MemberTelemetrySnapshot,
  line: string,
  turnWindowStartMs?: number,
): boolean {
  const trimmed = line.trim()
  if (!trimmed) return true
  try {
    const obj = recordOf(JSON.parse(trimmed))
    if (!obj) return false
    const delta = extractStepTelemetry(obj)
    if (delta.ts !== undefined) {
      if (cursor.firstStepAt === undefined || delta.ts < cursor.firstStepAt) {
        cursor.firstStepAt = delta.ts
      }
      if (cursor.lastActiveAt === undefined || delta.ts > cursor.lastActiveAt) {
        cursor.lastActiveAt = delta.ts
      }
    }
    cursor.inputTokens += delta.inputTokens
    cursor.outputTokens += delta.outputTokens
    cursor.cacheReadTokens += delta.cacheReadTokens
    cursor.thinkingTokens += delta.thinkingTokens
    cursor.toolCalls += delta.toolCalls
    if (
      turnWindowStartMs === undefined ||
      (delta.ts !== undefined && delta.ts >= turnWindowStartMs)
    ) {
      cursor.windowInputTokens = (cursor.windowInputTokens ?? 0) + delta.inputTokens
      cursor.windowOutputTokens = (cursor.windowOutputTokens ?? 0) + delta.outputTokens
      cursor.windowCacheReadTokens = (cursor.windowCacheReadTokens ?? 0) + delta.cacheReadTokens
      cursor.windowThinkingTokens = (cursor.windowThinkingTokens ?? 0) + delta.thinkingTokens
    }
    return true
  } catch {
    return false
  }
}

/**
 * Incremental byte-offset telemetry scanner for member `transcript.jsonl` files (B7).
 *
 * - Uses per-member `StringDecoder('utf8')` so multi-byte UTF-8 characters split across
 *   chunk boundaries never corrupt into U+FFFD replacement characters.
 * - Tracks `hasBacklog` (`byteOffset < fileSize`) and `partial` (unread backlog or oversized
 *   line drop), so callers continue draining quiet large logs across ticks and NEVER emit a
 *   partial count disguised as an exact terminal total.
 */
export class IncrementalTranscriptTelemetryCache {
  private readonly cursors = new Map<string, TelemetryCursor>()
  private readonly maxChunkBytes: number
  private readonly maxDrainBytes: number
  private readonly turnWindowStartMs?: number

  constructor(
    maxChunkBytes = MAX_TELEMETRY_DELTA_BYTES,
    maxDrainBytes = MAX_TELEMETRY_DRAIN_BYTES,
    turnWindowStartMs?: number,
  ) {
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
      dev: st.dev,
      ino: st.ino,
      byteOffset: 0,
      lastSeenSize: st.size,
      mutationEpoch: 0,
      remainder: '',
      decoder: new StringDecoder('utf8'),
      droppedOversizedLine: false,
      hadMalformedLine: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
      toolCalls: 0,
      windowInputTokens: 0,
      windowOutputTokens: 0,
      windowCacheReadTokens: 0,
      windowThinkingTokens: 0,
      hasBacklog: st.size > 0,
      partial: st.size > 0,
    }
  }

  private snapshotOf(c: TelemetryCursor): MemberTelemetrySnapshot {
    return {
      firstStepAt: c.firstStepAt,
      lastActiveAt: c.lastActiveAt,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      cacheReadTokens: c.cacheReadTokens,
      thinkingTokens: c.thinkingTokens,
      toolCalls: c.toolCalls,
      windowInputTokens: c.windowInputTokens ?? 0,
      windowOutputTokens: c.windowOutputTokens ?? 0,
      windowCacheReadTokens: c.windowCacheReadTokens ?? 0,
      windowThinkingTokens: c.windowThinkingTokens ?? 0,
      hasBacklog: c.hasBacklog,
      partial: c.partial,
    }
  }

  private computePartial(c: TelemetryCursor): boolean {
    // B7: 区分“读到物理 EOF”与“最后一条记录完整”——只要仍有未闭合/不可解析尾行或损坏行，
    // 必须诚实标记 partial=true，绝不将已解析小计伪装为完整总计。
    return Boolean(
      c.hasBacklog ||
        c.droppedOversizedLine ||
        c.hadMalformedLine ||
        c.remainder.trim().length > 0,
    )
  }

  private consumeTextChunk(cursor: TelemetryCursor, decoded: string, atEof: boolean): void {
    const combined = cursor.remainder + decoded
    const lastNewline = combined.lastIndexOf('\n')
    if (lastNewline >= 0) {
      const completePart = combined.slice(0, lastNewline)
      const trailing = combined.slice(lastNewline + 1)
      for (const line of completePart.split('\n')) {
        if (!applyTelemetryLine(cursor, line, this.turnWindowStartMs)) {
          cursor.hadMalformedLine = true
        }
      }
      if (trailing.length > MAX_TELEMETRY_REMAINDER_BYTES) {
        cursor.remainder = ''
        cursor.droppedOversizedLine = true
      } else {
        cursor.remainder = trailing
      }
    } else if (combined.length > MAX_TELEMETRY_REMAINDER_BYTES) {
      cursor.remainder = ''
      cursor.droppedOversizedLine = true
    } else {
      cursor.remainder = combined
    }

    // Only attempt to parse a trailing line without newline when we have reached EOF
    // and the trailing text is a complete JSON object (avoiding premature truncation mid-chunk).
    if (atEof && cursor.remainder.trim().endsWith('}')) {
      if (applyTelemetryLine(cursor, cursor.remainder, this.turnWindowStartMs)) {
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
    const rotated =
      !cursor ||
      cursor.dev !== st.dev ||
      cursor.ino !== st.ino ||
      st.size < cursor.byteOffset
    if (rotated) {
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
        c.byteOffset += readTotal
        c.mutationEpoch += 1
        bytesBudgetLeft -= readTotal
        const atEof = c.byteOffset >= fst.size
        const decoded = c.decoder.write(buf.subarray(0, readTotal))
        this.consumeTextChunk(c, decoded, atEof)
      }

      if (opts?.drainAll && c.byteOffset >= fst.size) {
        const flushed = c.decoder.end()
        if (flushed) {
          c.mutationEpoch += 1
          this.consumeTextChunk(c, flushed, true)
        }
        // Re-initialize fresh decoder in case more bytes are appended later.
        c.decoder = new StringDecoder('utf8')
      }

      c.hasBacklog = c.byteOffset < fst.size
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
    const rotated =
      !cursor ||
      cursor.dev !== st.dev ||
      cursor.ino !== st.ino ||
      st.size < cursor.byteOffset
    if (rotated) {
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
        this.consumeTextChunk(c, decoded, atEof)
      }

      if (opts?.drainAll && c.byteOffset >= fst.size) {
        const flushed = c.decoder.end()
        if (flushed) {
          c.mutationEpoch += 1
          this.consumeTextChunk(c, flushed, true)
        }
        c.decoder = new StringDecoder('utf8')
      }

      c.hasBacklog = c.byteOffset < fst.size
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
