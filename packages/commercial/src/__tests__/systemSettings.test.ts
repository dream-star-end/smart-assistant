/**
 * V3 Phase 4H — system_settings 纯单元测试(不碰 DB)。
 *
 * 覆盖:
 *   - KEY_SCHEMAS:每个 key 的 zod schema 接受合法值/拒绝非法值/边界
 *   - DEFAULTS:每个 allowlist key 都有默认,且默认能被自身 schema 接受
 *   - KEY_META:与 KEY_SCHEMAS 同 key 集,字段齐全
 *   - ALLOWED_KEYS:与 Object.keys(KEY_SCHEMAS) 一致,无遗漏
 *   - SystemSettingValidationError:issues 字段聚合
 *
 * DB 路径(list/get/set 在事务/审计层面的行为)由 integ test 覆盖,这里只
 * 锁住 schema 不被悄悄放宽 / 默认值不被偷偷改坏。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  KEY_SCHEMAS,
  DEFAULTS,
  KEY_META,
  ALLOWED_KEYS,
  SystemSettingNotFoundError,
  SystemSettingValidationError,
} from "../admin/systemSettings.js";

describe("KEY_SCHEMAS allowlist", () => {
  test("ALLOWED_KEYS == Object.keys(KEY_SCHEMAS)", () => {
    assert.deepEqual([...ALLOWED_KEYS].sort(), Object.keys(KEY_SCHEMAS).sort());
  });

  test("DEFAULTS covers every allowlist key", () => {
    for (const k of ALLOWED_KEYS) assert.ok(k in DEFAULTS, `missing default: ${k}`);
  });

  test("KEY_META covers every allowlist key", () => {
    for (const k of ALLOWED_KEYS) assert.ok(k in KEY_META, `missing meta: ${k}`);
  });

  test("DEFAULTS pass their own schema", () => {
    for (const k of ALLOWED_KEYS) {
      const r = KEY_SCHEMAS[k].safeParse(DEFAULTS[k]);
      assert.ok(r.success, `default for ${k} fails own schema: ${JSON.stringify(r)}`);
    }
  });
});

describe("KEY_SCHEMAS — idle_sweep_min", () => {
  const s = KEY_SCHEMAS.idle_sweep_min;
  test("accepts 1 .. 1440", () => {
    assert.ok(s.safeParse(1).success);
    assert.ok(s.safeParse(30).success);
    assert.ok(s.safeParse(1440).success);
  });
  test("rejects 0 / negative / >1440 / fractional / non-number", () => {
    assert.equal(s.safeParse(0).success, false);
    assert.equal(s.safeParse(-1).success, false);
    assert.equal(s.safeParse(1441).success, false);
    assert.equal(s.safeParse(1.5).success, false);
    assert.equal(s.safeParse("30").success, false);
    assert.equal(s.safeParse(null).success, false);
  });
});

describe("KEY_SCHEMAS — allow_registration / maintenance_mode", () => {
  test("only true/false accepted", () => {
    for (const k of ["allow_registration", "maintenance_mode"] as const) {
      const s = KEY_SCHEMAS[k];
      assert.ok(s.safeParse(true).success);
      assert.ok(s.safeParse(false).success);
      assert.equal(s.safeParse(0).success, false);
      assert.equal(s.safeParse("true").success, false);
      assert.equal(s.safeParse(null).success, false);
    }
  });
});

describe("KEY_SCHEMAS — default_effort", () => {
  const s = KEY_SCHEMAS.default_effort;
  test("accepts low/medium/high/xhigh", () => {
    for (const v of ["low", "medium", "high", "xhigh"]) {
      assert.ok(s.safeParse(v).success);
    }
  });
  test("rejects unknown / wrong type", () => {
    assert.equal(s.safeParse("LOW").success, false);
    assert.equal(s.safeParse("ultra").success, false);
    assert.equal(s.safeParse("").success, false);
    assert.equal(s.safeParse(1).success, false);
  });
});

describe("KEY_SCHEMAS — rate_limit_chat_per_min", () => {
  const s = KEY_SCHEMAS.rate_limit_chat_per_min;
  test("accepts 1 .. 1000", () => {
    assert.ok(s.safeParse(1).success);
    assert.ok(s.safeParse(60).success);
    assert.ok(s.safeParse(1000).success);
  });
  test("rejects 0 / >1000 / fractional", () => {
    assert.equal(s.safeParse(0).success, false);
    assert.equal(s.safeParse(1001).success, false);
    assert.equal(s.safeParse(0.5).success, false);
  });
});

describe("KEY_META", () => {
  test("each entry has required fields by kind", () => {
    for (const k of ALLOWED_KEYS) {
      const m = KEY_META[k];
      assert.ok(m.description.length > 0, `meta.description empty for ${k}`);
      if (m.kind === "number") {
        assert.equal(typeof m.min, "number");
        assert.equal(typeof m.max, "number");
        assert.ok((m.max ?? 0) > (m.min ?? 0));
      } else if (m.kind === "enum") {
        assert.ok(Array.isArray(m.enumValues) && m.enumValues.length > 0);
      } else {
        assert.equal(m.kind, "boolean");
      }
    }
  });
});

describe("Errors", () => {
  test("SystemSettingNotFoundError carries name + message", () => {
    const e = new SystemSettingNotFoundError("foo");
    assert.equal(e.name, "SystemSettingNotFoundError");
    assert.match(e.message, /foo/);
  });
  test("SystemSettingValidationError exposes issues array", () => {
    const e = new SystemSettingValidationError(["a: bad", "b: bad"]);
    assert.equal(e.name, "SystemSettingValidationError");
    assert.deepEqual(e.issues, ["a: bad", "b: bad"]);
    assert.match(e.message, /a: bad; b: bad/);
  });
});
