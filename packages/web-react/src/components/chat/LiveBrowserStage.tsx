/**
 * Live cloud browser viewport & human takeover orchestrator (OCV5-813 / OCV5-857).
 *
 * Strictly lazily loaded inside BrowserView so zero bytes enter the initial bundle.
 * Orchestrates:
 * - Real-time WebSocket binary frame stream (`LiveBrowserStreamClient`) with automatic
 *   graceful fallback to adaptive HTTP polling (`liveBrowserApi`).
 * - Clarvy Atelier browser chrome (`LiveBrowserToolbar`) & interactive canvas (`LiveBrowserCanvas`).
 * - Exclusive human/assistant takeover arbitration, cross-origin handoff guard,
 *   one-click "交还并继续" + session-level `BrowserHandoffBlock` sync.
 */
import type {
  LiveBrowserDecodedFrame,
  LiveBrowserMouseButton,
  LiveBrowserStatePayload,
} from "@openclaude/protocol/browser";
import * as RD from "@radix-ui/react-dialog";
import {
  Maximize2,
  Minimize2,
  ShieldAlert,
  X,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { apiErrorMessage } from "../../lib/api";
import {
  type LiveBrowserActionPayload,
  type LiveBrowserState,
  type LiveBrowserTabInfo,
  fetchLiveBrowserState,
  normalizeBrowserUrlInput,
  sendLiveBrowserAction,
} from "../../lib/liveBrowserApi";
import {
  type LiveBrowserConnectionStatus,
  LiveBrowserStreamClient,
  type LiveBrowserStreamStats,
} from "../../lib/liveBrowserStreamClient";
import type { AuthSession } from "../../lib/types";
import { useChatInteraction } from "../tool/context";
import { useToast } from "../ui";
import {
  LiveBrowserCanvas,
  type LiveBrowserCanvasHandle,
  type LiveBrowserZoomMode,
} from "./LiveBrowserCanvas";
import {
  LiveBrowserConnectErrorView,
  LiveBrowserErrorBanner,
  LiveBrowserIdleView,
  LiveBrowserLoadingView,
  LiveBrowserTakeoverDock,
  LiveBrowserToolbar,
  LiveBrowserUnavailableView,
} from "./LiveBrowserToolbar";
import {
  type LiveBrowserHandoffPhase,
  type LiveBrowserHandoffRequest,
  notifyLiveBrowserHandback,
  notifyLiveBrowserHandoffPhase,
  registerLiveBrowserHandbackHandler,
  useInspectorStopTurn,
} from "./inspectorState";
import "./liveBrowser.css";

const MAX_POLL_BACKOFF_MS = 30_000;
const UNAVAILABLE_BASE_BACKOFF_MS = 3_000;
const HTTP_TAKEOVER_RENEW_MS = 30_000;
const SAFE_HANDBACK_CONTINUE_MESSAGE = "我已完成浏览器接管操作，请继续处理。";

/** Convert native key + CDP modifier bitmask to Playwright `press` expression for HTTP fallback. */
export function formatPlaywrightKey(key: string, modifiers = 0): string {
  const baseKey = key === " " ? "Space" : key;
  const mods: string[] = [];
  if (modifiers & 2 || modifiers & 4) mods.push("Control");
  if (modifiers & 1) mods.push("Alt");
  if (
    (modifiers & 8) &&
    (baseKey === "Tab" || baseKey.startsWith("Arrow") || baseKey === "Home" || baseKey === "End")
  ) {
    mods.push("Shift");
  }
  return mods.length > 0 ? `${mods.join("+")}+${baseKey}` : baseKey;
}

export interface LiveBrowserStageProps {
  agentId: string;
  auth: AuthSession;
  /** Whether the assistant is currently executing a browser tool step (speeds up idle→active detection). */
  running?: boolean;
  /** Whether this view is currently hidden behind another sub-mode (e.g. 步骤记录 keep-alive). */
  hidden?: boolean;
  /** Optional one-click handoff request emitted by a chat `browser_handoff` card. */
  handoffRequest?: (LiveBrowserHandoffRequest & { nonce: number }) | null;
  /** Notifies parent once a handoff request has been settled so remounting never replays it. */
  onHandoffSettled?: (nonce: number) => void;
  /** Prefill a continuation prompt into Composer when the user hands control back. */
  onHandBackToComposer?: (draft: string) => void;
  /** Stop the currently running assistant turn so the user can take over immediately. */
  onStopTurn?: () => void;
  /** Reports active status upward so BrowserView can render a live status indicator. */
  onActiveStateChange?: (active: boolean) => void;
}

interface HandoffOriginMismatch {
  expectedOrigin: string;
  expectedHost: string;
  actualOrigin: string;
  actualHost: string;
  continuePrompt: string | null;
  handoffId?: string | null;
}

interface LiveBrowserErrorState {
  message: string;
  kind: "connection" | "business";
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
  return apiErrorMessage(err, "云端浏览器连接失败，请稍后重试");
}

function isTakeoverRequiredError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? "";
  const msg = errorMessageOf(err);
  return code === "TAKEOVER_REQUIRED" || /TAKEOVER_REQUIRED|请先点击「接管」/.test(msg);
}

function isTakeoverConflictError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  const code = (err as { code?: string })?.code ?? "";
  const msg = errorMessageOf(err);
  return (
    code === "TAKEOVER_ALREADY_HELD" ||
    code === "TAKEOVER_TOKEN_MISMATCH" ||
    /TAKEOVER_ALREADY_HELD|TAKEOVER_TOKEN_MISMATCH|独占接管|租约/.test(msg) ||
    (status === 409 && !/助手正在操作浏览器|AGENT_RUNNING|TAKEOVER_REQUIRED|请先点击「接管」/.test(msg))
  );
}

const BUSINESS_ERROR_CODES = new Set([
  "AGENT_RUNNING", "TAKEOVER_REQUIRED", "TAKEOVER_ALREADY_HELD",
  "TAKEOVER_TOKEN_MISMATCH", "INVALID_URL", "BAD_REQUEST", "ORIGIN_MISMATCH", "TARGET_MISMATCH",
]);

function isBusinessError(err: unknown, msg: string, code?: string): boolean {
  const status = (err as { status?: number })?.status;
  const errCode = code ?? (err as { code?: string })?.code ?? "";
  if (BUSINESS_ERROR_CODES.has(errCode)) return true;
  if (status === 400 || status === 403 || status === 404 || status === 409 || status === 422) return true;
  return /助手正在操作浏览器|AGENT_RUNNING|TAKEOVER_REQUIRED|请先点击「接管」|独占接管|租约/.test(msg);
}

function mergeStreamState(prev: LiveBrowserState | null, next: LiveBrowserStatePayload): LiveBrowserState {
  // If old container lacks CDP while an active HTTP screenshot is already displayed, preserve it.
  if (next.cdpAvailable === false && prev?.active) {
    return {
      ...prev,
      cdpAvailable: false,
      agentBusy: next.agentBusy ?? prev.agentBusy,
    };
  }
  return {
    available: true,
    active: next.active,
    agentBusy: next.agentBusy,
    humanTakeover: next.humanTakeover,
    takeoverToken: next.takeoverToken ?? prev?.takeoverToken,
    loading: next.loading,
    url: next.url,
    origin: next.origin ?? parseOriginAndHost(next.url)?.origin,
    targetId: next.targetId ?? prev?.targetId,
    navGen: next.navGen ?? prev?.navGen,
    cdpAvailable: next.cdpAvailable,
    title: next.title,
    viewport: next.viewport ?? prev?.viewport,
    tabs: next.tabs ? [...next.tabs] : prev?.tabs,
    dialog: next.dialog ?? null,
    capturedAt: next.capturedAt ?? Date.now(),
    imageBase64: next.active ? prev?.imageBase64 : undefined,
    mimeType: prev?.mimeType,
  };
}

export function LiveBrowserStage({
  agentId,
  auth,
  running = false,
  hidden = false,
  handoffRequest = null,
  onHandoffSettled,
  onHandBackToComposer,
  onStopTurn,
  onActiveStateChange,
}: LiveBrowserStageProps) {
  const toast = useToast();
  const ctxStopTurn = useInspectorStopTurn();
  const effectiveStopTurn = onStopTurn ?? ctxStopTurn;
  const { sendUserText, busy: chatBusy, sessionId: chatSessionId } = useChatInteraction();

  const [state, setState] = useState<LiveBrowserState | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [takeover, setTakeover] = useState(false);
  const [takeoverLeaseMode, setTakeoverLeaseMode] = useState<"none" | "exclusive" | "compat">("none");
  const [expanded, setExpanded] = useState(false);
  const [zoomMode, setZoomMode] = useState<LiveBrowserZoomMode>("fit");
  const [errorState, setErrorState] = useState<LiveBrowserErrorState | null>(null);
  const error = errorState?.message ?? null;
  const errorRetryable = errorState?.kind === "connection";
  const [originMismatch, setOriginMismatch] = useState<HandoffOriginMismatch | null>(null);
  const [originMismatchDismissed, setOriginMismatchDismissed] = useState(false);
  const [pollEpoch, setPollEpoch] = useState(0);

  const setConnectionError = useCallback((message: string) => {
    setErrorState({ message, kind: "connection" });
  }, []);
  const setBusinessError = useCallback((message: string) => {
    setErrorState({ message, kind: "business" });
  }, []);
  const clearError = useCallback(() => {
    setErrorState(null);
  }, []);
  const clearConnectionError = useCallback(() => {
    setErrorState((prev) => (prev?.kind === "connection" ? null : prev));
  }, []);

  const [streamStatus, setStreamStatus] = useState<LiveBrowserConnectionStatus>("idle");
  const [streamFrame, setStreamFrame] = useState<LiveBrowserDecodedFrame | null>(null);
  const [streamStats, setStreamStats] = useState<LiveBrowserStreamStats>({
    fps: 0,
    rttMs: null,
    lastFrameAt: null,
    mode: "polling",
  });
  const [remoteCursor, setRemoteCursor] = useState<string>("default");
  const [captureFocused, setCaptureFocused] = useState(false);

  const [launchUrl, setLaunchUrl] = useState("https://scholar.google.com");
  const [addressDraft, setAddressDraft] = useState("");
  const [addressEditing, setAddressEditing] = useState(false);
  const [typeDraft, setTypeDraft] = useState("");

  const stageRef = useRef<HTMLDivElement>(null);
  const canvasHandleRef = useRef<LiveBrowserCanvasHandle | null>(null);
  const expandBtnRef = useRef<HTMLButtonElement>(null);
  const streamClientRef = useRef<LiveBrowserStreamClient | null>(null);
  const mountedRef = useRef(true);
  const authRef = useRef(auth);
  authRef.current = auth;
  const chatSessionIdRef = useRef<string | null | undefined>(chatSessionId);
  chatSessionIdRef.current = chatSessionId;
  const sendUserTextRef = useRef(sendUserText);
  sendUserTextRef.current = sendUserText;
  const chatBusyRef = useRef(chatBusy);
  chatBusyRef.current = chatBusy;
  const handbackInFlightRef = useRef(false);

  const reportHandoffPhase = useCallback(
    (handoffId: string | null | undefined, phase: LiveBrowserHandoffPhase, reason?: string) => {
      if (!handoffId) return;
      notifyLiveBrowserHandoffPhase({
        sessionId: chatSessionIdRef.current ?? null,
        handoffId,
        phase,
        reason,
      });
    },
    [],
  );

  // Monotonic sequence fencing: stale GET polls can never overwrite newer POST/WS states.
  const reqSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const lastPollEpochRef = useRef(0);
  const pollAbortRef = useRef<AbortController | null>(null);
  const pollInFlightRef = useRef(false);
  const pollErrorStreakRef = useRef(0);
  const unavailableStreakRef = useRef(0);
  const actionInFlightRef = useRef(false);
  const userClosingRef = useRef(false);
  const pendingTakeoverAfterStopRef = useRef(false);
  const prevActiveRef = useRef(false);
  const prevTakeoverRef = useRef(false);
  const keyBufferRef = useRef<{ text: string; timer: number | null }>({ text: "", timer: null });
  const inputQueueRef = useRef<LiveBrowserActionPayload[]>([]);

  const wsConnected = streamStatus === "connected" && state?.cdpAvailable !== false;
  const wsConnectedRef = useRef(false);
  wsConnectedRef.current = wsConnected;
  const lockedByAssistant = running || state?.agentBusy === true;
  const effectiveTakeover = takeover && !lockedByAssistant;
  const takeoverActiveRef = useRef(false);
  takeoverActiveRef.current = effectiveTakeover;
  const runningRef = useRef(running);
  runningRef.current = running;
  const stateUrlRef = useRef<string | undefined>(state?.url);
  stateUrlRef.current = state?.url;
  const renderedOriginRef = useRef<string | undefined>(
    state?.origin ?? parseOriginAndHost(state?.url)?.origin,
  );
  renderedOriginRef.current = state?.origin ?? parseOriginAndHost(state?.url)?.origin;
  const renderedTargetIdRef = useRef<string | undefined>(state?.targetId);
  renderedTargetIdRef.current = state?.targetId;

  const httpTakeoverTokenRef = useRef<string | null>(null);
  const httpLeaseRenewTimerRef = useRef<number | null>(null);
  const httpLeaseHeldRef = useRef(false);
  const httpLeaseAcquiringRef = useRef(false);
  const httpLeaseGenRef = useRef(0);
  const wsTakeoverRequestedRef = useRef(false);
  const wsReleaseWaitersRef = useRef<Set<() => void>>(new Set());
  const flushWsReleaseWaiters = useCallback(() => {
    for (const resolve of wsReleaseWaitersRef.current) resolve();
    wsReleaseWaitersRef.current.clear();
  }, []);

  const navGenMetaRef = useRef<Map<number, { origin?: string; targetId?: string }>>(new Map());
  const paintedNavGenRef = useRef<number | null>(null);
  const paintedOriginRef = useRef<string | undefined>(undefined);
  const paintedTargetIdRef = useRef<string | undefined>(undefined);

  const lastHandoffNonceRef = useRef<number | null>(null);
  const pendingHandoffRef = useRef<(LiveBrowserHandoffRequest & { nonce: number }) | null>(null);
  const pendingPostOpenHandoffRef = useRef<{
    nonce: number;
    takeover?: boolean;
    expand?: boolean;
    url?: string;
    continuePrompt?: string | null;
    handoffId?: string | null;
  } | null>(null);
  const handoffContinuePromptRef = useRef<string | null>(null);
  const activeHandoffIdRef = useRef<string | null>(null);
  const onHandoffSettledRef = useRef(onHandoffSettled);
  onHandoffSettledRef.current = onHandoffSettled;

  const clearPendingInputBuffers = useCallback(() => {
    keyBufferRef.current.text = "";
    if (keyBufferRef.current.timer !== null) {
      window.clearTimeout(keyBufferRef.current.timer);
      keyBufferRef.current.timer = null;
    }
    inputQueueRef.current.length = 0;
  }, []);

  const handleFramePainted = useCallback((frame: LiveBrowserDecodedFrame) => {
    const ng = frame.navGen & 0xffff;
    paintedNavGenRef.current = ng;
    const meta = navGenMetaRef.current.get(ng);
    if (meta) {
      paintedOriginRef.current = meta.origin;
      paintedTargetIdRef.current = meta.targetId;
    } else if (
      ng === 0 ||
      (typeof stateRef.current?.navGen === "number" && (stateRef.current.navGen & 0xffff) === ng)
    ) {
      paintedOriginRef.current = renderedOriginRef.current;
      paintedTargetIdRef.current = renderedTargetIdRef.current;
    }
  }, []);

  /**
   * Build origin/target/navGen fence bound to the actually-painted frame.
   * Returns `null` when a newer `state.navGen` arrived before its frame finished painting
   * (pausing WS input so keystrokes/clicks cannot hit an unrendered destination page).
   */
  const getWsInputFence = useCallback(() => {
    const latestNavGen = stateRef.current?.navGen;
    if (typeof latestNavGen === "number" && latestNavGen > 0) {
      const painted = paintedNavGenRef.current;
      if (painted === null || (painted & 0xffff) !== (latestNavGen & 0xffff)) {
        return null;
      }
    }
    return {
      expectedOrigin: paintedOriginRef.current ?? renderedOriginRef.current,
      expectedTargetId: paintedTargetIdRef.current ?? renderedTargetIdRef.current,
      ...(paintedNavGenRef.current !== null ? { expectedNavGen: paintedNavGenRef.current } : {}),
      ...(stateRef.current?.takeoverToken ? { takeoverToken: stateRef.current.takeoverToken } : {}),
    };
  }, []);

  const syncTakeoverToStream = useCallback((active: boolean) => {
    wsTakeoverRequestedRef.current = active;
    const tok = stateRef.current?.takeoverToken;
    streamClientRef.current?.send({
      type: "takeover",
      active,
      ...(tok ? { takeoverToken: tok } : {}),
    });
  }, []);

  const stopHttpLeaseRenewal = useCallback(() => {
    if (httpLeaseRenewTimerRef.current !== null) {
      window.clearInterval(httpLeaseRenewTimerRef.current);
      httpLeaseRenewTimerRef.current = null;
    }
  }, []);

  const revokeTakeoverOnLeaseLost = useCallback(
    (notice = "当前由另一标签页独占接管") => {
      httpLeaseGenRef.current += 1;
      httpLeaseAcquiringRef.current = false;
      stopHttpLeaseRenewal();
      httpTakeoverTokenRef.current = null;
      httpLeaseHeldRef.current = false;
      wsTakeoverRequestedRef.current = false;
      takeoverActiveRef.current = false;
      prevTakeoverRef.current = false;
      const lostHandoffId = activeHandoffIdRef.current;
      activeHandoffIdRef.current = null;
      handoffContinuePromptRef.current = null;
      clearPendingInputBuffers();
      setTakeover(false);
      setTakeoverLeaseMode("none");
      setBusinessError(notice);
      reportHandoffPhase(lostHandoffId, "error", notice);
      toast(notice, "info");
    },
    [stopHttpLeaseRenewal, clearPendingInputBuffers, setBusinessError, reportHandoffPhase, toast],
  );

  const releaseHttpTakeoverLease = useCallback(
    (keepalive = false, strict = false): Promise<void> => {
      httpLeaseGenRef.current += 1;
      httpLeaseAcquiringRef.current = false;
      stopHttpLeaseRenewal();
      const token = httpTakeoverTokenRef.current;
      const hadLease = httpLeaseHeldRef.current || Boolean(token);
      if (!strict) {
        httpTakeoverTokenRef.current = null;
        httpLeaseHeldRef.current = false;
        if (mountedRef.current) setTakeoverLeaseMode("none");
      }
      if (!hadLease) return Promise.resolve();
      const payload: LiveBrowserActionPayload = token
        ? { action: "takeover", active: false, token }
        : { action: "takeover", active: false };
      return Promise.resolve(
        sendLiveBrowserAction(
          authRef.current,
          agentId,
          payload,
          keepalive ? { keepalive: true } : undefined,
        ),
      )
        .then(() => {
          if (strict) {
            httpTakeoverTokenRef.current = null;
            httpLeaseHeldRef.current = false;
            if (mountedRef.current) setTakeoverLeaseMode("none");
          }
        })
        .catch((err) => {
          if (strict) throw err;
          /* best-effort release on teardown */
        });
    },
    [agentId, stopHttpLeaseRenewal],
  );

  const acquireHttpTakeoverLease = useCallback(() => {
    const gen = ++httpLeaseGenRef.current;
    httpLeaseAcquiringRef.current = true;
    stopHttpLeaseRenewal();
    void Promise.resolve(
      sendLiveBrowserAction(authRef.current, agentId, { action: "takeover", active: true }),
    )
      .then((res) => {
        if (gen === httpLeaseGenRef.current) httpLeaseAcquiringRef.current = false;
        if (!mountedRef.current || gen !== httpLeaseGenRef.current || !takeoverActiveRef.current) {
          // Released before acquire completed: proactively release returned token.
          if (res?.humanTakeover && res.takeoverToken) {
            void Promise.resolve(
              sendLiveBrowserAction(authRef.current, agentId, {
                action: "takeover",
                active: false,
                token: res.takeoverToken,
              }),
            ).catch(() => {});
          }
          return;
        }
        if (res?.humanTakeover === true) {
          httpTakeoverTokenRef.current = res.takeoverToken ?? null;
          httpLeaseHeldRef.current = true;
          setTakeoverLeaseMode("exclusive");
          httpLeaseRenewTimerRef.current = window.setInterval(() => {
            if (!mountedRef.current || !takeoverActiveRef.current || gen !== httpLeaseGenRef.current) {
              stopHttpLeaseRenewal();
              return;
            }
            const tok = httpTakeoverTokenRef.current;
            void Promise.resolve(
              sendLiveBrowserAction(
                authRef.current,
                agentId,
                tok ? { action: "takeover", active: true, token: tok } : { action: "takeover", active: true },
              ),
            )
              .then((renewed) => {
                if (!mountedRef.current || gen !== httpLeaseGenRef.current) return;
                if (renewed?.takeoverToken) httpTakeoverTokenRef.current = renewed.takeoverToken;
                if (renewed?.humanTakeover === false) {
                  revokeTakeoverOnLeaseLost("当前由另一标签页独占接管");
                }
              })
              .catch((renewErr) => {
                if (!mountedRef.current || gen !== httpLeaseGenRef.current) return;
                if (isTakeoverConflictError(renewErr)) {
                  revokeTakeoverOnLeaseLost("当前由另一标签页独占接管");
                } else if (/助手正在操作浏览器|AGENT_RUNNING/.test(errorMessageOf(renewErr))) {
                  revokeTakeoverOnLeaseLost(errorMessageOf(renewErr));
                }
              });
          }, HTTP_TAKEOVER_RENEW_MS);
        } else {
          // Legacy server without exclusive human-takeover lease support: display honestly.
          httpTakeoverTokenRef.current = null;
          httpLeaseHeldRef.current = false;
          setTakeoverLeaseMode("compat");
        }
      })
      .catch((err) => {
        if (gen === httpLeaseGenRef.current) httpLeaseAcquiringRef.current = false;
        if (!mountedRef.current || gen !== httpLeaseGenRef.current) return;
        const msg = errorMessageOf(err);
        if (isTakeoverConflictError(err)) {
          revokeTakeoverOnLeaseLost("当前由另一标签页独占接管");
          return;
        }
        if ((err as { status?: number })?.status === 409 || /助手正在操作浏览器|AGENT_RUNNING/.test(msg)) {
          revokeTakeoverOnLeaseLost(msg);
          return;
        }
        // Legacy server rejecting unknown `takeover` action: honestly enter compat mode.
        httpTakeoverTokenRef.current = null;
        httpLeaseHeldRef.current = false;
        setTakeoverLeaseMode("compat");
      });
  }, [agentId, stopHttpLeaseRenewal, revokeTakeoverOnLeaseLost]);

  const focusCanvasSoon = useCallback(() => {
    window.requestAnimationFrame(() => {
      if (!mountedRef.current || !takeoverActiveRef.current) return;
      const activeEl = document.activeElement;
      if (activeEl && activeEl !== document.body && activeEl !== stageRef.current) return;
      canvasHandleRef.current?.focusCapture();
    });
  }, []);

  const activateHandoffOnActivePage = useCallback(
    (
      req: {
        takeover?: boolean;
        expand?: boolean;
        url?: string;
        continuePrompt?: string | null;
        handoffId?: string | null;
      },
      actualUrl: string | undefined,
      isBusyNow: boolean,
    ) => {
      const nextHandoffId = req.handoffId ?? null;
      const expected = parseOriginAndHost(req.url);
      const actual = parseOriginAndHost(actualUrl);
      if (expected && actual && expected.origin !== actual.origin) {
        takeoverActiveRef.current = false;
        clearPendingInputBuffers();
        setTakeover(false);
        syncTakeoverToStream(false);
        releaseHttpTakeoverLease(false);
        handoffContinuePromptRef.current = null;
        activeHandoffIdRef.current = null;
        setOriginMismatch({
          expectedOrigin: expected.origin,
          expectedHost: expected.host,
          actualOrigin: actual.origin,
          actualHost: actual.host,
          continuePrompt: req.continuePrompt?.trim() || null,
          handoffId: nextHandoffId,
        });
        setOriginMismatchDismissed(false);
        if (req.expand) setExpanded(true);
        reportHandoffPhase(
          nextHandoffId,
          "blocked",
          `当前页面域名为 ${actual.host}（与卡片 ${expected.host} 不一致），请在右侧浏览器核对后确认接管。`,
        );
        return;
      }
      setOriginMismatch(null);
      setOriginMismatchDismissed(false);
      activeHandoffIdRef.current = nextHandoffId;
      handoffContinuePromptRef.current = req.continuePrompt?.trim() || null;
      if (req.takeover && !isBusyNow) {
        setTakeover(true);
        syncTakeoverToStream(true);
        focusCanvasSoon();
      }
      if (req.expand) setExpanded(true);
      reportHandoffPhase(nextHandoffId, "active");
    },
    [clearPendingInputBuffers, syncTakeoverToStream, releaseHttpTakeoverLease, focusCanvasSoon, reportHandoffPhase],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pollAbortRef.current?.abort();
      clearPendingInputBuffers();
      releaseHttpTakeoverLease(true);
    };
  }, [clearPendingInputBuffers, releaseHttpTakeoverLease]);

  // Synchronize HTTP fallback human-takeover lease & honest WS lease confirmation.
  const serverConfirmedHumanTakeover = state?.humanTakeover === true;
  useEffect(() => {
    if (!effectiveTakeover) {
      wsTakeoverRequestedRef.current = false;
      releaseHttpTakeoverLease(false);
      return;
    }
    if (wsConnected) {
      if (httpLeaseHeldRef.current || httpTakeoverTokenRef.current) {
        releaseHttpTakeoverLease(false);
      }
      // Only show "独占接管中" once server confirms this connection holds humanTakeover=true.
      setTakeoverLeaseMode(
        serverConfirmedHumanTakeover && wsTakeoverRequestedRef.current ? "exclusive" : "none",
      );
      return;
    }
    // HTTP fallback mode: acquire & 30s-renew a real server-side human-takeover lease once per takeover.
    if (httpLeaseHeldRef.current || httpLeaseAcquiringRef.current) return;
    acquireHttpTakeoverLease();
  }, [
    effectiveTakeover,
    wsConnected,
    serverConfirmedHumanTakeover,
    acquireHttpTakeoverLease,
    releaseHttpTakeoverLease,
  ]);

  // Honest exclusive control: whenever assistant runs, exit takeover and notify user.
  useEffect(() => {
    if (lockedByAssistant) {
      const wasInTakeover = prevTakeoverRef.current;
      prevTakeoverRef.current = false;
      setTakeover(false);
      syncTakeoverToStream(false);
      clearPendingInputBuffers();
      if (wasInTakeover) {
        const reasonSuffix = state?.reason ? `（${state.reason}）` : "";
        toast(
          state?.agentBusy && !running
            ? `同智能体其他后台任务正在使用浏览器，已自动切回观看模式${reasonSuffix}`
            : `助手已接管浏览器，已自动切回观看模式${reasonSuffix}`,
          "info",
        );
      }
      return;
    }
    if (pendingTakeoverAfterStopRef.current && state?.active) {
      pendingTakeoverAfterStopRef.current = false;
      setTakeover(true);
      syncTakeoverToStream(true);
      focusCanvasSoon();
      toast("已暂停助手并进入人工接管", "success");
    }
  }, [
    lockedByAssistant,
    clearPendingInputBuffers,
    syncTakeoverToStream,
    focusCanvasSoon,
    running,
    state?.agentBusy,
    state?.active,
    state?.reason,
    toast,
  ]);

  useEffect(() => {
    prevTakeoverRef.current = effectiveTakeover;
  }, [effectiveTakeover]);

  // Reset state cleanly when switching agents or chat sessions.
  useEffect(() => {
    releaseHttpTakeoverLease(false);
    setTakeover(false);
    setTakeoverLeaseMode("none");
    setExpanded(false);
    setZoomMode("fit");
    setAddressEditing(false);
    setErrorState(null);
    setOriginMismatch(null);
    setOriginMismatchDismissed(false);
    setState(null);
    setStreamFrame(null);
    paintedNavGenRef.current = null;
    paintedOriginRef.current = undefined;
    paintedTargetIdRef.current = undefined;
    navGenMetaRef.current.clear();
    setStreamStatus("idle");
    setStreamStats({ fps: 0, rttMs: null, lastFrameAt: null, mode: "polling" });
    setRemoteCursor("default");
    setInitialLoading(true);
    pollErrorStreakRef.current = 0;
    unavailableStreakRef.current = 0;
    pendingTakeoverAfterStopRef.current = false;
    prevActiveRef.current = false;
    prevTakeoverRef.current = false;
    clearPendingInputBuffers();
    pendingHandoffRef.current = null;
    pendingPostOpenHandoffRef.current = null;
    handoffContinuePromptRef.current = null;
    activeHandoffIdRef.current = null;
    reqSeqRef.current += 1;
    appliedSeqRef.current = reqSeqRef.current;
    lastPollEpochRef.current = pollEpoch;
    pollAbortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, clearPendingInputBuffers, releaseHttpTakeoverLease]);

  // Release takeover lease & transient session errors cleanly on session switch.
  const prevSessionIdRef = useRef<string | null | undefined>(chatSessionId);
  useEffect(() => {
    if (prevSessionIdRef.current !== chatSessionId) {
      prevSessionIdRef.current = chatSessionId;
      if (takeoverActiveRef.current) {
        takeoverActiveRef.current = false;
        setTakeover(false);
        syncTakeoverToStream(false);
        releaseHttpTakeoverLease(false);
        clearPendingInputBuffers();
      }
      setErrorState(null);
      setOriginMismatch(null);
      setOriginMismatchDismissed(false);
      pendingTakeoverAfterStopRef.current = false;
      pendingHandoffRef.current = null;
      pendingPostOpenHandoffRef.current = null;
      handoffContinuePromptRef.current = null;
      activeHandoffIdRef.current = null;
      if (stateRef.current === null) {
        pollErrorStreakRef.current = 0;
        setInitialLoading(true);
        setPollEpoch((n) => n + 1);
      }
    }
  }, [chatSessionId, syncTakeoverToStream, releaseHttpTakeoverLease, clearPendingInputBuffers]);

  const applyState = useCallback(
    (seq: number, next: LiveBrowserState) => {
      if (!mountedRef.current || seq < appliedSeqRef.current) return;
      appliedSeqRef.current = seq;
      pollErrorStreakRef.current = 0;
      if (next.available) {
        unavailableStreakRef.current = 0;
      }
      const wasActive = prevActiveRef.current;
      prevActiveRef.current = next.active;
      setState(next);
      if (next.humanTakeover === false || !next.active) {
        flushWsReleaseWaiters();
      }
      setInitialLoading(false);
      setErrorState((prev) => {
        if (!prev) return null;
        if (prev.kind === "connection") return null;
        if (!next.agentBusy && /助手正在操作浏览器|AGENT_RUNNING/.test(prev.message)) return null;
        return prev;
      });
      onActiveStateChange?.(next.active);

      // Clear origin-mismatch lock automatically if the browser navigated back to expected origin.
      const nextOrigin = parseOriginAndHost(next.url)?.origin;
      if (nextOrigin) {
        setOriginMismatch((prev) =>
          prev && prev.expectedOrigin === nextOrigin ? null : prev,
        );
      }

      if (!next.active) {
        pendingPostOpenHandoffRef.current = null;
        setOriginMismatch(null);
        setOriginMismatchDismissed(false);
        setStreamFrame(null);
        const unexpectedClose = wasActive && !userClosingRef.current;
        userClosingRef.current = false;
        pendingTakeoverAfterStopRef.current = false;
        prevTakeoverRef.current = false;
        setTakeover(false);
        setExpanded(false);
        clearPendingInputBuffers();
        if (unexpectedClose) {
          toast(
            next.reason ? `云端浏览器已关闭（${next.reason}）` : "云端浏览器连接已结束，可重新启动。",
            "info",
          );
        }
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
    [onActiveStateChange, clearPendingInputBuffers, activateHandoffOnActivePage, toast],
  );

  // Sync address bar with live URL unless user is currently editing it.
  useEffect(() => {
    if (!addressEditing && typeof state?.url === "string") {
      setAddressDraft(state.url);
    }
  }, [state?.url, addressEditing]);

  // WebSocket real-time stream client lifecycle (with silent graceful fallback to HTTP polling).
  const applyStateRef = useRef(applyState);
  applyStateRef.current = applyState;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const client = new LiveBrowserStreamClient({
      agentId,
      getAuth: () => authRef.current,
      callbacks: {
        onStatus: (nextStatus) => {
          if (!mountedRef.current) return;
          setStreamStatus(nextStatus);
          if (nextStatus === "connected") {
            clearConnectionError();
            if (takeoverActiveRef.current) {
              client.send({
                type: "takeover",
                active: true,
              });
            }
          } else {
            // Immediately clear stale canvas frame so HTTP polling <img> renders cleanly without overlap.
            setStreamFrame(null);
            paintedNavGenRef.current = null;
            paintedOriginRef.current = undefined;
            paintedTargetIdRef.current = undefined;
            if (nextStatus === "replaced") {
              takeoverActiveRef.current = false;
              setTakeover(false);
              clearPendingInputBuffers();
            }
          }
        },
        onState: (payload) => {
          if (!mountedRef.current) return;
          if (typeof payload.navGen === "number") {
            const key = payload.navGen & 0xffff;
            if (navGenMetaRef.current.size > 32) {
              const firstKey = navGenMetaRef.current.keys().next().value;
              if (firstKey !== undefined) navGenMetaRef.current.delete(firstKey);
            }
            navGenMetaRef.current.set(key, {
              origin: payload.origin ?? parseOriginAndHost(payload.url)?.origin,
              targetId: payload.targetId,
            });
          }
          if (payload.cdpAvailable === false) {
            setStreamFrame(null);
            paintedNavGenRef.current = null;
          }
          const seq = ++reqSeqRef.current;
          const merged = mergeStreamState(stateRef.current, payload);
          applyStateRef.current(seq, merged);
        },
        onFrame: (frame) => {
          if (!mountedRef.current) return;
          clearConnectionError();
          setStreamFrame(frame);
        },
        onCursor: (cursor) => {
          if (!mountedRef.current) return;
          setRemoteCursor(cursor || "default");
        },
        onStats: (stats) => {
          if (!mountedRef.current) return;
          setStreamStats(stats);
        },
        onError: (msg, code, retryable) => {
          if (!mountedRef.current) return;
          if (code === "CDP_UNAVAILABLE") {
            // Silently fall back to HTTP polling preserving active HTTP screenshot.
            setStreamFrame(null);
            setState((prev) => (prev ? { ...prev, cdpAvailable: false } : prev));
            setPollEpoch((n) => n + 1);
            return;
          }
          if (code === "TAKEOVER_ALREADY_HELD" || code === "TAKEOVER_TOKEN_MISMATCH") {
            revokeTakeoverOnLeaseLost("当前由另一标签页独占接管");
            return;
          }
          if (code === "TAKEOVER_REQUIRED") {
            if (takeoverActiveRef.current) {
              revokeTakeoverOnLeaseLost(msg);
            } else {
              setBusinessError(msg);
            }
            return;
          }
          if (code === "ORIGIN_MISMATCH" || code === "TARGET_MISMATCH") {
            // Pause takeover immediately and demand explicit user confirmation on the new page/origin.
            takeoverActiveRef.current = false;
            setTakeover(false);
            client.send({ type: "takeover", active: false });
            clearPendingInputBuffers();
            const expected = parseOriginAndHost(renderedOriginRef.current ?? stateUrlRef.current);
            const actual = parseOriginAndHost(stateUrlRef.current);
            setOriginMismatch({
              expectedOrigin: expected?.origin ?? renderedOriginRef.current ?? "",
              expectedHost: expected?.host ?? "原页面",
              actualOrigin: actual?.origin ?? "",
              actualHost: actual?.host ?? "当前新页面",
              continuePrompt: handoffContinuePromptRef.current,
              handoffId: activeHandoffIdRef.current,
            });
            setOriginMismatchDismissed(false);
            toast("页面来源或标签页已变化，已暂停输入，请核对地址栏后重新确认接管", "info");
            return;
          }
          if (code === "AGENT_RUNNING" || /助手正在操作浏览器|AGENT_RUNNING/.test(msg)) {
            setState((prev) => (prev ? { ...prev, agentBusy: true } : prev));
            setBusinessError(msg);
            return;
          }
          if (retryable === false || isBusinessError(undefined, msg, code)) {
            setBusinessError(msg);
          } else {
            setConnectionError(msg);
          }
        },
        onFallback: () => {
          if (!mountedRef.current) return;
          setStreamFrame(null);
        },
      },
    });
    streamClientRef.current = client;
    client.start();

    return () => {
      client.dispose();
      if (streamClientRef.current === client) {
        streamClientRef.current = null;
      }
    };
  }, [agentId, clearConnectionError, setBusinessError, setConnectionError]);

  const pollOnce = useCallback(async (): Promise<boolean> => {
    if (!mountedRef.current || actionInFlightRef.current || pollInFlightRef.current) return true;
    if (typeof document !== "undefined" && document.hidden) return true;
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
      if (ctrl.signal.aborted) return true;
      if (!next.available) {
        unavailableStreakRef.current += 1;
      }
      applyState(mySeq, next);
      return true;
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current) return true;
      pollErrorStreakRef.current += 1;
      const msg = errorMessageOf(err);
      setInitialLoading(false);
      setErrorState((prev) => prev ?? { message: msg, kind: "connection" });
      if (stateRef.current === null && pendingHandoffRef.current) {
        const failedReq = pendingHandoffRef.current;
        pendingHandoffRef.current = null;
        reportHandoffPhase(failedReq.handoffId, "error", msg);
        onHandoffSettledRef.current?.(failedReq.nonce);
      }
      return false;
    } finally {
      if (pollAbortRef.current === ctrl) {
        pollAbortRef.current = null;
        pollInFlightRef.current = false;
      }
    }
  }, [agentId, applyState, reportHandoffPhase]);

  const handleRetryConnection = useCallback(() => {
    pollErrorStreakRef.current = 0;
    unavailableStreakRef.current = 0;
    clearError();
    if (!state || !state.available) {
      setState(null);
      setInitialLoading(true);
    }
    streamClientRef.current?.retryNow();
    setPollEpoch((n) => n + 1);
  }, [state, clearError]);

  // Adaptive HTTP polling: active whenever WS is NOT connected; automatically pauses when WS is live.
  // Also handles exponential backoff re-check when `available: false` (cold-start recovery).
  const isActive = state?.active === true;
  const isAvailable = state?.available !== false;
  const stateIsNull = state === null;

  useEffect(() => {
    if (wsConnected) return;
    if (hidden && !effectiveTakeover) return;

    let cancelled = false;
    let timer: number | null = null;

    // Takeover polls faster (450ms) than watch mode (900ms); unavailable retries with backoff.
    const baseIntervalMs = !isAvailable && !stateIsNull
      ? UNAVAILABLE_BASE_BACKOFF_MS
      : isActive
        ? effectiveTakeover
          ? 450
          : 900
        : lockedByAssistant
          ? 1800
          : 4000;

    const nextDelayMs = () => {
      if (!isAvailable && !stateIsNull) {
        const streak = Math.max(0, unavailableStreakRef.current - 1);
        return Math.min(MAX_POLL_BACKOFF_MS, UNAVAILABLE_BASE_BACKOFF_MS * 2 ** Math.min(streak, 4));
      }
      const streak = pollErrorStreakRef.current;
      if (streak <= 0) return baseIntervalMs;
      return Math.min(MAX_POLL_BACKOFF_MS, baseIntervalMs * 2 ** Math.min(streak, 4));
    };

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
      schedule(nextDelayMs());
    };

    // Only fire an immediate poll on initial mount or when pollEpoch genuinely incremented.
    const epochChanged = pollEpoch !== lastPollEpochRef.current;
    if (epochChanged) {
      lastPollEpochRef.current = pollEpoch;
    }
    if (stateIsNull || epochChanged) {
      void runCycle();
    } else {
      schedule(nextDelayMs());
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
        pollErrorStreakRef.current = 0;
        void runCycle();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [
    agentId,
    wsConnected,
    hidden,
    isActive,
    isAvailable,
    lockedByAssistant,
    effectiveTakeover,
    pollOnce,
    stateIsNull,
    pollEpoch,
  ]);

  const runAction = useCallback(
    async (payload: LiveBrowserActionPayload) => {
      if (!mountedRef.current) return;
      pollAbortRef.current?.abort();
      actionInFlightRef.current = true;
      setBusy(true);
      clearError();
      const mySeq = ++reqSeqRef.current;
      let succeeded = false;
      try {
        const liveOrigin = parseOriginAndHost(stateUrlRef.current)?.origin;
        const withOrigin: LiveBrowserActionPayload =
          liveOrigin &&
          (payload.action === "click" ||
            payload.action === "dblclick" ||
            payload.action === "hover" ||
            payload.action === "drag" ||
            payload.action === "wheel" ||
            payload.action === "type" ||
            payload.action === "paste" ||
            payload.action === "press") &&
          !payload.expectedOrigin
            ? { ...payload, expectedOrigin: liveOrigin }
            : payload;
        const activeToken = payload.action !== "takeover" ? httpTakeoverTokenRef.current : null;
        const enrichedPayload = (
          activeToken ? { ...withOrigin, takeoverToken: activeToken } : withOrigin
        ) as LiveBrowserActionPayload;
        const next = await sendLiveBrowserAction(authRef.current, agentId, enrichedPayload);
        succeeded = true;
        applyState(mySeq, next);
      } catch (err) {
        const post = pendingPostOpenHandoffRef.current;
        pendingPostOpenHandoffRef.current = null;
        // Pause/clear pending input queue on failure so errors never cascade-spam.
        clearPendingInputBuffers();
        if (!isAbortError(err) && mountedRef.current) {
          const msg = errorMessageOf(err);
          const isAgentBusyConflict =
            !isTakeoverRequiredError(err) &&
            (/助手正在操作浏览器|AGENT_RUNNING/.test(msg) ||
              ((err as { status?: number })?.status === 409 && !isTakeoverConflictError(err)));
          if (isAgentBusyConflict) {
            setState((prev) => (prev ? { ...prev, agentBusy: true } : prev));
            if (post) {
              pendingHandoffRef.current = {
                nonce: post.nonce,
                takeover: post.takeover,
                expand: post.expand,
                url: post.url,
                continuePrompt: post.continuePrompt ?? undefined,
                handoffId: post.handoffId ?? undefined,
              };
              reportHandoffPhase(post.handoffId, "blocked", "助手正在执行浏览器步骤，稍候即可在右侧接管操作。");
            } else {
              setBusinessError(msg);
            }
          } else if (isTakeoverConflictError(err)) {
            if (post) {
              reportHandoffPhase(post.handoffId, "error", "当前由另一标签页独占接管");
              onHandoffSettledRef.current?.(post.nonce);
            }
            revokeTakeoverOnLeaseLost("当前由另一标签页独占接管");
          } else if (isTakeoverRequiredError(err)) {
            if (post) {
              reportHandoffPhase(post.handoffId, "error", msg);
              onHandoffSettledRef.current?.(post.nonce);
            }
            if (takeoverActiveRef.current) {
              revokeTakeoverOnLeaseLost(msg);
            } else {
              setBusinessError(msg);
            }
          } else {
            if (post) {
              reportHandoffPhase(post.handoffId, "error", msg);
              onHandoffSettledRef.current?.(post.nonce);
            }
            if (isBusinessError(err, msg)) {
              setBusinessError(msg);
            } else {
              setConnectionError(msg);
            }
          }
        }
      } finally {
        actionInFlightRef.current = false;
        if (mountedRef.current) setBusy(false);
        // Drain next queued canvas input strictly FIFO ONLY when the previous action succeeded.
        if (succeeded && mountedRef.current && takeoverActiveRef.current) {
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
    [
      agentId,
      applyState,
      clearError,
      clearPendingInputBuffers,
      reportHandoffPhase,
      revokeTakeoverOnLeaseLost,
      setBusinessError,
      setConnectionError,
    ],
  );

  const enqueueCanvasInput = useCallback(
    (payload: LiveBrowserActionPayload): boolean => {
      if (!takeoverActiveRef.current) return false;
      if (inputQueueRef.current.length >= 12) {
        setBusinessError("操作队列已满，请等待当前操作完成后再试");
        return false;
      }
      inputQueueRef.current.push(payload);
      if (!actionInFlightRef.current) {
        const next = inputQueueRef.current.shift();
        if (next) void runAction(next);
      }
      return true;
    },
    [runAction, setBusinessError],
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
    if (streamClientRef.current?.isConnected()) {
      const fence = getWsInputFence();
      if (!fence) return;
      streamClientRef.current.send({ type: "insert_text", text: pending, ...fence });
      return;
    }
    enqueueCanvasInput({ action: "type", text: pending, submit: false });
  }, [enqueueCanvasInput]);

  // Unified action dispatchers: WS first when connected, HTTP fallback otherwise.
  const handleLaunch = (e: FormEvent) => {
    e.preventDefault();
    if (lockedByAssistant || busy) return;
    const url = normalizeBrowserUrlInput(launchUrl);
    if (!url) {
      setBusinessError("请输入有效的 http:// 或 https:// 网址");
      return;
    }
    if (streamClientRef.current?.send({ type: "open", url })) return;
    void runAction({ action: "open", url });
  };

  const handleAddressSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (lockedByAssistant || busy || !takeoverActiveRef.current) return;
    const url = normalizeBrowserUrlInput(addressDraft);
    if (!url) {
      setBusinessError("仅支持打开 http:// 或 https:// 网址");
      return;
    }
    setAddressEditing(false);
    if (streamClientRef.current?.send({ type: "navigate", url })) return;
    void runAction({ action: "goto", url });
  };

  const handleHistory = useCallback(
    (action: "back" | "forward" | "reload" | "stop") => {
      if (lockedByAssistant || !takeoverActiveRef.current) return;
      if (streamClientRef.current?.send({ type: "history", action })) return;
      void runAction({ action });
    },
    [lockedByAssistant, runAction],
  );

  const handleTabSelect = useCallback(
    (tab: LiveBrowserTabInfo) => {
      if (lockedByAssistant || !takeoverActiveRef.current) return;
      if (
        streamClientRef.current?.send({
          type: "tab",
          action: "select",
          ...(tab.id ? { targetId: tab.id, id: tab.id } : {}),
          index: tab.index,
        })
      ) {
        return;
      }
      void runAction({ action: "tab_select", index: tab.index });
    },
    [lockedByAssistant, runAction],
  );

  const handleTabClose = useCallback(
    (tab: LiveBrowserTabInfo) => {
      if (lockedByAssistant || !takeoverActiveRef.current) return;
      if (tab.id) {
        const sent = streamClientRef.current?.send({
          type: "tab",
          action: "close",
          targetId: tab.id,
          id: tab.id,
        });
        if (sent) return;
        // Never downgrade a stable targetId close to a mutable HTTP index close (avoids closing wrong tab).
        setPollEpoch((n) => n + 1);
        toast("实时连接波动，未能关闭标签页，已刷新标签列表请重试", "info");
        return;
      }
      if (streamClientRef.current?.send({ type: "tab", action: "close", index: tab.index })) return;
      void runAction({ action: "tab_close", index: tab.index });
    },
    [lockedByAssistant, runAction, toast],
  );

  const handleTabNew = useCallback(() => {
    if (lockedByAssistant || !takeoverActiveRef.current) return;
    if (streamClientRef.current?.send({ type: "tab", action: "new" })) return;
    void runAction({ action: "tab_new" });
  }, [lockedByAssistant, runAction]);

  const handleCloseBrowser = useCallback(() => {
    if (lockedByAssistant || !takeoverActiveRef.current) return;
    userClosingRef.current = true;
    pendingTakeoverAfterStopRef.current = false;
    clearPendingInputBuffers();
    const sentViaWs = Boolean(streamClientRef.current?.send({ type: "close_browser" }));
    if (sentViaWs) {
      setExpanded(false);
      return;
    }
    // Wait for HTTP close to finish WHILE httpTakeoverTokenRef is still held so backend verifies lease ownership.
    void runAction({ action: "close" }).finally(() => {
      if (!mountedRef.current) return;
      takeoverActiveRef.current = false;
      prevTakeoverRef.current = false;
      setTakeover(false);
      setExpanded(false);
    });
  }, [lockedByAssistant, clearPendingInputBuffers, runAction]);

  const handleEnterTakeover = useCallback(() => {
    if (lockedByAssistant || originMismatch) return;
    activeHandoffIdRef.current = null;
    setTakeover(true);
    syncTakeoverToStream(true);
    focusCanvasSoon();
  }, [lockedByAssistant, originMismatch, syncTakeoverToStream, focusCanvasSoon]);

  const handlePointerEvent = useCallback(
    (evt: { action: "move" | "down" | "up" | "click" | "dblclick"; x: number; y: number; button?: LiveBrowserMouseButton; clickCount?: number; modifiers?: number }): boolean => {
      if (!takeoverActiveRef.current) return false;
      if (streamClientRef.current?.isConnected()) {
        const fence = getWsInputFence();
        return fence ? streamClientRef.current.send({ type: "pointer", ...evt, ...fence }) : false;
      }
      if (evt.action === "dblclick") return enqueueCanvasInput({ action: "dblclick", x: evt.x, y: evt.y, normalized: true });
      if (evt.action === "click") return enqueueCanvasInput({ action: "click", x: evt.x, y: evt.y, normalized: true, button: evt.button ?? "left" });
      return false;
    },
    [enqueueCanvasInput, getWsInputFence],
  );

  const handleDragFallback = useCallback(
    (evt: { fromX: number; fromY: number; toX: number; toY: number }) => {
      enqueueCanvasInput({ action: "drag", ...evt, normalized: true });
    },
    [enqueueCanvasInput],
  );

  const handleWheelEvent = useCallback(
    (evt: { x?: number; y?: number; deltaX: number; deltaY: number; modifiers?: number }) => {
      if (!takeoverActiveRef.current) return;
      if (streamClientRef.current?.isConnected()) {
        const fence = getWsInputFence();
        if (fence) streamClientRef.current.send({ type: "wheel", ...evt, ...fence });
        return;
      }
      enqueueCanvasInput({ action: "wheel", x: evt.x, y: evt.y, normalized: true, deltaX: evt.deltaX, deltaY: evt.deltaY });
    },
    [enqueueCanvasInput, getWsInputFence],
  );

  const handleKeyEvent = useCallback(
    (evt: { action: "down" | "up" | "press"; key: string; code?: string; modifiers?: number }) => {
      if (!takeoverActiveRef.current) return;
      if (streamClientRef.current?.isConnected()) {
        const fence = getWsInputFence();
        if (fence) streamClientRef.current.send({ type: "key", ...evt, ...fence });
        return;
      }
      enqueueCanvasInput({ action: "press", key: formatPlaywrightKey(evt.key, evt.modifiers) });
    },
    [enqueueCanvasInput, getWsInputFence],
  );

  const handleInsertText = useCallback(
    (text: string) => {
      if (!text || !takeoverActiveRef.current) return;
      if (streamClientRef.current?.isConnected()) {
        const fence = getWsInputFence();
        if (fence) streamClientRef.current.send({ type: "insert_text", text, ...fence });
        return;
      }
      enqueueCanvasInput({ action: "type", text, submit: false });
    },
    [enqueueCanvasInput, getWsInputFence],
  );

  const handlePasteText = useCallback(
    (text: string) => {
      if (!text || !takeoverActiveRef.current) return;
      if (streamClientRef.current?.isConnected()) {
        const fence = getWsInputFence();
        if (fence) streamClientRef.current.send({ type: "insert_text", text, ...fence });
        return;
      }
      enqueueCanvasInput({ action: "paste", text });
    },
    [enqueueCanvasInput, getWsInputFence],
  );

  const handleStagePrintableKey = useCallback(
    (char: string) => {
      if (streamClientRef.current?.isConnected()) {
        const fence = getWsInputFence();
        if (fence) streamClientRef.current.send({ type: "insert_text", text: char, ...fence });
        return;
      }
      const buf = keyBufferRef.current;
      buf.text += char;
      if (buf.timer !== null) window.clearTimeout(buf.timer);
      buf.timer = window.setTimeout(() => {
        buf.timer = null;
        flushKeyBufferToQueue();
      }, 160);
    },
    [flushKeyBufferToQueue, getWsInputFence],
  );

  const handleRespondDialog = useCallback(
    (accept: boolean, promptText?: string) => {
      if (lockedByAssistant || !takeoverActiveRef.current) return;
      if (streamClientRef.current?.send({ type: "dialog", accept, promptText })) return;
      void runAction({ action: "dialog", accept, promptText });
    },
    [lockedByAssistant, runAction],
  );

  const handleSendText = (submit: boolean) => {
    if (!typeDraft || busy || lockedByAssistant || !takeoverActiveRef.current) return;
    const text = typeDraft;
    setTypeDraft("");
    if (streamClientRef.current?.isConnected()) {
      const fence = getWsInputFence();
      if (!fence) return;
      streamClientRef.current.send({ type: "insert_text", text, ...fence });
      if (submit) {
        streamClientRef.current.send({ type: "key", action: "press", key: "Enter", code: "Enter", ...fence });
      }
      return;
    }
    void runAction({ action: "type", text, submit });
  };

  const releaseTakeoverCommon = useCallback(
    async (strict = false): Promise<void> => {
      const clearLocal = () => {
        takeoverActiveRef.current = false;
        prevTakeoverRef.current = false;
        pendingTakeoverAfterStopRef.current = false;
        clearPendingInputBuffers();
        if (!mountedRef.current) return;
        setTakeover(false);
        setExpanded(false);
        setOriginMismatch(null);
        setOriginMismatchDismissed(false);
      };
      if (!strict) {
        clearLocal();
        syncTakeoverToStream(false);
        await releaseHttpTakeoverLease(false, false);
        return;
      }
      const waitWsAck =
        wsConnectedRef.current && stateRef.current?.humanTakeover === true
          ? new Promise<void>((resolve) => {
              let done = false;
              const finish = () => {
                if (done) return;
                done = true;
                window.clearTimeout(timer);
                wsReleaseWaitersRef.current.delete(finish);
                resolve();
              };
              const timer = window.setTimeout(finish, 1200);
              wsReleaseWaitersRef.current.add(finish);
            })
          : null;
      syncTakeoverToStream(false);
      await releaseHttpTakeoverLease(false, true);
      if (waitWsAck) await waitWsAck;
      clearLocal();
    },
    [clearPendingInputBuffers, syncTakeoverToStream, releaseHttpTakeoverLease],
  );

  const emitHandback = useCallback(
    (handoffId: string | null, autoSent: boolean, sessionId = chatSessionIdRef.current ?? null) => {
      notifyLiveBrowserHandback({ sessionId, handoffId, agentId, autoSent });
    },
    [agentId],
  );

  // Allow chat BrowserHandoffBlock's "我已完成，继续任务" button to release our active takeover
  // lease BEFORE sending the single continuation message (strictly matching sessionId + handoffId).
  useEffect(() => {
    return registerLiveBrowserHandbackHandler(async (req) => {
      const currentSessionId = chatSessionIdRef.current ?? null;
      if (req.sessionId !== currentSessionId) return { handled: false };
      if (!takeoverActiveRef.current && !httpLeaseHeldRef.current && !wsTakeoverRequestedRef.current) {
        return { handled: false };
      }
      if (activeHandoffIdRef.current !== req.handoffId) {
        toast("当前正在进行另一项浏览器接管，请先从浏览器顶栏完成或退出接管", "info");
        return { handled: false, blocked: true };
      }
      if (handbackInFlightRef.current) return { handled: true };
      handbackInFlightRef.current = true;
      try {
        await releaseTakeoverCommon(true);
        handoffContinuePromptRef.current = null;
        activeHandoffIdRef.current = null;
        const canSend = Boolean(sendUserTextRef.current && !chatBusyRef.current);
        if (canSend) {
          sendUserTextRef.current?.(req.continueMessage || SAFE_HANDBACK_CONTINUE_MESSAGE);
          emitHandback(req.handoffId, true, currentSessionId);
          toast("已交还控制权并通知助手继续任务", "success");
        } else {
          emitHandback(req.handoffId, false, currentSessionId);
          toast("已交还云端浏览器控制权", "success");
        }
        return { handled: true };
      } catch {
        toast("交还浏览器控制权失败，请重试", "error");
        return { handled: false, failed: true };
      } finally {
        handbackInFlightRef.current = false;
      }
    });
  }, [emitHandback, releaseTakeoverCommon, toast]);

  const handleHandBackAndContinue = useCallback(async () => {
    if (handbackInFlightRef.current) return;
    handbackInFlightRef.current = true;
    try {
      await releaseTakeoverCommon(true);
      const customPrompt = handoffContinuePromptRef.current;
      const handoffId = activeHandoffIdRef.current;
      handoffContinuePromptRef.current = null;
      activeHandoffIdRef.current = null;
      // Never interpolate untrusted external webpage title or URL (prevents token leakage & prompt injection).
      const safeContinue = customPrompt || SAFE_HANDBACK_CONTINUE_MESSAGE;
      if (sendUserText && !chatBusy) {
        sendUserText(SAFE_HANDBACK_CONTINUE_MESSAGE);
        emitHandback(handoffId, true);
        toast("已交还控制权并通知助手继续任务", "success");
      } else if (onHandBackToComposer) {
        onHandBackToComposer(safeContinue);
        emitHandback(handoffId, false);
        toast("已交还控制权，并将续跑指令填入输入框", "success");
      } else {
        emitHandback(handoffId, false);
        toast("已交还云端浏览器控制权", "success");
      }
    } catch {
      toast("交还浏览器控制权失败，请重试", "error");
    } finally {
      handbackInFlightRef.current = false;
    }
  }, [releaseTakeoverCommon, sendUserText, chatBusy, emitHandback, onHandBackToComposer, toast]);

  const handleHandBackOnly = useCallback(() => {
    void releaseTakeoverCommon();
    const handoffId = activeHandoffIdRef.current;
    handoffContinuePromptRef.current = null;
    activeHandoffIdRef.current = null;
    emitHandback(handoffId, false);
    toast("已退出人工接管，交还助手控制权", "info");
  }, [releaseTakeoverCommon, emitHandback, toast]);

  const handlePauseAndTakeover = () => {
    if (!effectiveStopTurn) return;
    pendingTakeoverAfterStopRef.current = true;
    effectiveStopTurn();
    toast("正在暂停助手，暂停完成后自动进入人工接管…", "info");
  };

  const handleCopyUrl = useCallback(async (): Promise<boolean> => {
    if (!state?.url) return false;
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(state.url);
      toast("已复制当前页面网址", "success");
      return true;
    } catch {
      toast("复制失败，请手动复制地址栏内容", "error");
      return false;
    }
  }, [state?.url, toast]);

  const handleScreenshot = useCallback(() => {
    const dataUrl = canvasHandleRef.current?.exportScreenshotDataUrl();
    if (!dataUrl) {
      toast("当前暂无可保存的页面画面", "info");
      return;
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const ext = dataUrl.startsWith("data:image/png") ? "png" : "jpg";
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `live-browser-${ts}.${ext}`;
    link.click();
    toast("已保存当前浏览器画面截图", "success");
  }, [toast]);

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
  const stateReason = state?.reason;
  useEffect(() => {
    const req = pendingHandoffRef.current;
    if (!req) return;
    if (!stateLoaded) {
      if (!initialLoading && error) {
        pendingHandoffRef.current = null;
        reportHandoffPhase(req.handoffId, "error", error);
        onHandoffSettledRef.current?.(req.nonce);
      }
      return;
    }
    if (!stateAvailable) {
      pendingHandoffRef.current = null;
      reportHandoffPhase(
        req.handoffId,
        "error",
        stateReason && stateReason !== "unavailable" ? stateReason : "当前环境未启用云端浏览器",
      );
      onHandoffSettledRef.current?.(req.nonce);
      return;
    }
    if (lockedByAssistant || busy || actionInFlightRef.current) {
      reportHandoffPhase(req.handoffId, "blocked", "助手正在执行浏览器步骤，稍候即可在右侧接管操作。");
      return;
    }
    pendingHandoffRef.current = null;
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
          handoffId: req.handoffId ?? null,
        };
        void runAction({ action: "open", url: normalized, ifIdle: true });
        return;
      }
      reportHandoffPhase(req.handoffId, "error", "目标网址格式无效");
      onHandoffSettledRef.current?.(req.nonce);
      return;
    }
    reportHandoffPhase(req.handoffId, "error", "云端浏览器尚未启动，请先在右侧启动浏览器");
    onHandoffSettledRef.current?.(req.nonce);
  }, [
    handoffRequest,
    initialLoading,
    error,
    stateLoaded,
    stateActive,
    stateAvailable,
    stateUrl,
    stateReason,
    lockedByAssistant,
    busy,
    runAction,
    activateHandoffOnActivePage,
    reportHandoffPhase,
  ]);

  if (initialLoading && !state) {
    return <LiveBrowserLoadingView />;
  }

  if (!state && error) {
    return <LiveBrowserConnectErrorView error={error} onRetry={handleRetryConnection} />;
  }

  if (state && !state.available) {
    return <LiveBrowserUnavailableView reason={state.reason} onRetry={handleRetryConnection} />;
  }

  if (!state?.active) {
    return (
      <LiveBrowserIdleView
        error={error}
        errorRetryable={errorRetryable}
        launchUrl={launchUrl}
        busy={busy}
        lockedByAssistant={lockedByAssistant}
        onLaunchUrlChange={setLaunchUrl}
        onLaunchSubmit={handleLaunch}
        onSelectPreset={(presetUrl) => {
          setLaunchUrl(presetUrl);
          if (!streamClientRef.current?.send({ type: "open", url: presetUrl })) {
            void runAction({ action: "open", url: presetUrl });
          }
        }}
        onRetry={handleRetryConnection}
        onDismissError={clearError}
      />
    );
  }

  const tabs = state.tabs ?? [];
  const canAutoSendContinue = Boolean(sendUserText && !chatBusy);

  const browserShell = (
    <>
      {error && (
        <LiveBrowserErrorBanner
          error={error}
          retryable={errorRetryable}
          onRetry={handleRetryConnection}
          onDismiss={clearError}
        />
      )}

      {originMismatch && !originMismatchDismissed && !effectiveTakeover && (
        <div className="lb-handoff-banner oc-callout oc-callout-warning" role="alert" data-testid="live-browser-origin-mismatch">
          <span className="lb-handoff-body">
            <span className="oc-icon-badge oc-icon-badge-warning size-6 rounded-xs" aria-hidden>
              <ShieldAlert size={13} />
            </span>
            <span>
              当前实时页面域名为 <strong>{originMismatch.actualHost}</strong>（卡片指向{" "}
              <strong>{originMismatch.expectedHost}</strong>）。请核对地址栏；如为正常跳转（如第三方 SSO 登录），确认后再开启接管。
            </span>
          </span>
          <div className="lb-handoff-actions">
            <button
              type="button"
              className="lb-cta-btn oc-btn-tactile"
              data-variant="watch"
              disabled={lockedByAssistant}
              data-testid="live-browser-confirm-mismatch"
              onClick={() => {
                if (lockedByAssistant) return;
                const currentActual = parseOriginAndHost(state?.url);
                if (currentActual && currentActual.host !== originMismatch.actualHost) {
                  setOriginMismatch({
                    ...originMismatch,
                    actualOrigin: currentActual.origin,
                    actualHost: currentActual.host,
                  });
                  return;
                }
                const prompt = originMismatch.continuePrompt;
                const nextHandoffId = originMismatch.handoffId ?? null;
                setOriginMismatch(null);
                setOriginMismatchDismissed(false);
                handoffContinuePromptRef.current = prompt;
                activeHandoffIdRef.current = nextHandoffId;
                setTakeover(true);
                syncTakeoverToStream(true);
                focusCanvasSoon();
                reportHandoffPhase(nextHandoffId, "active");
              }}
            >
              确认接管当前页
            </button>
            <button
              type="button"
              className="lb-icon-btn oc-btn-tactile"
              aria-label="收起域名核对提示"
              title="收起提示（仍需核对确认后才可接管）"
              data-testid="live-browser-dismiss-mismatch"
              onClick={() => setOriginMismatchDismissed(true)}
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}

      <div className="lb-shell" data-takeover={effectiveTakeover ? "true" : "false"}>
        <LiveBrowserToolbar
          url={state.url}
          title={state.title}
          loading={state.loading}
          capturedAt={state.capturedAt}
          tabs={tabs}
          addressDraft={addressDraft}
          onAddressDraftChange={setAddressDraft}
          onAddressEditingChange={setAddressEditing}
          onAddressSubmit={handleAddressSubmit}
          effectiveTakeover={effectiveTakeover}
          takeoverLeaseMode={takeoverLeaseMode}
          lockedByAssistant={lockedByAssistant}
          running={running}
          canPauseAndTakeover={Boolean(effectiveStopTurn)}
          canAutoSendContinue={canAutoSendContinue}
          originMismatchLocked={Boolean(originMismatch)}
          originMismatchDismissed={originMismatchDismissed}
          onReopenOriginMismatch={() => setOriginMismatchDismissed(false)}
          busy={busy}
          expanded={expanded}
          expandBtnRef={expandBtnRef}
          zoomMode={zoomMode}
          onToggleZoom={() => setZoomMode((prev) => (prev === "fit" ? "1:1" : "fit"))}
          captureFocused={captureFocused}
          onReleaseCaptureFocus={() => canvasHandleRef.current?.blurCapture()}
          connectionStatus={streamStatus}
          hasConnectionError={errorRetryable}
          streamStats={streamStats}
          onHistory={handleHistory}
          onTabSelect={handleTabSelect}
          onTabClose={handleTabClose}
          onTabNew={handleTabNew}
          onEnterTakeover={handleEnterTakeover}
          onPauseAndTakeover={handlePauseAndTakeover}
          onHandBackAndContinue={handleHandBackAndContinue}
          onHandBackOnly={handleHandBackOnly}
          onToggleExpand={() => setExpanded((prev) => !prev)}
          onCloseBrowser={handleCloseBrowser}
          onCopyUrl={handleCopyUrl}
          onScreenshot={handleScreenshot}
        />

        <LiveBrowserCanvas
          canvasHandleRef={canvasHandleRef}
          stageRef={stageRef}
          viewport={state.viewport}
          title={state.title}
          imageBase64={state.imageBase64}
          mimeType={state.mimeType}
          streamFrame={streamFrame}
          effectiveTakeover={effectiveTakeover}
          lockedByAssistant={lockedByAssistant}
          originMismatchLocked={Boolean(originMismatch)}
          wsConnected={wsConnected}
          connectionStatus={streamStatus}
          busy={busy}
          zoomMode={zoomMode}
          remoteCursor={remoteCursor}
          dialog={state.dialog}
          onRequestTakeover={handleEnterTakeover}
          onRetryConnection={handleRetryConnection}
          onPointerEvent={handlePointerEvent}
          onDragFallback={handleDragFallback}
          onWheelEvent={handleWheelEvent}
          onKeyEvent={handleKeyEvent}
          onInsertText={handleInsertText}
          onPasteText={handlePasteText}
          onStagePrintableKey={handleStagePrintableKey}
          onFlushKeyBuffer={flushKeyBufferToQueue}
          onRespondDialog={handleRespondDialog}
          onCaptureFocusChange={setCaptureFocused}
          onFramePainted={handleFramePainted}
        />

        {effectiveTakeover && (
          <LiveBrowserTakeoverDock
            typeDraft={typeDraft}
            busy={busy}
            onTypeDraftChange={setTypeDraft}
            onSendText={handleSendText}
            onPressQuickKey={(key) => handleKeyEvent({ action: "press", key })}
          />
        )}
      </div>
    </>
  );

  return (
    <>
      {expanded ? (
        <div className="lb-root" data-testid="live-browser-docked">
          <div className="lb-docked-placeholder oc-surface-card">
            <span className="lb-idle-icon oc-icon-badge oc-icon-badge-accent" aria-hidden>
              <Maximize2 size={17} />
            </span>
            <p className="lb-idle-desc">云端浏览器正在全屏放大视图中运行</p>
            <button
              type="button"
              className="lb-preset-chip oc-btn-tactile oc-btn-secondary-craft"
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
              e.preventDefault();
              window.requestAnimationFrame(() => expandBtnRef.current?.focus());
            }}
            onEscapeKeyDown={(e) => {
              // If stage itself is focused (not imeSink), first Esc releases stage focus;
              // second Esc collapses ONLY theater dialog (never parent Sheet).
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
