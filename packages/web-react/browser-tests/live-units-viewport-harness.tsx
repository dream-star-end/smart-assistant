// T69: real Chromium geometry for older live-unit prepend (INC-20260924).
// The scroller, MessageList and stick controller are production code. This file
// only drives the three timings the incident cares about.
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageList } from "../src/components/MessageRenderer";
import { createStickToBottomController } from "../src/components/chat/stickToBottom";
import type { ChatMessage } from "../src/lib/chat/model";

type Mode = "follow" | "away" | "gesture";

type LiveUnitsApi = {
  started: boolean;
  grow: () => void;
  prepend: () => void;
  following: () => boolean;
};

declare global {
  interface Window {
    __liveUnits: Record<Mode, LiveUnitsApi>;
  }
}

function row(role: ChatMessage["role"], id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, text, ts: 1, ...extra };
}

function LiveUnitsViewportProbe({ mode }: { mode: Mode }) {
  const stick = useRef(createStickToBottomController()).current;
  const awayArmed = useRef(false);
  if (mode === "away" && !awayArmed.current) {
    awayArmed.current = true;
    stick.canRestick.current = false;
  }
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [stream, setStream] = useState("已渲染锚点正文\n第二行仍在视口里\n".repeat(6));
  const [older, setOlder] = useState(false);
  const releaseRef = useRef<((value: { ok: true; hasMore: true }) => void) | null>(null);

  const messages: ChatMessage[] = [
    row("user", `user-${mode}`, "请继续", { status: "sent" }),
    ...(older
      ? [row("assistant", `older-${mode}`, "更早的中间说明，应该出现在锚点上方。\n".repeat(16))]
      : []),
    row("tool", `tool-${mode}`, "pwd", {
      toolName: "Bash",
      output: "/work",
      _completed: true,
    }),
    row("assistant", `jump-anchor-${mode}`, stream),
  ];

  const onLoadOlderLiveUnits = useCallback(
    () =>
      new Promise<{ ok: true; hasMore: true }>((resolve) => {
        releaseRef.current = resolve;
        const api = window.__liveUnits[mode];
        if (api) api.started = true;
      }),
    [mode],
  );

  useLayoutEffect(() => {
    if (!scroller || mode !== "away") return;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.min(96, max);
  }, [scroller, mode]);

  window.__liveUnits[mode] = {
    started: window.__liveUnits[mode]?.started === true,
    grow: () => setStream((current) => current + "流式新增的一行，贴在锚点正文下面。\n".repeat(8)),
    prepend: () => {
      setOlder(true);
      releaseRef.current?.({ ok: true, hasMore: true });
    },
    following: () => stick.following.current,
  };

  return (
    <section className="live-units-case" data-mode={mode}>
      <div
        ref={setScroller}
        className="chat-scroll-area timeline-scroll-probe"
        data-testid={`live-units-${mode}`}
        tabIndex={0}
        onScroll={(event) => stick.onScroll(event.currentTarget)}
      >
        {scroller ? <MessageList
          processDisclosure
          sessionId={`live-units-${mode}`}
          messages={messages}
          sending
          cb={{}}
          onRespondPermission={() => {}}
          scrollParent={scroller}
          followBottomRef={stick.canRestick}
          archive={{
            hasMore: false,
            loading: false,
            error: false,
            onLoadOlder: () => {},
            liveHasMoreBefore: true,
            liveUnitsCursor: "u:40",
            onLoadOlderLiveUnits,
          }}
        /> : null}
      </div>
    </section>
  );
}

window.__liveUnits = {
  follow: { started: false, grow: () => {}, prepend: () => {}, following: () => false },
  away: { started: false, grow: () => {}, prepend: () => {}, following: () => false },
  gesture: { started: false, grow: () => {}, prepend: () => {}, following: () => false },
};

createRoot(document.getElementById("live-units-viewport-root")!).render(
  <>
    <LiveUnitsViewportProbe mode="follow" />
    <LiveUnitsViewportProbe mode="away" />
    <LiveUnitsViewportProbe mode="gesture" />
  </>,
);
