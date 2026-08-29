/**
 * Desktop-side mux peer: OPEN_HTTP/OPEN_WS from master are forwarded to a local origin.
 */

import http from "node:http";
import WebSocket from "ws";
import {
  FLAG_FIN,
  MuxType,
  decodeFrames,
  encodeFrame,
  encodeJsonFrame,
  parseJsonPayload,
  type MuxTransport,
} from "./desktopMux.js";
import { HEARTBEAT_INTERVAL_MS } from "./desktopMux.js";

export interface DesktopMuxResponderOpts {
  localOrigin: string;
  transport: MuxTransport;
}

export function attachDesktopMuxResponder(opts: DesktopMuxResponderOpts): { close: () => void } {
  const origin = new URL(opts.localOrigin);
  let buf = Buffer.alloc(0);
  const pendingHttp = new Map<number, { method: string; path: string; headers: Record<string, string>; chunks: Buffer[] }>();
  const localWs = new Map<number, WebSocket>();
  let closed = false;

  const sendBeat = () => {
    if (closed) return;
    opts.transport.send(encodeJsonFrame(MuxType.HEARTBEAT, 0, { ts: Date.now() }));
  };
  sendBeat();
  const beat = setInterval(sendBeat, HEARTBEAT_INTERVAL_MS);
  beat.unref?.();

  const onMsg = (data: unknown) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    let frames;
    try {
      const decoded = decodeFrames(buf);
      frames = decoded.frames;
      buf = decoded.rest;
    } catch {
      return;
    }
    for (const f of frames) onFrame(f);
  };
  opts.transport.on("message", onMsg);
  opts.transport.on("close", () => close());

  function onFrame(frame: { type: number; flags: number; streamId: number; payload: Buffer }): void {
    if (frame.type === MuxType.OPEN_HTTP) {
      let obj: Record<string, unknown>;
      try { obj = parseJsonPayload(frame.payload); } catch { return; }
      pendingHttp.set(frame.streamId, {
        method: String(obj.method ?? "GET"),
        path: String(obj.path ?? "/"),
        headers: (obj.headers && typeof obj.headers === "object" && !Array.isArray(obj.headers)
          ? obj.headers as Record<string, string>
          : {}),
        chunks: [],
      });
      return;
    }
    if (frame.type === MuxType.HTTP_DATA) {
      const p = pendingHttp.get(frame.streamId);
      if (!p) return;
      p.chunks.push(frame.payload);
      if (frame.flags & FLAG_FIN) {
        pendingHttp.delete(frame.streamId);
        void dispatchHttp(frame.streamId, p);
      }
      return;
    }
    if (frame.type === MuxType.OPEN_WS) {
      let obj: Record<string, unknown>;
      try { obj = parseJsonPayload(frame.payload); } catch { return; }
      const path = String(obj.path ?? "/ws");
      const wsUrl = `ws://${origin.hostname}:${origin.port}${path}`;
      const sock = new WebSocket(wsUrl);
      localWs.set(frame.streamId, sock);
      sock.on("message", (raw, isBinary) => {
        const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        opts.transport.send(encodeJsonFrame(MuxType.WS_DATA, frame.streamId, {
          opcode: isBinary ? 2 : 1,
          data: data.toString("base64"),
        }));
      });
      sock.on("close", (code, reason) => {
        opts.transport.send(encodeJsonFrame(MuxType.WS_CLOSE, frame.streamId, {
          code,
          reason: reason.toString(),
        }));
        localWs.delete(frame.streamId);
      });
      return;
    }
    if (frame.type === MuxType.WS_DATA) {
      const sock = localWs.get(frame.streamId);
      if (!sock || sock.readyState !== WebSocket.OPEN) return;
      try {
        const obj = parseJsonPayload(frame.payload);
        const data = Buffer.from(String(obj.data ?? ""), "base64");
        sock.send(data, { binary: obj.opcode === 2 });
      } catch { /* */ }
      return;
    }
    if (frame.type === MuxType.WS_CLOSE || frame.type === MuxType.RESET_STREAM || frame.type === MuxType.GOAWAY) {
      const sock = localWs.get(frame.streamId);
      try { sock?.close(); } catch { /* */ }
      localWs.delete(frame.streamId);
    }
  }

  function dispatchHttp(streamId: number, p: { method: string; path: string; headers: Record<string, string>; chunks: Buffer[] }): Promise<void> {
    const body = Buffer.concat(p.chunks);
    return new Promise((resolve) => {
      const req = http.request({
        hostname: origin.hostname,
        port: origin.port,
        path: p.path,
        method: p.method,
        headers: p.headers,
      }, (res) => {
        const headerList = Object.entries(res.headers).flatMap(([k, v]) => {
          if (v === undefined) return [];
          const val = Array.isArray(v) ? v.join(",") : v;
          return [{ k, v: val }];
        });
        opts.transport.send(encodeJsonFrame(MuxType.HTTP_RESPONSE_START, streamId, {
          status: res.statusCode ?? 500,
          headers: headerList,
        }));
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const bufOut = Buffer.concat(chunks);
          if (bufOut.length > 0) {
            opts.transport.send(encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, streamId, bufOut));
          } else {
            opts.transport.send(encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, streamId, Buffer.alloc(0)));
          }
          opts.transport.send(encodeFrame(MuxType.HTTP_END, 0, streamId));
          resolve();
        });
      });
      req.on("error", () => {
        opts.transport.send(encodeJsonFrame(MuxType.HTTP_RESPONSE_START, streamId, { status: 502, headers: [] }));
        opts.transport.send(encodeFrame(MuxType.HTTP_END, 0, streamId));
        resolve();
      });
      if (body.length) req.write(body);
      req.end();
    });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    clearInterval(beat);
    for (const s of localWs.values()) {
      try { s.close(); } catch { /* */ }
    }
    localWs.clear();
  }

  return { close };
}
