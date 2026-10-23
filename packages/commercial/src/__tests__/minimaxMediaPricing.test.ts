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

  // OCV5-589 / D6a (user decision 2026-10-23): speech is billed pro-rata per
  // character, rounded up to the cent (min 1), instead of per started 10k-char
  // block. The old expectations (10_001 chars → 400, 1 char hd → 350) encoded
  // the block rounding that was deliberately removed.
  test("speech counts Han as 2 chars and bills pro-rata per character (min 1 cent)", () => {
    assert.equal(countMiniMaxSpeechCharacters("中文A。"), 6);
    const turbo = calculateMiniMaxSpeechCost({ model: "speech-2.8-turbo", usageCharacters: 10_001 });
    assert.equal(turbo.costCredits, 201n);
    assert.equal(calculateMiniMaxSpeechCost({ model: "speech-2.8-turbo", usageCharacters: 10_000 }).costCredits, 200n);
    const hd = calculateMiniMaxSpeechCost({ model: "speech-2.8-hd", usageCharacters: 1 });
    assert.equal(hd.costCredits, 1n);
    const line = calculateMiniMaxSpeechCost({ model: "speech-2.8-turbo", text: "清晨，北方的雪松林慢慢醒来。" });
    assert.equal(line.units.characters, 26);
    assert.equal(line.costCredits, 1n, "a one-line voiceover costs 1 cent, not a whole 200-cent block");
    assert.equal(calculateMiniMaxSpeechCost({ model: "speech-2.8-hd", usageCharacters: 300 }).costCredits, 11n);
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
