/** OCV5-509: closes recovery chains paused before they ran (kept out of pgSessionsBackend for its size cap). */
import type { Pool } from "pg";
import { isClientMessageId } from "@openclaude/protocol";
import type { MessageLike } from "@openclaude/storage";
import { lockRecoveryRoot } from "../dispatch/turnRecoveryStore.js";
import { appendRecoveryGiveUpTerminalCard, withTx } from "./pgSessionsBackend.js";

/**
 * OCV5-509: a recovery paused before it ever ran gets no tape, so nothing ever
 * answers its "↻ 自动从断点继续" row and the client reads that unanswered row as a
 * recovery still in flight ("仍在处理中…" across reloads, Stop lit). Close the
 * chain with the give-up card once nothing will run it on:
 *   - refused:* — the recovery itself was refused (OCV5-391);
 *   - dispatch_not_accepted or automatic_retry_exhausted — only after the
 *     reconciler tick has judged the refused dispatch (client_notified), so
 *     OCV5-511's own takeover of a refused recovery always gets its turn first.
 * Under the same root lock OCV5-511 takes, the card's transaction re-reads the
 * session's last row, the dispatch and the job, and turns dispatch_not_accepted
 * into refused:closed, so no successor can start after the card. Only while the
 * recovery row is still the session's last message: a session the user has moved
 * on in is left alone. Every chain of the day without its card is read (no page
 * to starve a later one); one session's failure does not stop the others.
 */
export async function closeRefusedRecoveryChains(pool: Pool): Promise<number> {
  const jobs = (
    await pool.query<{
      job_id: string;
      user_id: string;
      session_id: string;
      root_client_message_id: string;
      recovery_message_id: string | null;
      dispatch_id: string | null;
      dispatch_attempt_no: number | null;
    }>(
      // The history is not parsed in SQL: json and jsonb both refuse a stored
      // lone surrogate (`\ud800`), which would fail the sweep for every session.
      `SELECT j.job_id::text AS job_id, j.user_id::text AS user_id, j.session_id, j.root_client_message_id,
              j.request_json->>'clientMessageId' AS recovery_message_id,
              j.dispatch_id::text AS dispatch_id, j.dispatch_attempt_no
         FROM turn_recovery_jobs j
         JOIN client_sessions s
           ON s.id=j.session_id AND s.user_id='c:'||j.user_id::text AND s.deleted_at IS NULL
         LEFT JOIN turn_dispatches d
           ON d.dispatch_id=j.dispatch_id AND d.attempt_no=j.dispatch_attempt_no
        WHERE j.status='paused'
          AND (j.pause_reason LIKE 'refused:%'
            OR (j.pause_reason IN ('dispatch_not_accepted','automatic_retry_exhausted')
              AND d.status='terminal' AND d.client_notified))
          AND j.updated_at > NOW() - INTERVAL '1 day'
          AND strpos(s.messages, '"m-recovery-giveup-' || j.root_client_message_id || '"') = 0
        ORDER BY j.updated_at`,
    )
  ).rows;
  let closed = 0;
  let failure: unknown;
  for (const job of jobs) {
    if (!isClientMessageId(job.recovery_message_id)) continue;
    const sessionUserId = `c:${job.user_id}`;
    const appended = await withTx(pool, async (client) => {
      await lockRecoveryRoot(client, { userId: BigInt(job.user_id), sessionId: job.session_id,
        rootClientMessageId: job.root_client_message_id });
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
      const dispatch = job.dispatch_id === null ? undefined : (
        await client.query<{ status: string; client_notified: boolean }>(
          `SELECT status, client_notified FROM turn_dispatches
            WHERE dispatch_id=$1 AND attempt_no=$2 FOR UPDATE`,
          [job.dispatch_id, job.dispatch_attempt_no],
        )
      ).rows[0];
      const current = (
        await client.query<{ pause_reason: string | null }>(
          `SELECT pause_reason FROM turn_recovery_jobs WHERE job_id=$1 AND status='paused' FOR UPDATE`,
          [job.job_id],
        )
      ).rows[0];
      const reason = current?.pause_reason ?? "";
      const judged = dispatch?.status === "terminal" && dispatch.client_notified === true;
      if (!(reason.startsWith("refused:")
        || ((reason === "dispatch_not_accepted" || reason === "automatic_retry_exhausted") && judged))) {
        return false;
      }
      const card = await appendRecoveryGiveUpTerminalCard(client, {
        sessionId: job.session_id,
        sessionUserId,
        rootClientMessageId: job.root_client_message_id,
        reason: "recovery_refused",
      });
      if (card && reason === "dispatch_not_accepted") {
        await client.query(
          `UPDATE turn_recovery_jobs SET pause_reason='refused:closed', updated_at=NOW()
            WHERE job_id=$1 AND status='paused' AND pause_reason='dispatch_not_accepted'`,
          [job.job_id],
        );
      }
      return card;
    }).catch((error: unknown) => {
      failure ??= error;
      return false;
    });
    if (appended) closed += 1;
  }
  if (failure !== undefined) throw failure;
  return closed;
}
