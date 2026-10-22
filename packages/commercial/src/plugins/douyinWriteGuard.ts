/**
 * 抖音写操作的拟人节奏与风控冷却（OCV5-553 设计 4.4）。
 *
 * - 节奏：同一账号两次写之间的最小间隔按动作类别计：发布 10 分钟、评论 / 回复 60 秒、点赞 20 秒，
 *   每次在记录时加 ±30% 随机抖动。间隔在**派发围栏落定之后**记录（真正可能发出才算一次），到执行时
 *   还没到就以 `DOUYIN_PACING_WAIT` 结束（确定未派发，账本记 failed），不排队、不在后台自动执行。
 * - 冷却：同一账号一旦出现 `DOUYIN_UPSTREAM_CHALLENGE`（验证码 / 风控），所有写操作暂停 24 小时，
 *   到期前提案和执行都以 `DOUYIN_WRITE_COOLDOWN` 拒绝。
 * - Redis 缺失、出错或应答异常时一律拒绝（fail-closed）：节奏闸和冷却闸挂了不能放行写。
 *
 * 只用 `eval`（与账号租约、每日上限同一个 Redis 接口）。
 */
import type { PluginLeaseRedis } from './accountLease.js'

export type DouyinPacingKind = 'publish' | 'comment' | 'digg'

export const DOUYIN_WRITE_PACING_MS: Readonly<Record<DouyinPacingKind, number>> = Object.freeze({
  publish: 10 * 60_000,
  comment: 60_000,
  digg: 20_000,
})
export const DOUYIN_WRITE_PACING_JITTER = 0.3
export const DOUYIN_WRITE_COOLDOWN_MS = 24 * 3_600_000

export class DouyinWriteGuardError extends Error {
  readonly code: 'DOUYIN_PACING_WAIT' | 'DOUYIN_WRITE_COOLDOWN' | 'RUNTIME_UNAVAILABLE'
  /** 最早可执行时间（epoch ms），只在节奏 / 冷却拒绝时有。 */
  readonly notBefore: number | null
  constructor(code: DouyinWriteGuardError['code'], notBefore: number | null = null) {
    super(code)
    this.name = 'DouyinWriteGuardError'
    this.code = code
    this.notBefore = notBefore
  }
}

/** 动作 → 节奏类别。未知的写动作按最严格的发布间隔算。 */
export function douyinPacingKind(actionId: string): DouyinPacingKind {
  if (actionId === 'create_comment' || actionId === 'reply_comment') return 'comment'
  if (actionId === 'set_comment_digg') return 'digg'
  return 'publish'
}

function paceKey(connectionId: string, kind: DouyinPacingKind): string {
  return `plugins:douyin:pace:${connectionId}:${kind}`
}
function cooldownKey(connectionId: string): string {
  return `plugins:douyin:cooldown:${connectionId}`
}

const READ_SCRIPT = `
return { redis.call('GET', KEYS[1]) or '', redis.call('GET', KEYS[2]) or '' }`
/** 只往后推：已记的时间更晚时保留（不会因为一次更短的间隔把冷却 / 节奏提前）。 */
const PUSH_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local next = tonumber(ARGV[1])
if current >= next then return current end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return next`

function parseMs(value: unknown): number | null | 'invalid' {
  if (value === '' || value === null || value === undefined) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : 'invalid'
}

/**
 * 当前最早可执行时间：`cooldownUntil`（风控冷却）和 `notBefore`（节奏），已过期或没有记录时为 null。
 */
export async function readDouyinWriteGate(input: {
  redis: PluginLeaseRedis | null | undefined
  connectionId: string
  actionId: string
  now: number
}): Promise<{ notBefore: number | null; cooldownUntil: number | null }> {
  if (!input.redis) throw new DouyinWriteGuardError('RUNTIME_UNAVAILABLE')
  let reply: unknown
  try {
    reply = await input.redis.eval(
      READ_SCRIPT,
      2,
      paceKey(input.connectionId, douyinPacingKind(input.actionId)),
      cooldownKey(input.connectionId),
    )
  } catch {
    throw new DouyinWriteGuardError('RUNTIME_UNAVAILABLE')
  }
  if (!Array.isArray(reply) || reply.length !== 2)
    throw new DouyinWriteGuardError('RUNTIME_UNAVAILABLE')
  const pace = parseMs(reply[0])
  const cooldown = parseMs(reply[1])
  if (pace === 'invalid' || cooldown === 'invalid')
    throw new DouyinWriteGuardError('RUNTIME_UNAVAILABLE')
  return {
    notBefore: pace !== null && pace > input.now ? pace : null,
    cooldownUntil: cooldown !== null && cooldown > input.now ? cooldown : null,
  }
}

/** 执行前的闸：冷却中 → DOUYIN_WRITE_COOLDOWN；间隔没到 → DOUYIN_PACING_WAIT。 */
export async function assertDouyinWriteAllowed(input: {
  redis: PluginLeaseRedis | null | undefined
  connectionId: string
  actionId: string
  now: number
}): Promise<void> {
  const gate = await readDouyinWriteGate(input)
  if (gate.cooldownUntil !== null)
    throw new DouyinWriteGuardError('DOUYIN_WRITE_COOLDOWN', gate.cooldownUntil)
  if (gate.notBefore !== null) throw new DouyinWriteGuardError('DOUYIN_PACING_WAIT', gate.notBefore)
}

async function push(
  redis: PluginLeaseRedis | null | undefined,
  key: string,
  until: number,
  now: number,
): Promise<void> {
  if (!redis) throw new DouyinWriteGuardError('RUNTIME_UNAVAILABLE')
  let reply: unknown
  try {
    reply = await redis.eval(PUSH_SCRIPT, 1, key, until, Math.max(1, until - now))
  } catch {
    throw new DouyinWriteGuardError('RUNTIME_UNAVAILABLE')
  }
  if (typeof reply !== 'number') throw new DouyinWriteGuardError('RUNTIME_UNAVAILABLE')
}

/**
 * 记一次（可能）发出的写：下一次同类写最早在 now + 间隔 ×（0.7–1.3）之后。在派发围栏落定之后、
 * 真正发出之前调用；失败会让本次写停在发出之前。
 */
export async function recordDouyinWriteDispatch(input: {
  redis: PluginLeaseRedis | null | undefined
  connectionId: string
  actionId: string
  now: number
  random?: () => number
}): Promise<number> {
  const kind = douyinPacingKind(input.actionId)
  const r = Math.min(1, Math.max(0, (input.random ?? Math.random)()))
  const factor = 1 - DOUYIN_WRITE_PACING_JITTER + 2 * DOUYIN_WRITE_PACING_JITTER * r
  const until = input.now + Math.round(DOUYIN_WRITE_PACING_MS[kind] * factor)
  await push(input.redis, paceKey(input.connectionId, kind), until, input.now)
  return until
}

/** 风控熔断：该账号所有写操作暂停 24 小时。 */
export async function tripDouyinWriteCooldown(input: {
  redis: PluginLeaseRedis | null | undefined
  connectionId: string
  now: number
}): Promise<number> {
  const until = input.now + DOUYIN_WRITE_COOLDOWN_MS
  await push(input.redis, cooldownKey(input.connectionId), until, input.now)
  return until
}

/** 北京时间 HH:MM（确认卡上的「最早可在 … 执行」）。 */
export function beijingClock(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
