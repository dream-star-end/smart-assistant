/** Operator-only closure of a synthetic paid probe whose old keeper omitted
 * terminal.json. This does NOT create keeper proof, settle usage, clean remote
 * private files, or permit replay of the original business call. */
export interface UnknownObservationSnapshot {
  readonly observedAtMs: number;
  readonly runNonce: string;
  readonly lockSha256: string;
  readonly stdoutSha256: string;
  readonly stdoutBytes: number;
  readonly runAgeSec: number;
}

function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BOX_UNKNOWN_QUARANTINE_EVIDENCE_INVALID");
  }
  return value as Record<string, unknown>;
}
function natural(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function assessUnknownProbeQuarantine(input: {
  observed: unknown;
  runNonce: string;
  lockSha256: string;
  nowMs: number;
  previous?: UnknownObservationSnapshot;
}): { ready: boolean; snapshot: UnknownObservationSnapshot } {
  const o = obj(input.observed), run = obj(o.run), proof = obj(o.proof),
    terminal = obj(o.terminal), entries = obj(o.runEntries),
    stream = obj(o.stream), processes = obj(o.processes);
  if (!/^[a-f0-9]{24}$/.test(input.runNonce)
    || !/^[a-f0-9]{64}$/.test(input.lockSha256)
    || !natural(input.nowMs) || input.nowMs < 1_700_000_000_000
    || run.present !== true || run.kind !== "dir" || run.mode !== 0o700
    || !natural(run.ageSec) || run.ageSec < 120
    || proof.present !== true || proof.kind !== "dir" || proof.mode !== 0o700
    || terminal.present !== false
    || entries.present !== true || !natural(entries.count)
    || entries.pendingCount !== 0 || entries.resultCount !== 0
    || entries.unexpectedCount !== 0
    || stream.present !== true || !natural(stream.stdoutBytes)
    || stream.stdoutBytes < 1 || stream.stdoutBytes > 2 * 1024 * 1024
    || stream.stderrBytes !== 0
    || typeof stream.stdoutSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(stream.stdoutSha256)
    || stream.partialLine !== false || stream.truncated !== false
    || stream.resultCount !== 1 || stream.lastType !== "result"
    || stream.lastResultSubtype !== "success"
    || stream.lastResultIsError !== true
    || stream.invalidCount !== 0 || stream.unrecognizedCount !== 0
    || stream.toolUseCount !== 0 || stream.toolResultCount !== 0
    || !Array.isArray(processes.matches) || processes.matches.length !== 0
    || !Array.isArray(processes.claudeLike)
    || !natural(processes.claudeLikeCount)
    || processes.claudeLikeCount !== processes.claudeLike.length
    || processes.claudeLikeCount >= 16
    || !natural(processes.scanned) || processes.scanned > 4096
    || !natural(processes.unreadableYoung) || processes.unreadableYoung !== 0
    || processes.cmdlineTruncated !== false || processes.fdTruncated !== false
    || processes.claudeLike.some((raw: unknown) => {
      const item = obj(raw);
      return !natural(item.ageSec) || item.ageSec <= Number(run.ageSec) + 60;
    })) {
    throw new Error("BOX_UNKNOWN_QUARANTINE_EVIDENCE_INVALID");
  }
  const snapshot: UnknownObservationSnapshot = {
    observedAtMs: input.nowMs, runNonce: input.runNonce,
    lockSha256: input.lockSha256,
    stdoutSha256: stream.stdoutSha256, stdoutBytes: stream.stdoutBytes,
    runAgeSec: run.ageSec,
  };
  const prior = input.previous;
  if (!prior) return { ready: false, snapshot };
  if (prior.runNonce !== snapshot.runNonce
    || prior.lockSha256 !== snapshot.lockSha256
    || prior.stdoutSha256 !== snapshot.stdoutSha256
    || prior.stdoutBytes !== snapshot.stdoutBytes
    || !natural(prior.observedAtMs)
    || snapshot.observedAtMs - prior.observedAtMs < 60_000
    || !natural(prior.runAgeSec)
    || snapshot.runAgeSec < prior.runAgeSec + 55) {
    throw new Error("BOX_UNKNOWN_QUARANTINE_OBSERVATION_CHANGED");
  }
  return { ready: true, snapshot };
}
