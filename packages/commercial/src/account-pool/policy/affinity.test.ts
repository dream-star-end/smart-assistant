/**
 * OCV5-424 — user-level affinity: pure decision rules (docs/ocv5-424-user-affinity.md §5–§7).
 *
 * Run: npx tsx --test packages/commercial/src/account-pool/policy/affinity.test.ts
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { PIN_LONG_COOLDOWN_MS } from "../store.js";
import {
  AFFINITY_LONG_COOLDOWN_MS,
  AFFINITY_MAX_MIGRATIONS_PER_WINDOW,
  AFFINITY_MIGRATION_WINDOW_MS,
  type AffinityBinding,
  type AffinityCandidate,
  _resetAffinityCapsForTest,
  acquireInflight,
  affinitySettings,
  chooseByLoad,
  classifyUnavailable,
  configureAffinitySettings,
  decideAffinity,
  inflightCount,
  noteAdmission,
  releaseInflight,
  underRateCap,
} from "./affinity.js";

const NOW = new Date("2026-10-15T08:00:00Z");
const cand = (id: string, capacity = 1, lastUsedAt: Date | null = null): AffinityCandidate => ({ memberKind: "account", id, capacity, lastUsedAt });
const bound = (memberId: string, over: Partial<AffinityBinding> = {}): AffinityBinding => ({
  memberKind: "account",
  memberId,
  lastUsedAt: NOW,
  expiresAt: new Date(NOW.getTime() + 86_400_000),
  migrationsRecent: 0,
  migrationsWindowStart: null,
  ...over,
});
const none = new Map<string, number>();

describe("user affinity decisions", () => {
  it("uses the long-cooldown boundary of session pins", () => {
    assert.equal(AFFINITY_LONG_COOLDOWN_MS, PIN_LONG_COOLDOWN_MS);
  });

  it("stays on the bound member while it is a candidate (every session of the user)", () => {
    const d = decideAffinity({ binding: bound("2"), candidates: [cand("1"), cand("2")], boundState: null, load: none, maxUsers: 8, now: NOW });
    assert.equal(d?.action, "stay");
    assert.equal(d?.member.id, "2");
  });

  it("a healthy bound member filtered out of this request (model/group/caps) spills without rebinding", () => {
    const d = decideAffinity({
      binding: bound("1"),
      candidates: [cand("2")],
      boundState: { status: "active", cooldownReason: null, cooldownUntil: null },
      load: none, maxUsers: 8, now: NOW,
    });
    assert.equal(d?.action, "spill");
    assert.equal(d?.member.id, "2");
  });

  it("a short cooldown spills; a long, quota, auth or credential cooldown migrates", () => {
    const short = { status: "cooldown", cooldownReason: "rate_limited", cooldownUntil: new Date(NOW.getTime() + 60_000) };
    assert.equal(classifyUnavailable(short, NOW), "temporary");
    assert.equal(classifyUnavailable({ ...short, cooldownUntil: new Date(NOW.getTime() + AFFINITY_LONG_COOLDOWN_MS + 1) }, NOW), "persistent");
    for (const reason of ["quota", "auth", "credential"]) {
      assert.equal(classifyUnavailable({ ...short, cooldownReason: reason }, NOW), "persistent", reason);
    }
    for (const status of ["disabled", "banned", null]) {
      assert.equal(classifyUnavailable({ status, cooldownReason: null, cooldownUntil: null }, NOW), "persistent", String(status));
    }
    const d = decideAffinity({
      binding: bound("1"), candidates: [cand("2"), cand("3")],
      boundState: { status: "cooldown", cooldownReason: "quota", cooldownUntil: null },
      load: new Map([["2", 3], ["3", 1]]), maxUsers: 8, now: NOW,
    });
    assert.equal(d?.action, "migrate");
    assert.equal(d?.member.id, "3", "migrates to the least loaded member");
    assert.equal(d?.reason, "cooldown_quota");
  });

  it("debounces: after the max migrations in the window it only spills", () => {
    const b = bound("1", { migrationsRecent: AFFINITY_MAX_MIGRATIONS_PER_WINDOW, migrationsWindowStart: new Date(NOW.getTime() - 60_000) });
    const st = { status: "disabled", cooldownReason: null, cooldownUntil: null };
    const d = decideAffinity({ binding: b, candidates: [cand("2")], boundState: st, load: none, maxUsers: 8, now: NOW });
    assert.equal(d?.action, "spill");
    assert.equal(d?.reason, "migration_debounce");
    const later = decideAffinity({
      binding: bound("1", { migrationsRecent: AFFINITY_MAX_MIGRATIONS_PER_WINDOW, migrationsWindowStart: new Date(NOW.getTime() - AFFINITY_MIGRATION_WINDOW_MS - 1) }),
      candidates: [cand("2")], boundState: st, load: none, maxUsers: 8, now: NOW,
    });
    assert.equal(later?.action, "migrate", "a new window allows migration again");
  });

  it("no binding or an expired one binds to the least loaded member", () => {
    const fresh = decideAffinity({ binding: null, candidates: [cand("1"), cand("2")], boundState: null, load: new Map([["1", 2]]), maxUsers: 8, now: NOW });
    assert.equal(fresh?.action, "bind");
    assert.equal(fresh?.member.id, "2");
    const expired = decideAffinity({
      binding: bound("1", { expiresAt: new Date(NOW.getTime() - 1) }),
      candidates: [cand("1"), cand("2")], boundState: null, load: new Map([["1", 2]]), maxUsers: 8, now: NOW,
    });
    assert.equal(expired?.action, "bind");
    assert.equal(expired?.member.id, "2");
  });

  it("no candidates → null (the pool's own no-member path applies)", () => {
    assert.equal(decideAffinity({ binding: bound("1"), candidates: [], boundState: null, load: none, maxUsers: 8, now: NOW }), null);
  });
});

describe("load spreading and the per-member user cap", () => {
  it("prefers fewer bound users per capacity; ties go to the least recently used, then the id", () => {
    const old = new Date(NOW.getTime() - 3_600_000);
    assert.equal(chooseByLoad([cand("1", 1), cand("2", 2)], new Map([["1", 1], ["2", 2]]), null)?.member.id, "2", "(2+1)/2 < (1+1)/1");
    assert.equal(chooseByLoad([cand("1", 1, NOW), cand("2", 1, old)], none, null)?.member.id, "2");
    assert.equal(chooseByLoad([cand("b"), cand("a")], none, null)?.member.id, "a");
  });

  it("members at the cap take no new users unless every member is at the cap", () => {
    const load = new Map([["1", 8], ["2", 3]]);
    assert.deepEqual(chooseByLoad([cand("1", 10), cand("2", 1)], load, 8), { member: cand("2", 1), overCap: false });
    const full = chooseByLoad([cand("1"), cand("2")], new Map([["1", 9], ["2", 8]]), 8);
    assert.equal(full?.member.id, "2");
    assert.equal(full?.overCap, true);
  });
});

describe("per-member rate and in-flight caps", () => {
  beforeEach(() => _resetAffinityCapsForTest());

  it("a member at its per-minute cap is out until the window slides", () => {
    const t0 = NOW.getTime();
    for (let i = 0; i < 3; i++) noteAdmission("antigravity", "1", t0 + i);
    assert.equal(underRateCap("antigravity", "1", 3, t0 + 10), false);
    assert.equal(underRateCap("antigravity", "2", 3, t0 + 10), true, "per member");
    assert.equal(underRateCap("antigravity", "1", 3, t0 + 60_001), true);
  });

  it("in-flight units are released by token and expire if a release is lost", () => {
    const t0 = NOW.getTime();
    acquireInflight("antigravity", "1", "req-a", t0);
    acquireInflight("antigravity", "1", "req-b", t0, 1_000);
    assert.equal(inflightCount("antigravity", "1", t0), 2);
    releaseInflight("req-a");
    assert.equal(inflightCount("antigravity", "1", t0), 1);
    assert.equal(inflightCount("antigravity", "1", t0 + 1_001), 0, "expired unit dropped");
    releaseInflight("unknown");
  });

  it("settings come from the admin loader, cached; a failed read keeps the last/default values", async () => {
    let calls = 0;
    configureAffinitySettings(async () => {
      calls += 1;
      if (calls > 1) throw new Error("db down");
      return { maxUsersPerSubscription: 5, ratePerMin: 7, antigravityInflight: 2, antigravityRatePerMin: 9 };
    });
    const t0 = NOW.getTime();
    assert.equal((await affinitySettings(t0)).ratePerMin, 7);
    assert.equal((await affinitySettings(t0 + 1_000)).ratePerMin, 7, "cached");
    assert.equal(calls, 1);
    assert.equal((await affinitySettings(t0 + 61_000)).ratePerMin, 7, "failed refresh keeps the last value");
  });
});
