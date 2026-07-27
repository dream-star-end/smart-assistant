import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { QueryResult, QueryResultRow } from "pg";
import { EVENTS } from "../admin/alertEvents.js";
import type { AlertEventInput } from "../admin/alertOutbox.js";
import {
  runBillingReconciliation,
  scanBillingReconciliation,
} from "../billing/reconciliation.js";
import type { QueryRunner } from "../db/queries.js";

type FakeRow = Record<string, unknown>;

function fakeRunner(resultRows: FakeRow[]) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  let index = 0;
  const runner: QueryRunner = {
    async query<Row extends QueryResultRow>(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      const row = resultRows[index++] ?? {};
      return {
        command: "SELECT",
        rowCount: 1,
        oid: 0,
        fields: [],
        rows: [row as Row],
      } as QueryResult<Row>;
    },
  };
  return { runner, calls };
}

const cleanRows: FakeRow[] = [
  { count: "0", absolute_credits: "0", ids: [] },
  { count: "0", absolute_credits: "0", ids: [] },
  {
    usage_gap_count: "0",
    usage_gap_credits: "0",
    usage_ids: [],
    tape_gap_count: "0",
    tape_user_ids: [],
  },
  { count: "1", uncollected_credits: "50", usage_ids: ["42"] },
];

describe("billing reconciliation probes", () => {
  test("runs exactly four parameterized read-only aggregates and bounds identifiers", async () => {
    const { runner, calls } = fakeRunner([
      { count: "2", absolute_credits: "30", ids: Array.from({ length: 15 }, (_, i) => String(i + 1)) },
      { count: "1", absolute_credits: "7", ids: ["8"] },
      {
        usage_gap_count: "1",
        usage_gap_credits: "9",
        usage_ids: ["91"],
        tape_gap_count: "2",
        tape_user_ids: ["1", "247"],
      },
      { count: "6", uncollected_credits: "510", usage_ids: ["92"] },
    ]);

    const snapshot = await scanBillingReconciliation(runner, Date.UTC(2026, 6, 27));
    assert.equal(calls.length, 4);
    assert.deepEqual(
      calls.map((call) => call.sql.match(/billing_reconciliation:([a-z_]+)/)?.[1]),
      ["wallet", "period", "usage_and_tapes", "clamp"],
    );
    assert.ok(calls.every((call) => call.params.length > 0));
    assert.equal(snapshot.wallet.userIds.length, 10);
    assert.deepEqual(snapshot.usage.tapeUserIds, ["1", "247"]);
  });

  test("emits all four registered events with daily durable dedupe and no PII", async () => {
    const { runner } = fakeRunner([
      { count: "1", absolute_credits: "30", ids: ["18"] },
      { count: "1", absolute_credits: "7", ids: ["247"] },
      {
        usage_gap_count: "1",
        usage_gap_credits: "9",
        usage_ids: ["91"],
        tape_gap_count: "1",
        tape_user_ids: ["1"],
      },
      { count: "5", uncollected_credits: "100", usage_ids: ["92"] },
    ]);
    const events: AlertEventInput[] = [];
    const count = await runBillingReconciliation({
      runner,
      nowMs: Date.UTC(2026, 6, 27, 10),
      enqueue: (event) => events.push(event),
    });

    assert.equal(count, 4);
    assert.deepEqual(events.map((event) => event.event_type), [
      EVENTS.BILLING_WALLET_DRIFT,
      EVENTS.BILLING_PERIOD_DRIFT,
      EVENTS.BILLING_USAGE_LEDGER_GAP,
      EVENTS.BILLING_CLAMP_SPIKE,
    ]);
    for (const event of events) {
      assert.equal(event.dedupe_all_statuses, true);
      assert.match(event.dedupe_key ?? "", /:2026-07-27$/);
      assert.doesNotMatch(JSON.stringify(event), /@/);
    }
  });

  test("clean invariants and observed 1/50 clamp baseline stay quiet", async () => {
    const { runner } = fakeRunner(cleanRows);
    const events: AlertEventInput[] = [];
    const count = await runBillingReconciliation({
      runner,
      nowMs: Date.UTC(2026, 6, 27),
      enqueue: (event) => events.push(event),
    });
    assert.equal(count, 0);
    assert.deepEqual(events, []);
  });
});
