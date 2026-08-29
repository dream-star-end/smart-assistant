/**
 * Dual-slot timeline projector (OCV5-21 P0).
 *
 * Pure function: per-identity content + locator slots. exact_deferred never
 * writes the content slot. Only exact_displayable converges both slots.
 * P0 callers run this in shadow mode and must not feed the result back into
 * sessions[].messages.
 */
import {
  EPOCH_BAND,
  deriveProcessKeyFromRecord,
  packEpoch,
  timelineIdentity,
  type TimelineLifecycle,
} from "@openclaude/protocol";
import type { ChatMessage } from "../chat/model";

export type LifecycleSlots = { content?: ChatMessage; locator?: ChatMessage };

const LIFECYCLES = new Set<TimelineLifecycle>([
  "optimistic_local",
  "live_open",
  "live_closed",
  "phase_a",
  "exact_deferred",
  "exact_displayable",
  "retired",
]);

function asLifecycle(value: unknown): TimelineLifecycle | undefined {
  return typeof value === "string" && LIFECYCLES.has(value as TimelineLifecycle)
    ? (value as TimelineLifecycle)
    : undefined;
}

export function turnOwnerOf(row: ChatMessage): string {
  if (typeof row._turnOwnerId === "string" && row._turnOwnerId) return row._turnOwnerId;
  if (typeof row._clientMessageId === "string" && row._clientMessageId) return row._clientMessageId;
  return "";
}

function incompleteDurableTool(row: ChatMessage): boolean {
  if (row.role !== "tool") return false;
  const extra = row as ChatMessage & { partial?: boolean; completed?: boolean };
  if (typeof row.output === "string" && row.output.length > 0) return false;
  if (row.error === true) return false;
  return extra._partial === true || extra.partial === true || extra._completed === false || extra.completed === false;
}

export function lifecycleOf(row: ChatMessage): TimelineLifecycle {
  const stamped = asLifecycle(row._lifecycle);
  if (stamped) return stamped;
  if (row.role === "permission") return "live_open";
  if (row._payloadDeferred === true) return "exact_deferred";
  if (row._displayDegradeReason === "records_unpublished") return "phase_a";
  if (incompleteDurableTool(row)) return "live_closed";
  if (row._timelineRecord === true || (row._source === "server" && row._turnTapeComplete === true)) {
    return "exact_displayable";
  }
  if (row._liveUnit === true) return row._completed === false || row._completed === undefined ? "live_open" : "live_closed";
  if (row._source === "server") return "exact_displayable";
  return "optimistic_local";
}

export function processKeyOf(row: ChatMessage): string {
  if (typeof row._timelineProcessKey === "string") return row._timelineProcessKey;
  if (row.role === "permission") {
    return typeof row.requestId === "string" && row.requestId
      ? row.requestId
      : `permission:${turnOwnerOf(row) || row.id}`;
  }
  if (row.role === "user" || row.role === "system") return `id:${row.id}`;
  const extra = row as ChatMessage & { messageId?: string; jobId?: string };
  return deriveProcessKeyFromRecord({
    role: row.role,
    messageId: typeof extra.messageId === "string" ? extra.messageId : undefined,
    blockId: row.blockId,
    runId: row.runId,
    jobId: extra.jobId,
    requestId: row.requestId,
    _delegateRunId: row._delegateRunId,
    _timelineProcessKey: row._timelineProcessKey,
    _turnTapeId: row._turnTapeId,
    _turnTapeOrdinal: row._turnTapeOrdinal,
    _recordOrdinal: row._recordOrdinal,
  });
}

export function identityOf(row: ChatMessage): string {
  if (typeof row._timelineIdentity === "string" && row._timelineIdentity) return row._timelineIdentity;
  if (row.role === "user" || row.role === "system") return `id:${row.id}`;
  return timelineIdentity(turnOwnerOf(row), row.role, processKeyOf(row));
}

export function epochOf(row: ChatMessage): number {
  if (typeof row._lifecycleEpoch === "number" && Number.isSafeInteger(row._lifecycleEpoch)) {
    return row._lifecycleEpoch;
  }
  const lc = lifecycleOf(row);
  if (lc === "exact_displayable") {
    return packEpoch(EPOCH_BAND.TAPE, 0, typeof row._recordOrdinal === "number" ? row._recordOrdinal : 0, 1);
  }
  if (lc === "exact_deferred" || lc === "phase_a") {
    return packEpoch(EPOCH_BAND.TAPE, 0, typeof row._recordOrdinal === "number" ? row._recordOrdinal : 0, 0);
  }
  if (lc === "live_open" || lc === "live_closed") {
    const streamGen = typeof row._timelineStreamGen === "number" ? row._timelineStreamGen : 0;
    return packEpoch(EPOCH_BAND.LIVE, streamGen, 0, 0);
  }
  return packEpoch(EPOCH_BAND.OPTIMISTIC, 0, 0, 0);
}

export function progressRank(lc: TimelineLifecycle): number {
  switch (lc) {
    case "optimistic_local": return 0;
    case "live_open": return 1;
    case "live_closed":
    case "phase_a": return 2;
    case "exact_displayable": return 4;
    default: return -1;
  }
}

function textLen(row: ChatMessage): number {
  const output = typeof row.output === "string" ? row.output : "";
  return (row.text || "").length + output.length;
}

function childCount(row: ChatMessage): number {
  return Array.isArray(row.childBlocks) ? row.childBlocks.length : 0;
}

export function wouldRegressIrreversible(prev: ChatMessage, next: ChatMessage): boolean {
  if (textLen(next) < textLen(prev)) return true;
  if (childCount(next) < childCount(prev)) return true;
  if (prev.error === true && next.error !== true) return true;
  if (prev._completed === true && next._completed !== true) return true;
  return false;
}

export function mergeIrreversible(prev: ChatMessage, next: ChatMessage): ChatMessage {
  const merged: ChatMessage = { ...prev, ...next };
  if (textLen(next) < textLen(prev)) {
    merged.text = prev.text;
    if (typeof prev.output === "string") merged.output = prev.output;
  }
  if (childCount(next) < childCount(prev) && prev.childBlocks) {
    merged.childBlocks = prev.childBlocks;
  }
  if (prev.error === true) merged.error = true;
  if (prev._completed === true) merged._completed = true;
  return merged;
}

function overlayEqualEpoch(prev: ChatMessage, next: ChatMessage): ChatMessage {
  if (wouldRegressIrreversible(prev, next)) return prev;
  return mergeIrreversible(prev, next);
}

function betterContent(prev: ChatMessage | undefined, row: ChatMessage): ChatMessage {
  if (!prev) return row;
  const eNew = epochOf(row);
  const eOld = epochOf(prev);
  if (eNew < eOld) return prev;
  if (eNew === eOld) {
    const rNew = progressRank(lifecycleOf(row));
    const rOld = progressRank(lifecycleOf(prev));
    if (rNew < rOld) return prev;
    if (rNew > rOld) return row;
    return overlayEqualEpoch(prev, row);
  }
  return row;
}

function stableOrder(rows: ChatMessage[]): ChatMessage[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const ao = typeof a.row._orderSeq === "number" ? a.row._orderSeq : Number.MAX_SAFE_INTEGER;
      const bo = typeof b.row._orderSeq === "number" ? b.row._orderSeq : Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      const at = typeof a.row.ts === "number" && Number.isFinite(a.row.ts) ? a.row.ts : 0;
      const bt = typeof b.row.ts === "number" && Number.isFinite(b.row.ts) ? b.row.ts : 0;
      if (at !== bt) return at - bt;
      return a.index - b.index;
    })
    .map((item) => item.row);
}

export function projectTimeline(input: ChatMessage[]): ChatMessage[] {
  const slots = new Map<string, LifecycleSlots>();
  for (const row of input) {
    if (!row) continue;
    const lc = lifecycleOf(row);
    if (lc === "retired") continue;
    const id = identityOf(row);
    const current = slots.get(id) ?? {};
    if (lc === "exact_deferred") {
      const cur = current.locator;
      if (!cur || epochOf(row) > epochOf(cur)) {
        current.locator = row;
      } else if (epochOf(row) === epochOf(cur)) {
        current.locator = overlayEqualEpoch(cur, row);
      }
    } else {
      current.content = betterContent(current.content, row);
    }
    slots.set(id, current);
  }
  const out: ChatMessage[] = [];
  for (const slot of slots.values()) {
    const exact = slot.content && lifecycleOf(slot.content) === "exact_displayable";
    if (slot.content) out.push(slot.content);
    if (slot.locator && !exact) out.push(slot.locator);
  }
  return stableOrder(out);
}

export function isLiveLifecycle(lc: TimelineLifecycle): boolean {
  return lc === "live_open" || lc === "live_closed" || lc === "optimistic_local";
}
