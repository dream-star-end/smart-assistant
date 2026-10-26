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
  const T0 = 1_700_000_000_000;
  const GAP = 30_000;
  const setOverride = (value: string | undefined) => {
    if (value === undefined) Reflect.deleteProperty(globalThis, "__OC_TIMELINE_LIFECYCLE_V1");
    else (globalThis as { __OC_TIMELINE_LIFECYCLE_V1?: string }).__OC_TIMELINE_LIFECYCLE_V1 = value;
  };
  const setForce = (on: boolean) => {
    if (on) (globalThis as { __OC_TIMELINE_LIFECYCLE_SHADOW_FORCE?: boolean }).__OC_TIMELINE_LIFECYCLE_SHADOW_FORCE = true;
    else Reflect.deleteProperty(globalThis, "__OC_TIMELINE_LIFECYCLE_SHADOW_FORCE");
  };
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
  function serverShadowOn(): ClientFrictionSignal[] {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    setTimelineLifecycleServerShadow(true);
    setForce(true);
    return capture();
  }

  test("the server switch turns shadow on when no local override is set; a local override still wins", () => {
    expect(timelineLifecycleMode()).toBe("off");
    setTimelineLifecycleServerShadow(true);
    expect(timelineLifecycleMode()).toBe("shadow");
    setOverride("off");
    expect(timelineLifecycleMode()).toBe("off");
    setOverride("read");
    expect(timelineLifecycleMode()).toBe("read");
    setOverride(undefined);
    setTimelineLifecycleServerShadow(false);
    expect(timelineLifecycleMode()).toBe("off");
  });

  test("a server-driven mismatch sends one bounded signal with no identity or text", () => {
    const sent = serverShadowOn();
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
    const sent = serverShadowOn();
    match();
    expect(sent).toEqual([
      expect.objectContaining({ code: "TIMELINE_SHADOW_MATCH", outcome: "succeeded", path: "full", reason: "none" }),
    ]);
  });

  test("Codex r1 burst: 40 sessions in one minute post at most twice (client-errors is 30/min per IP)", () => {
    const sent = serverShadowOn();
    for (let i = 0; i < 40; i += 1) {
      vi.setSystemTime(T0 + i * 1_500);
      mismatch(`sess-${i}`);
    }
    expect(sent.length).toBeLessThanOrEqual(2);
    expect(sent.length).toBeGreaterThanOrEqual(1);
  });

  test("throttled to one per session × entry × outcome per 5 minutes, and one per 30 s per page", () => {
    const sent = serverShadowOn();
    mismatch();
    mismatch();
    match();
    expect(sent).toHaveLength(1);
    vi.setSystemTime(T0 + GAP);
    match();
    vi.setSystemTime(T0 + 2 * GAP);
    mismatch();
    mismatch("sess-b");
    vi.setSystemTime(T0 + 3 * GAP);
    mismatch("sess-b");
    expect(sent.map((s) => `${s.sessionId}|${s.path}|${s.code}`)).toEqual([
      "sess-a|live_units|TIMELINE_SHADOW_MISMATCH",
      "sess-a|full|TIMELINE_SHADOW_MATCH",
      "sess-b|live_units|TIMELINE_SHADOW_MISMATCH",
    ]);
    vi.setSystemTime(T0 + 5 * 60_000 - 1);
    mismatch();
    expect(sent).toHaveLength(3);
    vi.setSystemTime(T0 + 5 * 60_000);
    mismatch();
    expect(sent).toHaveLength(4);
  });

  test("a page never sends more than 40 reports", () => {
    const sent = serverShadowOn();
    for (let i = 0; i < 60; i += 1) {
      vi.setSystemTime(T0 + i * GAP);
      mismatch(`sess-${i}`);
    }
    expect(sent).toHaveLength(40);
  });

  test("no report for a local override, an unsampled observation, or a throwing reporter", () => {
    const sent = capture();
    setOverride("shadow");
    setForce(true);
    expect(mismatch()?.sampled).toBe(true);
    expect(sent).toHaveLength(0);

    setOverride(undefined);
    setForce(false);
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
