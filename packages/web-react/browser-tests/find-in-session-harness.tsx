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

function sceneMessages(scene: Scene, needle: string): ChatMessage[] {
  if (scene === "coalesce") {
    const filler = Array.from({ length: 90 }, (_, i) => user(`f${i}`, `filler ${i}`, i));
    return [
      ...filler,
      group("g1", "team task one", 200, "coding-assistant"),
      group("g2", "team task two", 201, "research-assistant"),
      assistant("needle", `${needle} coalesced-after`, 202),
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
      directManipulation: boolean;
      holdFence: () => void;
      setScene: (scene: Scene) => void;
      setSessionId: (id: string) => void;
      replaceNeedle: (needle: string) => void;
      setSending: (value: boolean) => void;
      closeFind: () => void;
      openFind: () => void;
      setMounted: (value: boolean) => void;
    };
  }
}

function Harness() {
  const params = new URLSearchParams(location.search);
  const [scene, setScene] = useState<Scene>((params.get("scene") as Scene) || "tail");
  const [sessionId, setSessionId] = useState("sess-1");
  const [needle, setNeedle] = useState("FIND_NEEDLE_A");
  const [sending, setSending] = useState(false);
  const [findOpen, setFindOpen] = useState(true);
  const [mounted, setMounted] = useState(true);
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
    Object.defineProperty(window.__findPage, "directManipulation", {
      configurable: true,
      get: () => stick.directManipulation.current,
    });
    window.__findPage.holdFence = () => stick.beginWheelFence();
  }, [stick]);

  // Fixture/scene changes may reset; same-session needle replace and sessionId
  // changes must not steal success by resetting the controller.
  useLayoutEffect(() => {
    if (!scroller) return;
    stick.reset();
    stick.scrollToBottom(scroller);
  }, [scroller, stick, scene]);

  window.__findPage.setScene = setScene;
  window.__findPage.setSessionId = setSessionId;
  window.__findPage.replaceNeedle = setNeedle;
  window.__findPage.setSending = setSending;
  window.__findPage.closeFind = () => setFindOpen(false);
  window.__findPage.openFind = () => setFindOpen(true);
  window.__findPage.setMounted = setMounted;

  const messages = sceneMessages(scene, needle);
  const mark = useCallback(() => stick.markUserIntent(), [stick]);
  const beginDirect = useCallback(() => stick.beginDirectManipulation(), [stick]);
  const endDirect = useCallback(() => stick.endDirectManipulation(), [stick]);

  return (
    <TooltipProvider>
      <ToastProvider>
        <div className="flex h-full min-h-0 flex-col bg-bg text-fg">
          <output data-testid="scene">{scene}</output>
          <output data-testid="session">{sessionId}</output>
          <output data-testid="needle">{needle}</output>
          <div
            ref={setScroller}
            data-testid="find-chat-scroll"
            tabIndex={0}
            className="chat-scroll-area min-h-0 flex-1 overflow-x-hidden"
            style={{ height: 500, overflowY: "scroll" }}
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
            {mounted ? (
              <MessageList
                messages={messages}
                sending={sending}
                cb={{}}
                onRespondPermission={() => {}}
                scrollParent={scroller}
                followBottomRef={followBottomRef}
                find={findOpen ? { onClose: () => setFindOpen(false) } : undefined}
                sessionId={sessionId}
              />
            ) : (
              <div data-testid="list-unmounted">unmounted</div>
            )}
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
  directManipulation: false,
  holdFence: () => {},
  setScene: () => {},
  setSessionId: () => {},
  replaceNeedle: () => {},
  setSending: () => {},
  closeFind: () => {},
  openFind: () => {},
  setMounted: () => {},
};

createRoot(document.getElementById("root")!).render(<Harness />);
