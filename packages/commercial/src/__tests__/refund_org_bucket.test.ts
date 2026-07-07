import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { refundSessionWindow } from "../billing/refund.js";

/**
 * 退款按原桶冲正的核心不变量(P0 资损/套现回归门):
 *   - org_wallet/org_period 的扣费**只能退回 org**(ledger bucket=org_*、org_id 保留),
 *     绝不写成个人 wallet 桶 —— 否则等于把企业池的钱铸造成成员个人积分。
 *   - org 已停用(orgs FOR UPDATE 空)且无可退目标 → 跳过 + skippedOrgCredits 计数,绝不落个人钱包。
 *   - 个人 wallet/period 桶行为不变。
 *   - user_subscriptions 选择谓词含 period_end > NOW()(P1-1:防退款打进过期未轮转桶被清零)。
 */

interface DebitInput {
  usage_id: string;
  bucket: "wallet" | "period" | "org_wallet" | "org_period";
  delta: string;
  org_id: string | null;
}

interface FakeState {
  debits: DebitInput[];
  wallet: bigint;
  userSub: { id: string; period_credits: string } | null;
  orgs: Map<string, bigint | null>; // null = org 非 active(FOR UPDATE 空)
  orgSubs: Map<string, { id: string; period_credits: string } | null>;
}

interface Captured {
  ledgerInserts: Array<{ bucket: string; org_id: string | null; delta: string; memo: string }>;
  updates: Array<{ sql: string; params: readonly unknown[] }>;
  sqlSeen: string[];
}

function makeFakePool(state: FakeState): { pool: Pool; cap: Captured } {
  const cap: Captured = { ledgerInserts: [], updates: [], sqlSeen: [] };
  const client: PoolClient = {
    async query(sql: any, params?: any): Promise<any> {
      const text = typeof sql === "string" ? sql : sql.text;
      cap.sqlSeen.push(text);
      const t = text.replace(/\s+/g, " ").trim();
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(t)) return { rowCount: 0, rows: [] };
      if (/pg_advisory_xact_lock/.test(t)) return { rowCount: 1, rows: [{}] };
      if (/FROM usage_records ur JOIN credit_ledger/.test(t)) {
        return { rowCount: state.debits.length, rows: state.debits };
      }
      if (/FROM orgs WHERE id = \$1::bigint AND status = 'active' FOR UPDATE/.test(t)) {
        const c = state.orgs.get(String(params[0]));
        return c === null || c === undefined ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ credits: c.toString() }] };
      }
      if (/FROM org_subscriptions WHERE org_id/.test(t)) {
        const s = state.orgSubs.get(String(params[0]));
        return s ? { rowCount: 1, rows: [s] } : { rowCount: 0, rows: [] };
      }
      if (/FROM users WHERE id = \$1 FOR UPDATE/.test(t)) {
        return { rowCount: 1, rows: [{ credits: state.wallet.toString() }] };
      }
      if (/FROM user_subscriptions WHERE user_id/.test(t)) {
        return state.userSub ? { rowCount: 1, rows: [state.userSub] } : { rowCount: 0, rows: [] };
      }
      if (/^INSERT INTO credit_ledger/.test(t)) {
        // 参数序:user_id, delta, balance_after, bucket, usageId, memo, org_id
        cap.ledgerInserts.push({
          delta: String(params[1]),
          bucket: String(params[3]),
          memo: String(params[5]),
          org_id: params[6] == null ? null : String(params[6]),
        });
        return { rowCount: 1, rows: [] };
      }
      if (/^UPDATE /.test(t)) {
        cap.updates.push({ sql: t, params });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`fake: unhandled SQL: ${t.slice(0, 90)}`);
    },
    release() {},
  } as unknown as PoolClient;
  const pool = { async connect() { return client; } } as unknown as Pool;
  return { pool, cap };
}

const baseInput = { userId: 7n, sessionId: "sess-1", sinceMs: 1000, memo: "waive:idle_timeout" };

describe("refundSessionWindow — 按原桶冲正", () => {
  test("P0:org_wallet 扣费退回 org,不写个人 wallet 桶 ledger", async () => {
    const { pool, cap } = makeFakePool({
      debits: [{ usage_id: "u1", bucket: "org_wallet", delta: "-500", org_id: "5" }],
      wallet: 200n,
      userSub: null,
      orgs: new Map([["5", 1000n]]),
      orgSubs: new Map([["5", null]]),
    });
    const r = await refundSessionWindow(pool, baseInput);
    assert.equal(r.refundedCredits, 500n);
    assert.equal(r.skippedOrgCredits, 0n);
    // 唯一 ledger 行必须是 org_wallet + org_id=5,绝不是个人 wallet
    assert.equal(cap.ledgerInserts.length, 1);
    assert.equal(cap.ledgerInserts[0]!.bucket, "org_wallet");
    assert.equal(cap.ledgerInserts[0]!.org_id, "5");
    // orgs 被 +500;个人 wallet 写回原值(未被 org 钱膨胀)
    const orgUpd = cap.updates.find((u) => /UPDATE orgs SET credits/.test(u.sql));
    assert.ok(orgUpd, "org.credits 应被更新");
    assert.equal(String(orgUpd!.params[0]), "1500");
    const userUpd = cap.updates.find((u) => /UPDATE users SET credits/.test(u.sql));
    assert.equal(String(userUpd!.params[0]), "200", "个人钱包必须保持原值 200,不得被 org 退款膨胀");
  });

  test("P0:org_period 有 active org 订阅 → 退回 org 期内桶,不落个人", async () => {
    const { pool, cap } = makeFakePool({
      debits: [{ usage_id: "u1", bucket: "org_period", delta: "-300", org_id: "5" }],
      wallet: 0n,
      userSub: null,
      orgs: new Map([["5", 1000n]]),
      orgSubs: new Map([["5", { id: "88", period_credits: "700" }]]),
    });
    const r = await refundSessionWindow(pool, baseInput);
    assert.equal(r.refundedCredits, 300n);
    assert.equal(cap.ledgerInserts[0]!.bucket, "org_period");
    assert.equal(cap.ledgerInserts[0]!.org_id, "5");
    const subUpd = cap.updates.find((u) => /UPDATE org_subscriptions SET period_credits/.test(u.sql));
    assert.ok(subUpd);
    assert.equal(String(subUpd!.params[0]), "1000", "org 期内桶 700+300");
  });

  test("P0:org 已停用(orgs 空)→ 跳过,skippedOrgCredits 计数,绝不落个人钱包", async () => {
    const { pool, cap } = makeFakePool({
      debits: [{ usage_id: "u1", bucket: "org_wallet", delta: "-400", org_id: "9" }],
      wallet: 100n,
      userSub: null,
      orgs: new Map([["9", null]]), // 非 active
      orgSubs: new Map([["9", null]]),
    });
    const r = await refundSessionWindow(pool, baseInput);
    assert.equal(r.refundedCredits, 0n, "无可退 → 不退");
    assert.equal(r.skippedOrgCredits, 400n);
    assert.equal(cap.ledgerInserts.length, 0, "不得写任何退款 ledger");
    // refunded=0 → 整体 ROLLBACK,个人钱包绝不被 org 退款触碰
    assert.ok(!cap.updates.some((u) => /UPDATE users SET credits/.test(u.sql)), "不得写个人钱包");
  });

  test("个人 wallet 桶行为不变(回归)", async () => {
    const { pool, cap } = makeFakePool({
      debits: [{ usage_id: "u1", bucket: "wallet", delta: "-150", org_id: null }],
      wallet: 100n,
      userSub: null,
      orgs: new Map(),
      orgSubs: new Map(),
    });
    const r = await refundSessionWindow(pool, baseInput);
    assert.equal(r.refundedCredits, 150n);
    assert.equal(cap.ledgerInserts[0]!.bucket, "wallet");
    const userUpd = cap.updates.find((u) => /UPDATE users SET credits/.test(u.sql));
    assert.equal(String(userUpd!.params[0]), "250", "个人钱包 100+150");
  });

  test("P1-1:user_subscriptions 选择谓词含 period_end > NOW()", async () => {
    const { pool, cap } = makeFakePool({
      debits: [{ usage_id: "u1", bucket: "wallet", delta: "-10", org_id: null }],
      wallet: 0n, userSub: null, orgs: new Map(), orgSubs: new Map(),
    });
    await refundSessionWindow(pool, baseInput);
    const usSql = cap.sqlSeen.find((s) => /FROM user_subscriptions WHERE user_id/.test(s.replace(/\s+/g, " ")));
    assert.ok(usSql && /period_end > NOW\(\)/.test(usSql.replace(/\s+/g, " ")), "退款须与 spend 谓词对齐");
  });
});
