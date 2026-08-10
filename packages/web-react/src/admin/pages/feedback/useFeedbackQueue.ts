import { useCallback, useEffect, useRef, useState } from "react";
import { adminGet } from "../../lib/adminApi";
import type { FeedbackListResp, FeedbackRow, FeedbackStatus, FeedbackTotals } from "./types";

const PAGE_SIZE = 50;

export type FeedbackFilters = {
  status: FeedbackStatus | "";
  userId: string;
  trafficClass: string;
};

export type FeedbackQueueState = {
  rows: FeedbackRow[];
  totals: FeedbackTotals | null;
  loading: boolean;
  /** 追加下一页时的加载态（load-more 按钮）。 */
  loadingMore: boolean;
  error: Error | null;
  /** 已到末页（无更多游标）。 */
  done: boolean;
  loadMore: () => void;
  refresh: () => void;
  /** 就地把某行标记为已确认（ack 成功后无需整页重拉）。 */
  patchRow: (row: FeedbackRow) => void;
};

/**
 * 反馈队列的复合游标（created_at, id）累积分页 —— 平移旧 vanilla FEEDBACK_STATE 的
 * renderSeq/loadSeq 竞态守卫到 React：filters 变化即重置并重拉首页，loadMore 追加下一页。
 * ack 走 patchRow 就地更新，不整页重拉（保留已加载分页 + 滚动位置）。
 */
export function useFeedbackQueue(filters: FeedbackFilters): FeedbackQueueState {
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [totals, setTotals] = useState<FeedbackTotals | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [done, setDone] = useState(false);

  // 游标 + 竞态守卫：filters 变化 bump seq，废弃在飞结果。
  const cursorRef = useRef<{ createdAt: string | null; id: string | null }>({
    createdAt: null,
    id: null,
  });
  const seqRef = useRef(0);
  const fetchPage = useCallback(async (isFirst: boolean) => {
    const mySeq = seqRef.current;
    if (isFirst) {
      setLoading(true);
      setError(null);
    } else {
      setLoadingMore(true);
    }
    try {
      const resp = await adminGet<FeedbackListResp>("/feedback", {
        limit: PAGE_SIZE,
        status: filters.status || undefined,
        user_id: filters.userId || undefined,
        traffic_class: filters.trafficClass,
        before_created_at: isFirst ? undefined : cursorRef.current.createdAt,
        before_id: isFirst ? undefined : cursorRef.current.id,
      });
      if (mySeq !== seqRef.current) return; // 过期（filters 已变）
      cursorRef.current = {
        createdAt: resp.next_before_created_at,
        id: resp.next_before_id,
      };
      setDone(!resp.next_before_created_at || !resp.next_before_id);
      setRows((prev) => (isFirst ? resp.rows : [...prev, ...resp.rows]));
      setTotals(resp.totals);
    } catch (e) {
      if (mySeq !== seqRef.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (mySeq === seqRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [filters.status, filters.userId, filters.trafficClass]);

  // filters 变化 → 重置游标 + 重拉首页。
  useEffect(() => {
    seqRef.current += 1;
    cursorRef.current = { createdAt: null, id: null };
    setDone(false);
    void fetchPage(true);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (done || loadingMore || loading) return;
    void fetchPage(false);
  }, [done, loadingMore, loading, fetchPage]);

  const refresh = useCallback(() => {
    seqRef.current += 1;
    cursorRef.current = { createdAt: null, id: null };
    setDone(false);
    void fetchPage(true);
  }, [fetchPage]);

  const patchRow = useCallback((next: FeedbackRow) => {
    setRows((prev) => prev.map((r) => (r.id === next.id ? next : r)));
  }, []);

  return { rows, totals, loading, loadingMore, error, done, loadMore, refresh, patchRow };
}
