const PREFIX = "oc_v5_composer_draft:";
const MAX_BYTES = 20 * 1024;
export const NEW_COMPOSER_DRAFT_KEY = "new";
// Storage has a size/quota limit; keep rejected drafts in this tab's memory so a
// session switch cannot restore an older saved prefix. These do not survive reload.
const volatileDrafts = new Map<string, string>();

function storageKey(key: string): string {
  return `${PREFIX}${key}`;
}

export function readDraft(key: string): string {
  if (!key) return "";
  if (volatileDrafts.has(key)) return volatileDrafts.get(key)!;
  try {
    return sessionStorage.getItem(storageKey(key)) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(key: string, text: string): void {
  if (!key) return;
  try {
    if (new Blob([text]).size > MAX_BYTES) {
      volatileDrafts.set(key, text);
      sessionStorage.removeItem(storageKey(key));
      return;
    }
    sessionStorage.setItem(storageKey(key), text);
    volatileDrafts.delete(key);
  } catch {
    volatileDrafts.set(key, text);
  }
}

export function clearDraft(key: string): void {
  if (!key) return;
  try {
    sessionStorage.removeItem(storageKey(key));
    volatileDrafts.delete(key);
  } catch {
    // Remember deletion even when storage is temporarily unavailable.
    volatileDrafts.set(key, "");
  }
}

/** Only for allocating an ID to the SAME unsent session (e.g. GitHub/goal setup). */
export function moveDraft(from: string, to: string): void {
  if (!from || !to || from === to) return;
  const text = readDraft(from);
  if (text) writeDraft(to, text);
  else clearDraft(to);
  clearDraft(from);
}
