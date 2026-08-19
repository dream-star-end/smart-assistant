import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  clipVisibleText,
  settlementAuthorityHash,
  VISIBLE_HEAD_TEXT_MAX_BYTES,
} from "../db/visibleFinalize.js";

describe("clipVisibleText", () => {
  test("single UTF-8 buffer cut keeps character boundary", () => {
    const text = "é".repeat(VISIBLE_HEAD_TEXT_MAX_BYTES);
    const clipped = clipVisibleText(text);
    assert.equal(clipped.truncated, true);
    assert.ok(Buffer.byteLength(clipped.text, "utf8") <= VISIBLE_HEAD_TEXT_MAX_BYTES);
    assert.doesNotMatch(clipped.text, /\uFFFD/);
  });
});

describe("settlementAuthorityHash", () => {
  test("stable for the same envelope", () => {
    const a = settlementAuthorityHash({
      billingAnchorId: "srv-s-t1",
      requestId: "r1",
      engineBillings: [{ requestId: "r1", model: "x" }],
    });
    const b = settlementAuthorityHash({
      billingAnchorId: "srv-s-t1",
      requestId: "r1",
      engineBillings: [{ requestId: "r1", model: "x" }],
    });
    const c = settlementAuthorityHash({
      billingAnchorId: "srv-s-t1",
      requestId: "r2",
      engineBillings: [{ requestId: "r1", model: "x" }],
    });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});
