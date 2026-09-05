/**
 * W-05 owner directory against a real migrated test DB.
 *
 * REQUIRE_TEST_DB=1 bash scripts/test-mutex.sh commercial \
 *   'npx tsx --test --test-force-exit --test-concurrency=1 --test-timeout=180000 \
 *    packages/commercial/src/__tests__/desktopTunnelOwners.integ.test.ts'
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { randomBytes } from "node:crypto";
import { query } from "../db/queries.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import { ContainerUnreadyError } from "../ws/userChatBridge.js";
import { makeDesktopEnsureAttached, resetDesktopEnsureCacheForTest } from "../agent-sandbox/desktopEnsure.js";
import { createMemoryDesktopTunnelRegistry } from "../ws/desktopTunnelRegistry.js";
import { createPgDesktopTunnelOwnerStore, DESKTOP_OWNER_STALE_MS } from "../ws/desktopTunnelOwnerStore.js";
import { useDedicatedTestDatabase } from "./helpers/db.js";

const db = useDedicatedTestDatabase("desktop_owners_w05_test");

async function insertDesktopContainer(): Promise<{ uid: number; containerId: number }> {
  const u = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, role, status)
     VALUES ($1,'x','user','active') RETURNING id::text`,
    [`w05-own-${Date.now()}-${Math.random().toString(16).slice(2)}@t.local`],
  );
  const uid = Number(u.rows[0]!.id);
  const c = await query<{ id: string }>(
    `INSERT INTO agent_containers(
       user_id, host_uuid, bound_ip, secret_hash, state, port, image,
       runtime_channel, runtime_kind, last_ws_activity
     ) VALUES ($1, NULL, NULL, $2, 'active', 18789, 'desktop-gateway', $3, 'desktop', NOW())
     RETURNING id::text`,
    [uid, randomBytes(32), getRuntimeChannel()],
  );
  return { uid, containerId: Number(c.rows[0]!.id) };
}

const flagsOn = async () => ({
  envEnabled: true,
  killSwitch: false,
  settingsOn: true,
  allowlist: [1],
  assembled: true,
});

describe("W-05 desktop_tunnel_owners integ", () => {
  test("attach upserts; other instance miss is owned_elsewhere; drop is generation-conditional", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    resetDesktopEnsureCacheForTest();
    const { uid, containerId } = await insertDesktopContainer();
    const store = createPgDesktopTunnelOwnerStore();
    const a = createMemoryDesktopTunnelRegistry({
      instanceId: "integ-a", instanceAddr: "127.0.0.1:18445", owners: store,
    });
    const b = createMemoryDesktopTunnelRegistry({
      instanceId: "integ-b", instanceAddr: "127.0.0.1:18446", owners: store,
    });
    await a.attach(containerId, { close: () => {} }, {
      deviceId: "11111111-1111-4111-8111-111111111111",
      uid,
      expiresAt: new Date(Date.now() + 60_000),
      generation: 3,
    });
    const row = await query<{ instance_id: string; generation: number }>(
      `SELECT instance_id, generation FROM desktop_tunnel_owners WHERE agent_container_id = $1`,
      [containerId],
    );
    assert.equal(row.rows[0]?.instance_id, "integ-a");
    assert.equal(Number(row.rows[0]?.generation), 3);

    await assert.rejects(
      () => makeDesktopEnsureAttached(BigInt(uid), {
        flags: flagsOn,
        findDesktopContainerId: async () => containerId,
        registry: b,
      }),
      (e: unknown) => e instanceof ContainerUnreadyError && e.reason === "desktop_owned_elsewhere",
    );

    await b.attach(containerId, { close: () => {} }, {
      deviceId: "11111111-1111-4111-8111-111111111111",
      uid,
      expiresAt: new Date(Date.now() + 60_000),
      generation: 4,
    });
    assert.equal(a.drop(containerId, "ws_close"), true);
    const after = await query<{ instance_id: string; generation: number }>(
      `SELECT instance_id, generation FROM desktop_tunnel_owners WHERE agent_container_id = $1`,
      [containerId],
    );
    assert.equal(after.rows[0]?.instance_id, "integ-b");
    assert.equal(Number(after.rows[0]?.generation), 4);
  });

  test("stale last_heartbeat (>90s) is desktop_offline; sweep only own instance_id", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    resetDesktopEnsureCacheForTest();
    const first = await insertDesktopContainer();
    const second = await insertDesktopContainer();
    const store = createPgDesktopTunnelOwnerStore();
    const a = createMemoryDesktopTunnelRegistry({ instanceId: "sweep-a", owners: store });
    const b = createMemoryDesktopTunnelRegistry({ instanceId: "sweep-b", owners: store });
    await a.attach(first.containerId, { close: () => {} }, {
      deviceId: "d", uid: first.uid, expiresAt: new Date(Date.now() + 60_000), generation: 1,
    });
    await b.attach(second.containerId, { close: () => {} }, {
      deviceId: "d", uid: second.uid, expiresAt: new Date(Date.now() + 60_000), generation: 1,
    });
    await query(
      `UPDATE desktop_tunnel_owners
          SET last_heartbeat_at = NOW() - ($2::int * interval '1 millisecond')
        WHERE agent_container_id = $1`,
      [first.containerId, DESKTOP_OWNER_STALE_MS + 5_000],
    );
    await assert.rejects(
      () => makeDesktopEnsureAttached(BigInt(first.uid), {
        flags: flagsOn,
        findDesktopContainerId: async () => first.containerId,
        registry: b,
      }),
      (e: unknown) => e instanceof ContainerUnreadyError && e.reason === "desktop_offline",
    );
    const n = await a.sweepOwnInstance();
    assert.equal(n, 1);
    const leftover = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM desktop_tunnel_owners WHERE instance_id = 'sweep-b'`,
    );
    assert.equal(leftover.rows[0]!.n, "1");
    const gone = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM desktop_tunnel_owners WHERE instance_id = 'sweep-a'`,
    );
    assert.equal(gone.rows[0]!.n, "0");
  });

  test("delayed DELETE after same-generation reconnect leaves owner row; heartbeat updates 1", async (t) => {
    if (db.skipIfUnavailable(t)) return;
    const { uid, containerId } = await insertDesktopContainer();
    const inner = createPgDesktopTunnelOwnerStore();
    const delayed: Array<() => Promise<boolean>> = [];
    const wrap = {
      ...inner,
      async deleteIfMatch(
        agentContainerId: number,
        instanceId: string,
        generation: number,
        ownerEpoch: number,
      ) {
        delayed.push(() => inner.deleteIfMatch(agentContainerId, instanceId, generation, ownerEpoch));
        return false;
      },
    };
    const reg = createMemoryDesktopTunnelRegistry({
      instanceId: "reconnect-self", instanceAddr: "127.0.0.1:18445", owners: wrap,
    });
    await reg.attach(containerId, { close: () => {} }, {
      deviceId: "d", uid, expiresAt: new Date(Date.now() + 60_000), generation: 5,
    });
    const first = await inner.get(containerId);
    assert.ok(first);
    assert.equal(reg.drop(containerId, "ws_close"), true);
    await reg.attach(containerId, { close: () => {} }, {
      deviceId: "d", uid, expiresAt: new Date(Date.now() + 60_000), generation: 5,
    });
    const second = await inner.get(containerId);
    assert.ok(second);
    assert.equal(second.generation, 5);
    assert.notEqual(second.ownerEpoch, first.ownerEpoch);
    assert.equal(delayed.length, 1);
    assert.equal(await delayed[0]!(), false);
    const still = await inner.get(containerId);
    assert.equal(still?.ownerEpoch, second.ownerEpoch);
    const n = await inner.touchHeartbeat(
      containerId, "reconnect-self", 5, still!.ownerEpoch, new Date(),
    );
    assert.equal(n, 1);
  });
});
