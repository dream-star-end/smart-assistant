import { useLayoutEffect, useRef } from "react";
import {
  currentDocumentVisibilityState,
  ensureFirstTextPaintVisibilityTracking,
  summarizeFirstTextPaintVisibility,
} from "../../lib/chat/firstTextPaintVisibility";
import type { ChatMessage } from "../../lib/chat/model";
import type { CardCallbacks } from "./cards";

// The same ephemeral object follows a live message across process/final remounts.
// Weak ownership releases completed turns; cancellation never claims a paint.
const reported = new WeakSet<NonNullable<ChatMessage["_firstTextPaintProbe"]>>();

export function FirstTextPaintCommitProbe({ message, onFirstTextPaint }: {
  message: ChatMessage;
  onFirstTextPaint: CardCallbacks["onFirstTextPaint"];
}) {
  const messageRef = useRef(message);
  messageRef.current = message;
  const probe = message._payloadDeferred || message._hideUnpublishedFallback ||
    message.error || message._isError || message._errorCode || !message.text?.trim()
    ? undefined : message._firstTextPaintProbe;
  useLayoutEffect(() => {
    if (!probe || !onFirstTextPaint || reported.has(probe)) return;
    if (typeof requestAnimationFrame !== "function" || typeof cancelAnimationFrame !== "function") return;
    const mountedAt = Date.now();
    ensureFirstTextPaintVisibilityTracking(mountedAt);
    let hiddenDuringPaintObserved = currentDocumentVisibilityState() !== "visible";
    const onVisibilityChange = () => {
      if (currentDocumentVisibilityState() !== "visible") hiddenDuringPaintObserved = true;
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    let first = 0;
    let second = 0;
    let cancelled = false;
    first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        if (cancelled || reported.has(probe)) return;
        reported.add(probe);
        const paintedAt = Date.now();
        const latencyMs = Math.max(0, paintedAt - probe.startedAt);
        const visibility = summarizeFirstTextPaintVisibility({
          startedAt: probe.startedAt,
          frameAt: probe.frameAt ?? mountedAt,
          paintedAt,
          backgroundAtFrame: probe.backgroundAtFrame,
          hiddenBeforeFrame: probe.hiddenBeforeFrame,
          hiddenDuringPaintObserved,
        });
        onFirstTextPaint({
          traceId: probe.traceId,
          sessionId: probe.sessionId,
          clientMessageId: probe.clientMessageId,
          latencyMs,
          backgroundAtFrame: probe.backgroundAtFrame,
          visibilityState: visibility.visibilityState,
          wasHidden: visibility.wasHidden,
          hiddenDurationMs: visibility.hiddenDurationMs,
          visibleLatencyMs: visibility.visibleLatencyMs,
          visibilityPath: visibility.visibilityPath,
          visibilityReason: visibility.visibilityReason,
        });
        if (messageRef.current._firstTextPaintProbe === probe) messageRef.current._firstTextPaintProbe = undefined;
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [probe, onFirstTextPaint]);
  return null;
}
