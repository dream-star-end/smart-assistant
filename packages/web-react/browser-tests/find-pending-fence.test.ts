// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createStickToBottomController } from "../src/components/chat/stickToBottom";
import { attachWheelFence } from "../src/components/chat/wheelFence";
import { createFindPendingFence } from "./find-pending-fence";

describe("find fixture pending fence ownership", () => {
  const cleanups: Array<() => void> = [];
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.useRealTimers();
  });

  function fixture() {
    const stick = createStickToBottomController();
    const fence = createFindPendingFence(stick);
    const el = document.createElement("div");
    const detach = attachWheelFence(el, fence.native);
    const dispose = () => { detach(); fence.reset(); };
    cleanups.push(dispose);
    const fire = (type: string) => el.dispatchEvent(new Event(type));
    return { stick, fence, fire, dispose };
  }

  test("manual pending survives native scrollend and quiet timer, then release permits correction", () => {
    const { stick, fence, fire } = fixture();
    const scroller = { scrollTop: 500, scrollHeight: 1000, clientHeight: 200 };
    fence.hold();
    fire("scroll");
    fire("scrollend");
    vi.advanceTimersByTime(250);
    expect(stick.wheelFence.current).toBe(true);
    stick.correctTo(scroller, 100);
    expect(scroller.scrollTop).toBe(500);
    fence.release();
    expect(stick.wheelFence.current).toBe(false);
    stick.correctTo(scroller, 100);
    expect(scroller.scrollTop).toBe(100);
  });

  test.each(["wheel", "touchend", "touchcancel"])(
    "manual release does not shorten a native %s quiet window",
    (event) => {
      const { stick, fence, fire } = fixture();
      fence.hold();
      fire(event);
      vi.advanceTimersByTime(100);
      fence.release();
      fence.release();
      expect(stick.wheelFence.current).toBe(true);
      fire("scrollend");
      vi.advanceTimersByTime(99);
      expect(stick.wheelFence.current).toBe(true);
      vi.advanceTimersByTime(2);
      expect(stick.wheelFence.current).toBe(false);
    },
  );

  test("native expiry cannot release manual ownership, and manual release has no hidden delay", () => {
    const { stick, fence, fire } = fixture();
    fire("wheel");
    fence.hold();
    vi.advanceTimersByTime(201);
    expect(stick.wheelFence.current).toBe(true);
    fence.release();
    expect(stick.wheelFence.current).toBe(false);
  });

  test("repeated hold/release is idempotent and does not clear unrelated user intent", () => {
    const { stick, fence } = fixture();
    fence.hold();
    fence.hold();
    fence.release();
    expect(stick.wheelFence.current).toBe(false);
    const scroller = { scrollTop: 500, scrollHeight: 1000, clientHeight: 200 };
    stick.markUserIntent();
    fence.release();
    stick.correctTo(scroller, 100);
    expect(scroller.scrollTop).toBe(500);
  });

  test("reset and teardown clear owned holds idempotently, with no surviving listener/timer", () => {
    const { stick, fence, fire, dispose } = fixture();
    fence.hold();
    fire("wheel");
    fence.reset();
    fence.reset();
    expect(stick.wheelFence.current).toBe(false);
    fence.hold();
    vi.advanceTimersByTime(201);
    expect(stick.wheelFence.current).toBe(true);
    dispose();
    dispose();
    expect(stick.wheelFence.current).toBe(false);
    fire("wheel");
    vi.advanceTimersByTime(1000);
    expect(stick.wheelFence.current).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
