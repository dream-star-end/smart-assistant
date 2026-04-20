/**
 * V3 Phase 2 Task 2G — preferences zod schema 单测(无 DB)。
 *
 * 跑法: npx tsx --test src/__tests__/preferences.test.ts
 *
 * DB 行为(upsert / partial merge / null=delete)由 preferences.integ.test.ts 覆盖。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  PreferencesSchema,
  PreferencesPatchSchema,
} from "../user/preferences.js";

describe("PreferencesSchema (full)", () => {
  test("空对象合法", () => {
    const r = PreferencesSchema.safeParse({});
    assert.equal(r.success, true);
  });

  test("接受全部已知字段的合法值", () => {
    const r = PreferencesSchema.safeParse({
      theme: "dark",
      default_model: "claude-opus-4-7",
      default_effort: "high",
      notify_email: true,
      notify_telegram: false,
      hotkeys: { send: "Ctrl+Enter" },
    });
    assert.equal(r.success, true);
  });

  test("拒绝未知字段(strict)", () => {
    const r = PreferencesSchema.safeParse({ random_field: "x" });
    assert.equal(r.success, false);
  });

  test("theme 越界值 → 拒绝", () => {
    const r = PreferencesSchema.safeParse({ theme: "neon" });
    assert.equal(r.success, false);
  });

  test("default_effort 必须在枚举内", () => {
    const ok = PreferencesSchema.safeParse({ default_effort: "xhigh" });
    const bad = PreferencesSchema.safeParse({ default_effort: "ultra" });
    assert.equal(ok.success, true);
    assert.equal(bad.success, false);
  });

  test("default_model 长度限制 1..64", () => {
    const ok = PreferencesSchema.safeParse({ default_model: "a" });
    const longOk = PreferencesSchema.safeParse({ default_model: "x".repeat(64) });
    const tooLong = PreferencesSchema.safeParse({ default_model: "x".repeat(65) });
    const empty = PreferencesSchema.safeParse({ default_model: "" });
    assert.equal(ok.success, true);
    assert.equal(longOk.success, true);
    assert.equal(tooLong.success, false);
    assert.equal(empty.success, false);
  });

  test("hotkeys 上限 32 条", () => {
    const map: Record<string, string> = {};
    for (let i = 0; i < 32; i++) map[`k${i}`] = `v${i}`;
    const ok = PreferencesSchema.safeParse({ hotkeys: map });
    map.k32 = "v32";
    const bad = PreferencesSchema.safeParse({ hotkeys: map });
    assert.equal(ok.success, true);
    assert.equal(bad.success, false);
  });

  test("hotkeys key/value 长度限制", () => {
    const longKey = { hotkeys: { ["x".repeat(65)]: "ok" } };
    const longVal = { hotkeys: { send: "x".repeat(65) } };
    assert.equal(PreferencesSchema.safeParse(longKey).success, false);
    assert.equal(PreferencesSchema.safeParse(longVal).success, false);
  });
});

describe("PreferencesPatchSchema", () => {
  test("空 patch 合法(no-op)", () => {
    assert.equal(PreferencesPatchSchema.safeParse({}).success, true);
  });

  test("null 字段 = 删除标记,合法", () => {
    const r = PreferencesPatchSchema.safeParse({
      theme: null,
      default_model: null,
      hotkeys: null,
    });
    assert.equal(r.success, true);
  });

  test("混合 set + unset 合法", () => {
    const r = PreferencesPatchSchema.safeParse({
      theme: "auto",
      default_model: null,
      notify_email: true,
    });
    assert.equal(r.success, true);
  });

  test("拒绝未知字段(strict)", () => {
    const r = PreferencesPatchSchema.safeParse({ theme: "dark", foo: 1 });
    assert.equal(r.success, false);
  });

  test("非法 enum 值不变,拒绝", () => {
    const r = PreferencesPatchSchema.safeParse({ theme: "neon" });
    assert.equal(r.success, false);
  });
});
