import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DesktopMuxSession,
  FLAG_FIN,
  MAX_FRAME_PAYLOAD,
  MuxProtocolError,
  MuxType,
  createMuxLoopbackPair,
  decodeFrames,
  encodeFrame,
  encodeJsonFrame,
} from "../ws/desktopMux.js";

function drain(): Promise<void> {
  return new Promise((r) => setTimeout(r, 5));
}

describe("mux codec golden vectors", () => {
  test("OPEN_HTTP → RESPONSE_START → DATA → END", async () => {
    const pair = createMuxLoopbackPair();
    const master = new DesktopMuxSession(pair.master, { onHeartbeat: () => true });
    pair.desktop.on("message", (raw) => {
      const { frames } = decodeFrames(raw as Buffer);
      for (const f of frames) {
        if (f.type === MuxType.OPEN_HTTP) {
          pair.desktop.send(encodeJsonFrame(MuxType.HTTP_RESPONSE_START, f.streamId, {
            status: 200,
            headers: [{ k: "content-type", v: "text/plain" }],
          }));
          pair.desktop.send(encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, f.streamId, Buffer.from("pong", "utf8")));
          pair.desktop.send(encodeFrame(MuxType.HTTP_END, 0, f.streamId, Buffer.alloc(0)));
        }
      }
    });
    const res = await master.http({
      method: "POST",
      path: "/healthz",
      headers: {},
      body: "ping",
      deadlineMs: Date.now() + 2_000,
    }, 2_000);
    assert.equal(res.status, 200);
    assert.equal(res.bodyText, "pong");
    assert.equal(res.headers["content-type"], "text/plain");
    master.close();
  });

  test("DATA before RESPONSE_START is protocol error", async () => {
    const pair = createMuxLoopbackPair();
    const master = new DesktopMuxSession(pair.master);
    pair.desktop.on("message", (raw) => {
      const { frames } = decodeFrames(raw as Buffer);
      for (const f of frames) {
        if (f.type === MuxType.OPEN_HTTP) {
          pair.desktop.send(encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, f.streamId, Buffer.from("x")));
        }
      }
    });
    await assert.rejects(
      () => master.http({ method: "GET", path: "/", headers: {}, deadlineMs: Date.now() + 2_000 }, 2_000),
      (e: unknown) => e instanceof MuxProtocolError && e.code === "PROTOCOL",
    );
    master.close();
  });

  test("oversized declared payloadLen fails closed", () => {
    const hdr = Buffer.alloc(10);
    hdr.writeUInt8(MuxType.HTTP_DATA, 0);
    hdr.writeUInt8(0, 1);
    hdr.writeUInt32BE(1, 2);
    hdr.writeUInt32BE(MAX_FRAME_PAYLOAD + 1, 6);
    assert.throws(
      () => decodeFrames(hdr),
      (e: unknown) => e instanceof MuxProtocolError && e.code === "BODY_TOO_LARGE",
    );
  });

  test("unknown type fail-closed", async () => {
    const pair = createMuxLoopbackPair();
    let closed = false;
    const master = new DesktopMuxSession(pair.master, { onClose: () => { closed = true; } });
    pair.desktop.send(encodeFrame(0x99, 0, 1, Buffer.from("nope")));
    await drain();
    assert.equal(closed, true);
  });

  test("RESET_STREAM cancels waiter", async () => {
    const pair = createMuxLoopbackPair();
    const master = new DesktopMuxSession(pair.master);
    pair.desktop.on("message", (raw) => {
      const { frames } = decodeFrames(raw as Buffer);
      for (const f of frames) {
        if (f.type === MuxType.OPEN_HTTP) {
          pair.desktop.send(encodeJsonFrame(MuxType.RESET_STREAM, f.streamId, { code: "CANCEL", message: "nope" }));
        }
      }
    });
    await assert.rejects(
      () => master.http({ method: "GET", path: "/", headers: {}, deadlineMs: Date.now() + 2_000 }, 2_000),
      (e: unknown) => e instanceof MuxProtocolError && e.code === "RESET_STREAM",
    );
    master.close();
  });

  test("fragmented DATA with FIN assembles body", async () => {
    const pair = createMuxLoopbackPair();
    const master = new DesktopMuxSession(pair.master);
    pair.desktop.on("message", (raw) => {
      const { frames } = decodeFrames(raw as Buffer);
      for (const f of frames) {
        if (f.type === MuxType.OPEN_HTTP) {
          pair.desktop.send(encodeJsonFrame(MuxType.HTTP_RESPONSE_START, f.streamId, { status: 201, headers: [] }));
          pair.desktop.send(encodeFrame(MuxType.HTTP_DATA, 0, f.streamId, Buffer.from("ab")));
          pair.desktop.send(encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, f.streamId, Buffer.from("cd")));
          pair.desktop.send(encodeFrame(MuxType.HTTP_END, 0, f.streamId));
        }
      }
    });
    const res = await master.http({ method: "GET", path: "/x", headers: {}, deadlineMs: Date.now() + 2_000 }, 2_000);
    assert.equal(res.status, 201);
    assert.equal(res.bodyText, "abcd");
    master.close();
  });
});
