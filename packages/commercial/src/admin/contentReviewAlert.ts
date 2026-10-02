import type { ContentReviewAlert } from '../../../gateway/src/jevContentReview.js'

import { query } from '../db/queries.js'
import { enqueueAlert } from './alertOutbox.js'

export async function alertContentReview(event: ContentReviewAlert): Promise<void> {
  const title = '高置信违规内容'
  try {
    await enqueueAlert({
      event_type: 'content_review.policy_violation',
      severity: 'critical',
      title,
      body: event.body,
      dedupe_key: `content_review:${event.reviewId}`,
      payload: {
        reviewId: event.reviewId,
        sessionKey: event.sessionKey,
        userId: event.userId,
        confidence: event.confidence,
      },
    })
  } catch {
    // Alert delivery must not break the review record.
  }
  try {
    const admins = await query<{ id: string }>(
      "SELECT id::text AS id FROM users WHERE role = 'admin' AND status = 'active'",
    )
    for (const row of admins.rows) {
      await query(
        `INSERT INTO inbox_messages (audience, user_id, title, body_md, level, created_by)
         VALUES ('user', $1::bigint, $2, $3, 'warning', $1::bigint)`,
        [row.id, title, event.body.slice(0, 16000)],
      )
    }
  } catch {
    // Inbox is a best-effort copy of the same alert.
  }
}
