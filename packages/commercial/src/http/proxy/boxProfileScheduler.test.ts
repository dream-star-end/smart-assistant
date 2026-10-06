import test from "node:test";
import assert from "node:assert/strict";
import { BOX_PROFILE_POLICY, pickBoxProfile, rankBoxProfiles, type BoxProfileCandidate } from "./boxProfileScheduler.js";

const cand = (accountId: bigint, profile: string, over: Partial<BoxProfileCandidate> = {}): BoxProfileCandidate =>
  ({ accountId, profile, isDefault: profile === "default", weight: 1, utilization: null,
    cooldownActive: false, loginLoad: 0, boxLoad: 0, ...over });
const three = (over: Record<string, Partial<BoxProfileCandidate>> = {}) => [
  cand(1n, "default", over["1:default"]), cand(1n, "b", over["1:b"]), cand(2n, "default", over["2:default"])];
const label = (c: BoxProfileCandidate | undefined) => c ? `${c.accountId}:${c.profile}` : "none";
const users = Array.from({ length: 600 }, (_, i) => String(1000 + i));

test("a user keeps the same login every time (affinity)", () => {
  for (const uid of users.slice(0, 50)) {
    const first = pickBoxProfile({ candidates: three(), affinityKey: uid })!;
    for (let i = 0; i < 5; i++) {
      const again = pickBoxProfile({ candidates: three(), affinityKey: uid })!;
      assert.equal(label(again.candidate), label(first.candidate));
      assert.equal(again.reason, "affinity");
    }
  }
});

test("users spread over every enabled login, the default taking the larger share", () => {
  const counts = new Map<string, number>();
  for (const uid of users) {
    const key = label(pickBoxProfile({ candidates: three(), affinityKey: uid })!.candidate);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  assert.equal(counts.size, 3);
  for (const n of counts.values()) assert.ok(n > 80, `each login gets real traffic: ${[...counts]}`);
  assert.ok(counts.get("1:default")! > counts.get("1:b")!, "default bonus");
});

test("a benched login moves only its own users, and they come back when it recovers", () => {
  const before = new Map(users.map((u) => [u, label(pickBoxProfile({ candidates: three(), affinityKey: u })!.candidate)]));
  const benched = three({ "1:b": { cooldownActive: true } });
  let moved = 0, stayed = 0;
  for (const u of users) {
    const pick = pickBoxProfile({ candidates: benched, affinityKey: u })!;
    assert.notEqual(label(pick.candidate), "1:b");
    if (before.get(u) === "1:b") { moved++; assert.equal(pick.reason, "affinity"); } // 1:b is not in its usable set
    else { stayed++; assert.equal(label(pick.candidate), before.get(u), "unaffected users do not move"); }
  }
  assert.ok(moved > 0 && stayed > 0);
  for (const u of users) {
    assert.equal(label(pickBoxProfile({ candidates: three(), affinityKey: u })!.candidate), before.get(u), "recovery restores affinity");
  }
});

test("a login near its quota spills its users to the next-ranked login", () => {
  const hot = three({ "1:default": { utilization: 0.95 } });
  let spilled = 0;
  for (const u of users) {
    const base = pickBoxProfile({ candidates: three(), affinityKey: u })!;
    const pick = pickBoxProfile({ candidates: hot, affinityKey: u })!;
    if (label(base.candidate) === "1:default") { spilled++; assert.equal(pick.reason, "spill_unhealthy"); assert.notEqual(label(pick.candidate), "1:default"); }
    else assert.equal(label(pick.candidate), label(base.candidate));
  }
  assert.ok(spilled > 0);
});

test("a busy login or Box spills by load", () => {
  const busy = three({ "1:default": { loginLoad: BOX_PROFILE_POLICY.loginSpillLoad },
    "1:b": { boxLoad: BOX_PROFILE_POLICY.boxSpillLoad } });
  for (const u of users.slice(0, 100)) {
    const pick = pickBoxProfile({ candidates: busy, affinityKey: u })!;
    assert.ok(label(pick.candidate) === "2:default" || pick.reason === "affinity" || pick.reason === "spill_load");
    assert.notEqual(label(pick.candidate), "1:default");
  }
});

test("everything hot or full still returns the least-loaded healthy login; all benched returns null", () => {
  const full = three({ "1:default": { loginLoad: 15 }, "1:b": { loginLoad: 12 }, "2:default": { loginLoad: 13 } });
  const pick = pickBoxProfile({ candidates: full, affinityKey: "7" })!;
  assert.equal(pick.reason, "last_resort");
  assert.equal(label(pick.candidate), "1:b");
  const exhausted = three({ "1:default": { utilization: 0.99 }, "1:b": { utilization: 0.97 }, "2:default": { utilization: 0.995 } });
  assert.equal(label(pickBoxProfile({ candidates: exhausted, affinityKey: "7" })!.candidate), "1:b");
  const none = three({ "1:default": { cooldownActive: true }, "1:b": { cooldownActive: true }, "2:default": { cooldownActive: true } });
  assert.equal(pickBoxProfile({ candidates: none, affinityKey: "7" }), null);
});

test("ranking is deterministic and ignores load and utilization (weights stay static)", () => {
  const a = rankBoxProfiles(three(), "42").map(label);
  const b = rankBoxProfiles(three({ "1:b": { loginLoad: 9, utilization: 0.9 } }), "42").map(label);
  assert.deepEqual(a, b);
});
