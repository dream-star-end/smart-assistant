/**
 * usageSweeper — provider-neutral hourly quota-refresh skeleton.
 *
 * Run: npx tsx --test packages/commercial/src/account-pool/usageSweeper.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { AccountRow } from "./store.js";
import {
  USAGE_SWEEP_PER_ACCOUNT_GAP_MS,
  shortUsageError,
  startUsageSweeper,
  sweepUsageOnce,
  type UsageSweeperSpec,
} from "./usageSweeper.js";

const savedChannel = process.env.OC_RUNTIME_CHANNEL;
afterEach(() => {
  if (savedChannel === undefined) delete process.env.OC_RUNTIME_CHANNEL;
  else process.env.OC_RUNTIME_CHANNEL = savedChannel;
});

const row = (id: bigint, status: AccountRow["status"] = "active"): AccountRow =>
  ({ id, provider: "grok", status } as unknown as AccountRow);

type Deps = { seen: bigint[] };

function spec(overrides: Partial<UsageSweeperSpec<Deps>> = {}): UsageSweeperSpec<Deps> {
  return {
    label: "test sweep",
    provider: "grok",
    isCandidate: (r) => r.status === "active",
    refresh: async (r, deps) => {
      deps.seen.push(r.id);
      if (r.id === 2n) throw new Error("boom");
      if (r.id === 3n) return { ok: false, reason: "expired", skipped: "expired" };
      if (r.id === 4n) return { ok: false, reason: "upstream 500" };
      return { ok: true, weightInputsChanged: r.id === 5n };
    },
    listRows: async () => [row(1n), row(2n), row(3n), row(4n), row(5n), row(6n, "disabled")],
    sleep: async () => {},
    ...overrides,
  };
}

describe("sweepUsageOnce", () => {
  it("isolates per-account failures, classifies outcomes, paces between candidates only", async () => {
    const sleeps: number[] = [];
    const deps: Deps = { seen: [] };
    const summary = await sweepUsageOnce(spec({ sleep: async (ms) => { sleeps.push(ms); } }), deps);
    assert.deepEqual(summary, { scanned: 5, refreshed: 2, failed: 2, skipped: 1, weightChanged: 1 });
    assert.deepEqual(deps.seen, [1n, 2n, 3n, 4n, 5n], "disabled row never reaches refresh");
    assert.equal(sleeps.length, 4, "n-1 gaps");
    assert.ok(sleeps.every((ms) => ms === USAGE_SWEEP_PER_ACCOUNT_GAP_MS));
  });

  it("fires onAnyWeightChanged once per pass, only when something moved", async () => {
    let fired = 0;
    const s = spec({ onAnyWeightChanged: () => { fired += 1; } });
    await sweepUsageOnce(s, { seen: [] });
    assert.equal(fired, 1);
    fired = 0;
    await sweepUsageOnce(spec({
      onAnyWeightChanged: () => { fired += 1; },
      refresh: async () => ({ ok: true, weightInputsChanged: false }),
    }), { seen: [] });
    assert.equal(fired, 0);
  });

  it("a failing listing returns an empty summary instead of throwing", async () => {
    const summary = await sweepUsageOnce(spec({ listRows: async () => { throw new Error("db down"); } }), { seen: [] });
    assert.deepEqual(summary, { scanned: 0, refreshed: 0, failed: 0, skipped: 0, weightChanged: 0 });
  });
});

describe("startUsageSweeper", () => {
  it("is a no-op outside the v5 channel", async () => {
    process.env.OC_RUNTIME_CHANNEL = "v3";
    const deps: Deps = { seen: [] };
    const h = startUsageSweeper(spec(), { deps, runOnStart: false });
    const summary = await h.runOnceForTest();
    h.stop();
    assert.deepEqual(summary, { scanned: 0, refreshed: 0, failed: 0, skipped: 0, weightChanged: 0 });
    assert.deepEqual(deps.seen, []);
  });

  it("de-duplicates overlapping passes on v5", async () => {
    process.env.OC_RUNTIME_CHANNEL = "v5";
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    let refreshes = 0;
    const h = startUsageSweeper(spec({
      listRows: async () => [row(1n)],
      refresh: async () => { refreshes += 1; await gate; return { ok: true, weightInputsChanged: false }; },
    }), { deps: { seen: [] }, runOnStart: false, intervalMs: 3_600_000 });
    const a = h.runOnceForTest();
    const b = h.runOnceForTest();
    assert.strictEqual(a, b, "second call while in flight returns the same promise");
    release!();
    await a;
    h.stop();
    assert.equal(refreshes, 1);
  });
});

describe("shortUsageError", () => {
  it("prefers code:detailKeys when a code is given, else the collapsed message, both capped", () => {
    assert.equal(shortUsageError(new Error("x"), "SAND_HTTP", ["a", "b", "c", "d", "e"]), "SAND_HTTP:a,b,c,d");
    assert.equal(shortUsageError(new Error("x"), "PLAIN"), "PLAIN");
    assert.equal(shortUsageError(new Error("multi\n  line   msg")), "multi line msg");
    assert.equal(shortUsageError("s".repeat(500)).length, 200);
  });
});
