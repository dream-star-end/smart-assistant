/**
 * 抖音扫码「本人短信验证」的发送限频（OCV5-553 设计 4.3.C）。按平台用户计：60 秒 1 条、1 小时 3 条、
 * 1 天 5 条。三个窗口在一个 Lua 脚本里先全部检查、再一起计数，任何一个满了就整条不发。
 * Redis 缺失、出错或应答异常时一律拒绝（fail-closed）：宁可让用户稍后重试，也不多发短信触发风控。
 */
import type { PluginLeaseRedis } from './accountLease.js'

export const DOUYIN_SMS_WINDOWS = Object.freeze([
  { seconds: 60, limit: 1 },
  { seconds: 3600, limit: 3 },
  { seconds: 86_400, limit: 5 },
])

const SMS_QUOTA_SCRIPT = `
for i = 1, #KEYS do
  local used = tonumber(redis.call('GET', KEYS[i]) or '0')
  if used >= tonumber(ARGV[i * 2 - 1]) then return 0 end
end
for i = 1, #KEYS do
  if redis.call('INCR', KEYS[i]) == 1 then redis.call('EXPIRE', KEYS[i], tonumber(ARGV[i * 2])) end
end
return 1`

export type DouyinSmsQuotaResult = 'ok' | 'limited' | 'unavailable'

export function douyinSmsQuotaKeys(userId: number): string[] {
  return DOUYIN_SMS_WINDOWS.map((w) => `plugins:douyin:sms:${userId}:${w.seconds}`)
}

/** 消耗一次发送额度。只在真的要发短信（首次发送或重发）之前调用。 */
export async function consumeDouyinSmsQuota(input: {
  redis: PluginLeaseRedis | null | undefined
  userId: number
}): Promise<DouyinSmsQuotaResult> {
  if (!input.redis || !Number.isSafeInteger(input.userId) || input.userId <= 0) return 'unavailable'
  const args: number[] = []
  for (const w of DOUYIN_SMS_WINDOWS) args.push(w.limit, w.seconds)
  let reply: unknown
  try {
    reply = await input.redis.eval(
      SMS_QUOTA_SCRIPT,
      DOUYIN_SMS_WINDOWS.length,
      ...douyinSmsQuotaKeys(input.userId),
      ...args,
    )
  } catch {
    return 'unavailable'
  }
  if (reply === 1) return 'ok'
  if (reply === 0) return 'limited'
  return 'unavailable'
}
