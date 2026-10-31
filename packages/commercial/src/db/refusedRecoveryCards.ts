/** OCV5-509: closes recovery chains paused before they ran (kept out of pgSessionsBackend for its size cap). */
import type { Pool } from "pg";
import { isClientMessageId } from "@openclaude/protocol";
import type { MessageLike } from "@openclaude/storage";
import { appendRecoveryGiveUpTerminalCard, withTx } from "./pgSessionsBackend.js";

/**
 * OCV5-509: a recovery paused before it ever ran — its dispatch refused by the
 * container (dispatch_not_accepted) or the recovery itself refused (refused:*) —
 * gets no tape, so nothing ever answers its "↻ 自动从断点继续" row and the
 * client reads that unanswered row as a recovery still in flight ("仍在处理中…"
 * across reloads, Stop lit). Close each such chain with the give-up card, but
 * only while that row is still the session's last message: a session the user
 * has moved on in is left alone. Idempotent (the card id is per root).
 */
export async function closeRefusedRecoveryChains(pool: Pool): Promise<number> {
  const jobs = (
    await pool.query<{
      user_id: string;
      session_id: string;
      root_client_message_id: string;
      recovery_message_id: string | null;
    }>(
      // Every such chain of the last day whose card is not written yet: no page
      // to starve a later chain (Codex r1). The history is not parsed in SQL —
      // json and jsonb both refuse a stored lone surrogate (`\ud800`), which
      // would fail the sweep for every session (Codex r2, r3); the last-row
      // check below runs per session under its row lock.
      `SELECT j.user_id::text AS user_id, j.session_id, j.root_client_message_id,
              j.request_json->>'clientMessageId' AS recovery_message_id
         FROM turn_recovery_jobs j
         JOIN client_sessions s
           ON s.id=j.session_id AND s.user_id='c:'||j.user_id::text AND s.deleted_at IS NULL
        WHERE j.status='paused'
          AND j.error_code <> 'dispatch_authority_expired'
          AND (j.pause_reason='dispatch_not_accepted' OR j.pause_reason LIKE 'refused:%')
          AND j.updated_at > NOW() - INTERVAL '1 day'
          AND strpos(s.messages, '"m-recovery-giveup-' || j.root_client_message_id || '"') = 0
        ORDER BY j.updated_at`,
    )
  ).rows;
  let closed = 0;
  // One session's failure must not hold up the chains after it: each runs on
  // its own and the first error is reported once all were tried.
  let failure: unknown;
  for (const job of jobs) {
    if (!isClientMessageId(job.recovery_message_id)) continue;
    const sessionUserId = `c:${job.user_id}`;
    const appended = await withTx(pool, async (client) => {
      const row = (
        await client.query<{ messages: string }>(
          `SELECT messages FROM client_sessions
            WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`,
          [job.session_id, sessionUserId],
        )
      ).rows[0];
      let last: MessageLike | undefined;
      try {
        const parsed = row ? JSON.parse(row.messages) : undefined;
        last = Array.isArray(parsed) ? parsed.at(-1) : undefined;
      } catch {
        return false;
      }
      if (
        last?.id !== job.recovery_message_id ||
        last.role !== "user" ||
        last._automaticRecovery !== true
      ) return false;
      return appendRecoveryGiveUpTerminalCard(client, {
        sessionId: job.session_id,
        sessionUserId,
        rootClientMessageId: job.root_client_message_id,
        reason: "recovery_refused",
      });
    }).catch((error: unknown) => {
      failure ??= error;
      return false;
    });
    if (appended) closed += 1;
  }
  if (failure !== undefined) throw failure;
  return closed;
}
