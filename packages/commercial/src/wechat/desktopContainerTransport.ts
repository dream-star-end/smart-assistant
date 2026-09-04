/**
 * ContainerTransport over the in-process desktop reverse tunnel.
 *
 * P1 WeChat / QQ inbound must not call this. `selectContainerTransport` is a
 * fail-closed guard: a desktop endpoint still returns `dockerTransport` and
 * emits an audit log. Turn-dispatch reconciler injects this transport
 * separately (it is not the inbound path).
 */

import { rootLogger } from "../logging/logger.js";
import { getDesktopTunnelRegistry } from "../ws/desktopTunnelRegistry.js";
import type { ContainerTransport } from "./inboundDispatcher.js";

export function makeDesktopContainerTransport(): ContainerTransport {
  return {
    supportsTunnel: true,
    async post(endpoint, path, headers, bodyJson, timeoutMs) {
      return this.request!("POST", endpoint, path, headers, bodyJson, timeoutMs);
    },
    async request(method, endpoint, path, headers, bodyJson, timeoutMs) {
      const containerId = Number((endpoint as { containerId?: number }).containerId);
      if (!Number.isInteger(containerId) || containerId <= 0) {
        throw new Error("desktop transport requires endpoint.containerId");
      }
      const res = await getDesktopTunnelRegistry().http(
        containerId,
        method,
        path,
        headers,
        bodyJson,
        timeoutMs,
      );
      return { status: res.status, bodyText: res.bodyText, headers: res.headers };
    },
  };
}

/**
 * WeChat inbound must stay on docker. A desktop hint is audited and ignored.
 * `desktopTransport` is accepted so call sites type-check, but it is never
 * returned for a desktop endpoint.
 */
export function selectContainerTransport(
  endpoint: { desktop?: { containerId: number }; tunnel?: unknown; containerId?: number },
  dockerTransport: ContainerTransport,
  _desktopTransport: ContainerTransport,
): ContainerTransport {
  if (endpoint.desktop) {
    rootLogger.warn("selectContainerTransport_desktop_forced_docker", {
      containerId: endpoint.desktop.containerId,
    });
    return dockerTransport;
  }
  return dockerTransport;
}
