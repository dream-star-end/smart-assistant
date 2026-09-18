import type { SubscribeIntent } from './chat/pure'

export type { SubscribeIntent }

/**
 * 订阅弹窗的「预选意图 / 最近已付费」模块级状态。
 *
 * why 独立成 lib:红卡(components/chat/cards)在时间线首屏同步渲染,此前从
 * components/settings/SubscriptionDialog 取这两个小函数,顺带把整个订阅弹窗 + 虎皮椒支付入口
 * (≈4.6KB gzip)钉进入口静态闭包(2026-09-17 first-screen-budget 超限修复)。状态只此一份,
 * SubscriptionDialog / AccountTab / 红卡都从这里读写(SubscriptionDialog 仍 re-export 供旧引用)。
 */
let pendingSubscribeIntent: SubscribeIntent | null = null
let knownSubscriptionPaid: boolean | null = null

/** 红卡/账户条在打开订阅弹窗前预选 Lite 或加量包。 */
export function requestSubscribeIntent(intent: SubscribeIntent): void {
  pendingSubscribeIntent = intent
}

export function consumeSubscribeIntent(): SubscribeIntent | null {
  const intent = pendingSubscribeIntent
  pendingSubscribeIntent = null
  return intent
}

export function rememberSubscriptionPaid(paid: boolean): void {
  knownSubscriptionPaid = paid
}

export function lastKnownSubscriptionPaid(): boolean | null {
  return knownSubscriptionPaid
}

export function resetSubscribeUiState(): void {
  pendingSubscribeIntent = null
  knownSubscriptionPaid = null
}
