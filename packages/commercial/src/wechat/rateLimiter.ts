/**
 * v3 commercial WeChat broker — 限速器 (P1 no-op stub)。
 *
 * P1 不做真实限速,只占位 interface,使 broker.ts 在 P3 切换真实实现时上层无须改造。
 *
 * P3 实施(参 docs/v3/wechat-broker-design.md §4.9):
 *   - **入站**:按 (bindingUserId, senderId) 滑动窗口,默认 60s/30 条;过载丢入 audit
 *     warn 并不进入 dispatcher。
 *   - **出站**:按 bindingUserId 滑窗 + iLink 全局 QPS 兜底;过载暂停该 binding 投递,
 *     outbox row 留在 queued 自然下次再 pick。
 *
 * 故意不在 P1 就引入 LRU/counter map — 真实选型(token bucket vs sliding log vs Redis
 * sorted-set)依赖 P3 多 broker 拓扑决定,提前抽象只会留错抽象。
 */

export interface RateLimiter {
  /** P1: 永远 true。P3: 按 (bindingUserId, senderId) 滑窗判定。 */
  checkInbound(bindingUserId: string, senderId: string | null): boolean
  /** P1: 永远 true。P3: 按 bindingUserId 滑窗 + 全局 iLink QPS 兜底。 */
  checkOutbound(bindingUserId: string): boolean
}

/** P1 永远放行的实现。broker.ts 单例就拿这个。 */
export function createNoopRateLimiter(): RateLimiter {
  return {
    checkInbound: () => true,
    checkOutbound: () => true,
  }
}
