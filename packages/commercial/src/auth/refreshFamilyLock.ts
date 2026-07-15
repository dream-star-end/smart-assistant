import type { PoolClient } from "pg";

export interface RefreshTokenLockTarget {
  userId: string;
  familyId: string;
}

/** Resolve immutable lock identities without taking a row lock. */
export async function resolveRefreshTokenLockTarget(
  client: PoolClient,
  tokenHash: string,
): Promise<RefreshTokenLockTarget | null> {
  const lookup = await client.query<{ user_id: string; family_id: string }>(
    `SELECT user_id::text AS user_id, family_id::text AS family_id
       FROM refresh_tokens
      WHERE token_hash = $1`,
    [tokenHash],
  );
  const row = lookup.rows[0];
  return row ? { userId: row.user_id, familyId: row.family_id } : null;
}

/**
 * Acquire user mutation locks in one global numeric order. Identity-replacing
 * login can involve cookie owner A and target account B, so sorting is the
 * deadlock boundary shared by every multi-user path.
 */
export async function lockRefreshUsers(
  client: PoolClient,
  userIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(userIds)];
  for (const id of ids) {
    if (!/^[1-9][0-9]{0,19}$/.test(id)) {
      throw new TypeError(`invalid refresh-lock user id:${id}`);
    }
  }
  ids.sort((a, b) => {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const id of ids) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`oc_refresh_user:${id}`],
    );
  }
}

export async function lockRefreshFamily(client: PoolClient, familyId: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`oc_refresh_family:${familyId}`],
  );
}

/**
 * Serialize every issue/rotate/revoke mutation with account-wide password
 * reset/admin revocation and then with the exact refresh family.
 *
 * Global lock order (all auth paths must follow it):
 *   1. resolve token_hash -> immutable user_id/family_id without row locks;
 *   2. acquire every user advisory lock in numeric order;
 *   3. acquire family advisory lock(s);
 *   4. re-read and row-lock exact mutable rows.
 */
export async function lockRefreshMutationForTokenHash(
  client: PoolClient,
  tokenHash: string,
): Promise<RefreshTokenLockTarget | null> {
  const target = await resolveRefreshTokenLockTarget(client, tokenHash);
  if (!target) return null;

  await lockRefreshUsers(client, [target.userId]);
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`oc_refresh_family:${target.familyId}`],
  );
  return target;
}
