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
export async function proveRefusedRecoveryClosed({ backend, db, close, model }: {
  backend: Backend; db: Db; close: (db: Db) => Promise<number>; model: string }): Promise<string> {
  // biome-ignore lint/style/useSingleVarDeclarator: same shape as proveFinalizedTurnRecovery
  const uid = 9n, sessionUser = "c:9";
  const chain = async (name: string, pauseReason: string, text = "↻ 自动从断点继续") => {
    // biome-ignore lint/style/useSingleVarDeclarator: same shape as proveFinalizedTurnRecovery
    const sessionId = `s-ocv5-509-${name}`, root = `cm-ocv5-509-root-${name}`, recovery = `m-recover-ocv5509-${name}`;
    const admitted = await backend.admitUserTurn({ uid, sessionUserId: sessionUser, sessionId, clientMessageId: recovery,
      agentId: "main", model, requestHash: "h".repeat(64), billingRequestId: `brq-${recovery}`,
      dispatchId: randomUUID(), ownerId: "conn-A",
      message: { id: recovery, role: "user", text, ts: 1,
        _routing: { model, effortLevel: null, teamMode: false }, _automaticRecovery: true,
        _automaticRecoveryAttempt: 1, _recoveryOfClientMessageId: root, _automaticRecoveryRootClientMessageId: root } });
    if (admitted.kind !== "admitted") fail(`REFUSED_RECOVERY_${name}_NOT_ADMITTED`);
    await db.query(`INSERT INTO turn_recovery_jobs (user_id,session_id,root_client_message_id,source_client_message_id,
        source_turn_key,error_code,recovery_mode,semantic_recovery_attempt,request_json,tape_sha256,status,pause_reason,
        terminal_outcome) VALUES ($1,$2,$3,$3,$4,'engine_error','checkpoint',1,$5,$6,'paused',$7,'interrupted')`,
      [uid.toString(), sessionId, root, "k".repeat(64), JSON.stringify({ clientMessageId: recovery }), "a".repeat(64),
        pauseReason]);
    return { sessionId, root, recovery };
  };
  const last = async (sessionId: string) =>
    (await backend.getClientSession(sessionId, sessionUser))?.messages.at(-1) as Record<string, unknown> | undefined;
  // the recovery row was answered after all: nothing to close, and (oldest) it must not hold the sweep up
  const answered = await chain("answered", "dispatch_not_accepted");
  const reply = await backend.appendServerAuthoredMessage(answered.sessionId, sessionUser,
    { id: "m-ocv5-509-answer", role: "assistant", text: "done", ts: 2, status: "completed", _source: "server" });
  if (!reply.applied) fail("REFUSED_RECOVERY_ANSWER_NOT_APPENDED");
  const refused = await chain("refused", "dispatch_not_accepted");
  // a lone surrogate the session writer keeps must not fail the sweep for every session (Codex r2, r3)
  const policy = await chain("policy", "refused:UNAUTHORIZED_MODEL", "↻ 自动从断点继续\ud800");
  if ((await backend.getClientSession(policy.sessionId, sessionUser) as { messages: Array<{ text?: unknown }> } | null)
    ?.messages.at(-1)?.text !== "↻ 自动从断点继续\ud800") fail("REFUSED_RECOVERY_SURROGATE_NOT_STORED");
  // a chain that ran and gave up has its own card; it is not this sweep's
  const exhausted = await chain("exhausted", "automatic_retry_exhausted");
  // one sweep reaches every open chain, the history with a lone surrogate too (Codex r1–r3)
  if (await close(db) !== 2) fail("REFUSED_RECOVERY_NOT_CLOSED");
  for (const closed of [refused, policy]) {
    const card = await last(closed.sessionId);
    // what the client reads as the end of the turn (adoptPendingAutomaticRecoveryFromHistory)
    if (card?.id !== `m-recovery-giveup-${closed.root}` || card.role !== "assistant" || card._source !== "server"
      || card.status !== "completed" || typeof card.text !== "string" || !card.text.trim()) {
      fail(`REFUSED_RECOVERY_CARD_${closed.sessionId}_${String(card?.id)}`);
    }
  }
  if ((await last(answered.sessionId))?.id !== "m-ocv5-509-answer") fail("REFUSED_RECOVERY_ANSWERED_TOUCHED");
  if ((await last(exhausted.sessionId))?.id !== exhausted.recovery) fail("REFUSED_RECOVERY_EXHAUSTED_TOUCHED");
  if (await close(db) !== 0) fail("REFUSED_RECOVERY_NOT_IDEMPOTENT");
  return "[ocv5-509-refused-recovery-closed] PASS — a recovery paused before it ran ends its turn with a visible card, and an answered or exhausted chain is left alone";
}
