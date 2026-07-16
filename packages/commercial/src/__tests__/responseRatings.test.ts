import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { normalizeResponseRatingReason } from "../http/responseRatings.js";

describe("response rating reason normalization", () => {
  test("down rating without a reason receives an explicit stable placeholder", () => {
    assert.deepEqual(normalizeResponseRatingReason("down", [], "  "), {
      tags: ["未说明原因"], comment: null,
    });
  });

  test("provided reason is preserved without adding the placeholder", () => {
    assert.deepEqual(normalizeResponseRatingReason("down", ["回答不准确", "回答不准确"], "详情"), {
      tags: ["回答不准确"], comment: "详情",
    });
    assert.deepEqual(normalizeResponseRatingReason("up", [], null), { tags: [], comment: null });
  });
});

// ─── 隐式评分(方案 b)语义 ──────────────────────────────────────────────

import { IMPLICIT_RATING_TAG, isImplicitRating } from "../responseRatings.js";

describe("implicit rating semantics", () => {
  test("isImplicitRating 按机器标记 tag 判定", () => {
    assert.equal(isImplicitRating(["implicit", "中途打断"]), true);
    assert.equal(isImplicitRating(["不准确"]), false);
    assert.equal(isImplicitRating([]), false);
    assert.equal(IMPLICIT_RATING_TAG, "implicit");
  });

  test("implicit down 带原因 tag 时不追加'未说明原因'占位", () => {
    assert.deepEqual(normalizeResponseRatingReason("down", ["implicit", "中途打断"], null), {
      tags: ["implicit", "中途打断"], comment: null,
    });
  });
});
