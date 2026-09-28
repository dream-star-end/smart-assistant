/** Background success close for one already proved final model round.
 * A new tool handoff is out of scope: this function never writes a handoff
 * or skips ahead to a later result. The caller owns the pinned target. */
import { BoxCliToolHandoffDecoder } from "./boxCliToolHandoff.js";
import { makeBoxDetachedRunAccess } from "./boxDetachedRunAccess.js";
import { BoxDurableJournalError, type BoxDetachedUnknownRecovery,
  type BoxDurableJournal, type BoxRecoveryWinner } from "./boxDurableJournal.js";
import type { BoxReplayMessageWriter } from "./boxReplayMessageFile.js";
import { pollBoxSpoolLines } from "./boxSpoolPoller.js";
import { readBoxSpoolChunk } from "./boxSpoolRead.js";
import { readBoxTerminalProof } from "./boxTerminalProof.js";
import type { BoxToolCatalog } from "./boxToolCatalog.js";
import { BoxToolResultEcho } from "./boxToolResultEcho.js";
import type { BoxResolvedTarget } from "./boxTextFetch.js";

const LOST_RACE = new Set(["BOX_JOURNAL_COMPLETE_FENCE_LOST", "BOX_TOOL_CHAIN_FENCE_LOST",
  "BOX_TOOL_CHAIN_INVALID"]);

export type BoxToolTerminalRecovery =
  | { status: "committed" }
  | { status: "pending"; reason: string };

function winnerClosed(winner: BoxRecoveryWinner | null): boolean {
  if (!winner) return false;
  // request_finalize_journal.state=committed is settlement, not a Box terminal.
  if (winner.boxState === "failed_stopped") {
    return winner.proofReason !== null && winner.proofReason !== "worker_complete";
  }
  return winner.boxState === "terminal" && winner.proofReason === "worker_complete";
}

export async function observeBoxToolTerminalOnly(input: {
  evidence: BoxDetachedUnknownRecovery;
  catalog: BoxToolCatalog;
  target: BoxResolvedTarget;
  signal?: AbortSignal;
  budgetMs?: number;
}, deps: { journal: Pick<BoxDurableJournal, "complete" | "completeToolChain"
  | "readRecoveryWinner">; writeMessage: BoxReplayMessageWriter }):
  Promise<BoxToolTerminalRecovery> {
  const id = input.evidence;
  if (input.catalog.bindingSha256 !== id.catalogHash) {
    return { status: "pending", reason: "BOX_RECOVERY_CATALOG_MISMATCH" };
  }
  if (id.roundNo > 1 && (!id.resultHashes || id.resultHashes.length < 1)) {
    return { status: "pending", reason: "BOX_RECOVERY_PARENT_HASHES_MISSING" };
  }
  const budget = input.budgetMs ?? 20_000;
  if (!Number.isSafeInteger(budget) || budget < 1000 || budget > 30_000) {
    return { status: "pending", reason: "BOX_RECOVERY_BUDGET_INVALID" };
  }
  if (input.target.accountId !== id.accountId) {
    return { status: "pending", reason: "BOX_RECOVERY_ACCOUNT_MISMATCH" };
  }
  const abort = new AbortController();
  const onAbort = (): void => abort.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) abort.abort();
  const timer = setTimeout(() => abort.abort(), budget);
  try {
    const access = makeBoxDetachedRunAccess({ runNonce: id.runNonce,
      detachedRunnerHash: id.detachedRunnerHash });
    const decoder = new BoxCliToolHandoffDecoder(id.upstreamModel, input.catalog,
      { alreadyInitialized: id.roundNo > 1, allowFinal: true });
    const echo = id.roundNo > 1 ? new BoxToolResultEcho(id.resultHashes!) : null;
    let modelStarted = false;
    let endOffset = id.spoolOffset;
    for await (const line of pollBoxSpoolLines({ exec: input.target.exec, access,
      startOffset: id.roundNo === 1 ? 0 : id.spoolOffset,
      deadlineMs: budget, signal: abort.signal, pollIntervalMs: 1 })) {
      let record: unknown;
      try { record = JSON.parse(line.text); }
      catch { return { status: "pending", reason: "BOX_RECOVERY_RECORD_INVALID" }; }
      if (record && typeof record === "object" && !Array.isArray(record)
        && (record as { type?: unknown }).type === "user") {
        if (!echo || modelStarted) {
          return { status: "pending", reason: "BOX_RECOVERY_ECHO_UNEXPECTED" };
        }
        echo.accept(record);
        continue;
      }
      if (record && typeof record === "object" && !Array.isArray(record)
        && (record as { type?: unknown }).type === "stream_event"
        && (record as { event?: { type?: unknown } }).event?.type === "message_start") {
        echo?.assertComplete();
        modelStarted = true;
      }
      const decoded = decoder.push(line.text);
      if (decoded.candidate) {
        return { status: "pending", reason: "BOX_RECOVERY_INTERMEDIATE_HANDOFF" };
      }
      if (decoded.finalCandidate) {
        if (abort.signal.aborted) return { status: "pending", reason: "BOX_RECOVERY_ABORTED" };
        let proof;
        try {
          proof = await readBoxTerminalProof({ target: input.target,
            expectedAccountId: id.accountId, runNonce: id.runNonce,
            leaseEpoch: id.leaseEpoch, signal: abort.signal });
        } catch { return { status: "pending", reason: "BOX_RECOVERY_PROOF_UNREAD" }; }
        if (proof.reason !== "worker_complete") {
          return { status: "pending", reason: "BOX_RECOVERY_PROOF_NOT_COMPLETE" };
        }
        const trailing = await readBoxSpoolChunk({ exec: input.target.exec,
          plan: access, offset: line.endOffset, signal: abort.signal });
        if (trailing.bytes.length !== 0) {
          return { status: "pending", reason: "BOX_RECOVERY_FINAL_TRAILING_BYTES" };
        }
        try { decoder.finishFinal(); }
        catch { return { status: "pending", reason: "BOX_RECOVERY_FINAL_INVALID" }; }
        endOffset = line.endOffset;
        const final = decoded.finalCandidate;
        const usage = { inputTokens: final.inputTokens, outputTokens: final.outputTokens,
          cacheReadTokens: final.cacheReadTokens, cacheWriteTokens: final.cacheWriteTokens };
        let pointer;
        try {
          pointer = await deps.writeMessage({ uid: id.uid.toString(),
            requestId: id.requestId, runNonce: id.runNonce,
            leaseEpoch: id.leaseEpoch, roundNo: id.roundNo }, decoder.completedMessage());
        } catch { return { status: "pending", reason: "BOX_RECOVERY_CAPSULE_FAILED" }; }
        try {
          if (id.roundNo === 1) await deps.journal.complete({ requestId: id.requestId,
            uid: id.uid, leaseEpoch: id.leaseEpoch, proof, usage, messagePointer: pointer });
          else await deps.journal.completeToolChain({ requestId: id.requestId,
            uid: id.uid, leaseEpoch: id.leaseEpoch, proof, usage, messagePointer: pointer });
        } catch (error) {
          if (error instanceof BoxDurableJournalError && LOST_RACE.has(error.code)) {
            const winner = await deps.journal.readRecoveryWinner(id).catch(() => null);
            if (winnerClosed(winner)) {
              return { status: "pending", reason: "BOX_RECOVERY_LOST_RACE" };
            }
            return { status: "pending", reason: error.code };
          }
          return { status: "pending", reason: "BOX_RECOVERY_COMPLETE_FAILED" };
        }
        void endOffset;
        return { status: "committed" };
      }
    }
    return { status: "pending", reason: "BOX_RECOVERY_FINAL_MISSING" };
  } catch (error) {
    if (abort.signal.aborted) return { status: "pending", reason: "BOX_RECOVERY_ABORTED" };
    return { status: "pending", reason: error instanceof Error
      ? error.message : "BOX_RECOVERY_OBSERVE_FAILED" };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    abort.abort();
  }
}
