/**
 * OCV5-424 — shared pool policy: outcome classification, the cooldown state
 * machine, WRH ranking/failover, and the single recovery actor.
 *
 * Run: npx tsx --test packages/commercial/src/account-pool/policy/policy.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_POLICY, backoffMs, decide, decideProbe, reasonNeedsProbe } from "./decide.js";
import {
  attachPoolOutcome,
  classifyHttpOutcome,
  outcomeLabel,
  parseResetAt,
  parseRetryAfterMs,
  readPoolOutcome,
} from "./outcome.js";
import { type PoolAdapter, startPoolRecoveryActor } from "./registry.js";
import { mayFailoverWithinRequest, rankWRH, wrhScore } from "./select.js";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const MIN = 60_000;
const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });

describe("classifyHttpOutcome", () => {
  it("2xx is success, 400-class request errors are client_error", () => {
    assert.deepEqual(classifyHttpOutcome(200, null, NOW), { kind: "success" });
    assert.equal(classifyHttpOutcome(404, null, NOW).kind, "client_error");
    assert.equal(classifyHttpOutcome(422, null, NOW).kind, "client_error");
  });

  it("429 with a short Retry-After is rate_limited and carries the delay", () => {
    const o = classifyHttpOutcome(429, headers({ "retry-after": "42" }), NOW);
    assert.deepEqual(o, { kind: "rate_limited", retryAfterMs: 42_000 });
  });

  it("429 whose window resets hours away is quota_exhausted with that reset", () => {
    const reset = Math.floor(NOW.getTime() / 1000) + 3 * 3600;
    const o = classifyHttpOutcome(429, headers({ "anthropic-ratelimit-unified-reset": String(reset) }), NOW);
    assert.equal(o.kind, "quota_exhausted");
    assert.equal(o.kind === "quota_exhausted" && o.resetAt?.getTime(), reset * 1000);
  });

  it("402 and an explicit quota hint are quota; 401 auth; 403 a strike; 5xx upstream; 408 network", () => {
    assert.equal(classifyHttpOutcome(402, null, NOW).kind, "quota_exhausted");
    assert.equal(classifyHttpOutcome(403, null, NOW, { quotaHint: true }).kind, "quota_exhausted");
    assert.equal(classifyHttpOutcome(401, null, NOW).kind, "auth_invalid");
    assert.equal(classifyHttpOutcome(403, null, NOW).kind, "upstream_error");
    assert.equal(classifyHttpOutcome(529, null, NOW).kind, "upstream_error");
    assert.equal(classifyHttpOutcome(408, null, NOW).kind, "network");
  });

  it("parses Retry-After dates and reset epochs in s / ms / ISO", () => {
    assert.equal(parseRetryAfterMs(new Date(NOW.getTime() + 90_000).toUTCString(), NOW), 90_000);
    assert.equal(parseRetryAfterMs("soon", NOW), null);
    assert.equal(parseResetAt("1791950400")?.getTime(), 1791950400_000);
    assert.equal(parseResetAt("1791950400000")?.getTime(), 1791950400_000);
    assert.equal(parseResetAt("2026-10-14T13:00:00Z")?.toISOString(), "2026-10-14T13:00:00.000Z");
    assert.equal(parseResetAt(""), null);
  });

  it("an outcome attached to an error survives to the release path", () => {
    const err = attachPoolOutcome(new Error("upstream returned 429"), { kind: "rate_limited", retryAfterMs: 5000 });
    assert.deepEqual(readPoolOutcome(err), { kind: "rate_limited", retryAfterMs: 5000 });
    assert.equal(readPoolOutcome(new Error("plain")), null);
    assert.equal(readPoolOutcome("not an error"), null);
    assert.equal(outcomeLabel({ kind: "rate_limited", retryAfterMs: 5000 }), "rate_limited:5s");
  });
});

describe("decide (shared cooldown state machine)", () => {
  const active = { status: "active" as const, healthScore: 80, backoffLevel: 0 };

  it("success raises health, clears the backoff level, never changes status", () => {
    const t = decide({ ...active, backoffLevel: 4 }, { kind: "success" }, NOW);
    assert.equal(t.status, "active");
    assert.equal(t.healthScore, 90);
    assert.equal(t.backoffLevel, 0);
    assert.equal(t.changed, false);
    assert.equal(decide({ status: "cooldown", healthScore: 50, backoffLevel: 1 }, { kind: "success" }, NOW).status, "cooldown");
  });

  it("rate_limited cools immediately for Retry-After clamped to [15s, 15min]", () => {
    const t = decide(active, { kind: "rate_limited", retryAfterMs: 42_000 }, NOW);
    assert.equal(t.status, "cooldown");
    assert.equal(t.cooldownReason, "rate_limited");
    assert.equal(t.cooldownUntil?.getTime(), NOW.getTime() + 42_000);
    assert.equal(t.needsProbe, false);
    assert.equal(decide(active, { kind: "rate_limited", retryAfterMs: 1 }, NOW).cooldownUntil?.getTime(), NOW.getTime() + 15_000);
    assert.equal(decide(active, { kind: "rate_limited", retryAfterMs: 3_600_000 }, NOW).cooldownUntil?.getTime(), NOW.getTime() + 15 * MIN);
  });

  it("rate_limited without Retry-After backs off 30s·2^level up to 15min", () => {
    assert.equal(decide(active, { kind: "rate_limited" }, NOW).cooldownUntil?.getTime(), NOW.getTime() + 30_000);
    const t = decide({ ...active, backoffLevel: 2 }, { kind: "rate_limited" }, NOW);
    assert.equal(t.cooldownUntil?.getTime(), NOW.getTime() + 120_000);
    assert.equal(t.backoffLevel, 3);
    assert.equal(decide({ ...active, backoffLevel: 10 }, { kind: "rate_limited" }, NOW).cooldownUntil?.getTime(), NOW.getTime() + 15 * MIN);
  });

  it("quota waits for the reported reset (max 7d) or 1h, without hurting health or level", () => {
    const resetAt = new Date(NOW.getTime() + 3 * 3600_000);
    const t = decide({ ...active, backoffLevel: 2 }, { kind: "quota_exhausted", resetAt }, NOW);
    assert.equal(t.cooldownReason, "quota");
    assert.equal(t.cooldownUntil?.getTime(), resetAt.getTime());
    assert.equal(t.healthScore, 80);
    assert.equal(t.backoffLevel, 2);
    assert.equal(decide(active, { kind: "quota_exhausted" }, NOW).cooldownUntil?.getTime(), NOW.getTime() + 3600_000);
    const far = new Date(NOW.getTime() + 30 * 24 * 3600_000);
    assert.equal(decide(active, { kind: "quota_exhausted", resetAt: far }, NOW).cooldownUntil?.getTime(), NOW.getTime() + 7 * 24 * 3600_000);
  });

  it("auth_invalid never disables: cooldown that needs a probe, 5min·2^level up to 6h", () => {
    const t = decide(active, { kind: "auth_invalid" }, NOW);
    assert.equal(t.status, "cooldown");
    assert.equal(t.cooldownReason, "auth");
    assert.equal(t.needsProbe, true);
    assert.equal(t.cooldownUntil?.getTime(), NOW.getTime() + 5 * MIN);
    assert.equal(t.healthScore, 60);
    const capped = decide({ ...active, backoffLevel: 12 }, { kind: "auth_invalid" }, NOW);
    assert.equal(capped.cooldownUntil?.getTime(), NOW.getTime() + 6 * 3600_000);
  });

  it("credential_corrupt cools with a probe and zero health", () => {
    const t = decide(active, { kind: "credential_corrupt" }, NOW);
    assert.equal(t.cooldownReason, "credential");
    assert.equal(t.needsProbe, true);
    assert.equal(t.healthScore, 0);
    assert.equal(t.cooldownUntil?.getTime(), NOW.getTime() + 30 * MIN);
  });

  it("upstream_error is a strike: cooldown only at the threshold and only from active", () => {
    const one = decide({ ...active, consecutiveFailures: 1 }, { kind: "upstream_error" }, NOW);
    assert.equal(one.status, "active");
    assert.equal(one.healthScore, 60);
    assert.equal(one.failDelta, 1);
    const three = decide({ ...active, consecutiveFailures: 3 }, { kind: "upstream_error" }, NOW);
    assert.equal(three.status, "cooldown");
    assert.equal(three.cooldownReason, "upstream");
    assert.equal(three.cooldownUntil?.getTime(), NOW.getTime() + 10 * MIN);
    const cooling = decide({ status: "cooldown", healthScore: 40, backoffLevel: 1, consecutiveFailures: 5 }, { kind: "upstream_error" }, NOW);
    assert.equal(cooling.changed, false);
  });

  it("network and client errors change nothing", () => {
    for (const kind of ["network", "client_error"] as const) {
      const t = decide(active, { kind }, NOW);
      assert.equal(t.changed, false);
      assert.equal(t.healthScore, 80);
      assert.equal(t.failDelta, 0);
    }
  });

  it("admin states are never left by the policy", () => {
    for (const status of ["disabled", "banned"] as const) {
      for (const o of [
        { kind: "rate_limited" as const },
        { kind: "auth_invalid" as const },
        { kind: "credential_corrupt" as const },
        { kind: "quota_exhausted" as const },
      ]) {
        const t = decide({ status, healthScore: 50, backoffLevel: 0, consecutiveFailures: 9 }, o, NOW);
        assert.equal(t.status, status);
        assert.equal(t.changed, false);
      }
      assert.equal(decideProbe({ status, healthScore: 0, backoffLevel: 0, cooldownReason: "auth" }, true, NOW).status, status);
    }
  });

  it("every cooldown is finite, so recovery never needs a human", () => {
    const kinds = ["rate_limited", "quota_exhausted", "auth_invalid", "credential_corrupt"] as const;
    for (const kind of kinds) {
      for (let level = 0; level <= DEFAULT_POLICY.maxBackoffLevel; level += 1) {
        const t = decide({ status: "active", healthScore: 50, backoffLevel: level }, { kind }, NOW);
        assert.ok(t.cooldownUntil, `${kind}@${level}`);
        assert.ok(t.cooldownUntil.getTime() - NOW.getTime() <= 7 * 24 * 3600_000, `${kind}@${level}`);
      }
    }
    assert.equal(backoffMs(1000, 50, 5000), 5000);
  });

  it("a probe reactivates at half health; a failed probe escalates the same reason", () => {
    const ok = decideProbe({ status: "cooldown", healthScore: 0, backoffLevel: 3, cooldownReason: "auth" }, true, NOW);
    assert.equal(ok.status, "active");
    assert.equal(ok.healthScore, 50);
    assert.equal(ok.cooldownReason, null);
    const bad = decideProbe({ status: "cooldown", healthScore: 0, backoffLevel: 3, cooldownReason: "credential" }, false, NOW);
    assert.equal(bad.status, "cooldown");
    assert.equal(bad.cooldownReason, "credential");
    assert.equal(bad.backoffLevel, 4);
    assert.equal(reasonNeedsProbe("auth"), true);
    assert.equal(reasonNeedsProbe("quota"), false);
  });
});

describe("rankWRH / failover", () => {
  const members = [
    { id: "a", w: 100, tier: 0 },
    { id: "b", w: 100, tier: 0 },
    { id: "c", w: 100, tier: 1 },
  ];
  const opts = { id: (m: { id: string }) => m.id, weight: (m: { w: number }) => m.w, tier: (m: { tier: number }) => m.tier };

  it("is deterministic per key and keeps later tiers after earlier ones", () => {
    for (const key of ["s1", "s2", "s3", "s4"]) {
      const r1 = rankWRH(members, { ...opts, key }).map((m) => m.id);
      const r2 = rankWRH([...members].reverse(), { ...opts, key }).map((m) => m.id);
      assert.deepEqual(r1, r2);
      assert.equal(r1[2], "c");
    }
  });

  it("prefers heavier members in proportion to weight", () => {
    const heavy = [
      { id: "x", w: 900, tier: 0 },
      { id: "y", w: 100, tier: 0 },
    ];
    let x = 0;
    for (let i = 0; i < 2000; i += 1) if (rankWRH(heavy, { ...opts, key: `k${i}` })[0].id === "x") x += 1;
    assert.ok(x > 1650 && x < 1950, `x won ${x}/2000`);
    assert.ok(Number.isFinite(wrhScore("k", "id", 0)));
  });

  it("subscription pools never switch members inside a request; API-key pools may before the first byte", () => {
    assert.equal(mayFailoverWithinRequest("next_request", "rate_limited", false), false);
    assert.equal(mayFailoverWithinRequest("before_first_byte", "rate_limited", false), true);
    assert.equal(mayFailoverWithinRequest("before_first_byte", "rate_limited", true), false);
    assert.equal(mayFailoverWithinRequest("before_first_byte", "client_error", false), false);
  });
});

describe("startPoolRecoveryActor", () => {
  it("half-opens and probes every adapter, routing probe results back to the adapter", async () => {
    const applied: Array<[string, boolean]> = [];
    const mk = (name: string, ok: boolean): PoolAdapter => ({
      name,
      memberKind: "api_key",
      halfOpenDue: async () => 2,
      listDueProbes: async () => [{ id: `${name}-1`, service: name, reason: "auth" }],
      probe: async () => (ok ? { ok: true } : { ok: false, detail: "still_bad" }),
      applyProbeResult: async (m, r) => {
        applied.push([m.id, r.ok]);
      },
    });
    const h = startPoolRecoveryActor({ intervalMs: 3_600_000, adapters: () => [mk("p1", true), mk("p2", false)] });
    try {
      const r = await h.runNow();
      assert.deepEqual(r, { halfOpened: 4, probed: 2, recovered: 1 });
      assert.deepEqual(applied, [["p1-1", true], ["p2-1", false]]);
    } finally {
      h.stop();
    }
  });

  it("a throwing probe is a transient result and one adapter's failure does not stop the others", async () => {
    const seen: string[] = [];
    const broken: PoolAdapter = {
      name: "broken",
      memberKind: "account",
      halfOpenDue: async () => {
        throw new Error("db down");
      },
      listDueProbes: async () => [{ id: "b1", service: "claude", reason: "auth" }],
      probe: async () => {
        throw new Error("boom");
      },
      applyProbeResult: async (_m, r) => {
        seen.push(!r.ok && "transient" in r ? "transient" : "other");
      },
    };
    const h = startPoolRecoveryActor({ intervalMs: 3_600_000, adapters: () => [broken], onError: () => {} });
    try {
      const r = await h.runNow();
      assert.equal(r.probed, 1);
      assert.deepEqual(seen, ["transient"]);
    } finally {
      h.stop();
    }
  });
});
