import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMemoryDesktopTunnelRegistry } from "../ws/desktopTunnelRegistry.js";

describe("DesktopTunnelRegistry", () => {
  test("single slot kicks previous handle", () => {
    const reg = createMemoryDesktopTunnelRegistry();
    let closed = 0;
    reg.attach(1, { close: () => { closed += 1; } }, {
      deviceId: "d1", uid: 1, expiresAt: new Date(Date.now() + 60_000),
    });
    reg.attach(1, { close: () => {} }, {
      deviceId: "d1", uid: 1, expiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(closed, 1);
    assert.equal(reg.size(), 1);
  });

  test("expiry timer drops the slot", async () => {
    const reg = createMemoryDesktopTunnelRegistry();
    let closed = 0;
    reg.attach(3, { close: () => { closed += 1; } }, {
      deviceId: "d3", uid: 1, expiresAt: new Date(Date.now() + 25),
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(closed, 1);
    assert.equal(reg.get(3), undefined);
    assert.equal(reg.size(), 0);
  });

  test("drop closes handle and mint-style drop is idempotent", () => {
    const reg = createMemoryDesktopTunnelRegistry();
    let closed = 0;
    reg.attach(9, { close: () => { closed += 1; } }, {
      deviceId: "d9", uid: 2, expiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(reg.drop(9, "token_rotated"), true);
    assert.equal(closed, 1);
    assert.equal(reg.drop(9), false);
    assert.equal(reg.get(9), undefined);
  });
});
