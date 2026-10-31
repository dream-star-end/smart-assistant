import { useLayoutEffect, useRef, useState } from "react";

/** OCV5-695: a click landing within this window after the send button turned into Stop is the
 *  user's second click on an unresponsive Send, not a Stop. Measured from the first Stop render. */
export const STOP_ARM_MS = 1000;

/** Send/Stop transition guard for the composer button.
 *  - `sending`: onSend is still pending (fee check, session setup, network); the button shows
 *    「正在发送」 at once and ignores repeat clicks instead of looking dead for seconds.
 *  - `stopArmed()`: false while Stop has been on screen for less than STOP_ARM_MS after a
 *    not-busy → busy flip. Mounting into an already running turn arms Stop immediately. */
export function useSendGuard(busy: boolean) {
  const submittingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const stopShownAt = useRef<number | null>(null);
  const wasBusy = useRef(busy);
  useLayoutEffect(() => {
    if (busy && !wasBusy.current) stopShownAt.current = performance.now();
    wasBusy.current = busy;
  }, [busy]);
  const stopArmed = () => stopShownAt.current === null || performance.now() - stopShownAt.current >= STOP_ARM_MS;
  return { submittingRef, sending, setSending, stopArmed };
}
