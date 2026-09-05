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
import { CLOSE_BRIDGE } from "../ws/userChatBridge.js";
import {
  getDesktopTunnelRegistry,
  resetDesktopTunnelRegistryForTest,
} from "../ws/desktopTunnelRegistry.js";
import { createPgDesktopTunnelOwnerStore } from "../ws/desktopTunnelOwnerStore.js";
import { DesktopMuxSession, createMuxLoopbackPair } from "../ws/desktopMux.js";
import { makeDesktopOrDockerResolver } from "../agent-sandbox/desktopEnsure.js";
import { admitDispatch } from "../dispatch/turnDispatchStore.js";
import { getPool } from "../db/index.js";
import { randomBytes, randomUUID } from "node:crypto";
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

  test("production resolver desktop hit writes turn_dispatches.runtime_kind=desktop", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    process.env.DATABASE_URL = db.url;
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = "1";
    const u = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, role, status)
       VALUES ($1,'x','user','active') RETURNING id::text`,
      [`desk-wr01-${Date.now()}@t.local`],
    );
    const uid = Number(u.rows[0]!.id);
    const inserted = await query<{ id: string }>(
      `INSERT INTO agent_containers(
         user_id, host_uuid, bound_ip, secret_hash, state, port, image,
         runtime_channel, runtime_kind, last_ws_activity
       ) VALUES ($1, NULL, NULL, $2, 'active', 18789, 'desktop-gateway', $3, 'desktop', NOW())
       RETURNING id::text`,
      [uid, Buffer.alloc(32, 4), getRuntimeChannel()],
    );
    const desktopId = Number(inserted.rows[0]!.id);
    resetDesktopTunnelRegistryForTest();
    resetDesktopFlagCache();
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [uid] }));
    const pair = createMuxLoopbackPair();
    const mux = new DesktopMuxSession(pair.master);
    await getDesktopTunnelRegistry().attach(desktopId, { mux, close: () => {} }, {
      deviceId: "11111111-1111-4111-8111-111111111111",
      uid,
      expiresAt: new Date(Date.now() + 60_000),
      generation: 0,
    });
    try {
      let dockerCalls = 0;
      const resolver = makeDesktopOrDockerResolver(async () => {
        dockerCalls += 1;
        throw new Error("docker ensure must not run on desktop hit");
      });
      const ep = await resolver(BigInt(uid));
      assert.equal(ep.host, "desktop-reverse");
      assert.equal(ep.containerId, desktopId);
      assert.deepEqual(ep.desktop, { containerId: desktopId });
      assert.equal(dockerCalls, 0, "production chat resolver must not fall through to docker on hit");

      const dispatchId = randomUUID();
      const admitted = await admitDispatch(getPool(), {
        dispatchId,
        userId: BigInt(uid),
        sessionId: "s-desk-wr01",
        clientMessageId: "cm-desk-wr01",
        agentId: "main",
        model: "glm-5.2",
        requestHash: "a".repeat(64),
        billingRequestId: "brq-desk-wr01",
        ownerId: "conn-wr01",
        anchorSeq: null,
        agentContainerId: ep.containerId ?? null,
        runtimeKind: ep.desktop ? "desktop" : "docker",
      });
      assert.equal(admitted.kind, "admitted");
      const got = await query<{ runtime_kind: string | null; agent_container_id: string | null }>(
        `SELECT runtime_kind, agent_container_id::text AS agent_container_id
           FROM turn_dispatches WHERE dispatch_id = $1`,
        [dispatchId],
      );
      assert.equal(got.rows[0]?.runtime_kind, "desktop");
      assert.equal(Number(got.rows[0]?.agent_container_id), desktopId);
    } finally {
      mux.close();
      setDesktopSettingsLoader(null);
      resetDesktopFlagCache();
      delete process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    }
  });

  test("registerCommercial: active desktop + foreign owner → 4503 desktop_owned_elsewhere", async (t) => {
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
      [`desk-else-${Date.now()}@t.local`],
    );
    const uid = Number(u.rows[0]!.id);
    const inserted = await query<{ id: string }>(
      `INSERT INTO agent_containers(
         user_id, host_uuid, bound_ip, secret_hash, state, port, image,
         runtime_channel, runtime_kind, last_ws_activity
       ) VALUES ($1, NULL, NULL, $2, 'active', 18789, 'desktop-gateway', $3, 'desktop', NOW())
       RETURNING id::text`,
      [uid, Buffer.alloc(32, 5), getRuntimeChannel()],
    );
    const desktopId = Number(inserted.rows[0]!.id);
    resetDesktopTunnelRegistryForTest({
      instanceId: "bridge-self",
      instanceAddr: "127.0.0.1:18445",
      owners: createPgDesktopTunnelOwnerStore(),
    });
    await createPgDesktopTunnelOwnerStore().upsert({
      agentContainerId: desktopId,
      instanceId: "other-slot",
      instanceAddr: "127.0.0.1:18795",
      generation: 1,
      ownerEpoch: 1,
    });
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
      assert.equal(parsed.reason, "desktop_owned_elsewhere");
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    } finally {
      await r.shutdown();
      setDesktopSettingsLoader(null);
      resetDesktopFlagCache();
      resetDesktopTunnelRegistryForTest();
      delete process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
    }
  });
});
