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

const STREAM_GEN_RADIX = 2 ** 10;
const SEQ_RADIX = 2 ** 40;
const BAND_RADIX = 2 ** 51;

export function packEpoch(
  band: EpochBand,
  streamGen: number,
  seq: number,
  exactBit: 0 | 1,
): number {
  if (!Number.isInteger(band) || band < 0 || band > 2) {
    throw new Error("lifecycle_epoch_band");
  }
  if (!Number.isInteger(streamGen) || streamGen < 0) {
    throw new Error("lifecycle_epoch_stream_gen");
  }
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error("lifecycle_epoch_seq");
  }
  if (exactBit !== 0 && exactBit !== 1) {
    throw new Error("lifecycle_epoch_exact_bit");
  }
  if (streamGen >= STREAM_GEN_RADIX) {
    throw new Error("lifecycle_stream_generation_overflow");
  }
  if (seq >= SEQ_RADIX) {
    throw new Error("lifecycle_epoch_seq_overflow");
  }
  const e = band * BAND_RADIX + streamGen * (2 ** 41) + seq * 2 + exactBit;
  if (!Number.isSafeInteger(e)) throw new Error("lifecycle_epoch_overflow");
  return e;
}

export function unpackEpoch(epoch: number): {
  band: EpochBand;
  streamGen: number;
  seq: number;
  exactBit: 0 | 1;
} {
  const exactBit = (Math.abs(epoch) % 2 === 1 ? 1 : 0) as 0 | 1;
  const withoutExact = Math.floor(epoch / 2);
  const seq = withoutExact % SEQ_RADIX;
  const rest = Math.floor(withoutExact / SEQ_RADIX);
  const streamGen = rest % STREAM_GEN_RADIX;
  const band = Math.floor(rest / STREAM_GEN_RADIX) as EpochBand;
  return { band, streamGen, seq, exactBit };
}

/** Tape seq packing: historyRevision in the high 24 bits, ordinal in the low 16. */
export function packTapeSeq(historyRevision: number, ordinal: number): number {
  const rev = Math.max(0, Math.trunc(historyRevision)) % 0x1000000;
  const ord = Math.max(0, Math.trunc(ordinal)) % 0x10000;
  return rev * 0x10000 + ord;
}

export function timelineIdentity(
  owner: string,
  role: string,
  processKey: string,
): string {
  return `${owner}\0${role}\0${processKey}`;
}

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
  if (max >= STREAM_GEN_RADIX) {
    throw new Error("lifecycle_stream_generation_overflow");
  }
  return max;
}

/** `dispatch:<uuid>:<attempt>` attempt_no is 1-based; generation is 0-based. */
export function streamGenerationFromStreamKey(streamKey: string): number {
  const match = /^dispatch:[0-9a-f-]+:(\d+)$/i.exec(streamKey);
  if (!match) return 0;
  const attempt = Number(match[1]);
  if (!Number.isSafeInteger(attempt) || attempt < 1) return 0;
  if (attempt - 1 >= STREAM_GEN_RADIX) {
    throw new Error("lifecycle_stream_generation_overflow");
  }
  return attempt - 1;
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
  _timelineLogicalOrdinal?: number;
  _clientMessageId?: string;
  _turnOwnerId?: string;
};

export type LiveProcessIdentitySeed = {
  kind: string;
  clientMessageId?: string | null;
  timelineProcessKey?: string;
  messageId?: string;
  blockId?: string;
  runId?: string;
  jobId?: string;
  seqFirst: number;
};

function liveKindForRole(role: string): string {
  if (role === "agent-group") return "agent_group";
  if (role === "assistant") return "text";
  return role;
}

/**
 * Copy a live-minted processKey onto a tape row. Aligns by engine key first,
 * then by same-owner+role ordinal (thinking A/B sharing messageId).
 */
export function copyProcessKeyFromLiveUnits(
  liveUnits: readonly LiveProcessIdentitySeed[],
  record: EngineIdentityFields,
  sameRoleOrdinalIndex: number,
): string | undefined {
  const owner = record._turnOwnerId || record._clientMessageId || "";
  const role = record.role ?? "";
  const kind = liveKindForRole(role);
  const candidates = liveUnits
    .filter((unit) => (unit.clientMessageId || "") === owner && unit.kind === kind)
    .slice()
    .sort((a, b) => a.seqFirst - b.seqFirst);
  if (role === "tool" && record.blockId) {
    const hit = candidates.find((unit) => unit.blockId === record.blockId);
    if (typeof hit?.timelineProcessKey === "string") return hit.timelineProcessKey;
  }
  if (role === "agent-group" || role === "delegate-progress") {
    const runId = record.runId || record._delegateRunId || record.jobId;
    if (runId) {
      const hit = candidates.find((unit) => unit.runId === runId || unit.jobId === runId);
      if (typeof hit?.timelineProcessKey === "string") return hit.timelineProcessKey;
    }
  }
  if (role === "plan" && record.blockId) {
    const hit = candidates.find((unit) => unit.blockId === record.blockId);
    if (typeof hit?.timelineProcessKey === "string") return hit.timelineProcessKey;
  }
  const byIndex = candidates[sameRoleOrdinalIndex];
  if (typeof byIndex?.timelineProcessKey === "string") return byIndex.timelineProcessKey;
  return undefined;
}

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
  logicalIndex?: number,
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
  const logical = logicalIndex ?? record._timelineLogicalOrdinal;
  if (typeof logical === "number" && Number.isInteger(logical) && logical >= 0) {
    return `legacy:${tapeId}:${ordinal}:${logical}`;
  }
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
