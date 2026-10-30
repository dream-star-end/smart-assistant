/**
 * 失败卡上报去重(W3)。socket 实例里已经按「会话 + 根消息 + 结果 + 路径」去重,但它只活在一个
 * 页面里:刷新、断线重连后重建实例、同一账号开多个标签页,同一张卡会再报一次。管理员数据里
 * 一张 service_restart 失败卡在 71 分钟里报了 35 次(20 条连接)。
 *
 * 这里把已报过的键记在 localStorage(同源标签页共享),24 小时内同一键只报一次。
 * localStorage 不可用(隐私模式、配额满)时照常上报:宁可多报,不能漏报。
 */
const STORAGE_KEY = "oc:problem-card-reports:v1";
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_KEYS = 300;

type Store = Pick<Storage, "getItem" | "setItem">;

function defaultStore(): Store | undefined {
  try {
    return typeof window !== "undefined" ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

/** 第一次见到这个键返回 true(应该上报),24 小时内再见返回 false。 */
export function claimProblemCardReport(key: string, now = Date.now(), store: Store | undefined = defaultStore()): boolean {
  if (!store) return true;
  try {
    const raw = store.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const seen: Record<string, number> = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, number>)
      : {};
    const at = seen[key];
    if (typeof at === "number" && now - at < TTL_MS) return false;
    const live = Object.entries(seen)
      .filter(([, ts]) => typeof ts === "number" && now - ts < TTL_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_KEYS - 1);
    store.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries([[key, now], ...live])));
    return true;
  } catch {
    return true;
  }
}

export function problemCardReportKey(p: { sessionId: string; rootCmid: string; outcome: string; path: string; code: string }): string {
  return `${p.sessionId}:${p.rootCmid}:${p.outcome}:${p.path}:${p.code}`;
}
