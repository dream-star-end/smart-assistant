// App-isomorphic find harness: real MessageList + real stick controller +
// attachWheelFence + following getter (not canRestick) + production CSS.
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MessageList } from "../src/components/MessageRenderer";
import { createStickToBottomController } from "../src/components/chat/stickToBottom";
import { attachWheelFence } from "../src/components/chat/wheelFence";
import { ToastProvider, TooltipProvider } from "../src/components/ui";
import type { ChatMessage } from "../src/lib/chat/model";

type Scene = "tail" | "coalesce" | "multi" | "budget" | "midtail";

function user(id: string, text: string, ts: number): ChatMessage {
  return { id, role: "user", text, ts };
}
function assistant(id: string, text: string, ts: number): ChatMessage {
  return { id, role: "assistant", text, ts };
}
function group(id: string, text: string, ts: number, agent: string): ChatMessage {
  return { id, role: "agent-group", text, ts, _delegate: true, _delegateAgentId: agent };
}

function sceneMessages(scene: Scene, variant: "A" | "B"): ChatMessage[] {
  if (scene === "coalesce") {
    const filler = Array.from({ length: 90 }, (_, i) => user(`f${i}`, `filler ${i}`, i));
    return [
      ...filler,
      group("g1", "team task one", 200, "coding-assistant"),
      group("g2", "team task two", 201, "research-assistant"),
      assistant("needle", variant === "A" ? "FIND_NEEDLE_A coalesced-after" : "FIND_NEEDLE_B coalesced-after", 202),
      user("tail", "tail user", 203),
    ];
  }
  if (scene === "midtail") {
    return Array.from({ length: 320 }, (_, i) =>
      user(`m${i}`, i === 250 ? "FIND_NEEDLE_MID" : `message ${i}`, i),
    );
  }
  if (scene === "multi") {
    return Array.from({ length: 320 }, (_, i) =>
      user(`m${i}`, i === 0 || i === 160 || i === 319 ? `MULTI_NEEDLE ${i}` : `message ${i}`, i),
    );
  }
  const n = scene === "budget" ? 2000 : 320;
  const needle = variant === "A" ? "FIND_NEEDLE_A" : "FIND_NEEDLE_B";
  return Array.from({ length: n }, (_, i) =>
    user(`m${i}`, i === 0 ? needle : `message ${i}`, i),
  );
}

declare global {
  interface Window {
    __findPage: {
      peakMounted: number;
      following: boolean;
      wheelFence: boolean;
      setScene: (scene: Scene) => void;
      setVariant: (variant: "A" | "B") => void;
      setSending: (value: boolean) => void;
      closeFind: () => void;
      openFind: () => void;
    };
  }
}

function Harness() {
  const params = new URLSearchParams(location.search);
  const [scene, setScene] = useState<Scene>((params.get("scene") as Scene) || "tail");
  const [variant, setVariant] = useState<"A" | "B">("A");
  const [sending, setSending] = useState(false);
  const [findOpen, setFindOpen] = useState(true);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const stick = useRef(createStickToBottomController()).current;
  const followBottomRef = useMemo(() => ({
    get current() {
      return stick.following.current;
    },
    set current(value: boolean) {
      stick.following.current = value;
    },
    scrollToBottom: stick.scrollToBottom,
    jumpToBottom: stick.jumpToBottom,
    correctTo: stick.correctTo,
    releaseUserIntent: stick.releaseUserIntent,
  }), [stick]);

  useLayoutEffect(() => {
    if (!scroller) return;
    return attachWheelFence(scroller, stick);
  }, [scroller, stick]);

  useLayoutEffect(() => {
    if (!scroller) return;
    const obs = new MutationObserver(() => {
      const n = scroller.querySelectorAll("[data-chat-virtual-key]").length;
      if (n > window.__findPage.peakMounted) window.__findPage.peakMounted = n;
    });
    obs.observe(scroller, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [scroller]);

  useLayoutEffect(() => {
    Object.defineProperty(window.__findPage, "wheelFence", {
      configurable: true,
      get: () => stick.wheelFence.current,
    });
    Object.defineProperty(window.__findPage, "following", {
      configurable: true,
      get: () => stick.following.current,
    });
  }, [stick]);

  useLayoutEffect(() => {
    if (!scroller) return;
    stick.reset();
    stick.scrollToBottom(scroller);
  }, [scroller, stick, scene, variant]);

  window.__findPage.setScene = setScene;
  window.__findPage.setVariant = setVariant;
  window.__findPage.setSending = setSending;
  window.__findPage.closeFind = () => setFindOpen(false);
  window.__findPage.openFind = () => setFindOpen(true);

  const messages = sceneMessages(scene, variant);
  const mark = useCallback(() => stick.markUserIntent(), [stick]);
  const beginDirect = useCallback(() => stick.beginDirectManipulation(), [stick]);
  const endDirect = useCallback(() => stick.endDirectManipulation(), [stick]);

  return (
    <TooltipProvider>
      <ToastProvider>
        <div className="flex h-full min-h-0 flex-col bg-bg text-fg">
          <output data-testid="scene">{scene}:{variant}</output>
          <output data-testid="session">{variant}</output>
          <div
            ref={setScroller}
            data-testid="find-chat-scroll"
            tabIndex={0}
            className="chat-scroll-area min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
            style={{ height: 500 }}
            onScroll={() => {
              if (scroller) stick.onScroll(scroller);
            }}
            onWheel={mark}
            onKeyDown={mark}
            onTouchStart={beginDirect}
            onTouchMove={beginDirect}
            onTouchEnd={endDirect}
            onTouchCancel={endDirect}
            onPointerDown={beginDirect}
            onPointerUp={endDirect}
          >
            <MessageList
              messages={messages}
              sending={sending}
              cb={{}}
              onRespondPermission={() => {}}
              scrollParent={scroller}
              followBottomRef={followBottomRef}
              find={findOpen ? { onClose: () => setFindOpen(false) } : undefined}
              sessionId={`${scene}-${variant}`}
            />
          </div>
        </div>
      </ToastProvider>
    </TooltipProvider>
  );
}

window.__findPage = {
  peakMounted: 0,
  following: true,
  wheelFence: false,
  setScene: () => {},
  setVariant: () => {},
  setSending: () => {},
  closeFind: () => {},
  openFind: () => {},
};

createRoot(document.getElementById("root")!).render(<Harness />);
