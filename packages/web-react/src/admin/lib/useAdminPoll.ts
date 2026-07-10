import { type DependencyList, useCallback, useEffect, useRef, useState } from "react";

export type UseAdminPollOptions = {
  /**
   * 轮询间隔（ms）。默认 30s（对齐旧 vanilla admin dashboard）。
   * **传 0 = 不轮询**（只首载一次;保留 deps 重拉/切回补拉/手动 refresh）——
   * 「首载+手动刷新」型页面(containers 等)用这一档,不要拿超大间隔逼近。
   */
  intervalMs?: number;
  /** 是否启用（false 时不拉取、清 loading）。用于「有筛选参数才拉」等条件。 */
  enabled?: boolean;
  /**
   * 依赖数组：变化时**废弃在飞结果 + 立即重新拉取**（等价旧版 renderSeq 重置）。
   * 把过滤/分页等参数放进来即可获得「改筛选自动重拉」；fetcher 本身可用内联闭包
   * （内部经 ref 始终取最新版本，不必 useCallback 记忆）。
   */
  deps?: DependencyList;
};

export type UseAdminPoll<T> = {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** 手动立即重拉（尊重当前 effect 的 alive 守卫；卸载后调用为 no-op）。 */
  refresh: () => void;
};

/**
 * 立即拉一次 + 定时轮询的只读数据 hook。
 *  - `document.visibilityState==='hidden'` 时暂停轮询（tick 跳过），切回可见立即补拉。
 *  - 组件卸载 / deps 变化 → alive 守卫废弃在飞结果，不 setState 到已弃实例（无竞态、无 leak）。
 *  - fetcher 经 ref 取最新，故 effect 只依赖 [enabled, intervalMs, ...deps]，稳定不抖。
 */
export function useAdminPoll<T>(
  fetcher: () => Promise<T>,
  options: UseAdminPollOptions = {},
): UseAdminPoll<T> {
  const { intervalMs = 30_000, enabled = true, deps = [] } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(enabled);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // 当前 effect 实例的 run（带自身 alive 守卫）。refresh 经它调用最新版本。
  const runRef = useRef<(() => void) | null>(null);
  const refresh = useCallback(() => runRef.current?.(), []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      runRef.current = null;
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;

    const run = async () => {
      try {
        const d = await fetcherRef.current();
        if (!alive) return;
        setData(d);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (alive) setLoading(false);
      }
    };
    runRef.current = () => void run();

    const onVisible = () => {
      // 从隐藏切回可见：立即补拉（不等下一个 tick）。
      if (document.visibilityState === "visible") void run();
    };

    setLoading(true);
    void run(); // 立即拉一次
    if (intervalMs > 0) {
      timer = setInterval(() => {
        if (document.visibilityState === "visible") void run(); // 隐藏时跳过 = 暂停
      }, intervalMs);
      document.addEventListener("visibilitychange", onVisible);
    }

    return () => {
      alive = false;
      runRef.current = null;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // fetcher 走 ref，不进依赖；deps 变化重建（废弃在飞 + 重拉）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, ...deps]);

  return { data, error, loading, refresh };
}
