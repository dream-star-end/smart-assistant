import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  useMdViewport,
  useNarrowViewport,
  useShortViewport,
  useViewportClass,
  useWideViewport,
} from "./useMdViewport";

const originalMatchMedia = window.matchMedia;

function createViewportController(initialWidth: number, initialHeight: number) {
  let width = initialWidth;
  let height = initialHeight;
  const listeners = new Map<string, Set<() => void>>();

  const evalQuery = (query: string): boolean => {
    const minW = /\(min-width:\s*([\d.]+)px\)/.exec(query);
    if (minW) return width >= Number(minW[1]);
    const maxW = /\(max-width:\s*([\d.]+)px\)/.exec(query);
    if (maxW) return width <= Number(maxW[1]);
    const maxH = /\(max-height:\s*([\d.]+)px\)/.exec(query);
    if (maxH) return height <= Number(maxH[1]);
    return false;
  };

  window.matchMedia = ((query: string) =>
    ({
      get matches() {
        return evalQuery(query);
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, cb: () => void) => {
        const set = listeners.get(query) ?? new Set<() => void>();
        set.add(cb);
        listeners.set(query, set);
      },
      removeEventListener: (_type: string, cb: () => void) => {
        listeners.get(query)?.delete(cb);
      },
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;

  return {
    resize(nextWidth: number, nextHeight = height) {
      width = nextWidth;
      height = nextHeight;
      for (const set of listeners.values()) {
        for (const cb of set) cb();
      }
    },
  };
}

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("useMdViewport viewport primitives (OCV5-820)", () => {
  it("keeps jsdom defaults backward-compatible when matchMedia stub returns false", () => {
    const { result } = renderHook(() => ({
      md: useMdViewport(),
      narrow: useNarrowViewport(),
      wide: useWideViewport(),
      vpClass: useViewportClass(),
      short: useShortViewport(),
    }));

    expect(result.current.md).toBe(false);
    expect(result.current.narrow).toBe(false);
    expect(result.current.wide).toBe(false);
    expect(result.current.vpClass).toBe("wide");
    expect(result.current.short).toBe(false);
  });

  it("classifies <640 compact, 640-1023 medium, 1024-1199 expanded, >=1200 wide and reacts to resize", () => {
    const ctrl = createViewportController(390, 844);
    const { result } = renderHook(() => useViewportClass());
    expect(result.current).toBe("compact");

    act(() => ctrl.resize(639, 844));
    expect(result.current).toBe("compact");

    act(() => ctrl.resize(640, 844));
    expect(result.current).toBe("medium");

    act(() => ctrl.resize(1023, 844));
    expect(result.current).toBe("medium");

    act(() => ctrl.resize(1024, 844));
    expect(result.current).toBe("expanded");

    act(() => ctrl.resize(1199, 844));
    expect(result.current).toBe("expanded");

    act(() => ctrl.resize(1200, 844));
    expect(result.current).toBe("wide");
  });

  it("detects short viewports (max-height: 560px) and reacts to height changes", () => {
    const ctrl = createViewportController(844, 390);
    const { result } = renderHook(() => ({
      vpClass: useViewportClass(),
      short: useShortViewport(),
    }));

    expect(result.current.vpClass).toBe("medium");
    expect(result.current.short).toBe(true);

    act(() => ctrl.resize(844, 560));
    expect(result.current.short).toBe(true);

    act(() => ctrl.resize(844, 561));
    expect(result.current.short).toBe(false);
  });
});
