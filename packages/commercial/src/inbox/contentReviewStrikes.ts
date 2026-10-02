import { patchUser } from '../admin/users.js'
import { query, tx } from '../db/queries.js'
import { createInboxMessage } from './inbox.js'
import {
  shouldBanForStrikes,
  violationInbox,
} from '../../../gateway/src/contentReviewNotice.js'

export interface StrikeNoticeInput {
  adminId: string
  userId: string
  reviewId: number
  sessionKey: string
  excerpt: string
}

export interface StrikeNoticeResult {
  strikeId: string
  activeCount: number
  accountBanned: boolean
  alreadySent: boolean
}

export async function sendContentViolationNotice(input: StrikeNoticeInput): Promise<StrikeNoticeResult> {
  if (!/^[1-9][0-9]{0,18}$/.test(input.userId)) {
    throw new Error('CONTENT_REVIEW_USER_INVALID')
  }
  const existing = await query<{ id: string; inbox_message_id: string | null; status: string }>(
    `SELECT id::text AS id, inbox_message_id::text AS inbox_message_id, status
       FROM content_review_strikes
      WHERE user_id = $1::bigint AND review_id = $2`,
    [input.userId, input.reviewId],
  )
  let strikeId = existing.rows[0]?.id
  if (existing.rows[0]?.inbox_message_id) {
    const activeCount = await countOpenStrikes(input.userId)
    return { strikeId: strikeId!, activeCount, accountBanned: shouldBanForStrikes(activeCount), alreadySent: true }
  }
  if (!strikeId) {
    const inserted = await query<{ id: string }>(
      `INSERT INTO content_review_strikes (user_id, review_id, session_key, excerpt, status)
       VALUES ($1::bigint, $2, $3, $4, 'active')
       ON CONFLICT (user_id, review_id) DO NOTHING
       RETURNING id::text AS id`,
      [input.userId, input.reviewId, input.sessionKey, input.excerpt.slice(0, 180)],
    )
    strikeId = inserted.rows[0]?.id ?? (await query<{ id: string }>(
      `SELECT id::text AS id FROM content_review_strikes WHERE user_id = $1::bigint AND review_id = $2`,
      [input.userId, input.reviewId],
    )).rows[0]?.id
  }
  if (!strikeId) throw new Error('CONTENT_REVIEW_STRIKE_MISSING')
  const activeCount = await countOpenStrikes(input.userId)
  const notice = violationInbox({ strikeId, excerpt: input.excerpt.slice(0, 180), activeCount })
  const message = await createInboxMessage(input.adminId, {
    audience: 'user',
    user_id: input.userId,
    title: notice.title,
    body_md: notice.bodyMd,
    level: 'warning',
  })
  await query(
    `UPDATE content_review_strikes SET inbox_message_id = $2::bigint WHERE id = $1::bigint AND inbox_message_id IS NULL`,
    [strikeId, message.id],
  )
  let accountBanned = false
  if (shouldBanForStrikes(activeCount)) {
    const status = await query<{ status: string }>(
      `SELECT status FROM users WHERE id = $1::bigint`,
      [input.userId],
    )
    if (status.rows[0]?.status === 'active') {
      await patchUser(input.userId, { status: 'banned' }, { adminId: input.adminId })
      await query(
        `INSERT INTO content_review_account_bans (user_id, strike_count)
         VALUES ($1::bigint, $2)
         ON CONFLICT (user_id) DO UPDATE SET strike_count = EXCLUDED.strike_count, banned_at = NOW()`,
        [input.userId, activeCount],
      )
      accountBanned = true
    }
  }
  return { strikeId, activeCount, accountBanned, alreadySent: false }
}

export async function fileContentAppeal(input: {
  userId: string
  strikeId: string
  statement: string
}): Promise<{ appealId: string }> {
  const statement = input.statement.trim().slice(0, 1000)
  if (!statement) throw new Error('CONTENT_APPEAL_EMPTY')
  return tx(async (client) => {
    const strike = await client.query<{ id: string; status: string }>(
      `SELECT id::text AS id, status FROM content_review_strikes
        WHERE id = $1::bigint AND user_id = $2::bigint
        FOR UPDATE`,
      [input.strikeId, input.userId],
    )
    const row = strike.rows[0]
    if (!row || row.status === 'revoked') throw new Error('CONTENT_APPEAL_NOT_FOUND')
    if (row.status === 'appealed') {
      const pending = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM content_review_appeals
          WHERE strike_id = $1::bigint AND user_id = $2::bigint AND status = 'pending'`,
        [input.strikeId, input.userId],
      )
      if (pending.rows[0]) return { appealId: pending.rows[0].id }
    }
    await client.query(
      `UPDATE content_review_strikes SET status = 'appealed' WHERE id = $1::bigint AND status = 'active'`,
      [input.strikeId],
    )
    const appeal = await client.query<{ id: string }>(
      `INSERT INTO content_review_appeals (strike_id, user_id, statement, status)
       VALUES ($1::bigint, $2::bigint, $3, 'pending')
       RETURNING id::text AS id`,
      [input.strikeId, input.userId, statement],
    )
    return { appealId: appeal.rows[0]!.id }
  })
}

export async function listPendingContentAppeals(): Promise<Array<{
  id: string
  strikeId: string
  userId: string
  statement: string
  excerpt: string
  createdAt: string
}>> {
  const rows = await query<{
    id: string
    strike_id: string
    user_id: string
    statement: string
    excerpt: string
    created_at: Date
  }>(
    `SELECT a.id::text AS id, a.strike_id::text AS strike_id, a.user_id::text AS user_id,
            a.statement, s.excerpt, a.created_at
       FROM content_review_appeals a
       JOIN content_review_strikes s ON s.id = a.strike_id
      WHERE a.status = 'pending'
      ORDER BY a.id ASC
      LIMIT 50`,
  )
  return rows.rows.map((row) => ({
    id: row.id,
    strikeId: row.strike_id,
    userId: row.user_id,
    statement: row.statement,
    excerpt: row.excerpt,
    createdAt: row.created_at.toISOString(),
  }))
}

export async function decideContentAppeal(input: {
  adminId: string
  appealId: string
  approve: boolean
}): Promise<{ activeCount: number; accountActive: boolean }> {
  const decided = await tx(async (client) => {
    const appeal = await client.query<{ strike_id: string; user_id: string; status: string }>(
      `SELECT strike_id::text AS strike_id, user_id::text AS user_id, status
         FROM content_review_appeals WHERE id = $1::bigint FOR UPDATE`,
      [input.appealId],
    )
    const row = appeal.rows[0]
    if (!row || row.status !== 'pending') throw new Error('CONTENT_APPEAL_NOT_FOUND')
    await client.query(
      `UPDATE content_review_appeals
          SET status = $2, decided_at = NOW(), decided_by = $3::bigint
        WHERE id = $1::bigint`,
      [input.appealId, input.approve ? 'approved' : 'rejected', input.adminId],
    )
    if (input.approve) {
      await client.query(
        `UPDATE content_review_strikes
            SET status = 'revoked', revoked_at = NOW(), revoked_by = $2::bigint
          WHERE id = $1::bigint`,
        [row.strike_id, input.adminId],
      )
    } else {
      await client.query(
        `UPDATE content_review_strikes SET status = 'active' WHERE id = $1::bigint AND status = 'appealed'`,
        [row.strike_id],
      )
    }
    return row.user_id
  })
  const activeCount = await countOpenStrikes(decided)
  let accountActive = true
  if (input.approve && !shouldBanForStrikes(activeCount)) {
    const marker = await query(
      `DELETE FROM content_review_account_bans WHERE user_id = $1::bigint RETURNING user_id`,
      [decided],
    )
    if ((marker.rowCount ?? 0) > 0) {
      const status = await query<{ status: string }>(`SELECT status FROM users WHERE id = $1::bigint`, [decided])
      if (status.rows[0]?.status === 'banned') {
        await patchUser(decided, { status: 'active' }, { adminId: input.adminId })
      }
    }
  }
  const status = await query<{ status: string }>(`SELECT status FROM users WHERE id = $1::bigint`, [decided])
  accountActive = status.rows[0]?.status === 'active'
  return { activeCount, accountActive }
}

async function countOpenStrikes(userId: string): Promise<number> {
  const counted = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM content_review_strikes
      WHERE user_id = $1::bigint AND status IN ('active', 'appealed')`,
    [userId],
  )
  return Number(counted.rows[0]?.n ?? '0')
}
