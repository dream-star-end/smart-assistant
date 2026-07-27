/**
 * T-22 — ledger 单元测试(不碰 DB,只测入参校验 / Error 结构)。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
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
  test("matches the final reason constraint migration exactly", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sql = await readFile(
      path.resolve(here, "../db/migrations/0131_image_generation_billing.sql"),
      "utf8",
    );
    const constraint = /CHECK\s*\(reason IN\s*\(([\s\S]*?)\)\)\s*NOT VALID/.exec(sql)?.[1];
    assert.ok(constraint, "0131 final credit_ledger reason CHECK must remain parseable");
    const databaseReasons = [...constraint.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual([...databaseReasons].sort(), [...LEDGER_REASONS].sort());
  });
});

// 旧 debit/credit/getBalance 已删除(生产扣费收口 billing/spend.ts spendTwoBucket),
// 对应入参校验用例随之移除;user_id 归一化校验由 adminAdjust 路径继续覆盖。
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

  test("user_id number 非正整数 → TypeError", async () => {
    await assert.rejects(() => adminAdjust(0, 10n, "memo", 2), TypeError);
    await assert.rejects(() => adminAdjust(-1, 10n, "memo", 2), TypeError);
    await assert.rejects(() => adminAdjust(1.5, 10n, "memo", 2), TypeError);
  });

  test("user_id string 非十进制 → TypeError", async () => {
    await assert.rejects(() => adminAdjust("abc", 10n, "memo", 2), /decimal digits/);
    await assert.rejects(() => adminAdjust("12x", 10n, "memo", 2), TypeError);
  });
});
