/** Platform expense only. Admission survives cancellation/restart; it never refunds or charges a wallet. */
import type { Pool } from 'pg'
import { getPool } from '../../db/index.js'
import { tx } from '../../db/queries.js'
import { LiteratureError } from './errors.js'
import type { PlatformCaptchaBegin, PlatformCaptchaUsage } from './officialCaptchaReader.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TOKEN_KEYS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'thoughtTokens',
  'totalTokens',
] as const
const OUTCOMES = new Set([
  'success',
  'refused',
  'invalid',
  'http_error',
  'network_error',
  'cancelled',
])
export interface PlatformCaptchaLimits {
  globalDaily: number
  userDaily: number
  operationTotal: number
}
export const DEFAULT_PLATFORM_CAPTCHA_LIMITS: Readonly<PlatformCaptchaLimits> = Object.freeze({
  globalDaily: 500,
  userDaily: 20,
  operationTotal: 4,
})
function invalid(): never {
  throw new LiteratureError('INVALID_INPUT')
}
function validateBegin(value: Readonly<PlatformCaptchaBegin>): void {
  if (
    !value ||
    typeof value.requestId !== 'string' ||
    !UUID.test(value.requestId) ||
    !['anthropic', 'google'].includes(value.provider)
  )
    invalid()
  const prefix = value.provider === 'anthropic' ? 'claude-' : 'gemini-'
  const model =
    typeof value.model === 'string' ? value.model.replace(/^(?:anthropic|google)\//, '') : ''
  if (
    typeof value.model !== 'string' ||
    value.model.length > 128 ||
    !model.startsWith(prefix) ||
    !/^[a-z0-9.-]+$/.test(model)
  )
    invalid()
}
function tokens(event: Readonly<PlatformCaptchaUsage>): Array<number | null> {
  if (!OUTCOMES.has(event.outcome)) invalid()
  if (event.usage === null) return TOKEN_KEYS.map(() => null)
  if (!event.usage || typeof event.usage !== 'object') invalid()
  return TOKEN_KEYS.map((key) => {
    const count = event.usage![key]
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > (key === 'totalTokens' ? 8_000_000 : 2_000_000)
    )
      invalid()
    return count
  })
}
interface UsageRow {
  provider: string
  model: string
  outcome: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  thought_tokens: number | null
  total_tokens: number | null
}
/** Construct only from authenticated server context; never from model/tool arguments. */
export class PostgresPlatformCaptchaMeter {
  private readonly pool: Pool
  private readonly userId: number
  private readonly operationKey: string
  private readonly limits: Readonly<PlatformCaptchaLimits>
  constructor(input: {
    userId: number
    operationKey: string
    pool?: Pool
    limits?: Partial<PlatformCaptchaLimits>
  }) {
    if (
      !Number.isSafeInteger(input.userId) ||
      input.userId < 1 ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.operationKey)
    )
      invalid()
    const limits = { ...DEFAULT_PLATFORM_CAPTCHA_LIMITS, ...input.limits }
    for (const [key, maximum] of [
      ['globalDaily', 100_000],
      ['userDaily', 10_000],
      ['operationTotal', 4],
    ] as const) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum) invalid()
    }
    this.pool = input.pool ?? getPool()
    this.userId = input.userId
    this.operationKey = input.operationKey
    this.limits = Object.freeze(limits)
  }
  /** Resolve only after a NEW reservation commits. A duplicate is never permission to resend. */
  async beginPlatformUsage(event: Readonly<PlatformCaptchaBegin>): Promise<void> {
    validateBegin(event)
    try {
      await tx(async (client) => {
        await client.query("SET LOCAL statement_timeout = '3000ms'")
        await client.query("SET LOCAL lock_timeout = '2500ms'")
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('literature-captcha-budget-v1', 0))",
        )
        const counts = await client.query<{
          global_count: number
          user_count: number
          operation_count: number
        }>(
          `WITH boundary AS (SELECT date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start)
           SELECT COUNT(*) FILTER (WHERE created_at >= boundary.start)::int AS global_count,
                  COUNT(*) FILTER (WHERE user_id = $1 AND created_at >= boundary.start)::int AS user_count,
                  COUNT(*) FILTER (WHERE user_id = $1 AND operation_key = $2)::int AS operation_count
             FROM literature_captcha_requests CROSS JOIN boundary
            WHERE created_at >= boundary.start OR (user_id = $1 AND operation_key = $2)`,
          [this.userId, this.operationKey],
        )
        const count = counts.rows[0]!
        if (
          count.global_count >= this.limits.globalDaily ||
          count.user_count >= this.limits.userDaily ||
          count.operation_count >= this.limits.operationTotal
        )
          throw new LiteratureError('RATE_LIMITED')
        const inserted = await client.query(
          `INSERT INTO literature_captcha_requests (request_id, user_id, operation_key, provider, model)
           VALUES ($1::uuid, $2, $3, $4, $5) ON CONFLICT (request_id) DO NOTHING RETURNING request_id`,
          [event.requestId, this.userId, this.operationKey, event.provider, event.model],
        )
        if (inserted.rowCount !== 1) throw new LiteratureError('RATE_LIMITED')
      }, this.pool)
    } catch (error) {
      if (error instanceof LiteratureError) throw error
      throw new LiteratureError('MODEL_UNAVAILABLE')
    }
  }
  /** Fill an existing reservation only. Unknown usage remains NULL, never an invented zero. */
  async recordPlatformUsage(event: Readonly<PlatformCaptchaUsage>): Promise<void> {
    validateBegin(event)
    const usage = tokens(event)
    try {
      await tx(async (client) => {
        await client.query("SET LOCAL statement_timeout = '3000ms'")
        await client.query("SET LOCAL lock_timeout = '2500ms'")
        const selected = await client.query<UsageRow>(
          `SELECT provider, model, outcome, input_tokens, output_tokens, cache_read_tokens,
                  cache_write_tokens, thought_tokens, total_tokens
             FROM literature_captcha_requests
            WHERE request_id = $1::uuid AND user_id = $2 AND operation_key = $3 FOR UPDATE`,
          [event.requestId, this.userId, this.operationKey],
        )
        const row = selected.rows[0]
        if (!row || row.provider !== event.provider || row.model !== event.model)
          throw new LiteratureError('NOT_FOUND')
        if (row.outcome !== null) {
          const prior = [
            row.input_tokens,
            row.output_tokens,
            row.cache_read_tokens,
            row.cache_write_tokens,
            row.thought_tokens,
            row.total_tokens,
          ]
          if (row.outcome !== event.outcome || prior.some((value, i) => value !== usage[i]))
            throw new LiteratureError('RESPONSE_INVALID')
          return
        }
        const updated = await client.query(
          `UPDATE literature_captcha_requests
              SET outcome = $6, finished_at = NOW(), input_tokens = $7, output_tokens = $8,
                  cache_read_tokens = $9, cache_write_tokens = $10, thought_tokens = $11, total_tokens = $12
            WHERE request_id = $1::uuid AND user_id = $2 AND operation_key = $3
              AND provider = $4 AND model = $5 AND outcome IS NULL`,
          [
            event.requestId,
            this.userId,
            this.operationKey,
            event.provider,
            event.model,
            event.outcome,
            ...usage,
          ],
        )
        if (updated.rowCount !== 1) throw new LiteratureError('RESPONSE_INVALID')
      }, this.pool)
    } catch (error) {
      if (error instanceof LiteratureError) throw error
      throw new LiteratureError('MODEL_UNAVAILABLE')
    }
  }
}
