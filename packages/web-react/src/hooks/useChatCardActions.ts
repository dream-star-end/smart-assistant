/**
 * Chat turn and card actions: stop, media signing, permission response, feedback, tool actions, retry/continue and card callbacks
 *
 * Moved verbatim out of App() (App.tsx) — FINDINGS §10, OCV5-472. App calls this hook at the
 * exact position the statements had, so React hook order and every value are unchanged.
 */
import type { BlogDraft } from "../components/tutorials/blog/blogLib";
import { tutorialHref } from "./useAppRoute";
import { useCallback, useMemo, useRef } from "react";
import { identityIsCurrent, type ResolvedIdentity } from "../lib/resolvedIdentity";
import { findStopTarget } from "../lib/implicitFeedback";
import { api } from "../lib/api";
import type { FeedbackContext, CardCallbacks } from "../components/chat/cards";
import { TASKBOARD_ENABLED } from "../lib/taskboardFeature";
import type { ChatInteraction, ArtifactInspectTarget } from "../components/tool/context";
import { isBrowserStepMessage } from "../components/tool/browserDetect";
import type { PaneTab } from "../components/InspectorPanel";
import type { ToolLike } from "../components/tool/format";
import type { ChatMessage } from "../lib/chat/model";
import { preciseRetryEligible, interruptedContinuationTarget, exactUserReplayPayload } from "../lib/chat/socket";
import { canonicalTaskContinuationError, manualTaskContinuationSource, taskContinuationPrompt } from "../lib/chat/manualTaskContinuation";
import { CONTINUE_PROMPT } from "../lib/chat/render";
import { reportClientFriction } from "../lib/clientFriction";
import { normalizeMessageReplyQuote } from "@openclaude/protocol/browser";
import type { Agent } from "../lib/agents";
import type { AuthSession } from "../lib/types";
import type { UseChatSocket } from "./useChatSocket";
import type { ManageTab } from "../lib/manageTabs";
import type { SettingsDestinationSection } from "../lib/productCapabilities";
import type { ImplicitTarget } from "../lib/implicitFeedback";
import type { ImplicitReason } from "./useResponseRatings";
import type { ChatError } from "../components/ErrorBanner";
import type { SaveToProjectRequest } from "../components/project/SaveToProjectDialog";
import type { ToastFn } from "../components/ui/Toast";

function replyQuoteText(message: ChatMessage): string {
  if (message.text.trim()) return message.text;
  const media = message._media ?? [];
  if (media.some((item) => item.kind === "image")) return media.length > 1 ? `[${media.length} 张图片]` : "[图片]";
  const first = media[0];
  if (first?.filename) return `[文件：${first.filename}]`;
  return media.length > 0 ? "[附件]" : "";
}

export type BlogOpenTarget =
  | { kind: "post"; id: string }
  | { kind: "mine" }
  | { kind: "editor"; seed: BlogDraft };

export type ChatCardActionsInput = {
  activeId: string | undefined;
  agent: Agent;
  authRef: React.RefObject<AuthSession>;
  identity: ResolvedIdentity | null;
  chat: UseChatSocket;
  chipsBoardProjectId: string | null;
  chipsProjectName: string;
  demo: boolean;
  loadExactUserMessage: (message: ChatMessage) => Promise<ChatMessage | null>;
  messageFeedbackTriggerRef: React.RefObject<HTMLElement | null>;
  newSession: () => void;
  openManage: (tab: ManageTab) => void;
  /** 经验分享开关（feature_community_blog）；关时对话卡只读。 */
  communityBlogEnabled: boolean;
  openBlog: (target: BlogOpenTarget) => void;
  openPane: (tab?: PaneTab | undefined, message?: ToolLike | null | undefined) => void;
  openSettings: (section?: SettingsDestinationSection) => void;
  regenerate: () => Promise<void>;
  send: (text: string, media?: { url?: string | undefined; base64?: string | undefined; mimeType?: string | undefined; filename?: string | undefined; hidden?: boolean | undefined; localSrc?: string | undefined; kind: "image" | "audio" | "video" | "file"; }[] | undefined, imageEdit?: { mode?: "annotated" | "outpaint" | undefined; maskIndex?: number | undefined; targetAspect?: "16:9" | "4:3" | "9:16" | "3:4" | "1:1" | undefined; clientJobId: string; sourceIndex: number; guideIndex: number; width: number; height: number; } | undefined, displayText?: string | undefined, replyTo?: { text: string; messageId: string; role: "user" | "assistant"; } | undefined, target?: { sessionId: string; projectId?: string | null | undefined; } | undefined) => Promise<void>;
  sendImplicitRatingRef: React.RefObject<((target: ImplicitTarget, opts: { reason: ImplicitReason; }) => void) | null>;
  sending: boolean;
  setBoardOpen: (open: boolean) => void;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setChatError: React.Dispatch<React.SetStateAction<ChatError | null>>;
  setCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setComposerPrefill: React.Dispatch<React.SetStateAction<{ text: string; nonce: number; } | null>>;
  setMessageFeedback: React.Dispatch<React.SetStateAction<FeedbackContext | null>>;
  setMessageReplyTarget: React.Dispatch<React.SetStateAction<{ sessionId: string; quote: { text: string; messageId: string; role: "user" | "assistant"; }; } | null>>;
  setModelPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSaveToProject: React.Dispatch<React.SetStateAction<SaveToProjectRequest | null>>;
  setStreamText: React.Dispatch<React.SetStateAction<string>>;
  setSubscribeOpenSignal: React.Dispatch<React.SetStateAction<number>>;
  sockRef: React.RefObject<UseChatSocket | null>;
  stopRef: React.RefObject<boolean>;
  stoppedTurnRef: React.RefObject<boolean>;
  toast: ToastFn;
};

export function useChatCardActions({
  activeId,
  agent,
  authRef,
  identity,
  chat,
  chipsBoardProjectId,
  chipsProjectName,
  demo,
  loadExactUserMessage,
  messageFeedbackTriggerRef,
  newSession,
  openManage,
  communityBlogEnabled,
  openBlog,
  openPane,
  openSettings,
  regenerate,
  send,
  sendImplicitRatingRef,
  sending,
  setBoardOpen,
  setBusy,
  setChatError,
  setCollapsed,
  setComposerPrefill,
  setMessageFeedback,
  setMessageReplyTarget,
  setModelPickerOpen,
  setSaveToProject,
  setStreamText,
  setSubscribeOpenSignal,
  sockRef,
  stopRef,
  stoppedTurnRef,
  toast,
}: ChatCardActionsInput) {
  const activeSessionRef = useRef(activeId);
  activeSessionRef.current = activeId;
  // 停止当前轮：demo 本地停回放；非 demo 发 inbound.control.stop 并本地收尾。
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); sendImplicitRatingRef, setBusy, setChatError, setStreamText, stopRef, stoppedTurnRef are App useState setter/useRef passed in, stable
  const stopTurnTarget = useCallback((expectedClientMessageId?: string) => {
    // A confirmation may outlive the rendered turn. Check the mutable socket
    // before feedback/local teardown, then carry the same identity to Stop.
    if (!demo && expectedClientMessageId !== undefined &&
      (!activeId || !chat.isSending(activeId) ||
        chat.getSession(activeId)?._activeClientMessageId !== expectedClientMessageId)) return;
    if (demo) {
      stopRef.current = true;
      setBusy(false);
      setStreamText("");
    } else if (activeId) {
      // 隐式负反馈（中途打断）：过秒停窗后 Stop → 对本轮末条 assistant 静默记 implicit down。
      // 现场取消息（chat 已在依赖内），不捕获每帧刷新的 wsMessages。
      const stopTarget = findStopTarget(chat.getMessages(activeId), Date.now());
      if (stopTarget) sendImplicitRatingRef.current?.(stopTarget, { reason: "中途打断" });
      // 本轮由用户主动打断 → 不做完成脉冲高亮（nudge effect 消费该标记后清）。
      stoppedTurnRef.current = true;
      chat.stop(activeId, expectedClientMessageId);
    }
    setChatError(null);
  }, [demo, activeId, chat]);
  // Keep event-facing callbacks argument-free (React may supply a click event).
  const stopTurn = useCallback(() => stopTurnTarget(), [stopTurnTarget]);
  const stopTurnIfCurrent = useCallback((clientMessageId: string) => stopTurnTarget(clientMessageId), [stopTurnTarget]);

  // ── P5 渲染层接线 ──────────────────────────────────────────────────────
  // 媒体签名单一权威：把 api.mediaSign 注入渲染树（demo 无网络 → null）。容器内路径
  // 经此换签名 URL，图片/视频/音频才不停在占位。
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); authRef is App useState setter/useRef passed in, stable
  const signMedia = useCallback(
    (paths: string[]) => api.mediaSign(authRef.current, paths).then((r) => r.urls),
    [],
  );
  // 权限审批回送：绑定当前会话，桥接 useChatSocket.respondPermission。
  // 走稳定 sockRef（非 chat），避免依赖每帧重建的 chat 引用 —— 否则该回调每个流式帧
  // 都换新引用，会击穿 MessageRenderer 的 memo（防闪失效，全列表逐帧重渲）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); sockRef is App useState setter/useRef passed in, stable
  const onRespondPermission = useCallback(
    (p: { requestId: string; behavior: "allow" | "deny"; message?: string; updatedInput?: Record<string, unknown> }) => {
      if (!activeId) return;
      sockRef.current?.respondPermission({ sessId: activeId, ...p });
    },
    [activeId],
  );

  // 逐条反馈：打开显式反馈弹窗。上下文发送白名单由 MessageFeedbackDialog 收口，
  // 不再把诊断串静默写入剪贴板。
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); messageFeedbackTriggerRef, setMessageFeedback are App useState setter/useRef passed in, stable
  const onFeedback = useCallback((ctx: FeedbackContext) => {
    messageFeedbackTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMessageFeedback(ctx);
  }, []);
  // 工具卡上下文动作（记忆/技能/定时任务卡上的「打开…」按钮 + 连接器写操作确认卡的
  // 鉴权动作）。稳定引用经 context 注入，不污染 ToolCard 数据契约。demo 无网络 → 不提供
  //（按钮自动隐藏 / 确认卡降级纯展示）。authRef 是稳定 ref，不入依赖。
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); authRef, setCollapsed are App useState setter/useRef passed in, stable
  const toolActions = useMemo(
    () =>
      demo
        ? {}
        : {
            onOpenMemory: () => openManage("memory"),
            onOpenSkills: () => openManage("skills"),
            onOpenTasks: () => openManage("cron"),
            downloadLiteratureArtifact: (artifactId: string) =>
              api.downloadLiteratureArtifact(authRef.current, artifactId),
            literatureArtifactMeta: (artifactId: string) =>
              api.literatureArtifactMeta(authRef.current, artifactId),
            connectorConfirm: {
              getDetail: (id: string) => api.getConnectorConfirmation(authRef.current, id),
              decide: (id: string, decision: "approve" | "deny") =>
                api.decideConnectorConfirmation(authRef.current, id, decision),
            },
            ...(TASKBOARD_ENABLED
              ? {
                  taskApproval: {
                    getTicket: async (id: string) => {
                      const { taskboardApi } = await import("../lib/taskboard");
                      return taskboardApi.getTicket(authRef.current, id);
                    },
                    approve: async (id: string, expectedVersion: number) => {
                      const { taskboardApi } = await import("../lib/taskboard");
                      return taskboardApi.approve(authRef.current, id, expectedVersion);
                    },
                    reject: async (id: string, expectedVersion: number, reason: string) => {
                      const { taskboardApi } = await import("../lib/taskboard");
                      return taskboardApi.reject(authRef.current, id, expectedVersion, reason);
                    },
                  },
                  onOpenTaskboard: () => {
                    setCollapsed(false);
                    setBoardOpen(true);
                  },
                }
              : {}),
            ...(communityBlogEnabled && authRef.current.snapshot().token
              ? {
                  communityBlog: {
                    precheck: (draft: BlogDraft) =>
                      api.precheckCommunityTutorial(authRef.current, draft),
                    readContainerImage: async (path: string) => {
                      const url = (await api.mediaSign(authRef.current, [path])).urls[path];
                      if (!url) throw new Error("图片签名失败");
                      const res = await fetch(url);
                      if (!res.ok) throw new Error(`读取图片失败（${res.status}）`);
                      return res.blob();
                    },
                    uploadImage: (image: Blob) => api.uploadTutorialImage(authRef.current, image),
                    submit: (draft: BlogDraft) => api.submitCommunityTutorial(authRef.current, draft),
                    getMine: (id: string) => api.getMyCommunityTutorial(authRef.current, id),
                    postUrl: (id: string) =>
                      `${window.location.origin}${tutorialHref(window.location, null, null, id, { tab: "blog" })}`,
                    openPost: (id: string) => {
                      if (authRef.current.snapshot().token) openBlog({ kind: "post", id });
                    },
                    openMine: () => {
                      if (authRef.current.snapshot().token) openBlog({ kind: "mine" });
                    },
                    openEditor: (seed: BlogDraft) => {
                      if (authRef.current.snapshot().token) openBlog({ kind: "editor", seed });
                    },
                  },
                }
              : {}),
          },
    [demo, openManage, setBoardOpen, communityBlogEnabled, openBlog],
  );

  // 对话交互(```options 选择卡片等):点选即替用户发送。demo 不给发送能力(纯展示),
  // 但带上 reason 让交互块说清「演示模式仅供浏览」,而不是笼统的「此会话中不可交互」(misc-p3 D-08)。
  const chatInteraction = useMemo<ChatInteraction>(
    () => (demo ? { reason: "demo" } : { sendUserText: (t: string) => send(t), busy: sending }),
    [demo, send, sending],
  );

  // 产物详情列 open 回调:引用稳定,不随面板开合变化,避免打穿 MessageList 的 sig-memo。
  const artifactInspect = useMemo(
    () => ({
      // 浏览器操作(OCV5-374)进「浏览器」页看截图和整轮操作记录;其余工具进步骤详情。
      open: (t: ArtifactInspectTarget) => openPane(isBrowserStepMessage(t.message) ? "browser" : "steps", t.message),
      openPane: (tab: PaneTab, message?: ToolLike | null) => openPane(tab, message),
    }),
    [openPane],
  );

  // 发送失败重试：复用原消息 payload（含附件引用）走 WS service 既有发送收口原地重发；
  // model/teamMode/effort 由 socket 复用失败首发的 routing 快照,不读取当前偏好。
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); sockRef is App useState setter/useRef passed in, stable
  const retrySend = useCallback(
    async (msg: ChatMessage) => {
      if (demo || !activeId) return;
      const exact = await loadExactUserMessage(msg);
      if (!exact) {
        toast("原始消息加载失败，请重试", "error");
        return;
      }
      // A deferred red-card CTA was admitted only when the sidecar recorded
      // complete routing/media evidence. Re-check the decoded row before
      // dispatch so a corrupt/mismatched payload can never degrade to text-only.
      if (msg._userPayloadDeferred === true && !preciseRetryEligible(exact)) {
        toast("原消息的完整重试信息不可用，请使用重新生成", "error");
        return;
      }
      sockRef.current?.retryMessage({
        sessId: activeId,
        msgId: msg.id,
        agentId: agent.id,
        sourceOverride: exact,
      });
    },
    [demo, activeId, agent.id, loadExactUserMessage, toast],
  );

  // 红卡 CTA 硬门(任务④ / Codex 审计 R4)的精确重试目标解析:按 assistant 错误行的
  // _clientMessageId 在当前会话里定位可**原样重发**的 user 行。现场取 messages(稳定句柄 sockRef,
  // 不捕获每帧刷新的 wsMessages),与 retrySend 同 deps(仅随会话切换变)。资格三条:
  //   (a) 该 user 行存在且 status='error'(有完整 payload、确实失败);
  //   (b)(c) 自带 _routing 快照 + 附件重发证据仍在 —— 见 preciseRetryEligible(与 retryMessage
  //   实际读取的字段严格对齐,防止借用别轮 _lastRouting / 静默丢附件)。任一不满足 → 返回
  //   undefined,红卡落回 onRegenerate 兜底(见 AssistantCard 的 R5 末轮门控)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); sockRef is App useState setter/useRef passed in, stable
  const resolveRetryTarget = useCallback(
    (clientMessageId: string): ChatMessage | undefined => {
      if (demo || !activeId) return undefined;
      const msgs = sockRef.current?.getMessages(activeId) ?? [];
      const target = msgs.find(
        (m) => m.role === "user" && m.id === clientMessageId && m.status === "error",
      );
      return target && preciseRetryEligible(target) ? target : undefined;
    },
    [demo, activeId],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); sockRef is App useState setter/useRef passed in, stable
  const resolveInterruptedContinuation = useCallback(
    (error: ChatMessage): ChatMessage | undefined => {
      if (demo || !activeId) return undefined;
      const msgs = sockRef.current?.getMessages(activeId) ?? [];
      return manualTaskContinuationSource(msgs, error);
    },
    [demo, activeId],
  );

  const loadExactOrToast = useCallback(async (message: ChatMessage) => {
    const exact = await loadExactUserMessage(message);
    if (!exact) toast("原始消息加载失败，请重试", "error");
    return exact;
  }, [loadExactUserMessage, toast]);

  const pendingContinuations = useRef(new Set<string>());
  const continueInterrupted = useCallback(
    async (error: ChatMessage) => {
      if (demo || !activeId || activeSessionRef.current !== activeId) return;
      if (!identity || !identityIsCurrent(identity, authRef.current)) return;
      const sock = sockRef.current;
      const rows = sock?.getMessages(activeId) ?? [];
      const canonical = canonicalTaskContinuationError(rows, error);
      const source = canonical && manualTaskContinuationSource(rows, error);
      if (!sock || !source || !canonical) return;
      const key = `${activeId}\0${source.id}`;
      if (pendingContinuations.current.has(key)) return;
      pendingContinuations.current.add(key);
      try {
        if (interruptedContinuationTarget(rows, canonical, activeId)) {
          sock.continueInterruptedTurn({ sessId: activeId, errorMessageId: canonical.id, agentId: agent.id });
          return;
        }
        const exact = await loadExactOrToast(source);
        if (!exact || !identityIsCurrent(identity, authRef.current) || activeSessionRef.current !== activeId || sockRef.current !== sock ||
          manualTaskContinuationSource(sock.getMessages(activeId), error)?.id !== source.id) return;
        const replay = exactUserReplayPayload(exact);
        // Explicit human follow-up uses the normal admission/credit/auth gates.
        // It neither deletes old content nor resends an executed task.
        const text = taskContinuationPrompt(replay.text);
        const routing = exact._routing;
        if (routing) {
          await sock.send({
            sessId: activeId, agentId: agent.id, text, media: replay.media, displayText: "继续",
            model: routing.model, teamMode: routing.teamMode, effortLevel: routing.effortLevel,
            collabMode: routing.collabMode, advisorModel: routing.advisorModel,
            collabConfigVersion: routing.collabConfigVersion,
            contextTier: routing.contextTier, serviceTier: routing.serviceTier,
          });
        } else {
          await send(text, replay.media, undefined, "继续", undefined, { sessionId: activeId });
        }
      } finally {
        pendingContinuations.current.delete(key);
      }
    },
    [demo, activeId, agent.id, authRef, identity, loadExactOrToast, send, sockRef],
  );

  // 卡片回调集（稳定引用：作为 MessageRenderer memo 比较键之一，避免无谓重渲）。
  // True tape process paging + oversized-record loading. Hook methods are stable;
  // demo/readonly surfaces leave the cursor disabled rather than inventing content.
  const {
    fetchTapeRecordPayload,
    peekTapeRecordPayload,
    fetchUserMessagePayload,
    peekUserMessagePayload,
  } = chat;
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps verbatim from App() (OCV5-472); authRef, setComposerPrefill, setMessageReplyTarget, setModelPickerOpen, setSaveToProject, setSubscribeOpenSignal, sockRef are App useState setter/useRef passed in, stable
  const cardCallbacks: CardCallbacks = useMemo(
    () => ({
      onRegenerate: regenerate,
      onContinue: () => send(CONTINUE_PROMPT),
      onTopUp: demo
        ? undefined
        : () => {
            openSettings("account");
            setSubscribeOpenSignal((n) => n + 1);
          },
      onStartNewSession: demo ? undefined : newSession,
      onFeedback,
      onFirstTextPaint: demo
        ? undefined
        : (input) => {
            reportClientFriction({
              surface: "webchat",
              stage: "first_text_paint",
              code: input.backgroundAtFrame
                ? "FIRST_TEXT_PAINT_AFTER_BACKGROUND"
                : "FIRST_TEXT_PAINT",
              outcome: "succeeded",
              latencyMs: input.latencyMs,
              traceId: input.traceId,
              sessionId: input.sessionId,
            }, authRef.current?.snapshot().token);
          },
      onTimelineBlank: demo
        ? undefined
        : ({ sessionId, report }) => {
            // Bounded counters only; the full geometry stays in localStorage
            // (`oc.timelineBlank.last`) / `window.__ocTimelineDump()` for the
            // user to hand over when the blank shows up again.
            const snap = report.snapshot;
            reportClientFriction({
              surface: "webchat",
              stage: "timeline_paint",
              code: `TIMELINE_BLANK_${report.classification.toUpperCase()}`,
              outcome: "failed",
              attempts: snap.rowsMounted,
              latencyMs: Math.max(0, Math.round(snap.distBottom)),
              sessionId,
            }, authRef.current?.snapshot().token);
            if (typeof console !== "undefined") {
              console.warn("[oc-timeline] blank viewport detected", report.classification, snap);
            }
          },
      onRetrySend: demo ? undefined : retrySend,
      onEditResend: (m) => setComposerPrefill({ text: m.text || "", nonce: Date.now() }),
      onEditQueued: (m) => {
        const text = activeId
          ? (sockRef.current?.editQueuedMessage(activeId, m.id) ?? m.text ?? "")
          : (m.text || "");
        setComposerPrefill({ text, nonce: Date.now() });
      },
      onDeleteQueued: (m) => {
        if (!activeId) return;
        sockRef.current?.discardQueuedMessage(activeId, m.id);
      },
      onSendQueuedNow: (m) => {
        if (!activeId) return;
        sockRef.current?.sendQueuedNow(activeId, m.id);
      },
      onOpenModelPicker: () => setModelPickerOpen(true),
      onContinueInterrupted: demo ? undefined : continueInterrupted,
      resolveInterruptedContinuation: demo ? undefined : resolveInterruptedContinuation,
      onQuote: demo || !activeId
        ? undefined
        : (message) => {
            if (message.role !== "user" && message.role !== "assistant") return;
            const text = replyQuoteText(message);
            if (!text) return;
            const quote = normalizeMessageReplyQuote({
              messageId: message.id,
              role: message.role,
              text,
            });
            if (!quote) return;
            setMessageReplyTarget({
              sessionId: activeId,
              quote,
            });
          },
      onFetchTapeRecordPayload: demo
        ? undefined
        : (tapeId, recordOrdinal, expected, signal) =>
            fetchTapeRecordPayload(activeId, tapeId, recordOrdinal, expected, signal),
      onPeekTapeRecordPayload: demo
        ? undefined
        : (tapeId, recordOrdinal, expected) =>
            peekTapeRecordPayload(activeId, tapeId, recordOrdinal, expected),
      onFetchUserMessagePayload: demo
        ? undefined
        : (messageId, expected, signal) =>
            fetchUserMessagePayload(activeId, messageId, expected, signal),
      onPeekUserMessagePayload: demo
        ? undefined
        : (messageId, expected) =>
            peekUserMessagePayload(activeId, messageId, expected),
      resolveRetryTarget: demo ? undefined : resolveRetryTarget,
      onSaveToProject:
        chipsBoardProjectId && activeId
          ? (message, kind) => {
              const text = (message.text ?? "").trim();
              if (!text) return;
              const a = authRef.current;
              setSaveToProject({
                kind,
                text,
                sessionId: activeId,
                boardProjectId: chipsBoardProjectId,
                projectName: chipsProjectName,
                auth: a,
                epoch: a.snapshot().epoch,
                nonce: Date.now(),
              });
            }
          : undefined,
    }),
    [
      regenerate,
      send,
      demo,
      openSettings,
      newSession,
      onFeedback,
      retrySend,
      continueInterrupted,
      resolveInterruptedContinuation,
      activeId,
      fetchTapeRecordPayload,
      peekTapeRecordPayload,
      fetchUserMessagePayload,
      peekUserMessagePayload,
      resolveRetryTarget,
      chipsBoardProjectId,
      chipsProjectName,
    ],
  );

  return {
    artifactInspect,
    cardCallbacks,
    chatInteraction,
    onRespondPermission,
    signMedia,
    stopTurn,
    stopTurnIfCurrent,
    toolActions,
  };
}
