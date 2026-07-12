/**
 * v5 自愈体系收尾批(M5+B3)— selfheal/config 纯单元(无 DB/网络)。
 *
 * 验:assertSelfhealConfig fail-fast(密钥长度/互异/派单 URL SSRF 钉死)/
 *     validateDispatchUrl 形态矩阵 / 数值 env 解析默认值与下限 clamp。
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  assertSelfhealConfig,
  validateDispatchUrl,
  selfhealTickMs,
  repairCooldownMs,
  ackBudgetMs,
  totalBudgetMs,
  verifyBudgetMs,
  isSelfhealDispatchDisabled,
} from "../selfheal/config.js";

const ENV_KEYS = [
  "OC_SELFHEAL_DISPATCH_DISABLED",
  "OC_SELFHEAL_MASTER_SECRET",
  "OC_SELFHEAL_WEBHOOK_HMAC",
  "OC_SELFHEAL_DISPATCH_URL",
  "OC_SELFHEAL_TICK_MS",
  "OC_SELFHEAL_REPAIR_COOLDOWN_MS",
  "OC_SELFHEAL_ACK_BUDGET_MS",
  "OC_SELFHEAL_TOTAL_BUDGET_MS",
  "OC_SELFHEAL_VERIFY_BUDGET_MS",
] as const;

const GOOD = {
  OC_SELFHEAL_DISPATCH_DISABLED: "0",
  OC_SELFHEAL_MASTER_SECRET: "m".repeat(32),
  OC_SELFHEAL_WEBHOOK_HMAC: "w".repeat(32),
  OC_SELFHEAL_DISPATCH_URL: "http://127.0.0.1:18795",
};

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("validateDispatchUrl(M5 SSRF 钉死)", () => {
  test("合法:http + loopback + 显式端口", () => {
    assert.equal(validateDispatchUrl("http://127.0.0.1:18795"), null);
    assert.equal(validateDispatchUrl("http://localhost:18795"), null);
    assert.equal(validateDispatchUrl("http://[::1]:18795"), null);
  });
  test("拒:https / 非 loopback / 无端口 / 非 URL / 缺省", () => {
    assert.match(validateDispatchUrl("https://127.0.0.1:18795")!, /http:\/\//);
    assert.match(validateDispatchUrl("http://10.0.0.5:18795")!, /loopback/);
    assert.match(validateDispatchUrl("http://evil.example.com:80")!, /loopback/);
    assert.match(validateDispatchUrl("http://127.0.0.1")!, /端口/);
    assert.match(validateDispatchUrl("not a url")!, /不是合法 URL/);
    assert.match(validateDispatchUrl(undefined)!, /未设置/);
    assert.match(validateDispatchUrl("")!, /未设置/);
  });
});

describe("assertSelfhealConfig(fail-fast)", () => {
  test("dispatch 禁用(env 缺省)→ 不抛(warn-only,dormant 部署合法)", () => {
    assert.doesNotThrow(() => assertSelfhealConfig());
    assert.equal(isSelfhealDispatchDisabled(), true);
  });

  test("dispatch 启用 + 全部合规 → 通过", () => {
    Object.assign(process.env, GOOD);
    assert.doesNotThrow(() => assertSelfhealConfig());
    assert.equal(isSelfhealDispatchDisabled(), false);
  });

  test("MASTER_SECRET 短于 32 → throw", () => {
    Object.assign(process.env, GOOD, { OC_SELFHEAL_MASTER_SECRET: "short" });
    assert.throws(() => assertSelfhealConfig(), /MASTER_SECRET/);
  });

  test("WEBHOOK_HMAC 短于 32 → throw", () => {
    Object.assign(process.env, GOOD, { OC_SELFHEAL_WEBHOOK_HMAC: "short" });
    assert.throws(() => assertSelfhealConfig(), /WEBHOOK_HMAC/);
  });

  test("两密钥相同 → throw(域隔离)", () => {
    Object.assign(process.env, GOOD, {
      OC_SELFHEAL_MASTER_SECRET: "s".repeat(40),
      OC_SELFHEAL_WEBHOOK_HMAC: "s".repeat(40),
    });
    assert.throws(() => assertSelfhealConfig(), /互异/);
  });

  test("派单 URL 非 loopback / https / 无端口 → throw", () => {
    for (const bad of ["http://192.168.1.1:18795", "https://127.0.0.1:18795", "http://127.0.0.1"]) {
      Object.assign(process.env, GOOD, { OC_SELFHEAL_DISPATCH_URL: bad });
      assert.throws(() => assertSelfhealConfig(), /OC_SELFHEAL_DISPATCH_URL/, `应拒绝 ${bad}`);
    }
  });

  test("多项违规 → 一次性汇总在错误信息里(运维一次看全)", () => {
    process.env.OC_SELFHEAL_DISPATCH_DISABLED = "0";
    try {
      assertSelfhealConfig();
      assert.fail("应抛错");
    } catch (err) {
      const msg = (err as Error).message;
      assert.match(msg, /MASTER_SECRET/);
      assert.match(msg, /WEBHOOK_HMAC/);
      assert.match(msg, /OC_SELFHEAL_DISPATCH_URL/);
    }
  });
});

describe("数值 env 收口(B3:默认值 + 下限 clamp)", () => {
  test("缺省 → 各自默认值", () => {
    assert.equal(selfhealTickMs(), 10_000);
    assert.equal(repairCooldownMs(), 30 * 60 * 1000);
    assert.equal(ackBudgetMs(), 5 * 60 * 1000);
    assert.equal(totalBudgetMs(), 90 * 60 * 1000);
    assert.equal(verifyBudgetMs(), 6 * 60 * 1000);
  });
  test("低于下限 / 非数值 → 回默认;合法覆盖生效;cooldown 允许 0(显式关闭)", () => {
    process.env.OC_SELFHEAL_TICK_MS = "1"; // < 2s 下限
    assert.equal(selfhealTickMs(), 10_000);
    process.env.OC_SELFHEAL_TICK_MS = "garbage";
    assert.equal(selfhealTickMs(), 10_000);
    process.env.OC_SELFHEAL_TICK_MS = "5000";
    assert.equal(selfhealTickMs(), 5_000);
    process.env.OC_SELFHEAL_REPAIR_COOLDOWN_MS = "0";
    assert.equal(repairCooldownMs(), 0);
    process.env.OC_SELFHEAL_ACK_BUDGET_MS = "1000"; // < 30s 下限
    assert.equal(ackBudgetMs(), 5 * 60 * 1000);
    process.env.OC_SELFHEAL_VERIFY_BUDGET_MS = "120000";
    assert.equal(verifyBudgetMs(), 120_000);
  });
});
