import type { ChatMessage } from "./model";
import { isTurnTapeProcessControl, turnTapeProcessKey } from "./render";

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
  const anchor: ChatMessage = {
    ...sourceAnchor,
    _turnTapeProcessExpanded: true,
    _turnTapeProcessCursor: nextCursor,
  };
  const key = turnTapeProcessKey(sourceAnchor);
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
  for (const record of Array.isArray(records) ? records : []) {
    if (
      !record || typeof record.id !== "string" || record.id.length === 0 ||
      sectionIds.has(record.id) || idsOutsideSection.has(record.id)
    ) continue;
    sectionIds.add(record.id);
    mergedSection.push({
      ...record,
      _source: "server",
      _turnTapeProcessLoadedFrom: key,
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
  return [
    ...withoutSection.slice(0, controlIndex + 1),
    ...mergedSection,
    ...withoutSection.slice(controlIndex + 1),
  ];
}
