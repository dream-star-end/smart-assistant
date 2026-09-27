/** Resume observation of one *already launched* detached no-tool text run.
 * HTTP retries and background reconciliation share this read-only path. */
import { makeBoxDetachedRunAccess } from "./boxDetachedRunAccess.js";
import { observeBoxDetachedText } from "./boxDetachedTextObserve.js";
import { BoxDurableJournalError, type BoxDurableJournal,
  type BoxReplayIdentity } from "./boxDurableJournal.js";
import type { BoxReplayMessageWriter } from "./boxReplayMessageFile.js";
import { readBoxTerminalProof } from "./boxTerminalProof.js";
import type { BoxResolvedTarget } from "./boxTextFetch.js";

export class BoxTextUnknownObserverError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxTextUnknownObserverError"; }
}

type Resolver = (args: { uid: bigint; sessionId: string | null;
  requestId: string; upstreamModel: string; signal: AbortSignal;
  allowWakeIfHibernated: false; requiredAccountId: bigint }) => Promise<BoxResolvedTarget>;

export async function observeBoxTextUnknown(input: {
  identity: BoxReplayIdentity; signal?: AbortSignal;
}, deps: { journal: Pick<BoxDurableJournal, "complete" |
  "markFirstRoundStoppedFailure">; resolveTarget: Resolver;
  writeMessage: BoxReplayMessageWriter; budgetMs?: number }):
  Promise<"pending" | "committed" | "failed_stopped"> {
  const id = input.identity;
  if (id.invocationMode !== "text" || id.state !== "unknown"
    || !id.rootLaunchPermit || id.messagePointer) return "pending";
  if (id.roundNo !== 1 || !id.detachedRunnerHash
    || id.upstreamModel !== "claude-opus-5-5") {
    throw new BoxTextUnknownObserverError("BOX_TEXT_OBSERVER_EVIDENCE_INVALID");
  }
  const budget = deps.budgetMs ?? 20_000;
  if (!Number.isSafeInteger(budget) || budget < 1000 || budget > 30_000) {
    throw new BoxTextUnknownObserverError("BOX_TEXT_OBSERVER_BUDGET_INVALID");
  }
  const pollAbort = new AbortController();
  // BoxExecTransport's account guard closes over this resolver signal.
  // Keep it live for the independent terminal-proof read after spool timeout.
  const resolverAbort = new AbortController();
  const onAbort = (): void => pollAbort.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) pollAbort.abort();
  const timer = setTimeout(() => pollAbort.abort(), budget);
  let target: BoxResolvedTarget | undefined;
  try {
    // A resolver can finish after the HTTP caller has gone. Observe and
    // dispose only that late local ProxyAgent, never the remote keeper.
    let abandoned = false;
    let late: BoxResolvedTarget | undefined;
    const resolving = Promise.resolve().then(() => deps.resolveTarget({ uid: id.uid,
      sessionId: null, requestId: id.requestId,
      upstreamModel: id.upstreamModel!, signal: resolverAbort.signal,
      allowWakeIfHibernated: false, requiredAccountId: id.accountId }));
    void resolving.then((value) => {
      late = value;
      if (abandoned) void Promise.resolve().then(() => value.dispose?.()).catch(() => {});
    }, () => {});
    const stopped = new Promise<null>((resolve) => {
      if (pollAbort.signal.aborted) { resolve(null); return; }
      pollAbort.signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    try { target = (await Promise.race([resolving, stopped])) ?? undefined; }
    catch { return "pending"; }
    if (!target) {
      if (late) void Promise.resolve().then(() => late!.dispose?.()).catch(() => {});
      else abandoned = true;
      return "pending";
    }
    if (target.accountId !== id.accountId || pollAbort.signal.aborted) return "pending";
    const access = makeBoxDetachedRunAccess({ runNonce: id.runNonce,
      detachedRunnerHash: id.detachedRunnerHash });
    let observed: Awaited<ReturnType<typeof observeBoxDetachedText>>;
    try { observed = await observeBoxDetachedText({ target, access,
      expectedModel: id.upstreamModel, runNonce: id.runNonce,
      leaseEpoch: id.leaseEpoch, deadlineMs: budget, signal: pollAbort.signal }); }
    catch {
      // A keeper may have proved failure without ever producing a valid
      // Claude result line. Probe the immutable marker even after the spool
      // poll timed out; the spent HTTP signal must not hide that proof.
      const proofAbort = new AbortController();
      const proofTimer = setTimeout(() => proofAbort.abort(), 11_000);
      let proof: Awaited<ReturnType<typeof readBoxTerminalProof>> | undefined;
      try { proof = await readBoxTerminalProof({ target,
        expectedAccountId: id.accountId, runNonce: id.runNonce,
        leaseEpoch: id.leaseEpoch, signal: proofAbort.signal }); }
      catch { /* No proof means no release or invented usage. */ }
      finally { clearTimeout(proofTimer); }
      if (proof && proof.reason !== "worker_complete") {
        try { await deps.journal.markFirstRoundStoppedFailure({
          requestId: id.requestId, uid: id.uid,
          leaseEpoch: id.leaseEpoch, proof }); }
        catch (failure) {
          if (failure instanceof BoxDurableJournalError
            && ["BOX_FAILED_STOP_FENCE_LOST", "BOX_FAILED_STOP_CHAIN_INVALID"]
              .includes(failure.code)) return "pending";
          throw failure;
        }
        return "failed_stopped";
      }
      // A completed marker without a valid model result cannot invent usage;
      // missing proof is equally unknown. Neither permits a paid replay.
      return "pending";
    }
    const pointer = await deps.writeMessage({ uid: id.uid.toString(),
      requestId: id.requestId, runNonce: id.runNonce,
      leaseEpoch: id.leaseEpoch, roundNo: 1 }, observed.message);
    try { await deps.journal.complete({ requestId: id.requestId,
      uid: id.uid, leaseEpoch: id.leaseEpoch,
      proof: observed.proof, usage: observed.usage,
      messagePointer: pointer }); }
    catch (error) {
      if (error instanceof BoxDurableJournalError
        && error.code === "BOX_JOURNAL_COMPLETE_FENCE_LOST") return "pending";
      throw error;
    }
    return "committed";
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    pollAbort.abort();
    resolverAbort.abort();
    if (target?.dispose) {
      const close = Promise.resolve().then(() => target!.dispose!());
      void close.catch(() => {});
      await Promise.race([close.catch(() => {}), new Promise<void>((resolve) => {
        const wait = setTimeout(resolve, 200); wait.unref?.();
      })]);
    }
  }
}
