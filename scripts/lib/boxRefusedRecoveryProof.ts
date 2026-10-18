import { randomUUID } from "node:crypto";

type Db = { query: (sql: string, params?: unknown[]) => Promise<unknown> };
type Backend = {
  admitUserTurn: (input: unknown) => Promise<{ kind: string }>;
  getClientSession: (sessionId: string, userId: string) => Promise<{ messages: Array<{ id?: string }> } | null>;
  appendServerAuthoredMessage: (sessionId: string, userId: string,
    message: Record<string, unknown> & { id: string; role: string }) => Promise<{ applied: boolean }>;
};

function fail(message: string): never {
  throw new Error(`[box-incident-proofs] ${message}`);
}

/** INC-20261018-BOX-RECOVERY-REFUSED-STUCK, commercial u4 webmvc3iq5ff9hmmm (2026-10-17 23:30Z): after a Box 409 the
 * automatic 「从断点继续」 was refused by the container (DISPATCH_NOT_ACCEPTED); its job was paused and nothing ever
 * answered the recovery row, so every reload showed 「仍在处理中…」 under the not-started card for twelve hours.
 * A recovery paused before it ran closes its chain with a visible card while its row is still the last message. */
export async function proveRefusedRecoveryClosed({ backend, db, close, model, takeover }: {
  backend: Backend; db: Db; close: (db: Db) => Promise<number>; model: string;
  /** The tree has OCV5-511's takeover of a refused recovery (commercial). */
  takeover: boolean }): Promise<string> {
  // biome-ignore lint/style/useSingleVarDeclarator: same shape as proveFinalizedTurnRecovery
  const uid = 9n, sessionUser = "c:9";
  const chain = async (name: string, pauseReason: string, judged: boolean, text = "↻ 自动从断点继续") => {
    // biome-ignore lint/style/useSingleVarDeclarator: same shape as proveFinalizedTurnRecovery
    const sessionId = `s-ocv5-509-${name}`, root = `cm-ocv5-509-root-${name}`, recovery = `m-recover-ocv5509-${name}`;
    const dispatchId = randomUUID();
    const admitted = await backend.admitUserTurn({ uid, sessionUserId: sessionUser, sessionId, clientMessageId: recovery,
      agentId: "main", model, requestHash: "h".repeat(64), billingRequestId: `brq-${recovery}`,
      dispatchId, ownerId: "conn-A",
      message: { id: recovery, role: "user", text, ts: 1,
        _routing: { model, effortLevel: null, teamMode: false }, _automaticRecovery: true,
        _automaticRecoveryAttempt: 1, _recoveryOfClientMessageId: root, _automaticRecoveryRootClientMessageId: root } });
    if (admitted.kind !== "admitted") fail(`REFUSED_RECOVERY_${name}_NOT_ADMITTED`);
    // the container refused it; the tick has (judged) or has not yet looked at it
    await db.query(`UPDATE turn_dispatches SET status='terminal', outcome='not_accepted',
        failure_code='DISPATCH_NOT_ACCEPTED', client_notified=$2, terminal_at=NOW() WHERE dispatch_id=$1`,
      [dispatchId, judged]);
    await db.query(`INSERT INTO turn_recovery_jobs (user_id,session_id,root_client_message_id,source_client_message_id,
        source_turn_key,error_code,recovery_mode,semantic_recovery_attempt,request_json,tape_sha256,status,pause_reason,
        terminal_outcome,dispatch_id,dispatch_attempt_no) VALUES ($1,$2,$3,$3,$4,'engine_error','checkpoint',1,$5,$6,'paused',
        $7,'interrupted',$8,1)`,
      [uid.toString(), sessionId, root, "k".repeat(64), JSON.stringify({ clientMessageId: recovery }), "a".repeat(64),
        pauseReason, dispatchId]);
    return { sessionId, root, recovery };
  };
  const last = async (sessionId: string) =>
    (await backend.getClientSession(sessionId, sessionUser))?.messages.at(-1) as Record<string, unknown> | undefined;
  const reason = async (sessionId: string) => ((await db.query(
    "SELECT pause_reason FROM turn_recovery_jobs WHERE session_id=$1", [sessionId])) as { rows: Array<{ pause_reason: string }> })
    .rows[0]?.pause_reason;
  // the recovery row was answered after all: nothing to close, and (oldest) it must not hold the sweep up
  const answered = await chain("answered", "dispatch_not_accepted", true);
  const reply = await backend.appendServerAuthoredMessage(answered.sessionId, sessionUser,
    { id: "m-ocv5-509-answer", role: "assistant", text: "done", ts: 2, status: "completed", _source: "server" });
  if (!reply.applied) fail("REFUSED_RECOVERY_ANSWER_NOT_APPENDED");
  const refused = await chain("refused", "dispatch_not_accepted", true);
  // a lone surrogate the session writer keeps must not fail the sweep for every session (Codex r2, r3)
  const policy = await chain("policy", "refused:UNAUTHORIZED_MODEL", false, "↻ 自动从断点继续\ud800");
  if ((await backend.getClientSession(policy.sessionId, sessionUser) as { messages: Array<{ text?: unknown }> } | null)
    ?.messages.at(-1)?.text !== "↻ 自动从断点继续\ud800") fail("REFUSED_RECOVERY_SURROGATE_NOT_STORED");
  // not judged yet: with OCV5-511 its takeover gets the first turn, so no card yet (Codex r5)
  const unjudged = await chain("unjudged", "dispatch_not_accepted", false);
  // OCV5-511 ran out of attempts without a tape: nothing will run it on, and it wrote no card itself
  const exhausted = await chain("exhausted", "automatic_retry_exhausted", true);
  const cards = takeover ? [refused, policy, exhausted] : [refused, policy, unjudged];
  const untouched = takeover ? [unjudged] : [exhausted];
  if (await close(db) !== cards.length) fail("REFUSED_RECOVERY_NOT_CLOSED");
  for (const closed of cards) {
    const card = await last(closed.sessionId);
    // what the client reads as the end of the turn (adoptPendingAutomaticRecoveryFromHistory)
    if (card?.id !== `m-recovery-giveup-${closed.root}` || card.role !== "assistant" || card._source !== "server"
      || card.status !== "completed" || typeof card.text !== "string" || !card.text.trim()) {
      fail(`REFUSED_RECOVERY_CARD_${closed.sessionId}_${String(card?.id)}`);
    }
  }
  for (const open of untouched) {
    if ((await last(open.sessionId))?.id !== open.recovery) fail(`REFUSED_RECOVERY_TOUCHED_${open.sessionId}`);
  }
  if ((await last(answered.sessionId))?.id !== "m-ocv5-509-answer") fail("REFUSED_RECOVERY_ANSWERED_TOUCHED");
  // a closed chain is fenced against a late takeover (OCV5-511 resumes only dispatch_not_accepted)
  if (takeover && await reason(refused.sessionId) !== "refused:closed") fail("REFUSED_RECOVERY_NOT_FENCED");
  if (await close(db) !== 0) fail("REFUSED_RECOVERY_NOT_IDEMPOTENT");
  return "[ocv5-509-refused-recovery-closed] PASS — a recovery paused before it ran ends its turn with a visible card once nothing will run it on, and an answered chain is left alone";
}
