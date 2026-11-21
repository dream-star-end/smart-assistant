/** OCV5-837 蜂群模式会话级持久化（undefined=未显式设置，"1"=开，"0"=关）。 */
const PREFIX = "oc_v5_swarm_mode:";
const EVT = "oc:swarm-mode";

export function swarmModeSessionKey(sessionId: string): string {
  return `${PREFIX}${sessionId}`;
}

export function readSessionSwarmMode(sessionId: string | undefined): boolean | undefined {
  if (!sessionId) return undefined;
  try {
    const raw = localStorage.getItem(PREFIX + sessionId);
    return raw === "1" ? true : raw === "0" ? false : undefined;
  } catch {
    return undefined;
  }
}

export function writeSessionSwarmMode(sessionId: string | undefined, enabled: boolean | undefined): void {
  if (!sessionId) return;
  try {
    if (enabled === true) localStorage.setItem(PREFIX + sessionId, "1");
    else if (enabled === false) localStorage.setItem(PREFIX + sessionId, "0");
    else localStorage.removeItem(PREFIX + sessionId);
  } catch {}
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVT, { detail: { sessionId, enabled } }));
  }
}

export function clearSessionSwarmMode(sessionId: string | undefined): void {
  writeSessionSwarmMode(sessionId, undefined);
}

export function subscribeSessionSwarmMode(
  sessionId: string | undefined,
  onChange: (enabled: boolean | undefined) => void,
): () => void {
  if (!sessionId || typeof window === "undefined") return () => {};
  const key = PREFIX + sessionId;
  const onStorage = (e: StorageEvent) => {
    if (e.key === null) onChange(undefined);
    else if (e.key === key) onChange(e.newValue === "1" ? true : e.newValue === "0" ? false : undefined);
  };
  const onLocal = (e: Event) => {
    const d = (e as CustomEvent<{ sessionId?: string; enabled?: boolean }>).detail;
    if (d?.sessionId === sessionId) onChange(d.enabled);
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(EVT, onLocal);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(EVT, onLocal);
  };
}
