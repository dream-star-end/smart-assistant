/**
 * ContainerTransport over the in-process desktop reverse tunnel.
 * P1 WeChat inbound must not call this for desktop endpoints.
 */

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

export function selectContainerTransport(
  endpoint: { desktop?: { containerId: number }; tunnel?: unknown; containerId?: number },
  dockerTransport: ContainerTransport,
  desktopTransport: ContainerTransport,
): ContainerTransport {
  if (endpoint.desktop) return desktopTransport;
  return dockerTransport;
}
