/**
 * Recently opened projects and chats for the Ctrl/⌘K palette's empty state.
 *
 * Per user, in localStorage, best effort: private mode / quota / blocked storage
 * just means no recents. Kept tiny because App imports it statically (the palette
 * itself is a lazy chunk).
 */
export type PaletteRecent = { kind: "project" | "session"; id: string; at: number };

export const PALETTE_RECENTS_MAX = 8;
const KEY_PREFIX = "oc_v5_palette_recents:";

export function paletteRecentsKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

export function readPaletteRecents(userId: string | null | undefined): PaletteRecent[] {
  if (!userId) return [];
  try {
    const raw = localStorage.getItem(paletteRecentsKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: PaletteRecent[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const { kind, id, at } = item as Record<string, unknown>;
      if ((kind !== "project" && kind !== "session") || typeof id !== "string" || !id) continue;
      out.push({ kind, id, at: typeof at === "number" && Number.isFinite(at) ? at : 0 });
      if (out.length >= PALETTE_RECENTS_MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Move (kind, id) to the front; returns the new list (also when storage fails). */
export function pushPaletteRecent(
  userId: string | null | undefined,
  entry: { kind: PaletteRecent["kind"]; id: string },
  now: number = Date.now(),
): PaletteRecent[] {
  if (!userId || !entry.id) return [];
  const next = [
    { kind: entry.kind, id: entry.id, at: now },
    ...readPaletteRecents(userId).filter((r) => !(r.kind === entry.kind && r.id === entry.id)),
  ].slice(0, PALETTE_RECENTS_MAX);
  try {
    localStorage.setItem(paletteRecentsKey(userId), JSON.stringify(next));
  } catch {
    /* private mode / quota: recents are a convenience */
  }
  return next;
}
