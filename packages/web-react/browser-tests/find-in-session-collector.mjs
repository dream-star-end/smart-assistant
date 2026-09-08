/** Shared find-navigation scene catalog and JSON collector (not a test file). */
export const PEAK_BUDGET = 80;

export const EXPECTED_SCENES = [
  "tail-320-m0",
  "enter-second-hit",
  "shift-enter-first-hit",
  "button-key-activate",
  "mobile-tap",
  "coalesced-after-team",
  "pending-positive-m250",
  "wheel-cancel-no-rejump",
  "scrollbar-drag-cancel",
  "touchmove-pending-positive",
  "touchmove-cancel",
  "same-session-replace-drops-pin",
  "same-session-replace-new-needle",
  "session-switch-cancels-pin",
  "close-cancels-pin",
  "sending-cancels-pin",
  "unmount-no-rejump",
  "rapid-next-prev",
  "budget-2000-peak",
  "jump-to-bottom-after-find",
];

export function record(rows, scene, expected, actual, events, pass, failReason, extra = {}) {
  const row = {
    contractId: scene,
    mode: extra.mode ?? "candidate",
    phase: extra.phase ?? (pass ? "observed" : "failed"),
    expected,
    actual: {
      key: actual?.key ?? null,
      text: actual?.text?.slice?.(0, 80) ?? "",
      visible: actual?.visible ?? false,
      findPin: actual?.findPin ?? "",
      hit: actual?.hit ?? null,
      following: actual?.following ?? false,
      wheelFence: actual?.wheelFence ?? false,
      scrollTop: actual?.scrollTop ?? -1,
      distBottom: actual?.distBottom ?? -1,
      needleMounted: actual?.needleMounted ?? false,
      mountedCount: actual?.mountedCount ?? 0,
      peakMounted: actual?.peakMounted ?? 0,
      paintCount: actual?.paintCount ?? 0,
      dockVisible: actual?.dockVisible ?? null,
      mountedLast: actual?.mountedLast ?? null,
      sessionId: actual?.sessionId ?? "",
      findOpen: actual?.findOpen ?? false,
      listMounted: actual?.listMounted ?? false,
      row: actual?.row ?? null,
      scroller: actual?.scroller ?? null,
      toolbar: actual?.toolbar ?? null,
      pageErrors: actual?.pageErrors ?? 0,
      stable: actual?.stable,
      missing: actual?.missing === true,
      error: extra.error ?? actual?.error ?? "",
    },
    events: { ...(events ?? {}) },
    peakMounted: actual?.peakMounted ?? 0,
    pass: pass === true,
    failed: pass === true ? 0 : 1,
    skip: 0,
    skips: [],
    failReason: pass === true ? "" : (failReason || "unspecified failure"),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  return row;
}

export function finalizeRows(rows, extra = {}) {
  const seen = new Set(rows.map((r) => r.contractId));
  const missingScenes = EXPECTED_SCENES.filter((scene) => !seen.has(scene));
  for (const scene of missingScenes) {
    record(rows, scene, { recorded: true }, { missing: true }, {}, false,
      `scene ${scene} missing from collector`, { mode: extra.mode, phase: "never-recorded" });
  }
  return {
    expectedScenes: [...EXPECTED_SCENES],
    recordedBeforeFill: [...seen],
    missingScenes,
    scenes: rows.length,
    passed: rows.filter((r) => r.pass).length,
    failed: rows.filter((r) => !r.pass).length,
    skipped: 0,
  };
}
