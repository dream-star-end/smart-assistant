import {
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  Link2,
  Loader2,
  MessageCircleQuestion,
  Minimize2,
  RotateCcw,
  Square,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UseChatSocket } from "../../hooks/useChatSocket";
import type { AuthorizeSwitch } from "../../hooks/useModelSwitchCost";
import type { Agent } from "../../lib/agents";
import { api } from "../../lib/api";
import { mintMsgId, type ChatMessage } from "../../lib/chat/model";
import { CONTINUE_PROMPT } from "../../lib/chat/render";
import { preciseRetryEligible } from "../../lib/chat/socket";
import { demoReply } from "../../lib/demo";
import { isDialogLayerOpen } from "../../lib/hotkeys";
import {
  cleanQuickAskTitle,
  genQuickAskSessionId,
  QUICK_ASK_TITLE_PREFIX,
} from "../../lib/quickAskSession";
import type { AuthSession, PublicModel, Session, User } from "../../lib/types";
import { cn } from "../../lib/utils";
import { MessageList } from "../MessageRenderer";
import { modelLabel } from "../ModelSelector";
import { ChatInteractionContext, type ChatInteraction } from "../tool/context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  IconButton,
} from "../ui";
import type { CardCallbacks } from "./cards";
import type { PermissionRespond } from "./permissionPromptState";

const QUICK_ASK_MODEL_STORAGE_KEY = "oc.quickAsk.model";
const QUICK_ASK_LANES_STORAGE_PREFIX = "oc.quickAsk.lanes.";
const MAX_STORED_LANES = 32;
const MAX_CONTEXT_PREFIX_CHARS = 1200;
const DEFAULT_LANE_KEY = "__draft__";

export const FAST_MODEL_PRIORITY = [
  "deepseek-v4-flash",
  "gpt-6-luna",
  "antigravity-gemini-4-hydrogen",
  "box-claude-haiku-5-5",
  "mimo-v2.6-flash-go",
  "glm-5.3-flash-go",
  "minimax-m3.1-flash-free-go",
  "cursor-grok-4.7-low-fast",
] as const;

export function pickDefaultQuickAskModel(
  models: PublicModel[],
  mainlineModelId?: string,
  savedModelId?: string | null,
): string | undefined {
  const healthy = models.filter((m) => !m.degraded);
  if (savedModelId && healthy.some((m) => m.id === savedModelId)) {
    return savedModelId;
  }
  for (const candidate of FAST_MODEL_PRIORITY) {
    if (healthy.some((m) => m.id === candidate)) return candidate;
  }
  const fastFallback = healthy.find((m) => /flash|haiku|luna|hydrogen|fast|mini/i.test(m.id));
  if (fastFallback) return fastFallback.id;
  if (mainlineModelId && healthy.some((m) => m.id === mainlineModelId)) return mainlineModelId;
  return healthy[0]?.id ?? models[0]?.id ?? mainlineModelId;
}

function clipText(raw: string | undefined, max: number): string {
  const normalized = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(1, max - 1))}…`;
}

function isDefaultSessionTitle(title: string | undefined): boolean {
  const t = (title ?? "").trim();
  return !t || t === "新对话" || t === "新会话";
}

function extractErrorSummary(m: ChatMessage): string | null {
  if (m._errorCardSnapshot?.disposition === "card") {
    return m._errorCardSnapshot.message || m._errorCardSnapshot.title || null;
  }
  if (m._userError?.message) return m._userError.message;
  if (m._errorCode) return m._errorCode;
  return null;
}

export function buildMainlineContextPrefix(p: {
  title?: string;
  goalObjective?: string;
  messages: ChatMessage[];
}): string {
  const parts: string[] = [];
  const title = clipText(p.title, 80);
  if (title && !isDefaultSessionTitle(title)) parts.push(`会话标题：${title}`);
  const goal = clipText(p.goalObjective, 160);
  if (goal) parts.push(`当前目标：${goal}`);

  let lastUserText = "";
  let lastAssistantSummary = "";
  let lastToolSummary = "";
  for (let i = p.messages.length - 1; i >= 0; i -= 1) {
    const m = p.messages[i];
    if (!m) continue;
    if (!lastUserText && m.role === "user" && !m._recoveryOfClientMessageId) {
      const txt = clipText(m.text, 450);
      if (txt) lastUserText = txt;
    }
    if (!lastAssistantSummary && m.role === "assistant") {
      const err = extractErrorSummary(m);
      const txt = clipText(m.text, 450);
      if (err && txt) lastAssistantSummary = `${txt}（报错：${clipText(err, 160)}）`;
      else if (err) lastAssistantSummary = `报错：${clipText(err, 450)}`;
      else if (txt) lastAssistantSummary = txt;
    }
    if (!lastToolSummary && m.role === "tool") {
      const t = clipText(m.toolName || m.text, 120);
      if (t) lastToolSummary = t;
    }
    if (lastUserText && lastAssistantSummary) break;
  }

  if (lastUserText) parts.push(`最近提问：${lastUserText}`);
  if (lastAssistantSummary) parts.push(`最近进展：${lastAssistantSummary}`);
  else if (lastToolSummary) parts.push(`最近步骤：${lastToolSummary}`);

  if (parts.length === 0) return "";
  const header =
    "[以下为当前主线会话的只读背景摘要，仅供回答本次支线快问参考；请勿改动主线状态，优先简洁直接作答]\n";
  const footer = "\n---\n问题：";
  const budget = Math.max(80, MAX_CONTEXT_PREFIX_CHARS - header.length - footer.length);
  const rawBody = parts.join("\n");
  const body = rawBody.length <= budget ? rawBody : `${rawBody.slice(0, budget - 1)}…`;
  return `${header}${body}${footer}`;
}

function readSavedQuickAskModel(): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(QUICK_ASK_MODEL_STORAGE_KEY) : null;
  } catch {
    return null;
  }
}

function writeSavedQuickAskModel(modelId: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(QUICK_ASK_MODEL_STORAGE_KEY, modelId);
    }
  } catch {
    /* ignore storage unavailable */
  }
}

type LaneState = {
  qaSessId: string;
  draft: string;
  lastInjectedContext: string;
  lastSentModel?: string;
  demoMessages: ChatMessage[];
};

function createLaneState(qaSessId?: string): LaneState {
  return {
    qaSessId: qaSessId ?? genQuickAskSessionId(),
    draft: "",
    lastInjectedContext: "",
    lastSentModel: undefined,
    demoMessages: [],
  };
}

function lanesStorageKey(userId: string | null | undefined): string {
  return `${QUICK_ASK_LANES_STORAGE_PREFIX}${userId ?? "anon"}`;
}

function loadStoredLaneIds(userId: string | null | undefined): Record<string, string> {
  try {
    if (typeof sessionStorage === "undefined") return {};
    const raw = sessionStorage.getItem(lanesStorageKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === "string" && typeof v === "string" && v.startsWith("webqa_")) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveStoredLaneIds(userId: string | null | undefined, lanes: Record<string, LaneState>): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    const entries = Object.entries(lanes)
      .slice(-MAX_STORED_LANES)
      .map(([k, v]) => [k, v.qaSessId] as const);
    sessionStorage.setItem(lanesStorageKey(userId), JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* ignore storage unavailable */
  }
}

function initLanesForUser(userId: string | null | undefined, activeLaneKey: string): Record<string, LaneState> {
  const stored = loadStoredLaneIds(userId);
  const out: Record<string, LaneState> = {};
  for (const [k, id] of Object.entries(stored)) {
    out[k] = createLaneState(id);
  }
  if (!out[activeLaneKey]) {
    out[activeLaneKey] = createLaneState();
  }
  return out;
}

export type QuickAskWindowProps = {
  open: boolean;
  onClose: () => void;
  onSendingChange?: (sending: boolean) => void;
  seed: { text: string; nonce: number } | null;
  chat: UseChatSocket;
  authRef: React.RefObject<AuthSession>;
  user: User | null;
  demo: boolean;
  agent: Agent;
  models: PublicModel[];
  mainlineSessionId?: string;
  mainlineModelId?: string;
  authorizeSwitch?: AuthorizeSwitch;
  mainlineTitle?: string;
  mainlineGoalObjective?: string;
  mainlineMessages: ChatMessage[];
  rightOffsetPx?: number;
  isMdViewport?: boolean;
  onPromoteSession: (sess: Session, demoMessages?: ChatMessage[]) => void;
};

export function QuickAskWindow({
  open,
  onClose,
  onSendingChange,
  seed,
  chat,
  authRef,
  user,
  demo,
  models,
  mainlineSessionId,
  mainlineModelId,
  authorizeSwitch,
  mainlineTitle,
  mainlineGoalObjective,
  mainlineMessages,
  rightOffsetPx = 16,
  isMdViewport = true,
  onPromoteSession,
}: QuickAskWindowProps) {
  const laneKey = mainlineSessionId?.trim() || DEFAULT_LANE_KEY;
  const userId = user?.id ?? null;

  const [lanes, setLanes] = useState<Record<string, LaneState>>(() =>
    initLanesForUser(userId, laneKey),
  );
  const [selectedModel, setSelectedModel] = useState<string | null>(() => readSavedQuickAskModel());
  const [authorizing, setAuthorizing] = useState(false);
  const [demoBusyLanes, setDemoBusyLanes] = useState<Record<string, boolean>>({});

  const demoAbortRef = useRef<Record<string, boolean>>({});
  const demoTimersRef = useRef<Record<string, number>>({});
  const pendingDeleteIdsRef = useRef<Set<string>>(new Set());
  const lastHandledSeedRef = useRef(0);
  const prevUserIdRef = useRef<string | null>(userId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const pinnedToBottomRef = useRef(true);

  const clearDemoTimer = useCallback((targetLaneKey?: string) => {
    if (targetLaneKey !== undefined) {
      const id = demoTimersRef.current[targetLaneKey];
      if (id !== undefined) {
        window.clearInterval(id);
        delete demoTimersRef.current[targetLaneKey];
      }
      return;
    }
    for (const [k, id] of Object.entries(demoTimersRef.current)) {
      window.clearInterval(id);
      delete demoTimersRef.current[k];
    }
  }, []);

  useEffect(() => () => clearDemoTimer(), [clearDemoTimer]);

  // Reset isolated quick-ask state when signed-in account changes.
  useEffect(() => {
    if (prevUserIdRef.current !== userId) {
      prevUserIdRef.current = userId;
      clearDemoTimer();
      for (const k of Object.keys(demoAbortRef.current)) {
        demoAbortRef.current[k] = true;
      }
      pendingDeleteIdsRef.current.clear();
      setDemoBusyLanes({});
      setLanes(initLanesForUser(userId, laneKey));
      onClose();
    }
  }, [userId, laneKey, clearDemoTimer, onClose]);

  // Ensure the active main-session lane exists and persist tab lane pointers.
  useEffect(() => {
    setLanes((prev) => {
      if (prev[laneKey]) return prev;
      return { ...prev, [laneKey]: createLaneState() };
    });
  }, [laneKey]);

  useEffect(() => {
    saveStoredLaneIds(userId, lanes);
  }, [userId, lanes]);

  const activeLane = lanes[laneKey] ?? createLaneState();
  const qaSessId = activeLane.qaSessId;
  const input = activeLane.draft;

  const setInput = useCallback(
    (next: string | ((cur: string) => string)) => {
      setLanes((prev) => {
        const cur = prev[laneKey] ?? createLaneState();
        const nextDraft = typeof next === "function" ? next(cur.draft) : next;
        if (nextDraft === cur.draft && prev[laneKey]) return prev;
        return { ...prev, [laneKey]: { ...cur, draft: nextDraft } };
      });
    },
    [laneKey],
  );

  // Settle delayed deletes once an in-flight cleared lane receives its stop terminal state.
  useEffect(() => {
    if (demo || pendingDeleteIdsRef.current.size === 0) return;
    for (const id of [...pendingDeleteIdsRef.current]) {
      if (!chat.isSending(id)) {
        pendingDeleteIdsRef.current.delete(id);
        chat.removeSession(id);
        chat.removePersisted(id);
        if (authRef.current) {
          void api.deleteSession(authRef.current, id).catch(() => {});
        }
      }
    }
  }, [demo, chat, chat.version, authRef]);

  const activeModelId = useMemo(
    () => pickDefaultQuickAskModel(models, mainlineModelId, selectedModel),
    [models, mainlineModelId, selectedModel],
  );
  const activeModelObj = useMemo(
    () => models.find((m) => m.id === activeModelId),
    [models, activeModelId],
  );
  const activeModelLabel = activeModelObj ? modelLabel(activeModelObj) : (activeModelId ?? "快问模型");

  const messages = demo ? activeLane.demoMessages : chat.getMessages(qaSessId);
  const sending = demo ? Boolean(demoBusyLanes[laneKey]) : chat.isSending(qaSessId);
  const anyDemoBusy = useMemo(() => Object.values(demoBusyLanes).some(Boolean), [demoBusyLanes]);
  const anyLaneSending = useMemo(
    () =>
      demo
        ? anyDemoBusy
        : Object.values(lanes).some((l) => chat.isSending(l.qaSessId)),
    [demo, anyDemoBusy, lanes, chat, chat.version],
  );

  useEffect(() => {
    onSendingChange?.(anyLaneSending);
  }, [anyLaneSending, onSendingChange]);

  const contextPrefix = useMemo(
    () =>
      buildMainlineContextPrefix({
        title: mainlineTitle,
        goalObjective: mainlineGoalObjective,
        messages: mainlineMessages,
      }),
    [mainlineTitle, mainlineGoalObjective, mainlineMessages],
  );

  const handleStop = useCallback(() => {
    if (demo) {
      demoAbortRef.current[laneKey] = true;
      clearDemoTimer(laneKey);
      setDemoBusyLanes((prev) => ({ ...prev, [laneKey]: false }));
      return;
    }
    chat.stop(qaSessId);
  }, [demo, laneKey, clearDemoTimer, chat, qaSessId]);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el || !open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229 && !isDialogLayerOpen()) {
        e.preventDefault();
        e.stopPropagation();
        if (sending) handleStop();
        else onClose();
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [open, sending, handleStop, onClose]);

  const sendQuestion = useCallback(
    async (rawText: string): Promise<boolean> => {
      const rawQuestion = rawText.trim();
      if (!rawQuestion || sending || authorizing) return false;
      const targetLaneKey = laneKey;
      const targetSessId = qaSessId;
      const model = activeModelId;
      const shouldInjectContext =
        contextPrefix.length > 0 && contextPrefix !== activeLane.lastInjectedContext;
      const finalPrompt = shouldInjectContext ? `${contextPrefix}${rawQuestion}` : rawQuestion;

      if (demo) {
        clearDemoTimer(targetLaneKey);
        demoAbortRef.current[targetLaneKey] = false;
        const now = Date.now();
        const userMsg: ChatMessage = {
          id: mintMsgId(),
          role: "user",
          text: rawQuestion,
          ts: now,
        };
        const assistantId = mintMsgId();
        const full = demoReply(rawQuestion, activeModelLabel);
        setLanes((prev) => {
          const cur = prev[targetLaneKey] ?? createLaneState(targetSessId);
          return {
            ...prev,
            [targetLaneKey]: {
              ...cur,
              lastInjectedContext: shouldInjectContext ? contextPrefix : cur.lastInjectedContext,
              demoMessages: [
                ...cur.demoMessages,
                userMsg,
                { id: assistantId, role: "assistant", text: "", ts: now + 1, _completed: false },
              ],
            },
          };
        });
        setDemoBusyLanes((prev) => ({ ...prev, [targetLaneKey]: true }));
        let cursor = 0;
        demoTimersRef.current[targetLaneKey] = window.setInterval(() => {
          if (demoAbortRef.current[targetLaneKey]) {
            clearDemoTimer(targetLaneKey);
            setDemoBusyLanes((prev) => ({ ...prev, [targetLaneKey]: false }));
            return;
          }
          cursor = Math.min(full.length, cursor + 4);
          const done = cursor >= full.length;
          setLanes((prev) => {
            const cur = prev[targetLaneKey];
            if (!cur) return prev;
            return {
              ...prev,
              [targetLaneKey]: {
                ...cur,
                demoMessages: cur.demoMessages.map((m) =>
                  m.id === assistantId ? { ...m, text: full.slice(0, cursor), _completed: done } : m,
                ),
              },
            };
          });
          if (done) {
            clearDemoTimer(targetLaneKey);
            setDemoBusyLanes((prev) => ({ ...prev, [targetLaneKey]: false }));
          }
        }, 12);
        return true;
      }

      const prevModel =
        activeLane.lastSentModel ?? chat.getSession(targetSessId)?._lastRouting?.model;
      let switchAuthorization: Awaited<ReturnType<AuthorizeSwitch>> | undefined;
      if (messages.length > 0 && prevModel && model && prevModel !== model && authorizeSwitch) {
        setAuthorizing(true);
        try {
          const authz = await authorizeSwitch(
            {
              sessionId: targetSessId,
              requestId: mintMsgId(),
              targetModel: model,
              agentId: "main",
              text: finalPrompt,
              mediaCount: 0,
            },
            { useCachedRequestId: true, allowOfflineQueue: true },
          );
          if (!authz) return false;
          switchAuthorization = authz;
        } finally {
          setAuthorizing(false);
        }
      }

      const initialTitle = `${QUICK_ASK_TITLE_PREFIX}${rawQuestion.replace(/\s+/g, " ").slice(0, 32)}`;
      if (messages.length === 0) {
        chat.ensureSession(targetSessId, "main", initialTitle);
        const existingSess = chat.getSession(targetSessId);
        if (existingSess && isDefaultSessionTitle(existingSess.title)) {
          chat.renameSession(targetSessId, initialTitle);
        }
      } else {
        chat.ensureSession(targetSessId, "main");
      }
      if (model) chat.setSessionModel(targetSessId, model);

      const sent = await chat.send({
        sessId: targetSessId,
        agentId: "main",
        text: finalPrompt,
        ...(finalPrompt !== rawQuestion ? { displayText: rawQuestion } : {}),
        ...(model ? { model } : {}),
        ...(switchAuthorization ? { switchAuthorization } : {}),
      });
      if (sent !== false) {
        setLanes((prev) => {
          const cur = prev[targetLaneKey];
          if (!cur || cur.qaSessId !== targetSessId) return prev;
          return {
            ...prev,
            [targetLaneKey]: {
              ...cur,
              lastSentModel: model,
              lastInjectedContext: shouldInjectContext ? contextPrefix : cur.lastInjectedContext,
            },
          };
        });
        return true;
      }
      return false;
    },
    [
      sending,
      authorizing,
      laneKey,
      qaSessId,
      activeModelId,
      contextPrefix,
      activeLane.lastInjectedContext,
      activeLane.lastSentModel,
      demo,
      clearDemoTimer,
      activeModelLabel,
      chat,
      messages.length,
      authorizeSwitch,
    ],
  );

  // Focus textarea when opened or switched; auto-send non-empty slash seeds if idle.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset/focus trigger on prop or identity change
  useEffect(() => {
    if (!open) return;
    const raf = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(raf);
  }, [open, laneKey]);

  useEffect(() => {
    if (!seed || seed.nonce === lastHandledSeedRef.current) return;
    lastHandledSeedRef.current = seed.nonce;
    const text = seed.text.trim();
    if (!text) return;
    if (!sending && !authorizing) {
      void sendQuestion(text);
    } else {
      setInput((cur) => cur || text);
    }
  }, [seed, sending, authorizing, sendQuestion, setInput]);

  // Auto-scroll isolated quick-ask feed when user is pinned to bottom.
  const lastMsg = messages[messages.length - 1];
  const scrollSignal = `${laneKey}:${qaSessId}:${messages.length}:${lastMsg?.text?.length ?? 0}:${sending ? 1 : 0}`;
  useEffect(() => {
    void scrollSignal;
    const el = scrollRef.current;
    if (!el || !open || !pinnedToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [open, scrollSignal]);

  // Auto-resize textarea cleanly.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 36), 120)}px`;
  }, [input]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    const ok = await sendQuestion(text);
    if (ok) setInput("");
  }, [input, sendQuestion, setInput]);

  const handleClear = useCallback(() => {
    const prevId = qaSessId;
    if (demo) {
      clearDemoTimer(laneKey);
      demoAbortRef.current[laneKey] = true;
      setDemoBusyLanes((prev) => ({ ...prev, [laneKey]: false }));
    } else if (chat.isSending(prevId)) {
      pendingDeleteIdsRef.current.add(prevId);
      chat.stop(prevId);
    } else {
      chat.removeSession(prevId);
      chat.removePersisted(prevId);
      if (authRef.current) {
        void api.deleteSession(authRef.current, prevId).catch(() => {});
      }
    }
    pinnedToBottomRef.current = true;
    setLanes((prev) => ({
      ...prev,
      [laneKey]: createLaneState(),
    }));
  }, [qaSessId, demo, laneKey, clearDemoTimer, chat, authRef]);

  const handlePromote = useCallback(() => {
    if (messages.length === 0 || sending) return;
    const firstUser = messages.find((m) => m.role === "user");
    const sess = demo ? undefined : chat.getSession(qaSessId);
    const title = cleanQuickAskTitle(sess?.title, firstUser?.text);
    const snapshotDemo = demo ? [...messages] : undefined;

    if (!demo) {
      chat.ensureSession(qaSessId, "main", title);
      chat.renameSession(qaSessId, title);
      const authSession = authRef.current;
      void chat
        .ensureServerSession(qaSessId, "main", title)
        .then((ok) => (ok ? api.patchSessionTitle(authSession, qaSessId, title) : undefined))
        .catch(() => {});
    } else {
      clearDemoTimer(laneKey);
      demoAbortRef.current[laneKey] = true;
      setDemoBusyLanes((prev) => ({ ...prev, [laneKey]: false }));
    }

    const promoted: Session = {
      id: qaSessId,
      title,
      ownerUserId: user?.id ?? "self",
      createdAt: sess?.createdAt ?? messages[0]?.ts ?? Date.now(),
      lastAt: Date.now(),
      updatedAt: new Date().toISOString(),
      messageCount: messages.length,
      agentId: "main",
      ...(activeModelId ? { modelId: activeModelId } : {}),
    };

    setLanes((prev) => ({
      ...prev,
      [laneKey]: createLaneState(),
    }));
    onPromoteSession(promoted, snapshotDemo);
  }, [
    messages,
    sending,
    demo,
    chat,
    qaSessId,
    authRef,
    clearDemoTimer,
    laneKey,
    user?.id,
    activeModelId,
    onPromoteSession,
  ]);

  const healthyModels = useMemo(() => models.filter((m) => !m.degraded), [models]);

  const qaChatInteraction = useMemo<ChatInteraction>(
    () =>
      demo
        ? { reason: "demo" }
        : {
            sendUserText: (t: string) => {
              void sendQuestion(t);
            },
            busy: sending,
          },
    [demo, sendQuestion, sending],
  );

  const onRespondPermission = useCallback<PermissionRespond>(
    (p) => {
      if (demo) return;
      chat.respondPermission({ sessId: qaSessId, ...p });
    },
    [demo, chat, qaSessId],
  );

  const qaCardCallbacks = useMemo<CardCallbacks>(
    () => ({
      onContinue: demo ? undefined : () => { void sendQuestion(CONTINUE_PROMPT); },
      onRetrySend: demo
        ? undefined
        : (msg) => {
            chat.retryMessage({ sessId: qaSessId, msgId: msg.id, agentId: "main" });
          },
      resolveRetryTarget: demo
        ? undefined
        : (cmid) => {
            const m = chat
              .getMessages(qaSessId)
              .find((x) => x.role === "user" && x.id === cmid && x.status === "error");
            return m && preciseRetryEligible(m) ? m : undefined;
          },
      onFetchTapeRecordPayload: demo
        ? undefined
        : (tapeId, ord, exp, sig) => chat.fetchTapeRecordPayload(qaSessId, tapeId, ord, exp, sig),
      onPeekTapeRecordPayload: demo
        ? undefined
        : (tapeId, ord, exp) => chat.peekTapeRecordPayload(qaSessId, tapeId, ord, exp),
      onFetchUserMessagePayload: demo
        ? undefined
        : (mid, exp, sig) => chat.fetchUserMessagePayload(qaSessId, mid, exp, sig),
      onPeekUserMessagePayload: demo
        ? undefined
        : (mid, exp) => chat.peekUserMessagePayload(qaSessId, mid, exp),
    }),
    [demo, chat, qaSessId, sendQuestion],
  );

  const qaSess = demo ? undefined : chat.getSession(qaSessId);
  const contextLabel = contextPrefix
    ? `已关联主线：${clipText(!isDefaultSessionTitle(mainlineTitle) ? mainlineTitle : "当前会话", 20)}`
    : "独立支线快问";

  return (
    <section
      ref={sectionRef}
      aria-label="快问小窗"
      data-testid="quick-ask-window"
      data-quick-ask-lane={laneKey}
      data-quick-ask-session={qaSessId}
      style={isMdViewport ? { right: rightOffsetPx } : undefined}
      className={cn(
        "fixed bottom-3 inset-x-3 z-40 flex h-[68dvh] max-h-[560px] flex-col overflow-hidden rounded-xl border border-border-control bg-surface shadow-float",
        "sm:inset-x-auto sm:bottom-4 sm:w-[430px]",
        !open && "hidden",
      )}
    >
      {/* Header */}
      <header className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Zap size={15} className="shrink-0 text-accent" />
          <span className="truncate text-title font-semibold text-fg">快问</span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="quick-ask-model-trigger"
              aria-label="选择快问模型"
              className="ml-1 inline-flex max-w-[165px] items-center gap-1 rounded-full border border-border bg-bg px-2.5 py-1 text-caption font-medium text-muted transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate">{activeModelLabel}</span>
              <ChevronDown size={12} className="shrink-0 text-faint" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-60 overflow-y-auto">
            <DropdownMenuLabel>选择快问模型</DropdownMenuLabel>
            {healthyModels.length === 0 ? (
              <DropdownMenuItem disabled>暂无可选模型</DropdownMenuItem>
            ) : (
              healthyModels.map((m) => (
                <DropdownMenuItem
                  key={m.id}
                  onSelect={() => {
                    setSelectedModel(m.id);
                    writeSavedQuickAskModel(m.id);
                  }}
                >
                  <Check
                    size={14}
                    className={cn("shrink-0 text-accent", m.id !== activeModelId && "opacity-0")}
                  />
                  <span className="min-w-0 flex-1 truncate">{modelLabel(m)}</span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton
            size="sm"
            shape="square"
            aria-label="转为正式对话"
            title="转为正式对话并显示在左侧列表"
            disabled={messages.length === 0 || sending}
            onClick={handlePromote}
          >
            <ArrowUpRight size={15} />
          </IconButton>
          <IconButton
            size="sm"
            shape="square"
            aria-label="清空重问"
            title="清空当前快问，重新开始"
            onClick={handleClear}
          >
            <RotateCcw size={15} />
          </IconButton>
          <IconButton
            size="sm"
            shape="square"
            aria-label="收起快问小窗"
            title="收起 (Esc / Alt+K)"
            onClick={onClose}
          >
            <Minimize2 size={15} />
          </IconButton>
        </div>
      </header>

      {/* Message stream: only mount MessageList while open so PermissionPromptHost never portals modals/bars while collapsed */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 36;
        }}
        className="min-h-0 flex-1 overflow-y-auto [&_[data-testid=timeline-short-list]]:space-y-3 [&_[data-testid=timeline-short-list]]:px-3 [&_[data-testid=timeline-short-list]]:py-3 [&_[data-testid=timeline-footer]]:pb-2 [&_[data-testid=timeline-footer]]:pt-2 [&_[data-testid=pending-permission-dock]]:px-3"
      >
        {open &&
          (messages.length === 0 && !sending ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
              <MessageCircleQuestion size={24} className="text-accent" />
              <p className="text-body font-medium text-fg">并行快问，不打断主线任务</p>
              <p className="text-meta text-muted">
                按当前主会话隔离车道与轻模型快答；也可在主输入框直接发送{" "}
                <span className="font-mono text-fg">/btw 问题</span>
              </p>
            </div>
          ) : (
            <ChatInteractionContext.Provider value={qaChatInteraction}>
              <MessageList
                processDisclosure
                key={qaSessId}
                messages={messages}
                sending={sending}
                liveTurnUsage={qaSess?._liveTurnUsage}
                transientNotice={demo ? null : chat.getTransientNotice(qaSessId)}
                cb={qaCardCallbacks}
                onRespondPermission={onRespondPermission}
                sessionId={qaSessId}
              />
            </ChatInteractionContext.Provider>
          ))}
      </div>

      {/* Footer composer */}
      <footer className="shrink-0 border-t border-border bg-bg/60 px-3 py-2.5">
        <div className="mb-2 flex items-center justify-between gap-2 text-caption text-faint">
          <span
            data-testid="quick-ask-context-hint"
            className="flex min-w-0 items-center gap-1 truncate text-muted"
          >
            <Link2 size={12} className="shrink-0 text-accent" />
            <span className="truncate">{contextLabel}</span>
          </span>
          <span className="shrink-0">不进主历史</span>
        </div>

        <div className="flex items-end gap-2 rounded-lg border border-border-control bg-surface px-2.5 py-1.5 focus-within:border-border-strong">
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                e.nativeEvent.keyCode !== 229
              ) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            placeholder="输入技术问题（Enter 发送）…"
            aria-label="快问输入框"
            className="max-h-28 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-base leading-relaxed text-fg outline-none placeholder:text-faint md:text-sm"
          />
          <button
            type="button"
            aria-label={sending ? "停止快问" : "发送快问"}
            disabled={!sending && (!input.trim() || authorizing)}
            onClick={() => {
              if (sending) handleStop();
              else void handleSubmit();
            }}
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-full transition-colors [@media(hover:none)]:size-11",
              sending
                ? "bg-fg text-bg"
                : input.trim() && !authorizing
                  ? "bg-primary text-primary-fg hover:opacity-90"
                  : "bg-hover text-faint",
            )}
          >
            {authorizing ? (
              <Loader2 size={16} className="animate-spin" />
            ) : sending ? (
              <Square size={14} className="fill-current" />
            ) : (
              <ArrowUp size={17} />
            )}
          </button>
        </div>
      </footer>
    </section>
  );
}
