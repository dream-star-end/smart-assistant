import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  calculateMiniMaxImageCost,
  calculateMiniMaxLyricsCost,
  calculateMiniMaxMusicCost,
  calculateMiniMaxSpeechCost,
  calculateMiniMaxVideoCost,
  countMiniMaxSpeechCharacters,
} from "../minimax/mediaPricing.js";

describe("MiniMax media pricing", () => {
  test("image-01 rounds ¥0.025/image up to whole cents", () => {
    const r = calculateMiniMaxImageCost({ imageCount: 2, capturedAt: new Date("2026-06-02T00:00:00Z") });
    assert.equal(r.costCredits, 6n);
    assert.equal(r.snapshot.unit_price_cents, "3");
  });

  test("speech counts Han as 2 chars and bills per started 10k chars", () => {
    assert.equal(countMiniMaxSpeechCharacters("中文A。"), 6);
    const turbo = calculateMiniMaxSpeechCost({ model: "speech-2.8-turbo", usageCharacters: 10_001 });
    assert.equal(turbo.costCredits, 400n);
    const hd = calculateMiniMaxSpeechCost({ model: "speech-2.8-hd", usageCharacters: 1 });
    assert.equal(hd.costCredits, 350n);
  });

  test("video current tiers are exact RMB cents", () => {
    assert.equal(
      calculateMiniMaxVideoCost({ model: "MiniMax-Hailuo-2.3", resolution: "1080P", duration: 6 }).costCredits,
      350n,
    );
    assert.equal(
      calculateMiniMaxVideoCost({ model: "MiniMax-Hailuo-2.3-Fast", mode: "image", resolution: "768P", duration: 10 }).costCredits,
      225n,
    );
  });

  test("music and lyrics use original prices, not temporary free promotion", () => {
    assert.equal(calculateMiniMaxMusicCost().costCredits, 100n);
    assert.equal(calculateMiniMaxLyricsCost().costCredits, 5n);
  });

  test("unsupported video tier fails closed", () => {
    assert.throws(() => calculateMiniMaxVideoCost({ model: "MiniMax-Hailuo-2.3-Fast", mode: "text", resolution: "768P", duration: 6 }));
    assert.throws(() => calculateMiniMaxVideoCost({ model: "MiniMax-Hailuo-2.3", resolution: "512P", duration: 6 }));
  });
});
