import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchInflightDelegatesResult,
  isTerminalDelegateState,
  mergeInflightWithTimeline,
  type InflightDelegateItem,
} from "../lib/chat/inflightDelegates";
import type { ChatMessage } from "../lib/chat/model";
import { activeBackgroundDelegateJobIds } from "../lib/chat/backgroundDelegates";
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
 * non-terminal, backing off to 60s on read failure without discarding the last
 * confirmed snapshot. A first 404 stops polling (flag-off / missing route).
 */
export function useInflightDelegates(opts: {
  sessionId: string | null;
  messages: ChatMessage[];
  enabled: boolean;
  auth: AuthSession | null;
}): { items: InflightDelegateItem[]; controlItems: InflightDelegateItem[]; degraded: boolean; dismiss: (jobId: string) => void } {
  const { sessionId, messages, enabled, auth } = opts;
  const [rawItems, setRawItems] = useState<InflightDelegateItem[] | null>(null);
  const [failures, setFailures] = useState(0);
  const [dismissed, setDismissed] = useState<Set<string>>(() => readDismissedDelegates(sessionId));
  const [seenSessionId, setSeenSessionId] = useState(sessionId);
  if (sessionId !== seenSessionId) {
    setSeenSessionId(sessionId);
    setRawItems(null);
    setFailures(0);
    setDismissed(readDismissedDelegates(sessionId));
  }
  const notFoundRef = useRef(new Set<string>());
  /** jobIds this tab observed non-terminal; their terminal row is always shown until dismissed. */
  const seenLiveRef = useRef(new Set<string>());
  const authRef = useRef(auth);
  authRef.current = auth;
  const genRef = useRef(0);
  const discoveredBackgroundRef = useRef(new Set<string>());

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
    if (notFoundRef.current.has(sid)) return;
    const result = await fetchInflightDelegatesResult(sid, a);
    if (genRef.current !== myGen) return;
    if (result.ok) {
      for (const item of result.items) {
        if (!isTerminalDelegateState(item.state)) seenLiveRef.current.add(item.jobId);
      }
      setRawItems((previous) => {
        // Terminal job state is irreversible. Preserve only explicit background
        // terminals when a bounded later snapshot omits them (or an older read
        // still says running), so their old tool receipts cannot revive Stop.
        const settled = previous?.filter((item) => item.background === true && isTerminalDelegateState(item.state));
        if (!settled?.length) return result.items;
        const latest = new Map(result.items.map((item) => [item.jobId, item]));
        for (const item of settled) {
          const fresh = latest.get(item.jobId);
          if (!fresh || !isTerminalDelegateState(fresh.state)) latest.set(item.jobId, item);
        }
        return [...latest.values()];
      });
      setFailures(0);
      return;
    }
    if (result.notFound) notFoundRef.current.add(sid);
    setFailures((n) => Math.min(n + 1, 2));
  }, []);

  useEffect(() => {
    if (!enabled || !sessionId || !auth) {
      genRef.current += 1;
      setRawItems(null);
      setFailures(0);
      setDismissed(new Set());
      return;
    }
    const myGen = ++genRef.current;
    setRawItems(null);
    setFailures(0);
    // 会话内已「知道了」的终态项从 sessionStorage 回灌(H-14),不再随重挂载清零。
    setDismissed(readDismissedDelegates(sessionId));
    seenLiveRef.current = new Set();
    discoveredBackgroundRef.current = new Set();
    void pull(sessionId, myGen);
    return () => {
      genRef.current += 1;
    };
  }, [enabled, sessionId, auth, pull]);

  // A receipt can arrive after the session-entry snapshot was empty, before
  // any runner/progress exists. Keep reading that exact job until the server
  // proves its terminal; missing progress is not evidence that it finished.
  const backgroundKey = activeBackgroundDelegateJobIds(rawItems ?? [], messages).sort().join("\0");
  const snapshotReady = rawItems !== null;
  const routeMissing = !!sessionId && notFoundRef.current.has(sessionId);
  useEffect(() => {
    if (!enabled || !sessionId || !auth || !backgroundKey || (!snapshotReady && !routeMissing)) return;
    const fresh = backgroundKey.split("\0").filter((id) => !discoveredBackgroundRef.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) discoveredBackgroundRef.current.add(id);
    // Only explicit new background evidence can retry an earlier missing route.
    notFoundRef.current.delete(sessionId);
    void pull(sessionId, genRef.current);
  }, [backgroundKey, snapshotReady, routeMissing, enabled, sessionId, auth, pull]);

  const shouldPoll =
    !!enabled &&
    !!sessionId &&
    !!auth &&
    !routeMissing &&
    (failures > 0 || !!backgroundKey || rawItems?.some((item) => !isTerminalDelegateState(item.state)));

  useEffect(() => {
    if (!shouldPoll || !sessionId) return;
    const myGen = genRef.current;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void pull(sessionId, myGen);
    }, POLL_MS * 2 ** failures);
    // 回到前台立刻拉一次(H-15):隐藏期跳过的轮询不必再等下一个 15s。
    const onVisible = () => {
      if (document.visibilityState === "visible") void pull(sessionId, myGen);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [shouldPoll, sessionId, pull, failures]);

  // Controls need every authoritative terminal, including rows hidden by HUD
  // dismissal/recency. Presentation cannot remove evidence that a job finished.
  const controlItems = useMemo(() => rawItems ?? [], [rawItems]);
  const items = useMemo(() => {
    return filterVisibleInflightItems(mergeInflightWithTimeline(controlItems, messages), {
      dismissed,
      seenLive: seenLiveRef.current,
      now: Date.now(),
    });
  }, [controlItems, messages, dismissed]);

  return { items, controlItems, degraded: failures > 0, dismiss };
}
