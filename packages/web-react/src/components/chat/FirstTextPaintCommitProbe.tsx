import { useLayoutEffect, useRef } from "react";
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
    let first = 0;
    let second = 0;
    let cancelled = false;
    first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        if (cancelled || reported.has(probe)) return;
        reported.add(probe);
        onFirstTextPaint({
          traceId: probe.traceId,
          sessionId: probe.sessionId,
          clientMessageId: probe.clientMessageId,
          latencyMs: Math.max(0, Date.now() - probe.startedAt),
          backgroundAtFrame: probe.backgroundAtFrame,
        });
        if (messageRef.current._firstTextPaintProbe === probe) messageRef.current._firstTextPaintProbe = undefined;
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(first);
      if (second) cancelAnimationFrame(second);
    };
  }, [probe, onFirstTextPaint]);
  return null;
}
