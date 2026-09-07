const PREFIX = "oc_v5_composer_draft:";
const MAX_BYTES = 20 * 1024;

function storageKey(key: string): string {
  return `${PREFIX}${key}`;
}

export function readDraft(key: string): string {
  if (!key) return "";
  try {
    return sessionStorage.getItem(storageKey(key)) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(key: string, text: string): void {
  if (!key) return;
  try {
    if (new Blob([text]).size > MAX_BYTES) return;
    sessionStorage.setItem(storageKey(key), text);
  } catch {
    /* quota / private mode */
  }
}

export function clearDraft(key: string): void {
  if (!key) return;
  try {
    sessionStorage.removeItem(storageKey(key));
  } catch {
    /* ignore */
  }
}
