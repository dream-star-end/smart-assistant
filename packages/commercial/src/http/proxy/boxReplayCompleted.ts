/** Authenticated same-round replay from a completed private Message capsule.
 * Lookup/read/render only: no account selection, paid CLI, tool publication,
 * precheck, journal admission or second settlement. */
import type { BoxDurableJournal, BoxReplayIdentity, BoxRemoteCleanupCandidate } from "./boxDurableJournal.js";
import type { BoxReplayMessagePointer } from "./boxReplayMessageFile.js";
import { boxReplayMessageToSse } from "./boxReplayMessageSse.js";
import type { ProxyBody } from "./shared.js";
import type { AuthorityProjection, PreparedContinuation } from "./boxPreparedContinuation.js";

export class BoxReplayCompletedError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxReplayCompletedError"; }
}
export type BoxReplayLookup =
  | { kind: "missing" }
  | { kind: "failed"; code: "BOX_REPLAY_FAILED" | "BOX_REPLAY_STOPPED" | "BOX_REPLAY_RESULT_REJECTED"; diagnosticId?: string }
  | { kind: "pending"; identity: BoxReplayIdentity }
  | { kind: "ready"; identity: BoxReplayIdentity; response: Response };

export async function findCompletedBoxReplay(input: {
  uid: bigint; canonicalModel: string; canonicalBody: ProxyBody;
  upstreamModel: string;
  trustedAuthority?: AuthorityProjection;
  prepared?: PreparedContinuation;
}, deps: {
  journal: Pick<BoxDurableJournal, "findReplayIdentity">
    & Partial<Pick<BoxDurableJournal, "findSettledFailure">>;
  readFailureDiagnosticId?: (identity: BoxRemoteCleanupCandidate) => Promise<string | null>;
  readMessage: (pointer: BoxReplayMessagePointer) => Promise<unknown>;
}): Promise<BoxReplayLookup> {
  const identity = await deps.journal.findReplayIdentity(input);
  if (!identity) {
    if ((input.canonicalBody as { stream?: boolean }).stream === false && deps.journal.findSettledFailure) {
      const failure = await deps.journal.findSettledFailure(input);
      if (failure) {
        // Missing/expired/broken diagnostic storage cannot erase terminal truth.
        let diagnosticId: string | null = null;
        try { diagnosticId = await deps.readFailureDiagnosticId?.(failure) ?? null; } catch { /* optional */ }
        return { kind: "failed", code: failure.proof.reason === "keeper_stopped" ? "BOX_REPLAY_STOPPED"
          : failure.proof.reason === "worker_complete" ? "BOX_REPLAY_RESULT_REJECTED" : "BOX_REPLAY_FAILED",
          ...(typeof diagnosticId === "string" && /^bdiag_[a-f0-9]{24}$/.test(diagnosticId)
            ? { diagnosticId } : {}) };
      }
    }
    return { kind: "missing" };
  }
  if (!identity.messagePointer) return { kind: "pending", identity };
  const message = await deps.readMessage(identity.messagePointer);
  if (!message || typeof message !== "object" || Array.isArray(message)
    || (message as { model?: unknown }).model !== input.upstreamModel) {
    throw new BoxReplayCompletedError("BOX_REPLAY_MESSAGE_MODEL_INVALID");
  }
  const stream = (input.canonicalBody as { stream?: boolean }).stream;
  if (stream === false) {
    return { kind: "ready", identity,
      response: new Response(JSON.stringify(message), { status: 200,
        headers: { "content-type": "application/json" } }) };
  }
  if (stream !== true) throw new BoxReplayCompletedError("BOX_REPLAY_STREAM_INVALID");
  return { kind: "ready", identity,
    response: new Response(boxReplayMessageToSse(message), { status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } }) };
}
