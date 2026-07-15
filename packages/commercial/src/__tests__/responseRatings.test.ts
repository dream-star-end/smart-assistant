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
