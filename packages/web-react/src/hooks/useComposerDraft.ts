import { useCallback, useLayoutEffect, useState, type SetStateAction } from "react";
import { clearDraft, readDraft, writeDraft } from "../lib/composerDraft";

type Draft = { key: string | undefined; text: string };

/** The text and its owner move together; a new key must never inherit old text. */
export function useComposerDraft(key: string | undefined) {
  const [draft, setDraft] = useState<Draft>(() => ({ key, text: key ? readDraft(key) : "" }));
  if (draft.key !== key) {
    // React retries this component before committing children/effects. Unlike a passive
    // key-change effect, no frame (or persistence effect) can pair old text with a new key.
    setDraft({ key, text: key ? readDraft(key) : "" });
  }

  const setText = useCallback((next: SetStateAction<string>) => {
    setDraft((current) => {
      const text = typeof next === "function" ? next(current.text) : next;
      return text === current.text ? current : { ...current, text };
    });
  }, []);

  useLayoutEffect(() => {
    if (!draft.key) return;
    // Commit synchronously, before another click, unmount, or page reload. A debounced
    // cleanup loses the last edit/deletion on quick switches and resurrects old drafts.
    if (draft.text) writeDraft(draft.key, draft.text);
    else clearDraft(draft.key);
  }, [draft]);

  return [draft.text, setText] as const;
}
