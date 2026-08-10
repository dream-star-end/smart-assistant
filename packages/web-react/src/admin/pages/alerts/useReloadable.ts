import { type DependencyList, useCallback, useEffect, useRef, useState } from "react";

export type Reloadable<T> = {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** 手动重拉(废弃在飞的旧请求结果,避免竞态)。 */
  reload: () => void;
};

/**
 * 首载 + 手动/依赖重拉 的只读数据 hook(告警各子区共用)。
 *
 * 缺省保持「首载 + 手动刷新」；当前行动队列可显式传 intervalMs，并只在页面可见时轮询。
 * deps 变化(如切换过滤)自动重拉并废弃在飞旧结果。fetcher 经 ref 取最新，调用方无需
 * useCallback。
 */
export function useReloadable<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList = [],
  options: { intervalMs?: number } = {},
): Reloadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const seq = useRef(0);
  const aliveRef = useRef(true);

  const load = useCallback(() => {
    const my = ++seq.current;
    setLoading(true);
    fetcherRef
      .current()
      .then((d) => {
        if (!aliveRef.current || my !== seq.current) return;
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (!aliveRef.current || my !== seq.current) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (aliveRef.current && my === seq.current) setLoading(false);
      });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 这是自定义数据 hook，调用方 deps 是显式刷新契约；load 本身稳定。
  useEffect(() => {
    aliveRef.current = true;
    load();
    const intervalMs = options.intervalMs ?? 0;
    const timer = intervalMs > 0
      ? window.setInterval(() => {
          if (document.visibilityState !== "hidden") load();
        }, intervalMs)
      : undefined;
    return () => {
      aliveRef.current = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
    // load 稳定;deps 变化重拉(废弃在飞)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, options.intervalMs]);

  return { data, error, loading, reload: load };
}
