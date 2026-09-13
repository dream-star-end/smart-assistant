import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withReceiptWriteBarrier } from './receiptWriteBarrier.js'

// Only the synchronous SQL surface used by receipt ownership. Node and Bun
// share the exact queries, transactions, identity guards and physical barrier.
export type ReceiptSqlValue = string | number | null
export interface ReceiptSqliteDatabase {
  exec(sql: string): unknown
  prepare(sql: string): {
    get(...params: ReceiptSqlValue[]): unknown
    all(...params: ReceiptSqlValue[]): unknown[]
    run(...params: ReceiptSqlValue[]): { changes: number }
  }
  transaction(write: () => void): () => void
  close(): void
}
export type ReceiptSqliteFactory = (existingCanonicalPath: string) => ReceiptSqliteDatabase

/** Internal, already-verified parent binding; NOT an HTTP authentication API. */
export type TrustedReceiptBinding = {
  jobId: string
  generation: number
  userId: string
  parentSession: string
  parentTurnKey: string
  nativeToolUseId: string
  receiptNonceHash: string
  resultDigest: string
}
/** Prepared before input admission so a crash before ACK still has an exact oracle target. */
export type ReceiptInputProof = { nativeSessionId: string; recordLocator: string; recordHash: string }
export type ReceiptInputClaim = TrustedReceiptBinding & {
  ownerToken: string
  parentOwnerEpoch: string
  proof: ReceiptInputProof
}
export type ReceiptRecordObservation = { kind: 'present'; proof: ReceiptInputProof } | { kind: 'absent' } | { kind: 'unknown' }
export type ReceiptRecordOracle = (claim: ReceiptInputClaim) => Promise<ReceiptRecordObservation>
export type ReceiptInputOutcome = 'ingested' | 'already_ingested' | 'notify_owned' | 'pending_recovery' | 'stale_parent' | 'unknown'
export type ReceiptRecoveryOutcome = 'ingested' | 'already_ingested' | 'notify_ready' | 'notify_owned' | 'pending' | 'unknown'
type Row = Record<string, unknown>
type BarrierOptions = { timeoutMs?: number; signal?: AbortSignal }
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const validHash = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)
function bounded(s: unknown, n: number): s is string { return typeof s === 'string' && s.length > 0 && s.length <= n }
function checkedProof(p: ReceiptInputProof): ReceiptInputProof {
  if (!p || !bounded(p.nativeSessionId, 256) || !bounded(p.recordLocator, 2048) || !validHash(p.recordHash)) {
    throw new Error('invalid receipt input proof')
  }
  return { nativeSessionId: p.nativeSessionId, recordLocator: p.recordLocator, recordHash: p.recordHash }
}
function sameProof(a: ReceiptInputProof, b: ReceiptInputProof): boolean {
  return a.nativeSessionId === b.nativeSessionId && a.recordLocator === b.recordLocator && a.recordHash === b.recordHash
}
function checkedBinding(b: TrustedReceiptBinding): TrustedReceiptBinding {
  if (!bounded(b.jobId, 256) || !Number.isSafeInteger(b.generation) || b.generation < 0 ||
      !bounded(b.userId, 256) || !bounded(b.parentSession, 1024) || !bounded(b.parentTurnKey, 256) ||
      !bounded(b.nativeToolUseId, 256) || !validHash(b.receiptNonceHash) || !validHash(b.resultDigest)) {
    throw new Error('invalid receipt identity')
  }
  return Object.freeze({ jobId: b.jobId, generation: b.generation, userId: b.userId, parentSession: b.parentSession,
    parentTurnKey: b.parentTurnKey, nativeToolUseId: b.nativeToolUseId,
    receiptNonceHash: b.receiptNonceHash, resultDigest: b.resultDigest })
}

/**
 * Receipt-only coordinator shared by the gateway and the actual input writer.
 * Opens an EXISTING migrated DB, never falls back to memory or creates schema.
 * All owner changes AND awaited writer/oracle work share the writer-owned flock.
 * No SQL transaction is kept open across await. A callback must perform the real
 * strict append/flush/fsync; this class alone is not proof of CCB resume ingestion.
 */
export class ReceiptDeliveryCoordinator {
  private readonly db: ReceiptSqliteDatabase
  private readonly path: string
  constructor(dbPath: string, openDatabase: ReceiptSqliteFactory, private readonly now: () => number = Date.now) {
    if (dbPath === ':memory:') throw new Error('receipt coordinator requires a persistent database')
    this.path = realpathSync(dbPath)
    this.db = openDatabase(this.path)
    try {
      this.db.exec('PRAGMA busy_timeout = 10000')
      if ((this.db.prepare('PRAGMA user_version').get() as Row)?.user_version !== 7) throw new Error('unsupported receipt consumer schema')
      this.db.prepare('SELECT owner_token,parent_owner_epoch,input_proof FROM delegate_delivery_receipt LIMIT 0').all()
    } catch (err) { this.db.close(); throw err }
  }
  close(): void { this.db.close() }

  async ingest(
    binding: TrustedReceiptBinding,
    input: { parentOwnerEpoch: string; proof: ReceiptInputProof; isCurrentParentOwner: () => Promise<boolean> },
    write: (claim: ReceiptInputClaim) => Promise<void>,
    oracle: ReceiptRecordOracle,
    opts: BarrierOptions = {},
  ): Promise<ReceiptInputOutcome> {
    binding = checkedBinding(binding)
    const proof = Object.freeze(checkedProof(input.proof))
    const parentOwnerEpoch = input.parentOwnerEpoch
    const isCurrentParentOwner = input.isCurrentParentOwner
    if (!bounded(parentOwnerEpoch, 256)) throw new Error('invalid receipt parent owner epoch')
    return this.barrier(binding, async row => {
      if (row.state === 'ingested') return 'already_ingested'
      if (String(row.state).startsWith('notify') || row.state === 'notified') return 'notify_owned'
      if (row.state !== 'offered') return 'pending_recovery'
      // Never interpret an owner lookup exception as authority to write.
      if (!await isCurrentParentOwner()) return 'stale_parent'
      opts.signal?.throwIfAborted()
      const token = randomBytes(24).toString('hex')
      const changed = this.db.prepare(`UPDATE delegate_delivery_receipt SET state='ingest_claimed',
        owner_token=?,parent_owner_epoch=?,input_proof=?,updated_at=?
        WHERE job_id=? AND generation=? AND state='offered' AND owner_token IS NULL`)
        .run(token, parentOwnerEpoch, JSON.stringify(proof), this.now(), binding.jobId, binding.generation)
      if (changed.changes !== 1) throw new Error('receipt input owner CAS lost')
      const claim = this.claimFrom(this.readBound(binding))
      // No finally releases owner on failure: the physical lock closes, while
      // ingest_claimed and its prepared proof remain durable for recovery.
      await write(claim)
      const observation = await this.observe(oracle, claim)
      if (observation.kind !== 'present') return 'unknown'
      this.commitIngested(claim)
      return 'ingested'
    }, opts)
  }

  async recover(
    binding: TrustedReceiptBinding,
    oracle: ReceiptRecordOracle,
    parentState: (claim: ReceiptInputClaim | null) => Promise<'inactive' | 'active' | 'unknown'>,
    opts: BarrierOptions = {},
  ): Promise<ReceiptRecoveryOutcome> {
    binding = checkedBinding(binding)
    return this.barrier(binding, async row => {
      if (row.state === 'ingested') return 'already_ingested'
      if (String(row.state).startsWith('notify') || row.state === 'notified') return 'notify_owned'
      let claim: ReceiptInputClaim | null = null
      if (row.state === 'ingest_claimed') {
        claim = this.claimFrom(row)
        const observation = await this.observe(oracle, claim)
        if (observation.kind === 'present') { this.commitIngested(claim); return 'ingested' }
        if (observation.kind === 'unknown') return 'unknown'
      } else if (row.state !== 'offered') {
        throw new Error('invalid receipt owner state')
      }
      // Parent liveness is separate from physical writer exclusion. No TTL or
      // missing heartbeat gives permission to start a parallel parent turn.
      let parent: 'inactive' | 'active' | 'unknown'
      try { parent = await parentState(claim) } catch { return 'unknown' }
      if (parent === 'unknown') return 'unknown'
      if (parent !== 'inactive') return 'pending'
      opts.signal?.throwIfAborted()
      const token = randomBytes(24).toString('hex')
      this.db.transaction(() => {
        const changed = this.db.prepare(`UPDATE delegate_delivery_receipt SET state='notify_pending',owner_token=?,updated_at=?
          WHERE job_id=? AND generation=? AND state=? AND owner_token IS ?`)
          .run(token, this.now(), binding.jobId, binding.generation, row.state, row.owner_token ?? null)
        if (changed.changes !== 1) throw new Error('receipt notification owner CAS lost')
        const job = this.db.prepare(`UPDATE delegate_jobs SET callback='origin-inject',callback_state='pending',
          callback_epoch=callback_epoch+1,notify_retry_at=NULL,notify_delivery_token=NULL,notify_claimed_until=NULL,
          last_activity_at=?,updated_at=? WHERE job_id=? AND generation=? AND retired_at IS NULL
          AND callback='stdout-wait' AND callback_state='none'
          AND state IN ('completed','failed','cancelled','killed_by_cutover') AND result_json IS NOT NULL`)
          .run(this.now(), this.now(), binding.jobId, binding.generation)
        if (job.changes !== 1) throw new Error('receipt notification job preparation failed')
      })()
      // This is preparation only. The old notifier's claim guard remains
      // closed until the paired receipt-aware dispatch/ACK adapter is installed.
      return 'notify_ready'
    }, opts)
  }

  private async barrier<T>(binding: TrustedReceiptBinding, fn: (row: Row) => Promise<T>, opts: BarrierOptions): Promise<T> {
    if (!bounded(binding.jobId, 256) || !Number.isSafeInteger(binding.generation) || binding.generation < 0) {
      throw new Error('invalid receipt identity')
    }
    const key = hash(JSON.stringify([binding.jobId, binding.generation]))
    return withReceiptWriteBarrier(join(dirname(this.path), 'delegate-receipt-locks', key + '.lock'), async () => {
      return await fn(this.readBound(binding))
    }, opts)
  }

  private readBound(binding: TrustedReceiptBinding): Row {
    const row = this.db.prepare('SELECT * FROM delegate_delivery_receipt WHERE job_id=? AND generation=?')
      .get(binding.jobId, binding.generation) as Row | undefined
    if (!row || row.user_id !== binding.userId || row.parent_session !== binding.parentSession ||
        row.parent_turn_key !== binding.parentTurnKey || row.native_tool_use_id !== binding.nativeToolUseId ||
        row.receipt_nonce_hash !== binding.receiptNonceHash || row.result_digest !== binding.resultDigest) {
      throw new Error('receipt binding mismatch or missing')
    }
    return row
  }

  private claimFrom(row: Row): ReceiptInputClaim {
    if (!bounded(row.owner_token, 256) || !bounded(row.parent_owner_epoch, 256) || typeof row.input_proof !== 'string') {
      throw new Error('receipt input claim is incomplete')
    }
    return Object.freeze({
      jobId: String(row.job_id), generation: Number(row.generation), userId: String(row.user_id),
      parentSession: String(row.parent_session), parentTurnKey: String(row.parent_turn_key),
      nativeToolUseId: String(row.native_tool_use_id), receiptNonceHash: String(row.receipt_nonce_hash),
      resultDigest: String(row.result_digest), ownerToken: row.owner_token,
      parentOwnerEpoch: row.parent_owner_epoch, proof: Object.freeze(checkedProof(JSON.parse(row.input_proof))),
    })
  }

  private async observe(oracle: ReceiptRecordOracle, claim: ReceiptInputClaim): Promise<ReceiptRecordObservation> {
    try {
      const observation = await oracle(claim)
      if (observation.kind === 'present') {
        return sameProof(checkedProof(observation.proof), claim.proof) ? observation : { kind: 'unknown' }
      }
      return observation.kind === 'absent' ? observation : { kind: 'unknown' }
    } catch { return { kind: 'unknown' } }
  }

  private commitIngested(claim: ReceiptInputClaim): void {
    const changed = this.db.prepare(`UPDATE delegate_delivery_receipt SET state='ingested',updated_at=?
      WHERE job_id=? AND generation=? AND state='ingest_claimed' AND owner_token=?
      AND parent_owner_epoch=? AND input_proof=?`)
      .run(this.now(), claim.jobId, claim.generation, claim.ownerToken, claim.parentOwnerEpoch, JSON.stringify(claim.proof))
    if (changed.changes !== 1) throw new Error('receipt ingestion confirmation CAS lost')
  }
}
