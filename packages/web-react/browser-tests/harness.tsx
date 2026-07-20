// browser-tests 挂载壳:在真浏览器里 mount **真实 Composer**(非复刻结构),
// 由 run.mjs 用受信点击驱动断言。背景(2026-07-18 附件事故):jsdom 的 label
// 激活查找走 ownerDocument 而非 tree scope、fireEvent 非受信不触发同步 flush,
// "点击→选择器弹出"这类交互契约在 jsdom 里物理上测不出真实结果,必须真浏览器。
//
// stub 原则:只 stub 网络/宿主副作用(上传/发送/目标提交),不 stub 任何 UI 结构;
// onUpload 立即 resolve → 附件 chip 无后端也能走到 done 态,CI 零外部依赖。
import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../src/components/Composer";
import { MessageList, MessageRenderer } from "../src/components/MessageRenderer";
import { mergeTapePage } from "../src/lib/chat/directTimeline";
import type { ChatMessage } from "../src/lib/chat/model";
import type { MediaRef } from "../src/lib/chat/frames";

declare global {
  interface Window {
    __sends: Array<{ text: string; mediaCount: number }>;
    __uploads: string[];
    __lazyTimeline: {
      userFetches: number;
      tapeFetches: number;
      userRetry: null | {
        id: string;
        text: string;
        modelText?: string;
        retryFilename?: string;
      };
      tapeFetch: null | { tapeId: string; ordinal: number; recordId: string; role: string };
    };
    __scrollTimeline: {
      calls: Array<number | null>;
      mergedPages: number;
      messageCount: number;
    };
  }
}
window.__sends = [];
window.__uploads = [];
window.__lazyTimeline = { userFetches: 0, tapeFetches: 0, userRetry: null, tapeFetch: null };
window.__scrollTimeline = { calls: [], mergedPages: 0, messageCount: 0 };

const uploadStub = async (file: File): Promise<MediaRef> => {
  window.__uploads.push(file.name);
  return { kind: "file", url: "https://stub.invalid/browser-test", filename: file.name };
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Composer
      onSend={(text, media) => {
        window.__sends.push({ text, mediaCount: media?.length ?? 0 });
      }}
      onUpload={uploadStub}
      onSetGoal={async () => {}}
      onGoalAction={async () => {}}
    />
  </StrictMode>,
);

const deferredUser: ChatMessage = {
  id: "deferred-user-probe",
  role: "user",
  text: "",
  ts: 1,
  status: "error",
  _payloadDeferred: true,
  _userPayloadDeferred: true,
  _payloadBytes: 5_000_000,
  _payloadSha256: "a".repeat(64),
  _deferredRetryEligible: true,
};
const exactUser: ChatMessage = {
  id: deferredUser.id,
  role: "user",
  text: "EXACT_DEFERRED_USER_MARKER",
  ts: 1,
  _modelText: "EXACT_MODEL_VISIBLE_PROMPT",
  _retryMedia: [{ kind: "file", url: "https://stub.invalid/exact", filename: "exact-retry.txt" }],
};

createRoot(document.getElementById("timeline-user-root")!).render(
  <StrictMode>
    <MessageRenderer
      message={deferredUser}
      sig="deferred-user-probe"
      isLast
      sending={false}
      inActiveTurn
      cb={{
        onFetchUserMessagePayload: async () => {
          window.__lazyTimeline.userFetches += 1;
          return [exactUser];
        },
        onRetrySend: (message) => {
          window.__lazyTimeline.userRetry = {
            id: message.id,
            text: message.text,
            modelText: message._modelText,
            retryFilename: message._retryMedia?.[0]?.filename,
          };
        },
      }}
      onRespondPermission={() => {}}
    />
  </StrictMode>,
);

const deferredAgentRecord: ChatMessage = {
  id: "deferred-tool-probe",
  role: "tool",
  text: "",
  ts: 2,
  _payloadDeferred: true,
  _payloadBytes: 5_000_000,
  _payloadSha256: "b".repeat(64),
  _turnTapeId: "tape-browser-probe",
  _recordOrdinal: 7,
};
const exactAgentRecord: ChatMessage = {
  id: deferredAgentRecord.id,
  role: "tool",
  text: "",
  ts: 2,
  toolName: "Bash",
  inputJson: { command: "printf exact" },
  output: "EXACT_AGENT_PROCESS_MARKER",
  _completed: true,
};

createRoot(document.getElementById("timeline-agent-root")!).render(
  <StrictMode>
    <MessageRenderer
      message={deferredAgentRecord}
      sig="deferred-tool-probe"
      isLast
      sending={false}
      inActiveTurn
      cb={{
        onFetchTapeRecordPayload: async (tapeId, ordinal, expected) => {
          window.__lazyTimeline.tapeFetches += 1;
          window.__lazyTimeline.tapeFetch = {
            tapeId,
            ordinal,
            recordId: expected.recordId,
            role: expected.role,
          };
          return [exactAgentRecord];
        },
      }}
      onRespondPermission={() => {}}
    />
  </StrictMode>,
);

const processControl: ChatMessage = {
  id: "turn-process:scroll-tape",
  role: "runtime-event",
  text: "",
  ts: 2,
  _source: "server",
  _turnTapeProcess: true,
  _turnTapeProcessExpanded: true,
  _turnTapeProcessCursor: 200,
  _turnTapeId: "scroll-tape",
  _turnTapeSha256: "scroll-sha",
};
const processKey = "scroll-tape::scroll-sha::turn-process:scroll-tape";
const initialTail: ChatMessage[] = Array.from({ length: 96 }, (_, index) => ({
  id: `scroll-tail-${index}`,
  role: "system",
  text: `SCROLL_TAIL_${index}`,
  ts: 10 + index,
  _source: "server",
  _turnTapeId: "scroll-tape",
  _turnTapeSha256: "scroll-sha",
  _turnTapeOrdinal: 200 + index,
  _turnTapeProcessLoadedFrom: processKey,
  _turnTapeProcessPageKey: "scroll-tail-page",
  _turnTapeComplete: true,
}));

function olderPage(before: number): ChatMessage[] {
  const start = before === 200 ? 136 : 72;
  return Array.from({ length: 64 }, (_, index) => ({
    id: `scroll-old-${before}-${index}`,
    role: "system",
    text: `SCROLL_OLDER_${before}_${index}`,
    ts: start + index,
    _source: "server",
    _turnTapeOrdinal: start + index,
  } as ChatMessage));
}

function ScrollTimelineProbe() {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "scroll-user",
      role: "user",
      text: "SCROLL_USER_QUESTION",
      ts: 1,
      status: "replied",
      _source: "server",
    },
    processControl,
    ...initialTail,
    {
      id: "scroll-answer",
      role: "assistant",
      text: "SCROLL_FINAL_ANSWER",
      ts: 500,
      _source: "server",
    },
  ]);
  const loadOlder = useCallback(async (
    anchorId: string,
    tapeId: string,
    before: number | null,
  ) => {
    window.__scrollTimeline.calls.push(before);
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (anchorId !== processControl.id || tapeId !== processControl._turnTapeId || before === null) {
      return { ok: false, error: true };
    }
    const nextCursor = before === 200 ? 100 : null;
    setMessages((current) => {
      const merged = mergeTapePage(current, anchorId, olderPage(before), nextCursor);
      if (merged && merged !== current) window.__scrollTimeline.mergedPages += 1;
      return merged ?? current;
    });
    return { ok: true, nextCursor };
  }, []);
  window.__scrollTimeline.messageCount = messages.length;
  return (
    <div
      ref={setScroller}
      className="chat-scroll-area timeline-scroll-probe"
      data-testid="timeline-scroll-probe"
      tabIndex={0}
    >
      <MessageList
        messages={messages}
        sending={false}
        cb={{ onLoadOlderTape: loadOlder }}
        onRespondPermission={() => {}}
        scrollParent={scroller}
        historyGeneration={7}
      />
    </div>
  );
}

createRoot(document.getElementById("timeline-scroll-root")!).render(
  <StrictMode><ScrollTimelineProbe /></StrictMode>,
);
