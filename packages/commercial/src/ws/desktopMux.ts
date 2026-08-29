/**
 * oc-desktop-mux/1 — versioned reverse-tunnel frames (design v2 §4.4).
 *
 * Header (big-endian, 10 bytes): u8 type | u8 flags | u32 streamId | u32 payloadLen
 * flags.bit0 = FIN (last DATA chunk in that direction).
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";

export const MUX_VERSION = 1;
export const MUX_PROTOCOL_NAME = "oc-desktop-mux/1";
export const FRAME_HEADER_SIZE = 10;
export const MAX_FRAME_PAYLOAD = 64 * 1024;
export const MAX_HTTP_BODY = 64 * 1024;
export const MAX_STREAMS_PER_TUNNEL = 32;
export const FLAG_FIN = 0x01;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 45_000;

export const MuxType = {
  OPEN_HTTP: 0x01,
  HTTP_RESPONSE_START: 0x02,
  HTTP_DATA: 0x03,
  HTTP_END: 0x04,
  RESET_STREAM: 0x05,
  OPEN_WS: 0x11,
  WS_DATA: 0x12,
  WS_CLOSE: 0x13,
  HEARTBEAT: 0x20,
  HEARTBEAT_ACK: 0x21,
  GOAWAY: 0x30,
} as const;

export type MuxTypeId = (typeof MuxType)[keyof typeof MuxType];

const KNOWN_TYPES = new Set<number>(Object.values(MuxType));

export class MuxProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly streamId = 0,
  ) {
    super(message);
    this.name = "MuxProtocolError";
  }
}

export interface MuxFrame {
  type: number;
  flags: number;
  streamId: number;
  payload: Buffer;
}

export function encodeFrame(type: number, flags: number, streamId: number, payload: Buffer | Uint8Array = Buffer.alloc(0)): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > MAX_FRAME_PAYLOAD) {
    throw new MuxProtocolError("BODY_TOO_LARGE", `payload ${body.length} > ${MAX_FRAME_PAYLOAD}`, streamId);
  }
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) {
    throw new MuxProtocolError("PROTOCOL", `bad streamId ${streamId}`, streamId);
  }
  const buf = Buffer.allocUnsafe(FRAME_HEADER_SIZE + body.length);
  buf.writeUInt8(type & 0xff, 0);
  buf.writeUInt8(flags & 0xff, 1);
  buf.writeUInt32BE(streamId >>> 0, 2);
  buf.writeUInt32BE(body.length, 6);
  body.copy(buf, FRAME_HEADER_SIZE);
  return buf;
}

export function encodeJsonFrame(type: number, streamId: number, obj: unknown, flags = 0): Buffer {
  return encodeFrame(type, flags, streamId, Buffer.from(JSON.stringify(obj), "utf8"));
}

export function decodeFrames(buf: Buffer): { frames: MuxFrame[]; rest: Buffer } {
  const frames: MuxFrame[] = [];
  let offset = 0;
  while (offset + FRAME_HEADER_SIZE <= buf.length) {
    const type = buf.readUInt8(offset);
    const flags = buf.readUInt8(offset + 1);
    const streamId = buf.readUInt32BE(offset + 2);
    const payloadLen = buf.readUInt32BE(offset + 6);
    if (payloadLen > MAX_FRAME_PAYLOAD) {
      throw new MuxProtocolError("BODY_TOO_LARGE", `declared payloadLen ${payloadLen}`, streamId);
    }
    if (offset + FRAME_HEADER_SIZE + payloadLen > buf.length) break;
    const payload = Buffer.from(buf.subarray(offset + FRAME_HEADER_SIZE, offset + FRAME_HEADER_SIZE + payloadLen));
    frames.push({ type, flags, streamId, payload });
    offset += FRAME_HEADER_SIZE + payloadLen;
  }
  return { frames, rest: offset === 0 ? buf : Buffer.from(buf.subarray(offset)) };
}

export function parseJsonPayload(payload: Buffer): Record<string, unknown> {
  const text = payload.toString("utf8");
  const v = JSON.parse(text) as unknown;
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new MuxProtocolError("PROTOCOL", "JSON payload must be an object");
  }
  return v as Record<string, unknown>;
}

export interface MuxTransport {
  send(data: Buffer): void;
  close(code?: number, reason?: string): void;
  terminate?: () => void;
  on(event: "message" | "close" | "error", cb: (...args: unknown[]) => void): void;
  off?(event: "message" | "close" | "error", cb: (...args: unknown[]) => void): void;
}

export interface OpenHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Buffer | string | null;
  deadlineMs: number;
}

export interface MuxHttpResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

export interface MuxSessionHooks {
  onHeartbeat?: (payload: Record<string, unknown>) => boolean | Promise<boolean>;
  onActivity?: () => void;
  onClose?: (reason: string) => void;
  maxFrameBytes?: number;
}

interface HttpWaiter {
  status?: number;
  headers: Record<string, string>;
  chunks: Buffer[];
  resolve: (v: MuxHttpResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sawStart: boolean;
  bytes: number;
}

/**
 * Minimal EventEmitter that duck-types `ws` WebSocket enough for userChatBridge.
 */
export class DesktopBridgedSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  constructor(private readonly sendFn: (data: Buffer, isBinary: boolean) => void, private readonly closeFn: (code?: number, reason?: string) => void) {
    super();
  }
  markOpen(): void {
    if (this.readyState !== WebSocket.CONNECTING) return;
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }
  pushMessage(data: Buffer, isBinary: boolean): void {
    if (this.readyState !== WebSocket.OPEN) return;
    this.emit("message", data, isBinary);
  }
  send(data: Buffer | string | ArrayBuffer, opts?: { binary?: boolean }, cb?: (err?: Error) => void): void {
    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const binary = opts?.binary ?? true;
      this.sendFn(buf, binary);
      cb?.();
    } catch (err) {
      cb?.(err as Error);
    }
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSING;
    this.closeFn(code, reason);
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code ?? 1000, Buffer.from(reason ?? "", "utf8"));
  }
  terminate(): void {
    this.close(1006, "terminated");
  }
}

export class DesktopMuxSession {
  private buf: Buffer = Buffer.alloc(0);
  private nextOdd = 1;
  private readonly streams = new Map<number, { kind: "http" | "ws" }>();
  private readonly httpWait = new Map<number, HttpWaiter>();
  private readonly wsStreams = new Map<number, DesktopBridgedSocket>();
  private closed = false;
  private lastBeat = Date.now();
  private readonly beatWatch: ReturnType<typeof setInterval>;
  private readonly maxFrameBytes: number;

  constructor(
    private readonly transport: MuxTransport,
    private readonly hooks: MuxSessionHooks = {},
  ) {
    this.maxFrameBytes = hooks.maxFrameBytes ?? MAX_HTTP_BODY;
    const onMsg = (data: unknown) => {
      try {
        const raw = toBuffer(data);
        this.pushBytes(raw);
      } catch (err) {
        this.failClosed(err);
      }
    };
    const onClose = () => this.shutdown("peer_close");
    transport.on("message", onMsg);
    transport.on("close", onClose);
    this.beatWatch = setInterval(() => {
      if (this.closed) return;
      if (Date.now() - this.lastBeat > HEARTBEAT_TIMEOUT_MS) {
        this.failClosed(new MuxProtocolError("HEARTBEAT_TIMEOUT", "no heartbeat within 45s"));
      }
    }, 5_000);
    this.beatWatch.unref?.();
  }

  get size(): number {
    return this.streams.size;
  }

  async http(req: OpenHttpRequest, timeoutMs?: number): Promise<MuxHttpResponse> {
    if (this.closed) throw new MuxProtocolError("CLOSED", "mux session closed");
    if (this.streams.size >= MAX_STREAMS_PER_TUNNEL) {
      this.goaway("too many streams");
      throw new MuxProtocolError("STREAM_LIMIT", "max 32 streams");
    }
    const streamId = this.allocOdd();
    this.streams.set(streamId, { kind: "http" });
    const bodyBuf = req.body == null ? Buffer.alloc(0) : Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body, "utf8");
    if (bodyBuf.length > MAX_HTTP_BODY) {
      this.reset(streamId, "BODY_TOO_LARGE", "request body too large");
      throw new MuxProtocolError("BODY_TOO_LARGE", "request body too large", streamId);
    }
    const deadline = req.deadlineMs;
    this.send(encodeJsonFrame(MuxType.OPEN_HTTP, streamId, {
      method: req.method,
      path: req.path,
      headers: req.headers,
      deadlineMs: deadline,
    }));
    if (bodyBuf.length > 0) {
      this.send(encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, streamId, bodyBuf));
    } else {
      this.send(encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, streamId, Buffer.alloc(0)));
    }
    const waitMs = Math.max(1, timeoutMs ?? Math.max(1, deadline - Date.now()));
    return new Promise<MuxHttpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.reset(streamId, "TIMEOUT", "OPEN_HTTP deadline");
        reject(new MuxProtocolError("TRANSPORT_TIMEOUT_ERROR", "desktop mux HTTP timeout", streamId));
      }, waitMs);
      this.httpWait.set(streamId, {
        headers: {},
        chunks: [],
        resolve,
        reject,
        timer,
        sawStart: false,
        bytes: 0,
      });
    });
  }

  openWs(path: string): DesktopBridgedSocket {
    if (this.closed) throw new MuxProtocolError("CLOSED", "mux session closed");
    if (this.streams.size >= MAX_STREAMS_PER_TUNNEL) {
      this.goaway("too many streams");
      throw new MuxProtocolError("STREAM_LIMIT", "max 32 streams");
    }
    const streamId = this.allocOdd();
    this.streams.set(streamId, { kind: "ws" });
    const sock = new DesktopBridgedSocket(
      (data, isBinary) => {
        if (data.length > this.maxFrameBytes) {
          this.reset(streamId, "BODY_TOO_LARGE", "ws frame too large");
          return;
        }
        this.send(encodeJsonFrame(MuxType.WS_DATA, streamId, {
          opcode: isBinary ? 2 : 1,
          data: data.toString("base64"),
        }));
      },
      (code, reason) => {
        this.send(encodeJsonFrame(MuxType.WS_CLOSE, streamId, { code: code ?? 1000, reason: reason ?? "" }));
        this.finishStream(streamId);
      },
    );
    this.wsStreams.set(streamId, sock);
    this.send(encodeJsonFrame(MuxType.OPEN_WS, streamId, { path }));
    queueMicrotask(() => sock.markOpen());
    return sock;
  }

  close(reason = "goaway"): void {
    if (this.closed) return;
    this.goaway(reason);
    this.shutdown(reason);
  }

  private allocOdd(): number {
    const id = this.nextOdd;
    this.nextOdd += 2;
    if (this.nextOdd > 0x7fffffff) {
      this.goaway("stream id exhausted");
      throw new MuxProtocolError("GOAWAY", "stream id exhausted");
    }
    return id;
  }

  private send(frame: Buffer): void {
    if (this.closed) return;
    this.transport.send(frame);
  }

  private pushBytes(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
    const { frames, rest } = decodeFrames(this.buf);
    this.buf = Buffer.from(rest);
    for (const f of frames) this.onFrame(f);
  }

  private onFrame(frame: MuxFrame): void {
    if (!KNOWN_TYPES.has(frame.type)) {
      this.reset(frame.streamId, "PROTOCOL", `unknown type 0x${frame.type.toString(16)}`);
      this.failClosed(new MuxProtocolError("PROTOCOL", `unknown type ${frame.type}`, frame.streamId));
      return;
    }
    if (frame.type === MuxType.HEARTBEAT) {
      void this.onHeartbeat(frame);
      return;
    }
    if (frame.type === MuxType.GOAWAY) {
      this.shutdown("goaway");
      return;
    }
    if (frame.streamId === 0 && frame.type !== MuxType.HEARTBEAT_ACK) {
      this.failClosed(new MuxProtocolError("PROTOCOL", "streamId 0 reserved", 0));
      return;
    }
    switch (frame.type) {
      case MuxType.HTTP_RESPONSE_START:
        this.onResponseStart(frame);
        break;
      case MuxType.HTTP_DATA:
        this.onHttpData(frame);
        break;
      case MuxType.HTTP_END:
        this.onHttpEnd(frame);
        break;
      case MuxType.RESET_STREAM:
        this.onReset(frame);
        break;
      case MuxType.WS_DATA:
        this.onWsData(frame);
        break;
      case MuxType.WS_CLOSE:
        this.onWsClose(frame);
        break;
      case MuxType.HEARTBEAT_ACK:
        this.lastBeat = Date.now();
        break;
      default:
        this.reset(frame.streamId, "PROTOCOL", `unexpected type ${frame.type}`);
        break;
    }
  }

  private async onHeartbeat(frame: MuxFrame): Promise<void> {
    this.lastBeat = Date.now();
    let payload: Record<string, unknown> = {};
    try {
      if (frame.payload.length > 0) payload = parseJsonPayload(frame.payload);
    } catch {
      this.failClosed(new MuxProtocolError("PROTOCOL", "bad heartbeat json"));
      return;
    }
    const ok = this.hooks.onHeartbeat ? await this.hooks.onHeartbeat(payload) : true;
    if (!ok) {
      this.failClosed(new MuxProtocolError("EXPIRED", "heartbeat rejected"));
      return;
    }
    this.hooks.onActivity?.();
    this.send(encodeJsonFrame(MuxType.HEARTBEAT_ACK, 0, { ts: payload.ts ?? Date.now(), serverNow: Date.now() }));
  }

  private onResponseStart(frame: MuxFrame): void {
    const w = this.httpWait.get(frame.streamId);
    if (!w) {
      this.reset(frame.streamId, "PROTOCOL", "RESPONSE_START for unknown stream");
      return;
    }
    if (w.sawStart) {
      this.reset(frame.streamId, "PROTOCOL", "duplicate RESPONSE_START");
      return;
    }
    let obj: Record<string, unknown>;
    try {
      obj = parseJsonPayload(frame.payload);
    } catch {
      this.reset(frame.streamId, "PROTOCOL", "bad RESPONSE_START json");
      return;
    }
    const status = obj.status;
    if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
      this.reset(frame.streamId, "PROTOCOL", "RESPONSE_START.status required");
      return;
    }
    w.sawStart = true;
    w.status = status;
    w.headers = headersFrom(obj.headers);
  }

  private onHttpData(frame: MuxFrame): void {
    const w = this.httpWait.get(frame.streamId);
    if (!w) {
      this.reset(frame.streamId, "PROTOCOL", "DATA for unknown stream");
      return;
    }
    if (!w.sawStart) {
      this.reset(frame.streamId, "PROTOCOL", "DATA before RESPONSE_START");
      w.reject(new MuxProtocolError("PROTOCOL", "DATA before RESPONSE_START", frame.streamId));
      this.finishHttp(frame.streamId);
      return;
    }
    w.bytes += frame.payload.length;
    if (w.bytes > MAX_HTTP_BODY) {
      this.reset(frame.streamId, "BODY_TOO_LARGE", "response body too large");
      w.reject(new MuxProtocolError("BODY_TOO_LARGE", "response body too large", frame.streamId));
      this.finishHttp(frame.streamId);
      return;
    }
    w.chunks.push(frame.payload);
  }

  private onHttpEnd(frame: MuxFrame): void {
    const w = this.httpWait.get(frame.streamId);
    if (!w) {
      this.reset(frame.streamId, "PROTOCOL", "END for unknown stream");
      return;
    }
    if (!w.sawStart) {
      this.reset(frame.streamId, "PROTOCOL", "END before RESPONSE_START");
      w.reject(new MuxProtocolError("PROTOCOL", "END before RESPONSE_START", frame.streamId));
      this.finishHttp(frame.streamId);
      return;
    }
    clearTimeout(w.timer);
    w.resolve({
      status: w.status ?? 500,
      headers: w.headers,
      bodyText: Buffer.concat(w.chunks).toString("utf8"),
    });
    this.finishHttp(frame.streamId);
  }

  private onReset(frame: MuxFrame): void {
    const w = this.httpWait.get(frame.streamId);
    if (w) {
      clearTimeout(w.timer);
      w.reject(new MuxProtocolError("RESET_STREAM", frame.payload.toString("utf8").slice(0, 200), frame.streamId));
      this.finishHttp(frame.streamId);
    }
    const sock = this.wsStreams.get(frame.streamId);
    if (sock) {
      sock.terminate();
      this.wsStreams.delete(frame.streamId);
    }
    this.streams.delete(frame.streamId);
  }

  private onWsData(frame: MuxFrame): void {
    const sock = this.wsStreams.get(frame.streamId);
    if (!sock) {
      this.reset(frame.streamId, "PROTOCOL", "WS_DATA for unknown stream");
      return;
    }
    let obj: Record<string, unknown>;
    try {
      obj = parseJsonPayload(frame.payload);
    } catch {
      this.reset(frame.streamId, "PROTOCOL", "bad WS_DATA");
      return;
    }
    const b64 = typeof obj.data === "string" ? obj.data : "";
    const data = Buffer.from(b64, "base64");
    if (data.length > this.maxFrameBytes) {
      this.reset(frame.streamId, "BODY_TOO_LARGE", "ws frame too large");
      return;
    }
    sock.pushMessage(data, obj.opcode === 2);
  }

  private onWsClose(frame: MuxFrame): void {
    const sock = this.wsStreams.get(frame.streamId);
    if (sock) {
      sock.close(1000, "peer");
      this.wsStreams.delete(frame.streamId);
    }
    this.streams.delete(frame.streamId);
  }

  private reset(streamId: number, code: string, message: string): void {
    this.send(encodeJsonFrame(MuxType.RESET_STREAM, streamId, { code, message }));
  }

  private goaway(message: string): void {
    try {
      this.send(encodeJsonFrame(MuxType.GOAWAY, 0, { message }));
    } catch { /* ignore */ }
  }

  private finishHttp(streamId: number): void {
    const w = this.httpWait.get(streamId);
    if (w) clearTimeout(w.timer);
    this.httpWait.delete(streamId);
    this.streams.delete(streamId);
  }

  private finishStream(streamId: number): void {
    this.streams.delete(streamId);
    this.wsStreams.delete(streamId);
  }

  private failClosed(err: unknown): void {
    this.shutdown(err instanceof Error ? err.message : "protocol");
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.beatWatch);
    for (const [id, w] of this.httpWait) {
      clearTimeout(w.timer);
      w.reject(new MuxProtocolError("CLOSED", reason, id));
    }
    this.httpWait.clear();
    for (const sock of this.wsStreams.values()) {
      try { sock.terminate(); } catch { /* */ }
    }
    this.wsStreams.clear();
    this.streams.clear();
    try { this.transport.close(4001, reason.slice(0, 120)); } catch { /* */ }
    this.hooks.onClose?.(reason);
  }
}

function headersFrom(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const rec = item as { k?: unknown; v?: unknown };
      if (typeof rec.k === "string" && typeof rec.v === "string") out[rec.k.toLowerCase()] = rec.v;
    }
    return out;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k.toLowerCase()] = v;
    }
  }
  return out;
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data.filter((x): x is Buffer => Buffer.isBuffer(x)));
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data && typeof data === "object" && "data" in (data as object)) {
    return toBuffer((data as { data: unknown }).data);
  }
  return Buffer.from(String(data ?? ""), "utf8");
}

/** Test helper: two MuxTransports that echo to each other. */
export function createMuxLoopbackPair(): { master: MuxTransport; desktop: MuxTransport } {
  const masterListeners: { message: Array<(...a: unknown[]) => void>; close: Array<(...a: unknown[]) => void> } = { message: [], close: [] };
  const deskListeners: { message: Array<(...a: unknown[]) => void>; close: Array<(...a: unknown[]) => void> } = { message: [], close: [] };
  let closed = false;
  const make = (
    self: typeof masterListeners,
    peer: typeof masterListeners,
  ): MuxTransport => ({
    send(data) {
      if (closed) return;
      queueMicrotask(() => {
        for (const cb of peer.message) cb(Buffer.from(data));
      });
    },
    close() {
      if (closed) return;
      closed = true;
      queueMicrotask(() => {
        for (const cb of peer.close) cb();
        for (const cb of self.close) cb();
      });
    },
    on(event, cb) {
      if (event === "message") self.message.push(cb);
      if (event === "close") self.close.push(cb);
    },
  });
  return { master: make(masterListeners, deskListeners), desktop: make(deskListeners, masterListeners) };
}
