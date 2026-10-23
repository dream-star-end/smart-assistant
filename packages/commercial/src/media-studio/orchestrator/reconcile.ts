// OCV5-591 A2-1a — incremental reconciliation (plan r3 §4): project spent always catches up with the
// provider ledgers. Re-reads what each finished generation actually charged and books the
// difference against payload.booked, so a charge that lands late (an abandoned attempt that settles
// after its task failed) is still counted. Safe on both slots: rows are claimed with SKIP LOCKED.

import type { Pool } from 'pg'

import type { ProviderRegistry } from '../providers/registry.js'
import { appendStudioEvent } from '../store.js'
import { bookTaskCharge, overBudget } from './budget.js'

export const RECONCILE_INTERVAL_MS = 5 * 60_000
export const RECONCILE_LOOKBACK_DAYS = 30
const BATCH = 100

/** One full pass over the lookback window, a batch per transaction (keyset on task id). */
export async function reconcileCharges(deps: {
  pool: Pool
  providers: ProviderRegistry
}): Promise<number> {
  let changed = 0
  let cursor = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    const { n, last, booked } = await reconcileBatch(deps, cursor)
    changed += booked
    if (n < BATCH || !last) return changed
    cursor = last
  }
}

async function reconcileBatch(
  deps: { pool: Pool; providers: ProviderRegistry },
  after: string,
): Promise<{ n: number; last: string | null; booked: number }> {
  const client = await deps.pool.connect()
  let booked = 0
  try {
    await client.query('BEGIN')
    const rows = await client.query<{
      id: string
      project_id: string
      user_id: string
      exec: string
      provider: string
      take_id: string
      booked: string
    }>(
      `SELECT t.id::text AS id, t.project_id::text AS project_id, p.user_id::text AS user_id,
              t.exec_request_id AS exec, t.payload->>'providerId' AS provider, t.payload->>'takeId' AS take_id,
              COALESCE(t.payload->>'booked', '0') AS booked
         FROM studio_tasks t JOIN studio_projects p ON p.id = t.project_id
        WHERE t.kind = 'gen' AND t.status IN ('done', 'failed', 'canceled')
          AND t.updated_at > NOW() - make_interval(days => $1) AND p.deleted_at IS NULL
          AND t.id > $2::uuid
        ORDER BY t.id
        LIMIT $3
        FOR UPDATE OF t SKIP LOCKED`,
      [RECONCILE_LOOKBACK_DAYS, after, BATCH],
    )
    for (const r of rows.rows) {
      const provider = deps.providers.get(r.provider)
      if (!provider) continue
      const charged = await provider.chargedFor(BigInt(r.user_id), r.exec)
      if (charged === BigInt(r.booked)) continue
      await bookTaskCharge(client, { id: r.id, projectId: r.project_id }, charged, {
        release: false,
      })
      await client.query('UPDATE studio_takes SET cost_credits = $2 WHERE id = $1', [
        r.take_id,
        charged.toString(),
      ])
      await appendStudioEvent(client, r.project_id, 'charge.reconciled', {
        takeId: r.take_id,
        costCredits: charged.toString(),
        message: '按服务账单更新了一笔费用。',
      })
      if (await overBudget(client, r.project_id)) {
        await client.query(
          `UPDATE studio_projects SET status = 'paused', settings = settings || '{"pausedReason":"budget"}'::jsonb,
                  rev = rev + 1 WHERE id = $1 AND status = 'running'`,
          [r.project_id],
        )
        await appendStudioEvent(client, r.project_id, 'budget.exceeded_late', {
          message: '补记费用后超出预算，已暂停。',
        })
      }
      booked += 1
    }
    await client.query('COMMIT')
    return { n: rows.rows.length, last: rows.rows.at(-1)?.id ?? null, booked }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
