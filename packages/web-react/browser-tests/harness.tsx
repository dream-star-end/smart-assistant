// browser-tests 挂载壳:在真浏览器里 mount **真实 Composer**(非复刻结构),
// 由 run.mjs 用受信点击驱动断言。背景(2026-07-18 附件事故):jsdom 的 label
// 激活查找走 ownerDocument 而非 tree scope、fireEvent 非受信不触发同步 flush,
// "点击→选择器弹出"这类交互契约在 jsdom 里物理上测不出真实结果,必须真浏览器。
//
// stub 原则:只 stub 网络/宿主副作用(上传/发送/目标提交),不 stub 任何 UI 结构;
// onUpload 立即 resolve → 附件 chip 无后端也能走到 done 态,CI 零外部依赖。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Composer } from "../src/components/Composer";
import { MessageRenderer } from "../src/components/MessageRenderer";
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
  }
}
window.__sends = [];
window.__uploads = [];
window.__lazyTimeline = { userFetches: 0, tapeFetches: 0, userRetry: null, tapeFetch: null };

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
