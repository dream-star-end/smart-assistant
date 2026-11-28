import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ChatMessage } from "../../../lib/chat/model";
import { safeMessageSignature } from "../../../lib/chat/render";
import { StatusPill } from "../../ui";
import type { CardCallbacks } from "../cards";
import {
  LAZY_PAYLOAD_RETRY_MS,
  type MessageRendererComponent,
  RUNTIME_TEXT_STEP,
  type RendererProps,
} from "./types";

export function TapeBackedCard({ children }: { children: ReactNode }) {
  return <div className="space-y-1">{children}</div>;
}

/** Readable cards retain their pre-direct-timeline UX, while the immutable
 * source remains reachable byte-for-byte instead of being replaced by the
 * formatted view. Serialization and mounting happen only after the click. */
export function ExactTapeRecordDisclosure({
  messages,
  label,
}: {
  messages: ChatMessage[];
  label: string;
}) {
  const exactMessages = messages.filter((message) => !!message._turnTapeId);
  const [open, setOpen] = useState(false);
  const [visibleChars, setVisibleChars] = useState(RUNTIME_TEXT_STEP);
  if (exactMessages.length === 0) return null;

  const raw = exactMessages.length === 1
    ? exactMessages[0]._eventHistory ?? exactMessages[0]
    : exactMessages.map((message) => message._eventHistory ?? message);
  const serialized = open ? JSON.stringify(raw, null, 2) ?? String(raw) : "";

  return (
    <div className="px-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="text-caption text-faint hover:text-muted [@media(hover:none)]:inline-flex [@media(hover:none)]:min-h-11 [@media(hover:none)]:items-center"
      >
        {open ? `收起原始${label}记录` : `查看原始${label}记录`}
      </button>
      {open && (
        <div className="oc-surface-recessed mt-1 rounded-lg border border-border/70 px-3 py-2">
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words font-mono text-caption leading-relaxed text-muted">
            {serialized.slice(0, visibleChars)}
          </pre>
          {visibleChars < serialized.length && (
            <button
              type="button"
              onClick={() => setVisibleChars((value) => value + RUNTIME_TEXT_STEP)}
              className="oc-btn-tactile mt-2 rounded-full bg-hover px-2.5 py-1 text-caption text-muted hover:text-fg [@media(hover:none)]:min-h-11 [@media(hover:none)]:px-3"
            >
              继续显示原始记录
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Every persisted runtime event remains inspectable. The JSON body is
 * progressively mounted so a multi-megabyte event never blocks a frame. */
export function RuntimeEventCard({ message }: { message: ChatMessage }) {
  const raw = message._runtimeEvent ?? message;
  const event = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const eventLabel = [event.type, event.subtype].filter((part) => typeof part === "string").join(" · ");
  const label = eventLabel || (message.role === "runtime-event"
    ? "运行事件"
    : `原始 Agent 记录 · ${message.role || "unknown"}`);
  const [open, setOpen] = useState(false);
  const [visibleChars, setVisibleChars] = useState(RUNTIME_TEXT_STEP);
  const serialized = open ? JSON.stringify(raw, null, 2) : "";
  return (
    <div className="oc-surface-card overflow-hidden rounded-xl animate-in">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-meta transition-colors hover:bg-hover/70 [@media(hover:none)]:min-h-11"
      >
        <StatusPill tone="idle" size="sm" decorative />
        <span className="min-w-0 flex-1 truncate text-muted">{label}</span>
        {message._runtimeSource && <span className="shrink-0 text-caption text-faint">{message._runtimeSource}</span>}
        <span className="text-caption text-faint">{open ? "收起" : "查看原始记录"}</span>
      </button>
      {open && (
        <div className="oc-surface-recessed border-t border-border/70 px-3.5 py-2.5">
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words font-mono text-caption leading-relaxed text-muted">
            {serialized.slice(0, visibleChars)}
          </pre>
          {visibleChars < serialized.length && (
            <button
              type="button"
              onClick={() => setVisibleChars((value) => value + RUNTIME_TEXT_STEP)}
              className="oc-btn-tactile mt-2 rounded-full bg-hover px-2.5 py-1 text-caption text-muted hover:text-fg [@media(hover:none)]:min-h-11 [@media(hover:none)]:px-3"
            >
              继续显示原始记录
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type DeferredExpectation = {
  recordId: string;
  role: ChatMessage["role"];
  contentSha256?: string;
};

function buildPayloadExpectation(message: ChatMessage, payloadId: string): DeferredExpectation {
  return {
    recordId: payloadId,
    role: message.role,
    ...(message._payloadSha256 ? { contentSha256: message._payloadSha256 } : {}),
  };
}

function peekInitialDeferredRecords(
  message: ChatMessage,
  cb: CardCallbacks,
  isUserPayload: boolean,
  payloadId: string,
): ChatMessage[] | null {
  const initialExpectation = buildPayloadExpectation(message, payloadId);
  if (isUserPayload) {
    return cb.onPeekUserMessagePayload?.(payloadId, initialExpectation) ?? null;
  }
  const tapeId = message._turnTapeId;
  const recordOrdinal = message._recordOrdinal;
  if (tapeId && typeof recordOrdinal === "number") {
    return cb.onPeekTapeRecordPayload?.(tapeId, recordOrdinal, initialExpectation) ?? null;
  }
  return null;
}

function startDeferredPayloadRequest(
  cb: CardCallbacks,
  isUserPayload: boolean,
  payloadId: string,
  tapeId: string | undefined,
  recordOrdinal: number | undefined,
  expected: DeferredExpectation,
  signal: AbortSignal,
): Promise<ChatMessage[] | null> | null {
  if (isUserPayload) {
    return cb.onFetchUserMessagePayload
      ? cb.onFetchUserMessagePayload(payloadId, expected, signal)
      : null;
  }
  if (cb.onFetchTapeRecordPayload && tapeId && typeof recordOrdinal === "number") {
    return cb.onFetchTapeRecordPayload(tapeId, recordOrdinal, expected, signal);
  }
  return null;
}

function hydrateUserDeferredRecord(
  locator: ChatMessage,
  record: ChatMessage,
  currentUsage: ChatMessage["usage"] | undefined,
): ChatMessage {
  return {
    ...record,
    // Keep UI actions bound to the current dispatch row; the
    // immutable fetch key remains explicit and survives reload.
    id: locator.id,
    _userPayloadId: locator._userPayloadId ?? locator.id,
    _source: "server",
    status: locator.status ?? record.status,
    ...(currentUsage ? { usage: currentUsage } : {}),
    _payloadDeferred: undefined,
    _userPayloadDeferred: undefined,
    _payloadBytes: undefined,
    _payloadSha256: undefined,
    _seq: locator._seq,
    _orderSeq: locator._orderSeq,
    _timelineRecord: locator._timelineRecord,
    _timelineUnitKey: locator._timelineUnitKey,
    _timelineLogicalOrdinal: locator._timelineLogicalOrdinal,
    _historyPageLoadedFrom: locator._historyPageLoadedFrom,
    _historyPageKey: locator._historyPageKey,
    _clientMessageId: record._clientMessageId ?? locator._clientMessageId,
    _routing: record._routing ?? locator._routing,
    _sendAttempt: locator._sendAttempt ?? record._sendAttempt,
    _deferredRetryEligible: undefined,
  };
}

function hydrateTapeDeferredRecord(
  locator: ChatMessage,
  record: ChatMessage,
  index: number,
  currentUsage: ChatMessage["usage"] | undefined,
): ChatMessage {
  return {
    ...record,
    ...(currentUsage ? { usage: currentUsage } : {}),
    _turnTapeId: locator._turnTapeId,
    _turnTapeSha256: locator._turnTapeSha256,
    _turnTapeOrdinal: locator._recordOrdinal,
    _recordOrdinal: locator._recordOrdinal,
    _turnTapeComplete: true,
    _turnTapeProcessLoadedFrom: locator._turnTapeProcessLoadedFrom,
    _seq: locator._seq,
    _orderSeq: locator._orderSeq,
    _timelineRecord: locator._timelineRecord,
    _timelineUnitKey: `${locator._timelineUnitKey ?? locator.id}:logical:${index}`,
    _timelineLogicalOrdinal: index,
    _historyPageLoadedFrom: locator._historyPageLoadedFrom,
    _historyPageKey: locator._historyPageKey,
    _clientMessageId: record._clientMessageId ?? locator._clientMessageId,
    _continuationOfTurnKey: record._continuationOfTurnKey ?? locator._continuationOfTurnKey,
    _delegateRunId: record._delegateRunId ?? locator._delegateRunId,
    _turnKey: record._turnKey ?? locator._turnKey,
  };
}

function hydrateDeferredRecord(
  locator: ChatMessage,
  record: ChatMessage,
  index: number,
  isUserPayload: boolean,
): ChatMessage {
  // Payload bytes are immutable, but billing/status overlays on the small locator
  // can advance after the first viewport load. Re-merge them on every locator render.
  const currentUsage = record.id === locator.id && locator.usage
    ? { ...(record.usage ?? {}), ...locator.usage }
    : record.usage;
  return isUserPayload
    ? hydrateUserDeferredRecord(locator, record, currentUsage)
    : hydrateTapeDeferredRecord(locator, record, index, currentUsage);
}

function useDeferredViewportTrigger(
  ref: RefObject<HTMLDivElement | null>,
  load: () => Promise<void>,
  eagerPayload: boolean,
  requestAbortRef: RefObject<AbortController | null>,
  startedRef: RefObject<boolean>,
): void {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const cancel = () => {
      const controller = requestAbortRef.current;
      if (!controller) return;
      requestAbortRef.current = null;
      startedRef.current = false;
      controller.abort();
    };
    if (eagerPayload || typeof IntersectionObserver === "undefined") {
      void load();
      return cancel;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void load();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      cancel();
    };
  }, [ref, load, eagerPayload, requestAbortRef, startedRef]);
}

function useDeferredTapeRecords(
  message: ChatMessage,
  cb: CardCallbacks,
  eagerPayload: boolean,
) {
  const ref = useRef<HTMLDivElement>(null);
  const isUserPayload = message._userPayloadDeferred === true;
  const payloadId = isUserPayload ? message._userPayloadId ?? message.id : message.id;
  const payloadSha256 = message._payloadSha256;
  const tapeId = message._turnTapeId;
  const recordOrdinal = message._recordOrdinal;
  const [records, setRecords] = useState<ChatMessage[] | null>(() =>
    peekInitialDeferredRecords(message, cb, isUserPayload, payloadId),
  );
  const started = useRef(records !== null);
  const requestAbortRef = useRef<AbortController | null>(null);
  const [failed, setFailed] = useState(false);
  // OCV5-421: 弱网下单次读取失败先静默重试两次(仍显示「正在读取」),之后才给「点击重试」。
  const autoRetries = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
  }, []);
  const load = useCallback(async () => {
    if (started.current) return;
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    const expected: DeferredExpectation = {
      recordId: payloadId,
      role: message.role,
      ...(payloadSha256 ? { contentSha256: payloadSha256 } : {}),
    };
    const controller = new AbortController();
    const request = startDeferredPayloadRequest(
      cb, isUserPayload, payloadId, tapeId, recordOrdinal, expected, controller.signal,
    );
    if (!request) {
      setFailed(true);
      return;
    }
    started.current = true;
    requestAbortRef.current = controller;
    setFailed(false);
    let loaded: ChatMessage[] | null = null;
    try {
      loaded = await request;
    } catch {
      loaded = null;
    }
    if (requestAbortRef.current === controller) requestAbortRef.current = null;
    if (controller.signal.aborted) return;
    if (!loaded) {
      started.current = false;
      const delay: number | undefined = LAZY_PAYLOAD_RETRY_MS[autoRetries.current];
      if (delay !== undefined) {
        autoRetries.current++;
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null;
          void loadRef.current();
        }, delay);
        return;
      }
      setFailed(true);
      return;
    }
    setRecords(loaded);
  }, [
    cb,
    isUserPayload,
    message.role,
    payloadId,
    payloadSha256,
    recordOrdinal,
    tapeId,
  ]);
  const loadRef = useRef(load);
  loadRef.current = load;
  useDeferredViewportTrigger(ref, load, eagerPayload, requestAbortRef, started);
  const retry = () => {
    autoRetries.current = 0;
    void load();
  };
  return { ref, isUserPayload, records, failed, retry };
}

export type DeferredTapeRecordCardProps = Omit<RendererProps, "sig" | "delegateCost"> & {
  renderRecord: MessageRendererComponent;
};

export function DeferredTapeRecordCard({
  message,
  isLast,
  sending,
  inActiveTurn,
  turnActivity,
  activityInFooter,
  historyGeneration,
  processPaging,
  tokenUsage,
  cb,
  onRespondPermission,
  readOnly,
  turnFinalAssistant,
  failurePresentedBelow,
  eagerPayload = false,
  renderRecord: RenderRecord,
}: DeferredTapeRecordCardProps) {
  const { ref, isUserPayload, records, failed, retry } = useDeferredTapeRecords(
    message,
    cb,
    eagerPayload,
  );
  if (records) {
    return (
      <div className="space-y-3">
        {records.map((record, index) => {
          const hydratedRecord = hydrateDeferredRecord(message, record, index, isUserPayload);
          const final = isLast && index === records.length - 1;
          const recordIsFinalAssistant = turnFinalAssistant === true &&
            hydratedRecord.role === "assistant" && index === records.length - 1;
          const recordSig = safeMessageSignature(hydratedRecord, {
            isLast: final,
            sending,
            turnFinalAssistant: recordIsFinalAssistant,
          });
          return (
            <RenderRecord
              key={hydratedRecord.id}
              message={hydratedRecord}
              sig={recordSig}
              isLast={final}
              sending={sending}
              inActiveTurn={inActiveTurn}
              turnActivity={turnActivity}
              activityInFooter={activityInFooter}
              historyGeneration={historyGeneration}
              processPaging={processPaging}
              tokenUsage={tokenUsage}
              turnFinalAssistant={recordIsFinalAssistant}
              cb={cb}
              onRespondPermission={onRespondPermission}
              readOnly={readOnly}
              failurePresentedBelow={failurePresentedBelow}
              hostedPermission
            />
          );
        })}
      </div>
    );
  }
  return (
    <div ref={ref} className="rounded-lg border border-dashed border-border bg-surface px-3.5 py-3 text-caption text-muted">
      {failed ? (
        <button
          type="button"
          onClick={retry}
          className="inline-flex items-center text-muted underline-offset-2 hover:text-fg hover:underline [@media(hover:none)]:min-h-11"
        >
          {isUserPayload ? "完整消息加载失败，点击重新加载" : "内容加载失败，点击重新加载"}
        </button>
      ) : (
        <span>{isUserPayload ? "正在加载完整消息…" : "正在加载内容…"}</span>
      )}
    </div>
  );
}
