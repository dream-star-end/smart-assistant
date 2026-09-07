import type { ChatMessage } from "../../lib/chat/model";

export type FindMatch = { index: number; key: string };

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
