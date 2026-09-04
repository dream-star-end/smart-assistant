import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMemoryDesktopTunnelRegistry } from "../ws/desktopTunnelRegistry.js";

describe("DesktopTunnelRegistry", () => {
  test("single slot kicks previous handle", () => {
    const reg = createMemoryDesktopTunnelRegistry();
    let closed = 0;
    reg.attach(1, { close: () => { closed += 1; } }, {
      deviceId: "d1", uid: 1, expiresAt: new Date(Date.now() + 60_000),
    });
    reg.attach(1, { close: () => {} }, {
      deviceId: "d1", uid: 1, expiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(closed, 1);
    assert.equal(reg.size(), 1);
  });

  test("expiry timer drops the slot", async () => {
    const reg = createMemoryDesktopTunnelRegistry();
    let closed = 0;
    reg.attach(3, { close: () => { closed += 1; } }, {
      deviceId: "d3", uid: 1, expiresAt: new Date(Date.now() + 25),
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(closed, 1);
    assert.equal(reg.get(3), undefined);
    assert.equal(reg.size(), 0);
  });

  test("http and openWs require an attached mux", async () => {
    const { DesktopMuxSession, MuxType, FLAG_FIN, encodeFrame, encodeJsonFrame, decodeFrames, createMuxLoopbackPair } = await import("../ws/desktopMux.js");
    const pair = createMuxLoopbackPair();
    const mux = new DesktopMuxSession(pair.master);
    pair.desktop.on("message", (raw) => {
      const { frames } = decodeFrames(raw as Buffer);
      for (const f of frames) {
        if (f.type === MuxType.OPEN_HTTP) {
          pair.desktop.send(encodeJsonFrame(MuxType.HTTP_RESPONSE_START, f.streamId, { status: 204, headers: [] }));
          pair.desktop.send(encodeFrame(MuxType.HTTP_END, FLAG_FIN, f.streamId));
        }
      }
    });
    const reg = createMemoryDesktopTunnelRegistry();
    assert.throws(() => { void reg.http(1, "GET", "/", {}, null, 500); }, /not attached/);
    reg.attach(1, { mux, close: () => {} }, {
      deviceId: "d1", uid: 1, expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await reg.http(1, "GET", "/healthz", {}, null, 2_000);
    assert.equal(res.status, 204);
    const sock = reg.openWs(1, "/ws");
    assert.equal(typeof sock.send, "function");
    mux.close();
  });

  test("drop closes handle and mint-style drop is idempotent", () => {
    const reg = createMemoryDesktopTunnelRegistry();
    let closed = 0;
    reg.attach(9, { close: () => { closed += 1; } }, {
      deviceId: "d9", uid: 2, expiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(reg.drop(9, "token_rotated"), true);
    assert.equal(closed, 1);
    assert.equal(reg.drop(9), false);
    assert.equal(reg.get(9), undefined);
  });

  test("drop(g) rejects later attach with generation <= g", () => {
    const reg = createMemoryDesktopTunnelRegistry();
    let closedCode: number | undefined;
    reg.drop(4, "token_rotated", 3);
    assert.throws(
      () => {
        reg.attach(4, { close: (code) => { closedCode = code; } }, {
          deviceId: "d4", uid: 1, expiresAt: new Date(Date.now() + 60_000), generation: 3,
        });
      },
      /generation 3 <= fence 3/,
    );
    assert.equal(closedCode, 1008);
    reg.attach(4, { close: () => {} }, {
      deviceId: "d4", uid: 1, expiresAt: new Date(Date.now() + 60_000), generation: 4,
    });
    assert.equal(reg.size(), 1);
  });
});
