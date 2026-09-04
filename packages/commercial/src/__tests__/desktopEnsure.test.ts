import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ContainerUnreadyError } from "../ws/userChatBridge.js";
import {
  makeDesktopOrDockerResolver,
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
