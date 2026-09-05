import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ContainerUnreadyError } from "../ws/userChatBridge.js";
import {
  makeDesktopOrDockerResolver,
  makeInboundChannelResolver,
  type DesktopAttachedEndpoint,
} from "../agent-sandbox/desktopEnsure.js";

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
