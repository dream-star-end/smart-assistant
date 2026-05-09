/**
 * 0060 — admin/pricing extra_system_prompt 归一化 + 审计摘要 helper 单测。
 *
 * 不碰 DB。覆盖契约:
 *   - normalizeExtraSystemPrompt:undefined 由调用方区分(这里只测显式入参);
 *     null/""/"   "→ null;非空 trim 后存;>4096 抛 RangeError;非 string/null 抛 RangeError
 *   - summarizeExtraPrompt:null→null;非空→{len, sha256(64hex), preview(≤41 chars)}
 *   - 同一文本永远 sha256 相同,改一字 sha256 必变(防篡改对照)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  EXTRA_SYSTEM_PROMPT_MAX_LEN,
  normalizeExtraSystemPrompt,
  summarizeExtraPrompt,
} from "../admin/pricing.js";

describe("normalizeExtraSystemPrompt", () => {
  test("null → null", () => {
    assert.equal(normalizeExtraSystemPrompt(null), null);
  });

  test("空字符串 → null", () => {
    assert.equal(normalizeExtraSystemPrompt(""), null);
  });

  test("纯空白(空格 / \\n / \\t)→ null", () => {
    assert.equal(normalizeExtraSystemPrompt("   "), null);
    assert.equal(normalizeExtraSystemPrompt("\n\n  \t"), null);
  });

  test("非空字串 trim 后保留", () => {
    assert.equal(normalizeExtraSystemPrompt("  hello  "), "hello");
    assert.equal(
      normalizeExtraSystemPrompt("\n完成步骤后不要 yield\n"),
      "完成步骤后不要 yield",
    );
  });

  test("trim 后长度 ≤ 上限通过", () => {
    const max = "x".repeat(EXTRA_SYSTEM_PROMPT_MAX_LEN);
    assert.equal(normalizeExtraSystemPrompt(max), max);
  });

  test("trim 后长度超上限抛 RangeError(extra_system_prompt_too_long)", () => {
    const tooBig = "x".repeat(EXTRA_SYSTEM_PROMPT_MAX_LEN + 1);
    assert.throws(
      () => normalizeExtraSystemPrompt(tooBig),
      (err: unknown) =>
        err instanceof RangeError && err.message === "extra_system_prompt_too_long",
    );
  });

  test("非 string 非 null 抛 RangeError(invalid_extra_system_prompt)", () => {
    for (const bad of [42, true, [], {}, undefined as unknown]) {
      // undefined 在这里走 else 抛错;真实 patchPricing 在外层把 undefined 当"不改"挡掉,所以这条路径不可达。
      // 但 normalize 自身契约:非 null 非 string 一律拒绝。
      assert.throws(
        () => normalizeExtraSystemPrompt(bad),
        (err: unknown) =>
          err instanceof RangeError && err.message === "invalid_extra_system_prompt",
        `bad input: ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe("summarizeExtraPrompt", () => {
  test("null → null", () => {
    assert.equal(summarizeExtraPrompt(null), null);
  });

  test("短文本 → preview === 原文,len = 字符数,sha256 64-hex", () => {
    const r = summarizeExtraPrompt("hello");
    assert.ok(r);
    assert.equal(r!.len, 5);
    assert.equal(r!.preview, "hello");
    assert.match(r!.sha256, /^[0-9a-f]{64}$/);
  });

  test("长文本 → preview 取前 40 char + …", () => {
    const text = "A".repeat(100);
    const r = summarizeExtraPrompt(text);
    assert.ok(r);
    assert.equal(r!.len, 100);
    assert.equal(r!.preview, `${"A".repeat(40)}…`);
    assert.equal(r!.preview.length, 41); // 40 char + 1 ellipsis
  });

  test("sha256 稳定 + 改 1 字必变", () => {
    const a = summarizeExtraPrompt("完成步骤后不要 yield");
    const b = summarizeExtraPrompt("完成步骤后不要 yield");
    const c = summarizeExtraPrompt("完成步骤后不要 yield ");
    assert.ok(a && b && c);
    assert.equal(a!.sha256, b!.sha256);
    assert.notEqual(a!.sha256, c!.sha256);
  });

  test("UTF-8 中文 len 计的是 JS code unit(.length),不是字节数 — 与前端 textarea 计数对齐", () => {
    const r = summarizeExtraPrompt("中文");
    assert.ok(r);
    // "中文" 在 JS .length === 2,UTF-8 字节是 6
    assert.equal(r!.len, 2);
  });
});
