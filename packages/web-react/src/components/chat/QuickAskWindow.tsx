import {
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  Link2,
  Loader2,
  MessageCircleQuestion,
  Minimize2,
  Quote,
  RotateCcw,
  Square,
  Unlink,
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
import {
  modelCostLabel,
  modelPickerRows,
  resolveContextPickerSelection,
  resolveCursorPickerSelection,
} from "../../lib/cursorModelPicker";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  useConfirm,
} from "../ui";
import type { CardCallbacks } from "./cards";
import type { PermissionRespond } from "./permissionPromptState";

const QUICK_ASK_MODEL_STORAGE_KEY = "oc.quickAsk.model";
const QUICK_ASK_LANES_STORAGE_PREFIX = "oc.quickAsk.lanes.";
const MAX_STORED_LANES = 32;
const MAX_CONTEXT_PREFIX_CHARS = 1200;
const DEFAULT_LANE_KEY = "__draft__";

/**
 * 强模型透明可控红线（OCV5-817）：快问默认继承当前主会话模型，绝不静默黑盒降级至弱模型。
 * 仅在用户显式手动选择了快问模型（savedModelId）且该模型健康时采用用户指定模型；
 * 否则严格沿用 mainlineModelId，主模型不可用/缺失时再按目录顺序回退至首个健康模型。
 */
export function pickDefaultQuickAskModel(
  models: PublicModel[],
  mainlineModelId?: string,
  savedModelId?: string | null,
): string | undefined {
  const healthy = models.filter((m) => !m.degraded);
  if (savedModelId && healthy.some((m) => m.id === savedModelId)) {
    return savedModelId;
  }
  if (mainlineModelId && healthy.some((m) => m.id === mainlineModelId)) {
    return mainlineModelId;
  }
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

function writeSavedQuickAskModel(modelId: string | null): void {
  try {
    if (typeof localStorage !== "undefined") {
      if (modelId) localStorage.setItem(QUICK_ASK_MODEL_STORAGE_KEY, modelId);
      else localStorage.removeItem(QUICK_ASK_MODEL_STORAGE_KEY);
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
  /** 发送快捷键偏好，与主输入框保持一致。 */
  sendKey?: "enter" | "mod-enter";
  /** 将快问回复引用回主输入框（append 模式，不覆盖现有草稿）。 */
  onQuoteToComposer?: (text: string) => void;
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
  sendKey = "enter",
  onQuoteToComposer,
  onPromoteSession,
}: QuickAskWindowProps) {
  const laneKey = mainlineSessionId?.trim() || DEFAULT_LANE_KEY;
  const userId = user?.id ?? null;

  const [lanes, setLanes] = useState<Record<string, LaneState>>(() =>
    initLanesForUser(userId, laneKey),
  );
  const [selectedModel, setSelectedModel] = useState<string | null>(() => readSavedQuickAskModel());
  const [attachContext, setAttachContext] = useState(true);
  const [modelHighlight, setModelHighlight] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [demoBusyLanes, setDemoBusyLanes] = useState<Record<string, boolean>>({});
  const [coarsePointer] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches,
  );
  const [confirmClear, confirmClearEl] = useConfirm();

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
        attachContext && contextPrefix.length > 0 && contextPrefix !== activeLane.lastInjectedContext;
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
      attachContext,
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
    setModelHighlight(true);
    const timer = window.setTimeout(() => setModelHighlight(false), 2400);
    if (!sending && !authorizing) {
      void sendQuestion(text);
    } else {
      setInput((cur) => cur || text);
    }
    return () => window.clearTimeout(timer);
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

  const executeClear = useCallback(() => {
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

  const userTurnCount = useMemo(
    () => messages.filter((m) => m.role === "user").length,
    [messages],
  );

  const handleClear = useCallback(() => {
    if (userTurnCount >= 2) {
      void confirmClear({
        title: "清空当前快问记录？",
        body: `当前快问包含 ${userTurnCount} 轮对话，清空后将无法恢复。如需留存，可先点击右上角「转为正式对话」。`,
        confirmText: "清空重问",
        cancelText: "保留",
        danger: true,
      }).then((ok) => {
        if (ok) executeClear();
      });
      return;
    }
    executeClear();
  }, [userTurnCount, confirmClear, executeClear]);

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
  const groupedPickerRows = useMemo(() => modelPickerRows(healthyModels), [healthyModels]);
  const activeCostLabel = modelCostLabel(activeModelObj);
  const followingMainline = !selectedModel && Boolean(mainlineModelId && activeModelId === mainlineModelId);

  const latestAssistantReply = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m && m.role === "assistant" && m.text?.trim() && !m._errorCode) return m;
    }
    return null;
  }, [messages]);

  const quoteTextToMainline = useCallback(
    (rawText: string) => {
      if (!onQuoteToComposer) return;
      const trimmed = rawText.trim();
      if (!trimmed) return;
      onQuoteToComposer(`> [快问摘录]\n> ${trimmed.replace(/\n/g, "\n> ")}`);
    },
    [onQuoteToComposer],
  );

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
      onQuote: onQuoteToComposer
        ? (msg) => {
            if (msg.text?.trim()) quoteTextToMainline(msg.text);
          }
        : undefined,
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
    [demo, chat, qaSessId, sendQuestion, onQuoteToComposer, quoteTextToMainline],
  );

  const qaSess = demo ? undefined : chat.getSession(qaSessId);
  const hasMainlineContext = contextPrefix.length > 0;
  const contextLabel = !hasMainlineContext
    ? "独立支线快问"
    : attachContext
      ? `已关联主线：${clipText(!isDefaultSessionTitle(mainlineTitle) ? mainlineTitle : "当前会话", 20)}`
      : "已断开主线上下文";

  return (
    <>
    <section
      ref={sectionRef}
      aria-label="快问小窗"
      data-testid="quick-ask-window"
      data-quick-ask-lane={laneKey}
      data-quick-ask-session={qaSessId}
      style={isMdViewport ? { right: rightOffsetPx } : undefined}
      className={cn(
        "fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 flex h-[min(68dvh,calc(var(--oc-visual-height,100dvh)-1.5rem))] max-h-[min(560px,calc(var(--oc-visual-height,100dvh)-1.5rem))] flex-col overflow-hidden rounded-xl border border-border bg-elevated shadow-float",
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
              data-model-highlight={modelHighlight ? "true" : undefined}
              aria-label="选择快问模型"
              title={followingMainline ? `跟随主会话模型：${activeModelLabel}` : `当前快问模型：${activeModelLabel}`}
              className={cn(
                "ml-1 inline-flex max-w-[195px] items-center gap-1 rounded-full border px-2.5 py-1 text-caption font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11",
                modelHighlight
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border bg-bg text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <span className="truncate">{activeModelLabel}</span>
              {activeCostLabel && (
                <span className="shrink-0 tabular-nums text-faint">{activeCostLabel}</span>
              )}
              <ChevronDown size={12} className="shrink-0 text-faint" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-64 overflow-y-auto">
            <DropdownMenuLabel>选择快问模型</DropdownMenuLabel>
            {mainlineModelId && healthyModels.some((m) => m.id === mainlineModelId) && (
              <>
                <DropdownMenuItem
                  data-quick-ask-follow-mainline="true"
                  onSelect={() => {
                    setSelectedModel(null);
                    writeSavedQuickAskModel(null);
                  }}
                >
                  <Check
                    size={14}
                    className={cn("shrink-0 text-accent", !followingMainline && "opacity-0")}
                  />
                  <span className="min-w-0 flex-1 truncate">跟随主会话模型</span>
                  <span className="shrink-0 text-caption text-faint">默认</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            {groupedPickerRows.length === 0 ? (
              <DropdownMenuItem disabled>暂无可选模型</DropdownMenuItem>
            ) : (
              groupedPickerRows.map((row) => {
                if (row.kind === "plain") {
                  const m = row.model;
                  const cost = modelCostLabel(m);
                  return (
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
                      {cost && <span className="shrink-0 tabular-nums text-caption text-faint">{cost}</span>}
                    </DropdownMenuItem>
                  );
                }
                if (row.kind === "cursor-family") {
                  const repId =
                    resolveCursorPickerSelection(row.row.members, row.row.family, activeModelId) ??
                    row.row.members[0]?.id;
                  const rep = row.row.members.find((m) => m.id === repId);
                  if (!rep) return null;
                  const cost = modelCostLabel(rep);
                  const active = row.row.members.some((m) => m.id === activeModelId);
                  return (
                    <DropdownMenuItem
                      key={`cursor-${row.row.family}`}
                      onSelect={() => {
                        setSelectedModel(rep.id);
                        writeSavedQuickAskModel(rep.id);
                      }}
                    >
                      <Check
                        size={14}
                        className={cn("shrink-0 text-accent", !active && "opacity-0")}
                      />
                      <span className="min-w-0 flex-1 truncate">{row.row.label}</span>
                      {cost && <span className="shrink-0 tabular-nums text-caption text-faint">{cost}</span>}
                    </DropdownMenuItem>
                  );
                }
                if (row.kind === "context-family") {
                  const repId =
                    resolveContextPickerSelection(row.row.members, row.row.spec, activeModelId) ??
                    row.row.members[0]?.id;
                  const rep = row.row.members.find((m) => m.id === repId);
                  if (!rep) return null;
                  const cost = modelCostLabel(rep);
                  const active = row.row.members.some((m) => m.id === activeModelId);
                  return (
                    <DropdownMenuItem
                      key={`ctx-${row.row.family}`}
                      onSelect={() => {
                        setSelectedModel(rep.id);
                        writeSavedQuickAskModel(rep.id);
                      }}
                    >
                      <Check
                        size={14}
                        className={cn("shrink-0 text-accent", !active && "opacity-0")}
                      />
                      <span className="min-w-0 flex-1 truncate">{row.row.label}</span>
                      {cost && <span className="shrink-0 tabular-nums text-caption text-faint">{cost}</span>}
                    </DropdownMenuItem>
                  );
                }
                if (row.kind === "grok-build-family") {
                  const rep = row.row.members[0];
                  if (!rep) return null;
                  const cost = modelCostLabel(rep);
                  const active = row.row.members.some((m) => m.id === activeModelId);
                  return (
                    <DropdownMenuItem
                      key={`grok-${row.row.family}`}
                      onSelect={() => {
                        setSelectedModel(rep.id);
                        writeSavedQuickAskModel(rep.id);
                      }}
                    >
                      <Check
                        size={14}
                        className={cn("shrink-0 text-accent", !active && "opacity-0")}
                      />
                      <span className="min-w-0 flex-1 truncate">{row.row.label}</span>
                      {cost && <span className="shrink-0 tabular-nums text-caption text-faint">{cost}</span>}
                    </DropdownMenuItem>
                  );
                }
                return null;
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {onQuoteToComposer && latestAssistantReply && !sending && (
            <IconButton
              size="sm"
              shape="square"
              aria-label="引用最新回答到主线"
              title="将最新快问回答引用到主输入框"
              data-testid="quick-ask-quote-mainline"
              onClick={() => quoteTextToMainline(latestAssistantReply.text ?? "")}
            >
              <Quote size={14} />
            </IconButton>
          )}
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
                按当前主会话隔离车道，默认沿用主模型（可随时在上方切换）；也可在主输入框直接发送{" "}
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
          {hasMainlineContext ? (
            <button
              type="button"
              data-testid="quick-ask-context-hint"
              aria-pressed={attachContext}
              title={
                attachContext
                  ? `点击断开主线背景注入\n\n${contextPrefix}`
                  : "当前不注入主线背景，点击重新关联"
              }
              onClick={() => setAttachContext((v) => !v)}
              className={cn(
                "flex min-w-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11",
                attachContext ? "text-muted" : "text-faint line-through",
              )}
            >
              {attachContext ? (
                <Link2 size={12} className="shrink-0 text-accent" />
              ) : (
                <Unlink size={12} className="shrink-0 text-faint" />
              )}
              <span className="truncate">{contextLabel}</span>
            </button>
          ) : (
            <span
              data-testid="quick-ask-context-hint"
              className="flex min-w-0 items-center gap-1 truncate text-muted"
            >
              <Link2 size={12} className="shrink-0 text-accent" />
              <span className="truncate">{contextLabel}</span>
            </span>
          )}
          <span className="shrink-0">不进主历史</span>
        </div>

        <div className="flex items-end gap-2 rounded-lg border border-border-control bg-surface px-2.5 py-1.5 focus-within:border-border-strong">
          <textarea
            ref={textareaRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                if (coarsePointer) return;
                const mod = e.metaKey || e.ctrlKey;
                const shouldSend = sendKey === "mod-enter" ? mod : !e.shiftKey;
                if (!shouldSend) return;
                e.preventDefault();
                void handleSubmit();
              }
            }}
            enterKeyHint={coarsePointer ? "enter" : "send"}
            placeholder={
              coarsePointer
                ? "输入技术问题…"
                : sendKey === "mod-enter"
                  ? "输入技术问题（⌘/Ctrl+Enter 发送）…"
                  : "输入技术问题（Enter 发送）…"
            }
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
    {confirmClearEl}
    </>
  );
}
