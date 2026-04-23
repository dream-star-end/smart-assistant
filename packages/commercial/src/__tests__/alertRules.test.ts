/**
 * T-63 — alertRules.ts PolledRule.evaluate() 纯单元测试。
 *
 * evaluate() 只读 snapshot 不摸 DB/HTTP,非常适合用 fixture snapshot 覆盖
 * firing/resolved/边界阈值。
 *
 * 不覆盖的东西:
 *   - collectRuleSnapshot() 读 DB → 走 integ test(暂未写,见 backlog)
 *   - runRulesOnce() 带 transitionRuleState / enqueueAlert 副作用 → integ
 *
 * 这里锁住"相同输入永远给相同 outcome"的行为 —— 改阈值 / 改规则 / 加新规则时,
 * 相关测试必须同步更新,防止静默回归。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ruleAccountPoolNotConfigured,
  ruleAccountPoolAllDown,
  ruleAccountPoolLowCapacity,
  ruleSignupSpike,
  ruleRateLimitSpike,
  ruleLoginFailureSpike,
  defaultPolledRules,
  type RuleSnapshot,
} from "../admin/alertRules.js";
import { EVENTS } from "../admin/alertEvents.js";

/** 构造一个"全绿"的基准 snapshot,测试只覆盖感兴趣字段 */
function baseSnapshot(overrides: Partial<RuleSnapshot> = {}): RuleSnapshot {
  return {
    accountHealth: [
      { account_id: "1", health_score: 100, status: "active" },
      { account_id: "2", health_score: 80, status: "active" },
    ],
    signupCountLastWindowMin: 0,
    signupWindowMin: 10,
    rateLimitBlockedLastWindowMin: 0,
    rateLimitWindowMin: 10,
    loginFailureBlockedLastWindowMin: 0,
    loginFailureWindowMin: 10,
    ...overrides,
  };
}

describe("ruleAccountPoolNotConfigured", () => {
  test("firing 当账号池为空", () => {
    const s = baseSnapshot({ accountHealth: [] });
    const o = ruleAccountPoolNotConfigured.evaluate(s);
    assert.equal(o.firing, true);
    if (o.firing) {
      assert.ok(o.title.includes("CRITICAL"));
      assert.equal(o.dedupe_key, `${EVENTS.ACCOUNT_POOL_NOT_CONFIGURED}:global`);
      assert.equal(o.payload.accounts_count, 0);
    }
  });

  test("resolved 当有账号", () => {
    const o = ruleAccountPoolNotConfigured.evaluate(baseSnapshot());
    assert.equal(o.firing, false);
  });
});

describe("ruleAccountPoolAllDown", () => {
  test("不 firing 当账号池为空 (让 not_configured 负责)", () => {
    const o = ruleAccountPoolAllDown.evaluate(baseSnapshot({ accountHealth: [] }));
    assert.equal(o.firing, false);
  });

  test("firing 当所有账号 health_score=0", () => {
    const s = baseSnapshot({
      accountHealth: [
        { account_id: "1", health_score: 0, status: "active" },
        { account_id: "2", health_score: 0, status: "active" },
      ],
    });
    const o = ruleAccountPoolAllDown.evaluate(s);
    assert.equal(o.firing, true);
    if (o.firing) {
      assert.equal(o.payload.healthy, 0);
      assert.equal(o.payload.total, 2);
    }
  });

  test("firing 当所有账号 status != active", () => {
    const s = baseSnapshot({
      accountHealth: [
        { account_id: "1", health_score: 100, status: "disabled" },
        { account_id: "2", health_score: 100, status: "banned" },
      ],
    });
    assert.equal(ruleAccountPoolAllDown.evaluate(s).firing, true);
  });

  test("resolved 当至少一个 active + healthy", () => {
    const s = baseSnapshot({
      accountHealth: [
        { account_id: "1", health_score: 0, status: "banned" },
        { account_id: "2", health_score: 50, status: "active" },
      ],
    });
    assert.equal(ruleAccountPoolAllDown.evaluate(s).firing, false);
  });
});

describe("ruleAccountPoolLowCapacity", () => {
  test("空池 not firing (not_configured 专属)", () => {
    assert.equal(ruleAccountPoolLowCapacity.evaluate(baseSnapshot({ accountHealth: [] })).firing, false);
  });

  test("firing 当 healthy 低于 ceil(total*0.3) 且 > 0", () => {
    // 10 账号,阈值 = ceil(10 * 0.3) = 3,只有 2 healthy → firing
    const health = Array.from({ length: 10 }, (_, i) => ({
      account_id: String(i + 1),
      health_score: i < 2 ? 80 : 0,
      status: i < 2 ? "active" : "disabled",
    }));
    const s = baseSnapshot({ accountHealth: health });
    const o = ruleAccountPoolLowCapacity.evaluate(s);
    assert.equal(o.firing, true);
    if (o.firing) {
      assert.equal(o.payload.total, 10);
      assert.equal(o.payload.healthy, 2);
      assert.equal(o.payload.threshold, 3);
    }
  });

  test("healthy === 0 时 not firing (让 all_down 负责)", () => {
    const s = baseSnapshot({
      accountHealth: [
        { account_id: "1", health_score: 0, status: "active" },
        { account_id: "2", health_score: 0, status: "active" },
      ],
    });
    assert.equal(ruleAccountPoolLowCapacity.evaluate(s).firing, false);
  });

  test("healthy >= threshold 时 resolved", () => {
    // 2 个账号,阈值 ceil(2*0.3)=1,2 healthy → ok
    assert.equal(ruleAccountPoolLowCapacity.evaluate(baseSnapshot()).firing, false);
  });
});

describe("ruleSignupSpike", () => {
  test("默认阈值 20:低于时 not firing", () => {
    const o = ruleSignupSpike.evaluate(baseSnapshot({ signupCountLastWindowMin: 19 }));
    assert.equal(o.firing, false);
  });

  test("默认阈值 20:达到/超过时 firing", () => {
    const o = ruleSignupSpike.evaluate(baseSnapshot({ signupCountLastWindowMin: 25 }));
    assert.equal(o.firing, true);
    if (o.firing) {
      assert.equal(o.payload.threshold, 20);
      assert.equal(o.payload.count, 25);
      assert.ok(o.dedupe_key.startsWith(EVENTS.RISK_SIGNUP_SPIKE + ":"));
    }
  });

  test("注入 _signupThreshold 覆盖默认", () => {
    const s = baseSnapshot({ signupCountLastWindowMin: 5 }) as unknown as RuleSnapshot & {
      _signupThreshold: number;
    };
    s._signupThreshold = 3;
    const o = ruleSignupSpike.evaluate(s);
    assert.equal(o.firing, true);
    if (o.firing) assert.equal(o.payload.threshold, 3);
  });

  test("dedupe_key 按 10min 桶化,同一桶内相同", () => {
    // 两次紧邻调用应拿到相同 bucket(除非真跨 10min 边界)
    const s = baseSnapshot({ signupCountLastWindowMin: 100 });
    const a = ruleSignupSpike.evaluate(s);
    const b = ruleSignupSpike.evaluate(s);
    assert.equal(a.firing, true);
    assert.equal(b.firing, true);
    if (a.firing && b.firing) {
      // 非常罕见恰好跨桶 → 允许最多两组值;但 99.99% 相等
      assert.ok(
        a.dedupe_key === b.dedupe_key,
        `dedupe_key drifted: ${a.dedupe_key} vs ${b.dedupe_key}`,
      );
    }
  });
});

describe("ruleRateLimitSpike", () => {
  test("默认阈值 200:firing 条件", () => {
    assert.equal(
      ruleRateLimitSpike.evaluate(baseSnapshot({ rateLimitBlockedLastWindowMin: 199 })).firing,
      false,
    );
    const o = ruleRateLimitSpike.evaluate(baseSnapshot({ rateLimitBlockedLastWindowMin: 500 }));
    assert.equal(o.firing, true);
    if (o.firing) {
      assert.equal(o.payload.threshold, 200);
      assert.equal(o.payload.count, 500);
    }
  });

  test("注入 _rateLimitThreshold 覆盖", () => {
    const s = baseSnapshot({ rateLimitBlockedLastWindowMin: 50 }) as unknown as RuleSnapshot & {
      _rateLimitThreshold: number;
    };
    s._rateLimitThreshold = 10;
    assert.equal(ruleRateLimitSpike.evaluate(s).firing, true);
  });
});

describe("ruleLoginFailureSpike", () => {
  test("firing 当 login blocked 超阈值", () => {
    const s = baseSnapshot({ loginFailureBlockedLastWindowMin: 50 }) as unknown as RuleSnapshot & {
      _loginFailureThreshold: number;
    };
    s._loginFailureThreshold = 30;
    const o = ruleLoginFailureSpike.evaluate(s);
    assert.equal(o.firing, true);
    if (o.firing) {
      assert.ok(o.dedupe_key.startsWith(`${EVENTS.RISK_LOGIN_FAILURE_SPIKE}:`));
      assert.equal(o.payload.count, 50);
      assert.equal(o.payload.threshold, 30);
      assert.equal(o.payload.window_min, 10);
    }
  });

  test("不 firing 当数值低于阈值", () => {
    const s = baseSnapshot({ loginFailureBlockedLastWindowMin: 5 }) as unknown as RuleSnapshot & {
      _loginFailureThreshold: number;
    };
    s._loginFailureThreshold = 30;
    assert.equal(ruleLoginFailureSpike.evaluate(s).firing, false);
  });

  test("默认阈值 30(snapshot 未注入 _loginFailureThreshold)", () => {
    const s = baseSnapshot({ loginFailureBlockedLastWindowMin: 29 });
    assert.equal(ruleLoginFailureSpike.evaluate(s).firing, false);
    const s2 = baseSnapshot({ loginFailureBlockedLastWindowMin: 30 });
    assert.equal(ruleLoginFailureSpike.evaluate(s2).firing, true);
  });
});

describe("defaultPolledRules", () => {
  test("包含 6 条默认规则", () => {
    const rules = defaultPolledRules();
    assert.equal(rules.length, 6);
    const ids = rules.map((r) => r.id).sort();
    assert.deepEqual(ids, [
      EVENTS.ACCOUNT_POOL_ALL_DOWN,
      EVENTS.ACCOUNT_POOL_LOW_CAPACITY,
      EVENTS.ACCOUNT_POOL_NOT_CONFIGURED,
      EVENTS.RISK_LOGIN_FAILURE_SPIKE,
      EVENTS.RISK_RATE_LIMIT_SPIKE,
      EVENTS.RISK_SIGNUP_SPIKE,
    ].sort());
  });

  test("每条规则 rule.id === rule.event_type (dedupe_key 前缀对齐约定)", () => {
    for (const r of defaultPolledRules()) {
      assert.equal(r.id, r.event_type, `${r.id} id/event_type mismatch`);
    }
  });
});
