/**
 * Desktop reverse-tunnel C-stage integ (registry http + expiry not extended).
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit --test-concurrency=1 --test-timeout=180000 \
 *    packages/commercial/src/__tests__/desktopTunnel.integ.test.ts'
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { query } from "../db/queries.js";
import { useDedicatedTestDatabase } from "./helpers/db.js";
import {
  DesktopMuxSession,
  FLAG_FIN,
  MuxType,
  createMuxLoopbackPair,
  decodeFrames,
  encodeFrame,
  encodeJsonFrame,
} from "../ws/desktopMux.js";
import { createMemoryDesktopTunnelRegistry } from "../ws/desktopTunnelRegistry.js";
import { desktopAllowsEngine } from "../ws/containerTransportKind.js";
import { classifyDesktopPath } from "../http/desktopInternalDispatch.js";

const db = useDedicatedTestDatabase("desktop_tunnel_p1c_test");

describe("desktop tunnel integ", () => {
  test("registry http over mux + engine gate + 18445 classify", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    assert.equal(desktopAllowsEngine(true, "cursor"), false);
    assert.equal(classifyDesktopPath("POST", "/internal/v5/grok-relay"), "not_found");
    assert.equal(classifyDesktopPath("POST", "/v1/messages"), "messages");

    const pair = createMuxLoopbackPair();
    const mux = new DesktopMuxSession(pair.master);
    pair.desktop.on("message", (raw) => {
      const { frames } = decodeFrames(raw as Buffer);
      for (const f of frames) {
        if (f.type === MuxType.OPEN_HTTP) {
          pair.desktop.send(encodeJsonFrame(MuxType.HTTP_RESPONSE_START, f.streamId, {
            status: 200,
            headers: [{ k: "content-type", v: "application/json" }],
          }));
          pair.desktop.send(encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, f.streamId, Buffer.from('{"found":false,"state":"absent"}')));
          pair.desktop.send(encodeFrame(MuxType.HTTP_END, 0, f.streamId));
        }
        if (f.type === MuxType.HEARTBEAT_ACK) {
          /* master acked */
        }
      }
    });
    const reg = createMemoryDesktopTunnelRegistry();
    const u = await query<{ id: string }>(
      `INSERT INTO users(email, password_hash, role, status)
       VALUES ($1,'x','admin','active') RETURNING id::text`,
      [`desk-tun-${Date.now()}@t.local`],
    );
    const uid = Number(u.rows[0]!.id);
    const c = await query<{ id: string; session_secret_expires_at: Date | null }>(
      `INSERT INTO agent_containers(
         user_id, host_uuid, bound_ip, secret_hash, state, port, image,
         runtime_channel, runtime_kind, last_ws_activity
       ) VALUES ($1, NULL, NULL, $2, 'active', 18789, 'desktop-gateway', 'v5', 'desktop', NOW())
       RETURNING id::text AS id, session_secret_expires_at`,
      [uid, Buffer.alloc(32, 7)],
    );
    const containerId = Number(c.rows[0]!.id);
    const before = c.rows[0]!.session_secret_expires_at;
    await reg.attach(containerId, { mux, close: () => {} }, {
      deviceId: "11111111-1111-4111-8111-111111111111",
      uid,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const httpRes = await reg.http(containerId, "GET", "/internal/v3/turn-dispatch-state", {}, null, 2_000);
    assert.equal(httpRes.status, 200);
    assert.match(httpRes.bodyText, /absent/);
    pair.desktop.send(encodeJsonFrame(MuxType.HEARTBEAT, 0, { ts: Date.now() }));
    await new Promise((r) => setTimeout(r, 20));
    const after = await query<{ session_secret_expires_at: Date | null }>(
      `SELECT session_secret_expires_at FROM agent_containers WHERE id = $1`,
      [containerId],
    );
    assert.deepEqual(after.rows[0]!.session_secret_expires_at, before);
    assert.equal(reg.drop(containerId, "test"), true);
    mux.close();
  });
});
