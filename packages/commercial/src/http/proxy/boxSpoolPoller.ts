/** Read-only polling of an admitted detached Box stdout spool. The caller
 * decides when a complete message is durably committed; this never ACKs SSE,
 * publishes a tool result, cleans remote files or launches a model. */
import { BoxExecTransportError, type BoxExecTransport } from "./boxExecTransport.js";
import type { BoxDetachedRunAccess } from "./boxDetachedRunAccess.js";
import { readBoxSpoolChunk } from "./boxSpoolRead.js";
import { BoxSpoolJsonlFramer, type BoxSpoolLine } from "./boxSpoolJsonlFramer.js";
import { BOX_TOOL_MAX_WALL_MS } from "./boxToolCapacity.js";
import { readBoxTerminalProof, type BoxTerminalProof } from "./boxTerminalProof.js";

export class BoxSpoolPollError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxSpoolPollError"; }
}

/** Strictly proven remote stop, never evidence of delivered content or usage. */
export class BoxSpoolTerminalError extends Error {
  readonly code: "BOX_SPOOL_WORKER_FAILED" | "BOX_SPOOL_KEEPER_STOPPED"
    | "BOX_SPOOL_TERMINAL_INCOMPLETE";
  readonly proof: BoxTerminalProof;
  readonly accountId: bigint;
  constructor(input: { proof: BoxTerminalProof; accountId: bigint; cause?: unknown }) {
    const code = input.proof.reason === "worker_failed" ? "BOX_SPOOL_WORKER_FAILED"
      : input.proof.reason === "keeper_stopped" ? "BOX_SPOOL_KEEPER_STOPPED"
        : "BOX_SPOOL_TERMINAL_INCOMPLETE";
    super(code, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "BoxSpoolTerminalError";
    this.code = code;
    this.proof = input.proof;
    this.accountId = input.accountId;
  }
}

export interface BoxSpoolPolledLine extends BoxSpoolLine {
  /** A stopped writer cannot accept another tool handoff. Only a complete
   * final may still pass the caller's original worker_complete proof path. */
  readonly terminalProof?: BoxTerminalProof;
}

/** Missing, unreadable or malformed proof is unknown. Configuration/account
 * guard/auth failures remain loud rather than becoming indefinite polling. */
function unknownTerminalRead(error: unknown): boolean {
  return isTransientBoxSpoolReadError(error)
    || error instanceof BoxExecTransportError && error.code === "BOX_EXEC_REMOTE_EXIT"
    || error instanceof Error && error.message === "BOX_TERMINAL_PROOF_INVALID";
}

// OCV5-306: one dropped HTTPS exchange to the Box exec endpoint used to end a
// whole multi-round turn as continuation_unknown. A spool read only re-reads
// bytes at an unchanged offset, so only transport-level ambiguity is retried;
// account guard, remote exit, auth and frame errors still fail at once.
const TRANSIENT_READ_CODES = new Set(["BOX_EXEC_TRANSPORT_UNKNOWN",
  "BOX_EXEC_STREAM_UNKNOWN", "BOX_EXEC_INCOMPLETE", "BOX_EXEC_TIMEOUT",
  "BOX_EXEC_HTTP_429", "BOX_EXEC_HTTP_502", "BOX_EXEC_HTTP_503", "BOX_EXEC_HTTP_504"]);
export const BOX_SPOOL_READ_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 4000, 4000];

export function isTransientBoxSpoolReadError(error: unknown): boolean {
  return error instanceof BoxExecTransportError && !error.terminalKnown
    && TRANSIENT_READ_CODES.has(error.code);
}

// OCV5-762 (uid 4, 2026-11-12 19:53:39 / 20:03:40 CST): after minutes of a
// long Box turn Cursor's Exec gateway answered one spool read with HTTP 417
// and the whole turn was lost; its run then held the session's slot
// (BOX_CAPACITY_HELD, BOX_RESUME_IN_PROGRESS). The transport now refreshes its
// descriptor before the next call, so a read at the unchanged offset is
// retried once on the fresh descriptor. A second 417 with no progress in
// between, or a failed refresh, ends the round as rejected: the caller stops
// the run at once so the next message starts fresh.
const REJECTED_CODES = new Set(["BOX_EXEC_HTTP_417"]);
export const BOX_SPOOL_REJECTED_RETRIES = 1;
export function isBoxExecRefreshRetryable(error: unknown): boolean {
  return error instanceof BoxExecTransportError && !error.terminalKnown
    && REJECTED_CODES.has(error.code);
}
/** The Box run cannot be reached on its descriptor, even after one refresh. */
export function isBoxExecRejectedError(error: unknown): boolean {
  return error instanceof BoxExecTransportError && !error.terminalKnown
    && (REJECTED_CODES.has(error.code) || error.code === "BOX_EXEC_REFRESH_FAILED");
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new BoxSpoolPollError("BOX_SPOOL_POLL_ABORTED");
  await new Promise<void>((resolve, reject) => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", cancelled); };
    const cancelled = (): void => { done(); reject(new BoxSpoolPollError("BOX_SPOOL_POLL_ABORTED")); };
    const timer = setTimeout(() => { done(); resolve(); }, ms);
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
  });
}

export async function* pollBoxSpoolLines(input: {
  exec: Pick<BoxExecTransport, "run">;
  access: Pick<BoxDetachedRunAccess, "readSpool">;
  startOffset: number;
  deadlineMs: number;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  retryDelaysMs?: readonly number[];
  terminal?: { accountId: bigint; expectedAccountId: bigint;
    runNonce: string; leaseEpoch: string };
  terminalProbeIntervalMs?: number;
}): AsyncGenerator<BoxSpoolPolledLine> {
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1
    || input.deadlineMs > BOX_TOOL_MAX_WALL_MS) {
    throw new BoxSpoolPollError("BOX_SPOOL_POLL_BUDGET_INVALID");
  }
  const interval = input.pollIntervalMs ?? 100;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 1000) {
    throw new BoxSpoolPollError("BOX_SPOOL_POLL_INTERVAL_INVALID");
  }
  const probeInterval = input.terminalProbeIntervalMs ?? 1000;
  if (!Number.isSafeInteger(probeInterval) || probeInterval < 1 || probeInterval > 60_000) {
    throw new BoxSpoolPollError("BOX_SPOOL_TERMINAL_INTERVAL_INVALID");
  }
  const terminal = input.terminal;
  if (terminal && (terminal.accountId <= 0n
    || terminal.accountId !== terminal.expectedAccountId
    || !/^[a-f0-9]{24}$/.test(terminal.runNonce)
    || !/^[a-f0-9]{32}$/.test(terminal.leaseEpoch))) {
    throw new BoxSpoolPollError("BOX_TERMINAL_IDENTITY_INVALID");
  }
  const framer = new BoxSpoolJsonlFramer(input.startOffset);
  const abort = new AbortController();
  const onAbort = (): void => abort.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) abort.abort();
  let expired = false;
  const timer = setTimeout(() => { expired = true; abort.abort(); }, input.deadlineMs);
  let offset = input.startOffset;
  const retryDelays = input.retryDelaysMs ?? BOX_SPOOL_READ_RETRY_DELAYS_MS;
  let failures = 0;
  /** OCV5-762: 417 retries since the last read that made progress. */
  let rejected = 0;
  let terminalProof: BoxTerminalProof | undefined;
  let nextProbeAt = 0;
  const checkAbort = (): void => {
    if (abort.signal.aborted) throw new BoxSpoolPollError(expired
      ? "BOX_SPOOL_POLL_TIMEOUT" : "BOX_SPOOL_POLL_ABORTED");
  };
  try {
    while (true) {
      if (abort.signal.aborted) throw new BoxSpoolPollError(expired
        ? "BOX_SPOOL_POLL_TIMEOUT" : "BOX_SPOOL_POLL_ABORTED");
      let chunk;
      try { chunk = await readBoxSpoolChunk({ exec: input.exec, plan: input.access,
        offset, signal: abort.signal }); }
      catch (error) {
        if (abort.signal.aborted) throw new BoxSpoolPollError(expired
          ? "BOX_SPOOL_POLL_TIMEOUT" : "BOX_SPOOL_POLL_ABORTED");
        if (isBoxExecRefreshRetryable(error)) {
          if (rejected >= BOX_SPOOL_REJECTED_RETRIES) throw error;
          rejected++;
          try { await pause(retryDelays[0] ?? 250, abort.signal); }
          catch {
            throw new BoxSpoolPollError(expired ? "BOX_SPOOL_POLL_TIMEOUT" : "BOX_SPOOL_POLL_ABORTED");
          }
          continue;
        }
        if (!isTransientBoxSpoolReadError(error) || failures >= retryDelays.length) throw error;
        try { await pause(retryDelays[failures++]!, abort.signal); }
        catch {
          throw new BoxSpoolPollError(expired ? "BOX_SPOOL_POLL_TIMEOUT" : "BOX_SPOOL_POLL_ABORTED");
        }
        continue;
      }
      checkAbort();
      failures = 0;
      if (chunk.bytes.length > 0) rejected = 0;
      const lines = framer.push(chunk.bytes, offset);
      offset = chunk.nextOffset;
      for (const line of lines) {
        if (abort.signal.aborted) throw new BoxSpoolPollError(expired
          ? "BOX_SPOOL_POLL_TIMEOUT" : "BOX_SPOOL_POLL_ABORTED");
        yield terminalProof ? { ...line, terminalProof } : line;
      }
      if (chunk.bytes.length === 0) {
        if (terminalProof && terminal) {
          throw new BoxSpoolTerminalError({ proof: terminalProof,
            accountId: terminal.accountId });
        }
        if (terminal && Date.now() >= nextProbeAt) {
          nextProbeAt = Date.now() + probeInterval;
          try {
            terminalProof = await readBoxTerminalProof({
              target: { accountId: terminal.accountId, exec: input.exec },
              expectedAccountId: terminal.expectedAccountId,
              runNonce: terminal.runNonce, leaseEpoch: terminal.leaseEpoch,
              signal: abort.signal });
            rejected = 0;
          } catch (error) {
            checkAbort();
            if (isBoxExecRefreshRetryable(error)) {
              // The next read (spool or proof) goes out on a refreshed descriptor.
              if (rejected >= BOX_SPOOL_REJECTED_RETRIES) throw error;
              rejected++;
            } else if (!unknownTerminalRead(error)) throw error;
          }
          checkAbort();
          // The writer can append its final between the empty read and the
          // proof. Re-read this exact offset after proof, draining complete
          // lines before declaring an undeliverable terminal stream.
          if (terminalProof) continue;
        }
        try { await pause(interval, abort.signal); }
        catch (error) {
          if (abort.signal.aborted) throw new BoxSpoolPollError(expired
            ? "BOX_SPOOL_POLL_TIMEOUT" : "BOX_SPOOL_POLL_ABORTED");
          throw error;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    abort.abort();
  }
}
