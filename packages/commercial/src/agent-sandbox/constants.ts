/**
 * 容器沙箱共享常量 —— 避免在 v3supervisor.ts / sshMux.ts 等处双写魔数。
 *
 * UID/GID 必须和容器镜像 Dockerfile 的 `USER agent` 一致(agent = 1000:1000)。
 * v3supervisor 通过 HostConfig.User "1000:1000" 强制 enforce;容器内任何进程
 * (entrypoint / CCB / user shell)都以这个 uid 运行。
 *
 * /run/ccb-ssh/u<uid>/h<hid>/ 下的 socket / known_hosts 需要 group 权限允许
 * 容器内 agent 连接;V3_AGENT_GID 就是 chown 的 group。
 */

export const V3_AGENT_UID = 1000;
export const V3_AGENT_GID = 1000;

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
