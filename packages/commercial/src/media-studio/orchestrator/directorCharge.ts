// Book a user-billed director call (plan / interpret) onto the project budget and
// settle an answer that was stored before its charge (crash between onResult and settle).

import type { Pool, PoolClient } from 'pg'

import type { GrokVisionUsage } from '../../grok/visionProxy.js'
import { grokCharged } from '../providers/charges.js'
import { MediaProviderError } from '../providers/types.js'
import type { StudioTask } from '../queue.js'
import { appendStudioEvent } from '../store.js'
import { bookTaskCharge, overBudget } from './budget.js'

export function usableUsage(value: unknown): GrokVisionUsage | null {
  if (!value || typeof value !== 'object') return null
  const u = value as Partial<GrokVisionUsage>
  if (typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') return null
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    reasoning_output_tokens: typeof u.reasoning_output_tokens === 'number' ? u.reasoning_output_tokens : 0,
    cache_read_input_tokens: typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0,
    cache_creation_input_tokens:
      typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0,
  }
}

/** Settle a stored answer again. No-op when the row has no metered usage (an older platform-paid step). */
export async function resettleStored(
  deps: {
    grokResettle?: (input: {
      userId: bigint
      requestId: string
      usage: GrokVisionUsage
    }) => Promise<void>
  },
  userId: bigint,
  stored: { requestId?: unknown; usage?: unknown } | null | undefined,
  code: string,
): Promise<void> {
  const usage = usableUsage(stored?.usage)
  const requestId = typeof stored?.requestId === 'string' ? stored.requestId : ''
  if (!usage || !requestId || !deps.grokResettle) return
  try {
    await deps.grokResettle({ userId, requestId, usage })
  } catch (err) {
    throw new MediaProviderError(code, true, err instanceof Error ? err.message : 'resettle failed')
  }
}

/**
 * Bring project spent in line with what this director call debited, and release its reservation.
 * An unreadable ledger books what was already booked; reconcile catches up later.
 */
export async function bookDirectorCharge(
  pool: Pool,
  task: StudioTask,
  client: PoolClient,
  userId: bigint | null,
): Promise<void> {
  const booked = BigInt(String((task.payload as { booked?: unknown }).booked ?? '0'))
  const charged =
    userId === null
      ? 0n
      : ((await grokCharged(pool, userId, task.execRequestId).catch(() => null)) ?? booked)
  await bookTaskCharge(client, task, charged, { release: true })
  if (await overBudget(client, task.projectId)) {
    const paused = await client.query(
      `UPDATE studio_projects
          SET status = 'paused',
              settings = settings || jsonb_build_object('pausedReason', 'budget', 'resumeTo', status),
              rev = rev + 1
        WHERE id = $1 AND status IN ('running', 'planning', 'awaiting_user', 'composing')
        RETURNING id`,
      [task.projectId],
    )
    if (paused.rowCount) {
      await appendStudioEvent(client, task.projectId, 'budget.exceeded', {
        message: '实际费用超出了预算，已暂停。',
      })
    }
  }
}
