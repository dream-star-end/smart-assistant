/**
 * 空闲期预取懒块的网络策略(纯函数)。
 *
 * shell 审计 S-16:`prefetchLazyCentersOnIdle` 在浏览器空闲期无条件预取 8 个中心的懒块。
 * `vite.config.ts` 的首屏体积门只管静态闭包;省流量模式 / 2G 下用户仍会在后台下完全部中心。
 * 这里只回答「该不该发起预取」:Network Information API 缺席(Safari / Firefox)时照常预取,
 * 行为与改造前一致,不退化。
 */

export interface NetworkInformationLike {
  saveData?: boolean
  effectiveType?: string
}

/** 视为「慢网」的 effectiveType 取值(Network Information API 枚举)。 */
const SLOW_EFFECTIVE_TYPES: ReadonlySet<string> = new Set(['slow-2g', '2g'])

export function shouldPrefetchCenters(conn: NetworkInformationLike | null | undefined): boolean {
  if (!conn) return true
  if (conn.saveData === true) return false
  if (typeof conn.effectiveType === 'string' && SLOW_EFFECTIVE_TYPES.has(conn.effectiveType)) {
    return false
  }
  return true
}

/** 从 navigator 上读连接信息;不支持的浏览器返回 undefined(→ 照常预取)。 */
export function readNetworkInformation(
  nav: Navigator | undefined = globalThis.navigator,
): NetworkInformationLike | undefined {
  if (!nav) return undefined
  const anyNav = nav as Navigator & {
    connection?: NetworkInformationLike
    mozConnection?: NetworkInformationLike
    webkitConnection?: NetworkInformationLike
  }
  return anyNav.connection ?? anyNav.mozConnection ?? anyNav.webkitConnection ?? undefined
}
