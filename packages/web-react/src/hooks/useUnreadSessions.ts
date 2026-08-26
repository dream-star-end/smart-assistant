import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { resolveSessionStatus } from "../lib/sessionStatus";
import type { AuthSession } from "../lib/types";

const TERMINAL_OUTCOMES = new Set([
  "completed",
  "interrupted",
  "crashed",
  "not_accepted",
  "executed_error",
]);

export function unreadSessionsStorageKey(userId: string | null): string {
  return `oc_v5_unread_sessions:${userId || "anon"}`;
}

export function unreadNotifyStorageKey(userId: string | null): string {
  return `oc_v5_unread_notify:${userId || "anon"}`;
}

export type UnreadSessionInput = {
  id: string;
  title: string;
  runState?: string;
  lastOutcome?: string | null;
  lastErrorCode?: string | null;
  unread?: boolean;
};

export type UnreadState = {
  unreadIds: Set<string>;
  markRead: (sessionId: string) => void;
  markAllRead: () => void;
  notifyPermission: NotificationPermission | "unsupported";
  notifyEnabled: boolean;
  setNotifyEnabled: (on: boolean) => Promise<void>;
};

type Snap = {
  runState?: string;
  lastOutcome?: string | null;
  lastErrorCode?: string | null;
};

function notificationSupported(): boolean {
  return typeof Notification !== "undefined";
}

function readPermission(): NotificationPermission | "unsupported" {
  if (!notificationSupported()) return "unsupported";
  try {
    return Notification.permission;
  } catch {
    return "unsupported";
  }
}

function clearLegacyUnread(userId: string | null): void {
  try {
    localStorage.removeItem(unreadSessionsStorageKey(userId));
  } catch {
    /* private mode */
  }
}

function readNotifyEnabled(userId: string | null): boolean {
  try {
    return localStorage.getItem(unreadNotifyStorageKey(userId)) === "1";
  } catch {
    return false;
  }
}

function writeNotifyEnabled(userId: string | null, on: boolean): void {
  try {
    localStorage.setItem(unreadNotifyStorageKey(userId), on ? "1" : "0");
  } catch {
    /* private mode / quota */
  }
}

function isRunning(runState?: string): boolean {
  return runState === "running";
}

function terminalOutcome(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return TERMINAL_OUTCOMES.has(v) ? v : null;
}

function becameTerminal(prev: Snap, curr: UnreadSessionInput): boolean {
  if (isRunning(prev.runState) && !isRunning(curr.runState)) return true;
  const next = terminalOutcome(curr.lastOutcome);
  return Boolean(next && next !== terminalOutcome(prev.lastOutcome));
}

function notifyBody(session: UnreadSessionInput): string {
  const kind = resolveSessionStatus({
    running: isRunning(session.runState),
    lastOutcome: session.lastOutcome,
    lastErrorCode: session.lastErrorCode,
  });
  if (kind === "error" || kind === "interrupted" || kind === "service_restart") return "出错";
  if (session.lastErrorCode) return "出错";
  return "已完成";
}

function fireNotification(session: UnreadSessionInput): void {
  if (!notificationSupported()) return;
  try {
    if (Notification.permission !== "granted") return;
    const n = new Notification(session.title || "会话", { body: notifyBody(session) });
    n.onclick = () => {
      n.close();
    };
  } catch {
    /* 权限竞态 / 浏览器策略 */
  }
}

function shouldMarkActiveRead(session: UnreadSessionInput | undefined): boolean {
  if (!session) return true;
  // 还在跑就盖水位，terminal_at 会晚于 last_read_at，刷新后又绿。
  return !isRunning(session.runState);
}

/**
 * 侧栏未读：服务端 `unread` 为权威；本地 Set 只做乐观更新。
 * 打开已终态会话才 POST mark-read；running 等到本 tab 看到终态再盖。
 * 旧 localStorage 未读 key 只删除、不回填服务端。
 */
export function useUnreadSessions(args: {
  sessions: UnreadSessionInput[];
  activeId: string | null;
  userId: string | null;
  auth?: AuthSession | null;
}): UnreadState {
  const { sessions, activeId, userId, auth } = args;

  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => new Set());
  const [notifyPermission, setNotifyPermission] = useState<NotificationPermission | "unsupported">(
    readPermission,
  );
  const [notifyEnabled, setNotifyEnabledState] = useState(
    () => readPermission() === "granted" && readNotifyEnabled(userId),
  );

  const prevRef = useRef<Map<string, Snap> | null>(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const notifyEnabledRef = useRef(notifyEnabled);
  notifyEnabledRef.current = notifyEnabled;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const authRef = useRef(auth ?? null);
  authRef.current = auth ?? null;
  const optimisticReadRef = useRef(new Set<string>());
  const optimisticUnreadRef = useRef(new Set<string>());

  const rebuildUnread = useCallback((list: UnreadSessionInput[]) => {
    const next = new Set<string>();
    for (const s of list) {
      if (optimisticReadRef.current.has(s.id)) continue;
      if (s.unread === true || optimisticUnreadRef.current.has(s.id)) next.add(s.id);
    }
    for (const id of optimisticUnreadRef.current) {
      if (!optimisticReadRef.current.has(id)) next.add(id);
    }
    for (const s of list) {
      if (s.unread === false) optimisticReadRef.current.delete(s.id);
    }
    setUnreadIds(next);
  }, []);

  useEffect(() => {
    optimisticReadRef.current = new Set();
    optimisticUnreadRef.current = new Set();
    prevRef.current = null;
    setUnreadIds(new Set());
    clearLegacyUnread(userId);
    const perm = readPermission();
    setNotifyPermission(perm);
    setNotifyEnabledState(perm === "granted" && readNotifyEnabled(userId));
  }, [userId]);

  const markRead = useCallback((sessionId: string) => {
    // Streaming/session-list refreshes can re-run the sessions effect many times
    // before the server's unread=false projection comes back. One optimistic
    // barrier must correspond to at most one in-flight POST, otherwise a long
    // turn creates an unbounded /read request storm.
    if (optimisticReadRef.current.has(sessionId)) return;
    optimisticReadRef.current.add(sessionId);
    optimisticUnreadRef.current.delete(sessionId);
    setUnreadIds((cur) => {
      if (!cur.has(sessionId)) return cur;
      const next = new Set(cur);
      next.delete(sessionId);
      return next;
    });
    const a = authRef.current;
    if (!a) return;
    void api.markSessionRead(a, sessionId).catch(() => {
      optimisticReadRef.current.delete(sessionId);
      setUnreadIds((cur) => {
        if (cur.has(sessionId)) return cur;
        const next = new Set(cur);
        next.add(sessionId);
        return next;
      });
    });
  }, []);

  const markAllRead = useCallback(() => {
    setUnreadIds((cur) => {
      for (const id of cur) optimisticReadRef.current.add(id);
      optimisticUnreadRef.current.clear();
      if (cur.size === 0) return cur;
      return new Set<string>();
    });
    const a = authRef.current;
    if (!a) return;
    void api.markAllSessionsRead(a).catch(() => {
      /* 下次 list 刷新盖回 */
    });
  }, []);

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  useEffect(() => {
    if (!activeId) return;
    const row = sessionsRef.current.find((s) => s.id === activeId);
    if (!shouldMarkActiveRead(row)) return;
    markRead(activeId);
  }, [activeId, markRead]);

  useEffect(() => {
    const prev = prevRef.current;
    const nextSnap = new Map<string, Snap>();
    for (const s of sessions) {
      nextSnap.set(s.id, {
        runState: s.runState,
        lastOutcome: s.lastOutcome,
        lastErrorCode: s.lastErrorCode,
      });
    }

    if (prev) {
      const toMark: UnreadSessionInput[] = [];
      for (const s of sessions) {
        const p = prev.get(s.id);
        if (!p || !becameTerminal(p, s)) continue;
        toMark.push(s);
      }
      if (toMark.length > 0) {
        for (const s of toMark) {
          if (s.id === activeIdRef.current) {
            // 打开时若已 stamp 过，必须让终态后再 POST，否则水位早于 terminal_at。
            optimisticReadRef.current.delete(s.id);
            markRead(s.id);
            continue;
          }
          // 新终态盖掉旧的乐观已读屏障,否则 mark-read/mark-all 之后、
          // 首次 unread=false 刷新前的后台终态会被永久隐藏。
          optimisticReadRef.current.delete(s.id);
          optimisticUnreadRef.current.add(s.id);
        }
        for (const s of toMark) {
          const viewing =
            typeof document !== "undefined" && !document.hidden && s.id === activeIdRef.current;
          if (notifyEnabledRef.current && !viewing) fireNotification(s);
        }
      }
    }

    const active = activeIdRef.current;
    if (active) {
      const row = sessions.find((s) => s.id === active);
      if (row?.unread === true && shouldMarkActiveRead(row)) markRead(active);
    }

    rebuildUnread(sessions);
    prevRef.current = nextSnap;
  }, [sessions, markRead, rebuildUnread]);

  const setNotifyEnabled = useCallback(async (on: boolean) => {
    if (!on) {
      setNotifyEnabledState(false);
      writeNotifyEnabled(userIdRef.current, false);
      setNotifyPermission(readPermission());
      return;
    }
    if (!notificationSupported()) {
      setNotifyPermission("unsupported");
      setNotifyEnabledState(false);
      writeNotifyEnabled(userIdRef.current, false);
      return;
    }
    let perm: NotificationPermission = Notification.permission;
    try {
      perm = await Notification.requestPermission();
    } catch {
      perm = Notification.permission;
    }
    setNotifyPermission(perm);
    const enabled = perm === "granted";
    setNotifyEnabledState(enabled);
    writeNotifyEnabled(userIdRef.current, enabled);
  }, []);

  return {
    unreadIds,
    markRead,
    markAllRead,
    notifyPermission,
    notifyEnabled,
    setNotifyEnabled,
  };
}
