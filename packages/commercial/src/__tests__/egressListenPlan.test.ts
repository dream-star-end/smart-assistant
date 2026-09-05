// egress listenPlan 单元测试(蓝绿双槽 · sd_listen_fds 判定)。纯函数,不起 HTTP。
//
// Run: npx tsx --test packages/commercial/src/__tests__/egressListenPlan.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeListenPlan,
  parseEgressSlot,
  EGRESS_SLOT_PRIVATE_PORT,
} from "../egress/listenPlan.js";

describe("parseEgressSlot", () => {
  it("accepts only A/B", () => {
    assert.equal(parseEgressSlot("A"), "A");
    assert.equal(parseEgressSlot("B"), "B");
    assert.equal(parseEgressSlot("a"), null);
    assert.equal(parseEgressSlot(""), null);
    assert.equal(parseEgressSlot(undefined), null);
  });
});

describe("computeListenPlan", () => {
  it("legacy: no LISTEN_* and no slot → self_bind without private port", () => {
    const p = computeListenPlan({}, 4242);
    assert.deepEqual(p, { mode: "self_bind", fd: null, slot: null, privatePort: null });
  });

  it("sd_activation when LISTEN_PID matches self and LISTEN_FDS=1", () => {
    const p = computeListenPlan({ LISTEN_PID: "4242", LISTEN_FDS: "1", OC_EGRESS_SLOT: "A" }, 4242);
    assert.equal(p.mode, "sd_activation");
    assert.equal(p.fd, 3);
    assert.equal(p.slot, "A");
    assert.equal(p.privatePort, EGRESS_SLOT_PRIVATE_PORT.A);
  });

  it("LISTEN_PID of another process is ignored → self_bind (fd not ours)", () => {
    const p = computeListenPlan({ LISTEN_PID: "1", LISTEN_FDS: "1", OC_EGRESS_SLOT: "B" }, 4242);
    assert.equal(p.mode, "self_bind");
    assert.equal(p.fd, null);
    assert.equal(p.slot, "B");
    assert.equal(p.privatePort, EGRESS_SLOT_PRIVATE_PORT.B);
  });

  it("LISTEN_FDS != 1 with matching pid is a unit misconfiguration → throws", () => {
    assert.throws(
      () => computeListenPlan({ LISTEN_PID: "7", LISTEN_FDS: "2", OC_EGRESS_SLOT: "A" }, 7),
      /LISTEN_FDS=2/,
    );
    assert.throws(
      () => computeListenPlan({ LISTEN_PID: "7", LISTEN_FDS: "0" }, 7),
      /LISTEN_FDS=0/,
    );
  });

  it("slot without sd fd falls back to self_bind but keeps private port", () => {
    const p = computeListenPlan({ OC_EGRESS_SLOT: "B" }, 9);
    assert.deepEqual(p, { mode: "self_bind", fd: null, slot: "B", privatePort: 18899 });
  });

  it("slot ports are distinct and outside the shared 18892", () => {
    assert.notEqual(EGRESS_SLOT_PRIVATE_PORT.A, EGRESS_SLOT_PRIVATE_PORT.B);
    assert.notEqual(EGRESS_SLOT_PRIVATE_PORT.A, 18892);
    assert.notEqual(EGRESS_SLOT_PRIVATE_PORT.B, 18892);
  });
});
