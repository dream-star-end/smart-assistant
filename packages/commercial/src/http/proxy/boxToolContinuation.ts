/** Resume the same detached CLI after OpenClaude-local tool results publish.
 * Delivers either the next durable tool handoff or a remotely-proven final
 * message. The caller retains the Box target until terminal cleanup. */
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { BoxCliToolHandoffDecoder } from "./boxCliToolHandoff.js";
import { BoxExecTransportError } from "./boxExecTransport.js";
import type { BoxDurableJournal } from "./boxDurableJournal.js";
import { makeBoxPendingRead, parseBoxPendingCall } from "./boxToolResultPlan.js";
import { BoxToolResultEcho } from "./boxToolResultEcho.js";
import type { BoxToolPublishedResume } from "./boxToolResumePublish.js";
import { pollBoxSpoolLines } from "./boxSpoolPoller.js";
import { readBoxSpoolChunk } from "./boxSpoolRead.js";
import { readBoxTerminalProof, type BoxTerminalProof } from "./boxTerminalProof.js";
import { deriveBoxContextHash } from "./boxCallFingerprint.js";
import { makeBoxNativeFileInspect, parseBoxNativeFileEvidence } from "./boxNativeFile.js";
import { parseBoxNativePointer, type BoxNativePointer } from "./boxNativePointer.js";
import type { ProxyBody } from "./shared.js";

export class BoxToolContinuationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxToolContinuationError"; }
}
export type BoxToolContinuationResult =
  | { kind: "tool_handoff"; spoolOffset: number }
  | { kind: "final"; proof: BoxTerminalProof; nativePointer?: BoxNativePointer };
type Journal = Pick<BoxDurableJournal, "recordToolHandoff" |
  "completeToolChain" | "markUnknown">
  & Partial<Pick<BoxDurableJournal, "attachNativePointer">>;

export async function runBoxToolContinuation(input: {
  published: BoxToolPublishedResume;
  uid: bigint;
  requestId: string;
  canonicalBody: ProxyBody;
  upstreamModel: string;
  signal?: AbortSignal;
  emit: (sse: string) => void;
}, deps: {
  journal: Journal;
  retainUnknownTarget: (handle: { published: BoxToolPublishedResume;
    uid: bigint; requestId: string }) => void;
  onUnknown: (args: { uid: bigint; accountId: bigint; requestId: string;
    phase: string }) => Promise<void>;
  budgetMs?: number;
}): Promise<BoxToolContinuationResult> {
  const { claim, target, access } = input.published;
  const budget = deps.budgetMs ?? 900_000;
  if (!Number.isSafeInteger(budget) || budget < 1000 || budget > 900_000) {
    throw new BoxToolContinuationError("BOX_TOOL_CONTINUATION_BUDGET_INVALID");
  }
  const abort = new AbortController();
  const onAbort = (): void => abort.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) abort.abort();
  const timer = setTimeout(() => abort.abort(), budget);
  const signal = abort.signal;
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new BoxToolContinuationError(
      "BOX_TOOL_CONTINUATION_ABORTED")), { once: true });
  });
  void aborted.catch(() => {});
  const race = <T>(value: Promise<T>): Promise<T> => Promise.race([value, aborted]);
  let unknownNotified = false;
  const unknown = async (phase: string): Promise<void> => {
    if (unknownNotified) return;
    unknownNotified = true;
    deps.retainUnknownTarget({ published: input.published,
      uid: input.uid, requestId: input.requestId });
    const observed = Promise.allSettled([
      deps.journal.markUnknown({ requestId: input.requestId, uid: input.uid,
        leaseEpoch: claim.leaseEpoch, phase }),
      deps.onUnknown({ uid: input.uid, accountId: claim.accountId,
        requestId: input.requestId, phase }),
    ]);
    let wait: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([observed, new Promise<void>((resolve) => {
      wait = setTimeout(resolve, 200);
    })]); }
    finally { if (wait) clearTimeout(wait); }
  };
  try {
    if (signal.aborted) throw new BoxToolContinuationError("BOX_TOOL_CONTINUATION_ABORTED");
    const catalog = compileBoxToolCatalog(input.canonicalBody.tools);
    if (catalog.bindingSha256 !== claim.catalogHash
      || target.accountId !== claim.accountId || claim.roundNo < 2
      || claim.roundNo > 32) {
      throw new BoxToolContinuationError("BOX_TOOL_CONTINUATION_BINDING_INVALID");
    }
    const decoder = new BoxCliToolHandoffDecoder(input.upstreamModel, catalog,
      { alreadyInitialized: true, allowFinal: true });
    const echo = new BoxToolResultEcho(claim.results);
    let modelStarted = false;
    for await (const line of pollBoxSpoolLines({ exec: target.exec, access,
      startOffset: claim.spoolOffset, deadlineMs: budget, signal })) {
      let record: unknown;
      try { record = JSON.parse(line.text); }
      catch { throw new BoxToolContinuationError("BOX_TOOL_CONTINUATION_RECORD_INVALID"); }
      if (record && typeof record === "object" && !Array.isArray(record)
        && (record as { type?: unknown }).type === "user") {
        if (modelStarted) throw new BoxToolContinuationError("BOX_TOOL_ECHO_AFTER_MODEL");
        echo.accept(record);
        continue;
      }
      if (record && typeof record === "object" && !Array.isArray(record)
        && (record as { type?: unknown }).type === "stream_event"
        && (record as { event?: { type?: unknown } }).event?.type === "message_start") {
        echo.assertComplete();
        modelStarted = true;
      }
      const decoded = decoder.push(line.text);
      if (decoded.sse) input.emit(decoded.sse);
      if (decoded.candidate) {
        const candidate = decoded.candidate;
        const pending = new Set<string>();
        const until = Date.now() + 5000;
        while (pending.size === 0 && Date.now() < until && !signal.aborted) {
          for (const use of candidate.toolUses) {
            try {
              const result = await race(target.exec.run(makeBoxPendingRead(access.cwd, use.id), {
                timeoutMs: 20_000, maxResponseBytes: 1_048_576, signal }));
              parseBoxPendingCall(result.stdout, use);
              pending.add(use.id);
            } catch (error) {
              if (!(error instanceof BoxExecTransportError && error.terminalKnown)) throw error;
            }
          }
          if (pending.size === 0) await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
        if (pending.size === 0) throw new BoxToolContinuationError("BOX_TOOL_PENDING_UNPROVEN");
        const receipt = await race(deps.journal.recordToolHandoff({ requestId: input.requestId,
          uid: input.uid, leaseEpoch: claim.leaseEpoch, candidate,
          roundNo: claim.roundNo, spoolOffset: line.endOffset,
          detachedRunnerHash: claim.detachedRunnerHash,
          catalogHash: claim.catalogHash,
          verifiedPendingToolUseIds: [...pending] }));
        input.emit(decoder.commitHandoff(receipt));
        return { kind: "tool_handoff", spoolOffset: line.endOffset };
      }
      if (decoded.finalCandidate) {
        const final = decoded.finalCandidate;
        let proof: BoxTerminalProof | null = null;
        const until = Date.now() + 20_000;
        while (!proof && Date.now() < until && !signal.aborted) {
          try { proof = await race(readBoxTerminalProof({ target,
            expectedAccountId: claim.accountId, runNonce: claim.runNonce,
            leaseEpoch: claim.leaseEpoch, signal })); }
          catch (error) {
            if (!(error instanceof BoxExecTransportError && error.terminalKnown)) throw error;
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
          }
        }
        if (!proof || proof.reason !== "worker_complete") {
          throw new BoxToolContinuationError("BOX_TOOL_TERMINAL_UNPROVEN");
        }
        // The terminal marker proves no writer remains. Read from the result
        // line's exact byte end, not the enclosing chunk end: any trailing
        // result/error/bad JSON or incomplete frame must block billing.
        const trailing = await race(readBoxSpoolChunk({ exec: target.exec,
          plan: access, offset: line.endOffset, signal }));
        if (trailing.bytes.length !== 0) {
          throw new BoxToolContinuationError("BOX_TOOL_FINAL_TRAILING_BYTES");
        }
        decoder.finishFinal();
        const usage = { inputTokens: final.inputTokens,
          outputTokens: final.outputTokens, cacheReadTokens: final.cacheReadTokens,
          cacheWriteTokens: final.cacheWriteTokens };
        await race(deps.journal.completeToolChain({ requestId: input.requestId,
          uid: input.uid, leaseEpoch: claim.leaseEpoch, proof, usage }));
        let nativePointer: BoxNativePointer | undefined;
        if (process.env.OC_BOX_NATIVE_RESUME === "1" && final.assistantContentHash
          && claim.nativeSessionId && claim.nativeCliCwd
          && deps.journal.attachNativePointer) {
          try {
            const inspected = await target.exec.run(makeBoxNativeFileInspect({
              cliCwd: claim.nativeCliCwd, nativeSessionId: claim.nativeSessionId }), {
              timeoutMs: 10_000, maxResponseBytes: 4096 });
            const file = parseBoxNativeFileEvidence(inspected.stdout);
            const candidate = parseBoxNativePointer({ version: 1,
              accountId: claim.accountId.toString(), upstreamModel: input.upstreamModel,
              cliVersion: "2.1.280", nativeSessionId: claim.nativeSessionId,
              cliCwd: claim.nativeCliCwd, transcriptSha256: file.sha256,
              contextHashBeforeFinal: deriveBoxContextHash(input.canonicalBody),
              assistantContentHash: final.assistantContentHash,
              catalogHash: claim.catalogHash,
              expiresAtMs: Date.now() + 7 * 24 * 60 * 60 * 1000 });
            if (candidate && await deps.journal.attachNativePointer({
              requestId: input.requestId, uid: input.uid,
              accountId: claim.accountId, proof, pointer: candidate })) {
              nativePointer = candidate;
            }
          } catch { /* Cache miss must not erase durable usage or model result. */ }
        }
        input.emit(decoder.commitFinal({ terminalReason: proof.reason,
          journaledUsage: usage }));
        return { kind: "final", proof,
          ...(nativePointer ? { nativePointer } : {}) };
      }
    }
    throw new BoxToolContinuationError("BOX_TOOL_STREAM_INCOMPLETE");
  } catch (error) {
    await unknown("continuation_unknown");
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
