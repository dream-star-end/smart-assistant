// OCV5-591 A2-1 — every final write of a task happens in one transaction that first proves the
// lease is still ours (owner + epoch); a worker that lost its lease commits nothing.

import type { Pool, PoolClient } from 'pg'

import type { StudioTask } from '../queue.js'

export class LeaseLostError extends Error {
  constructor() {
    super('studio task lease lost')
    this.name = 'LeaseLostError'
  }
}

export async function withLease<T>(
  pool: Pool,
  task: StudioTask,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const own = await client.query(
      `SELECT 1 FROM studio_tasks WHERE id = $1 AND lease_owner = $2 AND lease_epoch = $3 AND status = 'leased' FOR UPDATE`,
      [task.id, task.owner, task.epoch],
    )
    if (own.rowCount !== 1) throw new LeaseLostError()
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
