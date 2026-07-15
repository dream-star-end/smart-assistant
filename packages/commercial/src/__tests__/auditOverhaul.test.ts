/**
 * 审计体系整改批 — 纯单元测试(无 DB):
 *   1. auditRedact:中央脱敏钩子(敏感 key 识别/元信息形状/复数 tokens 不误伤/深度帽)
 *   2. auditActions:注册表完整性(命名约定/kind/mode)
 *   3. writeAdminAudit:未登记 action fail-fast;before/after 入库前已脱敏(stub runner)
 *   4. writeAdminAuditBestEffort:mode='tx' action 走 best-effort 直接抛(政策执行点)
 *   5. auditRetention:政策解析(env 覆盖/未注册表拒绝/永久表断言)+ runNow 注入 purgeFn
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { redactSensitive, SENSITIVE_KEY_RE } from "../admin/auditRedact.js";
import {
  ADMIN_AUDIT_ACTIONS,
  isAdminAuditAction,
  auditActionsByKind,
} from "../admin/auditActions.js";
import { writeAdminAudit, writeAdminAuditBestEffort } from "../admin/audit.js";
import {
  AUDIT_RETENTION_POLICIES,
  PERMANENT_AUDIT_TABLES,
  resolveRetentionPolicies,
  startAuditRetentionSweeper,
  type RetentionPolicy,
} from "../admin/auditRetention.js";

describe("auditRedact — 中央脱敏钩子", () => {
  test("敏感 key 的字符串值替换为 {__redacted,len,last4}", () => {
    const out = redactSensitive({
      bot_token: "abcdefghijklmnop",
      label: "my-channel",
    }) as Record<string, unknown>;
    assert.deepEqual(out.bot_token, { __redacted: true, len: 16, last4: "mnop" });
    assert.equal(out.label, "my-channel");
  });

  test("短敏感值(<12 字符)不给 last4(避免尾巴即泄露)", () => {
    const out = redactSensitive({ password: "short" }) as Record<string, unknown>;
    assert.deepEqual(out.password, { __redacted: true, len: 5 });
  });

  test("计数字段防误伤按值类型:number/boolean 不脱;复数凭据名(access_tokens 数组)照脱", () => {
    const out = redactSensitive({
      max_tokens: 4096,
      input_tokens: 123,
      token_stream: true,
      access_token: "secret-value-here",
      access_tokens: ["secret-a", "secret-b"],
    }) as Record<string, unknown>;
    assert.equal(out.max_tokens, 4096);
    assert.equal(out.input_tokens, 123);
    assert.equal(out.token_stream, true);
    assert.deepEqual(out.access_token, { __redacted: true, len: 17, last4: "here" });
    // Codex R1 MAJOR#3:复数凭据集合绝不能被 lookahead 放过
    assert.deepEqual(out.access_tokens, { __redacted: true });
    // Codex R2+R3:数值放行只限显式计数名——数值型口令/密钥/裸 *_token 凭据照脱
    const out3 = redactSensitive({
      password: 123456,
      api_key: 987654321,
      access_token: 123456789,
      refresh_token: 42,
      api_token: 7,
      tokens_per_credit: 250,
      output_tokens: 512,
      token_count: 99,
    }) as Record<string, unknown>;
    assert.deepEqual(out3.password, { __redacted: true });
    assert.deepEqual(out3.api_key, { __redacted: true });
    assert.deepEqual(out3.access_token, { __redacted: true });
    assert.deepEqual(out3.refresh_token, { __redacted: true });
    assert.deepEqual(out3.api_token, { __redacted: true });
    assert.equal(out3.tokens_per_credit, 250);
    assert.equal(out3.output_tokens, 512);
    assert.equal(out3.token_count, 99);
  });

  test("嵌套对象与数组内的敏感 key 也被脱敏;敏感 key 下的对象整体替换", () => {
    const out = redactSensitive({
      config: { api_key: "0123456789abcdef", timeout: 30 },
      items: [{ client_secret: "0123456789abcdef" }],
      credentials: { user: "a", pass: "b" },
    }) as { config: Record<string, unknown>; items: Array<Record<string, unknown>>; credentials: unknown };
    assert.deepEqual(out.config.api_key, { __redacted: true, len: 16, last4: "cdef" });
    assert.equal(out.config.timeout, 30);
    assert.deepEqual(out.items[0].client_secret, { __redacted: true, len: 16, last4: "cdef" });
    assert.deepEqual(out.credentials, { __redacted: true });
  });

  test("调用点已自行脱敏的形状({set,len,last4})不二次包裹;冒充形状(字段类型不符)不予信任", () => {
    const already = { set: true, len: 40, last4: "ab12" };
    const out = redactSensitive({ token: already }) as Record<string, unknown>;
    assert.deepEqual(out.token, already);
    // Codex R1 MAJOR#3:{masked:"<raw>"} / {last4:"<raw>"} 带明文冒充 → 整体照脱
    const out2 = redactSensitive({
      token: { masked: "raw-secret-here" },
      secret: { last4: "raw-secret-here" },
      api_key: { __redacted: true },
    }) as Record<string, unknown>;
    assert.deepEqual(out2.token, { __redacted: true });
    assert.deepEqual(out2.secret, { __redacted: true });
    assert.deepEqual(out2.api_key, { __redacted: true });
    // Codex R2:__redacted:true 夹带未知字段 → 不信任,整体照脱(明文 raw 不得存活)
    const out3 = redactSensitive({
      token: { __redacted: true, raw: "sk-live-secret" },
    }) as Record<string, unknown>;
    assert.deepEqual(out3.token, { __redacted: true });
    assert.ok(!JSON.stringify(out3).includes("sk-live-secret"));
  });

  test("null/undefined 值原样;标量原样;深度帽生效不炸栈", () => {
    assert.equal(redactSensitive(null), null);
    assert.equal(redactSensitive("plain"), "plain");
    const out = redactSensitive({ secret: null }) as Record<string, unknown>;
    assert.equal(out.secret, null);
    // 深结构:>MAX_DEPTH 的子树整体替换,不抛
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    const capped = redactSensitive(deep);
    assert.ok(JSON.stringify(capped).includes("depth-capped"));
  });

  test("SENSITIVE_KEY_RE 语料回归(RE 只管 key 候选,计数字段由值类型层放行)", () => {
    const hit = ["bot_token", "access_token", "access_tokens", "refresh_tokens", "API_KEY", "clientSecret", "authorization", "cookie", "signing-key", "passwd", "max_tokens"];
    const miss = ["label", "key_metrics", "monkey", "delta", "memo"];
    for (const k of hit) assert.ok(SENSITIVE_KEY_RE.test(k), `expect hit: ${k}`);
    for (const k of miss) assert.ok(!SENSITIVE_KEY_RE.test(k), `expect miss: ${k}`);
  });
});

describe("auditActions — 注册表", () => {
  test("命名约定:全小写 名词[.子名词].动词,无破格", () => {
    for (const a of Object.keys(ADMIN_AUDIT_ACTIONS)) {
      assert.match(a, /^[a-z0-9_]+(\.[a-z0-9_]+)+$/, `action 命名破格: ${a}`);
    }
  });

  test("isAdminAuditAction:注册的 true,野字符串/原型链 false", () => {
    assert.ok(isAdminAuditAction("user.create"));
    assert.ok(isAdminAuditAction("account.migrate_to_pool"));
    assert.ok(isAdminAuditAction("user.patch"));
    assert.ok(isAdminAuditAction("user.credits.adjust"));
    assert.ok(!isAdminAuditAction("credits.adjust"));
    assert.ok(!isAdminAuditAction("blocked_route_bypass"));
    assert.ok(!isAdminAuditAction("toString"));
  });

  test("kind 派生:read 集含敏感读取,write 集含资金操作", () => {
    const reads = auditActionsByKind("read");
    assert.ok(reads.includes("sessions.read"));
    assert.ok(reads.includes("agent_container.logs"));
    assert.ok(!reads.includes("user.credits.adjust"));
    const writes = auditActionsByKind("write");
    assert.ok(writes.includes("user.credits.adjust"));
    assert.ok(writes.includes("marketplace.skill.revoke"));
  });

  test("资金/权限/封禁类必须 mode='tx'(政策不变量)", () => {
    for (const a of ["user.create", "user.credits.adjust", "org.credits.adjust", "user.patch", "pricing.patch", "plan.patch", "model_grant.add"] as const) {
      assert.equal(ADMIN_AUDIT_ACTIONS[a].mode, "tx", `${a} 必须 fail-closed`);
    }
  });
});

describe("writeAdminAudit — 写入口校验与脱敏(stub runner,无 DB)", () => {
  function stubRunner() {
    const calls: { sql: string; params: unknown[] }[] = [];
    return {
      calls,
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [{ id: "42" }], rowCount: 1 } as never;
      },
    };
  }

  test("未登记 action → 同步 fail-fast,不触 DB", async () => {
    const r = stubRunner();
    await assert.rejects(
      // @ts-expect-error 故意传未登记 action,验证运行时兜底
      () => writeAdminAudit(r, { adminId: 1, action: "made.up", target: null }),
      /unregistered action/,
    );
    assert.equal(r.calls.length, 0);
  });

  test("before/after 入库前已过中央脱敏", async () => {
    const r = stubRunner();
    const id = await writeAdminAudit(r, {
      adminId: 7,
      action: "system_settings.set",
      target: "setting:x",
      before: { value: { api_key: "0123456789abcdef" } },
      after: { value: { api_key: "fedcba9876543210" }, max_tokens: 100 },
      ip: "127.0.0.1",
      userAgent: "t/1",
    });
    assert.equal(id, 42n);
    assert.equal(r.calls.length, 1);
    const [, , , beforeJson, afterJson] = r.calls[0].params as [unknown, unknown, unknown, string, string];
    assert.ok(!beforeJson.includes("0123456789abcdef"), "before 明文泄露");
    assert.ok(!afterJson.includes("fedcba9876543210"), "after 明文泄露");
    assert.ok(afterJson.includes('"max_tokens":100'), "计数字段不得误伤(值类型放行)");
    assert.ok(beforeJson.includes('"__redacted":true'));
  });
});

describe("writeAdminAuditBestEffort — mode 政策执行点", () => {
  test("mode='tx' 的 action 走 best-effort → 抛(编程错误,不静默降级)", async () => {
    await assert.rejects(
      () => writeAdminAuditBestEffort({ adminId: 1 }, "user.credits.adjust", "user:1", null, null),
      /mode='tx'/,
    );
  });
});

describe("auditRetention — 政策注册表与 sweeper", () => {
  test("默认政策:admin_audit 永不在删除政策;核心事件表全覆盖", () => {
    const tables = AUDIT_RETENTION_POLICIES.map((p) => p.table);
    assert.ok(!tables.includes("admin_audit"));
    assert.ok(PERMANENT_AUDIT_TABLES.includes("admin_audit"));
    for (const t of ["security_events", "agent_audit", "compute_host_audit", "turn_traces", "rate_limit_events"]) {
      assert.ok(tables.includes(t), `缺 retention 政策: ${t}`);
    }
  });

  test("env 覆盖:注册表内的表可改天数;未注册表忽略(防任意表删除)", () => {
    const r = resolveRetentionPolicies("agent_audit=7,users=1,bogus");
    assert.equal(r.find((p) => p.table === "agent_audit")?.days, 7);
    assert.ok(!r.some((p) => p.table === "users"));
    // 非法天数不生效
    const r2 = resolveRetentionPolicies("agent_audit=0");
    assert.equal(r2.find((p) => p.table === "agent_audit")?.days, 90);
  });

  test("runNow:逐表调 purgeFn;单表失败不阻断其余(onError 收到)", async () => {
    const purged: string[] = [];
    const errs: string[] = [];
    const h = startAuditRetentionSweeper({
      intervalMs: 60_000,
      purgeFn: async (p: RetentionPolicy) => {
        if (p.table === "agent_audit") throw new Error("boom");
        purged.push(`${p.table}:${p.days}`);
        return 3;
      },
      onError: (table) => { errs.push(table); },
    });
    try {
      const res = await h.runNow();
      assert.equal(res["security_events"], 3);
      assert.equal(res["agent_audit"], -1);
      assert.deepEqual(errs, ["agent_audit"]);
      assert.ok(purged.includes("turn_traces:90"));
      assert.ok(purged.includes("rate_limit_events:30"));
    } finally {
      h.stop();
    }
  });
});
