/**
 * Interactive live cloud browser viewport canvas (OCV5-857).
 *
 * Features:
 * - Double-buffered `<canvas>` rendering (`createImageBitmap` + `drawImage`) for WS binary
 *   streams, with seamless `<img>` fallback for HTTP polling or environments without ImageBitmap.
 * - Exact content-box coordinate mapping (`mapClientPointToNormalized`) subtracting `object-fit`
 *   letterbox/pillarbox margins + CSS `aspect-ratio` locking to eliminate narrow-screen drift.
 * - Real desktop pointer semantics: 30Hz hover move, down/up split (drag & long-press),
 *   right/middle button, double-click deduplication, native `{ passive: false }` wheel capture
 *   with `deltaMode` normalization.
 * - Full CJK IME + local clipboard paste via visually-hidden `<textarea>` sink (`Shift+Esc`
 *   releases keyboard capture without conflicting with theater dialog `Esc`).
 * - Webpage JS dialog bar (`alert`/`confirm`/`prompt`), watch-mode hover guide, and reconnect band.
 */
import {
  type LiveBrowserDecodedFrame,
  type LiveBrowserDialogInfo,
  type LiveBrowserMouseButton,
  type LiveBrowserViewport,
  liveBrowserModifiersToBitmask,
} from "@openclaude/protocol/browser";
import { Hand, MessageSquareWarning, RotateCw, WifiOff } from "lucide-react";
import {
  type ClipboardEvent as ReactClipboardEvent,
  type CompositionEvent as ReactCompositionEvent,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { LiveBrowserConnectionStatus } from "../../lib/liveBrowserStreamClient";
import { Spinner } from "../ui";

export type LiveBrowserZoomMode = "fit" | "1:1";

export interface NormalizedPoint {
  x: number;
  y: number;
  insideContent: boolean;
}

export interface LiveBrowserCanvasHandle {
  focusCapture: () => void;
  blurCapture: () => void;
  isCaptureFocused: () => boolean;
  exportScreenshotDataUrl: () => string | null;
}

export interface LiveBrowserCanvasProps {
  canvasHandleRef?: RefObject<LiveBrowserCanvasHandle | null>;
  stageRef: RefObject<HTMLDivElement | null>;
  viewport?: LiveBrowserViewport;
  title?: string;
  imageBase64?: string;
  mimeType?: "image/jpeg" | "image/png";
  streamFrame: LiveBrowserDecodedFrame | null;
  effectiveTakeover: boolean;
  lockedByAssistant: boolean;
  originMismatchLocked: boolean;
  wsConnected: boolean;
  connectionStatus: LiveBrowserConnectionStatus;
  busy: boolean;
  zoomMode: LiveBrowserZoomMode;
  remoteCursor?: string;
  dialog?: LiveBrowserDialogInfo | null;
  onRequestTakeover: () => void;
  onRetryConnection: () => void;
  onPointerEvent: (evt: {
    action: "move" | "down" | "up" | "click" | "dblclick";
    x: number;
    y: number;
    button?: LiveBrowserMouseButton;
    clickCount?: number;
    modifiers?: number;
  }) => boolean;
  onDragFallback: (evt: { fromX: number; fromY: number; toX: number; toY: number }) => void;
  onWheelEvent: (evt: {
    x?: number;
    y?: number;
    deltaX: number;
    deltaY: number;
    modifiers?: number;
  }) => void;
  onKeyEvent: (evt: {
    action: "down" | "up" | "press";
    key: string;
    code?: string;
    modifiers?: number;
  }) => void;
  onInsertText: (text: string) => void;
  onPasteText: (text: string) => void;
  onStagePrintableKey: (char: string) => void;
  onFlushKeyBuffer: () => void;
  onRespondDialog: (accept: boolean, promptText?: string) => void;
  onCaptureFocusChange?: (focused: boolean) => void;
  /** Invoked strictly after a binary frame has actually been painted to <canvas> or loaded into <img>. */
  onFramePainted?: (frame: LiveBrowserDecodedFrame) => void;
}

interface ClickRipple {
  id: number;
  xPct: number;
  yPct: number;
}

interface TouchScrollGesture {
  pointerId: number;
  startX: number;
  startY: number;
  startPt: NormalizedPoint | null;
  lastX: number;
  lastY: number;
  dragging: boolean;
  lastSentAt: number;
}

interface MouseDragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPt: NormalizedPoint;
  moved: boolean;
}

const TOUCH_DRAG_SLOP = 8;
const MOUSE_DRAG_SLOP = 8;
const TOUCH_SCROLL_GAIN = 2;
const HOVER_THROTTLE_MS = 33; // ~30Hz
const WS_WHEEL_COALESCE_MS = 32;
const HTTP_WHEEL_COALESCE_MS = 160;

const SPECIAL_KEY_MAP: Record<string, string> = {
  Enter: "Enter",
  Tab: "Tab",
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
  Escape: "Escape",
  " ": " ",
};

const CTRL_COMBO_KEYS = new Set(["a", "c", "x", "z", "y"]);

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function mouseButtonOf(button: number): LiveBrowserMouseButton {
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "left";
}

function modifiersFromEvent(e: {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): number {
  return liveBrowserModifiersToBitmask({
    alt: Boolean(e.altKey),
    ctrl: Boolean(e.ctrlKey),
    meta: Boolean(e.metaKey),
    shift: Boolean(e.shiftKey),
  });
}

/**
 * Map viewport client coordinates onto `[0..1]` normalized remote page coordinates,
 * strictly subtracting any `object-fit: contain` letterbox or pillarbox margins.
 */
export function mapClientPointToNormalized(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  mediaWidth?: number,
  mediaHeight?: number,
): NormalizedPoint | null {
  if (rect.width <= 0 || rect.height <= 0) return null;

  let renderW = rect.width;
  let renderH = rect.height;
  let offsetX = 0;
  let offsetY = 0;

  if (mediaWidth && mediaHeight && mediaWidth > 0 && mediaHeight > 0) {
    const elemAspect = rect.width / rect.height;
    const mediaAspect = mediaWidth / mediaHeight;
    if (Math.abs(elemAspect - mediaAspect) > 0.001) {
      if (elemAspect > mediaAspect) {
        // Pillarboxed (empty bars on left/right)
        renderH = rect.height;
        renderW = renderH * mediaAspect;
        offsetX = (rect.width - renderW) / 2;
      } else {
        // Letterboxed (empty bars on top/bottom)
        renderW = rect.width;
        renderH = renderW / mediaAspect;
        offsetY = (rect.height - renderH) / 2;
      }
    }
  }

  if (renderW <= 0 || renderH <= 0) return null;
  const rawX = (clientX - rect.left - offsetX) / renderW;
  const rawY = (clientY - rect.top - offsetY) / renderH;
  const eps = 1e-6;
  const insideContent = rawX >= -eps && rawX <= 1 + eps && rawY >= -eps && rawY <= 1 + eps;
  return {
    x: clamp01(rawX),
    y: clamp01(rawY),
    insideContent,
  };
}

/** Normalize DOM WheelEvent deltas across pixel/line/page deltaModes. */
export function normalizeWheelDeltas(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  viewportHeight = 720,
): { deltaX: number; deltaY: number } {
  const scale = deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(200, viewportHeight) : 1;
  return {
    deltaX: Math.round(deltaX * scale),
    deltaY: Math.round(deltaY * scale),
  };
}

function dialogTypeLabel(type: LiveBrowserDialogInfo["type"]): string {
  switch (type) {
    case "confirm":
      return "网页确认";
    case "prompt":
      return "网页输入";
    case "beforeunload":
      return "离开确认";
    default:
      return "网页提示";
  }
}

export function LiveBrowserCanvas({
  canvasHandleRef,
  stageRef,
  viewport,
  title,
  imageBase64,
  mimeType = "image/jpeg",
  streamFrame,
  effectiveTakeover,
  lockedByAssistant,
  originMismatchLocked,
  wsConnected,
  connectionStatus,
  busy,
  zoomMode,
  remoteCursor,
  dialog,
  onRequestTakeover,
  onRetryConnection,
  onPointerEvent,
  onDragFallback,
  onWheelEvent,
  onKeyEvent,
  onInsertText,
  onPasteText,
  onStagePrintableKey,
  onFlushKeyBuffer,
  onRespondDialog,
  onCaptureFocusChange,
  onFramePainted,
}: LiveBrowserCanvasProps) {
  const onFramePaintedRef = useRef(onFramePainted);
  onFramePaintedRef.current = onFramePainted;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const imeSinkRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  const [ripple, setRipple] = useState<ClickRipple | null>(null);
  const [promptDraft, setPromptDraft] = useState(dialog?.defaultPrompt ?? "");
  const [canvasReady, setCanvasReady] = useState(false);
  const [blobFrameUrl, setBlobFrameUrl] = useState<string | null>(null);

  const rippleTimerRef = useRef<number | null>(null);
  const suppressClickTimerRef = useRef<number | null>(null);
  const suppressNextClickRef = useRef(false);
  const touchGestureRef = useRef<TouchScrollGesture | null>(null);
  const mouseDragRef = useRef<MouseDragState | null>(null);
  const lastHoverSentAtRef = useRef(0);
  const wheelBufRef = useRef<{
    dx: number;
    dy: number;
    x?: number;
    y?: number;
    modifiers: number;
    timer: number | null;
  }>({ dx: 0, dy: 0, modifiers: 0, timer: null });

  const decodingRef = useRef(false);
  const decodeGenRef = useRef(0);
  const pendingFrameRef = useRef<LiveBrowserDecodedFrame | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  const supportsBitmap =
    typeof window !== "undefined" && typeof window.createImageBitmap === "function";
  const activeStreamFrame = wsConnected ? streamFrame : null;
  const useCanvasSurface = Boolean(activeStreamFrame && supportsBitmap);

  const mediaWidth = activeStreamFrame?.width || viewport?.width || 1280;
  const mediaHeight = activeStreamFrame?.height || viewport?.height || 720;

  useEffect(() => {
    setPromptDraft(dialog?.defaultPrompt ?? "");
  }, [dialog?.type, dialog?.message, dialog?.defaultPrompt]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      decodeGenRef.current += 1;
      pendingFrameRef.current = null;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      if (rippleTimerRef.current !== null) window.clearTimeout(rippleTimerRef.current);
      if (suppressClickTimerRef.current !== null) window.clearTimeout(suppressClickTimerRef.current);
      if (wheelBufRef.current.timer !== null) window.clearTimeout(wheelBufRef.current.timer);
    };
  }, []);

  // Invalidate any in-flight decode whenever WS drops or streamFrame clears.
  useEffect(() => {
    if (!activeStreamFrame) {
      decodeGenRef.current += 1;
      pendingFrameRef.current = null;
      setCanvasReady(false);
    }
  }, [activeStreamFrame]);

  // Clear pending wheel buffer whenever takeover exits.
  useEffect(() => {
    if (!effectiveTakeover) {
      if (wheelBufRef.current.timer !== null) {
        window.clearTimeout(wheelBufRef.current.timer);
        wheelBufRef.current.timer = null;
      }
      wheelBufRef.current.dx = 0;
      wheelBufRef.current.dy = 0;
      touchGestureRef.current = null;
      mouseDragRef.current = null;
      composingRef.current = false;
    }
  }, [effectiveTakeover]);

  // Blob + <img> fallback when createImageBitmap is unavailable in the runtime environment.
  useEffect(() => {
    if (!activeStreamFrame || supportsBitmap) {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      setBlobFrameUrl(null);
      return;
    }
    const mime = activeStreamFrame.format === "png" ? "image/png" : "image/jpeg";
    const copy = new Uint8Array(activeStreamFrame.payload.byteLength);
    copy.set(activeStreamFrame.payload);
    const nextUrl = URL.createObjectURL(new Blob([copy.buffer], { type: mime }));
    const prevUrl = blobUrlRef.current;
    blobUrlRef.current = nextUrl;
    setBlobFrameUrl(nextUrl);
    if (prevUrl) URL.revokeObjectURL(prevUrl);
  }, [activeStreamFrame, supportsBitmap]);

  // Double-buffered decode & draw for WS binary frames (drops intermediate backlog & stale-gen frames).
  const drainDecodeQueue = useCallback(() => {
    if (decodingRef.current || !pendingFrameRef.current || !supportsBitmap) return;
    const next = pendingFrameRef.current;
    pendingFrameRef.current = null;
    decodingRef.current = true;
    const myGen = decodeGenRef.current;

    const mime = next.format === "png" ? "image/png" : "image/jpeg";
    const copy = new Uint8Array(next.payload.byteLength);
    copy.set(next.payload);
    const blob = new Blob([copy.buffer], { type: mime });

    window
      .createImageBitmap(blob)
      .then((bitmap) => {
        if (!mountedRef.current || myGen !== decodeGenRef.current) {
          bitmap.close();
          return;
        }
        const canvas = canvasRef.current;
        if (canvas) {
          const targetW = next.width || bitmap.width;
          const targetH = next.height || bitmap.height;
          if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
          }
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(bitmap, 0, 0, targetW, targetH);
            setCanvasReady(true);
            onFramePaintedRef.current?.(next);
          }
        }
        bitmap.close();
      })
      .catch(() => {
        /* ignore malformed frame */
      })
      .finally(() => {
        decodingRef.current = false;
        if (mountedRef.current && myGen === decodeGenRef.current && pendingFrameRef.current) {
          drainDecodeQueue();
        }
      });
  }, [supportsBitmap]);

  useEffect(() => {
    if (!activeStreamFrame || !supportsBitmap) return;
    pendingFrameRef.current = activeStreamFrame;
    drainDecodeQueue();
  }, [activeStreamFrame, supportsBitmap, drainDecodeQueue]);

  useImperativeHandle(
    canvasHandleRef,
    () => ({
      focusCapture: () => {
        if (imeSinkRef.current) {
          imeSinkRef.current.focus({ preventScroll: true });
        } else {
          stageRef.current?.focus({ preventScroll: true });
        }
      },
      blurCapture: () => {
        imeSinkRef.current?.blur();
        stageRef.current?.blur();
      },
      isCaptureFocused: () => {
        const active = document.activeElement;
        return Boolean(
          active && (active === imeSinkRef.current || active === stageRef.current),
        );
      },
      exportScreenshotDataUrl: () => {
        if (useCanvasSurface && canvasRef.current && canvasReady) {
          try {
            return canvasRef.current.toDataURL("image/png");
          } catch {
            /* fallback to base64 */
          }
        }
        if (imageBase64) {
          return `data:${mimeType};base64,${imageBase64}`;
        }
        return null;
      },
    }),
    [useCanvasSurface, canvasReady, imageBase64, mimeType, stageRef],
  );

  const getMediaElement = useCallback((): HTMLElement | null => {
    return useCanvasSurface ? canvasRef.current : imgRef.current;
  }, [useCanvasSurface]);

  const computeNormalizedPoint = useCallback(
    (e: { clientX: number; clientY: number }): NormalizedPoint | null => {
      const el = getMediaElement();
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      // For HTMLImageElement, prefer natural dimensions when available (falls back to viewport).
      const imgEl = el instanceof HTMLImageElement ? el : null;
      const natW = imgEl && imgEl.naturalWidth > 0 ? imgEl.naturalWidth : undefined;
      const natH = imgEl && imgEl.naturalHeight > 0 ? imgEl.naturalHeight : undefined;
      // In jsdom tests where naturalWidth is 0 and rect may have any mocked aspect, only apply
      // letterbox math when naturalWidth > 0 or when rendering real canvas dimensions.
      const mW = useCanvasSurface ? mediaWidth : natW;
      const mH = useCanvasSurface ? mediaHeight : natH;
      return mapClientPointToNormalized(e.clientX, e.clientY, rect, mW, mH);
    },
    [getMediaElement, useCanvasSurface, mediaWidth, mediaHeight],
  );

  const showRipple = useCallback((x: number, y: number) => {
    const id = Date.now() + Math.random();
    setRipple({ id, xPct: x * 100, yPct: y * 100 });
    if (rippleTimerRef.current !== null) window.clearTimeout(rippleTimerRef.current);
    rippleTimerRef.current = window.setTimeout(() => {
      rippleTimerRef.current = null;
      setRipple((curr) => (curr?.id === id ? null : curr));
    }, 360);
  }, []);

  // Native `{ passive: false }` wheel listener to block scroll leak to InspectorPanel/page.
  const latestWheelPropsRef = useRef({
    effectiveTakeover,
    wsConnected,
    mediaHeight,
    onWheelEvent,
    computeNormalizedPoint,
  });
  latestWheelPropsRef.current = {
    effectiveTakeover,
    wsConnected,
    mediaHeight,
    onWheelEvent,
    computeNormalizedPoint,
  };

  useEffect(() => {
    const stageEl = stageRef.current;
    if (!stageEl) return;

    const handleNativeWheel = (e: WheelEvent) => {
      const curr = latestWheelPropsRef.current;
      if (!curr.effectiveTakeover) return;
      e.preventDefault();
      e.stopPropagation();

      const pt = curr.computeNormalizedPoint(e);
      const norm = normalizeWheelDeltas(e.deltaX, e.deltaY, e.deltaMode, curr.mediaHeight);
      const buf = wheelBufRef.current;
      buf.dx += norm.deltaX;
      buf.dy += norm.deltaY;
      buf.modifiers = modifiersFromEvent(e);
      if (pt) {
        buf.x = pt.x;
        buf.y = pt.y;
      }

      if (buf.timer === null) {
        const delay = curr.wsConnected ? WS_WHEEL_COALESCE_MS : HTTP_WHEEL_COALESCE_MS;
        buf.timer = window.setTimeout(() => {
          const dx = Math.round(buf.dx);
          const dy = Math.round(buf.dy);
          const x = buf.x;
          const y = buf.y;
          const modifiers = buf.modifiers;
          buf.dx = 0;
          buf.dy = 0;
          buf.timer = null;
          if (!latestWheelPropsRef.current.effectiveTakeover) return;
          if (dx !== 0 || dy !== 0) {
            latestWheelPropsRef.current.onWheelEvent({ x, y, deltaX: dx, deltaY: dy, modifiers });
          }
        }, delay);
      }
    };

    stageEl.addEventListener("wheel", handleNativeWheel, { passive: false });
    return () => {
      stageEl.removeEventListener("wheel", handleNativeWheel);
    };
  }, [stageRef]);

  const handlePointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!effectiveTakeover) return;

    if (e.pointerType === "touch") {
      if (touchGestureRef.current) return;
      touchGestureRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startPt: computeNormalizedPoint(e),
        lastX: e.clientX,
        lastY: e.clientY,
        dragging: false,
        lastSentAt: 0,
      };
      return;
    }

    const pt = computeNormalizedPoint(e);
    if (!pt) return;
    imeSinkRef.current?.focus({ preventScroll: true });
    onFlushKeyBuffer();

    if (wsConnected) {
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        /* ignore unsupported pointer capture */
      }
      const sent = onPointerEvent({
        action: "down",
        x: pt.x,
        y: pt.y,
        button: mouseButtonOf(e.button),
        clickCount: Math.max(1, e.detail || 1),
        modifiers: modifiersFromEvent(e),
      });
      if (sent) showRipple(pt.x, pt.y);
      return;
    }

    // HTTP polling fallback: track potential left-button drag gesture.
    if (e.button === 0) {
      mouseDragRef.current = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPt: pt,
        moved: false,
      };
    }
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (!effectiveTakeover) return;

    if (e.pointerType === "touch") {
      const g = touchGestureRef.current;
      if (!g || g.pointerId !== e.pointerId) return;
      const totalDist = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
      if (!g.dragging) {
        if (totalDist <= TOUCH_DRAG_SLOP) return;
        g.dragging = true;
        suppressNextClickRef.current = true;
      }
      const now = performance.now();
      if (now - g.lastSentAt < 100) return;
      const dx = Math.round((g.lastX - e.clientX) * TOUCH_SCROLL_GAIN);
      const dy = Math.round((g.lastY - e.clientY) * TOUCH_SCROLL_GAIN);
      g.lastX = e.clientX;
      g.lastY = e.clientY;
      g.lastSentAt = now;
      if (dx !== 0 || dy !== 0) {
        const pt = computeNormalizedPoint(e);
        onWheelEvent({ x: pt?.x, y: pt?.y, deltaX: dx, deltaY: dy });
      }
      return;
    }

    if (wsConnected) {
      const now = performance.now();
      if (now - lastHoverSentAtRef.current < HOVER_THROTTLE_MS) return;
      const pt = computeNormalizedPoint(e);
      if (!pt) return;
      lastHoverSentAtRef.current = now;
      onPointerEvent({
        action: "move",
        x: pt.x,
        y: pt.y,
        modifiers: modifiersFromEvent(e),
      });
      return;
    }

    const drag = mouseDragRef.current;
    if (drag && drag.pointerId === e.pointerId && !drag.moved) {
      if (Math.hypot(e.clientX - drag.startClientX, e.clientY - drag.startClientY) > MOUSE_DRAG_SLOP) {
        drag.moved = true;
      }
    }
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "touch") {
      const g = touchGestureRef.current;
      if (!g || g.pointerId !== e.pointerId) return;
      touchGestureRef.current = null;
      if (!effectiveTakeover) return;
      if (g.dragging) {
        const dx = Math.round((g.lastX - e.clientX) * TOUCH_SCROLL_GAIN);
        const dy = Math.round((g.lastY - e.clientY) * TOUCH_SCROLL_GAIN);
        if (dx !== 0 || dy !== 0) {
          const pt = computeNormalizedPoint(e);
          onWheelEvent({ x: pt?.x, y: pt?.y, deltaX: dx, deltaY: dy });
        }
        suppressNextClickRef.current = true;
        if (suppressClickTimerRef.current !== null) {
          window.clearTimeout(suppressClickTimerRef.current);
        }
        suppressClickTimerRef.current = window.setTimeout(() => {
          suppressClickTimerRef.current = null;
          suppressNextClickRef.current = false;
        }, 300);
        return;
      }
      // Mobile WS tap: displacement stayed below drag threshold -> emit exactly 1 WS click and suppress synthetic click.
      if (wsConnected) {
        const pt = computeNormalizedPoint(e) ?? g.startPt;
        if (pt) {
          suppressNextClickRef.current = true;
          if (suppressClickTimerRef.current !== null) {
            window.clearTimeout(suppressClickTimerRef.current);
          }
          suppressClickTimerRef.current = window.setTimeout(() => {
            suppressClickTimerRef.current = null;
            suppressNextClickRef.current = false;
          }, 300);
          imeSinkRef.current?.focus({ preventScroll: true });
          onFlushKeyBuffer();
          if (
            onPointerEvent({
              action: "click",
              x: pt.x,
              y: pt.y,
              button: "left",
              clickCount: 1,
              modifiers: 0,
            })
          ) {
            showRipple(pt.x, pt.y);
          }
        }
      }
      return;
    }

    if (!effectiveTakeover) return;

    if (wsConnected) {
      const pt = computeNormalizedPoint(e);
      if (pt) {
        onPointerEvent({
          action: "up",
          x: pt.x,
          y: pt.y,
          button: mouseButtonOf(e.button),
          clickCount: Math.max(1, e.detail || 1),
          modifiers: modifiersFromEvent(e),
        });
      }
      try {
        if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } catch {
        /* ignore */
      }
      return;
    }

    const drag = mouseDragRef.current;
    if (drag && drag.pointerId === e.pointerId) {
      mouseDragRef.current = null;
      if (drag.moved) {
        const endPt = computeNormalizedPoint(e);
        if (endPt) {
          suppressNextClickRef.current = true;
          onDragFallback({
            fromX: drag.startPt.x,
            fromY: drag.startPt.y,
            toX: endPt.x,
            toY: endPt.y,
          });
          if (suppressClickTimerRef.current !== null) {
            window.clearTimeout(suppressClickTimerRef.current);
          }
          suppressClickTimerRef.current = window.setTimeout(() => {
            suppressClickTimerRef.current = null;
            suppressNextClickRef.current = false;
          }, 150);
        }
      }
    }
  };

  /** Dedicated pointercancel handler: ONLY resets gesture tracking, NEVER synthesizes a click. */
  const handlePointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.pointerType === "touch") {
      if (touchGestureRef.current?.pointerId === e.pointerId) {
        touchGestureRef.current = null;
      }
      return;
    }
    if (mouseDragRef.current?.pointerId === e.pointerId) {
      mouseDragRef.current = null;
    }
    try {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* ignore */
    }
  };

  const handleFrameClick = (e: ReactMouseEvent<HTMLElement>) => {
    if (!effectiveTakeover) {
      if (!lockedByAssistant && !originMismatchLocked) {
        onRequestTakeover();
      }
      return;
    }
    // In WS mode, pointerdown + pointerup already delivered exact click semantics (including drag & dblclick).
    if (wsConnected) return;

    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    // Suppress 2nd click of a double-click so dblclick doesn't trigger triple actions.
    if (e.detail >= 2) return;

    const pt = computeNormalizedPoint(e);
    if (!pt) return;
    imeSinkRef.current?.focus({ preventScroll: true });
    onFlushKeyBuffer();
    if (
      onPointerEvent({
        action: "click",
        x: pt.x,
        y: pt.y,
        button: "left",
        modifiers: modifiersFromEvent(e),
      })
    ) {
      showRipple(pt.x, pt.y);
    }
  };

  const handleFrameDoubleClick = (e: ReactMouseEvent<HTMLElement>) => {
    if (!effectiveTakeover || wsConnected) return;
    const pt = computeNormalizedPoint(e);
    if (!pt) return;
    imeSinkRef.current?.focus({ preventScroll: true });
    onFlushKeyBuffer();
    if (
      onPointerEvent({
        action: "dblclick",
        x: pt.x,
        y: pt.y,
        modifiers: modifiersFromEvent(e),
      })
    ) {
      showRipple(pt.x, pt.y);
    }
  };

  const handleFrameContextMenu = (e: ReactMouseEvent<HTMLElement>) => {
    if (!effectiveTakeover) return;
    e.preventDefault();
    if (wsConnected) return;
    const pt = computeNormalizedPoint(e);
    if (!pt) return;
    onFlushKeyBuffer();
    if (
      onPointerEvent({
        action: "click",
        x: pt.x,
        y: pt.y,
        button: "right",
        modifiers: modifiersFromEvent(e),
      })
    ) {
      showRipple(pt.x, pt.y);
    }
  };

  // Hidden IME sink handlers (real Chinese IME, paste, Tab/Shift+Tab, Shift+Arrow, etc.)
  const handleImeCompositionStart = () => {
    composingRef.current = true;
  };

  const handleImeCompositionEnd = (e: ReactCompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false;
    const text = e.data || e.currentTarget.value;
    e.currentTarget.value = "";
    if (text && effectiveTakeover) {
      onFlushKeyBuffer();
      onInsertText(text);
    }
  };

  const handleImeInput = (e: ReactFormEvent<HTMLTextAreaElement>) => {
    if (composingRef.current) return;
    const nativeEvt = e.nativeEvent as InputEvent | undefined;
    if (nativeEvt?.isComposing) return;
    const text = e.currentTarget.value;
    if (!text) return;
    e.currentTarget.value = "";
    if (effectiveTakeover) {
      onInsertText(text);
    }
  };

  const handleImePaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    if (!effectiveTakeover) return;
    e.preventDefault();
    e.stopPropagation();
    const text = e.clipboardData?.getData("text") ?? "";
    if (text) {
      onFlushKeyBuffer();
      onPasteText(text);
    }
  };

  const handleImeKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!effectiveTakeover) return;
    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;

    // Dedicated escape hatch to release keyboard capture without conflicting with Theater Esc.
    if (e.shiftKey && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      imeSinkRef.current?.blur();
      return;
    }

    // Allow native Ctrl/Cmd+V to fire `onPaste` so local clipboard text is captured cleanly.
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const lower = e.key.toLowerCase();
      if (lower === "v") return;
      if (CTRL_COMBO_KEYS.has(lower)) {
        e.preventDefault();
        e.stopPropagation();
        onFlushKeyBuffer();
        onKeyEvent({
          action: "press",
          key: lower,
          code: e.code || `Key${lower.toUpperCase()}`,
          modifiers: modifiersFromEvent(e),
        });
        return;
      }
    }

    const mapped = SPECIAL_KEY_MAP[e.key];
    if (mapped) {
      e.preventDefault();
      e.stopPropagation();
      onFlushKeyBuffer();
      onKeyEvent({
        action: "press",
        key: mapped,
        code: e.code || (mapped === " " ? "Space" : mapped),
        modifiers: modifiersFromEvent(e),
      });
    }
  };

  // Stage container keydown (for when stageRef itself receives focus directly).
  const handleStageKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!effectiveTakeover) return;
    if (e.nativeEvent.isComposing) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      stageRef.current?.blur();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const lower = e.key.toLowerCase();
      if (CTRL_COMBO_KEYS.has(lower) || lower === "v") {
        e.preventDefault();
        e.stopPropagation();
        onFlushKeyBuffer();
        onKeyEvent({
          action: "press",
          key: lower,
          code: e.code || `Key${lower.toUpperCase()}`,
          modifiers: modifiersFromEvent(e),
        });
      }
      return;
    }

    const mapped = SPECIAL_KEY_MAP[e.key];
    if (mapped && mapped !== "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onFlushKeyBuffer();
      onKeyEvent({
        action: "press",
        key: mapped,
        code: e.code || (mapped === " " ? "Space" : mapped),
        modifiers: modifiersFromEvent(e),
      });
      return;
    }

    if (e.key.length === 1 && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      onStagePrintableKey(e.key);
    }
  };

  const imgSrc = blobFrameUrl || (imageBase64 ? `data:${mimeType};base64,${imageBase64}` : null);
  const hasVisualFrame = useCanvasSurface || Boolean(imgSrc);
  const frameWrapStyle =
    zoomMode === "1:1"
      ? { width: `${mediaWidth}px`, height: `${mediaHeight}px`, maxWidth: "none" as const }
      : { aspectRatio: `${mediaWidth} / ${mediaHeight}` };
  const stageCursor = effectiveTakeover
    ? remoteCursor && remoteCursor !== "auto"
      ? remoteCursor
      : "default"
    : !lockedByAssistant && !originMismatchLocked
      ? "pointer"
      : "default";

  return (
    <div
      ref={stageRef}
      tabIndex={effectiveTakeover ? 0 : -1}
      className="lb-stage"
      data-takeover={effectiveTakeover ? "true" : "false"}
      data-zoom={zoomMode}
      data-testid="live-browser-stage"
      aria-label={effectiveTakeover ? "云端浏览器交互画布（接管中）" : "云端浏览器实时画布"}
      style={{ cursor: stageCursor }}
      onKeyDown={handleStageKeyDown}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      {busy && <span className="lb-progress-bar" aria-hidden />}

      {/* Visually-hidden focusable textarea for native CJK IME & clipboard paste */}
      {effectiveTakeover && (
        <textarea
          ref={imeSinkRef}
          className="lb-ime-sink"
          data-testid="live-browser-ime-input"
          aria-label="云端浏览器键盘与中文输入捕获"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onCompositionStart={handleImeCompositionStart}
          onCompositionEnd={handleImeCompositionEnd}
          onInput={handleImeInput}
          onPaste={handleImePaste}
          onKeyDown={handleImeKeyDown}
          onFocus={() => onCaptureFocusChange?.(true)}
          onBlur={() => onCaptureFocusChange?.(false)}
        />
      )}

      {/* Reconnecting or Replaced status ribbon overlay */}
      {connectionStatus === "reconnecting" && (
        <div
          className="lb-overlay-bar lb-reconnect-bar oc-surface-glass"
          role="status"
          data-testid="live-browser-reconnecting-bar"
        >
          <span className="lb-overlay-bar-body">
            <WifiOff size={13} className="shrink-0 text-warning" aria-hidden />
            <Spinner size={12} className="shrink-0 text-warning" />
            <span>实时连接波动，正在自动重连…</span>
          </span>
          <button
            type="button"
            className="lb-overlay-btn oc-btn-tactile oc-btn-secondary-craft"
            onClick={(e) => {
              e.stopPropagation();
              onRetryConnection();
            }}
          >
            <RotateCw size={11} aria-hidden />
            立即重试
          </button>
        </div>
      )}

      {connectionStatus === "replaced" && (
        <div
          className="lb-overlay-bar lb-reconnect-bar oc-surface-glass"
          role="status"
          data-testid="live-browser-replaced-bar"
        >
          <span className="lb-overlay-bar-body">
            <WifiOff size={13} className="shrink-0 text-warning" aria-hidden />
            <span>已在其他标签页接管实时画面</span>
          </span>
          <button
            type="button"
            className="lb-overlay-btn oc-btn-tactile oc-btn-secondary-craft"
            data-testid="live-browser-reconnect-replaced"
            onClick={(e) => {
              e.stopPropagation();
              onRetryConnection();
            }}
          >
            <RotateCw size={11} aria-hidden />
            重新连接
          </button>
        </div>
      )}

      {/* Webpage alert / confirm / prompt dialog overlay */}
      {dialog && (
        <div
          className="lb-overlay-bar lb-dialog-bar oc-surface-popover"
          role="alertdialog"
          aria-label={dialogTypeLabel(dialog.type)}
          data-testid="live-browser-dialog-bar"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="lb-dialog-head">
            <span className="oc-icon-badge oc-icon-badge-warning size-6 rounded-xs" aria-hidden>
              <MessageSquareWarning size={13} />
            </span>
            <div className="lb-dialog-copy">
              <span className="lb-dialog-badge">{dialogTypeLabel(dialog.type)}</span>
              <span className="lb-dialog-msg">{dialog.message}</span>
            </div>
          </div>
          {dialog.type === "prompt" && (
            <input
              type="text"
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              placeholder="请输入内容…"
              aria-label="网页弹窗输入"
              className="lb-dialog-input oc-surface-recessed"
              data-testid="live-browser-dialog-input"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  onRespondDialog(true, promptDraft);
                }
              }}
            />
          )}
          <div className="lb-dialog-actions">
            {dialog.type !== "alert" && (
              <button
                type="button"
                className="lb-overlay-btn oc-btn-tactile oc-btn-secondary-craft"
                data-testid="live-browser-dialog-dismiss"
                onClick={() => onRespondDialog(false)}
              >
                取消
              </button>
            )}
            <button
              type="button"
              className="lb-overlay-btn lb-overlay-btn-primary oc-btn-tactile oc-btn-primary-craft"
              data-testid="live-browser-dialog-accept"
              onClick={() =>
                onRespondDialog(true, dialog.type === "prompt" ? promptDraft : undefined)
              }
            >
              确定
            </button>
          </div>
        </div>
      )}

      {hasVisualFrame ? (
        <div className="lb-frame-wrap" style={frameWrapStyle} data-zoom={zoomMode}>
          {useCanvasSurface ? (
            <canvas
              ref={canvasRef}
              width={mediaWidth}
              height={mediaHeight}
              className="lb-frame-canvas"
              data-testid="live-browser-frame"
              aria-label={title ? `${title} 实时画面` : "云端浏览器实时画面"}
              onClick={handleFrameClick}
              onDoubleClick={handleFrameDoubleClick}
              onContextMenu={handleFrameContextMenu}
            />
          ) : (
            <img
              ref={imgRef}
              src={imgSrc ?? undefined}
              alt={title ? `${title} 实时画面` : "云端浏览器实时画面"}
              draggable={false}
              className="lb-frame-img"
              data-testid="live-browser-frame"
              onLoad={() => {
                if (activeStreamFrame && !supportsBitmap) {
                  onFramePaintedRef.current?.(activeStreamFrame);
                }
              }}
              onClick={handleFrameClick}
              onDoubleClick={handleFrameDoubleClick}
              onContextMenu={handleFrameContextMenu}
            />
          )}
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
          <span className="oc-icon-badge oc-icon-badge-accent size-9 rounded-md" aria-hidden>
            <Spinner size={15} />
          </span>
          <span>正在捕获页面画面…</span>
        </div>
      )}

      {/* Watch-mode subtle hover guide pill */}
      {!effectiveTakeover && !lockedByAssistant && !originMismatchLocked && hasVisualFrame && (
        <div className="lb-watch-guide oc-surface-glass" data-testid="live-browser-watch-guide" aria-hidden>
          <Hand size={12} className="shrink-0 text-accent" />
          <span>点击画布开始人工接管</span>
          <span className="lb-watch-guide-narrow">· 建议全屏放大操作</span>
        </div>
      )}
    </div>
  );
}
