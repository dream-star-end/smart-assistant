#!/usr/bin/env tsx
/**
 * Deploy-gate contract for INC-20260831-VISIBLE-ORPHAN-FALSE-KILL (OCV5-57).
 *
 * Pins classifyVisibleOrphan on the exact staging tree: live-engine
 * first_visible + zero dispatch frames must skip the 15min tapeless
 * interrupt; OCV5-43 hydrate-dead (no frames, no first_visible, container
 * still running) must still interrupt; interrupt/hard-cap must fence.
 *
 * Follow-up (same incident, 5-audit gaps): the reconciler must carry typed-state
 * liveness into closeVisibleOrphans (provenLiveDispatchIds short-circuit before
 * classify + pre-commit re-probe for rows outside the stuck page) and must
 * re-verify frame/first_visible evidence inside the finalize FOR UPDATE lock.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// ── Follow-up: reconciler wiring contracts (static, same style as
// check-v5-session-unavailable-rootfix.ts) ─────────────────────────────────
const reconciler = readFileSync(
  join(import.meta.dirname, "..", "packages/commercial/src/dispatch/turnDispatchReconciler.ts"),
  "utf8",
);

// Gap 1a: the accepted-stuck "真在飞" verdict must flow into closeVisibleOrphans
// and short-circuit classification.
assert.match(
  reconciler,
  /provenLiveDispatchIds/,
  "closeVisibleOrphans must receive this tick's proven-live dispatch ids",
);
const provenLiveSkip = reconciler.indexOf("opts.provenLiveDispatchIds.has(row.dispatch_id)");
const classifyCall = reconciler.indexOf("const action = classifyVisibleOrphan(");
assert.ok(
  provenLiveSkip > -1 && classifyCall > -1 && provenLiveSkip < classifyCall,
  "provenLive short-circuit must run before classifyVisibleOrphan",
);

// Gap 1b: rows only the orphan scan sees (own OFFSET paging + admitted rows)
// must re-probe typed state before an interrupt_tapeless commit.
assert.match(
  reconciler,
  /action === 'interrupt_tapeless' && !opts\.probedDispatchIds\.has\(row\.dispatch_id\)/,
  "interrupt_tapeless outside the stuck page must re-probe typed state pre-commit",
);
assert.match(
  reconciler,
  /isLiveTypedState\(probe\)/,
  "the pre-commit re-probe must honor running/queued/sink_staged as live",
);

// Gap 2: evidence re-verification must live inside the FOR UPDATE lock and
// ahead of every write (fence / visible_head / terminal).
const lockAt = reconciler.indexOf("FOR UPDATE -- closeVisibleOrphans lock");
const frameReverifyAt = reconciler.indexOf("-- orphanFinalizeFrameReverify");
const firstVisibleReverifyAt = reconciler.indexOf("-- orphanFinalizeFirstVisibleReverify");
const fenceWriteAt = reconciler.indexOf("producer_fenced_at=COALESCE");
assert.ok(lockAt > -1 && frameReverifyAt > -1 && firstVisibleReverifyAt > -1 && fenceWriteAt > -1);
assert.ok(
  lockAt < frameReverifyAt && frameReverifyAt < firstVisibleReverifyAt && firstVisibleReverifyAt < fenceWriteAt,
  "frame/first_visible re-verification must run inside the lock, before any write",
);

console.log("visible-orphan-liveness: PASS");
