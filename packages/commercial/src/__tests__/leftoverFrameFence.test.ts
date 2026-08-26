import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  filterMonotonicLiveFramePayloads,
  liveFrameSeq,
} from "../dispatch/leftoverFrameFence.js";

describe("leftoverFrameFence", () => {
  test("liveFrameSeq only accepts positive safe integers", () => {
    assert.equal(liveFrameSeq({ frameSeq: 3 }), 3);
    assert.equal(liveFrameSeq({ frameSeq: 0 }), null);
    assert.equal(liveFrameSeq({ frameSeq: -1 }), null);
    assert.equal(liveFrameSeq({ type: "outbound.message" }), null);
    assert.equal(liveFrameSeq(null), null);
  });

  test("drops duplicate and rollback seq, keeps later advances", () => {
    const kept = filterMonotonicLiveFramePayloads([
      { frameSeq: 1, text: "a" },
      { frameSeq: 1, text: "dup" },
      { frameSeq: 3, text: "c" },
      { frameSeq: 2, text: "late-2" },
      { frameSeq: 3, text: "rollback-3" },
      { frameSeq: 5, text: "e" },
    ]);
    assert.deepEqual(
      kept.map((row) => (row as { text: string }).text),
      ["a", "late-2", "c", "e"],
    );
  });

  test("out-of-order record_id still recovers unique seqs in order", () => {
    const kept = filterMonotonicLiveFramePayloads([
      { frameSeq: 4, n: 4 },
      { frameSeq: 1, n: 1 },
      { frameSeq: 2, n: 2 },
    ]);
    assert.deepEqual(
      kept.map((row) => (row as { n: number }).n),
      [1, 2, 4],
    );
  });

  test("unstamped legacy payloads survive after stamped frames", () => {
    const kept = filterMonotonicLiveFramePayloads([
      { type: "outbound.message", blocks: [] },
      { frameSeq: 2, n: 2 },
      { frameSeq: 2, n: "dup" },
    ]);
    assert.deepEqual(kept, [
      { frameSeq: 2, n: 2 },
      { type: "outbound.message", blocks: [] },
    ]);
  });
});
