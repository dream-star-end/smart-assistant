import type { ChatMessage } from "../../lib/chat/model";

export type FindMatch = { index: number; key: string };

/** Coalesced timeline row used to map a searchable message onto real DOM. */
export type FindRenderLookupItem = {
  key: string;
  memberKeys: readonly string[];
};

export type FindTarget = {
  renderIndex: number;
  renderKey: string;
  memberKey: string;
};

/**
 * Resolve a find hit onto the coalesced render list by message key.
 * Mapping failure must cancel the jump — never fall back to the raw index.
 */
export function locateFindMatch(
  items: readonly FindRenderLookupItem[],
  match: FindMatch | null | undefined,
): FindTarget | null {
  if (!match || typeof match.key !== "string" || match.key.length === 0) return null;
  for (let renderIndex = 0; renderIndex < items.length; renderIndex += 1) {
    const item = items[renderIndex];
    if (item.key === match.key || item.memberKeys.includes(match.key)) {
      return { renderIndex, renderKey: item.key, memberKey: match.key };
    }
  }
  return null;
}

/**
 * Row key for a single ChatMessage. Same rule as MessageRenderer.renderItemKey
 * (single branch): `_timelineUnitKey ?? id`.
 */
export function timelineMessageKey(m: { _timelineUnitKey?: string; id?: string } | null | undefined): string {
  const key = m?._timelineUnitKey ?? m?.id;
  return typeof key === "string" && key.length > 0 ? key : "single-missing";
}

export function findMatches(messages: readonly ChatMessage[], query: string): FindMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const out: FindMatch[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const m = messages[index];
    if (m.role !== "user" && m.role !== "assistant") continue;
    if ((m.text ?? "").toLowerCase().includes(needle)) {
      out.push({ index, key: timelineMessageKey(m) });
    }
  }
  return out;
}

export function stepMatch(matches: readonly FindMatch[], current: number, dir: 1 | -1): number {
  if (matches.length === 0) return -1;
  if (!Number.isFinite(current) || current < 0 || current >= matches.length) {
    return dir > 0 ? 0 : matches.length - 1;
  }
  return (current + dir + matches.length) % matches.length;
}
