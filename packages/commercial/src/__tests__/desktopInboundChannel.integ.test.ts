/**
 * P1-IMPL-09: WeChat inbound through registerCommercial stays on docker
 * even when the uid has an active desktop row.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit --test-concurrency=1 --test-timeout=180000 \
 *    packages/commercial/src/__tests__/desktopInboundChannel.integ.test.ts'
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { randomBytes } from "node:crypto";
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
import { DesktopMuxSession, createMuxLoopbackPair } from "../ws/desktopMux.js";
import { useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("desktop_inbound_p1f_test");
const JWT = "desktop-inbound-integ-secret-must-be-32b!!";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:56379/0";

type InboundOutcome = {
  kind?: string;
  reason?: string;
  errMessage?: string;
};

function assertNotDesktopHijack(outcome: InboundOutcome, label: string): void {
  assert.notEqual(
    outcome.reason,
    "desktop_offline",
    `${label}: WeChat inbound must not enter desktop_offline cold_start`,
  );
  const msg = `${outcome.kind ?? ""} ${outcome.reason ?? ""} ${outcome.errMessage ?? ""}`;
  assert.doesNotMatch(
    msg,
    /desktop-reverse/,
    `${label}: WeChat inbound must not target host=desktop-reverse (${msg})`,
  );
  assert.doesNotMatch(
    msg,
    /TRANSPORT_HOST_BLOCKED/,
    `${label}: WeChat inbound must not hit SSRF on desktop-reverse (${msg})`,
  );
}

describe("desktop inbound channel production composition", () => {
  test("registerCommercial: WeChat stays docker; chat still desktop_offline on miss", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    process.env.DATABASE_URL = db.url;
    process.env.REDIS_URL = TEST_REDIS_URL;
    process.env.COMMERCIAL_ENABLED = "1";
    process.env.OPENCLAUDE_KMS_KEY = randomBytes(32).toString("base64");
    process.env.OC_DESKTOP_VIRTUAL_CONTAINER = "1";
    process.env.COMMERCIAL_ALERTS_DISABLED = "1";
    process.env.WECHAT_BROKER_ENABLED = "1";
    delete process.env.OC_RUNTIME_CHANNEL;

    const u = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, role, status)
       VALUES ($1,'x','user','active') RETURNING id::text`,
      [`desk-inb-${Date.now()}@t.local`],
    );
    const uid = Number(u.rows[0]!.id);
    await query(
      `INSERT INTO agent_containers(
         user_id, host_uuid, bound_ip, secret_hash, state, port, image,
         runtime_channel, runtime_kind, last_ws_activity
       ) VALUES ($1, NULL, NULL, $2, 'active', 18789, 'desktop-gateway', $3, 'desktop', NOW())`,
      [uid, Buffer.alloc(32, 5), getRuntimeChannel()],
    );
    await query(
      `INSERT INTO agent_containers(
         user_id, host_uuid, bound_ip, secret_hash, state, port, image,
         runtime_channel, runtime_kind, last_ws_activity
       ) VALUES ($1, NULL, '172.31.0.9', $2, 'active', 18789, 'oc-runtime', $3, 'docker', NOW())`,
      [uid, Buffer.alloc(32, 6), getRuntimeChannel()],
    );

    resetDesktopTunnelRegistryForTest();
    resetDesktopFlagCache();
    setDesktopSettingsLoader(async () => ({ settingsOn: true, allowlist: [uid] }));

    let r: Awaited<ReturnType<typeof registerCommercial>>;
    try {
      r = await registerCommercial(null, { jwtSecret: JWT, skipInternalProxy: true });
    } catch (err) {
      setDesktopSettingsLoader(null);
      resetDesktopFlagCache();
      delete process.env.OC_DESKTOP_VIRTUAL_CONTAINER;
      delete process.env.WECHAT_BROKER_ENABLED;
      throw err;
    }

    try {
      if (!r.wechatBroker) {
        t.skip("wechatBroker not assembled (likely bridgeSecret missing in test env)");
        return;
      }

      const miss = await r.wechatBroker.onInbound({
        bindingUserId: String(uid),
        senderId: "wx-desk-inb",
        text: "hello from wechat",
        idempotencyKey: `inb-miss-${Date.now()}-${randomBytes(4).toString("hex")}`,
        receivedAt: Date.now(),
        channel: "wechat",
      }) as InboundOutcome;
      assertNotDesktopHijack(miss, "registry miss");
      if (miss.kind === "cold_start") {
        assert.equal(
          miss.reason,
          "supervisor_not_wired",
          `registry miss should use docker-only ensure, got ${JSON.stringify(miss)}`,
        );
      }

      const pair = createMuxLoopbackPair();
      const mux = new DesktopMuxSession(pair.master);
      const desktopId = await query<{ id: string }>(
        `SELECT id::text AS id FROM agent_containers
          WHERE user_id = $1 AND runtime_kind = 'desktop' AND state = 'active' LIMIT 1`,
        [uid],
      );
      await getDesktopTunnelRegistry().attach(Number(desktopId.rows[0]!.id), { mux, close: () => {} }, {
        deviceId: "22222222-2222-4222-8222-222222222222",
        uid,
        expiresAt: new Date(Date.now() + 60_000),
        generation: 0,
      });
      try {
        const hit = await r.wechatBroker.onInbound({
          bindingUserId: String(uid),
          senderId: "wx-desk-inb",
          text: "hello while desktop attached",
          idempotencyKey: `inb-hit-${Date.now()}-${randomBytes(4).toString("hex")}`,
          receivedAt: Date.now(),
          channel: "wechat",
        }) as InboundOutcome;
        assertNotDesktopHijack(hit, "registry hit");
        if (hit.kind === "cold_start") {
          assert.equal(
            hit.reason,
            "supervisor_not_wired",
            `registry hit must still use docker-only ensure, got ${JSON.stringify(hit)}`,
          );
        }
      } finally {
        mux.close();
        resetDesktopTunnelRegistryForTest();
      }

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
      delete process.env.WECHAT_BROKER_ENABLED;
    }
  });
});
