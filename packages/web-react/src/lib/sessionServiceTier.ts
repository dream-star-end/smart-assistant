/**
 * OCV5-434 GPT Fast(serviceTier)的**会话级**持久化,默认关。
 *
 *  - 每个会话独立记忆,键 `oc_v5_service_tier:<sessionId>`,只存显式 `"fast"`;关 = 删键。
 *  - **没有**全局继承键:新会话永远从「标准」开始(Fast 消耗更高,不跨会话带过去)。
 *  - sessionId 为空(空会话态):只在内存里;首条消息创建会话后由 App 落地。
 *
 * 后端:serviceTier 是 inbound.message 顶层 turn 级字段;只对 protocol serviceTiers 列出的
 * 模型生效(Codex serviceTierForTurn / OpenCode Go service_tier=priority),其它模型忽略。
 */
import type { ServiceTier } from '@openclaude/protocol/browser'

const SERVICE_TIER_SESSION_PREFIX = 'oc_v5_service_tier:'

export function serviceTierSessionKey(sessionId: string): string {
  return `${SERVICE_TIER_SESSION_PREFIX}${sessionId}`
}

/** 读某会话的 Fast 选择;缺键 / 值非法 / storage 不可用 → null(标准)。 */
export function readSessionServiceTier(sessionId: string | undefined): ServiceTier | null {
  if (!sessionId) return null
  try {
    return localStorage.getItem(serviceTierSessionKey(sessionId)) === 'fast' ? 'fast' : null
  } catch {
    return null
  }
}

/** 写某会话的 Fast 选择(null = 标准 → 删键)。best-effort,失败不抛。 */
export function writeSessionServiceTier(
  sessionId: string | undefined,
  tier: ServiceTier | null,
): void {
  if (!sessionId) return
  try {
    if (tier === 'fast') localStorage.setItem(serviceTierSessionKey(sessionId), 'fast')
    else localStorage.removeItem(serviceTierSessionKey(sessionId))
  } catch {
    // Storage 只是最佳努力;写失败不影响内存状态。
  }
}
