import { useCallback, useSyncExternalStore } from "react";

export type SendKey = "enter" | "mod-enter";
export type FontSize = "default" | "large";

export const COMPOSER_PREFS_STORAGE_KEY = "oc_v5_composer_prefs";

type ComposerPrefs = { sendKey: SendKey; fontSize: FontSize };

const DEFAULT_PREFS: ComposerPrefs = { sendKey: "enter", fontSize: "default" };

const listeners = new Set<() => void>();

let cachedRaw: string | null | undefined;
let cached: ComposerPrefs = DEFAULT_PREFS;

function parsePrefs(raw: string | null): ComposerPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_PREFS;
    const rec = parsed as Record<string, unknown>;
    const sendKey: SendKey = rec.sendKey === "mod-enter" ? "mod-enter" : "enter";
    const fontSize: FontSize = rec.fontSize === "large" ? "large" : "default";
    return { sendKey, fontSize };
  } catch {
    return DEFAULT_PREFS;
  }
}

function readRaw(): string | null {
  try {
    return localStorage.getItem(COMPOSER_PREFS_STORAGE_KEY);
  } catch {
    return null;
  }
}

function getSnapshot(): ComposerPrefs {
  const raw = readRaw();
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  cached = parsePrefs(raw);
  return cached;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function writePrefs(next: ComposerPrefs): void {
  const raw = JSON.stringify(next);
  try {
    localStorage.setItem(COMPOSER_PREFS_STORAGE_KEY, raw);
  } catch {
    /* private mode / quota */
  }
  cachedRaw = raw;
  cached = next;
  emit();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

export function useLocalComposerPrefs(): {
  sendKey: SendKey;
  fontSize: FontSize;
  setSendKey: (sendKey: SendKey) => void;
  setFontSize: (fontSize: FontSize) => void;
} {
  const prefs = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_PREFS);
  const setSendKey = useCallback((sendKey: SendKey) => {
    writePrefs({ ...getSnapshot(), sendKey });
  }, []);
  const setFontSize = useCallback((fontSize: FontSize) => {
    writePrefs({ ...getSnapshot(), fontSize });
  }, []);
  return {
    sendKey: prefs.sendKey,
    fontSize: prefs.fontSize,
    setSendKey,
    setFontSize,
  };
}
