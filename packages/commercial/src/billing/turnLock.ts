import type { PoolClient } from 'pg'

const TURN_KEY_RE = /^[0-9a-f]{64}$/

/** Commercial session storage keys are namespaced as `c:<numeric uid>`. */
export function numericCommercialUserId(userKey: string): bigint {
  const match = /^c:([1-9][0-9]*)$/.exec(userKey)
  if (!match) throw new Error('commercial user key must be c:<positive numeric uid>')
  return BigInt(match[1]!)
}

export function assertCanonicalTurnKey(turnKey: string): void {
  if (!TURN_KEY_RE.test(turnKey)) throw new Error('turn key must be 64 lowercase hex characters')
}

/**
 * Serialize every debit, terminal waiver fence, renewal decision and refund
 * for the same logical turn.  Delegate settlements lock both their child key
 * and the parent/root key in lexical order, preventing deadlocks while making
 * a parent waiver a real fence for all child costs.
 */
export async function lockTurnBillingKeys(
  client: PoolClient,
  userId: bigint,
  turnKeys: ReadonlyArray<string | null | undefined>,
): Promise<string[]> {
  const keys = [...new Set(turnKeys.filter((v): v is string => typeof v === 'string'))].sort()
  for (const turnKey of keys) {
    assertCanonicalTurnKey(turnKey)
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `turn-billing-v1:${userId.toString()}:${turnKey}`,
    ])
  }
  return keys
}
