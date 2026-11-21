import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, test } from "node:test";
import { WebSocket } from "ws";
import { signAccess } from "../auth/jwt.js";
import {
  DEFAULT_BRIDGE_MAX_FRAME_BYTES,
  MAX_BRIDGE_MAX_FRAME_BYTES,
  resolveBridgeMaxFrameBytes,
} from "./bridgeFrameBudget.js";
import { createUserChatBridge } from "./userChatBridge.js";

const TEST_JWT_SECRET = "ocv5-825-test-jwt-secret-0123456789abcdef";

describe("bridgeFrameBudget (OCV5-825 B1)", () => {
  test("defaults to 16 MiB matching container gateway and supports OC_WS_MAX_PAYLOAD_BYTES override", () => {
    assert.equal(DEFAULT_BRIDGE_MAX_FRAME_BYTES, 16 * 1024 * 1024);
    assert.equal(resolveBridgeMaxFrameBytes({}), DEFAULT_BRIDGE_MAX_FRAME_BYTES);
    assert.equal(
      resolveBridgeMaxFrameBytes({ OC_WS_MAX_PAYLOAD_BYTES: String(32 * 1024 * 1024) }),
      32 * 1024 * 1024,
    );
    assert.equal(
      resolveBridgeMaxFrameBytes({ OC_WS_MAX_PAYLOAD_BYTES: "1024" }),
      DEFAULT_BRIDGE_MAX_FRAME_BYTES,
    );
    assert.equal(
      resolveBridgeMaxFrameBytes({ OC_WS_MAX_PAYLOAD_BYTES: String(999 * 1024 * 1024) }),
      MAX_BRIDGE_MAX_FRAME_BYTES,
    );
  });

  test("B1 (R2): oversized frame during handshake window closes only offending user socket without uncaughtException", async () => {
    const warns: string[] = [];
    let releaseEnsure!: () => void;
    const ensureBlocked = new Promise<void>((r) => { releaseEnsure = r; });
    const signed = await signAccess({ sub: "42", role: "user" }, TEST_JWT_SECRET);

    const bridge = createUserChatBridge({
      jwtSecret: TEST_JWT_SECRET,
      maxFrameBytes: 1024,
      resolveContainerEndpoint: async () => {
        // Keep the handshake pending while clientA fires an oversized frame.
        await ensureBlocked;
        return { kind: "ready", host: "127.0.0.1", port: 1, containerId: 1 } as any;
      },
      logger: {
        info() {},
        debug() {},
        error() {},
        warn(msg: string) { warns.push(msg); },
        child() { return this; },
      } as any,
    } as any);

    const server = createServer();
    server.on("upgrade", (req, socket, head) => {
      if (!bridge.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address() as { port: number };
    const url = `ws://127.0.0.1:${addr.port}/ws/user-chat-bridge`;

    let uncaught: unknown = null;
    const onUncaught = (err: unknown) => { uncaught = err; };
    process.on("uncaughtException", onUncaught);

    const clientA = new WebSocket(url, ["bearer", signed.token]);
    const clientB = new WebSocket(url, ["bearer", signed.token]);
    try {
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          clientA.once("open", () => resolve());
          clientA.once("error", reject);
        }),
        new Promise<void>((resolve, reject) => {
          clientB.once("open", () => resolve());
          clientB.once("error", reject);
        }),
      ]);

      const closedA = new Promise<number>((resolve) => clientA.once("close", (code) => resolve(code)));
      clientA.on("error", () => {});
      // Exceed maxFrameBytes (1024) DURING handshake before startBridge attaches its error listener!
      clientA.send(JSON.stringify({ type: "inbound.message", text: "x".repeat(4096) }));
      const code = await closedA;
      assert.equal(code, 1009, "oversized handshake frame must close offending socket with 1009");
      assert.equal(uncaught, null, "master process must NOT crash with uncaughtException");
      assert.ok(
        warns.some((w) => w.includes("early user ws error")),
        `expected early error log, got: ${JSON.stringify(warns)}`,
      );
      assert.equal(clientB.readyState, WebSocket.OPEN, "sibling user socket must remain open");
    } finally {
      releaseEnsure();
      process.off("uncaughtException", onUncaught);
      try { clientA.terminate(); } catch {}
      try { clientB.terminate(); } catch {}
      await bridge.shutdown().catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
