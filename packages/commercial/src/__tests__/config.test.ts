import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError } from "../config.js";

/**
 * T-01b config.ts 单元测试
 *
 * 约束参见 docs/commercial/02-ARCHITECTURE §6 Configuration Management
 * 和 05-SECURITY §7 输入校验。
 */

const VALID_ENV = {
  DATABASE_URL: "postgres://user:pw@localhost:5432/openclaude_test",
  REDIS_URL: "redis://localhost:6379/0",
  COMMERCIAL_ENABLED: "1",
};

describe("config.loadConfig", () => {
  test("parses a complete valid env", () => {
    const cfg = loadConfig(VALID_ENV);
    assert.equal(cfg.DATABASE_URL, VALID_ENV.DATABASE_URL);
    assert.equal(cfg.REDIS_URL, VALID_ENV.REDIS_URL);
    assert.equal(cfg.COMMERCIAL_ENABLED, true);
  });

  test("COMMERCIAL_ENABLED defaults to false when missing", () => {
    const { COMMERCIAL_ENABLED: _omit, ...rest } = VALID_ENV;
    const cfg = loadConfig(rest);
    assert.equal(cfg.COMMERCIAL_ENABLED, false);
  });

  test("COMMERCIAL_ENABLED accepts explicit '0' as false", () => {
    const cfg = loadConfig({ ...VALID_ENV, COMMERCIAL_ENABLED: "0" });
    assert.equal(cfg.COMMERCIAL_ENABLED, false);
  });

  test("COMMERCIAL_ENABLED throws on any value other than undefined/'0'/'1'", () => {
    // 收紧:避免 "true"/"yes"/"01" 这种部署错误被静默掩盖
    for (const bad of ["true", "yes", "01", "", "on", "FALSE"]) {
      assert.throws(
        () => loadConfig({ ...VALID_ENV, COMMERCIAL_ENABLED: bad }),
        ConfigError,
        `value ${JSON.stringify(bad)} should be rejected`,
      );
    }
  });

  test("throws ConfigError when DATABASE_URL is missing", () => {
    const { DATABASE_URL: _omit, ...rest } = VALID_ENV;
    assert.throws(() => loadConfig(rest), ConfigError);
  });

  test("throws ConfigError when DATABASE_URL is not a valid URL", () => {
    assert.throws(
      () => loadConfig({ ...VALID_ENV, DATABASE_URL: "not-a-url" }),
      ConfigError,
    );
  });

  test("throws ConfigError when DATABASE_URL uses a non-postgres protocol", () => {
    for (const bad of [
      "http://user:pw@localhost:5432/x",
      "mysql://user:pw@localhost:3306/x",
      "file:///etc/passwd",
    ]) {
      assert.throws(
        () => loadConfig({ ...VALID_ENV, DATABASE_URL: bad }),
        ConfigError,
        `protocol in ${bad} should be rejected`,
      );
    }
  });

  test("accepts postgresql:// variant for DATABASE_URL", () => {
    const cfg = loadConfig({
      ...VALID_ENV,
      DATABASE_URL: "postgresql://user:pw@localhost:5432/x",
    });
    assert.equal(cfg.DATABASE_URL, "postgresql://user:pw@localhost:5432/x");
  });

  test("throws ConfigError when REDIS_URL is missing", () => {
    const { REDIS_URL: _omit, ...rest } = VALID_ENV;
    assert.throws(() => loadConfig(rest), ConfigError);
  });

  test("throws ConfigError when REDIS_URL uses a non-redis protocol", () => {
    assert.throws(
      () => loadConfig({ ...VALID_ENV, REDIS_URL: "http://localhost:6379" }),
      ConfigError,
    );
  });

  test("accepts rediss:// variant for REDIS_URL", () => {
    const cfg = loadConfig({ ...VALID_ENV, REDIS_URL: "rediss://localhost:6380/0" });
    assert.equal(cfg.REDIS_URL, "rediss://localhost:6380/0");
  });

  test("OC_RUNTIME_RELEASE treats blank values as a disabled release axis", () => {
    for (const value of ["", "   \t"]) {
      const cfg = loadConfig({ ...VALID_ENV, OC_RUNTIME_RELEASE: value });
      assert.equal(cfg.OC_RUNTIME_RELEASE, undefined);
    }
  });

  test("OC_RUNTIME_RELEASE keeps absolute paths and rejects non-empty relative paths", () => {
    const release = "/var/lib/openclaude-v5/runtime-releases/rel-abc123def456";
    assert.equal(loadConfig({ ...VALID_ENV, OC_RUNTIME_RELEASE: release }).OC_RUNTIME_RELEASE, release);
    assert.throws(
      () => loadConfig({ ...VALID_ENV, OC_RUNTIME_RELEASE: "runtime-releases/rel-abc123def456" }),
      ConfigError,
    );
  });

  test("ConfigError carries a structured issues list", () => {
    try {
      loadConfig({});
      assert.fail("expected loadConfig to throw");
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      assert.ok(Array.isArray(err.issues));
      assert.ok(err.issues.length >= 2, "missing DATABASE_URL and REDIS_URL");
      const fields = err.issues.map((i) => i.path);
      assert.ok(fields.includes("DATABASE_URL"));
      assert.ok(fields.includes("REDIS_URL"));
    }
  });

  // ─── Phase 4A — TURNSTILE_SITE_KEY (公开值,前端 widget 用) ───
  test("TURNSTILE_SITE_KEY 缺省 = undefined,不强制配", () => {
    const cfg = loadConfig(VALID_ENV);
    assert.equal(cfg.TURNSTILE_SITE_KEY, undefined);
  });

  test("TURNSTILE_SITE_KEY 接受合法字符串", () => {
    const cfg = loadConfig({ ...VALID_ENV, TURNSTILE_SITE_KEY: "0x4AAAAAAAxxxx" });
    assert.equal(cfg.TURNSTILE_SITE_KEY, "0x4AAAAAAAxxxx");
  });

  test("TURNSTILE_SITE_KEY 拒绝纯空白(trim 后必须 >=1)", () => {
    assert.throws(
      () => loadConfig({ ...VALID_ENV, TURNSTILE_SITE_KEY: "   " }),
      ConfigError,
    );
  });

  test("TURNSTILE_SITE_KEY 拒绝超长(>128 字符)", () => {
    assert.throws(
      () => loadConfig({ ...VALID_ENV, TURNSTILE_SITE_KEY: "x".repeat(129) }),
      ConfigError,
    );
  });

  test("does not leak raw env in error message", () => {
    try {
      loadConfig({
        DATABASE_URL: "not-a-url",
        REDIS_URL: "redis://x",
        SECRET_SHOULD_NOT_APPEAR: "sk-ant-oat-verysecret",
      });
      assert.fail("expected to throw");
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      assert.ok(
        !err.message.includes("sk-ant-oat-verysecret"),
        "error message must not contain raw env values",
      );
    }
  });

  // v1.0.207 release 契约:`PHASE6_ACCOUNT_UUID_ENFORCE` 和 `SESSION_PIN_MODE`
  // 已从 commercialConfigSchema 删除,迁到 system_settings 表(admin UI 立即可改)。
  // commercial.env 中残留这两行不能让启动崩 — z.object 默认 strip 模式应自动丢弃。
  // 即使值是 "bad-leftover" 这种非法 enum 也不应触发 ConfigError。
  test("deprecated SESSION_PIN_MODE / PHASE6_ACCOUNT_UUID_ENFORCE env leftovers are silently dropped (v1.0.207)", () => {
    const cfg = loadConfig({
      ...VALID_ENV,
      SESSION_PIN_MODE: "bad-leftover-value",
      PHASE6_ACCOUNT_UUID_ENFORCE: "another-bad-value",
    });
    // 字段必须不存在(zod strip),production 代码也不应再读 cfg.SESSION_PIN_MODE
    assert.equal("SESSION_PIN_MODE" in cfg, false);
    assert.equal("PHASE6_ACCOUNT_UUID_ENFORCE" in cfg, false);
  });
});

/**
 * 生产危险开关 fail-closed(2026-07-26 安全整改)。
 *
 * 2026-07-26 审计实测:生产 env 挂着 TURNSTILE_TEST_BYPASS=1,注册/登录/找回密码三个公开
 * 入口的人机验证全部失效,长期无人被提醒。这道门把"生产上开着 test/bypass 开关"变成
 * **启动期硬失败**,与 COMMERCIAL_JWT_SECRET min(32) 同一条 fail-closed 先例。
 *
 * 两类用例同等重要:
 *   ① 该拦的必须拦 —— 否则门形同虚设;
 *   ② **不该拦的必须放行** —— 生产 env 里有 9 个合法的 *_DISABLED 运维开关,
 *      误伤任意一个都会让生产网关起不来(比漏拦更严重的事故)。
 */
describe("config.loadConfig 生产危险开关 fail-closed", () => {
  const PROD_ENV = { ...VALID_ENV, NODE_ENV: "production" };

  // 生产 env 里真实存在的合法运维开关(2026-07-26 实测清单)。逐个断言不被误伤。
  const LEGIT_PRODUCTION_SWITCHES = [
    "COMMERCIAL_CONTROL_PLANE_DISABLED",
    "COMMERCIAL_CRON_WAKE_DISABLED",
    "OC_HEALTH_POLLER_DISABLED",
    "OC_IDLE_SWEEP_DISABLED",
    "OC_IMAGE_DISTRIBUTE_DISABLED",
    "OC_MIGRATION_RECONCILER_DISABLED",
    "OC_PREHEAT_DISABLED",
    "OC_SELFHEAL_DISPATCH_DISABLED",
    "OC_VOLUME_GC_DISABLED",
  ];

  test("production + TURNSTILE_TEST_BYPASS=1 → 拒绝启动", () => {
    assert.throws(
      () => loadConfig({ ...PROD_ENV, TURNSTILE_TEST_BYPASS: "1" }),
      (err: unknown) =>
        err instanceof ConfigError &&
        err.issues.some((i) => i.path === "TURNSTILE_TEST_BYPASS" && i.code === "production_danger_switch"),
    );
  });

  test("多个命中键全部列出且按键名排序(便于一次改干净,不用反复重启试错)", () => {
    try {
      loadConfig({
        ...PROD_ENV,
        TURNSTILE_TEST_BYPASS: "1",
        DEV_MODE: "true",
        OC_AUTH_BYPASS: "yes",
      });
      assert.fail("应当抛 ConfigError");
    } catch (err) {
      assert.ok(err instanceof ConfigError, `期望 ConfigError,实际 ${String(err)}`);
      assert.deepEqual(
        err.issues.map((i) => i.path),
        ["DEV_MODE", "OC_AUTH_BYPASS", "TURNSTILE_TEST_BYPASS"],
      );
    }
  });

  test("不回显 env 值(不泄露 secrets)", () => {
    // 说明:值只能是 1/true/yes 三种字面量之一才会触发,所以"值泄露"在结构上已不可能;
    // 这里锁的是"消息里不出现 `键=值` 形态",防止将来有人为了好排查把 value 拼进去。
    try {
      loadConfig({ ...PROD_ENV, DEV_SECRET_TOKEN: "1" });
      assert.fail("应当抛 ConfigError");
    } catch (err) {
      assert.ok(err instanceof ConfigError, `期望 ConfigError,实际 ${String(err)}`);
      assert.match(err.message, /DEV_SECRET_TOKEN/);
      assert.doesNotMatch(err.message, /DEV_SECRET_TOKEN\s*=/);
    }
  });

  test("各种真值写法都拦(1/true/yes,大小写与空白不敏感)", () => {
    for (const v of ["1", "true", "TRUE", "yes", " Yes ", "True"]) {
      assert.throws(
        () => loadConfig({ ...PROD_ENV, TURNSTILE_TEST_BYPASS: v }),
        ConfigError,
        `值 ${JSON.stringify(v)} 应被拦`,
      );
    }
  });

  test("挂着但没开启(=0/false/空)不拦 —— 历史遗留键不该阻断启动", () => {
    for (const v of ["0", "false", "no", ""]) {
      assert.doesNotThrow(
        () => loadConfig({ ...PROD_ENV, SOME_TEST_FLAG: v }),
        `值 ${JSON.stringify(v)} 不应被拦`,
      );
    }
  });

  test("【防误伤回归】生产 9 个合法 *_DISABLED 运维开关全部放行", () => {
    const env: Record<string, string> = { ...PROD_ENV };
    for (const k of LEGIT_PRODUCTION_SWITCHES) env[k] = "1";
    assert.doesNotThrow(
      () => loadConfig(env),
      "误伤 *_DISABLED 会让生产网关起不来 —— 比漏拦更严重",
    );
  });

  test("【防误伤回归】含子串但不成段的键放行(LATEST / CONTEST / MANIFEST)", () => {
    for (const k of ["OC_LATEST_RELEASE", "SOME_CONTEST_MODE", "BUILD_MANIFEST_PATH"]) {
      assert.doesNotThrow(
        () => loadConfig({ ...PROD_ENV, [k]: "1" }),
        `${k} 不该命中(TEST 不是独立段)`,
      );
    }
  });

  test("非 production 环境不拦(dev/CI 照常用全局旁路)", () => {
    for (const nodeEnv of [undefined, "development", "test"]) {
      const env: Record<string, string | undefined> = { ...VALID_ENV, TURNSTILE_TEST_BYPASS: "1" };
      if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
      assert.doesNotThrow(
        () => loadConfig(env as Record<string, string>),
        `NODE_ENV=${nodeEnv ?? "(未设)"} 不应被拦`,
      );
    }
  });

  test("扫描作用于原始 env —— schema 里没声明的键同样被拦", () => {
    // 这是整道门的关键:zod 会 strip 未声明键,只校验 schema 输出等于放过"将来别人随手加的"
    assert.throws(
      () => loadConfig({ ...PROD_ENV, OC_BRAND_NEW_BYPASS: "1" }),
      (err: unknown) =>
        err instanceof ConfigError && err.issues.some((i) => i.path === "OC_BRAND_NEW_BYPASS"),
    );
  });
});

/**
 * TURNSTILE_BYPASS_ACCOUNTS —— 取代全局旁路的账号级白名单。
 */
describe("config.TURNSTILE_ENFORCE", () => {
  test("缺省 = 强制(true)", () => {
    assert.equal(loadConfig(VALID_ENV).TURNSTILE_ENFORCE, true);
  });

  test("显式 '1' = 强制,'0' = 不强制", () => {
    assert.equal(loadConfig({ ...VALID_ENV, TURNSTILE_ENFORCE: "1" }).TURNSTILE_ENFORCE, true);
    assert.equal(loadConfig({ ...VALID_ENV, TURNSTILE_ENFORCE: "0" }).TURNSTILE_ENFORCE, false);
  });

  test("【关键】生产下 TURNSTILE_ENFORCE=0 不被危险开关扫描误拦", () => {
    // 它是显式产品配置而非测试旁路,键名不含 TEST/BYPASS/INSECURE/UNSAFE 段。
    // 若被误拦,线上就没有任何"合法关闭强制"的手段,只能退回那个被禁的 TEST_BYPASS。
    assert.doesNotThrow(() =>
      loadConfig({ ...VALID_ENV, NODE_ENV: "production", TURNSTILE_ENFORCE: "0" }),
    );
  });

  test("【关键】被认可的白名单键在生产下必须放行(键名含 _BYPASS_ 段但值非真值)", () => {
    // TURNSTILE_BYPASS_ACCOUNTS 自身匹配危险正则,靠"值非 1/true/yes"才放行。
    // 这条缺失过一次:上线前是靠人工实测才发现的,补成回归。
    assert.doesNotThrow(() =>
      loadConfig({
        ...VALID_ENV,
        NODE_ENV: "production",
        TURNSTILE_BYPASS_ACCOUNTS: "v5-canary@claudeai.chat,v5-evals@claudeai.chat",
      }),
    );
  });
});

describe("config.TURNSTILE_BYPASS_ACCOUNTS", () => {
  test("缺省 = 空表(谁也不能旁路)", () => {
    assert.deepEqual(loadConfig(VALID_ENV).TURNSTILE_BYPASS_ACCOUNTS, []);
  });

  test("逗号分隔 + trim + 小写 + 去空", () => {
    const cfg = loadConfig({
      ...VALID_ENV,
      TURNSTILE_BYPASS_ACCOUNTS: " V5-Canary@ClaudeAI.chat , ,v5-evals@claudeai.chat,,",
    });
    assert.deepEqual(cfg.TURNSTILE_BYPASS_ACCOUNTS, [
      "v5-canary@claudeai.chat",
      "v5-evals@claudeai.chat",
    ]);
  });
});
