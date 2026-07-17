import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Pool, PoolClient } from "pg";

import { applyTurnWaiver } from "../billing/refund.js";

/**
 * Exact-turn auto-waiver money invariants:
 *   - only turn_key / parent_turn_key locate debits (never a session/time window);
 *   - every debit returns to the original owner and bucket, with an inactive
 *     org still receiving its own money;
 *   - refund, one targeted inbox receipt and pending→applied commit together;
 *   - retries are idempotent, including zero-debit waived turns.
 */

interface DebitInput {
  usage_id: string;
  bucket: "wallet" | "period" | "org_wallet" | "org_period";
  delta: string;
  org_id: string | null;
  debited_at_us?: string;
}

interface WaiverState {
  id: string;
  reason: "idle_timeout";
  status: "pending" | "applied";
  refundedCredits: bigint;
  recordCount: number;
  inboxMessageId: string | null;
}

interface FakeState {
  debits: DebitInput[];
  wallet: bigint;
  userSub: { id: string; period: bigint; periodStartUs?: string; periodEndUs?: string } | null;
  /** Missing key means an impossible dangling historical org reference. */
  orgs: Map<string, bigint>;
  orgSubs: Map<
    string,
    { id: string; period: bigint; periodStartUs?: string; periodEndUs?: string } | null
  >;
  waiver?: WaiverState;
}

interface Captured {
  ledgerInserts: Array<{
    bucket: string;
    orgId: string | null;
    delta: bigint;
    usageId: string;
    memo: string;
  }>;
  inboxInserts: Array<{
    audience: string;
    userId: string;
    title: string;
    body: string;
    notifyEmail: boolean;
    sourceType: string;
    sourceId: string;
    sourcePhase: string;
  }>;
  sqlSeen: string[];
  sessionVersionBumps: number;
  commits: number;
  rollbacks: number;
}

function makeFakePool(initial: FakeState): { pool: Pool; state: FakeState; cap: Captured } {
  const state = initial;
  const cap: Captured = {
    ledgerInserts: [],
    inboxInserts: [],
    sqlSeen: [],
    sessionVersionBumps: 0,
    commits: 0,
    rollbacks: 0,
  };
  let nextInboxId = 900n;

  const client: PoolClient = {
    async query(sql: any, params: readonly unknown[] = []): Promise<any> {
      const text = typeof sql === "string" ? sql : sql.text;
      const t = text.replace(/\s+/g, " ").trim();
      cap.sqlSeen.push(t);
      if (t === "BEGIN") return { rowCount: 0, rows: [] };
      if (t === "COMMIT") {
        cap.commits++;
        return { rowCount: 0, rows: [] };
      }
      if (t === "ROLLBACK") {
        cap.rollbacks++;
        return { rowCount: 0, rows: [] };
      }
      if (/pg_advisory_xact_lock/.test(t)) return { rowCount: 1, rows: [{}] };

      if (/FROM turn_waivers WHERE user_id = \$1 AND turn_key = \$2 FOR UPDATE/.test(t)) {
        const w = state.waiver;
        return w
          ? {
              rowCount: 1,
              rows: [{
                id: w.id,
                reason: w.reason,
                status: w.status,
                refunded_credits: w.refundedCredits.toString(),
                record_count: w.recordCount,
                inbox_message_id: w.inboxMessageId,
              }],
            }
          : { rowCount: 0, rows: [] };
      }
      if (/^INSERT INTO turn_waivers /.test(t)) {
        state.waiver = {
          id: "71",
          reason: "idle_timeout",
          status: "pending",
          refundedCredits: 0n,
          recordCount: 0,
          inboxMessageId: null,
        };
        return {
          rowCount: 1,
          rows: [{
            id: "71",
            reason: "idle_timeout",
            status: "pending",
            refunded_credits: "0",
            record_count: 0,
            inbox_message_id: null,
          }],
        };
      }
      if (/FROM usage_records ur JOIN credit_ledger cl/.test(t)) {
        return {
          rowCount: state.debits.length,
          rows: state.debits.map((row) => ({
            ...row,
            debited_at_us: row.debited_at_us ?? "1000000",
          })),
        };
      }
      if (/FROM orgs WHERE id=\$1::bigint FOR UPDATE/.test(t)) {
        const credits = state.orgs.get(String(params[0]));
        return credits === undefined
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ credits: credits.toString() }] };
      }
      if (/FROM org_subscriptions WHERE org_id=\$1::bigint/.test(t)) {
        const sub = state.orgSubs.get(String(params[0]));
        return sub
          ? {
              rowCount: 1,
              rows: [{
                id: sub.id,
                period_credits: sub.period.toString(),
                period_start_us: sub.periodStartUs ?? "0",
                period_end_us: sub.periodEndUs ?? "2000000",
              }],
            }
          : { rowCount: 0, rows: [] };
      }
      if (/SELECT credits::text AS credits FROM users WHERE id=\$1 FOR UPDATE/.test(t)) {
        return { rowCount: 1, rows: [{ credits: state.wallet.toString() }] };
      }
      if (/FROM user_subscriptions WHERE user_id=\$1/.test(t)) {
        return state.userSub
          ? {
              rowCount: 1,
              rows: [{
                id: state.userSub.id,
                period_credits: state.userSub.period.toString(),
                period_start_us: state.userSub.periodStartUs ?? "0",
                period_end_us: state.userSub.periodEndUs ?? "2000000",
              }],
            }
          : { rowCount: 0, rows: [] };
      }
      if (/^INSERT INTO credit_ledger/.test(t)) {
        cap.ledgerInserts.push({
          delta: BigInt(String(params[1])),
          bucket: String(params[3]),
          usageId: String(params[4]),
          memo: String(params[5]),
          orgId: params[6] == null ? null : String(params[6]),
        });
        return { rowCount: 1, rows: [] };
      }
      if (/^UPDATE users SET credits=\$1 WHERE id=\$2/.test(t)) {
        state.wallet = BigInt(String(params[0]));
        return { rowCount: 1, rows: [] };
      }
      if (/^UPDATE user_subscriptions SET period_credits=\$1/.test(t)) {
        assert.ok(state.userSub);
        state.userSub.period = BigInt(String(params[0]));
        return { rowCount: 1, rows: [] };
      }
      if (/^UPDATE orgs SET credits=\$1/.test(t)) {
        state.orgs.set(String(params[1]), BigInt(String(params[0])));
        return { rowCount: 1, rows: [] };
      }
      if (/^UPDATE org_subscriptions SET period_credits=\$1/.test(t)) {
        const entry = [...state.orgSubs.entries()].find(([, sub]) => sub?.id === String(params[1]));
        assert.ok(entry?.[1]);
        entry[1].period = BigInt(String(params[0]));
        return { rowCount: 1, rows: [] };
      }
      if (/^INSERT INTO inbox_messages/.test(t)) {
        const id = (nextInboxId++).toString();
        cap.inboxInserts.push({
          audience: "user",
          userId: String(params[0]),
          title: "本轮已自动免单",
          body: String(params[1]),
          notifyEmail: false,
          sourceType: "turn_waive",
          sourceId: String(params[2]),
          sourcePhase: "receipt",
        });
        return { rowCount: 1, rows: [{ id }] };
      }
      if (/^UPDATE turn_waivers SET status='applied'/.test(t)) {
        assert.ok(state.waiver);
        state.waiver.status = "applied";
        state.waiver.refundedCredits = BigInt(String(params[1]));
        state.waiver.recordCount = Number(params[2]);
        state.waiver.inboxMessageId = String(params[3]);
        return { rowCount: 1, rows: [] };
      }
      if (/^UPDATE client_sessions s SET updated_at=GREATEST/.test(t)) {
        cap.sessionVersionBumps++;
        return { rowCount: 1, rows: [] };
      }
      if (/SELECT \(u\.credits \+ COALESCE/.test(t)) {
        const total = state.wallet + (state.userSub?.period ?? 0n);
        return { rowCount: 1, rows: [{ total: total.toString() }] };
      }
      throw new Error(`fake: unhandled SQL: ${t}`);
    },
    release() {},
  } as unknown as PoolClient;
  return {
    state,
    cap,
    pool: { async connect() { return client; } } as unknown as Pool,
  };
}

const TURN_KEY = "a".repeat(64);
const input = { userId: 7n, turnKey: TURN_KEY, reason: "idle_timeout" as const };

describe("applyTurnWaiver — exact owner/bucket reversal + inbox receipt", () => {
  test("personal period+wallet debits reverse exactly and create one targeted no-email receipt", async () => {
    const { pool, state, cap } = makeFakePool({
      debits: [
        { usage_id: "u1", bucket: "period", delta: "-40", org_id: null },
        { usage_id: "u1", bucket: "wallet", delta: "-60", org_id: null },
      ],
      wallet: 10n,
      userSub: { id: "51", period: 20n },
      orgs: new Map(),
      orgSubs: new Map(),
    });

    const result = await applyTurnWaiver(pool, input);
    assert.equal(result.newlyApplied, true);
    assert.equal(result.refundedCredits, 100n);
    assert.equal(result.recordCount, 1);
    assert.equal(cap.sessionVersionBumps, 1);
    assert.equal(state.wallet, 70n);
    assert.equal(state.userSub?.period, 60n);
    assert.deepEqual(cap.ledgerInserts.map((r) => [r.bucket, r.delta]), [
      ["period", 40n],
      ["wallet", 60n],
    ]);
    assert.equal(cap.inboxInserts.length, 1);
    assert.deepEqual(cap.inboxInserts[0], {
      audience: "user",
      userId: "7",
      title: "本轮已自动免单",
      body: "由于任务长时间没有新输出，本轮已自动免单，并退还 **100 积分**。积分已按原扣费来源退回个人或组织额度。你可以回到原会话重新尝试。",
      notifyEmail: false,
      sourceType: "turn_waive",
      sourceId: "71",
      sourcePhase: "receipt",
    });
    assert.equal(state.waiver?.status, "applied");
    assert.equal(cap.commits, 1);
  });

  test("suspended/inactive org still receives org money; period falls back only within same org", async () => {
    const { pool, state, cap } = makeFakePool({
      debits: [
        { usage_id: "u1", bucket: "org_period", delta: "-300", org_id: "5" },
        { usage_id: "u2", bucket: "org_wallet", delta: "-200", org_id: "5" },
      ],
      wallet: 9n,
      userSub: null,
      // Refund deliberately has no status predicate; 5 may be suspended.
      orgs: new Map([["5", 1_000n]]),
      orgSubs: new Map([["5", null]]),
    });

    const result = await applyTurnWaiver(pool, input);
    assert.equal(result.refundedCredits, 500n);
    assert.equal(state.orgs.get("5"), 1_500n);
    assert.equal(state.wallet, 9n);
    assert.deepEqual(cap.ledgerInserts.map((r) => [r.bucket, r.orgId, r.delta]), [
      ["org_wallet", "5", 300n],
      ["org_wallet", "5", 200n],
    ]);
    assert.match(cap.ledgerInserts[0]!.memo, /org_period→org_wallet/);
    const orgSelect = cap.sqlSeen.find((sql) => /FROM orgs WHERE id=\$1::bigint FOR UPDATE/.test(sql));
    assert.ok(orgSelect);
    assert.doesNotMatch(orgSelect, /status='active'/);
  });

  test("active org period debit returns to the original org period bucket", async () => {
    const { pool, state, cap } = makeFakePool({
      debits: [{ usage_id: "u1", bucket: "org_period", delta: "-300", org_id: "5" }],
      wallet: 0n,
      userSub: null,
      orgs: new Map([["5", 1_000n]]),
      orgSubs: new Map([["5", { id: "88", period: 700n }]]),
    });

    await applyTurnWaiver(pool, input);
    assert.equal(state.orgSubs.get("5")?.period, 1_000n);
    assert.deepEqual(cap.ledgerInserts.map((r) => [r.bucket, r.orgId]), [["org_period", "5"]]);
  });

  test("previous personal period debit refunds to wallet after subscription rollover", async () => {
    const { pool, state, cap } = makeFakePool({
      debits: [{
        usage_id: "u1",
        bucket: "period",
        delta: "-40",
        org_id: null,
        debited_at_us: "1000100",
      }],
      wallet: 10n,
      userSub: {
        id: "51",
        period: 20n,
        periodStartUs: "1000900",
        periodEndUs: "2000000",
      },
      orgs: new Map(),
      orgSubs: new Map(),
    });

    await applyTurnWaiver(pool, input);
    assert.equal(state.wallet, 50n);
    assert.equal(state.userSub?.period, 20n);
    assert.deepEqual(cap.ledgerInserts.map((r) => [r.bucket, r.delta]), [["wallet", 40n]]);
    assert.match(cap.ledgerInserts[0]!.memo, /period→wallet\(expired period\)/);
  });

  test("previous org period debit refunds to the same org wallet after rollover", async () => {
    const { pool, state, cap } = makeFakePool({
      debits: [{
        usage_id: "u1",
        bucket: "org_period",
        delta: "-300",
        org_id: "5",
        debited_at_us: "1000100",
      }],
      wallet: 0n,
      userSub: null,
      orgs: new Map([["5", 1_000n]]),
      orgSubs: new Map([[
        "5",
        { id: "88", period: 700n, periodStartUs: "1000900", periodEndUs: "2000000" },
      ]]),
    });

    await applyTurnWaiver(pool, input);
    assert.equal(state.orgs.get("5"), 1_300n);
    assert.equal(state.orgSubs.get("5")?.period, 700n);
    assert.deepEqual(cap.ledgerInserts.map((r) => [r.bucket, r.orgId]), [["org_wallet", "5"]]);
    assert.match(cap.ledgerInserts[0]!.memo, /org_period→org_wallet\(expired period\)/);
  });

  test("period membership uses the exact half-open start/end boundaries", async () => {
    const { pool, state, cap } = makeFakePool({
      debits: [
        {
          usage_id: "at-start",
          bucket: "period",
          delta: "-20",
          org_id: null,
          debited_at_us: "1000900",
        },
        {
          usage_id: "at-end",
          bucket: "period",
          delta: "-30",
          org_id: null,
          debited_at_us: "2000000",
        },
      ],
      wallet: 10n,
      userSub: {
        id: "51",
        period: 40n,
        periodStartUs: "1000900",
        periodEndUs: "2000000",
      },
      orgs: new Map(),
      orgSubs: new Map(),
    });

    await applyTurnWaiver(pool, input);
    assert.equal(state.wallet, 40n);
    assert.equal(state.userSub?.period, 60n);
    assert.deepEqual(cap.ledgerInserts.map((r) => [r.usageId, r.bucket]), [
      ["at-start", "period"],
      ["at-end", "wallet"],
    ]);
  });

  test("zero-debit waiver still commits one receipt; retry creates neither ledger nor inbox duplicates", async () => {
    const { pool, cap } = makeFakePool({
      debits: [],
      wallet: 25n,
      userSub: null,
      orgs: new Map(),
      orgSubs: new Map(),
    });

    const first = await applyTurnWaiver(pool, input);
    const second = await applyTurnWaiver(pool, input);
    assert.equal(first.newlyApplied, true);
    assert.equal(first.refundedCredits, 0n);
    assert.equal(second.newlyApplied, false);
    assert.equal(second.inboxMessageId, first.inboxMessageId);
    assert.equal(cap.ledgerInserts.length, 0);
    assert.equal(cap.inboxInserts.length, 1);
    assert.equal(cap.sessionVersionBumps, 1);
    assert.match(cap.inboxInserts[0]!.body, /没有实际扣除积分/);
  });

  test("locator is exact turn/parent-turn only, and a missing referenced org rolls back fail-closed", async () => {
    const { pool, cap } = makeFakePool({
      debits: [{ usage_id: "u1", bucket: "org_wallet", delta: "-10", org_id: "999" }],
      wallet: 50n,
      userSub: null,
      orgs: new Map(),
      orgSubs: new Map(),
    });

    await assert.rejects(() => applyTurnWaiver(pool, input), /referenced org 999 is missing/);
    const debitQuery = cap.sqlSeen.find((sql) => /FROM usage_records ur JOIN credit_ledger cl/.test(sql));
    assert.ok(debitQuery);
    assert.match(debitQuery, /ur\.turn_key = \$2 OR ur\.parent_turn_key = \$2/);
    assert.doesNotMatch(debitQuery, /session_id/);
    assert.doesNotMatch(debitQuery, /WHERE .*created_at/);
    assert.equal(cap.ledgerInserts.length, 0);
    assert.equal(cap.inboxInserts.length, 0);
    assert.equal(cap.commits, 0);
    assert.equal(cap.rollbacks, 1);
  });
});
