import type { QueryRunner } from '../db/queries.js'
import { query } from '../db/queries.js'

export const SIGNAL_TRAFFIC_CLASSES = [
  'production_user',
  'internal_admin',
  'synthetic_canary',
  'e2e',
] as const

export type SignalTrafficClass = (typeof SIGNAL_TRAFFIC_CLASSES)[number]
export type SignalTrafficFilter = SignalTrafficClass | 'all'

export function isSignalTrafficFilter(value: string): value is SignalTrafficFilter {
  return value === 'all' || (SIGNAL_TRAFFIC_CLASSES as readonly string[]).includes(value)
}

export function signalTrafficFilterValue(value: SignalTrafficFilter): SignalTrafficClass | null {
  return value === 'all' ? null : value
}

export async function getUserSignalTrafficClass(
  userId: string | number | bigint,
  runner?: QueryRunner,
): Promise<SignalTrafficClass> {
  const result = await query<{ signal_traffic_class: SignalTrafficClass }>(
    `SELECT signal_traffic_class
       FROM users
      WHERE id=$1::bigint`,
    [String(userId)],
    runner,
  )
  return result.rows[0]?.signal_traffic_class ?? 'production_user'
}
