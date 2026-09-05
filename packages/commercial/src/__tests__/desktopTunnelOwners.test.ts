import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ContainerUnreadyError } from "../ws/userChatBridge.js";
import { makeDesktopEnsureAttached, resetDesktopEnsureCacheForTest } from "../agent-sandbox/desktopEnsure.js";
import { createMemoryDesktopTunnelRegistry } from "../ws/desktopTunnelRegistry.js";
import {
  createMemoryDesktopTunnelOwnerStore,
  DESKTOP_OWNER_STALE_MS,
  ownerHeartbeatIsFresh,
} from "../ws/desktopTunnelOwnerStore.js";
import { readDesktopInstanceAddr, readDesktopInstanceId, isDesktopOwnerSqlEnabled } from "../desktop/instance.js";

const assembled = {
  envEnabled: true,
  killSwitch: false,
  settingsOn: true,
  allowlist: [1],
  assembled: true,
} as const;

describe("desktop instance identity", () => {
  test("OC_INSTANCE_ID wins; otherwise hostname:pid", () => {
    assert.equal(readDesktopInstanceId({ OC_INSTANCE_ID: " slot-A " } as NodeJS.ProcessEnv), "slot-A");
    const fallback = readDesktopInstanceId({} as NodeJS.ProcessEnv);
    assert.match(fallback, /:\d+$/);
  });

  test("OC_INSTANCE_ADDR wins; otherwise bind:port", () => {
    assert.equal(readDesktopInstanceAddr({ OC_INSTANCE_ADDR: "10.0.0.1:18445" } as NodeJS.ProcessEnv), "10.0.0.1:18445");
    assert.equal(
      readDesktopInstanceAddr({ OC_DESKTOP_TLS_BIND: "127.0.0.1", OC_DESKTOP_TLS_PORT: "18445" } as NodeJS.ProcessEnv),
      "127.0.0.1:18445",
    );
  });

  test("owner SQL follows OC_DESKTOP_VIRTUAL_CONTAINER only", () => {
    assert.equal(isDesktopOwnerSqlEnabled({} as NodeJS.ProcessEnv), false);
    assert.equal(isDesktopOwnerSqlEnabled({ OC_DESKTOP_VIRTUAL_CONTAINER: "1" } as NodeJS.ProcessEnv), true);
  });
});

describe("desktop tunnel owner directory", () => {
  test("two instance_ids: remote attach is owned_elsewhere on local miss", async () => {
    resetDesktopEnsureCacheForTest();
    const store = createMemoryDesktopTunnelOwnerStore();
    const a = createMemoryDesktopTunnelRegistry({ instanceId: "inst-a", instanceAddr: "a:1", owners: store });
    const b = createMemoryDesktopTunnelRegistry({ instanceId: "inst-b", instanceAddr: "b:1", owners: store });
    await a.attach(9, { close: () => {} }, {
      deviceId: "d9", uid: 1, expiresAt: new Date(Date.now() + 60_000), generation: 2,
    });
    assert.equal(b.get(9), undefined);
    const owner = await b.lookupOwner(9);
    assert.equal(owner?.instanceId, "inst-a");
    assert.equal(owner?.generation, 2);

    await assert.rejects(
      () => makeDesktopEnsureAttached(1n, {
        flags: async () => assembled,
        findDesktopContainerId: async () => 9,
        registry: b,
      }),
      (e: unknown) => e instanceof ContainerUnreadyError && e.reason === "desktop_owned_elsewhere",
    );
  });

  test("drop does not delete another instance's newer owner row", async () => {
    const store = createMemoryDesktopTunnelOwnerStore();
    const a = createMemoryDesktopTunnelRegistry({ instanceId: "inst-a", owners: store });
    const b = createMemoryDesktopTunnelRegistry({ instanceId: "inst-b", owners: store });
    await a.attach(4, { close: () => {} }, {
      deviceId: "d4", uid: 1, expiresAt: new Date(Date.now() + 60_000), generation: 1,
    });
    await b.attach(4, { close: () => {} }, {
      deviceId: "d4", uid: 1, expiresAt: new Date(Date.now() + 60_000), generation: 2,
    });
    assert.equal(a.drop(4, "ws_close"), true);
    const owner = await b.lookupOwner(4);
    assert.equal(owner?.instanceId, "inst-b");
    assert.equal(owner?.generation, 2);
  });

  test("owner heartbeat older than 90s falls back to desktop_offline", async () => {
    resetDesktopEnsureCacheForTest();
    const store = createMemoryDesktopTunnelOwnerStore();
    const a = createMemoryDesktopTunnelRegistry({ instanceId: "inst-a", owners: store });
    const b = createMemoryDesktopTunnelRegistry({ instanceId: "inst-b", owners: store });
    await a.attach(8, { close: () => {} }, {
      deviceId: "d8", uid: 1, expiresAt: new Date(Date.now() + 60_000), generation: 1,
    });
    const staleAt = new Date(Date.now() - DESKTOP_OWNER_STALE_MS - 1_000);
    store.rows.set(8, { ...store.rows.get(8)!, lastHeartbeatAt: staleAt });
    assert.equal(ownerHeartbeatIsFresh(store.rows.get(8)!), false);
    await assert.rejects(
      () => makeDesktopEnsureAttached(1n, {
        flags: async () => assembled,
        findDesktopContainerId: async () => 8,
        registry: b,
      }),
      (e: unknown) => e instanceof ContainerUnreadyError && e.reason === "desktop_offline",
    );
  });

  test("sweepOwnInstance only deletes this instance_id", async () => {
    const store = createMemoryDesktopTunnelOwnerStore();
    const a = createMemoryDesktopTunnelRegistry({ instanceId: "inst-a", owners: store });
    const b = createMemoryDesktopTunnelRegistry({ instanceId: "inst-b", owners: store });
    await a.attach(1, { close: () => {} }, {
      deviceId: "d1", uid: 1, expiresAt: new Date(Date.now() + 60_000),
    });
    await b.attach(2, { close: () => {} }, {
      deviceId: "d2", uid: 1, expiresAt: new Date(Date.now() + 60_000),
    });
    const n = await a.sweepOwnInstance();
    assert.equal(n, 1);
    assert.equal(await a.lookupOwner(1), null);
    assert.equal((await b.lookupOwner(2))?.instanceId, "inst-b");
  });

  test("flag off / not assembled: zero findDesktop SQL (W-R03 env-off path)", async () => {
    resetDesktopEnsureCacheForTest();
    let finds = 0;
    const got = await makeDesktopEnsureAttached(1n, {
      flags: async () => ({ ...assembled, envEnabled: false, assembled: false }),
      findDesktopContainerId: async () => {
        finds += 1;
        return 9;
      },
    });
    assert.equal(got, null);
    assert.equal(finds, 0);
  });

  test("assembled + no desktop row caches the miss (W-R03)", async () => {
    resetDesktopEnsureCacheForTest();
    let finds = 0;
    let now = 1_000;
    const deps = {
      flags: async () => assembled,
      findDesktopContainerId: async () => {
        finds += 1;
        return null;
      },
      now: () => now,
    };
    assert.equal(await makeDesktopEnsureAttached(7n, deps), null);
    assert.equal(await makeDesktopEnsureAttached(7n, deps), null);
    assert.equal(finds, 1);
    now = 1_000 + 15_000 + 1;
    assert.equal(await makeDesktopEnsureAttached(7n, deps), null);
    assert.equal(finds, 2);
  });

  test("local registry hit does not consult owner store", async () => {
    resetDesktopEnsureCacheForTest();
    const store = createMemoryDesktopTunnelOwnerStore();
    const reg = createMemoryDesktopTunnelRegistry({ instanceId: "self", owners: store });
    await reg.attach(3, { close: () => {} }, {
      deviceId: "d3", uid: 1, expiresAt: new Date(Date.now() + 60_000),
    });
    let lookups = 0;
    const ep = await makeDesktopEnsureAttached(1n, {
      flags: async () => assembled,
      findDesktopContainerId: async () => 3,
      registry: reg,
      lookupOwner: async () => {
        lookups += 1;
        return null;
      },
    });
    assert.equal(ep?.containerId, 3);
    assert.equal(lookups, 0);
  });
});

describe("W05-IMPL-01 owner_epoch and owner SQL chain", () => {
  test("delayed same-generation DELETE does not wipe the new owner row", async () => {
    const inner = createMemoryDesktopTunnelOwnerStore();
    const delayed: Array<() => Promise<boolean>> = [];
    const wrap = {
      ...inner,
      rows: inner.rows,
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
    const reg = createMemoryDesktopTunnelRegistry({ instanceId: "self", owners: wrap });
    await reg.attach(11, { close: () => {} }, {
      deviceId: "d11", uid: 1, expiresAt: new Date(Date.now() + 60_000), generation: 7,
    });
    const firstEpoch = (await inner.get(11))!.ownerEpoch;
    assert.equal(reg.drop(11, "ws_close"), true);
    await reg.attach(11, { close: () => {} }, {
      deviceId: "d11", uid: 1, expiresAt: new Date(Date.now() + 60_000), generation: 7,
    });
    const second = await inner.get(11);
    assert.ok(second);
    assert.equal(second.generation, 7);
    assert.notEqual(second.ownerEpoch, firstEpoch);
    assert.equal(delayed.length, 1);
    assert.equal(await delayed[0]!(), false);
    const still = await inner.get(11);
    assert.equal(still?.ownerEpoch, second.ownerEpoch);
    const touched = await inner.touchHeartbeat(11, "self", 7, still!.ownerEpoch, new Date());
    assert.equal(touched, 1);
  });

  test("memory store deleteIfMatch is epoch-conditional", async () => {
    const store = createMemoryDesktopTunnelOwnerStore();
    await store.upsert({
      agentContainerId: 3, instanceId: "self", instanceAddr: "a", generation: 1, ownerEpoch: 100,
    });
    assert.equal(await store.deleteIfMatch(3, "self", 1, 99), false);
    assert.ok(await store.get(3));
    assert.equal(await store.deleteIfMatch(3, "self", 1, 100), true);
    assert.equal(await store.get(3), null);
  });

  test("failed DELETE is retried from the 90s ledger", async () => {
    const inner = createMemoryDesktopTunnelOwnerStore();
    let fail = true;
    const wrap = {
      ...inner,
      rows: inner.rows,
      async deleteIfMatch(
        agentContainerId: number,
        instanceId: string,
        generation: number,
        ownerEpoch: number,
      ) {
        if (fail) throw new Error("pool blip");
        return inner.deleteIfMatch(agentContainerId, instanceId, generation, ownerEpoch);
      },
    };
    const reg = createMemoryDesktopTunnelRegistry({ instanceId: "self", owners: wrap });
    await reg.attach(5, { close: () => {} }, {
      deviceId: "d5", uid: 1, expiresAt: new Date(Date.now() + 60_000), generation: 1,
    });
    assert.equal(reg.drop(5, "ws_close"), true);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(await inner.get(5));
    fail = false;
    await reg.retryPendingOwnerDeletes();
    assert.equal(await inner.get(5), null);
  });

  test("sweepDesktopOwnersBeforeListen retries then throws", async () => {
    const { sweepDesktopOwnersBeforeListen, createMemoryDesktopTunnelRegistry } = await import("../ws/desktopTunnelRegistry.js");
    let n = 0;
    const store = createMemoryDesktopTunnelOwnerStore();
    store.sweepInstance = async () => {
      n += 1;
      throw new Error("pg down");
    };
    const reg = createMemoryDesktopTunnelRegistry({ instanceId: "self", owners: store });
    await assert.rejects(() => sweepDesktopOwnersBeforeListen(reg, 3), /pg down/);
    assert.equal(n, 3);
    n = 0;
    store.sweepInstance = async () => {
      n += 1;
      if (n < 3) throw new Error("pg down");
      return 0;
    };
    await sweepDesktopOwnersBeforeListen(reg, 3);
    assert.equal(n, 3);
  });
});
