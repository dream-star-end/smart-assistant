/**
 * 用户模型授权(role + grants)加载器。
 *
 * 无 fence 的展示/管理调用可用 60s soft TTL；安全执行面必须传入已经 fence 的
 * requiredEpoch。缓存仅在 epoch 精确相等时命中，DB 返回的 epoch 不相等则 fail-closed，
 * 从而 grant 撤销不会继承旧 TTL。
 */

import type { UserModelScope } from "../billing/modelCatalog.js";

export type UserModelAuthz = {
  role: "user" | "admin";
  grantedModelIds: ReadonlySet<string>;
  /** Account-scoped hard denials override visibility and explicit grants. */
  deniedModelIds?: ReadonlySet<string>;
  /** Personal subscription_plans.tier, or null if none/expired. */
  userPlanTier?: number | null;
  /** Highest-tier active org plan code, if the user is an org member. */
  orgPlanCode?: string | null;
};

export type UserModelAuthzLoader = (
  uid: bigint,
  requiredEpoch?: bigint,
) => Promise<UserModelAuthz>;

export class UserModelAuthzEpochMismatchError extends Error {
  constructor(
    readonly requiredEpoch: bigint,
    readonly loadedEpoch: bigint,
  ) {
    super(`user model authz epoch mismatch: required=${requiredEpoch} loaded=${loadedEpoch}`);
    this.name = "UserModelAuthzEpochMismatchError";
  }
}

const AUTHZ_TTL_MS = 60_000;
export const TEST_ACCOUNT_DENIED_MODEL_ID = "deepseek-v4-pro";

export function deniedModelIdsForTrafficClass(
  trafficClass: string | null,
): ReadonlySet<string> {
  return trafficClass === "synthetic_canary" || trafficClass === "e2e"
    ? new Set([TEST_ACCOUNT_DENIED_MODEL_ID])
    : new Set();
}

interface LoadedAuthz {
  value: UserModelAuthz;
  epoch: bigint;
}

export function makeLoadUserModelAuthz(): UserModelAuthzLoader {
  const loadUncached = async (uid: bigint): Promise<LoadedAuthz> => {
    const { query } = await import("../db/queries.js");
    const r = await query<{
      role: string | null;
      signal_traffic_class: string | null;
      epoch: string;
      grants: string[];
      user_plan_tier: string | number | null;
      org_plan_code: string | null;
    }>(
      `SELECT u.role,
              u.signal_traffic_class,
              e.epoch::text AS epoch,
              COALESCE(array_agg(g.model_id ORDER BY g.model_id)
                FILTER (WHERE g.model_id IS NOT NULL), ARRAY[]::text[]) AS grants,
              (
                SELECT sp.tier
                  FROM user_subscriptions us
                  JOIN subscription_plans sp
                    ON sp.code = us.plan_code AND sp.scope = 'user'
                 WHERE us.user_id = u.id
                   AND us.status = 'active'
                   AND us.period_end > NOW()
                 LIMIT 1
              ) AS user_plan_tier,
              (
                SELECT sp.code
                  FROM org_memberships om
                  JOIN org_subscriptions os
                    ON os.org_id = om.org_id
                   AND os.status = 'active'
                   AND os.period_end > NOW()
                  JOIN subscription_plans sp
                    ON sp.code = os.plan_code AND sp.scope = 'org'
                 WHERE om.user_id = u.id
                   AND om.status = 'active'
                 ORDER BY sp.tier DESC, sp.code
                 LIMIT 1
              ) AS org_plan_code
         FROM model_security_epoch e
         LEFT JOIN users u ON u.id = $1::bigint
         LEFT JOIN model_visibility_grants g ON g.user_id = u.id
        WHERE e.id
        GROUP BY u.role, u.signal_traffic_class, e.epoch, u.id`,
      [uid],
    );
    const row = r.rows[0];
    if (!row) throw new Error("model security epoch singleton missing");
    return {
      epoch: BigInt(row.epoch),
      value: {
        role: row.role === "admin" ? "admin" : "user",
        grantedModelIds: new Set(row.grants),
        deniedModelIds: deniedModelIdsForTrafficClass(row.signal_traffic_class),
        userPlanTier: row.user_plan_tier == null || row.user_plan_tier === "" ? null : Number(row.user_plan_tier),
        orgPlanCode: row.org_plan_code,
      },
    };
  };

  const cache = new Map<string, { loaded: LoadedAuthz; exp: number }>();
  const inflight = new Map<string, Promise<LoadedAuthz>>();

  return async (uid: bigint, requiredEpoch?: bigint): Promise<UserModelAuthz> => {
    const userKey = uid.toString();
    const hit = cache.get(userKey);
    if (
      hit &&
      hit.exp > Date.now() &&
      (requiredEpoch === undefined || hit.loaded.epoch === requiredEpoch)
    ) {
      return hit.loaded.value;
    }

    const requestKey = `${userKey}:${requiredEpoch?.toString() ?? "soft"}`;
    const pending = inflight.get(requestKey);
    const load = pending ?? loadUncached(uid);
    if (!pending) inflight.set(requestKey, load);
    try {
      const loaded = await load;
      if (requiredEpoch !== undefined && loaded.epoch !== requiredEpoch) {
        throw new UserModelAuthzEpochMismatchError(requiredEpoch, loaded.epoch);
      }
      if (cache.size > 5000) cache.clear();
      cache.set(userKey, { loaded, exp: Date.now() + AUTHZ_TTL_MS });
      return loaded.value;
    } finally {
      if (!pending) inflight.delete(requestKey);
    }
  };
}


/** Catalog/list/canUse scope from the fenced authz loader. */
export function scopeFromAuthz(
  uid: number | string | bigint,
  authz: UserModelAuthz,
): UserModelScope {
  return {
    uid,
    role: authz.role,
    grantedModelIds: authz.grantedModelIds,
    deniedModelIds: authz.deniedModelIds,
    userPlanTier: authz.userPlanTier ?? null,
    orgPlanCode: authz.orgPlanCode ?? null,
  };
}
