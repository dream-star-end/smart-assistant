/** Read-only polling of an admitted detached Box stdout spool. The caller
 * decides when a complete message is durably committed; this never ACKs SSE,
 * publishes a tool result, cleans remote files or launches a model. */
import type { BoxExecTransport } from "./boxExecTransport.js";
import type { BoxDetachedRunAccess } from "./boxDetachedRunAccess.js";
import { readBoxSpoolChunk } from "./boxSpoolRead.js";
import { BoxSpoolJsonlFramer, type BoxSpoolLine } from "./boxSpoolJsonlFramer.js";

export class BoxSpoolPollError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxSpoolPollError"; }
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
}): AsyncGenerator<BoxSpoolLine> {
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1
    || input.deadlineMs > 900_000) throw new BoxSpoolPollError("BOX_SPOOL_POLL_BUDGET_INVALID");
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
        throw error;
      }
      const lines = framer.push(chunk.bytes, offset);
      offset = chunk.nextOffset;
      for (const line of lines) {
        if (abort.signal.aborted) throw new BoxSpoolPollError(expired
          ? "BOX_SPOOL_POLL_TIMEOUT" : "BOX_SPOOL_POLL_ABORTED");
        yield line;
      }
      if (chunk.bytes.length === 0) await pause(interval, abort.signal);
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    abort.abort();
  }
}
