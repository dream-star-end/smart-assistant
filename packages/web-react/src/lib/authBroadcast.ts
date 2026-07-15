/**
 * 同源 tab 的 token-free 登出信号。refresh/access token 绝不落 storage，也不经此通道传播。
 * BroadcastChannel 不可用时用一次性 localStorage 写入触发 storage event。
 */
const CHANNEL_NAME = "oc-auth";
const STORAGE_LOGOUT_KEY = "oc_auth_logout_signal";
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

type LogoutMessage = { type: "logout"; senderTabId: string; ts: number };
type Listener = () => void;

const listeners = new Set<Listener>();
let channel: BroadcastChannel | null = null;
let storageListening = false;

function dispatch(message: unknown): void {
  if (!message || typeof message !== "object") return;
  const m = message as Partial<LogoutMessage>;
  if (m.type !== "logout" || m.senderTabId === TAB_ID) return;
  for (const listener of listeners) listener();
}

function ensureChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel !== "function") return null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event) => dispatch(event.data);
  } catch {
    channel = null;
  }
  return channel;
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_LOGOUT_KEY || !event.newValue) return;
  dispatch({ type: "logout", senderTabId: "", ts: Number(event.newValue) || Date.now() });
}

export function subscribeAuthLogout(listener: Listener): () => void {
  listeners.add(listener);
  ensureChannel();
  if (!storageListening && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
    storageListening = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    if (storageListening && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
      storageListening = false;
    }
    channel?.close();
    channel = null;
  };
}

export function publishAuthLogout(): void {
  const message: LogoutMessage = { type: "logout", senderTabId: TAB_ID, ts: Date.now() };
  const active = ensureChannel();
  if (active) {
    try {
      active.postMessage(message);
      return;
    } catch {
      /* storage fallback below */
    }
  }
  try {
    localStorage.setItem(STORAGE_LOGOUT_KEY, String(message.ts));
    localStorage.removeItem(STORAGE_LOGOUT_KEY);
  } catch {
    /* best effort */
  }
}
