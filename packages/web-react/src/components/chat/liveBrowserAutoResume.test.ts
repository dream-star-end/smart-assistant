import type { LiveBrowserHandoffReadyMessage } from "@openclaude/protocol/browser";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AUTO_RESUME_SAFE_CONTINUE_MESSAGE,
  type AutoResumeBindingContext,
  LiveBrowserAutoResumeController,
  formatAutoResumeUiFilename,
} from "./liveBrowserAutoResume";

function readyEvt(overrides: Partial<LiveBrowserHandoffReadyMessage> = {}): LiveBrowserHandoffReadyMessage {
  return {
    type: "handoff_ready",
    signal: "login_completed",
    url: "https://github.com/org/repo?token=secret123#frag",
    title: "org/repo",
    detectedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-23T08:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("B2 trust boundary & UI-only filename helper", () => {
  test("exports fixed trusted continuation prompt and sanitizes filename strictly for UI display", () => {
    expect(AUTO_RESUME_SAFE_CONTINUE_MESSAGE).toBe("我已完成浏览器接管操作，请继续处理。");
    expect(formatAutoResumeUiFilename('../../dir/paper"<script>.pdf')).toBe("paperscript.pdf");
    expect(formatAutoResumeUiFilename("  ")).toBeNull();
    expect(formatAutoResumeUiFilename(undefined)).toBeNull();
  });
});

describe("LiveBrowserAutoResumeController", () => {
  test("enforces 2s idle guard then 3s countdown before triggering automatic handback", () => {
    const handbacks: LiveBrowserHandoffReadyMessage[] = [];
    const phases: string[] = [];
    const ctrl = new LiveBrowserAutoResumeController({
      onChange: (snap) => phases.push(`${snap.phase}:${snap.remainingSec}`),
      onAutoHandBack: (evt) => handbacks.push(evt),
    });

    ctrl.onTakeoverEntered();
    // User clicked at t=0, handoff_ready arrives at t=500ms -> must wait remaining 1500ms!
    vi.advanceTimersByTime(500);
    ctrl.onHandoffReady(readyEvt());
    expect(ctrl.getSnapshot().phase).toBe("waiting_idle");
    expect(handbacks).toHaveLength(0);

    // At t=1900ms (only 1.9s idle) -> still waiting_idle
    vi.advanceTimersByTime(1_400);
    expect(ctrl.getSnapshot().phase).toBe("waiting_idle");

    // At t=2000ms (2.0s idle reached) -> enters 3s countdown!
    vi.advanceTimersByTime(100);
    expect(ctrl.getSnapshot().phase).toBe("countdown");
    expect(ctrl.getSnapshot().remainingSec).toBe(3);

    // After 2s of countdown -> still 1s remaining, not fired yet
    vi.advanceTimersByTime(2_000);
    expect(ctrl.getSnapshot().phase).toBe("countdown");
    expect(ctrl.getSnapshot().remainingSec).toBe(1);
    expect(handbacks).toHaveLength(0);

    // At 3s countdown expiry -> automatically fires handback!
    vi.advanceTimersByTime(1_050);
    expect(handbacks).toHaveLength(1);
    expect(ctrl.getSnapshot().phase).toBe("idle");
    expect(phases.some((p) => p.startsWith("countdown:"))).toBe(true);
    ctrl.dispose();
  });

  test("cancels countdown immediately on pointer/keyboard activity or '再等等' and supports '立即继续'", () => {
    const handbacks: LiveBrowserHandoffReadyMessage[] = [];
    const ctrl = new LiveBrowserAutoResumeController({
      onAutoHandBack: (evt) => handbacks.push(evt),
    });

    ctrl.onTakeoverEntered();
    vi.advanceTimersByTime(2_500); // already idle > 2s
    const evt1 = readyEvt({ url: "https://app.example.com/a" });
    ctrl.onHandoffReady(evt1);
    expect(ctrl.getSnapshot().phase).toBe("countdown");

    // Mouse/key activity during countdown -> cancels immediately!
    vi.advanceTimersByTime(1_000);
    ctrl.recordUserActivity();
    expect(ctrl.getSnapshot().phase).toBe("idle");
    vi.advanceTimersByTime(5_000);
    expect(handbacks).toHaveLength(0);

    // Re-emitting same dismissed event does not re-pop
    ctrl.onHandoffReady(evt1);
    expect(ctrl.getSnapshot().phase).toBe("idle");

    // New event arrives -> user clicks "再等等" -> cancels!
    const evt2 = readyEvt({ url: "https://app.example.com/b" });
    vi.advanceTimersByTime(2_500);
    ctrl.onHandoffReady(evt2);
    expect(ctrl.getSnapshot().phase).toBe("countdown");
    ctrl.cancelByUser();
    expect(ctrl.getSnapshot().phase).toBe("idle");
    vi.advanceTimersByTime(5_000);
    expect(handbacks).toHaveLength(0);

    // New event arrives -> user clicks "立即继续" -> fires immediately!
    const evt3 = readyEvt({ url: "https://app.example.com/c" });
    vi.advanceTimersByTime(2_500);
    ctrl.onHandoffReady(evt3);
    expect(ctrl.getSnapshot().phase).toBe("countdown");
    ctrl.triggerNow(false);
    expect(handbacks).toHaveLength(1);
    expect(handbacks[0]?.url).toBe("https://app.example.com/c");
    ctrl.dispose();
  });

  test("pauses while user is typing and trips circuit breaker after 2 rapid (<15s) auto-handback loops", () => {
    const handbacks: LiveBrowserHandoffReadyMessage[] = [];
    const ctrl = new LiveBrowserAutoResumeController({
      onAutoHandBack: (evt) => handbacks.push(evt),
    });

    // Typing guard: while typing, never enters countdown
    ctrl.onTakeoverEntered();
    ctrl.setTyping(true);
    vi.advanceTimersByTime(5_000);
    ctrl.onHandoffReady(readyEvt({ url: "https://app.example.com/step1" }));
    expect(ctrl.getSnapshot().phase).toBe("waiting_idle");
    vi.advanceTimersByTime(5_000);
    expect(handbacks).toHaveLength(0);

    // Stops typing -> 2s idle + 3s countdown -> auto-handback #1!
    ctrl.setTyping(false);
    vi.advanceTimersByTime(2_000);
    expect(ctrl.getSnapshot().phase).toBe("countdown");
    vi.advanceTimersByTime(3_100);
    expect(handbacks).toHaveLength(1);
    ctrl.onTakeoverExited();

    // Loop #1: new takeover within 15s (5s later) -> rapid count = 1 (not tripped yet)
    vi.advanceTimersByTime(5_000);
    ctrl.onTakeoverEntered();
    expect(ctrl.getSnapshot().circuitOpen).toBe(false);
    vi.advanceTimersByTime(2_000);
    ctrl.onHandoffReady(readyEvt({ url: "https://app.example.com/step2" }));
    expect(ctrl.getSnapshot().phase).toBe("countdown");
    vi.advanceTimersByTime(3_100);
    expect(handbacks).toHaveLength(2);
    ctrl.onTakeoverExited();

    // Loop #2: new takeover within 15s (4s later) -> rapid count = 2 -> CIRCUIT BREAKER OPEN!
    vi.advanceTimersByTime(4_000);
    ctrl.onTakeoverEntered();
    expect(ctrl.getSnapshot().circuitOpen).toBe(true);
    vi.advanceTimersByTime(3_000);
    ctrl.onHandoffReady(readyEvt({ url: "https://app.example.com/step3" }));
    expect(ctrl.getSnapshot().phase).toBe("circuit_open");
    // Even after 10s, MUST NOT auto-handback! Strictly manual!
    vi.advanceTimersByTime(10_000);
    expect(handbacks).toHaveLength(2);

    // Session reset clears circuit breaker
    ctrl.resetSession();
    expect(ctrl.getSnapshot().circuitOpen).toBe(false);
    ctrl.dispose();
  });

  test("cleans up all timers on exit/dispose with zero leaks", () => {
    const handbacks: LiveBrowserHandoffReadyMessage[] = [];
    const ctrl = new LiveBrowserAutoResumeController({
      onAutoHandBack: (evt) => handbacks.push(evt),
    });

    ctrl.onTakeoverEntered();
    vi.advanceTimersByTime(2_500);
    ctrl.onHandoffReady(readyEvt());
    expect(ctrl.getSnapshot().phase).toBe("countdown");

    // Exit takeover mid-countdown -> zero callbacks after advancing time
    ctrl.onTakeoverExited();
    vi.advanceTimersByTime(10_000);
    expect(handbacks).toHaveLength(0);

    // Dispose mid-countdown -> zero callbacks after advancing time
    ctrl.onTakeoverEntered();
    vi.advanceTimersByTime(2_500);
    ctrl.onHandoffReady(readyEvt({ url: "https://app.example.com/d" }));
    ctrl.dispose();
    vi.advanceTimersByTime(10_000);
    expect(handbacks).toHaveLength(0);
  });

  test("B3 & B4: cancels countdown on handoff_vetoed, invalidatePending, and handoff context switch", () => {
    const handbacks: Array<{ evt: LiveBrowserHandoffReadyMessage; ctx: AutoResumeBindingContext }> = [];
    const ctrl = new LiveBrowserAutoResumeController({
      onAutoHandBack: (evt, ctx) => handbacks.push({ evt, ctx }),
    });

    ctrl.onTakeoverEntered(null, { handoffNonce: 10, handoffId: "hid-A" });
    vi.advanceTimersByTime(2_500);
    const evt = readyEvt({ url: "https://app.example.com/dashboard" });
    ctrl.onHandoffReady(evt);
    expect(ctrl.getSnapshot().phase).toBe("countdown");

    // B3: server veto immediately cancels countdown and allows re-triggering on same URL later
    ctrl.onHandoffVetoed();
    expect(ctrl.getSnapshot().phase).toBe("idle");
    vi.advanceTimersByTime(5_000);
    expect(handbacks).toHaveLength(0);

    ctrl.onHandoffReady(evt);
    expect(ctrl.getSnapshot().phase).toBe("countdown");

    // B4: WS disconnect / CDP unavailable invalidates pending countdown without exiting takeover
    ctrl.invalidatePending();
    expect(ctrl.getSnapshot().phase).toBe("idle");
    vi.advanceTimersByTime(5_000);
    expect(handbacks).toHaveLength(0);

    // B4: switching from Card A to Card B cancels Card A countdown and binds Card B context
    ctrl.onHandoffReady(evt);
    expect(ctrl.getSnapshot().phase).toBe("countdown");
    ctrl.onHandoffContextChanged({ urlMatch: ["/final"] }, { handoffNonce: 20, handoffId: "hid-B" });
    expect(ctrl.getSnapshot().phase).toBe("idle");
    vi.advanceTimersByTime(5_000);
    expect(handbacks).toHaveLength(0);

    // Late in-flight Card A ready (mismatched or missing watchId) is ignored under Card B
    ctrl.onHandoffReady(readyEvt({ url: "https://app.example.com/old", watchId: "handoff-10" }));
    ctrl.onHandoffReady(readyEvt({ url: "https://app.example.com/old" }));
    expect(ctrl.getSnapshot().phase).toBe("idle");
    vi.advanceTimersByTime(4_000);
    expect(handbacks).toHaveLength(0);

    // Subsequent genuine ready under Card B (matching watchId) delivers Card B binding context
    ctrl.onHandoffReady(readyEvt({ url: "https://app.example.com/final", watchId: "handoff-20" }));
    vi.advanceTimersByTime(3_200);
    expect(handbacks).toHaveLength(1);
    expect(handbacks[0]!.ctx).toEqual({ handoffNonce: 20, handoffId: "hid-B" });
    ctrl.dispose();
  });
});
