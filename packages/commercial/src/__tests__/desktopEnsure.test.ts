import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ContainerUnreadyError } from "../ws/userChatBridge.js";
import {
  makeDesktopOrDockerResolver,
  makeInboundChannelResolver,
  makeDesktopEnsureAttached,
  resetDesktopEnsureCacheForTest,
  invalidateDesktopRowMiss,
  type DesktopAttachedEndpoint,
} from "../agent-sandbox/desktopEnsure.js";
import { createMemoryDesktopTunnelRegistry } from "../ws/desktopTunnelRegistry.js";
import { createMemoryDesktopTunnelOwnerStore } from "../ws/desktopTunnelOwnerStore.js";

const desktopEp: DesktopAttachedEndpoint = {
  host: "desktop-reverse",
  port: 0,
  containerId: 9,
  desktop: { containerId: 9 },
  coldStart: false,
};

describe("makeDesktopOrDockerResolver", () => {
  test("assembled desktop hit does not call docker ensure", async () => {
    let dockerCalls = 0;
    const docker = async () => {
      dockerCalls += 1;
      return { host: "127.0.0.1", port: 1 };
    };
    const resolve = makeDesktopOrDockerResolver(docker, async () => desktopEp);
    const got = await resolve(1n);
    assert.equal(got.containerId, 9);
    assert.deepEqual(got.desktop, { containerId: 9 });
    assert.equal(dockerCalls, 0);
  });

  test("registry miss throws desktop_offline and does not provision docker", async () => {
    let dockerCalls = 0;
    const docker = async () => {
      dockerCalls += 1;
      return { host: "127.0.0.1", port: 1 };
    };
    const resolve = makeDesktopOrDockerResolver(docker, async () => {
      throw new ContainerUnreadyError(5, "desktop_offline");
    });
    await assert.rejects(
      () => resolve(1n),
      (e: unknown) => e instanceof ContainerUnreadyError && e.reason === "desktop_offline",
    );
    assert.equal(dockerCalls, 0);
  });

  test("owned_elsewhere does not provision docker", async () => {
    let dockerCalls = 0;
    const docker = async () => {
      dockerCalls += 1;
      return { host: "127.0.0.1", port: 1 };
    };
    const resolve = makeDesktopOrDockerResolver(docker, async () => {
      throw new ContainerUnreadyError(5, "desktop_owned_elsewhere");
    });
    await assert.rejects(
      () => resolve(1n),
      (e: unknown) => e instanceof ContainerUnreadyError && e.reason === "desktop_owned_elsewhere",
    );
    assert.equal(dockerCalls, 0);
  });

  test("no desktop row falls through to the same docker ensure", async () => {
    const docker = async (uid: bigint) => ({ host: "docker", port: Number(uid), containerId: 3 });
    const resolve = makeDesktopOrDockerResolver(docker, async () => null);
    const got = await resolve(7n);
    assert.equal(got.host, "docker");
    assert.equal(got.port, 7);
    assert.equal(got.desktop, undefined);
  });

  test("flag-off / no docker ensure → supervisor_not_wired", async () => {
    const resolve = makeDesktopOrDockerResolver(undefined, async () => null);
    await assert.rejects(
      () => resolve(1n),
      (e: unknown) => e instanceof ContainerUnreadyError && e.reason === "supervisor_not_wired",
    );
  });
});

describe("makeInboundChannelResolver", () => {
  test("returns docker bound_ip even when chat resolver would throw desktop_offline", async () => {
    const docker = async () => ({ host: "172.31.0.9", port: 18789, containerId: 2 });
    const inbound = makeInboundChannelResolver(docker);
    const chat = makeDesktopOrDockerResolver(docker, async () => {
      throw new ContainerUnreadyError(5, "desktop_offline");
    });
    await assert.rejects(
      () => chat(1n),
      (e: unknown) => e instanceof ContainerUnreadyError && e.reason === "desktop_offline",
    );
    const ep = await inbound(1n);
    assert.equal(ep.host, "172.31.0.9");
    assert.equal(ep.port, 18789);
    assert.equal(ep.containerId, 2);
    assert.equal(ep.desktop, undefined);
  });

  test("fail-closes if docker ensure returns a desktop endpoint", async () => {
    const inbound = makeInboundChannelResolver(async () => desktopEp);
    await assert.rejects(
      () => inbound(1n),
      (e: unknown) =>
        e instanceof ContainerUnreadyError && e.reason === "desktop_not_allowed_for_inbound",
    );
  });

  test("no docker ensure → supervisor_not_wired (not desktop_offline)", async () => {
    const inbound = makeInboundChannelResolver(undefined);
    await assert.rejects(
      () => inbound(1n),
      (e: unknown) => e instanceof ContainerUnreadyError && e.reason === "supervisor_not_wired",
    );
  });
});

describe("makeDesktopEnsureAttached owner miss", () => {
  test("self owner + memory miss is desktop_offline not owned_elsewhere", async () => {
    resetDesktopEnsureCacheForTest();
    const store = createMemoryDesktopTunnelOwnerStore();
    const reg = createMemoryDesktopTunnelRegistry({ instanceId: "self", owners: store });
    await store.upsert({
      agentContainerId: 5,
      instanceId: "self",
      instanceAddr: "127.0.0.1:18445",
      generation: 1,
      ownerEpoch: 1,
    });
    await assert.rejects(
      () => makeDesktopEnsureAttached(1n, {
        flags: async () => ({
          envEnabled: true, killSwitch: false, settingsOn: true, allowlist: [1], assembled: true,
        }),
        findDesktopContainerId: async () => 5,
        registry: reg,
      }),
      (e: unknown) => e instanceof ContainerUnreadyError && e.reason === "desktop_offline",
    );
  });
});

describe("W05-IMPL-02 negative cache invalidation", () => {
  test("without invalidate, a newly appearing row stays cached-null (the bug)", async () => {
    resetDesktopEnsureCacheForTest();
    let finds = 0;
    let id: number | null = null;
    const deps = {
      flags: async () => ({
        envEnabled: true, killSwitch: false, settingsOn: true, allowlist: [1], assembled: true,
      }),
      findDesktopContainerId: async () => {
        finds += 1;
        return id;
      },
      now: () => 1_000,
    };
    assert.equal(await makeDesktopEnsureAttached(7n, deps), null);
    id = 42;
    assert.equal(await makeDesktopEnsureAttached(7n, deps), null);
    assert.equal(finds, 1);
  });

  test("invalidateDesktopRowMiss forces a SELECT within TTL, not silent docker", async () => {
    resetDesktopEnsureCacheForTest();
    let finds = 0;
    let id: number | null = null;
    const deps = {
      flags: async () => ({
        envEnabled: true, killSwitch: false, settingsOn: true, allowlist: [1], assembled: true,
      }),
      findDesktopContainerId: async () => {
        finds += 1;
        return id;
      },
      now: () => 1_000,
    };
    assert.equal(await makeDesktopEnsureAttached(7n, deps), null);
    id = 42;
    invalidateDesktopRowMiss(7);
    await assert.rejects(
      () => makeDesktopEnsureAttached(7n, deps),
      (e: unknown) => e instanceof ContainerUnreadyError && e.reason === "desktop_offline",
    );
    assert.equal(finds, 2);
  });
});
