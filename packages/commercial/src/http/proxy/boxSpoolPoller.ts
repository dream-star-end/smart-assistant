/** Read-only polling of an admitted detached Box stdout spool. The caller
 * decides when a complete message is durably committed; this never ACKs SSE,
 * publishes a tool result, cleans remote files or launches a model. */
import { BoxExecTransportError, type BoxExecTransport } from "./boxExecTransport.js";
import type { BoxDetachedRunAccess } from "./boxDetachedRunAccess.js";
import { readBoxSpoolChunk } from "./boxSpoolRead.js";
import { BoxSpoolJsonlFramer, type BoxSpoolLine } from "./boxSpoolJsonlFramer.js";
import { BOX_TOOL_MAX_WALL_MS } from "./boxToolCapacity.js";

export class BoxSpoolPollError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxSpoolPollError"; }
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
}): AsyncGenerator<BoxSpoolLine> {
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1
    || input.deadlineMs > BOX_TOOL_MAX_WALL_MS) {
    throw new BoxSpoolPollError("BOX_SPOOL_POLL_BUDGET_INVALID");
  }
  const interval = input.pollIntervalMs ?? 100;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 1000) {
    throw new BoxSpoolPollError("BOX_SPOOL_POLL_INTERVAL_INVALID");
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
        if (!isTransientBoxSpoolReadError(error) || failures >= retryDelays.length) throw error;
        try { await pause(retryDelays[failures++]!, abort.signal); }
        catch {
          throw new BoxSpoolPollError(expired ? "BOX_SPOOL_POLL_TIMEOUT" : "BOX_SPOOL_POLL_ABORTED");
        }
        continue;
      }
      failures = 0;
      const lines = framer.push(chunk.bytes, offset);
      offset = chunk.nextOffset;
      for (const line of lines) {
        if (abort.signal.aborted) throw new BoxSpoolPollError(expired
          ? "BOX_SPOOL_POLL_TIMEOUT" : "BOX_SPOOL_POLL_ABORTED");
        yield line;
      }
      if (chunk.bytes.length === 0) {
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
