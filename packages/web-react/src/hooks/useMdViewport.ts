import { useSyncExternalStore } from "react";

const QUERY = "(min-width: 768px)";
/** 与 Tailwind `sm`(min-width: 640px)互斥;BrowsePanel 同类窄屏查询同一条。 */
const NARROW_QUERY = "(max-width: 639px)";
const NARROW_SUBPIXEL_QUERY = "(max-width: 639.98px)";
const MEDIUM_CLASS_QUERY = "(min-width: 640px)";
const EXPANDED_CLASS_QUERY = "(min-width: 1024px)";
const WIDE_CLASS_QUERY = "(min-width: 1200px)";
const SHORT_VIEWPORT_QUERY = "(max-height: 560px)";

export type ViewportClass = "compact" | "medium" | "expanded" | "wide";

function subscribeQuery(query: string, onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(query);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function snapshotQuery(query: string): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(query).matches
  );
}

function subscribe(onChange: () => void): () => void {
  return subscribeQuery(QUERY, onChange);
}

function getSnapshot(): boolean {
  return snapshotQuery(QUERY);
}

function subscribeNarrow(onChange: () => void): () => void {
  return subscribeQuery(NARROW_QUERY, onChange);
}

function getNarrowSnapshot(): boolean {
  return snapshotQuery(NARROW_QUERY);
}

/** `md` 及以上。jsdom / SSR 默认 false，设置壳按窄屏横滚 tab 测。 */
export function useMdViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** `sm` 以下（<640px）。jsdom / SSR 默认 false，按宽屏测。 */
export function useNarrowViewport(): boolean {
  return useSyncExternalStore(subscribeNarrow, getNarrowSnapshot, () => false);
}

/** 详情面板内联成第三列的门槛:再窄就挤掉对话列(1024 宽时对话列只剩 ~370px),改用贴底面板。 */
const WIDE_QUERY = "(min-width: 1100px)";

function subscribeWide(onChange: () => void): () => void {
  return subscribeQuery(WIDE_QUERY, onChange);
}

function getWideSnapshot(): boolean {
  return snapshotQuery(WIDE_QUERY);
}

/** ≥1100px。jsdom / SSR 默认 false(按窄屏贴底面板测)。 */
export function useWideViewport(): boolean {
  return useSyncExternalStore(subscribeWide, getWideSnapshot, () => false);
}

const VIEWPORT_CLASS_QUERIES = [
  WIDE_CLASS_QUERY,
  EXPANDED_CLASS_QUERY,
  MEDIUM_CLASS_QUERY,
  NARROW_QUERY,
] as const;

function subscribeViewportClass(onChange: () => void): () => void {
  const unsubs = VIEWPORT_CLASS_QUERIES.map((q) => subscribeQuery(q, onChange));
  return () => {
    for (const unsub of unsubs) unsub();
  };
}

function getViewportClassSnapshot(): ViewportClass {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "wide";
  if (window.matchMedia(WIDE_CLASS_QUERY).matches) return "wide";
  if (window.matchMedia(EXPANDED_CLASS_QUERY).matches) return "expanded";
  if (window.matchMedia(MEDIUM_CLASS_QUERY).matches) return "medium";
  if (window.matchMedia(NARROW_QUERY).matches || window.matchMedia(NARROW_SUBPIXEL_QUERY).matches) {
    return "compact";
  }
  // jsdom 全局桩对所有查询恒返回 matches=false；与 useNarrowViewport() 默认 false 一致，回落桌面宽屏。
  return "wide";
}

/**
 * 统一 4 档视口语义分类（OCV5-820）：
 * - `compact`: <640px（手机单栏 + BottomSheet）
 * - `medium`: 640–1023px（折叠屏 / 平板）
 * - `expanded`: 1024–1199px（窄桌面，双栏优先）
 * - `wide`: ≥1200px（宽桌面，允许三栏并存）
 */
export function useViewportClass(): ViewportClass {
  return useSyncExternalStore(subscribeViewportClass, getViewportClassSnapshot, () => "wide");
}

function subscribeShortViewport(onChange: () => void): () => void {
  return subscribeQuery(SHORT_VIEWPORT_QUERY, onChange);
}

function getShortViewportSnapshot(): boolean {
  return snapshotQuery(SHORT_VIEWPORT_QUERY);
}

/** 视口高度 ≤560px（横屏手机 / 矮分屏窗口）。jsdom / SSR 默认 false。 */
export function useShortViewport(): boolean {
  return useSyncExternalStore(subscribeShortViewport, getShortViewportSnapshot, () => false);
}
