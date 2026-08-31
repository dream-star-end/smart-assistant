import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  classifyVisibleOrphan,
  ENGINE_DEAD_QUIET_MS,
  HARD_CAP_AGE_MS,
  PARTS_COMPLETE_QUIET_MS,
  shouldFenceProducer,
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
    firstVisibleAtMs: null as number | null,
    persistBacklogUndetermined: false,
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
    assert.equal(shouldFenceProducer("interrupt_tapeless"), true);
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
    assert.equal(shouldFenceProducer("fence_hard_cap"), true);
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
    assert.equal(shouldFenceProducer("converge_only"), false);
  });

  test("interrupt_tapeless when engine never emitted a frame even with container running", () => {
    // 2026-08-31 webmtd63p5mm747zh:引擎在存活容器内死亡,旧判据永远 skip。
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
    );
    assert.equal(shouldFenceProducer("interrupt_tapeless"), true);
  });

  test("skip live engine with first_visible but zero dispatch frames (OCV5-57 89f18ffe)", () => {
    // Persist lag: thinking/text already hit turn_traces.first_visible_at, but
    // client_session_live_streams.dispatch_id row is still missing. Killing
    // here produced "turn interrupted (visible fallback)" while cursor-agent
    // was alive on TaskOutput.
    assert.equal(
      classifyVisibleOrphan({
        ...base,
        lastFrameAtMs: null,
        firstVisibleAtMs: 1_000 + 33_000,
        nowMs: 1_000 + ENGINE_DEAD_QUIET_MS,
        containerRunning: true,
      }),
      "skip",
    );
  });

  test("skip when persist backlog makes last_frame undetermined", () => {
    assert.equal(
      classifyVisibleOrphan({
        ...base,
        lastFrameAtMs: null,
        firstVisibleAtMs: null,
        persistBacklogUndetermined: true,
        nowMs: 1_000 + ENGINE_DEAD_QUIET_MS,
        containerRunning: true,
      }),
      "skip",
    );
  });

  test("fence_hard_cap still fires at 6h even with first_visible and zero frames", () => {
    assert.equal(
      classifyVisibleOrphan({
        ...base,
        lastFrameAtMs: null,
        firstVisibleAtMs: 1_000 + 33_000,
        nowMs: 1_000 + HARD_CAP_AGE_MS,
        containerRunning: true,
      }),
      "fence_hard_cap",
    );
    assert.equal(shouldFenceProducer("fence_hard_cap"), true);
  });

  test("fence_hard_cap still fires at 6h even when persist backlog is undetermined", () => {
    assert.equal(
      classifyVisibleOrphan({
        ...base,
        lastFrameAtMs: null,
        persistBacklogUndetermined: true,
        nowMs: 1_000 + HARD_CAP_AGE_MS,
        containerRunning: true,
      }),
      "fence_hard_cap",
    );
    assert.equal(shouldFenceProducer("fence_hard_cap"), true);
  });

  test("skip when container running and engine has emitted frames recently", () => {
    assert.equal(
      classifyVisibleOrphan({
        ...base,
        tapePartCount: 3,
        tapePartsRows: 1,
        lastFrameAtMs: 500_000,
        nowMs: 500_000 + 60_000,
        containerRunning: true,
      }),
      "skip",
    );
    assert.equal(shouldFenceProducer("skip"), false);
  });

  test("skip when container running and engine once emitted frames then went quiet", () => {
    // 有过帧 = 引擎曾活着;中途静默可能只是长工具调用,保持保守不中断。
    assert.equal(
      classifyVisibleOrphan({
        ...base,
        tapePartCount: 3,
        tapePartsRows: 1,
        lastFrameAtMs: 1_000,
        nowMs: 1_000 + ENGINE_DEAD_QUIET_MS,
        containerRunning: true,
      }),
      "skip",
    );
  });
});
