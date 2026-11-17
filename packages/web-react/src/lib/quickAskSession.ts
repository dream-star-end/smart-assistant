export const QUICK_ASK_SESSION_PREFIX = "webqa_";
export const QUICK_ASK_TITLE_PREFIX = "[快问] ";

/**
 * Mints an isolated quick-ask session id matching backend `[A-Za-z0-9_-]{8,50}`.
 */
export function genQuickAskSessionId(): string {
  return `${QUICK_ASK_SESSION_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Returns true when a temporary quick-ask session should stay hidden from the
 * main Sidebar list. Promoted sessions (whose title no longer starts with
 * "[快问]") and `keepId` remain visible.
 */
export function isHiddenQuickAskSession(
  s: { id: string; title?: string },
  keepId?: string,
): boolean {
  if (!s.id.startsWith(QUICK_ASK_SESSION_PREFIX) || s.id === keepId) return false;
  const title = (s.title ?? "").trim();
  if (title.length > 0 && !title.startsWith("[快问]") && title !== "新对话") return false;
  return true;
}

/**
 * Strips temporary quick-ask prefixes to produce a clean formal session title.
 */
export function cleanQuickAskTitle(rawTitle: string | undefined, fallbackText?: string): string {
  const strip = (v: string | undefined) => (v ?? "").replace(/^(?:\[快问\]\s*)+/, "").trim();
  const base = strip(rawTitle);
  const candidate = base && base !== "新对话" ? base : strip(fallbackText);
  const normalized = candidate.replace(/\s+/g, " ").trim().slice(0, 48).trim();
  if (!normalized || normalized === "新对话") return "快问对话";
  return normalized;
}

/**
 * Parses `/btw <question>` or `/ask <question>` slash commands in the composer.
 */
export function parseQuickAskSlashCommand(
  raw: string,
): { matched: true; question: string } | { matched: false } {
  const trimmed = raw.trimStart();
  const match = /^\/(?:btw|ask)(?:$|\s+([\s\S]*))$/i.exec(trimmed);
  if (!match) return { matched: false };
  return { matched: true, question: (match[1] ?? "").trim() };
}
