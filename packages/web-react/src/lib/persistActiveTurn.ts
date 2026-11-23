import type { ChatMessage } from "./chat/model";

/**
 * 判断某条本地行是否属于当前活跃轮（client-owned、非 server-authored、未被 absorb）。
 * 全量同步（mergeFullServerWins）若活跃轮实时行恰好落在 server 已有行之前，
 * 必须保留它们，避免 SwarmBoard / tool 等活跃过程卡被误删（OCV5-867）。
 */
export function isActiveTurnLiveRow(
  m: ChatMessage,
  activeOwner: string | undefined,
  turnOwnerId: (row: ChatMessage) => string | undefined,
): boolean {
  if (!activeOwner) return false;
  if (m._source === "server" || typeof m._turnTapeId === "string") return false;
  if (m._adoptedInto) return false;
  return turnOwnerId(m) === activeOwner;
}

/**
 * 当活跃轮的 live units / WS 帧先于该轮 user 气泡到达本地，或全量/增量同步首次把
 * 活跃轮 user 追在末尾时，把位于该 user 之前的同轮 client-owned 实时行（SwarmBoard、
 * tool、agent-group、thinking 等）按原相对顺序移回该 user 之后（紧贴 owner 之后、
 * 位于本已在 owner 之后的实时行之前）（OCV5-867）。
 */
export function repositionActiveTurnRowsAfterOwner(
  rows: ChatMessage[],
  activeOwner: string | undefined,
  turnOwnerId: (row: ChatMessage) => string | undefined,
): ChatMessage[] {
  if (!activeOwner || rows.length < 2) return rows;
  const ownerIdx = rows.findIndex(
    (m) => m.role === "user" && (m.id === activeOwner || m._clientMessageId === activeOwner),
  );
  if (ownerIdx <= 0) return rows;
  let hasMisplaced = false;
  for (let idx = 0; idx < ownerIdx; idx++) {
    const m = rows[idx];
    if (m && m.role !== "user" && isActiveTurnLiveRow(m, activeOwner, turnOwnerId)) {
      hasMisplaced = true;
      break;
    }
  }
  if (!hasMisplaced) return rows;
  const before: ChatMessage[] = [];
  const misplaced: ChatMessage[] = [];
  for (let idx = 0; idx < ownerIdx; idx++) {
    const m = rows[idx]!;
    if (m.role !== "user" && isActiveTurnLiveRow(m, activeOwner, turnOwnerId)) {
      misplaced.push(m);
    } else {
      before.push(m);
    }
  }
  return [...before, rows[ownerIdx]!, ...misplaced, ...rows.slice(ownerIdx + 1)];
}
