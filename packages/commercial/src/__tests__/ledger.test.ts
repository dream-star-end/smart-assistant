/**
 * T-22 — ledger 单元测试(不碰 DB,只测入参校验 / Error 结构)。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  debit,
  credit,
  adminAdjust,
  InsufficientCreditsError,
  LEDGER_REASONS,
} from "../billing/ledger.js";

describe("InsufficientCreditsError", () => {
  test("code is ERR_INSUFFICIENT_CREDITS, shortfall = required - balance", () => {
    const e = new InsufficientCreditsError(40n, 100n);
    assert.equal(e.code, "ERR_INSUFFICIENT_CREDITS");
    assert.equal(e.balance, 40n);
    assert.equal(e.required, 100n);
    assert.equal(e.shortfall, 60n);
    assert.ok(e instanceof Error);
  });

  test("message includes balance and required values", () => {
    const e = new InsufficientCreditsError(10n, 25n);
    assert.match(e.message, /balance=10/);
    assert.match(e.message, /required=25/);
  });
});

describe("LEDGER_REASONS (schema sync check)", () => {
  test("expected reasons present", () => {
    for (const r of [
      "topup",
      "chat",
      "agent_chat",
      "agent_subscription",
      "refund",
      "admin_adjust",
      "promotion",
    ]) {
      assert.ok(LEDGER_REASONS.includes(r as (typeof LEDGER_REASONS)[number]));
    }
    // 不允许悄悄加东西而忘了同步 0002_init_billing.sql
    assert.equal(LEDGER_REASONS.length, 7);
  });
});

describe("debit / credit input validation(不触 DB,校验先于 tx)", () => {
  test("debit: amount <= 0 → TypeError", async () => {
    await assert.rejects(() => debit(1, 0n, "chat"), TypeError);
    await assert.rejects(() => debit(1, -5n, "chat"), TypeError);
  });

  test("credit: amount <= 0 → TypeError", async () => {
    await assert.rejects(() => credit(1, 0n, "topup"), TypeError);
    await assert.rejects(() => credit(1, -5n, "topup"), TypeError);
  });

  test("unknown reason → TypeError", async () => {
    // @ts-expect-error — 故意传非法 reason 验证 runtime guard
    await assert.rejects(() => debit(1, 10n, "hack_reason"), /unknown ledger reason/);
  });

  test("user_id number 非正整数 → TypeError", async () => {
    await assert.rejects(() => debit(0, 10n, "chat"), TypeError);
    await assert.rejects(() => debit(-1, 10n, "chat"), TypeError);
    await assert.rejects(() => debit(1.5, 10n, "chat"), TypeError);
  });

  test("user_id string 非十进制 → TypeError", async () => {
    await assert.rejects(() => debit("abc", 10n, "chat"), /decimal digits/);
    await assert.rejects(() => debit("12x", 10n, "chat"), TypeError);
  });
});

describe("adminAdjust input validation", () => {
  test("delta = 0 → TypeError", async () => {
    await assert.rejects(
      () => adminAdjust(1, 0n, "reason", 2),
      /delta must be != 0/,
    );
  });

  test("memo 空 / 仅空白 → TypeError", async () => {
    await assert.rejects(() => adminAdjust(1, 10n, "", 2), /memo is required/);
    await assert.rejects(() => adminAdjust(1, 10n, "   ", 2), /memo is required/);
  });
});
