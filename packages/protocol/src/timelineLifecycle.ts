/**
 * Display-layer timeline lifecycle stamps (OCV5-21 P0).
 *
 * Server is the authority. `_lifecycleEpoch` is a packed safe-int:
 * [band:2][streamGen:10][seq:40][exactBit:1]. `LIVE_UNITS_REDUCER_EPOCH`
 * is a protocol reducer version string and must never enter this packing.
 */

export type TimelineLifecycle =
  | "optimistic_local"
  | "live_open"
  | "live_closed"
  | "phase_a"
  | "exact_deferred"
  | "exact_displayable"
  | "retired";

export type EpochBand = 0 | 1 | 2; // OPTIMISTIC | LIVE | TAPE

export const EPOCH_BAND = {
  OPTIMISTIC: 0 as EpochBand,
  LIVE: 1 as EpochBand,
  TAPE: 2 as EpochBand,
};

export type TimelineStamp = {
  _lifecycle: TimelineLifecycle;
  _lifecycleEpoch: number;
  _timelineIdentity: string;
  _timelineProcessKey: string;
  _timelineStreamGen?: number;
  _timelineUnitKey?: string;
};

const STREAM_GEN_MASK = 0x3ff;
const SEQ_MASK = 0xffffffffff;

export function packEpoch(
  band: EpochBand,
  streamGen: number,
  seq: number,
  exactBit: 0 | 1,
): number {
  const e =
    band * 2 ** 51 +
    (streamGen & STREAM_GEN_MASK) * 2 ** 41 +
    (seq & SEQ_MASK) * 2 +
    exactBit;
  if (!Number.isSafeInteger(e)) throw new Error("lifecycle_epoch_overflow");
  return e;
}

export function unpackEpoch(epoch: number): {
  band: EpochBand;
  streamGen: number;
  seq: number;
  exactBit: 0 | 1;
} {
  const exactBit = (epoch & 1) as 0 | 1;
  const seq = Math.floor(epoch / 2) & SEQ_MASK;
  const streamGen = Math.floor(epoch / 2 ** 41) & STREAM_GEN_MASK;
  const band = Math.floor(epoch / 2 ** 51) as EpochBand;
  return { band, streamGen, seq, exactBit };
}

/** Tape seq packing: historyRevision in the high 24 bits, ordinal in the low 16. */
export function packTapeSeq(historyRevision: number, ordinal: number): number {
  const rev = Math.max(0, historyRevision | 0) & 0xffffff;
  const ord = Math.max(0, ordinal | 0) & 0xffff;
  // Avoid 32-bit `<<` overflow once historyRevision exceeds 15 bits.
  return rev * 0x10000 + ord;
}

export function timelineIdentity(
  owner: string,
  role: string,
  processKey: string,
): string {
  return `${owner}\0${role}\0${processKey}`;
}

const STREAM_GEN_MAX = 0x3ff;

/**
 * Map a session's stream_key lineage onto packEpoch streamGen.
 *
 * `orderedStreamKeys` is first-seen order (created_at, stream_key). The
 * generation of the current open stream(s) is the 0-based index in that
 * lineage so a later stream_key (sessionKey reuse / new dispatch) beats an
 * older generation even when frameSeq restarts at 1.
 */
export function streamGenerationFromLineage(
  orderedStreamKeys: readonly string[],
  currentStreamKeys: readonly string[] = [],
): number {
  const lineage: string[] = [];
  for (const key of orderedStreamKeys) {
    if (typeof key === "string" && key.length > 0 && !lineage.includes(key)) {
      lineage.push(key);
    }
  }
  const currents = currentStreamKeys.filter((key) => typeof key === "string" && key.length > 0);
  const pool = currents.length > 0 ? currents : lineage.slice(-1);
  let max = 0;
  for (const key of pool) {
    const idx = lineage.indexOf(key);
    const gen = idx >= 0 ? idx : Math.max(0, lineage.length);
    if (gen > max) max = gen;
  }
  return Math.min(STREAM_GEN_MAX, max);
}

/** `dispatch:<uuid>:<attempt>` attempt_no is 1-based; generation is 0-based. */
export function streamGenerationFromStreamKey(streamKey: string): number {
  const match = /^dispatch:[0-9a-f-]+:(\d+)$/i.exec(streamKey);
  if (!match) return 0;
  const attempt = Number(match[1]);
  if (!Number.isSafeInteger(attempt) || attempt < 1) return 0;
  return Math.min(STREAM_GEN_MAX, attempt - 1);
}

export type LiveProcessKeySeed = {
  kind: "thinking" | "text" | "tool" | "plan" | "agent_group";
  seqFirst: number;
  recordIdFirst?: string;
  messageId?: string;
  blockId?: string;
  runId?: string;
  jobId?: string;
  /** 0-based count of already-stamped units of this kind under the same owner. */
  segmentIndex: number;
  /** How many prior units already used this messageId for the same kind. */
  messageIdIndex?: number;
};

/**
 * Mint a stable processKey for a newly created live unit. Empty string is
 * allowed only for the narrative assistant/text slot (first text unit).
 */
export function mintLiveProcessKey(seed: LiveProcessKeySeed): string {
  switch (seed.kind) {
    case "thinking": {
      if (seed.messageId) {
        if ((seed.messageIdIndex ?? seed.segmentIndex) === 0) {
          return `msg:${seed.messageId}`;
        }
        return `msg:${seed.messageId}:seg:${seed.segmentIndex}`;
      }
      return `seg:${seed.seqFirst}:${seed.recordIdFirst ?? "norec"}`;
    }
    case "text": {
      if (seed.segmentIndex === 0) return "";
      if (seed.messageId) return `msg:${seed.messageId}:seg:${seed.segmentIndex}`;
      return `seg:${seed.seqFirst}:${seed.recordIdFirst ?? "norec"}`;
    }
    case "plan":
      return seed.blockId || `plan:${seed.seqFirst}`;
    case "tool":
      return seed.blockId || `tool:${seed.seqFirst}`;
    case "agent_group":
      return seed.runId || seed.jobId || `agent-group:${seed.seqFirst}`;
    default:
      return `legacy:${seed.seqFirst}`;
  }
}

export type EngineIdentityFields = {
  role?: string;
  messageId?: string;
  blockId?: string;
  runId?: string;
  jobId?: string;
  requestId?: string;
  _delegateRunId?: string;
  _timelineProcessKey?: string;
  _turnTapeId?: string;
  _turnTapeOrdinal?: number;
  _recordOrdinal?: number;
};

/**
 * Rebuild processKey from engine fields already on a tape/live row.
 * Never invents a live-matching key when the engine fields are missing —
 * fail-closed `legacy:${tapeId}:${ordinal}` so a mismatch becomes a duplicate
 * rather than a swallowed live row.
 */
export function deriveProcessKeyFromRecord(
  record: EngineIdentityFields,
  fallbackTapeId?: string,
  fallbackOrdinal?: number,
): string {
  if (typeof record._timelineProcessKey === "string") {
    return record._timelineProcessKey;
  }
  const role = record.role ?? "";
  if (role === "thinking") {
    if (record.messageId) return `msg:${record.messageId}`;
  } else if (role === "assistant") {
    return "";
  } else if (role === "plan") {
    if (record.blockId) return record.blockId;
  } else if (role === "tool") {
    if (record.blockId) return record.blockId;
  } else if (role === "agent-group") {
    const runId = record.runId || record._delegateRunId;
    if (runId) return runId;
  } else if (role === "delegate-progress") {
    const runId = record.runId || record.jobId || record._delegateRunId;
    if (runId) return runId;
  } else if (role === "runtime-event") {
    if (record.jobId) return record.jobId;
  } else if (role === "permission") {
    if (record.requestId) return record.requestId;
  }
  const tapeId = fallbackTapeId || record._turnTapeId || "notape";
  const ordinal =
    fallbackOrdinal ??
    record._recordOrdinal ??
    record._turnTapeOrdinal ??
    0;
  return `legacy:${tapeId}:${ordinal}`;
}

export function applyTimelineStamp<T extends Record<string, unknown>>(
  row: T,
  stamp: TimelineStamp,
): T {
  return {
    ...row,
    _lifecycle: stamp._lifecycle,
    _lifecycleEpoch: stamp._lifecycleEpoch,
    _timelineIdentity: stamp._timelineIdentity,
    _timelineProcessKey: stamp._timelineProcessKey,
    ...(stamp._timelineStreamGen != null
      ? { _timelineStreamGen: stamp._timelineStreamGen }
      : {}),
    ...(stamp._timelineUnitKey
      ? { _timelineUnitKey: stamp._timelineUnitKey }
      : {}),
  };
}
