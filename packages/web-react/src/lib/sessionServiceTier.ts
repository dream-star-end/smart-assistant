/**
 * OCV5-434 / OCV5-798 GPT 速度档位（serviceTier）的**会话级**持久化，默认标准（null）。
 *
 *  - 每个会话独立记忆，键 `oc_v5_service_tier:<sessionId>`，仅存 `'fast'` 或 `'ultrafast'`；关 = 删键。
 *  - **没有**全局继承键：新会话永远从「标准」开始（高倍率消耗，不跨会话带过去）。
 *  - sessionId 为空（空会话态）：只在内存里；首条消息创建会话后由 App 落地。
 */
import { isServiceTier, type ServiceTier } from '@openclaude/protocol/browser'

const SERVICE_TIER_SESSION_PREFIX = 'oc_v5_service_tier:'

export function serviceTierSessionKey(sessionId: string): string {
  return `${SERVICE_TIER_SESSION_PREFIX}${sessionId}`
}

/** 读某会话的速度选择；缺键 / 值非法 / storage 不可用 → null（标准）。 */
export function readSessionServiceTier(sessionId: string | undefined): ServiceTier | null {
  if (!sessionId) return null
  try {
    const raw = localStorage.getItem(serviceTierSessionKey(sessionId))
    return isServiceTier(raw) ? raw : null
  } catch {
    return null
  }
}

/** 写某会话的速度选择（null = 标准 → 删键）。best-effort，失败不抛。 */
export function writeSessionServiceTier(
  sessionId: string | undefined,
  tier: ServiceTier | null,
): void {
  if (!sessionId) return
  try {
    if (isServiceTier(tier)) localStorage.setItem(serviceTierSessionKey(sessionId), tier)
    else localStorage.removeItem(serviceTierSessionKey(sessionId))
  } catch {
    // Storage 只是最佳努力；写失败不影响内存状态。
  }
}

/** 删除会话时清理遗留的速度档键，防止 localStorage 持续泄漏。best-effort，失败不抛。 */
export function clearSessionServiceTier(sessionId: string | undefined): void {
  if (!sessionId) return
  try {
    localStorage.removeItem(serviceTierSessionKey(sessionId))
  } catch {
    // best-effort
  }
}

/** 订阅同一会话在其他标签页的速度档切换（经 storage 事件实时同步）。 */
export function subscribeSessionServiceTier(
  sessionId: string | undefined,
  onChange: (tier: ServiceTier | null) => void,
): () => void {
  if (!sessionId || typeof window === 'undefined') return () => {}
  const targetKey = serviceTierSessionKey(sessionId)
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== targetKey) return
    onChange(event.key === null ? null : isServiceTier(event.newValue) ? event.newValue : null)
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
