/**
 * 用户模型授权(role + model grants)加载器 —— 60s soft-TTL 缓存 + inflight 去重。
 *
 * 原先内联在 index.ts(anthropicProxy 装配段);2026-07-02 egress 进程解耦时抽出:
 * master 与 egress 两个进程的 /v1/messages 鉴权必须走同一份业务规则,单一权威收口
 * 在这里。语义与原实现逐行等价(fail-closed:user 不存在 → role=user + 空 grants;
 * 缓存未命中/过期照走权威 DB;size 上限防御性 clear)。
 */

export type UserModelAuthz = {
  role: "user" | "admin";
  grantedModelIds: ReadonlySet<string>;
};

const AUTHZ_TTL_MS = 60_000;

export function makeLoadUserModelAuthz(): (uid: bigint) => Promise<UserModelAuthz> {
  const loadUncached = async (uid: bigint): Promise<UserModelAuthz> => {
    const { query } = await import("../db/queries.js");
    const { listGrantsForUser } = await import("../admin/modelGrants.js");
    const r = await query<{ role: string }>("SELECT role FROM users WHERE id = $1", [uid]);
    if (r.rows.length === 0) {
      // user 在 DB 里不存在(理论被 verifyContainerIdentity 截掉,这里是防御编程)。
      // fail-closed:认 user role,grants 空集 → 公开 model 还能用,admin/hidden 一律拒。
      return { role: "user", grantedModelIds: new Set<string>() };
    }
    const roleRaw = r.rows[0].role;
    const role: "user" | "admin" = roleRaw === "admin" ? "admin" : "user";
    const grants = await listGrantsForUser(uid);
    return { role, grantedModelIds: new Set(grants.map((g) => g.model_id)) };
  };

  const cache = new Map<string, { v: UserModelAuthz; exp: number }>();
  const inflight = new Map<string, Promise<UserModelAuthz>>();

  return async (uid: bigint): Promise<UserModelAuthz> => {
    const k = uid.toString();
    const hit = cache.get(k);
    if (hit && hit.exp > Date.now()) return hit.v;
    const pending = inflight.get(k);
    if (pending) return pending;
    const p = loadUncached(uid)
      .then((v) => {
        if (cache.size > 5000) cache.clear();
        cache.set(k, { v, exp: Date.now() + AUTHZ_TTL_MS });
        return v;
      })
      .finally(() => inflight.delete(k));
    inflight.set(k, p);
    return p;
  };
}
