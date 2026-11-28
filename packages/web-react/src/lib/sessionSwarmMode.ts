/**
 * OCV5-837 / OCV5-927 蜂群模式持久化（undefined=未显式设置，"1"=开，"0"=关）：
 *  - 单会话键 `oc_v5_swarm_mode:<sessionId>`：会话内显式切换或自动回退结果，优先级最高。
 *  - 账号级默认键 `oc_v5_swarm_mode_default:<userId>`：用户显式选择的协作模式本地镜像，
 *    供草稿刷新、新建对话及 `/api/me/preferences` 水合前首帧即时恢复；严格按 userId 隔离，
 *    避免同浏览器切换账号串用高消耗模式。
 */
const PREFIX = "oc_v5_swarm_mode:";
const EVT = "oc:swarm-mode";
const DEFAULT_PREFIX = "oc_v5_swarm_mode_default:";
const DEFAULT_EVT = "oc:swarm-mode-default";

export function swarmModeSessionKey(sessionId: string): string {
  return `${PREFIX}${sessionId}`;
}

export function swarmModeDefaultKey(userId: string): string {
  return `${DEFAULT_PREFIX}${userId}`;
}

function readStorageFlag(key: string): boolean | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw === "1" ? true : raw === "0" ? false : undefined;
  } catch {
    return undefined;
  }
}

function writeStorageFlag(key: string, enabled: boolean | undefined): boolean {
  try {
    if (enabled === true) localStorage.setItem(key, "1");
    else if (enabled === false) localStorage.setItem(key, "0");
    else localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function readSessionSwarmMode(sessionId: string | undefined): boolean | undefined {
  if (!sessionId) return undefined;
  return readStorageFlag(PREFIX + sessionId);
}

export function writeSessionSwarmMode(sessionId: string | undefined, enabled: boolean | undefined): void {
  if (!sessionId) return;
  writeStorageFlag(PREFIX + sessionId, enabled);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVT, { detail: { sessionId, enabled } }));
  }
}

export function clearSessionSwarmMode(sessionId: string | undefined): void {
  writeSessionSwarmMode(sessionId, undefined);
}

export function readDefaultSwarmMode(userId: string | undefined): boolean | undefined {
  if (!userId) return undefined;
  return readStorageFlag(DEFAULT_PREFIX + userId);
}

export function writeDefaultSwarmMode(userId: string | undefined, enabled: boolean | undefined): void {
  if (!userId) return;
  writeStorageFlag(DEFAULT_PREFIX + userId, enabled);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DEFAULT_EVT, { detail: { userId, enabled } }));
  }
}

function subscribeStorageFlag(
  storageKey: string,
  eventName: string,
  id: string,
  detailKey: "sessionId" | "userId",
  onChange: (enabled: boolean | undefined) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === null) onChange(undefined);
    else if (e.key === storageKey) onChange(e.newValue === "1" ? true : e.newValue === "0" ? false : undefined);
  };
  const onLocal = (e: Event) => {
    const d = (e as CustomEvent<Record<string, unknown>>).detail;
    if (d?.[detailKey] === id) onChange(d.enabled as boolean | undefined);
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(eventName, onLocal);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(eventName, onLocal);
  };
}

export function subscribeSessionSwarmMode(
  sessionId: string | undefined,
  onChange: (enabled: boolean | undefined) => void,
): () => void {
  if (!sessionId) return () => {};
  return subscribeStorageFlag(PREFIX + sessionId, EVT, sessionId, "sessionId", onChange);
}

export function subscribeDefaultSwarmMode(
  userId: string | undefined,
  onChange: (enabled: boolean | undefined) => void,
): () => void {
  if (!userId) return () => {};
  return subscribeStorageFlag(DEFAULT_PREFIX + userId, DEFAULT_EVT, userId, "userId", onChange);
}
