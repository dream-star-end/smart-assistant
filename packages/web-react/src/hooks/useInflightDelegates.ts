import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchInflightDelegatesResult,
  isTerminalDelegateState,
  mergeInflightWithTimeline,
  type InflightDelegateItem,
} from "../lib/chat/inflightDelegates";
import type { ChatMessage } from "../lib/chat/model";
import type { AuthSession } from "../lib/types";

const POLL_MS = 15_000;
/**
 * Terminal rows persist server-side (≤32/session). Without a recency gate an
 * old session would pin a stale "completed" pill on open. Show a terminal item
 * only if this tab watched it run, or it settled within this window.
 */
export const TERMINAL_RECENCY_MS = 30 * 60_000;

export function filterVisibleInflightItems(
  items: InflightDelegateItem[],
  opts: { dismissed: ReadonlySet<string>; seenLive: ReadonlySet<string>; now: number },
): InflightDelegateItem[] {
  return items.filter((item) => {
    if (!isTerminalDelegateState(item.state)) return true;
    if (opts.dismissed.has(item.jobId)) return false;
    if (opts.seenLive.has(item.jobId)) return true;
    return item.updatedAt > 0 && opts.now - item.updatedAt <= TERMINAL_RECENCY_MS;
  });
}

/**
 * 「知道了」按会话持久化到 sessionStorage(H-14):刷新后 recency 窗内的终态项不再复活。
 * 只存 jobId 列表、上限 64 条;存储不可用(隐私模式 / 配额)一律静默,退化成仅内存。
 */
const DISMISSED_STORAGE_PREFIX = "oc_inflight_dismissed:";
const DISMISSED_STORAGE_CAP = 64;

function dismissedStorageKey(sessionId: string): string {
  return `${DISMISSED_STORAGE_PREFIX}${sessionId}`;
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function readDismissedDelegates(
  sessionId: string | null,
  storage: Pick<Storage, "getItem"> | null = safeSessionStorage(),
): Set<string> {
  if (!sessionId || !storage) return new Set();
  try {
    const raw = storage.getItem(dismissedStorageKey(sessionId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string" && v.length > 0));
  } catch {
    return new Set();
  }
}

export function writeDismissedDelegates(
  sessionId: string | null,
  dismissed: ReadonlySet<string>,
  storage: Pick<Storage, "setItem" | "removeItem"> | null = safeSessionStorage(),
): void {
  if (!sessionId || !storage) return;
  try {
    const key = dismissedStorageKey(sessionId);
    if (dismissed.size === 0) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify([...dismissed].slice(-DISMISSED_STORAGE_CAP)));
  } catch {
    // 静默:存储不可用时退化为仅内存。
  }
}

/**
 * Composer-pinned inflight delegate snapshot.
 *
 * Fetch once on session enter/switch. Poll every 15s while any item is
 * non-terminal. Stop on all-terminal, null, or a first 404 for that session
 * (flag-off / missing route — never retry that id in this tab).
 */
export function useInflightDelegates(opts: {
  sessionId: string | null;
  messages: ChatMessage[];
  enabled: boolean;
  auth: AuthSession | null;
}): { items: InflightDelegateItem[]; dismiss: (jobId: string) => void } {
  const { sessionId, messages, enabled, auth } = opts;
  const [rawItems, setRawItems] = useState<InflightDelegateItem[] | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissedDelegates(sessionId));
  const [seenSessionId, setSeenSessionId] = useState(sessionId);
  if (sessionId !== seenSessionId) {
    setSeenSessionId(sessionId);
    setRawItems(null);
    setDismissed(readDismissedDelegates(sessionId));
  }
  const notFoundRef = useRef(new Set<string>());
  /** jobIds this tab observed non-terminal; their terminal row is always shown until dismissed. */
  const seenLiveRef = useRef(new Set<string>());
  const authRef = useRef(auth);
  authRef.current = auth;
  const genRef = useRef(0);

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const dismiss = useCallback((jobId: string) => {
    setDismissed((prev) => {
      if (prev.has(jobId)) return prev;
      const next = new Set(prev);
      next.add(jobId);
      // 幂等写入(StrictMode 双调 updater 也安全);读回见 readDismissedDelegates。
      writeDismissedDelegates(sessionIdRef.current, next);
      return next;
    });
  }, []);

  const pull = useCallback(async (sid: string, myGen: number) => {
    const a = authRef.current;
    if (!a) return;
    if (notFoundRef.current.has(sid)) {
      if (genRef.current === myGen) setRawItems(null);
      return;
    }
    const result = await fetchInflightDelegatesResult(sid, a);
    if (genRef.current !== myGen) return;
    if (result.ok) {
      for (const item of result.items) {
        if (!isTerminalDelegateState(item.state)) seenLiveRef.current.add(item.jobId);
      }
      setRawItems(result.items);
      return;
    }
    if (result.notFound) notFoundRef.current.add(sid);
    setRawItems(null);
  }, []);

  useEffect(() => {
    if (!enabled || !sessionId || !auth) {
      genRef.current += 1;
      setRawItems(null);
      setDismissed(new Set());
      return;
    }
    const myGen = ++genRef.current;
    setRawItems(null);
    // 会话内已「知道了」的终态项从 sessionStorage 回灌(H-14),不再随重挂载清零。
    setDismissed(readDismissedDelegates(sessionId));
    seenLiveRef.current = new Set();
    void pull(sessionId, myGen);
    return () => {
      genRef.current += 1;
    };
  }, [enabled, sessionId, auth, pull]);

  const shouldPoll =
    !!enabled &&
    !!sessionId &&
    !!auth &&
    rawItems !== null &&
    rawItems.some((item) => !isTerminalDelegateState(item.state));

  useEffect(() => {
    if (!shouldPoll || !sessionId) return;
    const myGen = genRef.current;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void pull(sessionId, myGen);
    }, POLL_MS);
    // 回到前台立刻拉一次(H-15):隐藏期跳过的轮询不必再等下一个 15s。
    const onVisible = () => {
      if (document.visibilityState === "visible") void pull(sessionId, myGen);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [shouldPoll, sessionId, pull]);

  const items = useMemo(() => {
    if (!rawItems) return [];
    return filterVisibleInflightItems(mergeInflightWithTimeline(rawItems, messages), {
      dismissed,
      seenLive: seenLiveRef.current,
      now: Date.now(),
    });
  }, [rawItems, messages, dismissed]);

  return { items, dismiss };
}
