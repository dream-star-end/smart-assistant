import test from "node:test";
import assert from "node:assert/strict";
import { boxProfileKey } from "./boxClaudeProfile.js";
import type { BoxProfileRow } from "./boxClaudeProfileStore.js";
import { BoxProfileHealth } from "./boxProfileHealth.js";
import { boxLoginCandidates } from "./boxLoginCandidates.js";

const now = 1_700_000_000_000;
const week = 7 * 24 * 3_600_000;

function row(over: Partial<BoxProfileRow> = {}): BoxProfileRow {
  return {
    accountId: 20n, profile: "cc3", enabled: true, isDefault: false, loginState: "logged_in",
    projectsMode: "shared", emailHint: null, accountFingerprint: null, orgType: null,
    lastSeenAt: null, utilization: null, cooldownUntil: null, lastReason: null,
    healthUpdatedAt: new Date(now - 60_000), ...over,
  };
}

test("weekly exhaustion benches a login whose 5-hour reading has aged out", () => {
  const health = new BoxProfileHealth(() => now);
  const [candidate] = boxLoginCandidates({
    accountId: 20n, weight: 1, health, nowMs: now,
    own: [row({ quota7d: 1, quota7dResetsAt: new Date(now + week) })],
  });
  assert.equal(candidate?.utilization, null);
  assert.equal(candidate?.cooldownActive, true);
  assert.equal(candidate?.cooldownQuotaOnly, true);
});

test("a weekly window that has already reset is not exhaustion", () => {
  const health = new BoxProfileHealth(() => now);
  const [candidate] = boxLoginCandidates({
    accountId: 20n, weight: 1, health, nowMs: now,
    own: [row({ quota7d: 1, quota7dResetsAt: new Date(now - 1_000) })],
  });
  assert.equal(candidate?.cooldownActive, false);
  assert.equal(candidate?.cooldownQuotaOnly, false);
});

test("an in-memory seven-day window benches even when the durable scalar is empty", () => {
  const health = new BoxProfileHealth(() => now);
  health.observe(boxProfileKey(20n, "cc3"), {
    kind: "rate_limit", status: "allowed", utilization: 0.2, resetsAtMs: now + 60_000,
    windows: { sevenDay: { utilization: 1, resetsAtMs: now + week } },
  });
  const [candidate] = boxLoginCandidates({
    accountId: 20n, weight: 1, health, nowMs: now,
    // Older than the observation, so load() must not drop the live window before we read it.
    own: [row({ healthUpdatedAt: new Date(now - week), utilization: null })],
  });
  assert.equal(candidate?.cooldownActive, true);
  assert.equal(candidate?.cooldownQuotaOnly, true);
});

test("a logged-out bench stays ineligible as a quota last resort when the week is also full", () => {
  const health = new BoxProfileHealth(() => now);
  health.observe(boxProfileKey(20n, "cc3"), { kind: "login_required" });
  const [candidate] = boxLoginCandidates({
    accountId: 20n, weight: 1, health, nowMs: now,
    own: [row({
      healthUpdatedAt: new Date(now - week),
      quota7d: 1, quota7dResetsAt: new Date(now + week),
    })],
  });
  assert.equal(candidate?.cooldownActive, true);
  assert.equal(candidate?.cooldownQuotaOnly, false);
});
