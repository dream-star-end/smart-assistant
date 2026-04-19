import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { shouldAutoMigrate } from "../index.js";

/**
 * T-02: COMMERCIAL_AUTO_MIGRATE 旋钮语义测试。
 *
 * 规约:
 *  - 未设 / "" / "1" → true(默认开,无 warning)
 *  - "0" → false(关,无 warning)
 *  - 其他值(e.g. "true"/"false"/"no")→ true 且打 warning
 *
 * 原因:auto migrate 是运维 toggle,写错值时继续 migrate 更安全,但必须
 * 告警避免"以为自己关掉了"的脚枪。COMMERCIAL_ENABLED 严格枚举是因为它控
 * 制 feature 是否挂载,误写必须 fail hard;这两个语义差异是故意的。
 */
describe("shouldAutoMigrate", () => {
  test("defaults to true when env var is unset", () => {
    let warned = false;
    assert.equal(shouldAutoMigrate({}, () => { warned = true; }), true);
    assert.equal(warned, false, "unset must not warn");
  });

  test("returns false only for exact '0' and does not warn", () => {
    let warned = false;
    assert.equal(
      shouldAutoMigrate({ COMMERCIAL_AUTO_MIGRATE: "0" }, () => { warned = true; }),
      false,
    );
    assert.equal(warned, false, "'0' must not warn");
  });

  test("returns true for '1' without warning", () => {
    let warned = false;
    assert.equal(
      shouldAutoMigrate({ COMMERCIAL_AUTO_MIGRATE: "1" }, () => { warned = true; }),
      true,
    );
    assert.equal(warned, false);
  });

  test("empty string treated as unset (true, no warning)", () => {
    let warned = false;
    assert.equal(
      shouldAutoMigrate({ COMMERCIAL_AUTO_MIGRATE: "" }, () => { warned = true; }),
      true,
    );
    assert.equal(warned, false);
  });

  test("unrecognized value still returns true but emits warning mentioning the raw value", () => {
    for (const v of ["true", "false", "yes", "no", "on", "enabled"]) {
      let warning = "";
      assert.equal(
        shouldAutoMigrate({ COMMERCIAL_AUTO_MIGRATE: v }, (m) => { warning = m; }),
        true,
        `value ${JSON.stringify(v)} should still enable auto-migrate`,
      );
      assert.match(warning, /not recognized/, `should warn for ${v}`);
      assert.match(warning, new RegExp(v.replace(/[^\w]/g, "")));
    }
  });

  test("uses console.warn by default when no warn callback passed", () => {
    // 劫持 console.warn 来验证默认路径确实会打 warning(而不只是不抛错)。
    // 用 mock.method 保证测试结束后自动还原,避免污染其他用例。
    const warnMock = mock.method(console, "warn", () => { /* silence */ });
    try {
      const result = shouldAutoMigrate({ COMMERCIAL_AUTO_MIGRATE: "bogus" });
      assert.equal(result, true);
      assert.equal(warnMock.mock.callCount(), 1, "default path must call console.warn once");
      const arg = warnMock.mock.calls[0]?.arguments[0];
      assert.equal(typeof arg, "string");
      assert.match(arg as string, /not recognized/);
      assert.match(arg as string, /bogus/);
    } finally {
      warnMock.mock.restore();
    }
  });
});
