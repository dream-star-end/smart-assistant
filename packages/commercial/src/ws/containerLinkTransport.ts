import { WebSocket } from "ws";
import { getContainerLinkHandle, type ContainerLinkRegistry } from "./containerLink.js";
import type { ResolveContainerEndpoint, UserChatBridgeDeps } from "./userChatBridge.js";

/** Browser admission supplies authorization; only the registry dials shared transports. */
export async function attachContainerTransport(input: {
  uid: bigint;
  endpoint: Awaited<ReturnType<ResolveContainerEndpoint>>;
  links: ContainerLinkRegistry | null;
  deps: UserChatBridgeDeps;
  maxFrameBytes: number;
  signal: AbortSignal;
  connId: string;
}): Promise<WebSocket> {
  const { uid, endpoint, links, deps, maxFrameBytes, signal, connId } = input;
  const dial = async (dialSignal: AbortSignal): Promise<WebSocket> => {
    if (endpoint.desktop) {
      const { getDesktopTunnelRegistry } = await import("./desktopTunnelRegistry.js");
      return getDesktopTunnelRegistry().openWs(endpoint.desktop.containerId, "/ws") as unknown as WebSocket;
    }
    if (endpoint.tunnel) {
      if (!deps.createTunnelContainerSocket) throw new Error("tunnel not configured");
      return deps.createTunnelContainerSocket(endpoint.tunnel, endpoint.port, dialSignal, connId);
    }
    return deps.createContainerSocket?.(endpoint.host, endpoint.port, dialSignal)
      ?? new WebSocket(`ws://${endpoint.host}:${endpoint.port}/ws`, { perMessageDeflate: false, maxPayload: maxFrameBytes });
  };
  // OC_CONTAINER_LINK=0 and legacy endpoints intentionally retain the old transport.
  return links && endpoint.containerId !== undefined
    ? links.attach(uid, endpoint.containerId, dial)
    : dial(signal);
}

export function registerBridgeTransport(uid: bigint, socket: WebSocket, map: Map<string, Set<WebSocket>>): void {
  const handle = getContainerLinkHandle(socket);
  if (handle) { handle.link.registerTransport(map); return; }
  const key = String(uid);
  let set = map.get(key);
  if (!set) { set = new Set(); map.set(key, set); }
  set.add(socket);
}
