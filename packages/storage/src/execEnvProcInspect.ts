/**
 * OCV5-890 / OCV5-908 Layer 3 — Pure UTF-8 boundary helpers, bounded head+tail stream buffer,
 * and Linux `/proc` process-group identity verification (zero sync I/O, zero empty catches).
 */
import type { ChildProcess } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import {
  isParsedProcAlive,
  parseProcStatFull,
  parseProcStatStartTimeTicks,
  verifyProcGroupByStartTicks,
  type ParsedProcStat,
} from '@openclaude/protocol'

export { isParsedProcAlive, parseProcStatFull, parseProcStatStartTimeTicks, verifyProcGroupByStartTicks }
export type { ParsedProcStat }

export const EXEC_ENV_JOB_MAX_OUTPUT_BYTES = 200 * 1024
export const EXEC_ENV_JOB_HEAD_BYTES = 64 * 1024
export const EXEC_ENV_JOB_TAIL_BYTES = EXEC_ENV_JOB_MAX_OUTPUT_BYTES - EXEC_ENV_JOB_HEAD_BYTES
export const EXEC_ENV_JOB_DEFAULT_KILL_GRACE_MS = 400
export const EXEC_ENV_JOB_DEFAULT_CLOSE_DRAIN_MS = 2_000
export const EXEC_ENV_JOB_DEFAULT_MAX_LIFETIME_MS = 2 * 60 * 60_000
export const EXEC_ENV_JOB_DEFAULT_TOMBSTONE_MAX = 256

export type ExecEnvJobErrorCode =
  | 'EXEC_JOB_COMMAND_EMPTY'
  | 'EXEC_JOB_REGISTRY_DISPOSED'
  | 'EXEC_JOB_NOT_FOUND'
  | 'EXEC_JOB_LEASE_MISMATCH'
  | 'EXEC_JOB_DUPLICATE_ID'
  | 'EXEC_JOB_SURVIVABLE_STDIO_UNAVAILABLE'

export class ExecEnvJobError extends Error {
  readonly code: ExecEnvJobErrorCode
  constructor(code: ExecEnvJobErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'ExecEnvJobError'
    this.code = code
  }
}

export type ExecEnvJobTerminationCause =
  | 'exited'
  | 'killed'
  | 'yield_timeout'
  | 'max_lifetime'
  | 'spawn_error'

export function trailingIncompleteUtf8Count(buf: Uint8Array): number {
  const len = buf.length
  if (len === 0) return 0
  let pos = len - 1
  const minPos = Math.max(0, len - 3)
  while (pos > minPos && (buf[pos]! & 0xc0) === 0x80) pos -= 1
  const lead = buf[pos]!
  if ((lead & 0x80) === 0 || (lead & 0xc0) === 0x80) return 0
  let expectedLen = 0
  if ((lead & 0xe0) === 0xc0) expectedLen = 2
  else if ((lead & 0xf0) === 0xe0) expectedLen = 3
  else if ((lead & 0xf8) === 0xf0) expectedLen = 4
  else return 0
  const actualLen = len - pos
  return actualLen < expectedLen ? actualLen : 0
}

export function leadingContinuationUtf8Count(buf: Uint8Array): number {
  let i = 0
  const limit = Math.min(3, buf.length)
  while (i < limit && (buf[i]! & 0xc0) === 0x80) i += 1
  return i
}

export function clipUtf8Tail(text: string, maxBytes: number): { text: string; byteLength: number } {
  if (maxBytes <= 0) return { text: '', byteLength: 0 }
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return { text, byteLength: buf.length }
  let tail = buf.subarray(buf.length - maxBytes)
  const leadSkip = leadingContinuationUtf8Count(tail)
  if (leadSkip > 0) tail = tail.subarray(leadSkip)
  const out = tail.toString('utf8')
  return { text: out, byteLength: Buffer.byteLength(out, 'utf8') }
}

export async function readProcStatFullAsync(pid: number): Promise<ParsedProcStat | null> {
  if (!Number.isInteger(pid) || pid <= 1 || process.platform !== 'linux') return null
  try {
    return parseProcStatFull(await readFile(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return null
  }
}

export async function readProcStartTimeTicksAsync(pid: number): Promise<number | null> {
  return (await readProcStatFullAsync(pid))?.startTimeTicks ?? null
}

async function listLinuxProcPidsAsync(): Promise<number[]> {
  try {
    const entries = await readdir('/proc')
    const pids: number[] = []
    for (const name of entries) {
      if (!/^[1-9][0-9]*$/.test(name)) continue
      const pid = Number(name)
      if (Number.isSafeInteger(pid) && pid > 1) pids.push(pid)
    }
    return pids
  } catch {
    return []
  }
}

export interface VerifyProcessGroupOps {
  platform?: NodeJS.Platform
  readProcStat?: (pid: number) => ParsedProcStat | null
  listProcPids?: () => number[]
  probeGroup?: (pgid: number) => boolean
}

function probeGroupAlive(pgid: number, customProbe?: (p: number) => boolean): boolean {
  if (customProbe) return customProbe(pgid)
  try {
    process.kill(-pgid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH'
  }
}

let defaultSyncProcOps: VerifyProcessGroupOps | null = null

/**
 * Registers the host's authoritative synchronous Linux `/proc` reader for `hasAliveVerifiedProcessGroup`
 * and `sendVerifiedGroupSignal`. Without a bound reader, Linux synchronous checks fail closed (`false`).
 */
export function registerDefaultSyncProcOps(ops: VerifyProcessGroupOps): void {
  defaultSyncProcOps = ops
}

export function getDefaultSyncProcOps(): VerifyProcessGroupOps | null {
  return defaultSyncProcOps
}

/**
 * Synchronous verified process-group liveness check (W04).
 * Fails closed on Linux when `minStartTicks === null`, when no `/proc` reader is available,
 * or when live leader identity mismatches.
 */
export function hasAliveVerifiedProcessGroup(
  pgid: number,
  minStartTicks: number | null,
  ops: VerifyProcessGroupOps = {},
): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false
  const platform = ops.platform ?? process.platform
  const useProc = platform === 'linux' || Boolean(ops.readProcStat || ops.listProcPids)
  if (!useProc) return probeGroupAlive(pgid, ops.probeGroup)
  if (minStartTicks === null) return false
  const readStat = ops.readProcStat ?? defaultSyncProcOps?.readProcStat
  if (!readStat) return false
  if ((!ops.readProcStat || ops.probeGroup) && !probeGroupAlive(pgid, ops.probeGroup)) {
    return false
  }
  const listPids = ops.listProcPids ?? defaultSyncProcOps?.listProcPids ?? (() => [pgid])
  return verifyProcGroupByStartTicks(pgid, minStartTicks, {
    readProcStat: readStat,
    listProcPids: listPids,
  })
}

export async function hasAliveVerifiedProcessGroupAsync(
  pgid: number,
  minStartTicks: number | null,
): Promise<boolean> {
  if (!Number.isInteger(pgid) || pgid <= 1) return false
  if (process.platform !== 'linux') return probeGroupAlive(pgid)
  if (minStartTicks === null || !probeGroupAlive(pgid)) return false
  const leaderStat = await readProcStatFullAsync(pgid)
  if (isParsedProcAlive(leaderStat)) {
    return leaderStat.pgrp === pgid && leaderStat.startTimeTicks === minStartTicks
  }
  const pids = await listLinuxProcPidsAsync()
  for (const pid of pids) {
    if (pid === pgid) continue
    const stat = await readProcStatFullAsync(pid)
    if (isParsedProcAlive(stat) && stat.pgrp === pgid && stat.startTimeTicks >= minStartTicks) {
      return true
    }
  }
  return false
}

export function sendVerifiedGroupSignal(
  pgid: number | undefined,
  child: ChildProcess | null,
  startTimeTicks: number | null,
  signal: NodeJS.Signals,
  ops: VerifyProcessGroupOps = {},
): boolean {
  if (pgid && pgid > 1) {
    if (!hasAliveVerifiedProcessGroup(pgid, startTimeTicks, ops)) return false
    try {
      process.kill(-pgid, signal)
      return true
    } catch (err) {
      void err
    }
  }
  if (!child) return false
  const isLinux = (ops.platform ?? process.platform) === 'linux'
  if (child.pid && child.pid > 1 && isLinux && !hasAliveVerifiedProcessGroup(child.pid, startTimeTicks, ops)) {
    return false
  }
  try {
    return child.kill(signal)
  } catch {
    return false
  }
}

export async function sendVerifiedGroupSignalAsync(
  pgid: number | undefined,
  child: ChildProcess | null,
  startTimeTicks: number | null,
  signal: NodeJS.Signals,
): Promise<boolean> {
  if (pgid && pgid > 1) {
    if (!(await hasAliveVerifiedProcessGroupAsync(pgid, startTimeTicks))) return false
    try {
      process.kill(-pgid, signal)
      return true
    } catch (err) {
      void err
    }
  }
  if (!child) return false
  if (child.pid && child.pid > 1 && process.platform === 'linux') {
    if (!(await hasAliveVerifiedProcessGroupAsync(child.pid, startTimeTicks))) return false
  }
  try {
    return child.kill(signal)
  } catch {
    return false
  }
}

export interface BoundedDeltaStreamBufferOptions {
  maxBytes?: number
  headBytes?: number
}

export interface BoundedDeltaReadResult {
  text: string
  nextCursor: number
  truncated: boolean
  omittedBytes: number
  totalBytes: number
}

function sliceUtf8Safe(buf: Buffer, isFinal: boolean): { text: string; heldBack: number } {
  const heldBack = isFinal ? 0 : trailingIncompleteUtf8Count(buf)
  const clean = heldBack > 0 ? buf.subarray(0, buf.length - heldBack) : buf
  return { text: clean.toString('utf8'), heldBack }
}

/**
 * Bounded head + rolling-tail stream buffer (default 200 KiB = 64 KiB head + 136 KiB tail)
 * supporting incremental byte-cursor reads via `readFrom(cursor)`.
 */
export class BoundedDeltaStreamBuffer {
  readonly maxBytes: number
  readonly headCap: number
  readonly tailCap: number

  private totalBytes = 0
  private truncated = false
  private inlineBuf: Buffer = Buffer.alloc(0)
  private headBuf: Buffer = Buffer.alloc(0)
  private tailBuf: Buffer = Buffer.alloc(0)

  constructor(opts: BoundedDeltaStreamBufferOptions = {}) {
    const maxBytes = Math.max(0, Math.floor(opts.maxBytes ?? EXEC_ENV_JOB_MAX_OUTPUT_BYTES))
    const defaultHead =
      opts.maxBytes === undefined
        ? EXEC_ENV_JOB_HEAD_BYTES
        : Math.floor(maxBytes * (EXEC_ENV_JOB_HEAD_BYTES / EXEC_ENV_JOB_MAX_OUTPUT_BYTES))
    const headCap = Math.max(0, Math.min(maxBytes, Math.floor(opts.headBytes ?? defaultHead)))
    this.maxBytes = maxBytes
    this.headCap = headCap
    this.tailCap = Math.max(0, maxBytes - headCap)
  }

  get byteLength(): number {
    return this.totalBytes
  }

  get isTruncated(): boolean {
    return this.truncated
  }

  push(chunk: Uint8Array | string): void {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    if (data.length === 0) return
    this.totalBytes += data.length
    if (this.maxBytes === 0) {
      this.truncated = true
      return
    }
    if (!this.truncated) {
      this.pushInline(data)
      return
    }
    this.pushTail(data)
  }

  private pushInline(data: Buffer): void {
    const combined = this.inlineBuf.length === 0 ? data : Buffer.concat([this.inlineBuf, data])
    if (combined.length <= this.maxBytes) {
      this.inlineBuf = combined
      return
    }
    this.inlineBuf = Buffer.alloc(0)
    this.truncated = true
    this.headBuf = Buffer.from(combined.subarray(0, this.headCap))
    this.tailBuf =
      this.tailCap > 0
        ? Buffer.from(combined.subarray(Math.max(this.headCap, combined.length - this.tailCap)))
        : Buffer.alloc(0)
  }

  private pushTail(data: Buffer): void {
    if (this.tailCap === 0) return
    if (data.length >= this.tailCap) {
      this.tailBuf = Buffer.from(data.subarray(data.length - this.tailCap))
    } else if (this.tailBuf.length + data.length <= this.tailCap) {
      this.tailBuf = Buffer.concat([this.tailBuf, data])
    } else {
      const keepFromOld = this.tailCap - data.length
      this.tailBuf = Buffer.concat([this.tailBuf.subarray(this.tailBuf.length - keepFromOld), data])
    }
  }

  readFrom(cursor = 0, isFinal = false): BoundedDeltaReadResult {
    const safeCursor = Math.max(0, Math.min(Math.floor(cursor), this.totalBytes))
    if (safeCursor >= this.totalBytes) {
      return { text: '', nextCursor: this.totalBytes, truncated: false, omittedBytes: 0, totalBytes: this.totalBytes }
    }
    if (!this.truncated) {
      const { text, heldBack } = sliceUtf8Safe(this.inlineBuf.subarray(safeCursor), isFinal)
      return { text, nextCursor: this.totalBytes - heldBack, truncated: false, omittedBytes: 0, totalBytes: this.totalBytes }
    }
    const tailStartOffset = this.totalBytes - this.tailBuf.length
    if (safeCursor >= tailStartOffset) {
      const relStart = safeCursor - tailStartOffset
      let slice = this.tailBuf.subarray(relStart)
      if (relStart === 0) {
        const leadSkip = leadingContinuationUtf8Count(slice)
        if (leadSkip > 0) slice = slice.subarray(leadSkip)
      }
      const { text, heldBack } = sliceUtf8Safe(slice, isFinal)
      return { text, nextCursor: this.totalBytes - heldBack, truncated: false, omittedBytes: 0, totalBytes: this.totalBytes }
    }
    return this.readTruncatedWindow(safeCursor, isFinal)
  }

  private readTruncatedWindow(safeCursor: number, isFinal: boolean): BoundedDeltaReadResult {
    const tailLeadSkip = leadingContinuationUtf8Count(this.tailBuf)
    const tailClean = tailLeadSkip > 0 ? this.tailBuf.subarray(tailLeadSkip) : this.tailBuf
    const { text: tailText, heldBack } = sliceUtf8Safe(tailClean, isFinal)
    let headText = ''
    let headDeliveredEnd = safeCursor
    if (safeCursor < this.headBuf.length) {
      let headSlice = this.headBuf.subarray(safeCursor)
      const headLeadSkip = safeCursor > 0 ? leadingContinuationUtf8Count(headSlice) : 0
      if (headLeadSkip > 0) headSlice = headSlice.subarray(headLeadSkip)
      const headTrailCut = trailingIncompleteUtf8Count(headSlice)
      if (headTrailCut > 0) headSlice = headSlice.subarray(0, headSlice.length - headTrailCut)
      headText = headSlice.toString('utf8')
      headDeliveredEnd = this.headBuf.length - headTrailCut
    }
    const tailDeliveredStart = this.totalBytes - this.tailBuf.length + tailLeadSkip
    const omittedBytes = Math.max(0, tailDeliveredStart - headDeliveredEnd)
    const marker = `\n...[truncated ${omittedBytes} bytes]...\n`
    const text = headText
      ? `${headText}${marker}${tailText}`
      : tailText
        ? `${marker.trimStart()}${tailText}`
        : marker.trimStart()
    return { text, nextCursor: this.totalBytes - heldBack, truncated: true, omittedBytes, totalBytes: this.totalBytes }
  }

  clear(): void {
    this.totalBytes = 0
    this.truncated = false
    this.inlineBuf = Buffer.alloc(0)
    this.headBuf = Buffer.alloc(0)
    this.tailBuf = Buffer.alloc(0)
  }
}
