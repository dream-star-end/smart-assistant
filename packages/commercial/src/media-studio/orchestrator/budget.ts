// OCV5-591 A2-1a — project budget (backend plan §4): reserve the worst case atomically when a task
// is dispatched, then book what was actually charged and release the reservation exactly once.

import type { Pool, PoolClient } from 'pg'

type Db = Pool | PoolClient

/**
 * Adds `est` to the project's reservation only if spent + reserved + est still fits the budget.
 * false → do not dispatch (the caller pauses the project with a budget event).
 */
export async function reserveBudget(db: Db, projectId: string, est: bigint): Promise<boolean> {
  if (est < 0n) throw new Error('negative reservation')
  const r = await db.query(
    `UPDATE studio_projects
        SET reserved_credits = reserved_credits + $2, updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
        AND spent_credits + reserved_credits + $2 <= budget_credits
      RETURNING id`,
    [projectId, est.toString()],
  )
  return r.rowCount === 1
}

/**
 * Brings the project's spent in line with what one execution actually charged (plan r3 §4): the
 * task's `payload.booked` holds what is already counted, so spent += charged - booked. With
 * `release`, the task's reservation is released in the same statement, exactly once (its
 * reserved_credits is zeroed). Safe to call any number of times: a second call with the same
 * charge changes nothing. Returns the booked delta, or null when the task is not this project's.
 */
export async function bookTaskCharge(
  db: Db,
  task: { id: string; projectId: string },
  charged: bigint,
  opts: { release: boolean },
): Promise<{ delta: bigint; released: bigint } | null> {
  if (charged < 0n) throw new Error('negative charge')
  const r = await db.query<{ delta: string; released: string }>(
    `WITH t AS (
       SELECT id, reserved_credits AS held, COALESCE((payload->>'booked')::bigint, 0) AS booked
         FROM studio_tasks WHERE id = $1 AND project_id = $2 FOR UPDATE
     ), u AS (
       UPDATE studio_tasks s
          SET payload = jsonb_set(s.payload, '{booked}', to_jsonb($3::text)),
              reserved_credits = CASE WHEN $4 THEN 0 ELSE s.reserved_credits END
         FROM t WHERE s.id = t.id
       RETURNING t.held, t.booked
     )
     UPDATE studio_projects p
        SET spent_credits = GREATEST(0, p.spent_credits + ($3::bigint - u.booked)),
            reserved_credits = GREATEST(0, p.reserved_credits - CASE WHEN $4 THEN u.held ELSE 0 END),
            updated_at = NOW()
       FROM u
      WHERE p.id = $2
      RETURNING ($3::bigint - u.booked)::text AS delta,
                (CASE WHEN $4 THEN u.held ELSE 0 END)::text AS released`,
    [task.id, task.projectId, charged.toString(), opts.release],
  )
  const row = r.rows[0]
  return row ? { delta: BigInt(row.delta), released: BigInt(row.released) } : null
}

/** Over budget once late charges are counted (the caller pauses the project). */
export async function overBudget(db: Db, projectId: string): Promise<boolean> {
  const r = await db.query<{ over: boolean }>(
    `SELECT spent_credits + reserved_credits > budget_credits AS over
       FROM studio_projects WHERE id = $1`,
    [projectId],
  )
  return r.rows[0]?.over === true
}
