import { useRef, useState } from "react";

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
  // Render-time bookkeeping, idempotent across re-renders: only the busy edge writes.
  const flip = useRef({ busy, at: -STOP_ARM_MS }).current;
  if (busy !== flip.busy) {
    flip.busy = busy;
    if (busy) flip.at = performance.now();
  }
  return { submittingRef, sending, setSending, stopArmed: () => performance.now() - flip.at >= STOP_ARM_MS };
}
