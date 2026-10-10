import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DETAIL_PANE_WIDTH } from "../components/InspectorPanel";
import { useResizableWidth } from "./useResizableWidth";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  vi.restoreAllMocks();
});

for (const m of ["setPointerCapture", "releasePointerCapture"] as const) {
  if (!(m in Element.prototype)) {
    Object.defineProperty(Element.prototype, m, { value: () => {}, configurable: true, writable: true });
  }
}

describe("useResizableWidth(详情面板:把手在左缘)", () => {
  test("默认宽、读回记忆并夹回范围", () => {
    expect(renderHook(() => useResizableWidth(DETAIL_PANE_WIDTH)).result.current.width).toBe(440);
    cleanup();
    localStorage.setItem(DETAIL_PANE_WIDTH.storageKey, "9999");
    expect(renderHook(() => useResizableWidth(DETAIL_PANE_WIDTH)).result.current.width).toBe(720);
  });

  test("往左拖变宽、松手落盘;键盘 ← 变宽 → 变窄;双击复位", () => {
    const { result } = renderHook(() => useResizableWidth(DETAIL_PANE_WIDTH));
    const handle = document.createElement("div");
    document.body.appendChild(handle);
    act(() => {
      result.current.onResizeStart({
        button: 0,
        detail: 1,
        pointerId: 1,
        clientX: 800,
        currentTarget: handle,
        preventDefault() {},
      } as unknown as import("react").PointerEvent);
    });
    act(() => {
      document.dispatchEvent(new PointerEvent("pointermove", { clientX: 700, pointerId: 1 }));
      document.dispatchEvent(new PointerEvent("pointerup", { clientX: 700, pointerId: 1 }));
    });
    expect(result.current.width).toBe(540);
    expect(localStorage.getItem(DETAIL_PANE_WIDTH.storageKey)).toBe("540");
    const key = (k: string) =>
      act(() => {
        result.current.onResizeKeyDown({ key: k, shiftKey: false, preventDefault() {} } as unknown as import("react").KeyboardEvent);
      });
    key("ArrowLeft");
    expect(result.current.width).toBe(556);
    key("ArrowRight");
    key("ArrowRight");
    expect(result.current.width).toBe(524);
    act(() => {
      result.current.onResizeStart({
        button: 0,
        detail: 2,
        pointerId: 2,
        clientX: 0,
        currentTarget: handle,
        preventDefault() {},
      } as unknown as import("react").PointerEvent);
    });
    expect(result.current.width).toBe(440);
    handle.remove();
  });
});
