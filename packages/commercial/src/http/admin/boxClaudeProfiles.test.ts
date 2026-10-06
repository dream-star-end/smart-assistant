import test from "node:test";
import assert from "node:assert/strict";
import { serializeBoxProfile } from "./boxClaudeProfiles.js";
import type { BoxProfileRow } from "../proxy/boxClaudeProfileStore.js";

const row = (profile: string, over: Partial<BoxProfileRow> = {}): BoxProfileRow => ({ accountId: 25n, profile,
  enabled: true, isDefault: profile === "default", loginState: "logged_in",
  projectsMode: profile === "default" ? "root" : "shared", emailHint: "a***@b***.com",
  accountFingerprint: null, orgType: "claude_pro", lastSeenAt: new Date(0), utilization: 0.5,
  cooldownUntil: null, lastReason: null, healthUpdatedAt: null, ...over });

test("a serialized login exposes only masked identity and states, never a path outside its config dir", () => {
  const all = [row("default"), row("b")];
  const out = serializeBoxProfile(all[1]!, all);
  assert.deepEqual(Object.keys(out).sort(), ["config_dir", "cooldown_reason", "cooldown_until", "duplicate_of",
    "email_hint", "enabled", "is_default", "last_seen_at", "login_state", "org_type", "profile",
    "projects_mode", "selectable", "utilization"]);
  assert.equal(out.config_dir, "/home/box/.claude-b");
  assert.equal(out.selectable, true);
});
test("own-projects and logged-out logins are not selectable", () => {
  const all = [row("default"), row("own", { projectsMode: "own" }), row("out", { loginState: "logged_out" }), row("new", { projectsMode: "absent" })];
  assert.deepEqual(all.map((r) => serializeBoxProfile(r, all).selectable), [true, false, false, false]);
});
test("a bench is reported only while it lasts", () => {
  const now = Date.now();
  const live = row("a", { cooldownUntil: new Date(now + 60_000), lastReason: "quota_exhausted" });
  const stale = row("b", { cooldownUntil: new Date(now - 60_000), lastReason: "quota_exhausted" });
  assert.equal(serializeBoxProfile(live, [live], now).cooldown_reason, "quota_exhausted");
  assert.equal(serializeBoxProfile(stale, [stale], now).cooldown_until, null);
});
test("two logins of the same Claude account are flagged against each other", () => {
  const all = [row("default", { accountFingerprint: "0123456789ab" }), row("b", { accountFingerprint: "0123456789ab" }), row("c", { accountFingerprint: "ffffffffffff" })];
  assert.deepEqual(all.map((r) => serializeBoxProfile(r, all).duplicate_of), ["b", "default", null]);
});
