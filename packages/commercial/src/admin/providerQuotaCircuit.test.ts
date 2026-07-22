import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { QueryResult } from "pg";
import {
  claimProviderQuotaProbe,
  clearProviderQuotaBlock,
  isMoonshotBillingQuotaExhausted,
  markProviderQuotaExhausted,
  providerQuotaRetryAt,
  PROVIDER_QUOTA_PROBE_LEASE_MS,
} from "./providerQuotaCircuit.js";

describe("Moonshot quota classifier", () => {
  test("matches only the documented billing-cycle 403", () => {
    const exact = JSON.stringify({ error: { message: "You've reached your usage limit for this billing cycle" } });
    assert.equal(isMoonshotBillingQuotaExhausted(403, exact), true);
    assert.equal(isMoonshotBillingQuotaExhausted(429, exact), false);
    assert.equal(isMoonshotBillingQuotaExhausted(403, "access terminated"), false);
    assert.equal(isMoonshotBillingQuotaExhausted(403, "usage limit for another feature"), false);
  });

  test("uses valid Retry-After and falls back for invalid/past values", () => {
    const now = Date.parse("2026-07-22T12:00:00Z");
    assert.equal(
      providerQuotaRetryAt(new Headers({ "Retry-After": "90" }), now).getTime(),
      now + 90_000,
    );
    assert.ok(providerQuotaRetryAt(new Headers({ "Retry-After": "bad" }), now).getTime() > now);
  });
});

describe("durable quota block", () => {
  test("upsert stores no upstream body and clear deletes by provider", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const runner = {
      async query(sql: string, params: readonly unknown[] = []) {
        calls.push({ sql, params });
        return { rows: [], rowCount: 1 } as unknown as QueryResult;
      },
    };
    const retryAt = new Date("2026-07-22T13:00:00Z");
    await markProviderQuotaExhausted("moonshot", retryAt, runner);
    await clearProviderQuotaBlock("moonshot", runner);
    assert.match(calls[0]!.sql, /ON CONFLICT \(provider_id\) DO UPDATE/);
    assert.deepEqual(calls[0]!.params, ["moonshot", retryAt]);
    assert.match(calls[1]!.sql, /DELETE FROM provider_quota_blocks/);
  });

  test("atomic expired-row claim admits only one concurrent probe", async () => {
    const now = Date.parse("2026-07-22T12:00:00Z");
    let leaseUntil = 0;
    const runner = {
      async query(sql: string, params: readonly unknown[] = []) {
        assert.match(sql, /retry_at <= \$2/);
        assert.match(sql, /probe_lease_until IS NULL OR probe_lease_until <= \$2/);
        const claimAt = (params[1] as Date).getTime();
        let won = false;
        if (leaseUntil <= claimAt) {
          leaseUntil = (params[2] as Date).getTime();
          won = true;
        }
        await Promise.resolve();
        return {
          rows: won ? [{ provider_id: "moonshot" }] : [],
          rowCount: won ? 1 : 0,
        } as unknown as QueryResult;
      },
    };

    const results = await Promise.all([
      claimProviderQuotaProbe("moonshot", now, runner),
      claimProviderQuotaProbe("moonshot", now, runner),
    ]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal(leaseUntil, now + PROVIDER_QUOTA_PROBE_LEASE_MS);
  });
});
