import type { StickToBottomController } from "../src/components/chat/stickToBottom";

/** Fixture-only hold for a pending find. Native gesture timing stays authoritative. */
export function createFindPendingFence(
  stick: Pick<StickToBottomController, "wheelFence" | "beginWheelFence" | "endWheelFence">,
) {
  let manualHeld = false;
  let nativeActive = false;
  const releaseIfIdle = () => {
    if (!manualHeld && !nativeActive && stick.wheelFence.current) stick.endWheelFence();
  };
  return {
    // attachWheelFence still receives the real controller's flag and owns all
    // wheel/touch/scroll timers. Its end cannot release the fixture's hold.
    native: {
      wheelFence: stick.wheelFence,
      beginWheelFence() {
        nativeActive = true;
        stick.beginWheelFence();
      },
      endWheelFence() {
        nativeActive = false;
        releaseIfIdle();
      },
    },
    hold() {
      manualHeld = true;
      stick.beginWheelFence();
    },
    release() {
      if (!manualHeld) return;
      manualHeld = false;
      releaseIfIdle();
    },
    // Scene reset/teardown only. Ordinary cancellation releases just manual
    // ownership, preserving any real gesture's remaining quiet window.
    reset() {
      manualHeld = false;
      nativeActive = false;
      releaseIfIdle();
    },
  };
}
