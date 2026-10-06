import test from "node:test";
import assert from "node:assert/strict";
import { BoxProfileHealth, BOX_PROFILE_DEFAULT_COOLDOWN_MS } from "./boxProfileHealth.js";

test("a rejection benches the login until its reset, then it is usable again", () => {
  let now = 1_000_000;
  const saved: string[] = [];
  const health = new BoxProfileHealth(() => now, (key, state) => { saved.push(`${key}:${state.lastReason}`); });
  health.observe("1:b", { kind: "rate_limit", status: "rejected", utilization: 1.04, resetsAtMs: now + 600_000 });
  assert.equal(health.cooldownActive("1:b"), true);
  assert.equal(health.get("1:b")!.utilization, 1.04);
  assert.deepEqual(saved, ["1:b:quota_exhausted"]);
  now += 600_001;
  assert.equal(health.cooldownActive("1:b"), false);
  health.observe("1:b", { kind: "rate_limit", status: "allowed", utilization: 0.02, resetsAtMs: null });
  assert.equal(health.get("1:b")!.utilization, 0.02);
  assert.equal(health.get("1:b")!.cooldownUntilMs, null);
});
test("a rejection without a usable reset uses the default bench; absurd resets are not trusted", () => {
  const now = 5_000_000;
  const health = new BoxProfileHealth(() => now);
  health.observe("a", { kind: "rate_limit", status: "rejected", utilization: null, resetsAtMs: null });
  assert.equal(health.get("a")!.cooldownUntilMs, now + BOX_PROFILE_DEFAULT_COOLDOWN_MS);
  health.observe("b", { kind: "rate_limit", status: "rejected", utilization: null, resetsAtMs: now + 90 * 86_400_000 });
  assert.equal(health.get("b")!.cooldownUntilMs, now + BOX_PROFILE_DEFAULT_COOLDOWN_MS);
});
test("login_required benches; launches decay out of the concurrency window", () => {
  let now = 10_000;
  const health = new BoxProfileHealth(() => now);
  health.observe("x", { kind: "login_required" });
  assert.equal(health.cooldownActive("x"), true);
  health.recordLaunch("y"); health.recordLaunch("y");
  assert.equal(health.recentLaunches("y"), 2);
  now += 91_000;
  assert.equal(health.recentLaunches("y"), 0);
});
test("durable state seeds without overriding newer in-process state", () => {
  const now = 100;
  const health = new BoxProfileHealth(() => now);
  health.load("k", { utilization: 0.5, cooldownUntilMs: null, lastReason: null, updatedAtMs: 10 });
  health.observe("k", { kind: "login_required" });
  health.load("k", { utilization: 0.1, cooldownUntilMs: null, lastReason: null, updatedAtMs: 20 });
  assert.equal(health.cooldownActive("k"), true);
});

test("a login the guard refused is benched for an hour with its own reason", () => {
  const now = 1_000;
  const health = new BoxProfileHealth(() => now);
  health.observe("u", { kind: "profile_unsafe" });
  assert.equal(health.get("u")!.lastReason, "profile_unsafe");
  assert.equal(health.get("u")!.cooldownUntilMs, now + 3_600_000);
});

test("a utilization reading stops counting once its window has reset or it is too old", () => {
  let now = 1_000_000;
  const health = new BoxProfileHealth(() => now);
  health.observe("a", { kind: "rate_limit", status: "allowed_warning", utilization: 0.95, resetsAtMs: now + 600_000 });
  assert.equal(health.utilization("a"), 0.95);
  now += 600_001;
  assert.equal(health.utilization("a"), null, "window reset");
  health.observe("b", { kind: "rate_limit", status: "rejected", utilization: 1.04, resetsAtMs: now + 300_000 });
  assert.equal(health.utilization("b"), 1.04);
  now += 300_001;
  assert.equal(health.cooldownActive("b"), false);
  assert.equal(health.utilization("b"), null, "after the bench the stale 1.04 must not keep the login out");
  health.load("c", { utilization: 0.97, cooldownUntilMs: null, lastReason: null, updatedAtMs: now - 6 * 3_600_000 });
  assert.equal(health.utilization("c"), null, "a durable reading older than a window is not trusted");
});

test("a later unrelated bench keeps the reading's window boundary", () => {
  let now = 1_000_000;
  const health = new BoxProfileHealth(() => now);
  health.observe("a", { kind: "rate_limit", status: "rejected", utilization: 1.04, resetsAtMs: now + 600_000 });
  health.observe("a", { kind: "profile_unsafe" });
  now += 600_001;
  assert.equal(health.utilization("a"), null, "the 1.04 belonged to a window that has reset");
});

test("two observations in the same millisecond still get distinct, increasing timestamps", () => {
  const health = new BoxProfileHealth(() => 5_000);
  health.observe("a", { kind: "rate_limit", status: "allowed", utilization: 0.1, resetsAtMs: null });
  const first = health.get("a")!.updatedAtMs;
  health.observe("a", { kind: "rate_limit", status: "rejected", utilization: 1.04, resetsAtMs: null });
  assert.ok(health.get("a")!.updatedAtMs > first);
});

test("re-reading the same login or unsafe evidence does not push the bench out", () => {
  let now = 10_000;
  const health = new BoxProfileHealth(() => now);
  health.observe("a", { kind: "login_required" });
  const until = health.get("a")!.cooldownUntilMs;
  now += 60_000;
  health.observe("a", { kind: "login_required" });
  assert.equal(health.get("a")!.cooldownUntilMs, until);
  health.observe("b", { kind: "profile_unsafe" });
  const unsafeUntil = health.get("b")!.cooldownUntilMs;
  now += 60_000;
  health.observe("b", { kind: "profile_unsafe" });
  assert.equal(health.get("b")!.cooldownUntilMs, unsafeUntil);
  now = until! + 1;                                   // after it lapsed, a new sighting benches again
  health.observe("a", { kind: "login_required" });
  assert.ok(health.get("a")!.cooldownUntilMs! > until!);
});
