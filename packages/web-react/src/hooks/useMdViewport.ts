import { useSyncExternalStore } from "react";

const QUERY = "(min-width: 768px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches;
}

/** `md` 及以上。jsdom / SSR 默认 false，设置壳按窄屏横滚 tab 测。 */
export function useMdViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
