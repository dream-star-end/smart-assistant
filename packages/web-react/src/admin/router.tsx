import { useMemo, useSyncExternalStore } from "react";
import { adminTabKeys } from "./registry";

/**
 * 管理后台 hash 路由（与旧 vanilla admin 深链兼容）。
 *
 * 形态：`#tab=NAME&k=v&k2=v2`。
 *  - tab 名字符类 [A-Za-z0-9_]（历史 bug：旧 `[a-z]+` 对 modelGrants/accountGroups 这类
 *    含大写的 tab 永不匹配、无声回落 dashboard）；白名单 adminTabKeys 是最终裁决。
 *  - 非法 / 缺失 tab → 回落 dashboard。
 *  - 单一权威 = window.location.hash；useSyncExternalStore 订阅 hashchange，多处消费不 tear。
 */

/** 解析结果里的参数恒为字符串（URLSearchParams 解码后）。 */
export type AdminRouteParams = Record<string, string>;
/** 写入 hash 时可传数字/布尔/空值（空/undefined/null 会被跳过）。 */
export type AdminRouteParamsInput = Record<string, string | number | boolean | null | undefined>;

const DEFAULT_TAB = "dashboard";

/** 解析 hash → { tab, params }。纯函数，供路由与测试直接消费。 */
export function parseAdminHash(hash: string): { tab: string; params: AdminRouteParams } {
  const m = /#tab=([A-Za-z0-9_]+)(?:&(.+))?$/.exec(hash);
  const raw = m?.[1];
  const tab = raw && adminTabKeys.has(raw) ? raw : DEFAULT_TAB;
  const params: AdminRouteParams = {};
  if (m?.[2]) {
    for (const [k, v] of new URLSearchParams(m[2]).entries()) params[k] = v;
  }
  return { tab, params };
}

/** 组装 hash 串（省略空/undefined 参数）。纯函数，供 navigate 与测试消费。 */
export function buildAdminHash(tab: string, params?: AdminRouteParamsInput | null): string {
  let hash = `#tab=${tab}`;
  if (params) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      sp.set(k, String(v));
    }
    const qs = sp.toString();
    if (qs) hash += `&${qs}`;
  }
  return hash;
}

/** 导航到某 tab（写 location.hash → 触发 hashchange → 所有 useAdminRoute 同步更新）。 */
export function navigateAdmin(tab: string, params?: AdminRouteParamsInput | null): void {
  const next = buildAdminHash(tab, params);
  if (window.location.hash === next) return;
  window.location.hash = next;
}

function subscribe(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}
function getSnapshot(): string {
  return window.location.hash;
}

export type UseAdminRoute = {
  tab: string;
  params: AdminRouteParams;
  navigate: (tab: string, params?: AdminRouteParamsInput | null) => void;
};

/** 当前路由 + 稳定的 navigate。非法 tab 已在 parse 阶段回落 dashboard。 */
export function useAdminRoute(): UseAdminRoute {
  // SSR 快照给空串（parse 后回落 dashboard）；客户端读真实 hash。
  const hash = useSyncExternalStore(subscribe, getSnapshot, () => "");
  const { tab, params } = useMemo(() => parseAdminHash(hash), [hash]);
  return { tab, params, navigate: navigateAdmin };
}
