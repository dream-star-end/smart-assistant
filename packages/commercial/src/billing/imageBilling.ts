import type { Pool } from 'pg'
import { resolveOrgBillingContext } from '../org/orgBilling.js'
import { spendTwoBucket } from './spend.js'
import { InsufficientCreditsError } from './ledger.js'

export const IMAGE2_UNIT_COST = 50n
export const IMAGE_RESPONSE_CACHE_MAX_BYTES = 64 * 1024 * 1024
export const IMAGE_STALE_SWEEP_INTERVAL_MS = 60_000

export async function sweepStaleImageUsage(pool: Pool, batchSize = 500): Promise<number> {
  const boundedBatch = Math.max(1, Math.min(5000, Math.trunc(batchSize)))
  const result = await pool.query<{ finalized: string }>(
    `WITH stale AS (
       SELECT id FROM image_generation_usage_records
        WHERE status='reserved' AND updated_at < NOW()-INTERVAL '15 minutes'
        ORDER BY updated_at,id
        LIMIT $1 FOR UPDATE SKIP LOCKED
     ), attempts AS (
       UPDATE image_generation_attempts a
          SET outcome='failed',error_code='IMAGE_STALE_TIMEOUT',completed_at=NOW()
         FROM stale
        WHERE a.usage_id=stale.id AND a.outcome='pending'
       RETURNING a.id
     ), journeys AS (
       UPDATE image_generation_usage_records u
          SET status='failed',error_code='IMAGE_STALE_TIMEOUT',updated_at=NOW()
         FROM stale
        WHERE u.id=stale.id AND u.status='reserved'
       RETURNING u.id
     )
     SELECT COUNT(*)::text AS finalized FROM journeys`,
    [boundedBatch],
  )
  return Number(result.rows[0]?.finalized ?? 0)
}

export interface ImageUsageSweeperHandle {
  stop(): void
  runNow(): Promise<number>
}

export function startImageUsageSweeper(opts: {
  pool: Pool
  intervalMs?: number
  runOnStart?: boolean
  onError?: (error: unknown) => void
}): ImageUsageSweeperHandle {
  const intervalMs = Math.max(10_000, opts.intervalMs ?? IMAGE_STALE_SWEEP_INTERVAL_MS)
  let stopped = false
  const runNow = async (): Promise<number> => {
    if (stopped) return 0
    try {
      return await sweepStaleImageUsage(opts.pool)
    } catch (error) {
      opts.onError?.(error)
      return -1
    }
  }
  const timer = setInterval(() => { void runNow() }, intervalMs)
  timer.unref?.()
  if (opts.runOnStart) void runNow()
  return {
    stop() { stopped = true; clearInterval(timer) },
    runNow,
  }
}

function stableImageErrorCode(code: string | undefined): string | null {
  if (!code) return null
  const upper = code.trim().toUpperCase()
  const prefixed = upper.startsWith('IMAGE_') ? upper : `IMAGE_${upper}`
  return /^[A-Z0-9_]{1,64}$/.test(prefixed) ? prefixed : 'IMAGE_UNKNOWN'
}

export class ImageDailyLimitError extends Error {
  constructor() {
    super('daily Image 2 limit reached')
    this.name = 'ImageDailyLimitError'
  }
}

export class ImageInputMismatchError extends Error {
  constructor() {
    super('image recovery input does not match the paid request')
    this.name = 'ImageInputMismatchError'
  }
}

/** Bind the stable request/job id to the exact normalized edit input. The
 * first valid attempt records the hash; retries and post-expiry free recovery
 * must match it byte-for-byte or they could reuse an old paid job for a new
 * image. */
export async function bindImageInputHash(pool: Pool, args: {
  userId: bigint
  requestId: string
  inputHash: Buffer
}): Promise<void> {
  if (args.inputHash.length !== 32) throw new Error('image input hash must be SHA-256')
  const result = await pool.query(
    `UPDATE image_generation_usage_records
     SET input_hash=COALESCE(input_hash,$3), updated_at=NOW()
     WHERE user_id=$1 AND request_id=$2 AND status='reserved'
       AND (input_hash IS NULL OR input_hash=$3)
     RETURNING id`,
    [args.userId.toString(), args.requestId, args.inputHash],
  )
  if (result.rowCount !== 1) throw new ImageInputMismatchError()
}

export async function getCompletedImageUsage(pool: Pool, args: {
  userId: bigint
  requestId: string
}): Promise<{ responseBody: Buffer; contentType: string } | null> {
  const result = await pool.query<{ response_body: Buffer | null; response_content_type: string | null }>(
    `SELECT response_body, response_content_type FROM image_generation_usage_records
     WHERE user_id=$1 AND request_id=$2 AND status='success'
       AND response_expires_at > NOW()`,
    [args.userId.toString(), args.requestId],
  )
  const row = result.rows[0]
  if (!row?.response_body || !row.response_content_type) return null
  return { responseBody: row.response_body, contentType: row.response_content_type }
}

export async function reserveImageUsage(pool: Pool, args: {
  userId: bigint
  containerId: number | null
  requestId: string
  jobId?: string | null
  operation: 'generation' | 'edit' | 'annotated_edit' | 'native_image'
  /** Number of output images (native_image data plane bills 50×n). Default 1;
   * clamp [1,4] is the caller's responsibility (relay). Fixed 50/image. */
  imageCount?: number
}): Promise<{ alreadyCharged: boolean }> {
  const imageCount = args.imageCount ?? 1
  const costCredits = IMAGE2_UNIT_COST * BigInt(imageCount)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Opportunistic global bounded cleanup keeps one-shot users from leaving
    // expired TOAST values forever. The expiry index makes this O(batch).
    await client.query(
      `UPDATE image_generation_usage_records SET response_body=NULL, response_content_type=NULL
       WHERE id IN (
         SELECT id FROM image_generation_usage_records
         WHERE response_body IS NOT NULL AND response_expires_at <= NOW()
         ORDER BY response_expires_at ASC LIMIT 100
       )`,
    )
    // Serialize quota admission per user. This makes the UTC daily check and
    // one-in-flight insert a single decision even across master/egress nodes.
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [args.userId.toString()])
    await client.query(
      `UPDATE image_generation_usage_records
       SET response_body=NULL, response_content_type=NULL
       WHERE user_id=$1 AND response_body IS NOT NULL AND response_expires_at <= NOW()`,
      [args.userId.toString()],
    )
    await client.query(
      `WITH stale AS (
         UPDATE image_generation_usage_records
            SET status='failed', error_code='IMAGE_STALE_TIMEOUT', updated_at=NOW()
          WHERE user_id=$1 AND status='reserved' AND updated_at < NOW() - INTERVAL '15 minutes'
         RETURNING id
       )
       UPDATE image_generation_attempts a
          SET outcome='failed', error_code='IMAGE_STALE_TIMEOUT', completed_at=NOW()
         FROM stale
        WHERE a.usage_id=stale.id AND a.outcome='pending'`,
      [args.userId.toString()],
    )
    const daily = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM image_generation_usage_records
       WHERE user_id=$1 AND (status='success' OR ledger_id IS NOT NULL)
         AND request_id<>$2
         AND completed_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [args.userId.toString(), args.requestId],
    )
    if (BigInt(daily.rows[0]?.count ?? '0') >= 10n) throw new ImageDailyLimitError()
    const inserted = await client.query<{ already_charged: boolean }>(
      `INSERT INTO image_generation_usage_records
         (user_id,container_id,request_id,job_id,operation,status,image_count,cost_credits)
       VALUES ($1,$2,$3,$4,$5,'reserved',$6,$7)
       ON CONFLICT (user_id,request_id) DO UPDATE SET
         container_id=EXCLUDED.container_id,
         job_id=EXCLUDED.job_id,
         operation=EXCLUDED.operation,
         image_count=EXCLUDED.image_count,
         cost_credits=EXCLUDED.cost_credits,
         status='reserved',
         error_code=NULL,
         updated_at=NOW()
       WHERE image_generation_usage_records.status='failed'
          OR (
            image_generation_usage_records.status='success'
            AND image_generation_usage_records.operation IN ('annotated_edit','native_image')
            AND image_generation_usage_records.response_expires_at <= NOW()
          )
       RETURNING ledger_id IS NOT NULL AS already_charged`,
      [args.userId.toString(), args.containerId, args.requestId, args.jobId ?? null, args.operation, imageCount, costCredits.toString()],
    )
    if (inserted.rowCount !== 1) {
      const conflict = new Error('image request already exists') as Error & { code: string }
      conflict.code = '23505'
      throw conflict
    }
    await client.query('COMMIT')
    return { alreadyCharged: inserted.rows[0]?.already_charged === true }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Atomically records one real upstream fetch immediately before it begins.
 * attempt_count is cumulative for the stable request journey (including paid
 * cache recovery) and is never reset when a failed/expired row is reopened. */
export async function beginImageUpstreamAttempt(
  pool: Pool,
  args: { userId: bigint; requestId: string },
): Promise<{ attemptId: bigint; attemptNo: number }> {
  const result = await pool.query<{ id: string; attempt_no: number }>(
    `WITH bumped AS (
       UPDATE image_generation_usage_records
          SET attempt_count=attempt_count+1, last_attempt_at=NOW(), updated_at=NOW()
        WHERE user_id=$1 AND request_id=$2 AND status='reserved'
       RETURNING id,user_id,attempt_count
     )
     INSERT INTO image_generation_attempts(usage_id,user_id,attempt_no,outcome)
     SELECT id,user_id,attempt_count,'pending' FROM bumped
     RETURNING id::text AS id,attempt_no`,
    [args.userId.toString(), args.requestId],
  )
  if (result.rowCount !== 1) throw new Error('image retry reservation is not active')
  return { attemptId: BigInt(result.rows[0]!.id), attemptNo: result.rows[0]!.attempt_no }
}

export async function finishImageUpstreamAttempt(
  pool: Pool,
  args: {
    userId: bigint
    requestId: string
    attemptId: bigint
    outcome: 'succeeded' | 'failed' | 'cancelled'
    errorCode?: string
  },
): Promise<boolean> {
  const errorCode = args.outcome === 'succeeded'
    ? null
    : stableImageErrorCode(args.errorCode) ?? 'IMAGE_UNKNOWN'
  const result = await pool.query(
    `UPDATE image_generation_attempts a
        SET outcome=$4,error_code=$5,completed_at=NOW()
       FROM image_generation_usage_records u
      WHERE a.id=$1 AND a.usage_id=u.id
        AND u.user_id=$2 AND u.request_id=$3
        AND a.outcome='pending'`,
    [args.attemptId.toString(), args.userId.toString(), args.requestId, args.outcome, errorCode],
  )
  return result.rowCount === 1
}

export async function settleImageCharge(
  pool: Pool,
  args: {
    userId: bigint
    containerId: number | null
    requestId: string
    jobId?: string | null
    operation: 'generation' | 'edit' | 'annotated_edit' | 'native_image'
    /** Output image count (native_image bills 50×n). Must match reserve. Default 1. */
    imageCount?: number
    responseBody: Buffer
    responseContentType?: string
  },
): Promise<{ ledgerId: bigint | null; balanceAfter: bigint | null; duplicate: boolean }> {
  const client = await pool.connect()
  const chargeAmount = IMAGE2_UNIT_COST * BigInt(args.imageCount ?? 1)
  try {
    if (args.responseBody.byteLength > IMAGE_RESPONSE_CACHE_MAX_BYTES) {
      throw new Error('image response exceeds cache limit')
    }
    await client.query('BEGIN')
    const existing = await client.query<{ id: string; ledger_id: string | null; status: string }>(
      `SELECT id::text AS id, ledger_id::text AS ledger_id, status FROM image_generation_usage_records
       WHERE user_id=$1 AND request_id=$2 FOR UPDATE`,
      [args.userId.toString(), args.requestId],
    )
    if (existing.rows[0]?.status === 'success') {
      await client.query('COMMIT')
      return {
        ledgerId: existing.rows[0].ledger_id ? BigInt(existing.rows[0].ledger_id) : null,
        balanceAfter: null,
        duplicate: true,
      }
    }
    if (existing.rows[0]?.status === 'reserved' && existing.rows[0].ledger_id) {
      await client.query(
        `UPDATE image_generation_usage_records
         SET status='success', response_body=$1, response_content_type=$2,
             response_expires_at=NOW() + INTERVAL '24 hours', error_code=NULL, updated_at=NOW()
         WHERE id=$3`,
        [
          args.responseBody,
          args.responseContentType ?? 'application/json; charset=utf-8',
          existing.rows[0].id,
        ],
      )
      await client.query('COMMIT')
      return { ledgerId: BigInt(existing.rows[0].ledger_id), balanceAfter: null, duplicate: true }
    }
    const orgCtx = await resolveOrgBillingContext(client, args.userId)
    if (!existing.rows[0] || existing.rows[0].status !== 'reserved') {
      throw new Error('image usage is not reserved')
    }
    const row = await client.query<{ id: string }>(
      `UPDATE image_generation_usage_records SET updated_at=NOW(), error_code=NULL
       WHERE user_id=$1 AND request_id=$2 RETURNING id::text AS id`,
      [args.userId.toString(), args.requestId],
    )
    const usageId = BigInt(row.rows[0]!.id)
    const spend = await spendTwoBucket(client, {
      userId: args.userId,
      amount: chargeAmount,
      reason: 'image_generation',
      ref: { type: 'image_generation', id: usageId.toString() },
      memo: `gpt-image-2 ${args.operation}${(args.imageCount ?? 1) > 1 ? ` x${args.imageCount}` : ''}`,
      orgId: orgCtx?.billingEnabled ? orgCtx.orgId : undefined,
      monthlyOrgBudget: orgCtx?.billingEnabled ? orgCtx.monthlyOrgBudget : undefined,
    })
    if (spend.clamped || spend.debited !== chargeAmount) {
      throw new InsufficientCreditsError(spend.debited, chargeAmount)
    }
    await client.query(
      `UPDATE image_generation_usage_records
       SET status='success', ledger_id=$1, response_body=$2, response_content_type=$3, completed_at=NOW(),
           response_expires_at=CASE WHEN operation='annotated_edit'
             THEN NOW() + INTERVAL '24 hours' ELSE NOW() + INTERVAL '1 hour' END,
           updated_at=NOW()
       WHERE id=$4`,
      [
        spend.primaryLedgerId?.toString() ?? null,
        args.responseBody,
        args.responseContentType ?? 'application/json; charset=utf-8',
        usageId.toString(),
      ],
    )
    await client.query('COMMIT')
    return { ledgerId: spend.primaryLedgerId, balanceAfter: spend.totalAfter, duplicate: false }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export async function markImageUsage(
  pool: Pool,
  args: {
    userId: bigint
    containerId: number | null
    requestId: string
    jobId?: string | null
    operation: 'generation' | 'edit' | 'annotated_edit' | 'native_image'
    status: 'reserved' | 'failed'
    errorCode?: string
  },
): Promise<void> {
  const errorCode = stableImageErrorCode(args.errorCode)
  await pool.query(
    `INSERT INTO image_generation_usage_records
       (user_id,container_id,request_id,job_id,operation,status,error_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id,request_id) DO UPDATE SET
       status=CASE WHEN image_generation_usage_records.status='success' THEN 'success' ELSE EXCLUDED.status END,
       error_code=CASE WHEN image_generation_usage_records.status='success' THEN image_generation_usage_records.error_code ELSE EXCLUDED.error_code END,
       updated_at=NOW()`,
    [
      args.userId.toString(),
      args.containerId,
      args.requestId,
      args.jobId ?? null,
      args.operation,
      args.status,
      errorCode,
    ],
  )
}
