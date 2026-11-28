/**
 * Per-sessionKey `frameSeq` deduplication cursor + per-row replay fence (§3 / §4 / OCV5-421).
 */
import type { ChatMessage, ChatSession } from "../model";
import { frameSeqKey, getFrameSeqCursor } from "../pure";

let frameSeqAcceptOrder = 0;

export function currentFrameSeqAcceptOrder(): number {
  return frameSeqAcceptOrder;
}

function setFrameSeqCursor(sess: ChatSession, key: string, seq: number): void {
  if (!sess._lastFrameSeqByKey || typeof sess._lastFrameSeqByKey !== "object") {
    sess._lastFrameSeqByKey = {};
  }
  sess._lastFrameSeqByKey[key] = seq;
  sess._lastFrameSeq = Math.max(sess._lastFrameSeq || 0, seq);
  if (seq > 0) {
    if (
      !sess._lastAcceptedFrameSeqOrderByKey ||
      typeof sess._lastAcceptedFrameSeqOrderByKey !== "object"
    ) {
      sess._lastAcceptedFrameSeqOrderByKey = {};
    }
    sess._lastAcceptedFrameSeqOrderByKey[key] = ++frameSeqAcceptOrder;
    sess._lastAcceptedFrameSeqAt = Date.now();
  } else {
    if (sess._lastAcceptedFrameSeqOrderByKey) delete sess._lastAcceptedFrameSeqOrderByKey[key];
    if (
      !sess._lastAcceptedFrameSeqOrderByKey ||
      Object.keys(sess._lastAcceptedFrameSeqOrderByKey).length === 0
    ) {
      sess._lastAcceptedFrameSeqAt = undefined;
    }
  }
}

/** 无 frameSeq>0 直接接受；<=游标 drop；否则严格前进推进游标（乱序不回退）。*/
export function acceptFrameSeq(
  sess: ChatSession,
  frame: { frameSeq?: number; sessionKey?: string },
): boolean {
  const fs = frame.frameSeq;
  if (!(typeof fs === "number" && fs > 0)) return true;
  const key = frameSeqKey(frame, sess.id);
  const last = getFrameSeqCursor(sess._lastFrameSeqByKey, sess._lastFrameSeq, key);
  if (fs <= last) return false;
  setFrameSeqCursor(sess, key, fs);
  return true;
}

/** Advance the cursor when seq is newer; never reject. Permission prompts are
 *  idempotent by requestId and must survive stream reordering; other frame
 *  types keep acceptFrameSeq's drop-on-regression semantics. */
export function noteFrameSeqIfNewer(
  sess: ChatSession,
  frame: { frameSeq?: number; sessionKey?: string },
): void {
  const fs = frame.frameSeq;
  if (!(typeof fs === "number" && fs > 0)) return;
  const key = frameSeqKey(frame, sess.id);
  const last = getFrameSeqCursor(sess._lastFrameSeqByKey, sess._lastFrameSeq, key);
  if (fs > last) setFrameSeqCursor(sess, key, fs);
}

/** 公开给 resume_failed：把游标推到 server currentLast（§4）。只进不退。 */
export function advanceFrameSeqCursorTo(
  sess: ChatSession,
  frame: { sessionKey?: string },
  to: number,
): void {
  const key = frameSeqKey(frame, sess.id);
  const last = getFrameSeqCursor(sess._lastFrameSeqByKey, sess._lastFrameSeq, key);
  if (to > last) setFrameSeqCursor(sess, key, to);
}

/**
 * 容器 ring **重启签名**下的游标归零(resume_failed reason='no_buffer' 且 to===0 专用)。
 */
export function resetFrameSeqCursor(sess: ChatSession, frame: { sessionKey?: string }): void {
  const key = frameSeqKey(frame, sess.id);
  setFrameSeqCursor(sess, key, 0);
}

/**
 * 冷启(sys.cold_start = bridge provision 分支 = **全新容器**)下,把该会话全部 agent-scoped
 * 游标归零。
 */
export function resetAgentFrameSeqCursorsForSession(
  sess: ChatSession,
  opts?: { keepAcceptedAfterOrder?: number; excludeKey?: string; onResetKey?: (key: string) => void },
): void {
  const byKey = sess._lastFrameSeqByKey;
  if (byKey && typeof byKey === "object") {
    const safeId = String(sess.id).replace(/[^a-zA-Z0-9_-]/g, "_");
    const suffix = `:webchat:dm:${safeId}`;
    for (const key of Object.keys(byKey)) {
      if (!key.startsWith("agent:") || !key.endsWith(suffix)) continue;
      if (key === opts?.excludeKey) continue;
      if (
        typeof opts?.keepAcceptedAfterOrder === "number" &&
        (sess._lastAcceptedFrameSeqOrderByKey?.[key] ?? 0) > opts.keepAcceptedAfterOrder
      ) {
        continue;
      }
      opts?.onResetKey?.(key);
      delete byKey[key];
      if (sess._lastAcceptedFrameSeqOrderByKey) delete sess._lastAcceptedFrameSeqOrderByKey[key];
    }
  }
  if (
    !sess._lastAcceptedFrameSeqOrderByKey ||
    Object.keys(sess._lastAcceptedFrameSeqOrderByKey).length === 0
  ) {
    sess._lastAcceptedFrameSeqAt = undefined;
  }
}

/** Unified timeline rows are historical evidence, not live UI state. */
export function isImmutableTapeViewportRow(message: ChatMessage): boolean {
  return (
    message._timelineRecord === true ||
    (typeof message._turnTapeProcessLoadedFrom === "string" &&
      message._turnTapeProcessLoadedFrom.length > 0)
  );
}

/** Only proven-terminal tape/timeline rows are frozen. */
export function isFrozenLiveTarget(message: ChatMessage): boolean {
  if (isImmutableTapeViewportRow(message)) return true;
  return message._turnTapeComplete === true;
}

export function frameSeqAlreadyApplied(message: ChatMessage, frameSeq?: number): boolean {
  if (!(typeof frameSeq === "number" && Number.isSafeInteger(frameSeq) && frameSeq > 0)) {
    return false;
  }
  if (message._appliedFrameSeqs?.[frameSeq] === true) return true;
  const ranges = message._appliedFrameSeqRanges;
  if (!ranges) return false;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [from, to] = ranges[mid];
    if (frameSeq < from) hi = mid - 1;
    else if (frameSeq > to) lo = mid + 1;
    else return true;
  }
  return false;
}

const APPLIED_FRAME_SEQ_KEEP = 512;

function foldFrameSeqRanges(
  ranges: ReadonlyArray<readonly [number, number]>,
  seqs: number[],
): Array<[number, number]> {
  const all: Array<[number, number]> = ranges.map(([from, to]) => [from, to]);
  for (const seq of seqs) all.push([seq, seq]);
  all.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [from, to] of all) {
    const last = out[out.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}

export function noteAppliedFrameSeq(message: ChatMessage, frameSeq?: number): void {
  if (!(typeof frameSeq === "number" && Number.isSafeInteger(frameSeq) && frameSeq > 0)) return;
  if (!message._appliedFrameSeqs) message._appliedFrameSeqs = {};
  message._appliedFrameSeqs[frameSeq] = true;
  const keys = Object.keys(message._appliedFrameSeqs);
  if (keys.length > APPLIED_FRAME_SEQ_KEEP * 2) {
    const cut = keys.length - APPLIED_FRAME_SEQ_KEEP;
    message._appliedFrameSeqRanges = foldFrameSeqRanges(
      message._appliedFrameSeqRanges ?? [],
      keys.slice(0, cut).map(Number),
    );
    const kept: Record<number, true> = {};
    for (const key of keys.slice(cut)) kept[Number(key)] = true;
    message._appliedFrameSeqs = kept;
  }
}
