import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { getContainerLinkHandle, type ContainerLinkHandle, type ContainerLinkRegistry } from "./containerLink.js";
import { attachContainerTransport } from "./containerLinkTransport.js";
import { loadBridgeAgentResolver, loadBridgeModelChecker } from "./bridgeExecutionContext.js";
import type { LinkCarrier } from "./containerLinkRecoveryStore.js";
import type { ResolveContainerEndpoint, UserChatBridgeDeps } from "./userChatBridge.js";

type Endpoint = Awaited<ReturnType<ResolveContainerEndpoint>>;
type Context = {
  checker: Awaited<ReturnType<typeof loadBridgeModelChecker>>;
  agents: Awaited<ReturnType<typeof loadBridgeAgentResolver>>;
  role: "admin" | "user";
};
export type ContainerLinkLease = { socket: WebSocket; release(): void };
type Entry = { users: number; work: Promise<ContainerLinkHandle | null>; unpin?: () => void };

class BackgroundSubscriber extends EventEmitter {
  readyState = WebSocket.CLOSED;
  bufferedAmount = 0;
  send(): void {}
  ping(): void {}
  close(): void { this.emit("close", 1000, Buffer.alloc(0)); }
  terminate(): void { this.close(); }
}

/** Shared control/origin wake entry. No provisioning, browser quota or activity. */
export class ContainerLinkWake {
  private readonly entries = new Map<string, Entry>();
  private readonly abort = new AbortController();
  constructor(private readonly options: {
    links: ContainerLinkRegistry; deps: UserChatBridgeDeps; maxFrameBytes: number;
    start(user: WebSocket, uid: bigint, endpoint: Endpoint, socket: WebSocket,
      abort: AbortController, connId: string, context: Context): void;
  }) {}

  async acquire(carrier: LinkCarrier, options: { execution?: boolean } = {}): Promise<ContainerLinkLease | null> {
    if (this.abort.signal.aborted) return null;
    const execution = options.execution !== false;
    const key = `${carrier.uid}:${carrier.containerId}:${execution}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { users: 0, work: Promise.resolve(null) };
      this.entries.set(key, entry);
      entry.work = this.open(carrier, entry, execution);
    }
    entry.users++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (--entry.users === 0) {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        entry.unpin?.();
      }
    };
    try {
      const handle = await entry.work;
      if (!handle || handle.disposed || this.abort.signal.aborted) { release(); return null; }
      return { socket: handle.socket, release };
    } catch (error) {
      release();
      this.options.deps.logger?.warn("container-link: wake failed", { ...carrier, error });
      return null;
    }
  }

  private async open(carrier: LinkCarrier, entry: Entry, execution: boolean): Promise<ContainerLinkHandle | null> {
    const { deps, links } = this.options;
    const uid = BigInt(carrier.uid);
    const abort = new AbortController();
    const cancel = () => abort.abort();
    this.abort.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, deps.containerConnectTimeoutMs ?? 5000);
    let socket: WebSocket | undefined;
    const check = () => {
      if (abort.signal.aborted || links.stopping) throw new Error("container link wake stopped");
    };
    const work = async () => {
      let endpoint = await deps.resolveContainerLinkEndpoint!(uid, carrier.containerId);
      check();
      if (!endpoint || endpoint === "pending" || endpoint.containerId !== carrier.containerId) return null;
      if (execution && !endpoint.desktop && deps.readContainerLinkBundleRev) {
        const bundleRev = await deps.readContainerLinkBundleRev(uid, carrier.containerId);
        check();
        endpoint = { ...endpoint, bundleRev };
      }
      const checker = execution ? await loadBridgeModelChecker(deps, uid) : null;
      check();
      const agents = execution ? await loadBridgeAgentResolver(deps, uid, endpoint.bundleRev) : null;
      check();
      const user = execution ? (await deps.pgPool!.query<{ role: string }>("SELECT role FROM users WHERE id=$1", [carrier.uid])).rows[0] : { role: "user" };
      check();
      if (!user) throw new Error("container link user unavailable");
      const connId = randomUUID();
      socket = await attachContainerTransport({ uid, endpoint, links, deps,
        signal: abort.signal, connId, maxFrameBytes: this.options.maxFrameBytes });
      check();
      const handle = getContainerLinkHandle(socket)!;
      handle.background = true;
      handle.recoveryOnly = !execution;
      entry.unpin = handle.retain();
      const subscriber = new BackgroundSubscriber();
      this.options.start(subscriber as unknown as WebSocket, uid, endpoint, socket, abort, connId,
        { checker, agents, role: user.role === "admin" ? "admin" : "user" });
      subscriber.close();
      const opened = waitForLink(handle, abort.signal, () => handle.readyState === WebSocket.OPEN);
      handle.activate();
      await opened;
      check();
      return handle;
    };
    let onAbort!: () => void;
    try {
      return await Promise.race([work().catch(error => { socket?.terminate(); throw error; }), new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("container link wake timeout or shutdown"));
        abort.signal.addEventListener("abort", onAbort, { once: true });
      })]);
    } catch (error) {
      socket?.terminate();
      throw error;
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener("abort", onAbort);
      this.abort.signal.removeEventListener("abort", cancel);
    }
  }
  stop(): void { this.abort.abort(); }
  async drain(): Promise<void> { await Promise.allSettled([...this.entries.values()].map(entry => entry.work)); }
}

function waitForLink(handle: ContainerLinkHandle, signal: AbortSignal, ready: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      handle.off("open", check); handle.off("message", check); handle.off("close", closed);
      signal.removeEventListener("abort", closed);
    };
    const closed = () => { cleanup(); reject(new Error("container link unavailable")); };
    const check = () => {
      if (signal.aborted || handle.disposed) closed();
      else if (ready()) { cleanup(); resolve(); }
    };
    handle.on("open", check); handle.on("message", check); handle.once("close", closed);
    signal.addEventListener("abort", closed, { once: true });
    check();
  });
}

/** Attestation registration is the sole origin-executor availability authority. */
export async function waitForOriginExecutor(socket: WebSocket, timeoutMs: number): Promise<void> {
  const handle = getContainerLinkHandle(socket)!;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try { await waitForLink(handle, abort.signal, () => handle.link.executors.canInject); }
  finally { clearTimeout(timer); }
}
