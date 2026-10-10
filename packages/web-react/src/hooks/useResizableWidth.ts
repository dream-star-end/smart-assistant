import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/**
 * 可拖宽的边栏宽度(侧栏 / 详情面板共用):Pointer Events 拖拽 + 键盘(← → 步进,Home/End 最小/最大,
 * Shift 大步)+ 双击复位 + localStorage 持久化(读写都 try/catch,隐私模式下退回默认宽)。
 * `edge` = 把手在栏的哪一侧:左侧栏把手在右边(往右拖变宽),右侧面板把手在左边(往左拖变宽)。
 */
export type ResizableWidthOptions = {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  edge: "left" | "right";
  keyStep?: number;
  keyStepLarge?: number;
};

export type ResizableWidth = {
  width: number;
  resizing: boolean;
  onResizeStart: (e: ReactPointerEvent) => void;
  /** 把手的键盘处理（separator 模式要求键盘可调）。 */
  onResizeKeyDown: (e: ReactKeyboardEvent) => void;
};

const PERSIST_THROTTLE_MS = 80;

function clampWidth(opts: ResizableWidthOptions, n: number): number {
  if (!Number.isFinite(n)) return opts.defaultWidth;
  return Math.min(opts.max, Math.max(opts.min, Math.round(n)));
}

function readStoredWidth(opts: ResizableWidthOptions): number {
  try {
    const raw = localStorage.getItem(opts.storageKey);
    if (raw == null || raw === "") return opts.defaultWidth;
    return clampWidth(opts, Number(raw));
  } catch {
    return opts.defaultWidth;
  }
}

function writeStoredWidth(opts: ResizableWidthOptions, width: number): void {
  try {
    localStorage.setItem(opts.storageKey, String(clampWidth(opts, width)));
  } catch {
    /* private mode / quota */
  }
}

export function useResizableWidth(options: ResizableWidthOptions): ResizableWidth {
  // 选项按挂载时的值使用(调用方传常量);存进 ref,回调保持稳定引用。
  const optsRef = useRef(options);
  const opts = optsRef.current;
  const [width, setWidth] = useState(() => readStoredWidth(opts));
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
      writeStoredWidth(opts, widthRef.current);
    } else {
      clearPersistTimer();
    }
  };

  const applyWidth = (next: number, persist: "throttle" | "flush") => {
    const clamped = clampWidth(opts, next);
    widthRef.current = clamped;
    setWidth(clamped);
    if (persist === "flush") {
      clearPersistTimer();
      writeStoredWidth(opts, clamped);
      return;
    }
    clearPersistTimer();
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      writeStoredWidth(opts, widthRef.current);
    }, PERSIST_THROTTLE_MS);
  };

  const onResizeStart = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();

    if (e.detail >= 2) {
      endDrag(false);
      applyWidth(opts.defaultWidth, "flush");
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
      const delta = ev.clientX - drag.startX;
      applyWidth(drag.startWidth + (opts.edge === "right" ? delta : -delta), "throttle");
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

  const onResizeKeyDown = useCallback((e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? (opts.keyStepLarge ?? 64) : (opts.keyStep ?? 16);
    // 往把手外侧方向按 = 变宽(左侧栏 →,右侧面板 ←)。
    const grow = opts.edge === "right" ? "ArrowRight" : "ArrowLeft";
    const shrink = opts.edge === "right" ? "ArrowLeft" : "ArrowRight";
    let next: number;
    switch (e.key) {
      case shrink:
        next = widthRef.current - step;
        break;
      case grow:
        next = widthRef.current + step;
        break;
      case "Home":
        next = opts.min;
        break;
      case "End":
        next = opts.max;
        break;
      default:
        return;
    }
    e.preventDefault();
    endDrag(false);
    applyWidth(next, "flush");
  }, []);

  useEffect(
    () => () => {
      endDrag(true);
    },
    [],
  );

  return { width, resizing, onResizeStart, onResizeKeyDown };
}
