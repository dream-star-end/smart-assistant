import { describe, expect, it } from "vitest";
import {
  BLANK_CONFIRM_SAMPLES,
  buildSnapshot,
  classifyBlank,
  createBlankDetector,
  type BlankProbeInput,
  type RowGeometry,
} from "./timelineBlankProbe";

function row(partial: Partial<RowGeometry> & { top: number; height: number }): RowGeometry {
  return {
    key: partial.key ?? `k${partial.top}`,
    top: partial.top,
    height: partial.height,
    skipped: partial.skipped ?? false,
    live: partial.live ?? false,
    innerHeight: partial.innerHeight ?? partial.height,
    kind: partial.kind ?? "tape",
  };
}

function input(over: Partial<BlankProbeInput> = {}): BlankProbeInput {
  return {
    scroller: { scrollTop: 1000, scrollHeight: 2000, clientHeight: 700 },
    rows: [row({ top: 0, height: 300 }), row({ top: 316, height: 500 })],
    spacerTop: null,
    spacerBottom: null,
    footer: null,
    windowCount: 2,
    paintCount: 2,
    paintStart: 0,
    paintEnd: 2,
    sending: true,
    followBottom: true,
    messagesLength: 2,
    ...over,
  };
}

describe("classifyBlank", () => {
  it("is ok when painted rows cover the viewport", () => {
    expect(classifyBlank(input())).toBe("ok");
  });

  it("is ok when only the footer (turn activity) fills a short viewport tail", () => {
    // Rows end above the viewport; the footer alone covers >25% of the viewport.
    expect(classifyBlank(input({
      rows: [row({ top: -900, height: 800 })],
      footer: { top: 0, height: 200 },
    }))).toBe("ok");
  });

  it("flags rows that intersect the viewport but are content-visibility skipped", () => {
    expect(classifyBlank(input({
      rows: [row({ top: 0, height: 700, skipped: true })],
    }))).toBe("rows_skipped_in_viewport");
  });

  it("flags rows whose card rendered nothing (zero inner height)", () => {
    expect(classifyBlank(input({
      rows: [row({ top: 0, height: 16, innerHeight: 0 }), row({ top: 16, height: 16, innerHeight: 0 })],
      footer: { top: 40, height: 38 },
    }))).toBe("rows_zero_height_in_viewport");
  });

  it("flags viewport sitting inside the bottom spacer (stale paint range)", () => {
    expect(classifyBlank(input({
      rows: [row({ top: -2000, height: 300 })],
      spacerBottom: { cssHeight: 4000, top: -1600 },
    }))).toBe("viewport_in_bottom_spacer");
  });

  it("flags viewport sitting inside the top spacer", () => {
    expect(classifyBlank(input({
      rows: [row({ top: 3000, height: 300 })],
      spacerTop: { cssHeight: 13600, top: -9000 },
    }))).toBe("viewport_in_top_spacer");
  });

  it("flags viewport scrolled past all mounted content (scrollHeight lies)", () => {
    expect(classifyBlank(input({
      rows: [row({ top: -900, height: 300 })],
    }))).toBe("viewport_past_content");
  });

  it("flags an empty list that should have rows", () => {
    expect(classifyBlank(input({ rows: [], windowCount: 80 }))).toBe("no_rows_mounted");
    expect(classifyBlank(input({ rows: [], windowCount: 0 }))).toBe("ok");
  });

  it("does not flag a genuinely short session (content shorter than viewport)", () => {
    expect(classifyBlank(input({
      scroller: { scrollTop: 0, scrollHeight: 700, clientHeight: 700 },
      rows: [row({ top: 32, height: 90 }), row({ top: 138, height: 120 })],
      footer: { top: 274, height: 38 },
    }))).toBe("ok");
  });
});

describe("createBlankDetector", () => {
  it("needs consecutive blank samples before reporting, and resets on ok", () => {
    const detector = createBlankDetector({ reportCooldownMs: 60_000 });
    const blank = input({ rows: [row({ top: 0, height: 700, skipped: true })] });
    let report = null;
    for (let i = 0; i < BLANK_CONFIRM_SAMPLES - 1; i += 1) {
      report = detector.sample(blank, 1000 * (i + 1));
      expect(report).toBeNull();
    }
    expect(detector.sample(input(), 5000)).toBeNull(); // ok resets the streak
    for (let i = 0; i < BLANK_CONFIRM_SAMPLES - 1; i += 1) {
      expect(detector.sample(blank, 6000 + 1000 * i)).toBeNull();
    }
    report = detector.sample(blank, 9000);
    expect(report?.code).toBe("TIMELINE_BLANK_VIEWPORT");
    expect(report?.classification).toBe("rows_skipped_in_viewport");
    expect(detector.isConfirmed()).toBe(true);
  });

  it("reports once per cooldown while the blank persists, snapshot keeps updating", () => {
    const detector = createBlankDetector({ confirmSamples: 1, reportCooldownMs: 10_000 });
    const blank = input({ rows: [row({ top: 0, height: 700, skipped: true })] });
    expect(detector.sample(blank, 0)).not.toBeNull();
    expect(detector.sample(blank, 5000)).toBeNull();
    expect(detector.lastSnapshot()?.at).toBe(5000);
    expect(detector.sample(blank, 10_000)).not.toBeNull();
  });
});

describe("buildSnapshot", () => {
  it("captures nearby rows without any text and sums heights", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ top: -2000 + i * 300, height: 284, key: `tape:${i}` }));
    const snap = buildSnapshot(input({ rows }), "viewport_gap_unknown", 42);
    expect(snap.at).toBe(42);
    expect(snap.rowsMounted).toBe(10);
    expect(snap.rowsHeightSum).toBe(2840);
    expect(snap.nearbyRows.length).toBeGreaterThan(0);
    expect(snap.nearbyRows.length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(snap)).not.toContain("innerText");
  });
});
