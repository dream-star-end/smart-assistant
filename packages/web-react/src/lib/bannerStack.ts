/**
 * 输入框上方全局横幅栈的裁决(纯函数)。
 *
 * 为什么存在(shell 审计 S-06):App.tsx 把「容器休眠」「连接状态」「新版本」「发送失败」
 * 「本轮成本提醒」依次挂在同一个 `composer-safe-b` 容器里,彼此不互斥、无条数上限。
 * 断线重连 + 容器休眠 + 有新版本 + 上一条发送失败是常见组合,390×844 下横幅吃掉约 560px,
 * 对话区只剩顶部三分之一。这里把「此刻该露出哪几条」收成一处可测的判断:
 *   - 按优先级排序:阻断性 > 可恢复错误 > 提示性;
 *   - 同屏最多 MAX_VISIBLE_BANNERS 条,其余折叠成一行「还有 N 条提示」,可展开。
 * 优先级表就是产品约定,改它要改这里并改测试,不要在渲染处临时调换顺序。
 */

export type BannerKind = 'error' | 'connection' | 'dormant' | 'update' | 'cost'

/** 从高到低。error(上一条发送失败,带重试)必须恒在最上;connection 是断线真相,其次。 */
export const BANNER_PRIORITY: readonly BannerKind[] = [
  'error',
  'connection',
  'dormant',
  'update',
  'cost',
]

export const MAX_VISIBLE_BANNERS = 2

export interface BannerStackResolution {
  /** 按优先级排好、此刻要渲染的横幅。 */
  visible: BannerKind[]
  /** 被折叠起来的横幅(按优先级)。为空则不渲染折叠条。 */
  hidden: BannerKind[]
  /** 用户已展开、且条数确实超过上限:渲染「收起」而不是什么都不渲染,否则展开后再也收不回。 */
  canCollapse: boolean
}

function rank(kind: BannerKind): number {
  const i = BANNER_PRIORITY.indexOf(kind)
  return i === -1 ? BANNER_PRIORITY.length : i
}

/**
 * @param active 此刻条件成立的横幅(顺序任意、可重复)。
 * @param expanded 用户点了「展开」:全部露出,不再折叠。
 */
export function resolveBanners(
  active: readonly BannerKind[],
  expanded = false,
  max = MAX_VISIBLE_BANNERS,
): BannerStackResolution {
  const sorted = [...new Set(active)].sort((a, b) => rank(a) - rank(b))
  if (sorted.length <= max) return { visible: sorted, hidden: [], canCollapse: false }
  if (expanded) return { visible: sorted, hidden: [], canCollapse: true }
  return { visible: sorted.slice(0, max), hidden: sorted.slice(max), canCollapse: false }
}

/** 折叠条文案。 */
export function collapsedBannersLabel(hiddenCount: number): string {
  return `还有 ${hiddenCount} 条提示`
}
