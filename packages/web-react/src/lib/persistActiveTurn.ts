import type { ChatMessage } from "./chat/model";

function validOrderSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

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
 * 判断位于活跃轮 `owner` 之后（或 `owner` 尚缺席时）的某行，是否属于更早的耐久历史轮：
 * - 例如 `toStored` 剥离 `_timelineRecord` 或 Turn 1 旧 live 行被 Phase-B tape 淘汰后，
 *   `mergeFullServerWins` 先排 `local = [u2, T2_live]` 再把 Turn 1 耐久行尾追到末尾；
 * - 这些行携带更小的 `_orderSeq`（或显式归属非 `activeOwner` 的 server/tape 轮），
 *   必须拉回 `u2` 之前按耐久序归位，绝不能留在 `u2` 之后造成用户消息倒挂与两轮粘连（OCV5-868）。
 */
function isEarlierDurableNonActiveRow(
  m: ChatMessage,
  activeOwner: string,
  ownerOrderSeq: number | null,
  turnOwnerId: (row: ChatMessage) => string | undefined,
): boolean {
  if (m.role === "user") {
    return validOrderSeq(m._orderSeq) && (ownerOrderSeq === null || m._orderSeq < ownerOrderSeq);
  }
  if (isActiveTurnLiveRow(m, activeOwner, turnOwnerId)) return false;
  const rowOwner = turnOwnerId(m);
  if (rowOwner === activeOwner) return false;
  if (validOrderSeq(m._orderSeq)) {
    if (ownerOrderSeq === null) return true;
    return m._orderSeq < ownerOrderSeq;
  }
  if (m._source === "server" || typeof m._turnTapeId === "string" || m._timelineRecord === true) {
    return typeof rowOwner === "string" && rowOwner.length > 0 && rowOwner !== activeOwner;
  }
  return false;
}

/**
 * 活跃轮合并归位（OCV5-867 + OCV5-868）：
 * 1. 所有早于 `activeOwner` 的耐久历史行（即使在 `mergeFullServerWins` Loop 2 被尾追到
 *    `owner` 之后）拉回 `owner` 之前，并经 `sortPreOwner`（`stableSortByTs`）按耐久序归位；
 * 2. 落在 `owner` 之前的同轮 client-owned 实时行（SwarmBoard、tool、agent-group、thinking 等）
 *    移回 `owner` 之后，且保持本轮实时行的原始相对顺序（不破坏 OCV5-272）；
 * 3. 当 `owner` 尚缺席（跨 tab 尚未拉回 `u2`）时，同样确保更早的耐久历史行排在活跃轮实时行之前。
 */
export function repositionActiveTurnRowsAfterOwner(
  rows: ChatMessage[],
  activeOwner: string | undefined,
  turnOwnerId: (row: ChatMessage) => string | undefined,
  sortPreOwner?: (preRows: ChatMessage[]) => ChatMessage[],
): ChatMessage[] {
  if (!activeOwner || rows.length < 2) return rows;
  const ownerIdx = rows.findIndex(
    (m) => m.role === "user" && (m.id === activeOwner || m._clientMessageId === activeOwner),
  );
  if (ownerIdx < 0) {
    let seenActiveLive = false;
    let hasInvertedDurable = false;
    for (const m of rows) {
      if (m && isActiveTurnLiveRow(m, activeOwner, turnOwnerId)) {
        seenActiveLive = true;
      } else if (seenActiveLive && m && isEarlierDurableNonActiveRow(m, activeOwner, null, turnOwnerId)) {
        hasInvertedDurable = true;
        break;
      }
    }
    if (!hasInvertedDurable) return rows;
    const pre: ChatMessage[] = [];
    const active: ChatMessage[] = [];
    for (const m of rows) {
      if (isActiveTurnLiveRow(m, activeOwner, turnOwnerId)) active.push(m);
      else pre.push(m);
    }
    const sortedPre = sortPreOwner && pre.length > 1 ? sortPreOwner(pre) : pre;
    const out = [...sortedPre, ...active];
    return out.length === rows.length && out.every((m, idx) => m === rows[idx]) ? rows : out;
  }

  const owner = rows[ownerIdx]!;
  const ownerOrderSeq = validOrderSeq(owner._orderSeq) ? owner._orderSeq : null;
  let hasMisplacedActive = false;
  for (let idx = 0; idx < ownerIdx; idx++) {
    const m = rows[idx];
    if (m && m.role !== "user" && isActiveTurnLiveRow(m, activeOwner, turnOwnerId)) {
      hasMisplacedActive = true;
      break;
    }
  }
  let hasTrailingEarlierHistory = false;
  for (let idx = ownerIdx + 1; idx < rows.length; idx++) {
    const m = rows[idx];
    if (m && isEarlierDurableNonActiveRow(m, activeOwner, ownerOrderSeq, turnOwnerId)) {
      hasTrailingEarlierHistory = true;
      break;
    }
  }
  if (!hasMisplacedActive && !hasTrailingEarlierHistory) return rows;

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
  const after: ChatMessage[] = [];
  for (let idx = ownerIdx + 1; idx < rows.length; idx++) {
    const m = rows[idx]!;
    if (isEarlierDurableNonActiveRow(m, activeOwner, ownerOrderSeq, turnOwnerId)) {
      before.push(m);
    } else {
      after.push(m);
    }
  }
  const sortedBefore = hasTrailingEarlierHistory && sortPreOwner && before.length > 1
    ? sortPreOwner(before)
    : before;
  const out = [...sortedBefore, owner, ...misplaced, ...after];
  return out.length === rows.length && out.every((m, idx) => m === rows[idx]) ? rows : out;
}
