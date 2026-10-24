import { query, type QueryRunner } from '../db/queries.js'
import { InboxError } from './inbox.js'
/** Fixed approval snapshots; no body or execution-time expansion of the approved set. */
export interface InboxReadReference { id: string; version: string }
export interface InboxReadSnapshot { messages: InboxReadReference[]; title?: string }
export class InboxApprovalConflict extends Error {
  constructor() { super('INBOX_APPROVAL_CONFLICT'); this.name = 'InboxApprovalConflict' }
}
const approvalVisibility = `(
  (m.audience='user' AND m.user_id=$1::bigint)
  OR (m.audience='all' AND m.created_at >= (SELECT created_at FROM users WHERE id=$1::bigint))
) AND (m.expires_at IS NULL OR m.expires_at > NOW())`;
export async function snapshotInboxRead(userId: string, messageId: string | null, runner?: QueryRunner): Promise<InboxReadSnapshot> {
  const result = await query<{ id: string; version: string; title: string | null }>(`
    SELECT m.id::text AS id,m.xmin::text AS version,
           CASE WHEN $2::bigint IS NOT NULL THEN m.title ELSE NULL END AS title
      FROM inbox_messages m LEFT JOIN inbox_message_reads r ON r.message_id=m.id AND r.user_id=$1::bigint
     WHERE ${approvalVisibility} AND ($2::bigint IS NULL OR m.id=$2::bigint)
       AND ($2::bigint IS NOT NULL OR r.user_id IS NULL)
     ORDER BY m.id`, [userId, messageId], runner);
  if (messageId !== null && result.rows.length !== 1) throw new InboxError('NOT_FOUND', 'message not found');
  return { messages: result.rows.map(({ id, version }) => ({ id, version })),
    ...(messageId !== null ? { title: result.rows[0]!.title ?? '' } : {}) };
}
/** Must run inside the caller's PG receipt transaction; every query uses that exact runner. */
export async function markApprovedInboxRead(userId: string, messages: readonly InboxReadReference[], runner: QueryRunner): Promise<{ inserted: number }> {
  const ids = messages.map(message => message.id);
  if (new Set(ids).size !== ids.length) throw new InboxApprovalConflict();
  const locked = await query<{ id: string; version: string }>(`
    SELECT m.id::text AS id,m.xmin::text AS version FROM inbox_messages m
     WHERE ${approvalVisibility} AND m.id=ANY($2::bigint[])
     ORDER BY m.id FOR SHARE OF m`, [userId, ids], runner);
  const expected = new Map(messages.map(message => [message.id, message.version]));
  if (locked.rows.length !== messages.length || locked.rows.some(row => expected.get(row.id) !== row.version)) throw new InboxApprovalConflict();
  const result = await query(`INSERT INTO inbox_message_reads(user_id,message_id)
    SELECT $1::bigint,id FROM unnest($2::bigint[]) AS approved(id)
    ON CONFLICT(user_id,message_id) DO NOTHING`, [userId, ids], runner);
  return { inserted: result.rowCount ?? 0 };
}
