/**
 * Real-time WebSocket stream client for the live cloud browser (OCV5-857).
 *
 * Strictly lazy-imported by LiveBrowserStage so zero bytes enter the first-screen bundle.
 * Manages ticket issuance, subprotocol WS handshake, generation fencing (`connGen`),
 * monotonic binary frame sequence filtering (`seq`), FPS/RTT telemetry, exponential
 * backoff reconnects, and automatic graceful fallback to HTTP polling.
 */
import {
  LIVE_BROWSER_PUBLIC_WS_PATH,
  LIVE_BROWSER_TICKET_PROTOCOL,
  type LiveBrowserClientMessage,
  type LiveBrowserDecodedFrame,
  type LiveBrowserHandoffReadyMessage,
  type LiveBrowserHandoffVetoedMessage,
  type LiveBrowserServerMessage,
  type LiveBrowserStatePayload,
  type LiveBrowserStreamTicketResponse,
  decodeLiveBrowserFrame,
} from "@openclaude/protocol/browser";
import { requestLiveBrowserStreamTicket } from "./liveBrowserApi";
import type { AuthSession } from "./types";

export type LiveBrowserConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "fallback"
  | "replaced"
  | "closed";

export interface LiveBrowserStreamStats {
  fps: number;
  rttMs: number | null;
  lastFrameAt: number | null;
  mode: "ws" | "polling";
}

export interface LiveBrowserStreamCallbacks {
  onStatus?: (status: LiveBrowserConnectionStatus, detail?: string) => void;
  onState?: (state: LiveBrowserStatePayload, fromReady: boolean) => void;
  onFrame?: (frame: LiveBrowserDecodedFrame) => void;
  onCursor?: (cursor: string) => void;
  onHandoffReady?: (event: LiveBrowserHandoffReadyMessage) => void;
  onHandoffVetoed?: (event: LiveBrowserHandoffVetoedMessage) => void;
  onError?: (message: string, code?: string, retryable?: boolean) => void;
  onStats?: (stats: LiveBrowserStreamStats) => void;
  onFallback?: (reason: string) => void;
}

export interface LiveBrowserStreamClientOptions {
  agentId: string;
  getAuth: () => AuthSession;
  callbacks: LiveBrowserStreamCallbacks;
  /** Initial consecutive failures allowed before falling back to HTTP polling (default 2). */
  maxConnectFailuresBeforeFallback?: number;
  /** Interval in ms between WS heartbeat pings (default 10_000). */
  pingIntervalMs?: number;
  /** Optional WebSocket factory for tests. */
  createWebSocket?: (url: string, protocols: string[]) => WebSocket;
  /** Optional ticket requester for tests. */
  requestTicket?: (
    auth: AuthSession,
    agentId: string,
    signal?: AbortSignal,
  ) => Promise<LiveBrowserStreamTicketResponse>;
  /** Optional base location override for tests. */
  locationOrigin?: string;
}

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 15_000;
const FALLBACK_UPGRADE_PROBE_MS = 30_000;
const STATS_THROTTLE_MS = 500;
const FPS_WINDOW_MS = 1_000;

export function buildLiveBrowserWsUrl(wsPath: string, locationOrigin?: string): string {
  const path = wsPath.startsWith("/") ? wsPath : `/${wsPath}`;
  if (locationOrigin) {
    const u = new URL(path, locationOrigin);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  }
  if (typeof window !== "undefined" && window.location) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}${path}`;
  }
  return `ws://127.0.0.1${path}`;
}

function errorReason(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "实时流连接不可用";
}

export class LiveBrowserStreamClient {
  private readonly agentId: string;
  private readonly getAuth: () => AuthSession;
  private readonly callbacks: LiveBrowserStreamCallbacks;
  private readonly maxFailuresBeforeFallback: number;
  private readonly pingIntervalMs: number;
  private readonly createWebSocket: (url: string, protocols: string[]) => WebSocket;
  private readonly requestTicket: NonNullable<LiveBrowserStreamClientOptions["requestTicket"]>;
  private readonly locationOrigin?: string;

  private ws: WebSocket | null = null;
  private ticketAbort: AbortController | null = null;
  private connGen = 0;
  private disposed = false;
  private status: LiveBrowserConnectionStatus = "idle";
  private hasEverReady = false;
  private readyThisGen = false;
  private consecutiveFailures = 0;
  private lastFrameSeq = 0;

  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private pingTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private statsTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  private frameTimestamps: number[] = [];
  private lastFrameAt: number | null = null;
  private rttMs: number | null = null;
  private lastStatsEmittedAt = 0;
  private visibilityBound = false;

  constructor(opts: LiveBrowserStreamClientOptions) {
    this.agentId = opts.agentId;
    this.getAuth = opts.getAuth;
    this.callbacks = opts.callbacks;
    this.maxFailuresBeforeFallback = opts.maxConnectFailuresBeforeFallback ?? 2;
    this.pingIntervalMs = opts.pingIntervalMs ?? 10_000;
    this.createWebSocket =
      opts.createWebSocket ?? ((url, protocols) => new WebSocket(url, protocols));
    this.requestTicket = opts.requestTicket ?? requestLiveBrowserStreamTicket;
    this.locationOrigin = opts.locationOrigin;
  }

  public getStatus(): LiveBrowserConnectionStatus {
    return this.status;
  }

  public isConnected(): boolean {
    return this.status === "connected" && this.ws?.readyState === 1;
  }

  public start(): void {
    if (this.disposed) return;
    if (typeof WebSocket === "undefined" && !this.createWebSocket) {
      this.enterFallback("当前环境不支持 WebSocket");
      return;
    }
    this.bindVisibility();
    void this.connect();
  }

  public retryNow(): void {
    if (this.disposed) return;
    this.consecutiveFailures = 0;
    this.clearReconnectTimer();
    void this.connect();
  }

  /** Immediately close WS and degrade to HTTP polling fallback (e.g. CDP_UNAVAILABLE). */
  public degradeToFallback(reason: string): void {
    if (this.disposed) return;
    this.connGen += 1;
    this.readyThisGen = false;
    this.abortTicket();
    this.closeSocket();
    this.enterFallback(reason);
  }

  public send(msg: LiveBrowserClientMessage): boolean {
    if (this.disposed || !this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.connGen += 1;
    this.clearAllTimers();
    this.unbindVisibility();
    this.abortTicket();
    this.closeSocket();
    this.setStatus("closed");
  }

  private setStatus(next: LiveBrowserConnectionStatus, detail?: string): void {
    if (this.status === next && !detail) return;
    this.status = next;
    this.callbacks.onStatus?.(next, detail);
    if (next === "fallback" || next === "connected") {
      this.emitStats(true);
    }
  }

  private abortTicket(): void {
    if (this.ticketAbort) {
      this.ticketAbort.abort();
      this.ticketAbort = null;
    }
  }

  private closeSocket(): void {
    const sock = this.ws;
    this.ws = null;
    if (!sock) return;
    sock.onopen = null;
    sock.onmessage = null;
    sock.onerror = null;
    sock.onclose = null;
    try {
      if (sock.readyState === 0 || sock.readyState === 1) {
        sock.close(1000, "client dispose");
      }
    } catch {
      /* ignore close errors */
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      globalThis.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearPingTimer(): void {
    if (this.pingTimer !== null) {
      globalThis.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearStatsTimer(): void {
    if (this.statsTimer !== null) {
      globalThis.clearTimeout(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private clearAllTimers(): void {
    this.clearReconnectTimer();
    this.clearPingTimer();
    this.clearStatsTimer();
  }

  private readonly onVisibilityChange = (): void => {
    if (this.disposed || typeof document === "undefined") return;
    if (!document.hidden && this.status === "reconnecting") {
      this.clearReconnectTimer();
      void this.connect();
    }
  };

  private bindVisibility(): void {
    if (this.visibilityBound || typeof document === "undefined") return;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.visibilityBound = true;
  }

  private unbindVisibility(): void {
    if (!this.visibilityBound || typeof document === "undefined") return;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.visibilityBound = false;
  }

  private async connect(): Promise<void> {
    if (this.disposed) return;
    const gen = ++this.connGen;
    this.readyThisGen = false;
    this.clearAllTimers();
    this.abortTicket();
    this.closeSocket();

    this.setStatus(this.hasEverReady ? "reconnecting" : "connecting");

    const abort = new AbortController();
    this.ticketAbort = abort;

    let ticketResp: LiveBrowserStreamTicketResponse;
    try {
      ticketResp = await this.requestTicket(this.getAuth(), this.agentId, abort.signal);
    } catch (err) {
      if (this.disposed || gen !== this.connGen) return;
      this.handleConnectFailure(errorReason(err), gen);
      return;
    } finally {
      if (this.ticketAbort === abort) this.ticketAbort = null;
    }

    if (this.disposed || gen !== this.connGen) return;
    if (!ticketResp?.ticket) {
      this.handleConnectFailure("实时流票据为空", gen);
      return;
    }

    const protocol = ticketResp.protocol || LIVE_BROWSER_TICKET_PROTOCOL;
    const wsUrl = buildLiveBrowserWsUrl(
      ticketResp.wsPath || LIVE_BROWSER_PUBLIC_WS_PATH,
      this.locationOrigin,
    );

    let sock: WebSocket;
    try {
      sock = this.createWebSocket(wsUrl, [protocol, `ticket.${ticketResp.ticket}`]);
    } catch (err) {
      if (this.disposed || gen !== this.connGen) return;
      this.handleConnectFailure(errorReason(err), gen);
      return;
    }

    sock.binaryType = "arraybuffer";
    this.ws = sock;

    sock.onopen = () => {
      if (this.disposed || gen !== this.connGen) {
        try {
          sock.close(1000, "stale generation");
        } catch {
          /* ignore */
        }
        return;
      }
      // Do NOT clear consecutiveFailures or declare connected on transport open alone:
      // wait for the container end-to-end `ready` message to confirm the bridge succeeded.
      this.lastFrameSeq = 0;
      this.frameTimestamps = [];
      this.startHeartbeat(gen);
    };

    sock.onmessage = (event: MessageEvent) => {
      if (this.disposed || gen !== this.connGen) return;
      this.handleMessage(event.data, gen);
    };

    sock.onerror = () => {
      if (this.disposed || gen !== this.connGen) return;
      // onclose always follows onerror in standard WebSocket; defer backoff there.
    };

    sock.onclose = (ev: CloseEvent) => {
      if (this.disposed || gen !== this.connGen) return;
      this.ws = null;
      this.clearPingTimer();
      const rawReason = ev.reason || "";
      // Terminal state: superseded cleanly by a newer tab/connection — never auto-kick it back.
      if (ev.code === 1000 && /replaced/i.test(rawReason)) {
        this.readyThisGen = false;
        this.clearAllTimers();
        this.setStatus("replaced", rawReason || "已在其他标签页接管");
        return;
      }
      const reason = rawReason || (ev.code === 1006 ? "连接已断开" : `连接关闭 (${ev.code})`);
      if (!this.readyThisGen) {
        this.handleConnectFailure(reason, gen);
      } else {
        this.readyThisGen = false;
        this.consecutiveFailures += 1;
        this.scheduleReconnect(reason, gen);
      }
    };
  }

  private handleMessage(data: unknown, gen: number): void {
    if (typeof data === "string") {
      let msg: LiveBrowserServerMessage;
      try {
        msg = JSON.parse(data) as LiveBrowserServerMessage;
      } catch {
        return;
      }
      this.handleJsonMessage(msg);
      return;
    }

    if (data instanceof ArrayBuffer) {
      this.handleBinaryPayload(data);
      return;
    }

    if (ArrayBuffer.isView(data)) {
      const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.handleBinaryPayload(view);
      return;
    }

    if (typeof Blob !== "undefined" && data instanceof Blob) {
      void data.arrayBuffer().then((buf) => {
        if (this.disposed || gen !== this.connGen) return;
        this.handleBinaryPayload(buf);
      });
    }
  }

  private handleJsonMessage(msg: LiveBrowserServerMessage): void {
    switch (msg.type) {
      case "ready":
        this.lastFrameSeq = 0;
        if (msg.state?.cdpAvailable === false) {
          this.callbacks.onState?.(msg.state, true);
          this.degradeToFallback("CDP_UNAVAILABLE");
          return;
        }
        this.readyThisGen = true;
        this.hasEverReady = true;
        this.consecutiveFailures = 0;
        this.setStatus("connected");
        if (msg.state) {
          this.callbacks.onState?.(msg.state, true);
        }
        break;
      case "state":
        this.callbacks.onState?.(msg, false);
        if (msg.cdpAvailable === false) {
          this.degradeToFallback("CDP_UNAVAILABLE");
        }
        break;
      case "cursor":
        if (typeof msg.cursor === "string") {
          this.callbacks.onCursor?.(msg.cursor);
        }
        break;
      case "handoff_ready":
        if (typeof msg.signal === "string" && typeof msg.url === "string") {
          this.callbacks.onHandoffReady?.(msg);
        }
        break;
      case "handoff_vetoed":
        if (typeof msg.reason === "string") {
          this.callbacks.onHandoffVetoed?.(msg);
        }
        break;
      case "error":
        this.callbacks.onError?.(msg.message || "云端浏览器发生错误", msg.code, msg.retryable);
        if (msg.code === "CDP_UNAVAILABLE") {
          this.degradeToFallback(msg.message || "CDP_UNAVAILABLE");
        }
        break;
      case "pong":
        if (typeof msg.ts === "number") {
          this.rttMs = Math.max(0, Date.now() - msg.ts);
          this.emitStats(true);
        }
        break;
    }
  }

  private handleBinaryPayload(buf: ArrayBuffer | Uint8Array): void {
    let frame: LiveBrowserDecodedFrame;
    try {
      frame = decodeLiveBrowserFrame(buf);
    } catch {
      return;
    }
    // Monotonic seq filter: drop stale/out-of-order frames.
    if (frame.seq > 0 && frame.seq <= this.lastFrameSeq) return;
    this.lastFrameSeq = frame.seq;

    const now = Date.now();
    this.lastFrameAt = now;
    this.frameTimestamps.push(now);
    const cutoff = now - FPS_WINDOW_MS;
    while (this.frameTimestamps.length > 0 && (this.frameTimestamps[0] ?? 0) < cutoff) {
      this.frameTimestamps.shift();
    }

    this.callbacks.onFrame?.(frame);
    this.emitStats(false);
  }

  private emitStats(force: boolean): void {
    const now = Date.now();
    const cutoff = now - FPS_WINDOW_MS;
    while (this.frameTimestamps.length > 0 && (this.frameTimestamps[0] ?? 0) < cutoff) {
      this.frameTimestamps.shift();
    }
    const payload: LiveBrowserStreamStats = {
      fps: this.status === "connected" ? this.frameTimestamps.length : 0,
      rttMs: this.status === "connected" ? this.rttMs : null,
      lastFrameAt: this.lastFrameAt,
      mode: this.status === "connected" ? "ws" : "polling",
    };

    if (force || now - this.lastStatsEmittedAt >= STATS_THROTTLE_MS) {
      this.lastStatsEmittedAt = now;
      this.clearStatsTimer();
      this.callbacks.onStats?.(payload);
      return;
    }

    if (this.statsTimer === null) {
      this.statsTimer = globalThis.setTimeout(() => {
        this.statsTimer = null;
        if (this.disposed) return;
        this.emitStats(true);
      }, STATS_THROTTLE_MS - (now - this.lastStatsEmittedAt));
    }
  }

  private startHeartbeat(gen: number): void {
    this.clearPingTimer();
    this.send({ type: "ping", ts: Date.now() });
    this.pingTimer = globalThis.setInterval(() => {
      if (this.disposed || gen !== this.connGen) {
        this.clearPingTimer();
        return;
      }
      this.send({ type: "ping", ts: Date.now() });
    }, this.pingIntervalMs);
  }

  private handleConnectFailure(reason: string, gen: number): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.maxFailuresBeforeFallback) {
      this.enterFallback(reason);
      return;
    }
    this.scheduleReconnect(reason, gen);
  }

  private scheduleReconnect(reason: string, gen: number): void {
    if (this.disposed || gen !== this.connGen) return;
    if (this.consecutiveFailures >= this.maxFailuresBeforeFallback + 1) {
      this.enterFallback(reason);
      return;
    }
    this.setStatus("reconnecting", reason);
    const delay = Math.min(
      MAX_BACKOFF_MS,
      BASE_BACKOFF_MS * 2 ** Math.min(Math.max(0, this.consecutiveFailures - 1), 4),
    );
    this.clearReconnectTimer();
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || gen !== this.connGen) return;
      if (typeof document !== "undefined" && document.hidden) return;
      void this.connect();
    }, delay);
  }

  private enterFallback(reason: string): void {
    this.clearAllTimers();
    this.setStatus("fallback", reason);
    this.callbacks.onFallback?.(reason);
    const gen = this.connGen;
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || gen !== this.connGen) return;
      if (typeof document !== "undefined" && document.hidden) return;
      this.consecutiveFailures = 0;
      void this.connect();
    }, FALLBACK_UPGRADE_PROBE_MS);
  }
}
