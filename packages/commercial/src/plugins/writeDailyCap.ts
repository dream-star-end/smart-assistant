/**
 * 受管插件写操作的**按账号每日上限**(OCV5-553)。
 *
 * 策略来自 `managedPluginWriteDailyCap(slug)`(writePolicy.ts):没有声明上限的插件(当前全部现有插件)
 * 不触达 Redis、行为不变。声明了上限的插件:
 *   - 计数维度 = 账号(connectionId)× 动作桶 × 北京时间自然日(用户理解的「每天」);
 *   - 在 `executeConfirmedWrite` 内、派发围栏之前原子扣减。超限 → `WRITE_DAILY_LIMIT`,此时尚未派发,
 *     账本记 failed,不会有副作用;
 *   - Redis 未装配或出错一律拒绝(fail-closed:上限闸挂了不能放行写);
 *   - 已扣减的额度不退还(扣减之后、派发之前的失败也算一次尝试),宁可少发不多发。
 */
import type { PluginLeaseRedis } from './accountLease.js'

export interface ManagedPluginWriteDailyCapPolicy {
  /** 动作 id → 动作桶;未列出的写动作归入 `defaultBucket`。 */
  buckets: Readonly<Record<string, string>>
  defaultBucket: string
  /** 动作桶 → 每日上限(正整数)。每个桶(含 defaultBucket)都必须有上限。 */
  caps: Readonly<Record<string, number>>
}

export class PluginWriteDailyCapError extends Error {
  readonly code: 'WRITE_DAILY_LIMIT' | 'RUNTIME_UNAVAILABLE'
  constructor(code: PluginWriteDailyCapError['code'], message: string = code) {
    super(message)
    this.name = 'PluginWriteDailyCapError'
    this.code = code
  }
}

const CAP_SCRIPT = `
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
local cap = tonumber(ARGV[1])
if v >= cap then return -1 end
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) end
return n
`

const KEY_TTL_SECONDS = 48 * 3600
const BEIJING_OFFSET_MS = 8 * 3_600_000

/** 北京时间自然日 YYYYMMDD。 */
export function beijingDay(now: number): string {
  const d = new Date(now + BEIJING_OFFSET_MS)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

export function writeDailyCapBucket(
  policy: ManagedPluginWriteDailyCapPolicy,
  actionId: string,
): string {
  return policy.buckets[actionId] ?? policy.defaultBucket
}

/**
 * 按策略扣减一次。`policy === null` 直接返回(不碰 Redis)。返回扣减后的计数,便于日志。
 */
export async function consumeManagedPluginWriteDailyCap(input: {
  redis: PluginLeaseRedis | null | undefined
  policy: ManagedPluginWriteDailyCapPolicy | null
  slug: string
  connectionId: string
  actionId: string
  now: number
}): Promise<number | null> {
  const { policy } = input
  if (policy === null) return null
  const bucket = writeDailyCapBucket(policy, input.actionId)
  const cap = policy.caps[bucket]
  if (cap === undefined || !Number.isInteger(cap) || cap < 1)
    throw new PluginWriteDailyCapError(
      'RUNTIME_UNAVAILABLE',
      'Plugin write daily cap is misconfigured',
    )
  if (!input.redis)
    throw new PluginWriteDailyCapError(
      'RUNTIME_UNAVAILABLE',
      'Plugin write daily cap is unavailable',
    )
  const key = `plugins:write-daily:${input.slug}:${input.connectionId}:${bucket}:${beijingDay(input.now)}`
  let n: unknown
  try {
    n = await input.redis.eval(CAP_SCRIPT, 1, key, cap, KEY_TTL_SECONDS)
  } catch {
    throw new PluginWriteDailyCapError(
      'RUNTIME_UNAVAILABLE',
      'Plugin write daily cap is unavailable',
    )
  }
  if (n === -1)
    throw new PluginWriteDailyCapError('WRITE_DAILY_LIMIT', 'Plugin write daily cap reached')
  if (typeof n !== 'number')
    throw new PluginWriteDailyCapError(
      'RUNTIME_UNAVAILABLE',
      'Plugin write daily cap is unavailable',
    )
  return n
}
