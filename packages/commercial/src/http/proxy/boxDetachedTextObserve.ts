/** Shared read-only decoder for a detached no-tool Box text round. A live
 * request may stream nonterminal SSE through emit; a later HTTP request or
 * recovery worker passes a no-op. No paid launch, tool call or settlement. */
import { createBoxCliSseDecoder } from "./boxCliSse.js";
import type { BoxDetachedRunAccess } from "./boxDetachedRunAccess.js";
import { BoxExecTransportError, type BoxExecTransport } from "./boxExecTransport.js";
import { BoxSpoolPollError, isTransientBoxSpoolReadError, pollBoxSpoolLines } from "./boxSpoolPoller.js";
import { readBoxSpoolChunk } from "./boxSpoolRead.js";
import { readBoxTerminalProof, type BoxTerminalProof } from "./boxTerminalProof.js";

export class BoxDetachedTextObserveError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxDetachedTextObserveError"; }
}

export async function observeBoxDetachedText(input: {
  target: { accountId: bigint; exec: Pick<BoxExecTransport, "run"> };
  access: Pick<BoxDetachedRunAccess, "readSpool">;
  expectedModel: string;
  trustedNativeSessionId?: string;
  runNonce: string; leaseEpoch: string;
  signal?: AbortSignal; deadlineMs: number;
  emit?: (sse: string) => void;
}): Promise<{ proof: BoxTerminalProof; usage: { inputTokens: number;
  outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  message: unknown; tailSse: string }> {
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1
    || input.deadlineMs > 900_000) {
    throw new BoxDetachedTextObserveError("BOX_TEXT_OBSERVE_BUDGET_INVALID");
  }
  const abort = new AbortController();
  const onAbort = (): void => abort.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) abort.abort();
  const deadlineAt = Date.now() + input.deadlineMs;
  const timer = setTimeout(() => abort.abort(), input.deadlineMs);
  const decoder = createBoxCliSseDecoder(input.expectedModel, input.trustedNativeSessionId);
  try {
  for await (const line of pollBoxSpoolLines({ exec: input.target.exec,
    access: input.access, startOffset: 0, deadlineMs: input.deadlineMs,
    signal: abort.signal })) {
    const partial = decoder.push(line.text);
    if (partial) input.emit?.(partial);
    let record: unknown;
    try { record = JSON.parse(line.text); }
    catch { throw new BoxDetachedTextObserveError("BOX_TEXT_SPOOL_RECORD_INVALID"); }
    if (!record || typeof record !== "object" || Array.isArray(record)
      || (record as { type?: unknown }).type !== "result") continue;
    let proof: BoxTerminalProof | null = null;
    const until = Math.min(Date.now() + 10_000, deadlineAt);
    while (!proof && Date.now() < until && !abort.signal.aborted) {
      try { proof = await readBoxTerminalProof({ target: input.target,
        expectedAccountId: input.target.accountId,
        runNonce: input.runNonce, leaseEpoch: input.leaseEpoch,
        signal: abort.signal }); }
      catch (error) {
        if ((error instanceof BoxExecTransportError && error.terminalKnown)
          || isTransientBoxSpoolReadError(error)) {
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        } else if (error instanceof BoxExecTransportError) {
          throw new BoxDetachedTextObserveError("BOX_TEXT_TERMINAL_UNKNOWN");
        } else {
          throw new BoxDetachedTextObserveError("BOX_TEXT_TERMINAL_INVALID");
        }
      }
    }
    if (!proof) {
      throw new BoxDetachedTextObserveError("BOX_TEXT_TERMINAL_UNPROVEN");
    }
    if (proof.reason !== "worker_complete") {
      throw new BoxDetachedTextObserveError(proof.reason === "keeper_stopped"
        ? "BOX_TEXT_TERMINAL_STOPPED" : "BOX_TEXT_TERMINAL_FAILED");
    }
    const trailing = await readBoxSpoolChunk({ exec: input.target.exec,
      plan: input.access, offset: line.endOffset, signal: abort.signal });
    if (trailing.bytes.length !== 0) {
      throw new BoxDetachedTextObserveError("BOX_TEXT_FINAL_TRAILING_BYTES");
    }
    const converted = decoder.finish();
    return { proof, usage: { inputTokens: converted.inputTokens,
      outputTokens: converted.outputTokens,
      cacheReadTokens: converted.cacheReadTokens,
      cacheWriteTokens: converted.cacheWriteTokens },
    message: decoder.completedMessage(), tailSse: converted.tailSse };
  }
  throw new BoxDetachedTextObserveError("BOX_TEXT_SPOOL_INCOMPLETE");
  } catch (error) {
    if (error instanceof BoxSpoolPollError) {
      throw new BoxDetachedTextObserveError(error.code === "BOX_SPOOL_POLL_ABORTED"
        ? "BOX_TEXT_OBSERVE_ABORTED" : error.code === "BOX_SPOOL_POLL_TIMEOUT"
          ? "BOX_TEXT_OBSERVE_TIMEOUT" : "BOX_TEXT_SPOOL_INVALID");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    abort.abort();
  }
}
