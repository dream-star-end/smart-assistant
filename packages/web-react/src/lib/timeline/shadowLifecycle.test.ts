import { afterEach, describe, expect, test, vi } from "vitest";
import { EPOCH_BAND, packEpoch, timelineIdentity } from "@openclaude/protocol/browser";
import type { ClientFrictionSignal } from "../clientFriction";
import type { ChatMessage } from "../chat/model";
import {
  observeTimelineShadow,
  resetShadowStatsForTests,
  setShadowReporterForTests,
  setTimelineLifecycleServerShadow,
  timelineLifecycleMode,
} from "./shadowLifecycle";

const OWNER = "cm-shadow";

function stamped(
  partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">,
  lifecycle: ChatMessage["_lifecycle"],
  processKey: string,
): ChatMessage {
  return {
    text: "",
    ts: 1,
    _clientMessageId: OWNER,
    _lifecycle: lifecycle,
    _lifecycleEpoch: packEpoch(EPOCH_BAND.LIVE, 0, 1, 0),
    _timelineProcessKey: processKey,
    _timelineIdentity: timelineIdentity(OWNER, partial.role, processKey),
    ...partial,
  };
}

afterEach(() => {
  delete (globalThis as { __OC_TIMELINE_LIFECYCLE_V1?: string }).__OC_TIMELINE_LIFECYCLE_V1;
  delete (globalThis as { __OC_TIMELINE_LIFECYCLE_SHADOW_FORCE?: boolean }).__OC_TIMELINE_LIFECYCLE_SHADOW_FORCE;
  resetShadowStatsForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("server switch and content-free report (OCV5-630)", () => {
  const live = () => stamped({ id: "live", role: "agent-group", text: "SECRET_RICH_TEXT" }, "live_closed", "run-1");
  const stub = () =>
    stamped({ id: "stub", role: "agent-group", text: "", _payloadDeferred: true }, "exact_deferred", "run-1");
  const mismatch = (sessionId = "sess-a", entry: "full" | "live-units" = "live-units") =>
    observeTimelineShadow({ entry, sessionId, input: [live(), stub()], oldOutput: [stub()], oldMs: 1.2 });
  const match = (sessionId = "sess-a") => {
    const row = stamped({ id: "l", role: "thinking", text: "x" }, "live_open", "k");
    return observeTimelineShadow({ entry: "full", sessionId, input: [row], oldOutput: [row] });
  };
  function capture(): ClientFrictionSignal[] {
    const sent: ClientFrictionSignal[] = [];
    setShadowReporterForTests((signal) => sent.push(signal));
    return sent;
  }

  test("the server switch turns shadow on when no local override is set; a local override still wins", () => {
    expect(timelineLifecycleMode()).toBe("off");
    setTimelineLifecycleServerShadow(true);
    expect(timelineLifecycleMode()).toBe("shadow");
    (globalThis as { __OC_TIMELINE_LIFECYCLE_V1?: string }).__OC_TIMELINE_LIFECYCLE_V1 = "off";
    expect(timelineLifecycleMode()).toBe("off");
    (globalThis as { __OC_TIMELINE_LIFECYCLE_V1?: string }).__OC_TIMELINE_LIFECYCLE_V1 = "read";
    expect(timelineLifecycleMode()).toBe("read");
    delete (globalThis as { __OC_TIMELINE_LIFECYCLE_V1?: string }).__OC_TIMELINE_LIFECYCLE_V1;
    setTimelineLifecycleServerShadow(false);
    expect(timelineLifecycleMode()).toBe("off");
  });

  test("a server-driven mismatch sends one bounded signal with no identity or text", () => {
    const sent = capture();
    setTimelineLifecycleServerShadow(true);
    (globalThis as { __OC_TIMELINE_LIFECYCLE_SHADOW_FORCE?: boolean }).__OC_TIMELINE_LIFECYCLE_SHADOW_FORCE = true;
    const obs = mismatch();
    expect(obs?.mismatchCount).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
    const signal = sent[0] as ClientFrictionSignal;
    expect(signal).toMatchObject({
      surface: "chat",
      stage: "timeline_shadow",
      code: "TIMELINE_SHADOW_MISMATCH",
      outcome: "failed",
      path: "live_units",
      sessionId: "sess-a",
    });
    expect(signal.reason).toMatch(/^old\d+_new\d+_diff\d+$/);
    expect(signal.reason?.length).toBeLessThanOrEqual(48);
    expect(Number.isInteger(signal.latencyMs)).toBe(true);
    const wire = JSON.stringify(signal);
    expect(wire).not.toContain("SECRET_RICH_TEXT");
    expect(wire).not.toContain("agent-group");
    expect(wire).not.toContain("run-1");
  });

  test("a clean comparison reports MATCH / succeeded so mismatches have a denominator", () => {
    const sent = capture();
    setTimelineLifecycleServerShadow(true);
    match();
    expect(sent).toEqual([
      expect.objectContaining({ code: "TIMELINE_SHADOW_MATCH", outcome: "succeeded", path: "full", reason: "none" }),
    ]);
  });

  test("throttled per session × entry × outcome for 5 minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const sent = capture();
    setTimelineLifecycleServerShadow(true);
    (globalThis as { __OC_TIMELINE_LIFECYCLE_SHADOW_FORCE?: boolean }).__OC_TIMELINE_LIFECYCLE_SHADOW_FORCE = true;
    mismatch();
    mismatch();
    match();
    mismatch("sess-b");
    mismatch("sess-a", "full");
    expect(sent.map((s) => `${s.sessionId}|${s.path}|${s.code}`)).toEqual([
      "sess-a|live_units|TIMELINE_SHADOW_MISMATCH",
      "sess-a|full|TIMELINE_SHADOW_MATCH",
      "sess-b|live_units|TIMELINE_SHADOW_MISMATCH",
      "sess-a|full|TIMELINE_SHADOW_MISMATCH",
    ]);
    vi.setSystemTime(1_700_000_000_000 + 5 * 60_000 - 1);
    mismatch();
    expect(sent).toHaveLength(4);
    vi.setSystemTime(1_700_000_000_000 + 5 * 60_000);
    mismatch();
    expect(sent).toHaveLength(5);
  });

  test("a page never sends more than 40 reports", () => {
    const sent = capture();
    setTimelineLifecycleServerShadow(true);
    (globalThis as { __OC_TIMELINE_LIFECYCLE_SHADOW_FORCE?: boolean }).__OC_TIMELINE_LIFECYCLE_SHADOW_FORCE = true;
    for (let i = 0; i < 60; i += 1) mismatch(`sess-${i}`);
    expect(sent).toHaveLength(40);
  });

  test("no report for a local override, an unsampled observation, or a throwing reporter", () => {
    const sent = capture();
    (globalThis as { __OC_TIMELINE_LIFECYCLE_V1?: string }).__OC_TIMELINE_LIFECYCLE_V1 = "shadow";
    (globalThis as { __OC_TIMELINE_LIFECYCLE_SHADOW_FORCE?: boolean }).__OC_TIMELINE_LIFECYCLE_SHADOW_FORCE = true;
    expect(mismatch()?.sampled).toBe(true);
    expect(sent).toHaveLength(0);

    delete (globalThis as { __OC_TIMELINE_LIFECYCLE_V1?: string }).__OC_TIMELINE_LIFECYCLE_V1;
    delete (globalThis as { __OC_TIMELINE_LIFECYCLE_SHADOW_FORCE?: boolean }).__OC_TIMELINE_LIFECYCLE_SHADOW_FORCE;
    setTimelineLifecycleServerShadow(true);
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    expect(mismatch("sess-unsampled")?.sampled).toBe(false);
    expect(sent).toHaveLength(0);

    setShadowReporterForTests(() => {
      throw new Error("network down");
    });
    expect(() => match("sess-throw")).not.toThrow();
  });
});

describe("shadow observer", () => {
  test("default mode is off and is a no-op", () => {
    expect(timelineLifecycleMode()).toBe("off");
    const live = stamped({ id: "l", role: "thinking", text: "x" }, "live_open", "k");
    expect(observeTimelineShadow({ entry: "full", input: [live], oldOutput: [live] })).toBeNull();
  });

  test("shadow mode reports zero mismatch when outputs match", () => {
    (globalThis as { __OC_TIMELINE_LIFECYCLE_V1?: string }).__OC_TIMELINE_LIFECYCLE_V1 = "shadow";
    (globalThis as { __OC_TIMELINE_LIFECYCLE_SHADOW_FORCE?: boolean }).__OC_TIMELINE_LIFECYCLE_SHADOW_FORCE = true;
    const live = stamped({ id: "l", role: "thinking", text: "x" }, "live_open", "k");
    const obs = observeTimelineShadow({ entry: "full", input: [live], oldOutput: [live], oldMs: 0.4 });
    expect(obs?.mismatchCount).toBe(0);
    expect(obs?.sampled).toBe(true);
    expect((obs?.totalMs ?? 0) >= (obs?.oldMs ?? 0)).toBe(true);
  });

  test("shadow mode counts a dual-slot vs old-single mismatch", () => {
    (globalThis as { __OC_TIMELINE_LIFECYCLE_V1?: string }).__OC_TIMELINE_LIFECYCLE_V1 = "shadow";
    (globalThis as { __OC_TIMELINE_LIFECYCLE_SHADOW_FORCE?: boolean }).__OC_TIMELINE_LIFECYCLE_SHADOW_FORCE = true;
    const live = stamped({ id: "live", role: "agent-group", text: "rich" }, "live_closed", "run-1");
    const stub = stamped(
      { id: "stub", role: "agent-group", text: "", _payloadDeferred: true },
      "exact_deferred",
      "run-1",
    );
    const obs = observeTimelineShadow({
      entry: "live-units",
      input: [live, stub],
      oldOutput: [stub],
    });
    expect(obs?.mismatchCount).toBeGreaterThan(0);
    expect(obs?.mismatches.some((row) =>
      row.identity.includes("agent-group") && (row.oldText !== row.newText || row.oldKeep !== row.newKeep),
    )).toBe(true);
  });

  test("full text after the first 240 chars still counts as a mismatch", () => {
    (globalThis as { __OC_TIMELINE_LIFECYCLE_V1?: string }).__OC_TIMELINE_LIFECYCLE_V1 = "shadow";
    (globalThis as { __OC_TIMELINE_LIFECYCLE_SHADOW_FORCE?: boolean }).__OC_TIMELINE_LIFECYCLE_SHADOW_FORCE = true;
    const prefix = "a".repeat(240);
    const oldRow = stamped({ id: "th", role: "thinking", text: `${prefix}OLD` }, "live_open", "k");
    const newRow = stamped({ id: "th", role: "thinking", text: `${prefix}NEW` }, "live_open", "k");
    const obs = observeTimelineShadow({
      entry: "full",
      input: [newRow],
      oldOutput: [oldRow],
    });
    expect(obs?.mismatchCount).toBeGreaterThan(0);
  });
});
