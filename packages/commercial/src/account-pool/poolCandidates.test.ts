/**
 * poolCandidates / poolWeight — provider-neutral account-pool primitives.
 *
 * Run: npx tsx --test packages/commercial/src/account-pool/poolCandidates.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { accountPoolChannelFor, activePoolWhere } from "./poolCandidates.js";
import {
  dayBucket,
  expiryProximityFactor,
  hoursUntil,
  pctBucket,
  quotaHeadroom,
  resetProximityFactor,
  weightInputsCrossedBucket,
} from "./poolWeight.js";

const ENV_KEYS = ["OC_RUNTIME_CHANNEL", "OC_CODEX_ACCOUNT_RUNTIME_CHANNEL"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("accountPoolChannelFor", () => {
  it("claude and cursor pools are shared across channels", () => {
    process.env.OC_RUNTIME_CHANNEL = "v5";
    assert.equal(accountPoolChannelFor("claude"), null);
    assert.equal(accountPoolChannelFor("cursor"), null);
  });
  it("grok follows the runtime channel", () => {
    process.env.OC_RUNTIME_CHANNEL = "v5";
    delete process.env.OC_CODEX_ACCOUNT_RUNTIME_CHANNEL;
    assert.equal(accountPoolChannelFor("grok"), "v5");
  });
  it("codex follows the (overridable) Codex account-pool channel, not the runtime channel", () => {
    process.env.OC_RUNTIME_CHANNEL = "v3";
    process.env.OC_CODEX_ACCOUNT_RUNTIME_CHANNEL = "v5";
    assert.equal(accountPoolChannelFor("codex"), "v5");
    assert.equal(accountPoolChannelFor("grok"), "v3", "override must not leak into grok");
  });
});

describe("activePoolWhere", () => {
  it("claude: status + provider only, params numbered from 1", () => {
    process.env.OC_RUNTIME_CHANNEL = "v5";
    const w = activePoolWhere({ provider: "claude" });
    assert.deepEqual(w.clauses, ["status = 'active'", "provider = $1"]);
    assert.deepEqual(w.params, ["claude"]);
    assert.equal(w.nextParam, 2);
  });
  it("codex with group: channel then group, in placeholder order", () => {
    process.env.OC_RUNTIME_CHANNEL = "v5";
    delete process.env.OC_CODEX_ACCOUNT_RUNTIME_CHANNEL;
    const w = activePoolWhere({ provider: "codex", groupId: 7n });
    assert.deepEqual(w.clauses, [
      "status = 'active'",
      "provider = $1",
      "runtime_channel = $2",
      "group_id = $3",
    ]);
    assert.deepEqual(w.params, ["codex", "v5", "7"]);
    assert.equal(w.nextParam, 4);
  });
  it("null groupId is the same as omitting it", () => {
    process.env.OC_RUNTIME_CHANNEL = "v5";
    assert.deepEqual(activePoolWhere({ provider: "grok", groupId: null }), activePoolWhere({ provider: "grok" }));
  });
  it("startParam and alias let callers prepend their own params / join", () => {
    process.env.OC_RUNTIME_CHANNEL = "v5";
    const w = activePoolWhere({ provider: "grok", groupId: "3", startParam: 4, alias: "a" });
    assert.deepEqual(w.clauses, [
      "a.status = 'active'",
      "a.provider = $4",
      "a.runtime_channel = $5",
      "a.group_id = $6",
    ]);
    assert.deepEqual(w.params, ["grok", "v5", "3"]);
    assert.equal(w.nextParam, 7);
  });
});

describe("poolWeight primitives", () => {
  const NOW = new Date("2026-09-08T00:00:00Z");
  const h = (hours: number): Date => new Date(NOW.getTime() + hours * 3_600_000);

  it("hoursUntil handles null and non-finite", () => {
    assert.equal(hoursUntil(null, NOW), null);
    assert.equal(hoursUntil(undefined, NOW), null);
    assert.equal(hoursUntil(h(36), NOW), 36);
    assert.equal(hoursUntil(new Date(Number.NaN), NOW), null);
  });

  it("quotaHeadroom: unknown policy is the caller's, floor 0.02, optional 5% bucketing", () => {
    assert.equal(quotaHeadroom(null, { unknown: 1.0 }), 1.0);
    assert.equal(quotaHeadroom(null, { unknown: 0.5 }), 0.5);
    assert.equal(quotaHeadroom(Number.NaN, { unknown: 0.5 }), 0.5);
    assert.equal(quotaHeadroom(-5, { unknown: 0.5 }), 0.5, "negative → unknown");
    assert.equal(quotaHeadroom(0, { unknown: 0.5 }), 1);
    assert.equal(quotaHeadroom(72, { unknown: 0.5 }), 0.28);
    assert.equal(quotaHeadroom(72, { unknown: 0.5, bucketPct: 5 }), 0.3, "72 buckets to 70");
    assert.equal(quotaHeadroom(100, { unknown: 0.5 }), 0.02);
    assert.equal(quotaHeadroom(130, { unknown: 0.5 }), 0.02, "over 100 clamps to the floor");
  });

  it("resetProximityFactor: null 1, <24h 1.5, <72h 1.2, else 1", () => {
    assert.equal(resetProximityFactor(null, NOW), 1);
    assert.equal(resetProximityFactor(h(6), NOW), 1.5);
    assert.equal(resetProximityFactor(h(48), NOW), 1.2);
    assert.equal(resetProximityFactor(h(200), NOW), 1);
  });

  it("expiryProximityFactor: null 1, past 0.2 (overridable), <72h 1.5, <168h 1.2, else 1", () => {
    assert.equal(expiryProximityFactor(null, NOW), 1);
    assert.equal(expiryProximityFactor(h(-1), NOW), 0.2);
    assert.equal(expiryProximityFactor(h(-1), NOW, { expired: 0.1 }), 0.1);
    assert.equal(expiryProximityFactor(h(24), NOW), 1.5);
    assert.equal(expiryProximityFactor(h(120), NOW), 1.2);
    assert.equal(expiryProximityFactor(h(24 * 30), NOW), 1);
  });

  it("buckets: 5% for pct, UTC day for dates; null passes through", () => {
    assert.equal(pctBucket(null), null);
    assert.equal(pctBucket(9), 1);
    assert.equal(pctBucket(13), 2);
    assert.equal(dayBucket(null), null);
    assert.equal(dayBucket(new Date("2026-09-08T23:59:59Z")), dayBucket(new Date("2026-09-08T00:00:01Z")));
  });

  it("weightInputsCrossedBucket: same bucket false, boundary true, null→value true", () => {
    const day = new Date("2026-09-10T12:00:00Z");
    assert.equal(weightInputsCrossedBucket([[61, 63.9]], [[day, day]]), false);
    assert.equal(weightInputsCrossedBucket([[64, 65]], [[day, day]]), true);
    assert.equal(weightInputsCrossedBucket([[8, 8]], [[day, new Date("2026-09-11T00:00:00Z")]]), true);
    assert.equal(weightInputsCrossedBucket([[null, 8]], [[day, day]]), true);
    assert.equal(weightInputsCrossedBucket([], []), false);
  });
});
