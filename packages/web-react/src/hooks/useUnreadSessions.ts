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

function readLegacyUnread(userId: string | null): string[] | null {
  try {
    const raw = localStorage.getItem(unreadSessionsStorageKey(userId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
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

/**
 * 侧栏未读：服务端 `unread` 为权威；本地 Set 只做乐观更新。
 * 打开会话 POST mark-read；旧 localStorage 未读集合只合并一次。
 */
export function useUnreadSessions(args: {
  sessions: UnreadSessionInput[];
  activeId: string | null;
  userId: string | null;
  auth?: AuthSession | null;
}): UnreadState {
  const { sessions, activeId, userId, auth } = args;

  const [unreadIds, setUnreadIds] = useState<Set<string>>(
    () => new Set(readLegacyUnread(userId) ?? []),
  );
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
  const migratedRef = useRef(false);

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
    optimisticUnreadRef.current = new Set(readLegacyUnread(userId) ?? []);
    migratedRef.current = false;
    prevRef.current = null;
    setUnreadIds(new Set(optimisticUnreadRef.current));
    const perm = readPermission();
    setNotifyPermission(perm);
    setNotifyEnabledState(perm === "granted" && readNotifyEnabled(userId));
  }, [userId]);

  useEffect(() => {
    if (migratedRef.current) return;
    const a = authRef.current;
    const uid = userIdRef.current;
    const legacy = readLegacyUnread(uid);
    if (!a || legacy === null) {
      if (legacy === null) migratedRef.current = true;
      return;
    }
    migratedRef.current = true;
    if (legacy.length === 0) {
      clearLegacyUnread(uid);
      return;
    }
    for (const id of legacy) optimisticUnreadRef.current.add(id);
    void api
      .migrateUnreadSessions(a, legacy)
      .then(() => {
        clearLegacyUnread(uid);
      })
      .catch(() => {
        migratedRef.current = false;
      });
  }, [auth, userId]);

  const markRead = useCallback((sessionId: string) => {
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
        for (const s of toMark) {
          if (s.id === activeIdRef.current) {
            markRead(s.id);
            continue;
          }
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
      if (row?.unread === true) markRead(active);
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
