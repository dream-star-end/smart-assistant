import { useCallback, useEffect, useRef, useState } from "react";
import { resolveSessionStatus } from "../lib/sessionStatus";

const MAX_UNREAD = 200;
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

function readUnread(userId: string | null): Set<string> {
  try {
    const raw = localStorage.getItem(unreadSessionsStorageKey(userId));
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string").slice(-MAX_UNREAD));
  } catch {
    return new Set();
  }
}

function writeUnread(userId: string | null, ids: Set<string>): void {
  try {
    localStorage.setItem(
      unreadSessionsStorageKey(userId),
      JSON.stringify([...ids].slice(-MAX_UNREAD)),
    );
  } catch {
    /* private mode / quota */
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

function addUnread(cur: Set<string>, id: string): Set<string> {
  const arr = [...cur].filter((x) => x !== id);
  arr.push(id);
  return new Set(arr.slice(-MAX_UNREAD));
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

/**
 * 侧栏未读：运行中→终态且非当前会话则标未读；按用户持久化；桌面通知仅由用户手势开启。
 */
export function useUnreadSessions(args: {
  sessions: UnreadSessionInput[];
  activeId: string | null;
  userId: string | null;
}): UnreadState {
  const { sessions, activeId, userId } = args;

  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => readUnread(userId));
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

  useEffect(() => {
    setUnreadIds(readUnread(userId));
    const perm = readPermission();
    setNotifyPermission(perm);
    setNotifyEnabledState(perm === "granted" && readNotifyEnabled(userId));
    prevRef.current = null;
  }, [userId]);

  const persistUnread = useCallback((next: Set<string>) => {
    writeUnread(userIdRef.current, next);
  }, []);

  const markRead = useCallback(
    (sessionId: string) => {
      setUnreadIds((cur) => {
        if (!cur.has(sessionId)) return cur;
        const next = new Set(cur);
        next.delete(sessionId);
        persistUnread(next);
        return next;
      });
    },
    [persistUnread],
  );

  const markAllRead = useCallback(() => {
    setUnreadIds((cur) => {
      if (cur.size === 0) return cur;
      const next = new Set<string>();
      persistUnread(next);
      return next;
    });
  }, [persistUnread]);

  useEffect(() => {
    if (!activeId) return;
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
        setUnreadIds((cur) => {
          let next = cur;
          for (const s of toMark) {
            if (s.id === activeIdRef.current) continue;
            next = addUnread(next, s.id);
          }
          if (next === cur) return cur;
          persistUnread(next);
          return next;
        });
        for (const s of toMark) {
          const viewing =
            typeof document !== "undefined" && !document.hidden && s.id === activeIdRef.current;
          if (notifyEnabledRef.current && !viewing) fireNotification(s);
        }
      }
    }

    prevRef.current = nextSnap;
  }, [sessions, persistUnread]);

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
