/**
 * T-30 — account-pool/store 单元测试(仅覆盖输入校验,不触 DB)。
 *
 * DB 行为 / 加密与解密的往返 / FK 约束都在 accountStore.integ.test.ts 里验证,
 * 这个文件只覆盖「在发 SQL 之前就该拒绝」的用例,保证单元级反馈快。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { KMS_KEY_BYTES } from "../crypto/keys.js";
import {
  createAccount,
  updateAccount,
  ACCOUNT_PLANS,
  ACCOUNT_STATUSES,
} from "../account-pool/store.js";

const KEY = randomBytes(KMS_KEY_BYTES);
const keyFn = (): Buffer => Buffer.from(KEY);

describe("ACCOUNT_PLANS / ACCOUNT_STATUSES 常量", () => {
  test("plans 枚举包含 pro/max/team", () => {
    assert.deepEqual([...ACCOUNT_PLANS].sort(), ["max", "pro", "team"]);
  });
  test("statuses 枚举包含 active/cooldown/disabled/banned", () => {
    assert.deepEqual(
      [...ACCOUNT_STATUSES].sort(),
      ["active", "banned", "cooldown", "disabled"],
    );
  });
});

describe("createAccount — 预校验在 DB 之前拦截", () => {
  test("非法 plan → TypeError(不触 DB)", async () => {
    await assert.rejects(
      createAccount(
        { label: "x", plan: "FREE" as unknown as "pro", token: "t", egress_proxy_id: "1" },
        keyFn,
      ),
      TypeError,
    );
  });

  test("空 token → TypeError", async () => {
    await assert.rejects(
      createAccount({ label: "x", plan: "pro", token: "", egress_proxy_id: "1" }, keyFn),
      TypeError,
    );
  });

  test("非字符串 token → TypeError", async () => {
    await assert.rejects(
      createAccount(
        { label: "x", plan: "pro", token: 42 as unknown as string, egress_proxy_id: "1" },
        keyFn,
      ),
      TypeError,
    );
  });

  test("空字符串 refresh → TypeError", async () => {
    await assert.rejects(
      createAccount({ label: "x", plan: "pro", token: "t", refresh: "", egress_proxy_id: "1" }, keyFn),
      TypeError,
    );
  });
});

describe("updateAccount — 预校验在 DB 之前拦截", () => {
  test("非法 plan → TypeError", async () => {
    await assert.rejects(
      updateAccount(1n, { plan: "FREE" as unknown as "pro" }, keyFn),
      TypeError,
    );
  });

  test("非法 status → TypeError", async () => {
    await assert.rejects(
      updateAccount(1n, { status: "frozen" as unknown as "active" }, keyFn),
      TypeError,
    );
  });

  test("health_score < 0 → RangeError", async () => {
    await assert.rejects(updateAccount(1n, { health_score: -1 }, keyFn), RangeError);
  });

  test("health_score > 100 → RangeError", async () => {
    await assert.rejects(updateAccount(1n, { health_score: 101 }, keyFn), RangeError);
  });

  test("空 token 字符串 → TypeError", async () => {
    await assert.rejects(updateAccount(1n, { token: "" }, keyFn), TypeError);
  });

  test("空 refresh 字符串 → TypeError", async () => {
    await assert.rejects(updateAccount(1n, { refresh: "" }, keyFn), TypeError);
  });
});
