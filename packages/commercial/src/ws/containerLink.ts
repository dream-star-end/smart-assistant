import { recordContainerLinkGap, type LinkDispatch } from "./containerLinkRecoveryStore.js";
import { containerLinkGap } from "../admin/metrics.js";
import { ContainerLinkHello } from "./containerLinkHello.js";
/**
 * Master owns one physical WS per (uid, containerId). Bridge handles retain
 * their existing authorization and billing closures; each incoming frame has
 * exactly one handler. Browser detach does not dispose an open turn's handler.
 * This adapter is deliberately temporary until browser ingress moves out of
 * userChatBridge. No billing journal or container protocol is migrated here.
 */
import { ContainerLinkExecutors } from "./bridgeExecutorRegistration.js";
import { EventEmitter } from "node:events";
import { WebSocket, type RawData } from "ws";
import { getDispatchByLogicalKey, type Queryable } from "../dispatch/turnDispatchStore.js";
import { CONTAINER_ATTEST_FRAME_TYPE } from "./userChatBridgeTypes.js";
import { renewContainerLinkLease } from "./containerLinkStore.js";

type Log = { info?(message: string, fields?: Record<string, unknown>): void; warn?(message: string, fields?: Record<string, unknown>): void };
type Wire = Record<string, any>;
type Stream = { sessionId: string; clientMessageId: string; dispatchId?: string; attemptNo?: number; leaseEpoch?: number };
const streamKey = (session: string, message: string): string => JSON.stringify([session, message]);
const handles = new WeakMap<WebSocket, ContainerLinkHandle>();
export const getContainerLinkHandle = (ws: WebSocket): ContainerLinkHandle | undefined => handles.get(ws);
function parse(data: RawData, binary: boolean): Wire | null {
  if (binary) return null;
  try {
    const value: unknown = JSON.parse(Buffer.isBuffer(data) ? data.toString() : String(data));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Wire : null;
  } catch { return null; }
}

export interface ContainerLinkSnapshot {
  uid: string;
  containerId: number;
  subscribers: number;
  transportAliveAt: number;
  dispatches: Stream[];
}

/** A handle's close releases only this consumer, never another browser's WS. */
export class ContainerLinkHandle extends EventEmitter {
  readonly socket: WebSocket;
  readonly streams = new Map<string, Stream>();
  readonly closedStreams = new Set<string>();
  detached = false;
  recoveryOnly = false;
  keepAlive = false;
  background = false;
  private retainers = 0;
  get retained(): boolean { return this.retainers > 0; }
  retain(): () => void {
    this.retainers++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.retainers--;
      this.onStreamsChanged();
    };
  }
  active = false;
  opened = false;
  disposed = false;
  onStreamsChanged: () => void = () => {};
  pendingPing: { wireId: string; originalId: unknown } | null = null;
  constructor(readonly link: ContainerLink) {
    super();
    this.socket = this as unknown as WebSocket;
    handles.set(this.socket, this);
  }
  get readyState(): number {
    if (this.disposed) return WebSocket.CLOSED;
    return this.active ? this.link.ws?.readyState ?? WebSocket.CONNECTING : WebSocket.CONNECTING;
  }
  get bufferedAmount(): number { return this.link.ws?.bufferedAmount ?? 0; }
  get hasOpenDispatches(): boolean { return !this.link.stopping && this.streams.size > 0; }
  activate(): void {
    if (this.disposed) return;
    this.active = true;
    this.link.activate(this);
  }
  send(data: RawData, opts?: { binary?: boolean }, callback?: (err?: Error) => void): void {
    if (this.disposed || !this.link.ws) { callback?.(new Error("container link closed")); return; }
    this.link.send(this, data, opts, callback);
  }
  close(): void { this.terminate(); }
  terminate(): void { this.link.release(this); }
  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.link.detached(this);
  }
  noteStream(sessionId: string, clientMessageId: string, final = false): void {
    const key = streamKey(sessionId, clientMessageId);
    if (final) {
      this.closedStreams.add(key);
      if (this.streams.delete(key)) this.onStreamsChanged();
    } else if (!this.closedStreams.has(key) && !this.disposed) {
      this.streams.set(key, this.streams.get(key) ?? { sessionId, clientMessageId });
      this.link.claimStream(key, this);
    }
  }
  restoreDispatch(record: LinkDispatch): void {
    const key = streamKey(record.sessionId, record.clientMessageId);
    if (!this.link.restoreDispatch(key, record, this)) return;
    this.streams.set(key, record);
  }
  bindDispatch(record: Stream & { dispatchId: string; attemptNo: number; leaseEpoch: number }): void {
    const key = streamKey(record.sessionId, record.clientMessageId);
    this.closedStreams.delete(key);
    this.streams.set(key, {
      sessionId: record.sessionId, clientMessageId: record.clientMessageId,
      dispatchId: record.dispatchId, attemptNo: record.attemptNo, leaseEpoch: record.leaseEpoch,
    });
    this.link.bindDispatch(key, record, this);
  }
  persisted(sessionId: string, clientMessageId: string | null, final: boolean): void {
    this.link.persisted(this);
    if (clientMessageId !== null) this.noteStream(sessionId, clientMessageId, final);
  }
}

class ContainerLink {
  ws: WebSocket | null = null;
  stopping = false;
  readonly ready: Promise<void>;
  readonly consumers = new Set<ContainerLinkHandle>();
  readonly executors = new ContainerLinkExecutors();
  transportAliveAt = 0;
  private readonly abort = new AbortController();
  private readonly routes = new Map<string, ContainerLinkHandle>();
  private readonly sessions = new Map<string, ContainerLinkHandle>();
  private attest: RawData | null = null;
  private queued: Array<{ data: RawData; binary: boolean }> = [];
  private queuedBytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickWork: Promise<void> | null = null;
  private pingSeq = 0;
  private readonly hello: ContainerLinkHello;
  private unmountTransport: (() => void) | null = null;
  transport: WebSocket | null = null;
  private transportOwner(): ContainerLinkHandle | undefined {
    return [...this.consumers].find((h) => h.active && !h.detached && !h.disposed)
      ?? [...this.consumers].find((h) => h.active && !h.disposed);
  }
  registerTransport(map: Map<string, Set<WebSocket>>): void {
    if (this.unmountTransport) return;
    const link = this;
    const transport = {
      get readyState() { return link.stopping ? WebSocket.CLOSED : link.ws?.readyState ?? WebSocket.CONNECTING; },
      send(data: RawData, opts?: { binary?: boolean }, callback?: (err?: Error) => void) {
        const owner = link.transportOwner();
        if (!owner) throw new Error("container link closed");
        link.send(owner, data, opts, callback);
      },
    } as WebSocket;
    this.transport = transport;
    const key = String(this.uid);
    let set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); }
    set.add(transport);
    this.unmountTransport = () => { set.delete(transport); if (!set.size) map.delete(key); };
  }
  private sending: Promise<void> | null = null;
  private sendingBytes = 0;

  constructor(
    readonly uid: bigint, readonly containerId: number,
    private readonly registry: ContainerLinkRegistry,
    create: (signal: AbortSignal) => WebSocket | Promise<WebSocket>,
  ) {
    this.hello = new ContainerLinkHello(registry.pool, uid, containerId);
    const dialWork = Promise.resolve().then(() => create(this.abort.signal)).then((ws) => {
      this.ws = ws;
      // Also cover an async tunnel factory resolving after shutdown.
      if (this.stopping) { ws.on("error", () => {}); ws.terminate(); return; }
      this.transportAliveAt = Date.now();
      ws.on("open", () => {
        this.transportAliveAt = Date.now();
        for (const consumer of this.consumers) this.activate(consumer);
      });
      ws.on("pong", () => { this.transportAliveAt = Date.now(); });
      ws.on("message", (data, binary) => this.receive(data, binary));
      ws.on("error", (err) => {
        this.registry.log?.warn?.("container-link: transport error", { uid: String(uid), containerId, err });
        this.transportFailed(err);
      });
      ws.on("close", () => this.registry.onTransportLost ? this.transportFailed(new Error("container link transport closed")) : this.stop());
      this.timer = setInterval(() => { void this.tick(); }, registry.heartbeatMs);
      this.timer.unref();
    });
    let timeout: ReturnType<typeof setTimeout>;
    this.ready = Promise.race([dialWork, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("container link dial timeout")), registry.dialTimeoutMs);
    })]).finally(() => clearTimeout(timeout));
  }
  attach(): ContainerLinkHandle {
    if (this.stopping) throw new Error("container link stopped");
    const handle = new ContainerLinkHandle(this);
    this.consumers.add(handle);
    this.registry.report("attach", this);
    return handle;
  }
  activate(handle: ContainerLinkHandle): void {
    if (!handle.active || handle.disposed || handle.opened || this.ws?.readyState !== WebSocket.OPEN) return;
    handle.opened = true;
    handle.emit("open");
    if (this.attest !== null) handle.emit("message", this.attest, false);
    const pending = this.queued;
    this.queued = [];
    this.queuedBytes = 0;
    for (const item of pending) this.receive(item.data, item.binary);
  }
  claimStream(key: string, owner: ContainerLinkHandle): void {
    if (!this.routes.has(`stream:${key}`)) this.routes.set(`stream:${key}`, owner);
  }
  bindDispatch(key: string, record: Stream, owner: ContainerLinkHandle): void {
    this.routes.set(`stream:${key}`, owner);
    this.routes.set(`dispatch:${record.dispatchId}:${record.attemptNo}`, owner);
  }
  restoreDispatch(key: string, record: Stream, owner: ContainerLinkHandle): boolean {
    if (this.routes.has(`stream:${key}`)) return false;
    this.bindDispatch(key, record, owner);
    return true;
  }
  private transportFailed(error: Error): void {
    if (this.stopping) return;
    this.stop(error);
    this.registry.onTransportLost?.(this.uid, this.containerId);
  }
  send(handle: ContainerLinkHandle, data: RawData, opts?: { binary?: boolean }, cb?: (err?: Error) => void): void {
    const frame = parse(data, opts?.binary === true);
    if (typeof frame?.requestId === "string") this.routes.set(`request:${frame.requestId}`, handle);
    if (typeof frame?.sessionKey === "string") this.sessions.set(frame.sessionKey, handle);
    if (frame?.type === "ping") {
      const wireId = `container-link:${++this.pingSeq}`;
      handle.pendingPing = { wireId, originalId: frame.id };
      data = Buffer.from(JSON.stringify({ ...frame, id: wireId }));
    } else if (frame?.type === "inbound.message") {
      const session = frame.peer?.id;
      const cmid = frame.clientMessageId;
      if (typeof session === "string") {
        this.sessions.set(session, handle);
        if (typeof cmid === "string") handle.noteStream(session, cmid);
      }
      const grantId = frame.__oc_prompt_queue_grant?.grantId;
      if (typeof grantId === "string") this.routes.set(`grant:${grantId}`, handle);
    } else if (frame?.type === "inbound.hello" && Array.isArray(frame.peers)) {
      for (const peer of frame.peers) {
        if (typeof peer?.peerId === "string" && !this.sessions.has(peer.peerId)) this.sessions.set(peer.peerId, handle);
      }
    }
    const helloPeers = frame?.type === "inbound.hello" && Array.isArray(frame.peers) ? frame.peers : null;
    if (helloPeers === null && this.sending === null) { this.ws!.send(data, opts ?? {}, cb); return; }
    const bytes = Buffer.byteLength(Buffer.isBuffer(data) ? data : String(data));
    if (this.sendingBytes + bytes > this.registry.maxBufferedBytes) {
      const error = new Error("container link send backpressure");
      cb?.(error); this.stop(error); return;
    }
    this.sendingBytes += bytes;
    const work = (this.sending ?? Promise.resolve()).then(async () => {
      if (this.stopping || handle.disposed) { cb?.(new Error("container link closed")); return; }
      if (helloPeers !== null) await this.registry.beforeReplay?.();
      const prepared = helloPeers === null ? null : await this.hello.prepare(helloPeers);
      if (prepared) data = Buffer.from(JSON.stringify(prepared));
      if (this.stopping || handle.disposed) { cb?.(new Error("container link closed")); return; }
      await new Promise<void>((resolve, reject) => {
        this.ws!.send(data, opts ?? {}, (error) => error ? reject(error) : resolve());
      });
      if (prepared) this.hello.committed(prepared);
      cb?.();
    }).catch((error: Error) => { cb?.(error); this.transportFailed(error); }).finally(() => {
      this.sendingBytes -= bytes;
      if (this.sending === work) this.sending = null;
    });
    this.sending = work;
  }
  private receiving: Promise<void> | null = null;
  private receivingBytes = 0;
  private receive(data: RawData, binary: boolean): void {
    if (this.stopping) return;
    const frame = parse(data, binary);
    if (frame?.type !== "outbound.resume_failed" && this.receiving === null) { this.deliver(data, binary); return; }
    const bytes = Buffer.byteLength(Buffer.isBuffer(data) ? data : String(data));
    this.receivingBytes += bytes;
    if (this.receivingBytes > this.registry.maxBufferedBytes) { this.transportFailed(new Error("container link receive backpressure")); return; }
    const work = (this.receiving ?? Promise.resolve()).then(async () => {
      if (this.stopping) return;
      if (frame?.type === "outbound.resume_failed") {
        const count = await recordContainerLinkGap(this.registry.pool, this.uid, this.containerId, frame);
        if (count > 0) { containerLinkGap.inc({}, count); this.registry.report("gap", this); }
      }
      this.deliver(data, binary);
    }).catch((error: Error) => this.transportFailed(error)).finally(() => {
      this.receivingBytes -= bytes;
      if (this.receiving === work) this.receiving = null;
    });
    this.receiving = work;
  }
  private deliver(data: RawData, binary: boolean): void {
    if (this.stopping) return;
    this.transportAliveAt = Date.now();
    const frame = parse(data, binary);
    if (frame?.type === CONTAINER_ATTEST_FRAME_TYPE) {
      this.attest = data;
      for (const handle of this.consumers) {
        if (handle.active && handle.opened) handle.emit("message", data, binary);
      }
      return;
    }
    if (frame?.type === "pong") {
      for (const handle of this.consumers) {
        const pending = handle.pendingPing;
        if (!pending || pending.wireId !== frame.id) continue;
        const { originalId } = pending;
        handle.pendingPing = null;
        const restored = { ...frame, id: originalId };
        handle.emit("message", Buffer.from(JSON.stringify(restored)), false);
        return;
      }
      return;
    }
    const session = frame?.peer?.id ?? frame?.sessionId ?? frame?.owner?.clientSessionId ?? frame?.owner?.peer?.id ?? frame?.sessionKey;
    const cmid = frame?.clientMessageId;
    let owner = typeof frame?.grantId === "string" ? this.routes.get(`grant:${frame.grantId}`) : undefined;
    owner ??= typeof frame?.dispatchId === "string" ? this.routes.get(`dispatch:${frame.dispatchId}:${frame.attemptNo}`) : undefined;
    owner ??= typeof frame?.requestId === "string" ? this.routes.get(`request:${frame.requestId}`) : undefined;
    if (!owner && typeof session === "string" && typeof cmid === "string") {
      owner = this.routes.get(`stream:${streamKey(session, cmid)}`);
    }
    owner ??= typeof session === "string" ? this.sessions.get(session) : undefined;
    owner ??= [...this.consumers].find((h) => h.active && !h.detached);
    owner ??= [...this.consumers].find((h) => h.active);
    if (owner?.active && !owner.disposed) {
      owner.emit("message", data, binary);
      return;
    }
    this.queuedBytes += Buffer.byteLength(Buffer.isBuffer(data) ? data : String(data));
    if (this.queuedBytes > this.registry.maxBufferedBytes) { this.stop(); return; }
    this.queued.push({ data, binary });
  }
  detached(handle: ContainerLinkHandle): void {
    if (handle.hasOpenDispatches) this.registry.takeovers++;
    this.registry.report("detach", this);
    void this.tick();
  }
  persisted(handle: ContainerLinkHandle): void {
    if (handle.detached) this.registry.detachedFrames++;
  }
  tick(): Promise<void> {
    if (this.tickWork) return this.tickWork;
    if (this.stopping || this.ws?.readyState !== WebSocket.OPEN) return Promise.resolve();
    if (Date.now() - this.transportAliveAt > this.registry.heartbeatMs * 3) {
      this.transportFailed(new Error("container link heartbeat timeout"));
      return Promise.resolve();
    }
    this.ws.ping();
    this.tickWork = this.renew().finally(() => { this.tickWork = null; });
    return this.tickWork;
  }
  private async renew(): Promise<void> {
    for (const handle of [...this.consumers]) {
      for (const [key, stream] of [...handle.streams]) {
        if (this.stopping) return;
        try {
          const row = await getDispatchByLogicalKey(this.registry.pool, { userId: this.uid, ...stream });
          if (this.stopping || handle.streams.get(key) !== stream) continue;
          if (!row || row.agentContainerId !== this.containerId ||
              (stream.dispatchId !== undefined && (row.dispatchId !== stream.dispatchId || row.attemptNo !== stream.attemptNo || row.leaseEpoch !== stream.leaseEpoch)) ||
              (row.status !== "admitted" && row.status !== "accepted") || row.terminalAt !== null) {
            handle.noteStream(stream.sessionId, stream.clientMessageId, true);
            continue;
          }
          stream.dispatchId = row.dispatchId;
          stream.attemptNo = row.attemptNo;
          stream.leaseEpoch = row.leaseEpoch;
          if (handle.recoveryOnly && row.status === "admitted") continue;
          await renewContainerLinkLease(this.registry.pool, this.uid, this.containerId, row);
        } catch (err) {
          this.registry.log?.warn?.("container-link: heartbeat failed", { uid: String(this.uid), containerId: this.containerId, err });
        }
      }
    }
    this.registry.report("heartbeat", this);
  }
  release(handle: ContainerLinkHandle): void {
    if (handle.disposed) return;
    handle.disposed = true;
    this.executors.release(handle);
    handle.streams.clear();
    handle.pendingPing = null;
    this.consumers.delete(handle);
    for (const [key, value] of this.routes) if (value === handle) this.routes.delete(key);
    for (const [key, value] of this.sessions) if (value === handle) this.sessions.delete(key);
    handle.emit("close", 1000, Buffer.from("container link detached"));
    if (this.consumers.size === 0) this.stop();
  }
  stop(error?: Error): void {
    if (this.stopping) return;
    this.stopping = true;
    this.executors.close();
    this.unmountTransport?.();
    this.unmountTransport = null;
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    // Preserve error-before-close: bridge cleanup keeps live Grok route leases
    // on transport errors, whereas an explicit container close is terminal.
    if (error) {
      for (const handle of [...this.consumers]) {
        if (handle.listenerCount("error") > 0) handle.emit("error", error);
      }
    }
    this.ws?.terminate();
    for (const handle of [...this.consumers]) this.release(handle);
    this.registry.remove(this);
    this.queued = [];
    this.queuedBytes = 0;
  }
  async drain(): Promise<void> { await Promise.allSettled([this.ready, this.tickWork, this.sending, this.receiving]); }
  snapshot(): ContainerLinkSnapshot {
    return { uid: String(this.uid), containerId: this.containerId,
      subscribers: [...this.consumers].filter((h) => !h.detached).length,
      transportAliveAt: this.transportAliveAt,
      dispatches: [...this.consumers].flatMap((h) => [...h.streams.values()].map((s) => ({ ...s }))),
    };
  }
}

export class ContainerLinkRegistry {
  private readonly links = new Map<string, ContainerLink>();
  private readonly draining = new Set<ContainerLink>();
  stopping = false;
  takeovers = 0;
  detachedFrames = 0;
  onTransportLost?: (uid: bigint, containerId: number) => void;
  beforeReplay?: () => Promise<void>;
  readonly dialTimeoutMs: number;
  readonly heartbeatMs: number;
  readonly maxBufferedBytes: number;
  constructor(readonly pool: Queryable, readonly log?: Log | null, opts?: { heartbeatMs?: number; maxBufferedBytes?: number; dialTimeoutMs?: number }) {
    this.dialTimeoutMs = opts?.dialTimeoutMs ?? 5000;
    this.heartbeatMs = opts?.heartbeatMs ?? 30_000;
    this.maxBufferedBytes = opts?.maxBufferedBytes ?? 4 * 1024 * 1024;
  }
  connect(uid: bigint, cid: number, create: (signal: AbortSignal) => WebSocket | Promise<WebSocket>): Promise<WebSocket> {
    return this.attach(uid, cid, create);
  }
  async attach(uid: bigint, cid: number, create: (signal: AbortSignal) => WebSocket | Promise<WebSocket>): Promise<WebSocket> {
    if (this.stopping) throw new Error("container link registry shutting down");
    const key = `${uid}:${cid}`;
    let link = this.links.get(key);
    if (!link) {
      link = new ContainerLink(uid, cid, this, create);
      this.links.set(key, link); // reserve before any async dial
    }
    try {
      await link.ready;
      if (this.stopping) throw new Error("container link registry shutting down");
      return link.attach().socket;
    } catch (error) {
      const failed = !link.stopping;
      link.stop();
      if (failed && !this.stopping) this.onTransportLost?.(uid, cid);
      throw error;
    }
  }
  remove(link: ContainerLink): void {
    const key = `${link.uid}:${link.containerId}`;
    if (this.links.get(key) === link) this.links.delete(key);
    this.draining.add(link);
    void link.drain().finally(() => this.draining.delete(link));
    this.report("closed", link);
  }
  report(event: string, link: ContainerLink): void {
    this.log?.info?.(`container-link: ${event}`, {
      ...link.snapshot(), container_link_active: this.links.size,
      container_link_takeovers_total: this.takeovers,
      container_link_detached_frames_total: this.detachedFrames,
    });
  }
  snapshots(): ContainerLinkSnapshot[] { return [...this.links.values()].map((link) => link.snapshot()); }
  controlTransport(uid: bigint, containerId: number): WebSocket | null {
    const transport = this.links.get(`${uid}:${containerId}`)?.transport;
    return transport?.readyState === WebSocket.OPEN ? transport : null;
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.draining].map((link) => link.drain())); }
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const link of [...this.links.values()]) {
      for (const handle of [...link.consumers]) handle.emit("linkShutdown");
      link.stop();
    }
    await Promise.allSettled([...this.draining].map((link) => link.drain()));
  }
}
