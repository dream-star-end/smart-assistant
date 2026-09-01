#!/usr/bin/env tsx
/**
 * Deploy-gate contract for INC-20260831-VISIBLE-ORPHAN-FALSE-KILL (OCV5-57).
 *
 * Pins classifyVisibleOrphan on the exact staging tree: live-engine
 * first_visible + zero dispatch frames must skip the 15min tapeless
 * interrupt; OCV5-43 hydrate-dead (no frames, no first_visible, container
 * still running) must still interrupt; interrupt/hard-cap must fence.
 */
import assert from "node:assert/strict";
import {
  classifyVisibleOrphan,
  ENGINE_DEAD_QUIET_MS,
  HARD_CAP_AGE_MS,
  shouldFenceProducer,
} from "../packages/commercial/src/dispatch/visibleOrphan.js";

const base = {
  tapeVisibleAt: null as number | null,
  tapePartCount: null as number | null,
  tapePartsRows: 0,
  lastFrameAtMs: null as number | null,
  acceptedOrAdmittedAtMs: 1_000,
  containerRunning: false,
  nowMs: 1_000,
  firstVisibleAtMs: null as number | null,
  persistBacklogUndetermined: false,
};

assert.equal(
  classifyVisibleOrphan({
    ...base,
    lastFrameAtMs: null,
    firstVisibleAtMs: 1_000 + 33_000,
    nowMs: 1_000 + ENGINE_DEAD_QUIET_MS,
    containerRunning: true,
  }),
  "skip",
  "OCV5-57: first_visible + zero dispatch frames must skip interrupt_tapeless",
);

assert.equal(
  classifyVisibleOrphan({
    ...base,
    tapePartCount: 3,
    tapePartsRows: 1,
    lastFrameAtMs: null,
    firstVisibleAtMs: null,
    nowMs: 1_000 + ENGINE_DEAD_QUIET_MS,
    containerRunning: true,
  }),
  "interrupt_tapeless",
  "OCV5-43: hydrate-dead engine with no first_visible still interrupts at 15min",
);
assert.equal(shouldFenceProducer("interrupt_tapeless"), true);

assert.equal(
  classifyVisibleOrphan({
    ...base,
    lastFrameAtMs: null,
    firstVisibleAtMs: 1_000 + 33_000,
    nowMs: 1_000 + HARD_CAP_AGE_MS,
    containerRunning: true,
  }),
  "fence_hard_cap",
  "6h fence_hard_cap still fires with first_visible and zero frames",
);
assert.equal(shouldFenceProducer("fence_hard_cap"), true);

console.log("visible-orphan-liveness: PASS");
