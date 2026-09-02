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
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [seenSessionId, setSeenSessionId] = useState(sessionId);
  if (sessionId !== seenSessionId) {
    setSeenSessionId(sessionId);
    setRawItems(null);
    setDismissed(new Set());
  }
  const notFoundRef = useRef(new Set<string>());
  /** jobIds this tab observed non-terminal; their terminal row is always shown until dismissed. */
  const seenLiveRef = useRef(new Set<string>());
  const authRef = useRef(auth);
  authRef.current = auth;
  const genRef = useRef(0);

  const dismiss = useCallback((jobId: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(jobId);
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
    setDismissed(new Set());
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
    return () => window.clearInterval(timer);
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
