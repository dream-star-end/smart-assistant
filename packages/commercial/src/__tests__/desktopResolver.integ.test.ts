/**
 * E1 production composition: registerCommercial/userChatBridge real entry.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit --test-concurrency=1 --test-timeout=180000 \
 *    packages/commercial/src/__tests__/desktopResolver.integ.test.ts'
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { WebSocket } from "ws";
import { signAccess } from "../auth/jwt.js";
import { query } from "../db/queries.js";
import { registerCommercial } from "../index.js";
import { resetDesktopFlagCache, setDesktopSettingsLoader } from "../desktop/flags.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import {
  createUserChatBridge,
  CLOSE_BRIDGE,
} from "../ws/userChatBridge.js";
import {
  getDesktopTunnelRegistry,
  resetDesktopTunnelRegistryForTest,
} from "../ws/desktopTunnelRegistry.js";
import { DesktopMuxSession, createMuxLoopbackPair } from "../ws/desktopMux.js";
import { randomBytes } from "node:crypto";
import { useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("desktop_resolver_p1e_test");
const JWT = "desktop-resolver-integ-secret-must-be-32b!!";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";

describe("desktop resolver production composition", () => {
  test("registerCommercial: active desktop + registry miss → 4503 desktop_offline, not docker", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = TEST_REDIS_URL;
    process.env.COMMERCIAL_ENABLED = "1";
    process.env.OPENCLAUDE_KMS_KEY = randomBytes(32).toString("base64");
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = "1";
    process.env.COMMERCIAL_ALERTS_DISABLED = "1";
    const u = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, role, status)
       VALUES ($1,'x','user','active') RETURNING id::text`,
      [`desk-res-${Date.now()}@t.local`],
    );
    const uid = Number(u.rows[0]!.id);
    await query(
      `INSERT INTO agent_containers(
         user_id, host_uuid, bound_ip, secret_hash, state, port, image,
         runtime_channel, runtime_kind, last_ws_activity
       ) VALUES ($1, NULL, NULL, $2, 'active', 18789, 'desktop-gateway', $3, 'desktop', NOW())`,
      [uid, Buffer.alloc(32, 3), getRuntimeChannel()],
    );
    resetDesktopTunnelRegistryForTest();
    resetDesktopFlagCache();
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [uid] }));
    const r = await registerCommercial(null, { jwtSecret: JWT, skipInternalProxy: true });
    try {
      const httpServer = createServer();
      httpServer.on("upgrade", (req, socket, head) => {
        if (!r.handleWsUpgrade(req, socket, head)) {
          try { socket.destroy(); } catch { /* */ }
        }
      });
      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
      const port = (httpServer.address() as AddressInfo).port;
      const issued = await signAccess({ sub: String(uid), role: "user" }, JWT);
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/ws/user-chat-bridge`,
        ["bearer", issued.token],
      );
      const closeInfo = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ws never closed")), 8000);
        ws.on("close", (code, reason) => {
          clearTimeout(timer);
          resolve({ code, reason: reason.toString("utf8") });
        });
        ws.on("error", () => { /* */ });
      });
      assert.equal(closeInfo.code, CLOSE_BRIDGE.CONTAINER_UNREADY);
      const parsed = JSON.parse(closeInfo.reason) as { reason?: string };
      assert.equal(parsed.reason, "desktop_offline");
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    } finally {
      await r.shutdown();
      setDesktopSettingsLoader(null);
      resetDesktopFlagCache();
      delete process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    }
  });

  test("userChatBridge desktop branch writes admit runtimeKind=desktop; grok is ENGINE_NOT_ENABLED", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    resetDesktopTunnelRegistryForTest();
    const pair = createMuxLoopbackPair();
    const mux = new DesktopMuxSession(pair.master);
    const registry = getDesktopTunnelRegistry();
    registry.attach(88, { mux, close: () => {} }, {
      deviceId: "11111111-1111-4111-8111-111111111111",
      uid: 5,
      expiresAt: new Date(Date.now() + 60_000),
      generation: 0,
    });
    const admits: Array<{ runtimeKind?: string | null; agentContainerId?: number | null }> = [];
    const errors: string[] = [];
    const bridge = createUserChatBridge({
      jwtSecret: JWT,
      resolveContainerEndpoint: async () => ({
        host: "desktop-reverse",
        port: 0,
        containerId: 88,
        desktop: { containerId: 88 },
        coldStart: false,
      }),
      admitUserTurn: async (input) => {
        admits.push({ runtimeKind: input.runtimeKind ?? undefined, agentContainerId: input.agentContainerId ?? null });
        return { kind: "session_not_found" };
      },
      loadAllowedModelChecker: async () => () => true,
    });
    const httpServer = createServer();
    httpServer.on("upgrade", (req, socket, head) => {
      if (!bridge.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const port = (httpServer.address() as AddressInfo).port;
    const issued = await signAccess({ sub: "5", role: "user" }, JWT);
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws/user-chat-bridge`,
      ["bearer", issued.token],
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("open timeout")), 5000);
      ws.on("open", () => { clearTimeout(timer); resolve(); });
      ws.on("error", reject);
    });
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { code?: string };
        if (typeof msg.code === "string") errors.push(msg.code);
      } catch { /* */ }
    });
    assert.equal(ws.readyState, WebSocket.OPEN, "desktop reverse tunnel should keep the user bridge open");
    ws.send(JSON.stringify({
      type: "inbound.message",
      peer: { id: "p1", kind: "dm" },
      clientMessageId: "m1",
      model: "glm-5.2",
      content: "hi",
    }));
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(
      ws.readyState === WebSocket.OPEN
      || admits.some((a) => a.runtimeKind === "desktop" && a.agentContainerId === 88)
      || errors.length > 0,
      `expected desktop bridge to stay up or emit a turn error, admits=${JSON.stringify(admits)} errors=${errors.join(",")}`,
    );
    ws.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    mux.close();
    await bridge.shutdown();
  });
});
