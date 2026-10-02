import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOX_RUNS_CEILING, resolveBoxCapacityPolicy, validRunCapacity } from "./boxCapacityPolicy.js";

describe("OCV5-297 Box capacity policy", () => {
  it("commercial keeps one run and no Box pool or Box rate", () => {
    assert.deepEqual(resolveBoxCapacityPolicy({}), {
      maxRunsPerAccount: 1, maxRunsPerUser: 1, proxyConcurrency: null, proxyRatePerMinute: null,
    });
  });

  it("selfhost flavor defaults to ten concurrent Box sessions", () => {
    for (const env of [{ SELFHOST_CURSOR_EGRESS: "1" }, { OC_SELFHOST_CURSOR_EGRESS: "1" }]) {
      assert.deepEqual(resolveBoxCapacityPolicy(env), {
        maxRunsPerAccount: 10, maxRunsPerUser: 10, proxyConcurrency: 20, proxyRatePerMinute: 120,
      });
    }
  });

  it("env overrides within the ceiling, with no uid/account/instance special case", () => {
    const policy = resolveBoxCapacityPolicy({
      SELFHOST_CURSOR_EGRESS: "1", OC_BOX_MAX_RUNS_PER_ACCOUNT: "16", OC_BOX_MAX_RUNS_PER_USER: "12",
      OC_BOX_PROXY_MAX_CONCURRENT: "32", OC_BOX_PROXY_RATE_PER_MIN: "240", OC_INSTANCE_ID: "anything",
    });
    assert.deepEqual(policy, {
      maxRunsPerAccount: 16, maxRunsPerUser: 12, proxyConcurrency: 32, proxyRatePerMinute: 240,
    });
    assert.equal(resolveBoxCapacityPolicy({ OC_BOX_MAX_RUNS_PER_ACCOUNT: "4" }).maxRunsPerAccount, 4,
      "commercial can opt in explicitly");
  });

  it("invalid or out-of-range values fall back to defaults instead of failing startup", () => {
    const policy = resolveBoxCapacityPolicy({
      SELFHOST_CURSOR_EGRESS: "1", OC_BOX_MAX_RUNS_PER_ACCOUNT: "17", OC_BOX_MAX_RUNS_PER_USER: "0",
      OC_BOX_PROXY_MAX_CONCURRENT: "ten", OC_BOX_PROXY_RATE_PER_MIN: "5",
    });
    assert.deepEqual(policy, {
      maxRunsPerAccount: 10, maxRunsPerUser: 10, proxyConcurrency: 20, proxyRatePerMinute: 120,
    });
  });

  it("shares one ceiling with the registry and the journal", () => {
    assert.equal(BOX_RUNS_CEILING, 16);
    assert.equal(validRunCapacity(16), true);
    assert.equal(validRunCapacity(17), false);
    assert.equal(validRunCapacity(0), false);
    assert.equal(validRunCapacity(2.5), false);
  });
});
