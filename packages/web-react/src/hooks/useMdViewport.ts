import { useSyncExternalStore } from "react";

const QUERY = "(min-width: 768px)";
/** 与 Tailwind `sm`(min-width: 640px)互斥;BrowsePanel 同类窄屏查询同一条。 */
const NARROW_QUERY = "(max-width: 639px)";

function subscribeQuery(query: string, onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(query);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function snapshotQuery(query: string): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
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
