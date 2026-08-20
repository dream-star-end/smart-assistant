import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STORAGE_KEY,
  useSidebarWidth,
} from "./useSidebarWidth";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  vi.restoreAllMocks();
});

function ensurePointerCapture() {
  for (const m of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const) {
    if (!(m in Element.prototype)) {
      Object.defineProperty(Element.prototype, m, {
        value: () => {},
        configurable: true,
        writable: true,
      });
    }
  }
}

function fakePointerDown(init: {
  clientX: number;
  pointerId?: number;
  button?: number;
  detail?: number;
  currentTarget?: EventTarget;
}) {
  const target = init.currentTarget ?? document.createElement("div");
  if (target instanceof HTMLElement && !document.body.contains(target)) {
    document.body.appendChild(target);
  }
  return {
    pointerId: init.pointerId ?? 1,
    clientX: init.clientX,
    button: init.button ?? 0,
    detail: init.detail ?? 1,
    currentTarget: target,
    target,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as import("react").PointerEvent;
}

function dispatchPointer(type: string, init: { clientX: number; pointerId?: number }) {
  document.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: init.clientX,
      pointerId: init.pointerId ?? 1,
    }),
  );
}

describe("useSidebarWidth", () => {
  test("初始默认值 268", () => {
    const { result } = renderHook(() => useSidebarWidth());
    expect(result.current.width).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(result.current.resizing).toBe(false);
  });

  test("localStorage 越界值被夹回，NaN 回落到默认", () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "100");
    const low = renderHook(() => useSidebarWidth());
    expect(low.result.current.width).toBe(SIDEBAR_WIDTH_MIN);
    low.unmount();

    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "999");
    const high = renderHook(() => useSidebarWidth());
    expect(high.result.current.width).toBe(SIDEBAR_WIDTH_MAX);
    high.unmount();

    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "not-a-number");
    const nan = renderHook(() => useSidebarWidth());
    expect(nan.result.current.width).toBe(SIDEBAR_WIDTH_DEFAULT);
  });

  test("拖拽后落盘", () => {
    ensurePointerCapture();
    const { result } = renderHook(() => useSidebarWidth());
    act(() => {
      result.current.onResizeStart(fakePointerDown({ clientX: 268, pointerId: 1 }));
    });
    expect(result.current.resizing).toBe(true);
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    act(() => {
      dispatchPointer("pointermove", { clientX: 300, pointerId: 1 });
    });
    expect(result.current.width).toBe(300);

    act(() => {
      dispatchPointer("pointerup", { clientX: 300, pointerId: 1 });
    });
    expect(result.current.resizing).toBe(false);
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("300");
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  test("卸载清理监听与 body 样式", () => {
    ensurePointerCapture();
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { result, unmount } = renderHook(() => useSidebarWidth());
    act(() => {
      result.current.onResizeStart(fakePointerDown({ clientX: 268, pointerId: 1 }));
    });
    expect(document.body.style.cursor).toBe("col-resize");
    unmount();
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(removeSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("pointerup", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("pointercancel", expect.any(Function));
  });
});
