/** Authenticated same-round replay from a completed private Message capsule.
 * Lookup/read/render only: no account selection, paid CLI, tool publication,
 * precheck, journal admission or second settlement. */
import type { BoxDurableJournal, BoxReplayIdentity } from "./boxDurableJournal.js";
import type { BoxReplayMessagePointer } from "./boxReplayMessageFile.js";
import { boxReplayMessageToSse } from "./boxReplayMessageSse.js";
import type { ProxyBody } from "./shared.js";

export class BoxReplayCompletedError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxReplayCompletedError"; }
}
export type BoxReplayLookup =
  | { kind: "missing" }
  | { kind: "pending"; identity: BoxReplayIdentity }
  | { kind: "ready"; identity: BoxReplayIdentity; response: Response };

export async function findCompletedBoxReplay(input: {
  uid: bigint; canonicalModel: string; canonicalBody: ProxyBody;
  upstreamModel: string;
}, deps: {
  journal: Pick<BoxDurableJournal, "findReplayIdentity">;
  readMessage: (pointer: BoxReplayMessagePointer) => Promise<unknown>;
}): Promise<BoxReplayLookup> {
  const identity = await deps.journal.findReplayIdentity(input);
  if (!identity) return { kind: "missing" };
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
