import type { BashTail, ChatMessage, ChildBlock } from "./model";
import {
  isCcbBashOutputTailEnvelope,
  isTurnTapeProcessControl,
  turnTapeProcessKey,
} from "./render";

type LoadedBashTail = BashTail & { toolUseId: string };

function loadedBashTail(message: ChatMessage): LoadedBashTail | null {
  if (!isCcbBashOutputTailEnvelope(message)) return null;
  const raw = message._runtimeEvent as Record<string, unknown>;
  if (typeof raw.tool_use_id !== "string" || raw.tool_use_id.length === 0) return null;
  return {
    toolUseId: raw.tool_use_id,
    tail: typeof raw.tail === "string" ? raw.tail : "",
    totalBytes: typeof raw.total_bytes === "number" && Number.isFinite(raw.total_bytes)
      ? raw.total_bytes
      : 0,
    truncatedHead: raw.truncated_head === true,
  };
}

function sameBashTail(a: BashTail | undefined, b: LoadedBashTail): boolean {
  return !!a &&
    a.tail === b.tail &&
    a.totalBytes === b.totalBytes &&
    a.truncatedHead === b.truncatedHead;
}

/**
 * Reapply exact historical CCB Bash tail snapshots to their canonical tool
 * cards after each lazy page merge. The raw immutable runtime rows stay in
 * the message set for exact inspection, but are not separate chat cards.
 *
 * Scanning the assembled timeline makes both load orders work and also joins
 * post-terminal continuation tapes back to a tool in the originating tape.
 * Equal byte counts use the later timeline/ordinal snapshot; lower counts can
 * never replace a newer live or historical tail.
 */
function reconcileLoadedBashTails(messages: ChatMessage[]): ChatMessage[] {
  const latestByTool = new Map<string, LoadedBashTail>();
  for (const message of messages) {
    const next = loadedBashTail(message);
    if (!next) continue;
    const previous = latestByTool.get(next.toolUseId);
    if (!previous || next.totalBytes >= previous.totalBytes) {
      latestByTool.set(next.toolUseId, next);
    }
  }
  if (latestByTool.size === 0) return messages;

  let changed = false;
  const reconciled = messages.map((message) => {
    let nextMessage = message;
    if (message.role === "tool" && typeof message.blockId === "string") {
      const tail = latestByTool.get(message.blockId);
      if (
        tail &&
        tail.totalBytes >= (message.bashTail?.totalBytes ?? 0) &&
        !sameBashTail(message.bashTail, tail)
      ) {
        nextMessage = {
          ...message,
          bashTail: {
            tail: tail.tail,
            totalBytes: tail.totalBytes,
            truncatedHead: tail.truncatedHead,
          },
        };
        changed = true;
      }
    }

    if (Array.isArray(message.childBlocks)) {
      let childrenChanged = false;
      const childBlocks = message.childBlocks.map((child): ChildBlock => {
        if (child.kind !== "tool_use" || typeof child.blockId !== "string") return child;
        const tail = latestByTool.get(child.blockId);
        if (
          !tail ||
          tail.totalBytes < (child.bashTail?.totalBytes ?? 0) ||
          sameBashTail(child.bashTail, tail)
        ) return child;
        childrenChanged = true;
        return {
          ...child,
          bashTail: {
            tail: tail.tail,
            totalBytes: tail.totalBytes,
            truncatedHead: tail.truncatedHead,
          },
        };
      });
      if (childrenChanged) {
        nextMessage = {
          ...nextMessage,
          childBlocks,
          _runtimeBashTailRevision: (message._runtimeBashTailRevision ?? 0) + 1,
        };
        changed = true;
      }
    }
    return nextMessage;
  });
  return changed ? reconciled : messages;
}

/** Merge one immutable reverse physical-ordinal page around its process cursor.
 * The already-visible genuine narrative is retained byte-for-byte; fetched
 * process rows are only an in-memory viewport cache. */
export function mergeTapePage(
  messages: ChatMessage[],
  anchorId: string,
  records: ChatMessage[],
  nextCursor: number | null,
): ChatMessage[] | null {
  const anchorIndex = messages.findIndex(
    (message) => message?.id === anchorId && isTurnTapeProcessControl(message),
  );
  if (anchorIndex < 0) return null;
  const sourceAnchor = messages[anchorIndex]!;
  const key = turnTapeProcessKey(sourceAnchor);
  const pageKey = `${key}::${sourceAnchor._turnTapeProcessExpanded === true
    ? `before:${String(sourceAnchor._turnTapeProcessCursor)}`
    : "tail"}`;
  const anchor: ChatMessage = {
    ...sourceAnchor,
    _turnTapeProcessExpanded: true,
    _turnTapeProcessCursor: nextCursor,
  };
  const anchorChanged =
    sourceAnchor._turnTapeProcessExpanded !== true ||
    sourceAnchor._turnTapeProcessCursor !== nextCursor;
  const isSameTapeRecord = (message: ChatMessage): boolean =>
    message.id !== sourceAnchor.id &&
    message._turnTapeId === sourceAnchor._turnTapeId &&
    (sourceAnchor._turnTapeSha256 === undefined ||
      message._turnTapeSha256 === undefined ||
      message._turnTapeSha256 === sourceAnchor._turnTapeSha256);
  const existingSection = messages.filter(isSameTapeRecord);
  const sectionIds = new Set(existingSection.map((message) => message.id));
  const idsOutsideSection = new Set(
    messages.filter((message) => !isSameTapeRecord(message)).map((message) => message.id),
  );
  const mergedSection = [...existingSection];
  let added = false;
  for (const record of Array.isArray(records) ? records : []) {
    if (
      !record || typeof record.id !== "string" || record.id.length === 0 ||
      sectionIds.has(record.id) || idsOutsideSection.has(record.id)
    ) continue;
    sectionIds.add(record.id);
    added = true;
    mergedSection.push({
      ...record,
      _source: "server",
      _turnTapeProcessLoadedFrom: key,
      _turnTapeProcessPageKey: pageKey,
      _turnTapeId: sourceAnchor._turnTapeId,
      _turnTapeSha256: sourceAnchor._turnTapeSha256,
      _turnTapeComplete: true,
      _seq: sourceAnchor._seq,
      _orderSeq: sourceAnchor._orderSeq,
      _clientMessageId:
        typeof record._clientMessageId === "string" && record._clientMessageId
          ? record._clientMessageId
          : sourceAnchor._clientMessageId,
      ts: typeof record.ts === "number" && Number.isFinite(record.ts)
        ? record.ts
        : sourceAnchor.ts,
    });
  }
  if (!added && !anchorChanged) return messages;
  const originalPosition = new Map(mergedSection.map((message, index) => [message.id, index]));
  const ordinalOf = (message: ChatMessage): number =>
    typeof message._turnTapeOrdinal === "number"
      ? message._turnTapeOrdinal
      : typeof message._recordOrdinal === "number"
        ? message._recordOrdinal
        : Number.MAX_SAFE_INTEGER;
  mergedSection.sort((a, b) => {
    const byOrdinal = ordinalOf(a) - ordinalOf(b);
    if (byOrdinal !== 0) return byOrdinal;
    const ao = typeof a._ocEventOrdinal === "number" ? a._ocEventOrdinal : Number.MAX_SAFE_INTEGER;
    const bo = typeof b._ocEventOrdinal === "number" ? b._ocEventOrdinal : Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return (originalPosition.get(a.id) ?? 0) - (originalPosition.get(b.id) ?? 0);
  });
  const withoutSection = messages
    .filter((message) => !isSameTapeRecord(message))
    .map((message) => message.id === sourceAnchor.id ? anchor : message);
  const controlIndex = withoutSection.findIndex((message) => message.id === sourceAnchor.id);
  return reconcileLoadedBashTails([
    ...withoutSection.slice(0, controlIndex + 1),
    ...mergedSection,
    ...withoutSection.slice(controlIndex + 1),
  ]);
}
