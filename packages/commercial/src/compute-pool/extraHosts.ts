/**
 * OCV5-860: Domain-level sinkhole for Google Clearcut telemetry (`https://play.googleapis.com/log`)
 * embedded in Antigravity CLI. Container loopback 127.0.0.1:443 refuses immediately (ECONNREFUSED)
 * with zero egress bytes, avoiding the 5s HTTP 401 retry upload storm (~210 MB/h/proc) without
 * touching shared Google Anycast VIPs used by inference (`daily-cloudcode-pa.googleapis.com`).
 */
export const ANTIGRAVITY_CLEARCUT_BLOCK_EXTRA_HOST = "play.googleapis.com:127.0.0.1";

/** Default HostConfig.ExtraHosts injected into every local managed runtime container. */
export const V3_DEFAULT_EXTRA_HOSTS: readonly string[] = Object.freeze([
  ANTIGRAVITY_CLEARCUT_BLOCK_EXTRA_HOST,
]);

function extraHostKey(entry: string): string {
  const colonIdx = entry.indexOf(":");
  if (colonIdx <= 0) return entry.toLowerCase();
  return entry.slice(0, colonIdx).trim().toLowerCase();
}

/**
 * Build Docker `HostConfig.ExtraHosts` preserving any existing caller/platform entries
 * (such as `host.docker.internal:host-gateway`) and appending required platform defaults
 * without overriding or duplicating entries for the same hostname.
 */
export function buildContainerExtraHosts(existing?: readonly string[]): string[] {
  const result: string[] = [];
  const seenHosts = new Set<string>();
  const addEntry = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const key = extraHostKey(trimmed);
    if (seenHosts.has(key)) return;
    seenHosts.add(key);
    result.push(trimmed);
  };
  if (existing) {
    for (const entry of existing) {
      addEntry(entry);
    }
  }
  for (const defaultEntry of V3_DEFAULT_EXTRA_HOSTS) {
    addEntry(defaultEntry);
  }
  return result;
}
