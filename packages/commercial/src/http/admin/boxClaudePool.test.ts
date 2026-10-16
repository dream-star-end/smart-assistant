import test from "node:test";
import assert from "node:assert/strict";
import { BOX_QUOTA_REASON_NO_DATA, BOX_QUOTA_REASON_NOT_LOGGED_IN, BOX_QUOTA_REASON_NOT_SCHEDULED,
  loginView } from "./boxClaudePool.js";
import type { BoxProfileRow } from "../proxy/boxClaudeProfileStore.js";

const row = (over: Partial<BoxProfileRow> = {}): BoxProfileRow => ({
  accountId: 25n, profile: "account2", enabled: true, isDefault: true, loginState: "logged_in",
  projectsMode: "shared", emailHint: "a***@x.com", accountFingerprint: "f", orgType: null,
  lastSeenAt: null, utilization: null, cooldownUntil: null, lastReason: null, healthUpdatedAt: null, ...over,
} as BoxProfileRow);

test("windows from 0309 are shown with their reset; no reason", () => {
  const v = loginView(row(), { accountId: 25n, profile: "account2", quota5h: 0.12,
    quota5hResetsAt: new Date("2026-10-15T18:00:00Z"), quota7d: 0.4, quota7dResetsAt: null });
  assert.deepEqual(v.quota, { five_hour: { used: 0.12, resets_at: "2026-10-15T18:00:00.000Z" },
    weekly: { used: 0.4, resets_at: null }, reason: null });
});

test("no windows: the reason says why, never blank", () => {
  assert.equal(loginView(row(), undefined).quota.reason, BOX_QUOTA_REASON_NO_DATA);
  assert.equal(loginView(row({ enabled: false }), undefined).quota.reason, BOX_QUOTA_REASON_NOT_SCHEDULED);
  assert.equal(loginView(row({ loginState: "logged_out" } as Partial<BoxProfileRow>), undefined).quota.reason,
    BOX_QUOTA_REASON_NOT_LOGGED_IN);
  assert.match(loginView(row({ utilization: 0.08 }), undefined).quota.reason!, /最高窗口已用 8%/);
});

test("an expired cooldown is not shown; a masked email only", () => {
  const v = loginView(row({ cooldownUntil: new Date(1_000), lastReason: "quota_exhausted", emailHint: "full@x.com" }),
    undefined, 2_000);
  assert.equal(v.cooldown_until, null);
  assert.equal(v.cooldown_reason, null);
  assert.equal(v.email_hint, null);
});
