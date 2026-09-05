import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  makeDesktopContainerTransport,
  selectContainerTransport,
} from "../wechat/desktopContainerTransport.js";
import type { ContainerTransport } from "../wechat/inboundDispatcher.js";

function stubTransport(name: string): ContainerTransport {
  return {
    async post() {
      throw new Error(`${name} must not post`);
    },
  };
}

describe("selectContainerTransport (W-R04)", () => {
  test("desktop endpoint still returns docker transport", () => {
    const docker = stubTransport("docker");
    const desktop = stubTransport("desktop");
    const got = selectContainerTransport(
      { desktop: { containerId: 9 }, containerId: 9 },
      docker,
      desktop,
    );
    assert.equal(got, docker);
  });

  test("non-desktop endpoint returns docker transport", () => {
    const docker = stubTransport("docker");
    const desktop = stubTransport("desktop");
    const got = selectContainerTransport(
      { host: "172.31.0.9", port: 18789, containerId: 2 } as { containerId: number },
      docker,
      desktop,
    );
    assert.equal(got, docker);
  });

  test("makeDesktopContainerTransport still exists for reconciler (not inbound)", () => {
    const t = makeDesktopContainerTransport();
    assert.equal(t.supportsTunnel, true);
    assert.equal(typeof t.request, "function");
  });
});
