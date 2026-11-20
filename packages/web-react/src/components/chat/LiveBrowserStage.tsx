/**
 * Live cloud browser viewport & one-click human takeover stage (OCV5-813).
 *
 * Lazily loaded inside BrowserView so zero bytes enter the initial bundle.
 * Shares the container's persistent per-agent `oc-browser` Chromium daemon:
 * - Watch mode: smart low-overhead frame sync (pauses on hidden tab).
 * - Takeover mode: click / right-click / scroll / keyboard / text input / tab management.
 * - Hand back: preserves cookies/localStorage/page state and optionally prefills a continuation
 *   prompt into the chat Composer.
 */
import * as RD from "@radix-ui/react-dialog";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CornerDownLeft,
  Globe,
  Hand,
  Lock,
  Maximize2,
  Minimize2,
  Plus,
  Power,
  RotateCw,
  Send,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type LiveBrowserActionPayload,
  type LiveBrowserState,
  fetchLiveBrowserState,
  normalizeBrowserUrlInput,
  sendLiveBrowserAction,
} from "../../lib/liveBrowserApi";
import type { AuthSession } from "../../lib/types";
import { Spinner } from "../ui";
import type { LiveBrowserHandoffRequest } from "./inspectorState";
import "./liveBrowser.css";

const QUICK_PRESETS = [
  { label: "Google Scholar", url: "https://scholar.google.com" },
  { label: "arXiv", url: "https://arxiv.org" },
  { label: "GitHub", url: "https://github.com" },
] as const;

const QUICK_KEYS = [
  { label: "Enter", key: "Enter" },
  { label: "Tab", key: "Tab" },
  { label: "退格", key: "Backspace" },
  { label: "上翻", key: "PageUp" },
  { label: "下翻", key: "PageDown" },
  { label: "Esc", key: "Escape" },
] as const;

const SPECIAL_KEY_MAP: Record<string, string> = {
  Enter: "Enter",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Home: "Home",
  End: "End",
  " ": "Space",
};

const CTRL_COMBO_KEYS = new Set(["a", "c", "v", "x", "z"]);

interface ClickRipple {
  id: number;
  xPct: number;
  yPct: number;
}

export interface LiveBrowserStageProps {
  agentId: string;
  auth: AuthSession;
  /** Whether the assistant is currently executing a browser tool step (speeds up idle→active detection). */
  running?: boolean;
  /** Optional one-click handoff request emitted by a chat `browser_handoff` card. */
  handoffRequest?: (LiveBrowserHandoffRequest & { nonce: number }) | null;
  /** Notifies parent once a handoff request has been settled so remounting never replays it. */
  onHandoffSettled?: (nonce: number) => void;
  /** Prefill a continuation prompt into Composer when the user hands control back. */
  onHandBackToComposer?: (draft: string) => void;
  /** Reports active status upward so BrowserView can render a live status indicator. */
  onActiveStateChange?: (active: boolean) => void;
}

interface HandoffOriginMismatch {
  expectedHost: string;
  actualHost: string;
  continuePrompt: string | null;
}

function parseOriginAndHost(url?: string): { origin: string; host: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { origin: u.origin, host: u.host };
  } catch {
    return null;
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "云端浏览器连接失败，请稍后重试";
}

function formatSyncTime(ts?: number): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

export function LiveBrowserStage({
  agentId,
  auth,
  running = false,
  handoffRequest = null,
  onHandoffSettled,
  onHandBackToComposer,
  onActiveStateChange,
}: LiveBrowserStageProps) {
  const [state, setState] = useState<LiveBrowserState | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [takeover, setTakeover] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [originMismatch, setOriginMismatch] = useState<HandoffOriginMismatch | null>(null);
  const [handoffWaiting, setHandoffWaiting] = useState(false);

  const [launchUrl, setLaunchUrl] = useState("https://scholar.google.com");
  const [addressDraft, setAddressDraft] = useState("");
  const [addressEditing, setAddressEditing] = useState(false);
  const [typeDraft, setTypeDraft] = useState("");
  const [ripple, setRipple] = useState<ClickRipple | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const expandBtnRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(true);
  const authRef = useRef(auth);
  authRef.current = auth;

  // Monotonic sequence fencing: stale GET polls can never overwrite newer POST action frames.
  const reqSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const pollAbortRef = useRef<AbortController | null>(null);
  const pollInFlightRef = useRef(false);
  const actionInFlightRef = useRef(false);
  const keyBufferRef = useRef<{ text: string; timer: number | null }>({ text: "", timer: null });
  const inputQueueRef = useRef<LiveBrowserActionPayload[]>([]);
  const wheelBufferRef = useRef<{ dx: number; dy: number; x?: number; y?: number; timer: number | null }>({
    dx: 0,
    dy: 0,
    timer: null,
  });

  const lockedByAssistant = running || state?.agentBusy === true;
  const effectiveTakeover = takeover && !lockedByAssistant;
  const takeoverActiveRef = useRef(false);
  takeoverActiveRef.current = effectiveTakeover;
  const runningRef = useRef(running);
  runningRef.current = running;
  const stateUrlRef = useRef<string | undefined>(state?.url);
  stateUrlRef.current = state?.url;
  const lastHandoffNonceRef = useRef<number | null>(null);
  const pendingHandoffRef = useRef<(LiveBrowserHandoffRequest & { nonce: number }) | null>(null);
  const pendingPostOpenHandoffRef = useRef<{
    nonce: number;
    takeover?: boolean;
    expand?: boolean;
    url?: string;
    continuePrompt?: string | null;
  } | null>(null);
  const handoffContinuePromptRef = useRef<string | null>(null);
  const onHandoffSettledRef = useRef(onHandoffSettled);
  onHandoffSettledRef.current = onHandoffSettled;

  const clearPendingInputBuffers = useCallback(() => {
    keyBufferRef.current.text = "";
    if (keyBufferRef.current.timer !== null) {
      window.clearTimeout(keyBufferRef.current.timer);
      keyBufferRef.current.timer = null;
    }
    wheelBufferRef.current.dx = 0;
    wheelBufferRef.current.dy = 0;
    if (wheelBufferRef.current.timer !== null) {
      window.clearTimeout(wheelBufferRef.current.timer);
      wheelBufferRef.current.timer = null;
    }
    inputQueueRef.current.length = 0;
  }, []);

  const activateHandoffOnActivePage = useCallback(
    (
      req: { takeover?: boolean; expand?: boolean; url?: string; continuePrompt?: string | null },
      actualUrl: string | undefined,
      isBusyNow: boolean,
    ) => {
      const expected = parseOriginAndHost(req.url);
      const actual = parseOriginAndHost(actualUrl);
      if (expected && actual && expected.origin !== actual.origin) {
        // Always revoke any active takeover before asking the user to confirm the mismatched origin.
        takeoverActiveRef.current = false;
        clearPendingInputBuffers();
        setTakeover(false);
        handoffContinuePromptRef.current = null;
        setOriginMismatch({
          expectedHost: expected.host,
          actualHost: actual.host,
          continuePrompt: req.continuePrompt?.trim() || null,
        });
        if (req.expand) setExpanded(true);
        return;
      }
      setOriginMismatch(null);
      handoffContinuePromptRef.current = req.continuePrompt?.trim() || null;
      if (req.takeover && !isBusyNow) {
        setTakeover(true);
        window.requestAnimationFrame(() => stageRef.current?.focus({ preventScroll: true }));
      }
      if (req.expand) setExpanded(true);
    },
    [clearPendingInputBuffers],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pollAbortRef.current?.abort();
      clearPendingInputBuffers();
    };
  }, [clearPendingInputBuffers]);

  // Honest exclusive control: whenever the assistant is actively running a turn (local or any
  // server-side session for this agent), drop takeover back to watch-only mode and discard pending buffers.
  useEffect(() => {
    if (lockedByAssistant) {
      setTakeover(false);
      clearPendingInputBuffers();
    }
  }, [lockedByAssistant, clearPendingInputBuffers]);

  // Reset takeover, expanded theater view, and address draft if switching agent.
  useEffect(() => {
    setTakeover(false);
    setExpanded(false);
    setAddressEditing(false);
    setError(null);
    setOriginMismatch(null);
    setHandoffWaiting(false);
    setState(null);
    setInitialLoading(true);
    clearPendingInputBuffers();
    pendingHandoffRef.current = null;
    pendingPostOpenHandoffRef.current = null;
    handoffContinuePromptRef.current = null;
    reqSeqRef.current += 1;
    appliedSeqRef.current = reqSeqRef.current;
    pollAbortRef.current?.abort();
  }, [agentId, clearPendingInputBuffers]);

  const applyState = useCallback(
    (seq: number, next: LiveBrowserState) => {
      if (!mountedRef.current || seq < appliedSeqRef.current) return;
      appliedSeqRef.current = seq;
      setState(next);
      setInitialLoading(false);
      setError(null);
      onActiveStateChange?.(next.active);
      if (!next.active) {
        pendingPostOpenHandoffRef.current = null;
        setOriginMismatch(null);
        setTakeover(false);
        setExpanded(false);
        clearPendingInputBuffers();
      } else if (next.agentBusy) {
        setTakeover(false);
        clearPendingInputBuffers();
      } else if (pendingPostOpenHandoffRef.current) {
        const post = pendingPostOpenHandoffRef.current;
        pendingPostOpenHandoffRef.current = null;
        activateHandoffOnActivePage(post, next.url, Boolean(runningRef.current || next.agentBusy));
        onHandoffSettledRef.current?.(post.nonce);
      }
    },
    [onActiveStateChange, clearPendingInputBuffers, activateHandoffOnActivePage],
  );

  // Sync address bar with live URL unless user is currently editing it.
  useEffect(() => {
    if (!addressEditing && typeof state?.url === "string") {
      setAddressDraft(state.url);
    }
  }, [state?.url, addressEditing]);

  const pollOnce = useCallback(async () => {
    if (!mountedRef.current || actionInFlightRef.current || pollInFlightRef.current) return;
    if (typeof document !== "undefined" && document.hidden) return;
    const ctrl = new AbortController();
    pollAbortRef.current = ctrl;
    pollInFlightRef.current = true;
    const mySeq = ++reqSeqRef.current;
    try {
      const next = await fetchLiveBrowserState(authRef.current, agentId, {
        includeFrame: true,
        quality: 70,
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted) return;
      applyState(mySeq, next);
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current) return;
      setInitialLoading(false);
      setError((prev) => prev ?? errorMessageOf(err));
    } finally {
      if (pollAbortRef.current === ctrl) {
        pollAbortRef.current = null;
        pollInFlightRef.current = false;
      }
    }
  }, [agentId, applyState]);

  // Adaptive chained polling: schedules the next tick only AFTER the current GET settles so slow
  // frames are never aborted mid-flight; pauses when tab is hidden.
  const isActive = state?.active === true;
  const isAvailable = state?.available !== false;
  useEffect(() => {
    if (!isAvailable && state !== null) return;
    let cancelled = false;
    let timer: number | null = null;
    const intervalMs = isActive ? (effectiveTakeover ? 1200 : 900) : lockedByAssistant ? 1800 : 4000;

    const schedule = (delay: number) => {
      if (cancelled) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void runCycle();
      }, delay);
    };

    const runCycle = async () => {
      if (cancelled) return;
      await pollOnce();
      schedule(intervalMs);
    };

    if (state === null) {
      void runCycle();
    } else {
      schedule(intervalMs);
    }

    const onVisibility = () => {
      if (document.hidden) {
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        pollAbortRef.current?.abort();
      } else if (!cancelled) {
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        void runCycle();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [agentId, isActive, isAvailable, lockedByAssistant, effectiveTakeover, pollOnce, state === null]);

  const runAction = useCallback(
    async (payload: LiveBrowserActionPayload) => {
      if (!mountedRef.current) return;
      pollAbortRef.current?.abort();
      actionInFlightRef.current = true;
      setBusy(true);
      setError(null);
      const mySeq = ++reqSeqRef.current;
      try {
        const liveOrigin = parseOriginAndHost(stateUrlRef.current)?.origin;
        const enrichedPayload: LiveBrowserActionPayload =
          liveOrigin &&
          (payload.action === "click" ||
            payload.action === "dblclick" ||
            payload.action === "wheel" ||
            payload.action === "type" ||
            payload.action === "press") &&
          !payload.expectedOrigin
            ? { ...payload, expectedOrigin: liveOrigin }
            : payload;
        const next = await sendLiveBrowserAction(authRef.current, agentId, enrichedPayload);
        applyState(mySeq, next);
      } catch (err) {
        const post = pendingPostOpenHandoffRef.current;
        pendingPostOpenHandoffRef.current = null;
        if (!isAbortError(err) && mountedRef.current) {
          const msg = errorMessageOf(err);
          const isAgentBusyConflict =
            (err as { status?: number })?.status === 409 ||
            /助手正在操作浏览器|AGENT_RUNNING/.test(msg);
          if (post && isAgentBusyConflict) {
            // Re-queue transient 409 handoff so it automatically resumes when the assistant finishes.
            pendingHandoffRef.current = {
              nonce: post.nonce,
              takeover: post.takeover,
              expand: post.expand,
              url: post.url,
              continuePrompt: post.continuePrompt ?? undefined,
            };
            setHandoffWaiting(true);
            setState((prev) => (prev ? { ...prev, agentBusy: true } : prev));
          } else {
            if (post) onHandoffSettledRef.current?.(post.nonce);
            setError(msg);
          }
        }
      } finally {
        actionInFlightRef.current = false;
        if (mountedRef.current) setBusy(false);
        // Drain next queued canvas input in strict FIFO order only while still in takeover.
        if (mountedRef.current && takeoverActiveRef.current) {
          const nextQueued = inputQueueRef.current.shift();
          if (nextQueued) {
            void runAction(nextQueued);
          } else if (keyBufferRef.current.text && keyBufferRef.current.timer === null) {
            const pending = keyBufferRef.current.text;
            keyBufferRef.current.text = "";
            void runAction({ action: "type", text: pending, submit: false });
          }
        }
      }
    },
    [agentId, applyState],
  );

  const enqueueCanvasInput = useCallback(
    (payload: LiveBrowserActionPayload): boolean => {
      if (!takeoverActiveRef.current) return false;
      if (inputQueueRef.current.length >= 12) {
        setError("操作队列已满，请等待当前操作完成后再试");
        return false;
      }
      inputQueueRef.current.push(payload);
      if (!actionInFlightRef.current) {
        const next = inputQueueRef.current.shift();
        if (next) void runAction(next);
      }
      return true;
    },
    [runAction],
  );

  const flushKeyBufferToQueue = useCallback(() => {
    const buf = keyBufferRef.current;
    if (buf.timer !== null) {
      window.clearTimeout(buf.timer);
      buf.timer = null;
    }
    if (!buf.text || !takeoverActiveRef.current) {
      buf.text = "";
      return;
    }
    const pending = buf.text;
    buf.text = "";
    enqueueCanvasInput({ action: "type", text: pending, submit: false });
  }, [enqueueCanvasInput]);

  const handleLaunch = (e: FormEvent) => {
    e.preventDefault();
    if (lockedByAssistant || busy) return;
    const url = normalizeBrowserUrlInput(launchUrl);
    if (!url) {
      setError("请输入有效的 http:// 或 https:// 网址");
      return;
    }
    void runAction({ action: "open", url });
  };

  const handleAddressSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (lockedByAssistant || busy) return;
    const url = normalizeBrowserUrlInput(addressDraft);
    if (!url) {
      setError("仅支持打开 http:// 或 https:// 网址");
      return;
    }
    setAddressEditing(false);
    void runAction({ action: "goto", url });
  };

  const normalizedCoords = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    return { x, y };
  };

  const showRipple = (x: number, y: number) => {
    const id = Date.now() + Math.random();
    setRipple({ id, xPct: x * 100, yPct: y * 100 });
    window.setTimeout(() => {
      setRipple((curr) => (curr?.id === id ? null : curr));
    }, 360);
  };

  const handleCanvasClick = (e: ReactMouseEvent<HTMLImageElement>) => {
    if (!effectiveTakeover) return;
    const pt = normalizedCoords(e);
    if (!pt) return;
    stageRef.current?.focus({ preventScroll: true });
    flushKeyBufferToQueue();
    if (enqueueCanvasInput({ action: "click", x: pt.x, y: pt.y, normalized: true, button: "left" })) {
      showRipple(pt.x, pt.y);
    }
  };

  const handleCanvasContextMenu = (e: ReactMouseEvent<HTMLImageElement>) => {
    if (!effectiveTakeover) return;
    e.preventDefault();
    const pt = normalizedCoords(e);
    if (!pt) return;
    flushKeyBufferToQueue();
    if (enqueueCanvasInput({ action: "click", x: pt.x, y: pt.y, normalized: true, button: "right" })) {
      showRipple(pt.x, pt.y);
    }
  };

  const handleCanvasWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (!effectiveTakeover) return;
    const pt = normalizedCoords(e);
    const buf = wheelBufferRef.current;
    buf.dx += e.deltaX;
    buf.dy += e.deltaY;
    if (pt) {
      buf.x = pt.x;
      buf.y = pt.y;
    }
    if (buf.timer === null) {
      buf.timer = window.setTimeout(() => {
        const dx = Math.round(buf.dx);
        const dy = Math.round(buf.dy);
        const x = buf.x;
        const y = buf.y;
        buf.dx = 0;
        buf.dy = 0;
        buf.timer = null;
        if (!takeoverActiveRef.current) return;
        if (dx !== 0 || dy !== 0) {
          enqueueCanvasInput({ action: "wheel", x, y, normalized: true, deltaX: dx, deltaY: dy });
        }
      }, 220);
    }
  };

  const handleStageKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!effectiveTakeover) return;
    // Let native IME composition pass through untouched (users use bottom input bar for CJK).
    if (e.nativeEvent.isComposing) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    // Local focus escape: pressing Escape releases keyboard capture on the canvas without closing
    // InspectorPanel (remote Esc is available via the quick-keys dock). Tab stays native for a11y.
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      stageRef.current?.blur();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const lower = e.key.toLowerCase();
      if (CTRL_COMBO_KEYS.has(lower)) {
        e.preventDefault();
        e.stopPropagation();
        flushKeyBufferToQueue();
        enqueueCanvasInput({ action: "press", key: `Control+${lower}` });
      }
      return;
    }

    const mapped = SPECIAL_KEY_MAP[e.key];
    if (mapped) {
      e.preventDefault();
      e.stopPropagation();
      flushKeyBufferToQueue();
      enqueueCanvasInput({ action: "press", key: mapped });
      return;
    }

    // Buffer rapid printable keystrokes instead of dropping them while an action is in flight.
    if (e.key.length === 1 && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      const buf = keyBufferRef.current;
      buf.text += e.key;
      if (buf.timer !== null) window.clearTimeout(buf.timer);
      buf.timer = window.setTimeout(() => {
        buf.timer = null;
        flushKeyBufferToQueue();
      }, 160);
    }
  };

  const handleSendText = (submit: boolean) => {
    if (!typeDraft || busy || lockedByAssistant) return;
    const text = typeDraft;
    setTypeDraft("");
    void runAction({ action: "type", text, submit });
  };

  const handleHandBack = () => {
    takeoverActiveRef.current = false;
    clearPendingInputBuffers();
    setTakeover(false);
    setExpanded(false);
    setOriginMismatch(null);
    const customPrompt = handoffContinuePromptRef.current;
    handoffContinuePromptRef.current = null;
    if (onHandBackToComposer) {
      const label = state?.title?.trim() || state?.url?.trim() || "当前网页";
      onHandBackToComposer(customPrompt || `我已在云端浏览器完成操作（当前页面：${label}），请继续刚才的任务。`);
    }
  };

  // Fulfill one-click handoff requests emitted from chat `browser_handoff` cards.
  useEffect(() => {
    if (!handoffRequest || handoffRequest.nonce === lastHandoffNonceRef.current) return;
    lastHandoffNonceRef.current = handoffRequest.nonce;
    pendingHandoffRef.current = handoffRequest;
  }, [handoffRequest]);

  const stateLoaded = state !== null;
  const stateActive = state?.active === true;
  const stateAvailable = state?.available !== false;
  const stateUrl = state?.url;
  useEffect(() => {
    const req = pendingHandoffRef.current;
    if (!req || !stateLoaded) return;
    if (!stateAvailable) {
      pendingHandoffRef.current = null;
      setHandoffWaiting(false);
      onHandoffSettledRef.current?.(req.nonce);
      return;
    }
    // Preserve pending handoff across temporary assistant/action locks instead of dropping clicks.
    if (lockedByAssistant || busy || actionInFlightRef.current) {
      setHandoffWaiting(true);
      return;
    }
    pendingHandoffRef.current = null;
    setHandoffWaiting(false);
    if (stateActive) {
      activateHandoffOnActivePage(req, stateUrl, false);
      onHandoffSettledRef.current?.(req.nonce);
      return;
    }
    if (req.url) {
      const normalized = normalizeBrowserUrlInput(req.url);
      if (normalized) {
        setLaunchUrl(normalized);
        pendingPostOpenHandoffRef.current = {
          nonce: req.nonce,
          takeover: req.takeover,
          expand: req.expand,
          url: normalized,
          continuePrompt: req.continuePrompt?.trim() || null,
        };
        void runAction({ action: "open", url: normalized, ifIdle: true });
        return;
      }
    }
    onHandoffSettledRef.current?.(req.nonce);
  }, [
    handoffRequest,
    stateLoaded,
    stateActive,
    stateAvailable,
    stateUrl,
    lockedByAssistant,
    busy,
    runAction,
    activateHandoffOnActivePage,
  ]);

  if (initialLoading && !state) {
    return (
      <div className="lb-root" data-testid="live-browser-loading">
        <div className="lb-idle-surface">
          <Spinner size={18} className="text-accent" />
          <p className="lb-idle-desc">正在连接云端浏览器视口…</p>
        </div>
      </div>
    );
  }

  if (state && !state.available) {
    return (
      <div className="lb-root" data-testid="live-browser-unavailable">
        <div className="lb-idle-surface">
          <span className="lb-idle-icon" aria-hidden>
            <Globe size={18} />
          </span>
          <h3 className="lb-idle-title">当前环境未启用云端浏览器</h3>
          <p className="lb-idle-desc">
            该运行容器暂未挂载实时浏览器引擎，助手的浏览器步骤快照仍可在「步骤记录」中查看。
          </p>
        </div>
      </div>
    );
  }

  if (!state?.active) {
    return (
      <div className="lb-root" data-testid="live-browser-idle">
        {error && (
          <div className="lb-error-banner" role="alert" data-testid="live-browser-error">
            <span>{error}</span>
            <button type="button" className="lb-error-close" aria-label="关闭提示" onClick={() => setError(null)}>
              <X size={13} />
            </button>
          </div>
        )}
        {handoffWaiting && (
          <div className="lb-handoff-banner" role="status" data-testid="live-browser-handoff-waiting">
            <span>助手正在操作浏览器，当前步骤完成后将自动为你开启接管…</span>
          </div>
        )}
        <div className="lb-idle-surface">
          <span className="lb-idle-icon" aria-hidden>
            <Globe size={18} />
          </span>
          <h3 className="lb-idle-title">云端实时浏览器</h3>
          <p className="lb-idle-desc">
            助手操作网页时会自动同步实时画面；你也可以现在启动，直接登录学术库或处理验证，页面状态与助手共享。
          </p>
          <form className="lb-launch-form" onSubmit={handleLaunch}>
            <input
              type="text"
              value={launchUrl}
              disabled={lockedByAssistant}
              onChange={(e) => setLaunchUrl(e.target.value)}
              placeholder="输入网址，例如 https://arxiv.org"
              aria-label="启动网址"
              className="lb-launch-input"
              data-testid="live-browser-launch-input"
            />
            <button
              type="submit"
              disabled={busy || lockedByAssistant}
              className="lb-launch-btn"
              data-testid="live-browser-launch-btn"
            >
              {busy ? <Spinner size={13} /> : <Globe size={13} />}
              启动
            </button>
          </form>
          <div className="lb-presets" aria-label="快捷入口">
            {QUICK_PRESETS.map((preset) => (
              <button
                key={preset.url}
                type="button"
                disabled={busy || lockedByAssistant}
                className="lb-preset-chip"
                onClick={() => {
                  setLaunchUrl(preset.url);
                  void runAction({ action: "open", url: preset.url });
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const tabs = state.tabs ?? [];
  const isHttps = (state.url ?? "").startsWith("https://");

  const browserShell = (
    <>
      {error && (
        <div className="lb-error-banner" role="alert" data-testid="live-browser-error">
          <span>{error}</span>
          <button type="button" className="lb-error-close" aria-label="关闭提示" onClick={() => setError(null)}>
            <X size={13} />
          </button>
        </div>
      )}

      {handoffWaiting && (
        <div className="lb-handoff-banner" role="status" data-testid="live-browser-handoff-waiting">
          <span>助手正在操作浏览器，当前步骤完成后将自动为你开启接管…</span>
        </div>
      )}

      {originMismatch && !effectiveTakeover && (
        <div className="lb-handoff-banner" role="alert" data-testid="live-browser-origin-mismatch">
          <span>
            当前实时页面域名为 <strong>{originMismatch.actualHost}</strong>（卡片指向{" "}
            <strong>{originMismatch.expectedHost}</strong>）。请核对地址栏；如为正常跳转（如第三方 SSO 登录），确认后再开启接管。
          </span>
          <div className="lb-handoff-actions">
            <button
              type="button"
              className="lb-cta-btn"
              data-variant="watch"
              disabled={lockedByAssistant}
              data-testid="live-browser-confirm-mismatch"
              onClick={() => {
                if (lockedByAssistant) return;
                // Re-verify live host at click time: if page navigated again before confirmation, refresh banner.
                const currentActual = parseOriginAndHost(state?.url);
                if (currentActual && currentActual.host !== originMismatch.actualHost) {
                  setOriginMismatch({ ...originMismatch, actualHost: currentActual.host });
                  return;
                }
                const prompt = originMismatch.continuePrompt;
                setOriginMismatch(null);
                handoffContinuePromptRef.current = prompt;
                setTakeover(true);
                window.requestAnimationFrame(() => stageRef.current?.focus({ preventScroll: true }));
              }}
            >
              确认接管当前页
            </button>
            <button
              type="button"
              className="lb-icon-btn"
              aria-label="关闭域名核对提示"
              onClick={() => setOriginMismatch(null)}
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}

      <div className="lb-shell" data-takeover={effectiveTakeover ? "true" : "false"}>
        {/* Top Chrome Toolbar */}
        <div className="lb-toolbar">
          <div className="lb-nav-group">
            <button
              type="button"
              className="lb-icon-btn"
              aria-label="后退"
              title={lockedByAssistant ? "助手执行中，暂不可操作" : "后退"}
              disabled={busy || lockedByAssistant}
              onClick={() => void runAction({ action: "back" })}
            >
              <ArrowLeft size={14} />
            </button>
            <button
              type="button"
              className="lb-icon-btn"
              aria-label="前进"
              title={lockedByAssistant ? "助手执行中，暂不可操作" : "前进"}
              disabled={busy || lockedByAssistant}
              onClick={() => void runAction({ action: "forward" })}
            >
              <ArrowRight size={14} />
            </button>
            <button
              type="button"
              className="lb-icon-btn"
              aria-label="刷新页面"
              title={lockedByAssistant ? "助手执行中，暂不可操作" : "刷新页面"}
              disabled={busy || lockedByAssistant}
              onClick={() => void runAction({ action: "reload" })}
            >
              <RotateCw size={13} className={busy ? "lb-spin" : undefined} />
            </button>
          </div>

          <form className="lb-address-form" onSubmit={handleAddressSubmit}>
            <span className="lb-address-icon" aria-hidden>
              {isHttps ? <Lock size={11} /> : <Globe size={11} />}
            </span>
            <input
              type="text"
              value={addressDraft}
              readOnly={lockedByAssistant}
              onFocus={() => {
                if (!lockedByAssistant) setAddressEditing(true);
              }}
              onBlur={() => setAddressEditing(false)}
              onChange={(e) => setAddressDraft(e.target.value)}
              placeholder="输入网址并回车…"
              aria-label="浏览器地址栏"
              className="lb-address-input"
              data-testid="live-browser-address"
            />
          </form>

          <div className="lb-toolbar-actions">
            {effectiveTakeover ? (
              <button
                type="button"
                className="lb-cta-btn"
                data-variant="takeover"
                data-testid="live-browser-handback-btn"
                onClick={handleHandBack}
              >
                <Check size={13} />
                交还助手
              </button>
            ) : (
              <button
                type="button"
                className="lb-cta-btn"
                data-variant="watch"
                disabled={lockedByAssistant || Boolean(originMismatch)}
                title={
                  lockedByAssistant
                    ? "助手正在操作浏览器，本轮结束或停止后即可接管"
                    : originMismatch
                      ? "请先核对上方域名提示并确认后再接管"
                      : "接管云端浏览器"
                }
                data-testid="live-browser-takeover-btn"
                onClick={() => {
                  if (lockedByAssistant || originMismatch) return;
                  setTakeover(true);
                  window.requestAnimationFrame(() => stageRef.current?.focus({ preventScroll: true }));
                }}
              >
                <Hand size={13} />
                {lockedByAssistant ? "助手操作中" : "接管"}
              </button>
            )}
            <button
              ref={expanded ? undefined : expandBtnRef}
              type="button"
              className="lb-icon-btn"
              aria-label={expanded ? "退出放大视图" : "放大浏览器视图"}
              title={expanded ? "缩小回侧栏 (Esc)" : "放大为沉浸全屏视口"}
              data-testid="live-browser-expand-btn"
              onClick={() => setExpanded((prev) => !prev)}
            >
              {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            <button
              type="button"
              className="lb-icon-btn"
              aria-label="关闭云端浏览器"
              title={lockedByAssistant ? "助手执行中，暂不可关闭" : "关闭云端浏览器"}
              disabled={busy || lockedByAssistant}
              data-testid="live-browser-close-btn"
              onClick={() => {
                takeoverActiveRef.current = false;
                clearPendingInputBuffers();
                setTakeover(false);
                setExpanded(false);
                void runAction({ action: "close" });
              }}
            >
              <Power size={13} />
            </button>
          </div>
        </div>

        {/* Multi-tab bar (rendered only when more than 1 tab is open) */}
        {tabs.length > 1 && (
          <div className="lb-tabs" role="tablist" aria-label="浏览器标签页" data-testid="live-browser-tabs">
            {tabs.map((t) => (
              <div key={t.index} className="lb-tab" data-active={t.active ? "true" : "false"}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={t.active}
                  disabled={busy || lockedByAssistant}
                  className="lb-tab-select"
                  title={t.title || t.url}
                  onClick={() => void runAction({ action: "tab_select", index: t.index })}
                >
                  {t.title || t.url || `标签页 ${t.index + 1}`}
                </button>
                <button
                  type="button"
                  disabled={busy || lockedByAssistant}
                  className="lb-tab-close"
                  aria-label={`关闭标签页 ${t.title || t.index + 1}`}
                  onClick={() => void runAction({ action: "tab_close", index: t.index })}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="lb-icon-btn"
              aria-label="新建标签页"
              title="新建标签页"
              disabled={busy || lockedByAssistant}
              onClick={() => void runAction({ action: "tab_new" })}
            >
              <Plus size={12} />
            </button>
          </div>
        )}

        {/* Integrated Status Ribbon */}
        <div
          className="lb-status-ribbon"
          data-takeover={effectiveTakeover ? "true" : "false"}
          data-testid="live-browser-status"
        >
          <div className="lb-status-left">
            <span className="lb-live-dot" data-takeover={effectiveTakeover ? "true" : "false"} aria-hidden />
            <span className="lb-status-text">
              {lockedByAssistant
                ? "助手正在操作浏览器 · 实时观看中（本轮结束或停止后可一键接管）"
                : effectiveTakeover
                  ? "已接管 · 点击画面交互，Esc 退出键盘捕获，完成后点「交还助手」"
                  : state.title
                    ? `实时画面 · ${state.title}`
                    : "实时画面同步中 · 点击「接管」可直接操作"}
            </span>
          </div>
          {state.capturedAt && <span className="lb-status-meta">{formatSyncTime(state.capturedAt)}</span>}
        </div>

        {/* Viewport Canvas */}
        <div
          ref={stageRef}
          tabIndex={effectiveTakeover ? 0 : -1}
          className="lb-stage"
          data-takeover={effectiveTakeover ? "true" : "false"}
          data-testid="live-browser-stage"
          aria-label={effectiveTakeover ? "云端浏览器交互画布（接管中）" : "云端浏览器实时画布"}
          onKeyDown={handleStageKeyDown}
          onWheel={handleCanvasWheel}
        >
          {busy && <span className="lb-progress-bar" aria-hidden />}
          {state.imageBase64 ? (
            <div className="lb-frame-wrap">
              <img
                ref={imgRef}
                src={`data:${state.mimeType ?? "image/jpeg"};base64,${state.imageBase64}`}
                alt={state.title ? `${state.title} 实时画面` : "云端浏览器实时画面"}
                draggable={false}
                className="lb-frame-img"
                data-testid="live-browser-frame"
                onClick={handleCanvasClick}
                onContextMenu={handleCanvasContextMenu}
              />
              {ripple && (
                <span
                  key={ripple.id}
                  className="lb-ripple"
                  style={{ left: `${ripple.xPct}%`, top: `${ripple.yPct}%` }}
                  aria-hidden
                />
              )}
            </div>
          ) : (
            <div className="lb-stage-placeholder">
              <Spinner size={16} className="text-accent" />
              <span>正在捕获页面画面…</span>
            </div>
          )}
        </div>

        {/* Takeover Bottom Text Input & Quick Keys */}
        {effectiveTakeover && (
          <div className="lb-takeover-dock" data-testid="live-browser-takeover-dock">
            <form
              className="lb-type-form"
              onSubmit={(e) => {
                e.preventDefault();
                handleSendText(true);
              }}
            >
              <input
                type="text"
                value={typeDraft}
                onChange={(e) => setTypeDraft(e.target.value)}
                placeholder="输入文字或验证码发送到页面焦点…"
                aria-label="向云端浏览器输入文字"
                className="lb-type-input"
                data-testid="live-browser-type-input"
              />
              <button
                type="button"
                disabled={busy || !typeDraft}
                className="lb-type-btn"
                data-testid="live-browser-type-send"
                onClick={() => handleSendText(false)}
              >
                <Send size={12} />
                输入
              </button>
              <button
                type="submit"
                disabled={busy || !typeDraft}
                className="lb-type-btn"
                data-primary="true"
                title="输入并按回车"
                aria-label="输入并按回车"
                data-testid="live-browser-type-submit"
              >
                <CornerDownLeft size={12} />
              </button>
            </form>
            <div className="lb-keys-row" aria-label="快捷按键">
              {QUICK_KEYS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  disabled={busy}
                  className="lb-key-chip"
                  onClick={() => void runAction({ action: "press", key: item.key })}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );

  return (
    <>
      {expanded ? (
        <div className="lb-root" data-testid="live-browser-docked">
          <div className="lb-docked-placeholder">
            <span className="lb-idle-icon" aria-hidden>
              <Maximize2 size={16} />
            </span>
            <p className="lb-idle-desc">云端浏览器正在全屏放大视图中运行</p>
            <button
              type="button"
              className="lb-preset-chip"
              onClick={() => setExpanded(false)}
            >
              <Minimize2 size={12} />
              恢复到侧栏
            </button>
          </div>
        </div>
      ) : (
        <div className="lb-root" data-testid="live-browser-active">
          {browserShell}
        </div>
      )}

      <RD.Root open={expanded} onOpenChange={setExpanded}>
        <RD.Portal>
          <RD.Overlay className="lb-theater-backdrop" data-testid="live-browser-theater-backdrop" />
          <RD.Content
            className="lb-theater-dialog"
            data-testid="live-browser-theater-dialog"
            aria-describedby={undefined}
            onCloseAutoFocus={(e) => {
              // Restore focus deterministically to the inline expand trigger after portal teardown.
              e.preventDefault();
              window.requestAnimationFrame(() => expandBtnRef.current?.focus());
            }}
            onEscapeKeyDown={(e) => {
              // If the takeover canvas is focused, first Escape releases keyboard capture without
              // closing the theater dialog; second Escape closes ONLY this dialog (never parent Sheet).
              if (stageRef.current && document.activeElement === stageRef.current) {
                e.preventDefault();
                stageRef.current.blur();
              }
            }}
          >
            <RD.Title className="sr-only">云端实时浏览器放大视图</RD.Title>
            {expanded ? browserShell : null}
          </RD.Content>
        </RD.Portal>
      </RD.Root>
    </>
  );
}
