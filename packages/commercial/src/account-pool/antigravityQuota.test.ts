/**
 * OCV5-424 — Antigravity quota for the admin 服务池 page.
 * Run: npx tsx --test packages/commercial/src/account-pool/antigravityQuota.test.ts
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  ANTIGRAVITY_QUOTA_TTL_MS,
  _resetAntigravityQuotaCacheForTest,
  antigravityAccountQuota,
  parseQuotaSummary,
} from "./antigravityQuota.js";

// Shape captured from retrieveUserQuotaSummary on 2026-10-15 (values trimmed).
const SUMMARY = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        { bucketId: "gemini-weekly", window: "weekly", resetTime: "2026-10-21T01:10:20Z", remainingFraction: 0.98953944 },
        { bucketId: "gemini-5h", window: "5h", resetTime: "2026-10-15T11:21:54Z", remainingFraction: 0.99882746 },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        { bucketId: "3p-weekly", window: "weekly", resetTime: "2026-10-21T11:51:19Z", remainingFraction: 0.735804 },
        { bucketId: "3p-5h", window: "5h", resetTime: "2026-10-15T12:41:24Z", remainingFraction: 1 },
      ],
    },
  ],
  description: "x",
};

describe("Antigravity quota", () => {
  beforeEach(() => _resetAntigravityQuotaCacheForTest());

  it("parses every group's 5-hour and weekly bucket into used % and reset time", () => {
    assert.deepEqual(parseQuotaSummary(SUMMARY), [
      { label: "Gemini · 每周", usedPct: 1, resetsAt: "2026-10-21T01:10:20Z" },
      { label: "Gemini · 5 小时", usedPct: 0.1, resetsAt: "2026-10-15T11:21:54Z" },
      { label: "Claude/GPT · 每周", usedPct: 26.4, resetsAt: "2026-10-21T11:51:19Z" },
      { label: "Claude/GPT · 5 小时", usedPct: 0, resetsAt: "2026-10-15T12:41:24Z" },
    ]);
    assert.deepEqual(parseQuotaSummary({}), []);
    assert.deepEqual(parseQuotaSummary(null), []);
  });

  it("loads the project once, caches 10 minutes, and keeps the last windows when a refresh fails", async () => {
    let now = 1_000_000;
    const calls: string[] = [];
    let quotaStatus = 200;
    const deps = {
      clientSecret: () => "secret",
      freshToken: async () => Buffer.from("tok"),
      now: () => now,
      post: async (path: string, _t: string, body: unknown) => {
        calls.push(path);
        if (path.endsWith("loadCodeAssist")) return { status: 200, json: { cloudaicompanionProject: "proj-1" } };
        assert.deepEqual(body, { project: "proj-1" });
        return { status: quotaStatus, json: quotaStatus === 200 ? SUMMARY : null };
      },
    };
    const first = await antigravityAccountQuota("1", deps);
    assert.equal(first.windows.length, 4);
    assert.equal(first.note, null);
    await antigravityAccountQuota("1", deps);
    assert.deepEqual(calls, ["/v1internal:loadCodeAssist", "/v1internal:retrieveUserQuotaSummary"], "cached");
    now += ANTIGRAVITY_QUOTA_TTL_MS + 1;
    quotaStatus = 503;
    const stale = await antigravityAccountQuota("1", deps);
    assert.equal(stale.windows.length, 4, "last good windows kept");
    assert.equal(stale.note, "上游额度接口返回 HTTP 503");
    assert.equal(calls.filter((c) => c.endsWith("loadCodeAssist")).length, 1, "project reused");
  });

  it("says why there is no quota instead of returning nothing", async () => {
    assert.match((await antigravityAccountQuota("2", { clientSecret: () => "" })).note ?? "", /未配置/);
    const dead = await antigravityAccountQuota("3", {
      clientSecret: () => "secret",
      freshToken: async () => {
        throw new Error("invalid_grant");
      },
    });
    assert.match(dead.note ?? "", /登录凭证无法刷新/);
    assert.deepEqual(dead.windows, []);
  });
});
