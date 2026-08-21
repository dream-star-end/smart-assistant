import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  classifyVisibleOrphan,
  ENGINE_DEAD_QUIET_MS,
  HARD_CAP_AGE_MS,
  PARTS_COMPLETE_QUIET_MS,
} from "../dispatch/visibleOrphan.js";

describe("classifyVisibleOrphan (rev2 B4)", () => {
  const base = {
    tapeVisibleAt: null as number | null,
    tapePartCount: null as number | null,
    tapePartsRows: 0,
    lastFrameAtMs: null as number | null,
    acceptedOrAdmittedAtMs: 1_000,
    containerRunning: false,
    nowMs: 1_000,
  };

  test("complete_from_frames after parts-complete quiet", () => {
    assert.equal(
      classifyVisibleOrphan({
        ...base,
        tapePartCount: 12,
        tapePartsRows: 12,
        lastFrameAtMs: 1_000,
        nowMs: 1_000 + PARTS_COMPLETE_QUIET_MS,
      }),
      "complete_from_frames",
    );
  });

  test("interrupt_tapeless when engine is quiet and container is not running", () => {
    assert.equal(
      classifyVisibleOrphan({
        ...base,
        tapePartCount: 3,
        tapePartsRows: 1,
        lastFrameAtMs: 1_000,
        nowMs: 1_000 + ENGINE_DEAD_QUIET_MS,
        containerRunning: false,
      }),
      "interrupt_tapeless",
    );
  });

  test("fence_hard_cap at 6h with 15min quiet", () => {
    assert.equal(
      classifyVisibleOrphan({
        ...base,
        acceptedOrAdmittedAtMs: 1_000,
        lastFrameAtMs: 1_000 + HARD_CAP_AGE_MS - ENGINE_DEAD_QUIET_MS,
        nowMs: 1_000 + HARD_CAP_AGE_MS,
        containerRunning: true,
      }),
      "fence_hard_cap",
    );
  });

  test("already visible converges only", () => {
    assert.equal(
      classifyVisibleOrphan({
        ...base,
        tapeVisibleAt: 5_000,
        nowMs: 1_000 + HARD_CAP_AGE_MS,
      }),
      "converge_only",
    );
  });
});
