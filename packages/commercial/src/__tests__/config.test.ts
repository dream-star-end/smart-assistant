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
});
