import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export const SIDEBAR_WIDTH_DEFAULT = 268;
export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 460;
export const SIDEBAR_WIDTH_STORAGE_KEY = "oc_v5_sidebar_width";

const PERSIST_THROTTLE_MS = 80;

function clampWidth(n: number): number {
  if (!Number.isFinite(n)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(n)));
}

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (raw == null || raw === "") return SIDEBAR_WIDTH_DEFAULT;
    return clampWidth(Number(raw));
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

function writeStoredWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampWidth(width)));
  } catch {
    /* private mode / quota */
  }
}

/**
 * 侧栏宽度：Pointer Events 拖拽 + localStorage 持久化。
 * 窄屏是否采用返回值由调用方决定。
 */
export function useSidebarWidth(): {
  width: number;
  resizing: boolean;
  onResizeStart: (e: ReactPointerEvent) => void;
} {
  const [width, setWidth] = useState(readStoredWidth);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    target: HTMLElement | null;
  } | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevBodyRef = useRef<{ cursor: string; userSelect: string } | null>(null);
  const listenersRef = useRef<{
    move: (ev: PointerEvent) => void;
    up: (ev: PointerEvent) => void;
    cancel: (ev: PointerEvent) => void;
  } | null>(null);

  const clearPersistTimer = () => {
    if (persistTimerRef.current != null) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
  };

  const restoreBody = () => {
    const prev = prevBodyRef.current;
    if (!prev) return;
    document.body.style.cursor = prev.cursor;
    document.body.style.userSelect = prev.userSelect;
    prevBodyRef.current = null;
  };

  const detachListeners = () => {
    const l = listenersRef.current;
    if (!l) return;
    document.removeEventListener("pointermove", l.move);
    document.removeEventListener("pointerup", l.up);
    document.removeEventListener("pointercancel", l.cancel);
    listenersRef.current = null;
  };

  const endDrag = (persist: boolean) => {
    const drag = dragRef.current;
    if (drag) {
      dragRef.current = null;
      if (drag.target) {
        try {
          drag.target.releasePointerCapture(drag.pointerId);
        } catch {
          /* jsdom / already released */
        }
      }
    }
    detachListeners();
    restoreBody();
    setResizing(false);
    if (persist) {
      clearPersistTimer();
      writeStoredWidth(widthRef.current);
    } else {
      clearPersistTimer();
    }
  };

  const applyWidth = (next: number, persist: "throttle" | "flush") => {
    const clamped = clampWidth(next);
    widthRef.current = clamped;
    setWidth(clamped);
    if (persist === "flush") {
      clearPersistTimer();
      writeStoredWidth(clamped);
      return;
    }
    clearPersistTimer();
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      writeStoredWidth(widthRef.current);
    }, PERSIST_THROTTLE_MS);
  };

  const onResizeStart = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();

    if (e.detail >= 2) {
      endDrag(false);
      applyWidth(SIDEBAR_WIDTH_DEFAULT, "flush");
      return;
    }

    const target = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
    try {
      target?.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom */
    }

    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth: widthRef.current,
      target,
    };
    setResizing(true);

    if (!prevBodyRef.current) {
      prevBodyRef.current = {
        cursor: document.body.style.cursor,
        userSelect: document.body.style.userSelect,
      };
    }
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const move = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || ev.pointerId !== drag.pointerId) return;
      applyWidth(drag.startWidth + (ev.clientX - drag.startX), "throttle");
    };
    const up = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (drag && ev.pointerId !== drag.pointerId) return;
      endDrag(true);
    };
    const cancel = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (drag && ev.pointerId !== drag.pointerId) return;
      endDrag(true);
    };

    detachListeners();
    listenersRef.current = { move, up, cancel };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", cancel);
  }, []);

  useEffect(
    () => () => {
      endDrag(true);
    },
    [],
  );

  return { width, resizing, onResizeStart };
}
