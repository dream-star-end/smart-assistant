import { useSyncExternalStore } from "react";

const QUERY = "(min-width: 1280px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches;
}

/** `xl` 及以上。jsdom / SSR 默认 false，右栏按未开列测。 */
export function useXlViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
