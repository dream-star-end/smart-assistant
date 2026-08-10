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
 * 与地基 `useAdminPoll` 的区别:告警的通道/outbox/静默/规则是「首载 + 手动刷新」型
 * (对齐旧 vanilla,无 30s 自动轮询),不需要可见性暂停/定时 tick。deps 变化(如切换过滤)
 * 自动重拉并废弃在飞旧结果。fetcher 经 ref 取最新,不必调用方 useCallback。
 */
export function useReloadable<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList = [],
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

  useEffect(() => {
    aliveRef.current = true;
    load();
    return () => {
      aliveRef.current = false;
    };
    // load 稳定;deps 变化重拉(废弃在飞)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload: load };
}
