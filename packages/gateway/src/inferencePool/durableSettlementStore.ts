/**
 * OCV5-892 B07 — Shared Durable Pending-Settlement Store & Authoritative Reconciliation.
 *
 * Used identically by both `LocalPoolDriver` and `RemotePoolV5Driver` so side-effect
 * execution and authoritative billing settlement are cleanly decoupled:
 * 1. Persist a pending settlement record keyed by fixed business key (`billingIdempotencyKey`
 *    / `billingRequestId`) BEFORE invoking the authoritative `onSettleReceipt` callback.
 * 2. Mark settled & clear the pending entry ONLY AFTER authoritative confirmation succeeds.
 * 3. On transient failure, never wedge on a permanently rejected promise: keep the pending
 *    record so `retrySettlement` / `recoverPendingSettlements` / `reconcilePendingSettlements`
 *    can probe the authoritative ledger (`lookupAuthoritativeSettlement` /
 *    `probeAuthoritativeSettlement`):
 *    - Already written in authoritative ledger -> adopt authoritative outcome (zero double charge).
 *    - Not written in authoritative ledger -> idempotently replay `onSettleReceipt` until settled.
 *
 * Architecture invariants:
 * - Zero `node:sqlite`, `process.env`, network APIs, forbidden crypto primitives, or engine special cases.
 * - Value imports restricted to Node stdlib and L0 `@openclaude/protocol/inference-pool`.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import type { TurnReceiptV5 } from '@openclaude/protocol/inference-pool'

export type DriverTerminalStatus = 'success' | 'error' | 'interrupted' | 'budget_exceeded'

export interface TurnSettlementInfo {
  readonly admissionId: string
  readonly operationId: string
  readonly terminalStatus: DriverTerminalStatus
  readonly cumulativeCreditsFen: bigint
  readonly budgetExceeded: boolean
}

export interface PendingSettlementRecord {
  readonly admissionId: string
  readonly operationId?: string
  readonly turnId: string
  readonly billingRequestId: string
  readonly billingIdempotencyKey?: string
  readonly receipt: TurnReceiptV5
  readonly settlement: TurnSettlementInfo
  readonly status?: 'pending' | 'settled'
  readonly createdAt?: string
}

export interface PendingSettlementOutbox {
  /**
   * Explicitly marks whether the outbox survives process restarts.
   * `InMemoryPendingSettlementOutbox` sets `durable = false`; omitting it on custom
   * durable stores defaults to `true`.
   */
  readonly durable?: boolean
  put(record: PendingSettlementRecord): Promise<void> | void
  get(
    admissionIdOrKey: string,
  ): Promise<PendingSettlementRecord | null> | PendingSettlementRecord | null
  delete(admissionIdOrKey: string): Promise<void> | void
  list(): Promise<readonly PendingSettlementRecord[]> | readonly PendingSettlementRecord[]
}

export type AuthoritativeSettlementLookupResult =
  | boolean
  | {
      readonly settled: boolean
      readonly receipt?: TurnReceiptV5 | null
    }

export type LookupAuthoritativeSettlementFn = (
  billingKey: string,
  record: PendingSettlementRecord,
) => Promise<AuthoritativeSettlementLookupResult> | AuthoritativeSettlementLookupResult

export type SettlementResolutionKind = 'replayed_to_ledger' | 'adopted_from_ledger'

export interface PendingSettlementRecoveryFailure {
  readonly admissionId: string
  readonly billingIdempotencyKey: string
  readonly code?: 'writer_unavailable' | 'settlement_failed'
  readonly error: Error
}

export interface PendingSettlementRecoveryReport {
  readonly settled: readonly TurnReceiptV5[]
  readonly adoptedFromLedger: number
  readonly replayedToLedger: number
  readonly skippedNoWriter: number
  readonly failed: readonly PendingSettlementRecoveryFailure[]
}

export class SettlementWriterUnavailableError extends Error {
  readonly code = 'SETTLEMENT_WRITER_UNAVAILABLE' as const

  constructor(billingKey: string) {
    super(
      `SETTLEMENT_WRITER_UNAVAILABLE: pending settlement "${billingKey}" is not confirmed in authoritative ledger and no onSettleReceipt writer is configured`,
    )
    this.name = 'SettlementWriterUnavailableError'
  }
}

export interface SettlePendingOutcome {
  readonly receipt: TurnReceiptV5
  readonly resolution: SettlementResolutionKind
}

const SAFE_SETTLEMENT_KEY_RE = /^[A-Za-z0-9._-]{1,128}$/
const SETTLEMENT_FILE_SUFFIX = '.settlement.json'

export function resolveBillingIdempotencyKey(record: PendingSettlementRecord): string {
  return record.billingIdempotencyKey ?? record.billingRequestId
}

function safeSettlementFilename(key: string): string {
  const safe = SAFE_SETTLEMENT_KEY_RE.test(key)
    ? key
    : createHash('sha256').update(key, 'utf8').digest('hex')
  return `${safe}${SETTLEMENT_FILE_SUFFIX}`
}

function matchesPendingKey(record: PendingSettlementRecord, key: string): boolean {
  return (
    record.admissionId === key ||
    record.billingRequestId === key ||
    record.billingIdempotencyKey === key ||
    record.operationId === key ||
    record.settlement.operationId === key
  )
}

function fsyncDirSync(dirPath: string): void {
  let dirFd: number | undefined
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0)
    dirFd = openSync(dirPath, flags)
    fsyncSync(dirFd)
  } finally {
    if (dirFd !== undefined) closeSync(dirFd)
  }
}

function writeAllSync(fd: number, buf: Buffer): void {
  let offset = 0
  while (offset < buf.length) {
    offset += writeSync(fd, buf, offset, buf.length - offset)
  }
}

interface SerializedPendingSettlementRecord {
  readonly schemaVersion: 1
  readonly admissionId: string
  readonly operationId: string
  readonly turnId: string
  readonly billingRequestId: string
  readonly billingIdempotencyKey: string
  readonly receipt: TurnReceiptV5
  readonly settlement: {
    readonly admissionId: string
    readonly operationId: string
    readonly terminalStatus: DriverTerminalStatus
    readonly cumulativeCreditsFen: string
    readonly budgetExceeded: boolean
  }
  readonly status: 'pending'
  readonly createdAt?: string
}

function serializePendingRecord(record: PendingSettlementRecord): SerializedPendingSettlementRecord {
  const billingKey = resolveBillingIdempotencyKey(record)
  return {
    schemaVersion: 1,
    admissionId: record.admissionId,
    operationId: record.operationId ?? record.settlement.operationId,
    turnId: record.turnId,
    billingRequestId: record.billingRequestId,
    billingIdempotencyKey: billingKey,
    receipt: record.receipt,
    settlement: {
      admissionId: record.settlement.admissionId,
      operationId: record.settlement.operationId,
      terminalStatus: record.settlement.terminalStatus,
      cumulativeCreditsFen: record.settlement.cumulativeCreditsFen.toString(),
      budgetExceeded: record.settlement.budgetExceeded,
    },
    status: 'pending',
    ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
  }
}

function deserializePendingRecord(raw: unknown): PendingSettlementRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (
    typeof obj.admissionId !== 'string' ||
    typeof obj.turnId !== 'string' ||
    typeof obj.billingRequestId !== 'string' ||
    obj.receipt === null ||
    typeof obj.receipt !== 'object' ||
    obj.settlement === null ||
    typeof obj.settlement !== 'object'
  ) {
    return null
  }
  const st = obj.settlement as Record<string, unknown>
  if (
    typeof st.admissionId !== 'string' ||
    typeof st.operationId !== 'string' ||
    typeof st.terminalStatus !== 'string' ||
    typeof st.budgetExceeded !== 'boolean'
  ) {
    return null
  }
  let creditsFen: bigint
  try {
    creditsFen =
      typeof st.cumulativeCreditsFen === 'bigint'
        ? st.cumulativeCreditsFen
        : BigInt(String(st.cumulativeCreditsFen ?? '0'))
  } catch {
    return null
  }
  const billingIdempotencyKey =
    typeof obj.billingIdempotencyKey === 'string' && obj.billingIdempotencyKey.length > 0
      ? obj.billingIdempotencyKey
      : obj.billingRequestId
  const operationId =
    typeof obj.operationId === 'string' && obj.operationId.length > 0
      ? obj.operationId
      : st.operationId

  return Object.freeze({
    admissionId: obj.admissionId,
    operationId,
    turnId: obj.turnId,
    billingRequestId: obj.billingRequestId,
    billingIdempotencyKey,
    receipt: obj.receipt as TurnReceiptV5,
    settlement: Object.freeze({
      admissionId: st.admissionId,
      operationId: st.operationId,
      terminalStatus: st.terminalStatus as DriverTerminalStatus,
      cumulativeCreditsFen: creditsFen,
      budgetExceeded: st.budgetExceeded,
    }),
    status: 'pending' as const,
    ...(typeof obj.createdAt === 'string' ? { createdAt: obj.createdAt } : {}),
  })
}

export class InMemoryPendingSettlementOutbox implements PendingSettlementOutbox {
  readonly durable = false
  private readonly records = new Map<string, PendingSettlementRecord>()

  put(record: PendingSettlementRecord): void {
    const key = resolveBillingIdempotencyKey(record)
    this.records.set(key, record)
  }

  get(admissionIdOrKey: string): PendingSettlementRecord | null {
    const direct = this.records.get(admissionIdOrKey)
    if (direct) return direct
    for (const rec of this.records.values()) {
      if (matchesPendingKey(rec, admissionIdOrKey)) {
        return rec
      }
    }
    return null
  }

  delete(admissionIdOrKey: string): void {
    if (this.records.delete(admissionIdOrKey)) return
    for (const [key, rec] of this.records) {
      if (matchesPendingKey(rec, admissionIdOrKey)) {
        this.records.delete(key)
        return
      }
    }
  }

  list(): readonly PendingSettlementRecord[] {
    return [...this.records.values()]
  }
}

export class FilePendingSettlementOutbox implements PendingSettlementOutbox {
  readonly walDir: string

  constructor(walDir: string) {
    const resolvedDir = resolve(walDir)
    mkdirSync(resolvedDir, { recursive: true, mode: 0o700 })
    const st = lstatSync(resolvedDir)
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new Error(`SETTLEMENT_WAL_DIR_INVALID:${resolvedDir}`)
    }
    this.walDir = resolvedDir
  }

  put(record: PendingSettlementRecord): void {
    const billingKey = resolveBillingIdempotencyKey(record)
    const finalPath = join(this.walDir, safeSettlementFilename(billingKey))
    const tmpPath = join(this.walDir, `.${randomUUID()}.settlement.tmp`)
    const payload = Buffer.from(JSON.stringify(serializePendingRecord(record)), 'utf8')
    const flags =
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      (fsConstants.O_NOFOLLOW ?? 0)
    let fd: number | undefined
    try {
      fd = openSync(tmpPath, flags, 0o600)
      writeAllSync(fd, payload)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(tmpPath, finalPath)
      fsyncDirSync(this.walDir)
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {}
      }
      try {
        unlinkSync(tmpPath)
      } catch {}
      throw err
    }
  }

  get(admissionIdOrKey: string): PendingSettlementRecord | null {
    const directPath = join(this.walDir, safeSettlementFilename(admissionIdOrKey))
    const direct = this.readFileRecordSync(directPath)
    if (direct && matchesPendingKey(direct, admissionIdOrKey)) {
      return direct
    }
    for (const rec of this.list()) {
      if (matchesPendingKey(rec, admissionIdOrKey)) {
        return rec
      }
    }
    return null
  }

  delete(admissionIdOrKey: string): void {
    const directPath = join(this.walDir, safeSettlementFilename(admissionIdOrKey))
    const direct = this.readFileRecordSync(directPath)
    if (direct && matchesPendingKey(direct, admissionIdOrKey)) {
      this.unlinkFileSync(directPath)
      return
    }
    for (const entry of readdirSync(this.walDir)) {
      if (!entry.endsWith(SETTLEMENT_FILE_SUFFIX)) continue
      const fullPath = join(this.walDir, entry)
      const parsed = this.readFileRecordSync(fullPath)
      if (parsed && matchesPendingKey(parsed, admissionIdOrKey)) {
        this.unlinkFileSync(fullPath)
        return
      }
    }
  }

  list(): readonly PendingSettlementRecord[] {
    const records: PendingSettlementRecord[] = []
    for (const entry of readdirSync(this.walDir)) {
      if (!entry.endsWith(SETTLEMENT_FILE_SUFFIX)) continue
      const parsed = this.readFileRecordSync(join(this.walDir, entry))
      if (parsed) records.push(parsed)
    }
    return records
  }

  private readFileRecordSync(filePath: string): PendingSettlementRecord | null {
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw err
    }
    if (!st.isFile() || st.isSymbolicLink()) return null
    let fd: number | undefined
    try {
      fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      const raw = readFileSync(fd, 'utf8')
      return deserializePendingRecord(JSON.parse(raw))
    } catch {
      return null
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {}
      }
    }
  }

  private unlinkFileSync(filePath: string): void {
    try {
      unlinkSync(filePath)
      fsyncDirSync(this.walDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw err
      }
    }
  }
}

export interface DurableSettlementCoordinatorOptions {
  readonly pendingSettlementOutbox?: PendingSettlementOutbox
  readonly settlementWalDir?: string
  readonly onSettleReceipt?: (
    receipt: TurnReceiptV5,
    settlement: TurnSettlementInfo,
  ) => Promise<TurnReceiptV5 | void> | TurnReceiptV5 | void
  readonly lookupAuthoritativeSettlement?: LookupAuthoritativeSettlementFn
  readonly probeAuthoritativeSettlement?: (billingRequestId: string) => Promise<boolean> | boolean
}

export class DurableSettlementCoordinator {
  readonly isDurable: boolean
  readonly hasWriter: boolean
  readonly hasAuthoritativeLookup: boolean

  private readonly outbox: PendingSettlementOutbox
  private readonly onSettleReceipt?: DurableSettlementCoordinatorOptions['onSettleReceipt']
  private readonly lookupAuthoritativeSettlement?: LookupAuthoritativeSettlementFn
  private readonly probeAuthoritativeSettlement?: DurableSettlementCoordinatorOptions['probeAuthoritativeSettlement']
  private readonly inMemoryMirror = new Map<string, PendingSettlementRecord>()
  private readonly inFlightByKey = new Map<string, Promise<SettlePendingOutcome>>()

  constructor(opts: DurableSettlementCoordinatorOptions) {
    if (opts.pendingSettlementOutbox) {
      this.outbox = opts.pendingSettlementOutbox
      this.isDurable = opts.pendingSettlementOutbox.durable !== false
    } else if (typeof opts.settlementWalDir === 'string' && opts.settlementWalDir.trim().length > 0) {
      this.outbox = new FilePendingSettlementOutbox(opts.settlementWalDir)
      this.isDurable = true
    } else {
      this.outbox = new InMemoryPendingSettlementOutbox()
      this.isDurable = false
    }
    this.onSettleReceipt = opts.onSettleReceipt
    this.lookupAuthoritativeSettlement = opts.lookupAuthoritativeSettlement
    this.probeAuthoritativeSettlement = opts.probeAuthoritativeSettlement
    this.hasWriter = typeof opts.onSettleReceipt === 'function'
    this.hasAuthoritativeLookup =
      typeof opts.lookupAuthoritativeSettlement === 'function' ||
      typeof opts.probeAuthoritativeSettlement === 'function'
  }

  async persistPending(record: PendingSettlementRecord): Promise<void> {
    const key = resolveBillingIdempotencyKey(record)
    this.inMemoryMirror.set(key, record)
    await this.outbox.put(record)
  }

  async listPending(): Promise<readonly PendingSettlementRecord[]> {
    const byKey = new Map<string, PendingSettlementRecord>()
    for (const [key, rec] of this.inMemoryMirror) {
      byKey.set(key, rec)
    }
    const persisted = await this.outbox.list()
    for (const rec of persisted) {
      byKey.set(resolveBillingIdempotencyKey(rec), rec)
    }
    return [...byKey.values()]
  }

  async findPending(admissionIdOrKey: string): Promise<PendingSettlementRecord | null> {
    const direct = this.inMemoryMirror.get(admissionIdOrKey)
    if (direct) return direct
    for (const rec of this.inMemoryMirror.values()) {
      if (matchesPendingKey(rec, admissionIdOrKey)) {
        return rec
      }
    }
    const persistedDirect = await this.outbox.get(admissionIdOrKey)
    if (persistedDirect) return persistedDirect
    const persistedList = await this.outbox.list()
    for (const rec of persistedList) {
      if (matchesPendingKey(rec, admissionIdOrKey)) {
        return rec
      }
    }
    return null
  }

  async settlePending(
    pending: PendingSettlementRecord,
    onSettled?: (receipt: TurnReceiptV5, resolution: SettlementResolutionKind) => void,
  ): Promise<SettlePendingOutcome> {
    const billingKey = resolveBillingIdempotencyKey(pending)
    const existingInFlight = this.inFlightByKey.get(billingKey)
    if (existingInFlight) {
      return await existingInFlight
    }

    const attempt = (async (): Promise<SettlePendingOutcome> => {
      let alreadySettled = false
      let authoritativeReceipt: TurnReceiptV5 | null = null

      if (this.lookupAuthoritativeSettlement) {
        const lookup = await this.lookupAuthoritativeSettlement(billingKey, pending)
        if (typeof lookup === 'boolean') {
          alreadySettled = lookup
        } else if (lookup && lookup.settled) {
          alreadySettled = true
          authoritativeReceipt = lookup.receipt ?? null
        }
      } else if (this.probeAuthoritativeSettlement) {
        alreadySettled = Boolean(await this.probeAuthoritativeSettlement(pending.billingRequestId))
      }

      let resolution: SettlementResolutionKind
      let finalReceipt: TurnReceiptV5
      if (alreadySettled) {
        resolution = 'adopted_from_ledger'
        finalReceipt = authoritativeReceipt ?? pending.receipt
      } else {
        if (!this.onSettleReceipt) {
          // B07: NEVER report replayed_to_ledger or delete pending outbox records when the
          // authoritative ledger did not confirm settlement and no writer is configured!
          throw new SettlementWriterUnavailableError(billingKey)
        }
        const writerReturned = await this.onSettleReceipt(pending.receipt, pending.settlement)
        resolution = 'replayed_to_ledger'
        finalReceipt = writerReturned ?? pending.receipt
      }

      onSettled?.(finalReceipt, resolution)
      this.inMemoryMirror.delete(billingKey)
      // Delete by admissionId first for custom outboxes keyed by admissionId, then by billingKey if distinct.
      await this.outbox.delete(pending.admissionId)
      if (billingKey !== pending.admissionId) {
        await this.outbox.delete(billingKey)
      }
      return { receipt: finalReceipt, resolution }
    })()

    this.inFlightByKey.set(billingKey, attempt)
    try {
      return await attempt
    } finally {
      if (this.inFlightByKey.get(billingKey) === attempt) {
        this.inFlightByKey.delete(billingKey)
      }
    }
  }

  async recoverPendingSettlements(
    onSettled?: (
      pending: PendingSettlementRecord,
      receipt: TurnReceiptV5,
      resolution: SettlementResolutionKind,
    ) => void,
  ): Promise<PendingSettlementRecoveryReport> {
    const pendingList = await this.listPending()
    const settled: TurnReceiptV5[] = []
    const failed: PendingSettlementRecoveryFailure[] = []
    let adoptedFromLedger = 0
    let replayedToLedger = 0
    let skippedNoWriter = 0

    for (const pending of pendingList) {
      try {
        const outcome = await this.settlePending(pending, (receipt, resolution) => {
          onSettled?.(pending, receipt, resolution)
        })
        settled.push(outcome.receipt)
        if (outcome.resolution === 'adopted_from_ledger') {
          adoptedFromLedger += 1
        } else {
          replayedToLedger += 1
        }
      } catch (err) {
        const isNoWriter = err instanceof SettlementWriterUnavailableError
        if (isNoWriter) {
          skippedNoWriter += 1
        }
        failed.push({
          admissionId: pending.admissionId,
          billingIdempotencyKey: resolveBillingIdempotencyKey(pending),
          code: isNoWriter ? 'writer_unavailable' : 'settlement_failed',
          error: err instanceof Error ? err : new Error(String(err)),
        })
      }
    }

    return Object.freeze({
      settled: Object.freeze(settled),
      adoptedFromLedger,
      replayedToLedger,
      skippedNoWriter,
      failed: Object.freeze(failed),
    })
  }
}
