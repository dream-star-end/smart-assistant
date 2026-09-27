/** Read an existing detached CLI's spool after an ambiguous HTTP outcome.
 * This path never stages input, launches Claude, publishes tool results or
 * settles billing. It may only commit evidence to the original journal row. */
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { deriveBoxCallFingerprint } from "./boxCallFingerprint.js";
import { BoxCliToolHandoffDecoder } from "./boxCliToolHandoff.js";
import { makeBoxDetachedRunAccess } from "./boxDetachedRunAccess.js";
import { BoxExecTransportError } from "./boxExecTransport.js";
import { BoxDurableJournalError, type BoxDurableJournal,
  type BoxReplayIdentity } from "./boxDurableJournal.js";
import type { BoxReplayMessageWriter } from "./boxReplayMessageFile.js";
import { pollBoxSpoolLines } from "./boxSpoolPoller.js";
import { readBoxSpoolChunk } from "./boxSpoolRead.js";
import { readBoxTerminalProof } from "./boxTerminalProof.js";
import type { BoxResolvedTarget } from "./boxTextFetch.js";
import { makeBoxPendingRead, parseBoxPendingCall } from "./boxToolResultPlan.js";
import { BoxToolResultEcho } from "./boxToolResultEcho.js";
import type { ProxyBody } from "./shared.js";

export class BoxToolUnknownObserverError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxToolUnknownObserverError"; }
}

type Result = "pending" | "committed";
type Resolver = (args: { uid: bigint; sessionId: string | null;
  requestId: string; upstreamModel: string; signal: AbortSignal;
  allowWakeIfHibernated: false; requiredAccountId: bigint }) => Promise<BoxResolvedTarget>;

export async function observeBoxToolUnknown(input: {
  identity: BoxReplayIdentity; canonicalBody: ProxyBody; upstreamModel: string;
  signal?: AbortSignal;
}, deps: { journal: Pick<BoxDurableJournal, "recordToolHandoff" | "complete" |
  "completeToolChain">; resolveTarget: Resolver;
  writeMessage: BoxReplayMessageWriter; budgetMs?: number }): Promise<Result> {
  const id = input.identity;
  if (id.invocationMode !== "detached_tool" || id.state !== "unknown"
    || !id.rootLaunchPermit || id.messagePointer) return "pending";
  if (!id.detachedRunnerHash || !id.catalogHash
    || (id.roundNo > 1 && (!id.resultHashes || id.resultHashes.length < 1))) {
    throw new BoxToolUnknownObserverError("BOX_OBSERVER_EVIDENCE_MISSING");
  }
  const catalog = compileBoxToolCatalog(input.canonicalBody.tools);
  if (catalog.bindingSha256 !== id.catalogHash) {
    throw new BoxToolUnknownObserverError("BOX_OBSERVER_CATALOG_CHANGED");
  }
  const fingerprint = deriveBoxCallFingerprint(id.uid, input.canonicalBody);
  const budget = deps.budgetMs ?? 20_000;
  if (!Number.isSafeInteger(budget) || budget < 1000 || budget > 30_000) {
    throw new BoxToolUnknownObserverError("BOX_OBSERVER_BUDGET_INVALID");
  }
  const abort = new AbortController();
  const onAbort = (): void => abort.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) abort.abort();
  const timer = setTimeout(() => abort.abort(), budget);
  let target: BoxResolvedTarget | undefined;
  try {
    // No wake and no paid launch. The resolver must return the originally
    // admitted account; a different account is not recovery evidence.
    try {
      let abandoned = false;
      let lateTarget: BoxResolvedTarget | undefined;
      const resolving = Promise.resolve().then(() => deps.resolveTarget({ uid: id.uid,
        sessionId: fingerprint.sessionId, requestId: id.requestId,
        upstreamModel: input.upstreamModel, signal: abort.signal,
        allowWakeIfHibernated: false, requiredAccountId: id.accountId }));
      void resolving.then((late) => {
        lateTarget = late;
        if (abandoned) void Promise.resolve().then(() => late.dispose?.()).catch(() => {});
      }, () => {});
      const stopped = new Promise<null>((resolve) => {
        if (abort.signal.aborted) { resolve(null); return; }
        abort.signal.addEventListener("abort", () => resolve(null), { once: true });
      });
      const resolved = await Promise.race([resolving, stopped]);
      if (!resolved) {
        if (lateTarget) void Promise.resolve().then(() => lateTarget!.dispose?.()).catch(() => {});
        else abandoned = true;
        return "pending";
      }
      target = resolved;
    }
    catch { return "pending"; }
    if (target.accountId !== id.accountId || abort.signal.aborted) return "pending";
    const access = makeBoxDetachedRunAccess({ runNonce: id.runNonce,
      detachedRunnerHash: id.detachedRunnerHash });
    const decoder = new BoxCliToolHandoffDecoder(input.upstreamModel, catalog,
      { alreadyInitialized: id.roundNo > 1, allowFinal: true });
    const echo = id.roundNo > 1 ? new BoxToolResultEcho(id.resultHashes!) : null;
    let modelStarted = false;
    try {
      for await (const line of pollBoxSpoolLines({ exec: target.exec, access,
        startOffset: id.roundNo === 1 ? 0 : id.spoolOffset,
        deadlineMs: budget, signal: abort.signal })) {
        let record: unknown;
        try { record = JSON.parse(line.text); }
        catch { throw new BoxToolUnknownObserverError("BOX_OBSERVER_RECORD_INVALID"); }
        if (record && typeof record === "object" && !Array.isArray(record)
          && (record as { type?: unknown }).type === "user") {
          if (!echo || modelStarted) {
            throw new BoxToolUnknownObserverError("BOX_OBSERVER_ECHO_UNEXPECTED");
          }
          echo.accept(record);
          continue;
        }
        if (record && typeof record === "object" && !Array.isArray(record)
          && (record as { type?: unknown }).type === "stream_event"
          && (record as { event?: { type?: unknown } }).event?.type === "message_start") {
          echo?.assertComplete(); modelStarted = true;
        }
        const decoded = decoder.push(line.text);
        if (decoded.candidate) {
          const pending: string[] = [];
          for (const use of decoded.candidate.toolUses) {
            try {
              const result = await target.exec.run(makeBoxPendingRead(access.cwd, use.id), {
                timeoutMs: 5_000, maxResponseBytes: 1_048_576, signal: abort.signal });
              parseBoxPendingCall(result.stdout, use);
              pending.push(use.id);
            } catch (error) {
              if (!(error instanceof BoxExecTransportError && error.terminalKnown)) {
                throw error;
              }
              // A later call may not yet have been dispatched.
            }
          }
          if (pending.length === 0 || abort.signal.aborted) return "pending";
          const pointer = await deps.writeMessage({ uid: id.uid.toString(),
            requestId: id.requestId, runNonce: id.runNonce,
            leaseEpoch: id.leaseEpoch, roundNo: id.roundNo }, decoder.completedMessage());
          try { await deps.journal.recordToolHandoff({ requestId: id.requestId,
            uid: id.uid, leaseEpoch: id.leaseEpoch, candidate: decoded.candidate,
            roundNo: id.roundNo, spoolOffset: line.endOffset,
            detachedRunnerHash: id.detachedRunnerHash,
            catalogHash: id.catalogHash, verifiedPendingToolUseIds: pending,
            messagePointer: pointer }); }
          catch (error) {
            if (error instanceof BoxDurableJournalError
              && error.code === "BOX_TOOL_HANDOFF_FENCE_LOST") return "pending";
            throw error;
          }
          return "committed";
        }
        if (decoded.finalCandidate) {
          if (abort.signal.aborted) return "pending";
          let proof;
          try { proof = await readBoxTerminalProof({ target,
            expectedAccountId: id.accountId, runNonce: id.runNonce,
            leaseEpoch: id.leaseEpoch, signal: abort.signal }); }
          catch { return "pending"; }
          if (proof.reason !== "worker_complete") return "pending";
          const trailing = await readBoxSpoolChunk({ exec: target.exec,
            plan: access, offset: line.endOffset, signal: abort.signal });
          if (trailing.bytes.length !== 0) {
            throw new BoxToolUnknownObserverError("BOX_OBSERVER_FINAL_TRAILING_BYTES");
          }
          decoder.finishFinal();
          const final = decoded.finalCandidate;
          const usage = { inputTokens: final.inputTokens,
            outputTokens: final.outputTokens, cacheReadTokens: final.cacheReadTokens,
            cacheWriteTokens: final.cacheWriteTokens };
          const pointer = await deps.writeMessage({ uid: id.uid.toString(),
            requestId: id.requestId, runNonce: id.runNonce,
            leaseEpoch: id.leaseEpoch, roundNo: id.roundNo }, decoder.completedMessage());
          try {
            if (id.roundNo === 1) await deps.journal.complete({ requestId: id.requestId,
              uid: id.uid, leaseEpoch: id.leaseEpoch, proof, usage,
              messagePointer: pointer });
            else await deps.journal.completeToolChain({ requestId: id.requestId,
              uid: id.uid, leaseEpoch: id.leaseEpoch, proof, usage,
              messagePointer: pointer });
          } catch (error) {
            if (error instanceof BoxDurableJournalError
              && ["BOX_JOURNAL_COMPLETE_FENCE_LOST", "BOX_TOOL_CHAIN_INVALID"]
                .includes(error.code)) return "pending";
            throw error;
          }
          return "committed";
        }
      }
    } catch (error) {
      if (abort.signal.aborted) return "pending";
      throw error;
    }
    return "pending";
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    abort.abort();
    if (target?.dispose) {
      // Closing a local proxy agent cannot terminate the remote CLI. Observe
      // late completion/rejection without delaying the HTTP retry forever.
      const close = Promise.resolve().then(() => target!.dispose!());
      void close.catch(() => {});
      await Promise.race([close.catch(() => {}), new Promise<void>((resolve) => {
        const wait = setTimeout(resolve, 200); wait.unref?.();
      })]);
    }
  }
}
