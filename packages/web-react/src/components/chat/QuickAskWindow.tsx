import {
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
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
import { demoReply } from "../../lib/demo";
import { isDialogLayerOpen } from "../../lib/hotkeys";
import {
  cleanQuickAskTitle,
  genQuickAskSessionId,
  QUICK_ASK_TITLE_PREFIX,
} from "../../lib/quickAskSession";
import type { AuthSession, PublicModel, Session, User } from "../../lib/types";
import { cn } from "../../lib/utils";
import { Markdown } from "../Markdown";
import { modelLabel } from "../ModelSelector";
import {
  Alert,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  IconButton,
  Switch,
} from "../ui";

const QUICK_ASK_MODEL_STORAGE_KEY = "oc.quickAsk.model";
const MAX_CONTEXT_PREFIX_CHARS = 1200;

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
  if (title && title !== "新对话") parts.push(`会话标题：${title}`);
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
    "[以下为主线会话只读背景摘要，仅供回答本次支线技术问题参考，请简洁直接回答下方问题]\n";
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
  mainlineModelId,
  authorizeSwitch,
  mainlineTitle,
  mainlineGoalObjective,
  mainlineMessages,
  rightOffsetPx = 16,
  isMdViewport = true,
  onPromoteSession,
}: QuickAskWindowProps) {
  const [qaSessId, setQaSessId] = useState(() => genQuickAskSessionId());
  const [selectedModel, setSelectedModel] = useState<string | null>(() => readSavedQuickAskModel());
  const [includeContext, setIncludeContext] = useState(false);
  const [input, setInput] = useState("");
  const [authorizing, setAuthorizing] = useState(false);
  const [demoMessages, setDemoMessages] = useState<ChatMessage[]>([]);
  const [demoBusy, setDemoBusy] = useState(false);

  const demoAbortRef = useRef(false);
  const demoTimerRef = useRef<number | null>(null);
  const lastSentModelRef = useRef<string | undefined>(undefined);
  const lastHandledSeedRef = useRef(0);
  const prevUserIdRef = useRef<string | null>(user?.id ?? null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const pinnedToBottomRef = useRef(true);

  const clearDemoTimer = useCallback(() => {
    if (demoTimerRef.current !== null) {
      window.clearInterval(demoTimerRef.current);
      demoTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearDemoTimer(), [clearDemoTimer]);

  // Reset isolated quick-ask state when signed-in account changes.
  useEffect(() => {
    const uid = user?.id ?? null;
    if (prevUserIdRef.current !== uid) {
      prevUserIdRef.current = uid;
      clearDemoTimer();
      demoAbortRef.current = true;
      setDemoMessages([]);
      setDemoBusy(false);
      setInput("");
      lastSentModelRef.current = undefined;
      setQaSessId(genQuickAskSessionId());
      onClose();
    }
  }, [user?.id, clearDemoTimer, onClose]);

  const activeModelId = useMemo(
    () => pickDefaultQuickAskModel(models, mainlineModelId, selectedModel),
    [models, mainlineModelId, selectedModel],
  );
  const activeModelObj = useMemo(
    () => models.find((m) => m.id === activeModelId),
    [models, activeModelId],
  );
  const activeModelLabel = activeModelObj ? modelLabel(activeModelObj) : (activeModelId ?? "快问模型");

  const messages = demo ? demoMessages : chat.getMessages(qaSessId);
  const sending = demo ? demoBusy : chat.isSending(qaSessId);

  useEffect(() => {
    onSendingChange?.(sending);
  }, [sending, onSendingChange]);

  const handleStop = useCallback(() => {
    if (demo) {
      demoAbortRef.current = true;
      clearDemoTimer();
      setDemoBusy(false);
      return;
    }
    chat.stop(qaSessId);
  }, [demo, clearDemoTimer, chat, qaSessId]);

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
      const model = activeModelId;
      const contextPrefix = includeContext
        ? buildMainlineContextPrefix({
            title: mainlineTitle,
            goalObjective: mainlineGoalObjective,
            messages: mainlineMessages,
          })
        : "";
      const finalPrompt = contextPrefix ? `${contextPrefix}${rawQuestion}` : rawQuestion;

      if (demo) {
        clearDemoTimer();
        demoAbortRef.current = false;
        const now = Date.now();
        const userMsg: ChatMessage = {
          id: mintMsgId(),
          role: "user",
          text: rawQuestion,
          ts: now,
        };
        const assistantId = mintMsgId();
        const full = demoReply(rawQuestion, activeModelLabel);
        setDemoMessages((prev) => [
          ...prev,
          userMsg,
          { id: assistantId, role: "assistant", text: "", ts: now + 1, _completed: false },
        ]);
        setDemoBusy(true);
        let cursor = 0;
        demoTimerRef.current = window.setInterval(() => {
          if (demoAbortRef.current) {
            clearDemoTimer();
            setDemoBusy(false);
            return;
          }
          cursor = Math.min(full.length, cursor + 4);
          const done = cursor >= full.length;
          setDemoMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, text: full.slice(0, cursor), _completed: done } : m,
            ),
          );
          if (done) {
            clearDemoTimer();
            setDemoBusy(false);
          }
        }, 12);
        return true;
      }

      const prevModel = lastSentModelRef.current ?? chat.getSession(qaSessId)?._lastRouting?.model;
      let switchAuthorization: Awaited<ReturnType<AuthorizeSwitch>> | undefined;
      if (messages.length > 0 && prevModel && model && prevModel !== model && authorizeSwitch) {
        setAuthorizing(true);
        try {
          const authz = await authorizeSwitch(
            {
              sessionId: qaSessId,
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
        chat.ensureSession(qaSessId, "main", initialTitle);
        const existingSess = chat.getSession(qaSessId);
        if (existingSess && (!existingSess.title || existingSess.title === "新对话")) {
          chat.renameSession(qaSessId, initialTitle);
        }
      } else {
        chat.ensureSession(qaSessId, "main");
      }
      if (model) chat.setSessionModel(qaSessId, model);

      const sent = await chat.send({
        sessId: qaSessId,
        agentId: "main",
        text: finalPrompt,
        ...(finalPrompt !== rawQuestion ? { displayText: rawQuestion } : {}),
        ...(model ? { model } : {}),
        ...(switchAuthorization ? { switchAuthorization } : {}),
      });
      if (sent !== false) {
        lastSentModelRef.current = model;
        return true;
      }
      return false;
    },
    [
      sending,
      authorizing,
      activeModelId,
      includeContext,
      mainlineTitle,
      mainlineGoalObjective,
      mainlineMessages,
      demo,
      clearDemoTimer,
      activeModelLabel,
      chat,
      qaSessId,
      messages.length,
      authorizeSwitch,
    ],
  );

  // Focus textarea when opened or re-seeded; auto-send non-empty slash seeds if idle.
  useEffect(() => {
    if (!open) return;
    const raf = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(raf);
  }, [open]);

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
  }, [seed, sending, authorizing, sendQuestion]);

  // Auto-scroll isolated quick-ask feed when user is pinned to bottom.
  const lastMsg = messages[messages.length - 1];
  const scrollSignal = `${messages.length}:${lastMsg?.text?.length ?? 0}:${sending ? 1 : 0}`;
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
  }, [input, sendQuestion]);

  const handleClear = useCallback(() => {
    if (sending) handleStop();
    if (demo) {
      clearDemoTimer();
      demoAbortRef.current = true;
      setDemoMessages([]);
      setDemoBusy(false);
    } else {
      const prevId = qaSessId;
      chat.removeSession(prevId);
      chat.removePersisted(prevId);
      if (authRef.current) {
        void api.deleteSession(authRef.current, prevId).catch(() => {});
      }
    }
    lastSentModelRef.current = undefined;
    pinnedToBottomRef.current = true;
    setQaSessId(genQuickAskSessionId());
  }, [sending, handleStop, demo, clearDemoTimer, qaSessId, chat, authRef]);

  const handlePromote = useCallback(() => {
    if (messages.length === 0) return;
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
      clearDemoTimer();
      demoAbortRef.current = true;
      setDemoMessages([]);
      setDemoBusy(false);
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

    lastSentModelRef.current = undefined;
    setQaSessId(genQuickAskSessionId());
    onPromoteSession(promoted, snapshotDemo);
  }, [
    messages,
    demo,
    chat,
    qaSessId,
    authRef,
    clearDemoTimer,
    user?.id,
    activeModelId,
    onPromoteSession,
  ]);

  const healthyModels = useMemo(() => models.filter((m) => !m.degraded), [models]);

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === "assistant") return messages[i].id;
    }
    return undefined;
  }, [messages]);

  const waitingForFirstChunk =
    sending &&
    messages.length > 0 &&
    messages[messages.length - 1]?.role === "user";

  return (
    <section
      ref={sectionRef}
      aria-label="快问小窗"
      data-testid="quick-ask-window"
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
            disabled={messages.length === 0}
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

      {/* Message stream */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 36;
        }}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <MessageCircleQuestion size={24} className="text-accent" />
            <p className="text-body font-medium text-fg">并行快问，不打断主线任务</p>
            <p className="text-meta text-muted">
              独立会话车道与轻模型快答；也可在主输入框直接发送 <span className="font-mono text-fg">/btw 问题</span>
            </p>
          </div>
        ) : (
          messages.map((msg, idx) => {
            if (msg.role === "user") {
              return (
                <div key={msg.id} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm bg-bubble px-3 py-2 text-body text-fg">
                    {msg.text}
                  </div>
                </div>
              );
            }

            if (msg.role === "tool") {
              return (
                <div
                  key={msg.id}
                  className="flex items-center gap-1.5 text-caption text-muted"
                >
                  {msg._completed ? (
                    <Check size={12} className="shrink-0 text-success" />
                  ) : (
                    <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
                  )}
                  <span className="truncate">{msg.toolName || msg.text || "执行步骤"}</span>
                </div>
              );
            }

            if (msg.role === "assistant") {
              if (msg._errorCardSnapshot?.disposition === "silent") return null;
              const isError =
                msg._errorCardSnapshot?.disposition === "card" || Boolean(msg._errorCode);
              if (isError) {
                const errTitle =
                  msg._errorCardSnapshot?.disposition === "card"
                    ? msg._errorCardSnapshot.title
                    : "回答失败";
                const errBody =
                  msg._errorCardSnapshot?.disposition === "card"
                    ? msg._errorCardSnapshot.message
                    : msg._userError?.message || msg._errorCode || "请求失败，请重试";
                let ownerUserId = msg._clientMessageId;
                if (!ownerUserId) {
                  for (let j = idx - 1; j >= 0; j -= 1) {
                    if (messages[j]?.role === "user") {
                      ownerUserId = messages[j].id;
                      break;
                    }
                  }
                }
                return (
                  <div key={msg.id} className="space-y-2">
                    {msg.text && (
                      <div className="text-body text-fg">
                        <Markdown signMedia={!demo}>{msg.text}</Markdown>
                      </div>
                    )}
                    <Alert
                      tone="danger"
                      density="compact"
                      title={errTitle}
                      action={
                        !demo && ownerUserId && !sending ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              chat.retryMessage({
                                sessId: qaSessId,
                                msgId: ownerUserId,
                                agentId: "main",
                              })
                            }
                          >
                            重试
                          </Button>
                        ) : undefined
                      }
                    >
                      {errBody}
                    </Alert>
                  </div>
                );
              }
              if (!msg.text) return null;
              return (
                <div key={msg.id} className="text-body text-fg">
                  <Markdown
                    live={!msg._completed}
                    caret={sending && msg.id === lastAssistantId}
                    signMedia={!demo}
                  >
                    {msg.text}
                  </Markdown>
                </div>
              );
            }

            if (msg.role === "system" && msg._turnStatusRecord) {
              return (
                <Alert key={msg.id} tone="danger" density="compact">
                  {msg._userError?.message || msg.text || "请求未完成"}
                </Alert>
              );
            }
            return null;
          })
        )}

        {waitingForFirstChunk && (
          <div className="flex items-center gap-2 text-meta text-muted" role="status">
            <Loader2 size={14} className="animate-spin text-accent" />
            <span>{activeModelLabel} 正在思考…</span>
          </div>
        )}
      </div>

      {/* Footer composer */}
      <footer className="shrink-0 border-t border-border bg-bg/60 px-3 py-2.5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-meta text-muted">
            <Switch
              checked={includeContext}
              onCheckedChange={setIncludeContext}
              aria-label="附带主线摘要"
            />
            <span>附带主线只读摘要</span>
          </label>
          <span className="text-caption text-faint">不进主历史</span>
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
