const PREFIX = "oc_v5_composer_draft:";
const MAX_BYTES = 20 * 1024;
export const NEW_COMPOSER_DRAFT_KEY = "new";
// Storage has a size/quota limit; keep rejected drafts in this tab's memory so a
// session switch cannot restore an older saved prefix. These do not survive reload.
const volatileDrafts = new Map<string, string>();

function storageKey(key: string): string {
  return `${PREFIX}${key}`;
}

/** Bind a session draft key to a stable account id. Legacy unscoped keys stay as-is. */
export function accountDraftKey(sessionKey: string, accountId?: string | null): string {
  const id = accountId?.trim();
  return id ? `${id}:${sessionKey}` : sessionKey;
}

export function isNewComposerDraftKey(key: string | undefined | null): boolean {
  return key === NEW_COMPOSER_DRAFT_KEY || !!key?.endsWith(`:${NEW_COMPOSER_DRAFT_KEY}`);
}

/**
 * Identity teardown: drop in-memory drafts and this account's persisted keys.
 * Unscoped `new` is deleted, never migrated to the next account. Token refresh
 * must not call this.
 */
export function teardownComposerDrafts(accountId?: string | null): void {
  volatileDrafts.clear();
  try {
    const id = accountId?.trim() ?? "";
    const toRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      const rest = k.slice(PREFIX.length);
      if (rest === NEW_COMPOSER_DRAFT_KEY) toRemove.push(k);
      if (id && (rest === id || rest.startsWith(`${id}:`))) toRemove.push(k);
    }
    for (const k of toRemove) sessionStorage.removeItem(k);
  } catch {
    /* storage unavailable: volatile map already cleared */
  }
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
