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
  /** 动作桶 → 插件卡片上显示的名字(「今日已用 / 上限」)。没有名字的桶不显示。 */
  labels?: Readonly<Record<string, string>>
}

/** 插件卡片上的「今日已用 / 上限」(北京时间自然日)。只读,不扣额度。 */
export interface ManagedPluginWriteDailyUsage {
  /** 北京时间 YYYY-MM-DD。 */
  day: string
  /** Redis 读失败时为 false:前端显示「暂不可用」,used 一律 0(不猜)。 */
  available: boolean
  buckets: Array<{ bucket: string; label: string; used: number; cap: number }>
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

const USAGE_SCRIPT = `
local out = {}
for i = 1, #KEYS do out[i] = redis.call('GET', KEYS[i]) or '0' end
return out
`

function capKey(slug: string, connectionId: string, bucket: string, now: number): string {
  return `plugins:write-daily:${slug}:${connectionId}:${bucket}:${beijingDay(now)}`
}

/**
 * 读出今日各桶已用次数(只读)。策略为 null 时返回 null(不碰 Redis);只列出有名字的桶,顺序按
 * `labels` 的声明顺序。Redis 缺失、出错或应答异常时 available=false。
 */
export async function readManagedPluginWriteDailyUsage(input: {
  redis: PluginLeaseRedis | null | undefined
  policy: ManagedPluginWriteDailyCapPolicy | null
  slug: string
  connectionId: string
  now: number
}): Promise<ManagedPluginWriteDailyUsage | null> {
  const { policy } = input
  if (policy === null) return null
  const raw = beijingDay(input.now)
  const day = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  const shown = Object.entries(policy.labels ?? {}).filter(([bucket]) =>
    Number.isInteger(policy.caps[bucket]),
  )
  const empty = (available: boolean) => ({
    day,
    available,
    buckets: shown.map(([bucket, label]) => ({
      bucket,
      label,
      used: 0,
      cap: policy.caps[bucket]!,
    })),
  })
  if (shown.length === 0) return empty(true)
  if (!input.redis) return empty(false)
  let reply: unknown
  try {
    reply = await input.redis.eval(
      USAGE_SCRIPT,
      shown.length,
      ...shown.map(([bucket]) => capKey(input.slug, input.connectionId, bucket, input.now)),
    )
  } catch {
    return empty(false)
  }
  if (!Array.isArray(reply) || reply.length !== shown.length) return empty(false)
  const used = reply.map((value) => Number(value))
  if (used.some((n) => !Number.isSafeInteger(n) || n < 0)) return empty(false)
  return {
    day,
    available: true,
    buckets: shown.map(([bucket, label], index) => ({
      bucket,
      label,
      used: Math.min(used[index]!, policy.caps[bucket]!),
      cap: policy.caps[bucket]!,
    })),
  }
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
  const key = capKey(input.slug, input.connectionId, bucket, input.now)
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
