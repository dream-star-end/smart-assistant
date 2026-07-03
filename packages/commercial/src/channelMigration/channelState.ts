// channelMigration/channelState.ts
//
// v3 → v5 用户「切换即迁移」的**权威源单一读写**(single authority = users.v5_migrated_at)。
//
// 设计不变量:
//   - "用户是否在 v5" 的判定权威恒为 `users.v5_migrated_at IS NOT NULL`(见迁移 0099)。
//     路由/门控只读它,绝不看 status(status 仅生命周期/审计辅助)。
//   - 状态机转换全部用**带前置状态谓词的原子 UPDATE**(WHERE 命中当前合法起点),
//     以 rowCount 判定是否生效 —— 天然串行化并发切换/回滚,防脑裂(两个编排器同时切
//     同一用户,只有一个的 UPDATE 命中,另一个 rowCount=0 得知已被抢占)。
//   - 切换过程(停容器 + rsync + sessions merge)是长耗时、**不**持 DB 事务;因此每个
//     mark* 是独立短事务(单 UPDATE 即原子),编排器在其间做 IO。
//
// 两树共用(v3 + v5 byte-identical):v3 只调 isMigratedToV5 / migratedUserIds 做 mutator
// 与路由门控(默认 NULL → 现状行为不变);v5 调全部(编排器在 v5/控制面侧)。

import { query } from "../db/queries.js";

export type V5MigrationStatus = "seeding" | "migrating" | "migrated" | "rolled_back";

/** 归一化 user_id 为纯数字字符串(BIGSERIAL 主键);非法输入 fail-fast。 */
export function normUid(userId: bigint | number | string): string {
  if (typeof userId === "bigint") {
    if (userId <= 0n) throw new TypeError(`bad user_id: ${userId}`);
    return userId.toString();
  }
  if (typeof userId === "number") {
    if (!Number.isInteger(userId) || userId <= 0) throw new TypeError(`bad user_id: ${userId}`);
    return String(userId);
  }
  if (!/^\d+$/.test(userId)) throw new TypeError(`bad user_id: ${userId}`);
  return userId;
}

export interface UserChannelState {
  userId: string;
  /** 切换权威时间戳;非 null ⟺ 用户现网在 v5。 */
  migratedAt: Date | null;
  status: V5MigrationStatus | null;
  /** 便捷判定 = migratedAt !== null。 */
  onV5: boolean;
}

/**
 * 单一权威判定:该用户是否已切到 v5(路由 / v3 mutator 门控用)。
 * 未知 user_id 视作未迁移(false),调用方无需区分"不存在"与"未迁移"。
 */
export async function isMigratedToV5(userId: bigint | number | string): Promise<boolean> {
  const uid = normUid(userId);
  const r = await query<{ on_v5: boolean }>(
    "SELECT (v5_migrated_at IS NOT NULL) AS on_v5 FROM users WHERE id = $1",
    [uid],
  );
  return r.rows[0]?.on_v5 === true;
}

/**
 * 批量返回已迁移的 uid 集合(路由/看板/批量门控热路径,避免 N 次单查)。
 * 传入空数组返回空集。仅返回确实已迁移(v5_migrated_at IS NOT NULL)的子集。
 */
export async function migratedUserIds(
  userIds: ReadonlyArray<bigint | number | string>,
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const uids = userIds.map(normUid);
  const r = await query<{ id: string }>(
    `SELECT id::text AS id FROM users
      WHERE id = ANY($1::bigint[]) AND v5_migrated_at IS NOT NULL`,
    [uids],
  );
  return new Set(r.rows.map((row) => row.id));
}

/** 读单用户完整迁移状态(编排器/看板/审计)。未知用户返回 null。 */
export async function getChannelState(
  userId: bigint | number | string,
): Promise<UserChannelState | null> {
  const uid = normUid(userId);
  const r = await query<{ v5_migrated_at: Date | null; v5_migration_status: V5MigrationStatus | null }>(
    "SELECT v5_migrated_at, v5_migration_status FROM users WHERE id = $1",
    [uid],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    userId: uid,
    migratedAt: row.v5_migrated_at,
    status: row.v5_migration_status,
    onV5: row.v5_migrated_at !== null,
  };
}

/**
 * 状态机转换结果:applied=true 表示本次 UPDATE 命中合法起点、状态已推进;
 * applied=false 表示当前状态不在合法起点集(已被并发编排器抢占、或非法转换),
 * 编排器据此决定跳过/告警/重试。
 */
export interface TransitionResult {
  applied: boolean;
  /** 转换后(或未变时的当前)状态,便于编排器日志/决策。null=行不存在或状态清空。 */
  status: V5MigrationStatus | null;
}

async function transition(
  uid: string,
  setStatus: V5MigrationStatus | null,
  setMigratedAtNow: boolean,
  clearMigratedAt: boolean,
  validFrom: string,
  validParams: ReadonlyArray<unknown>,
): Promise<TransitionResult> {
  const setMigrated = setMigratedAtNow
    ? ", v5_migrated_at = NOW()"
    : clearMigratedAt
      ? ", v5_migrated_at = NULL"
      : "";
  const r = await query<{ v5_migration_status: V5MigrationStatus | null }>(
    `UPDATE users
        SET v5_migration_status = $2${setMigrated}, updated_at = NOW()
      WHERE id = $1 AND ${validFrom}
      RETURNING v5_migration_status`,
    [uid, setStatus, ...validParams],
  );
  if (r.rows.length === 1) return { applied: true, status: r.rows[0].v5_migration_status };
  // 未命中合法起点:回读当前状态给编排器。
  const cur = await getChannelState(uid);
  return { applied: false, status: cur?.status ?? null };
}

/** NULL/rolled_back(未迁移)→ seeding。用于后台预热开始。 */
export function markSeeding(userId: bigint | number | string): Promise<TransitionResult> {
  return transition(
    normUid(userId),
    "seeding",
    false,
    false,
    "v5_migrated_at IS NULL AND (v5_migration_status IS NULL OR v5_migration_status IN ('seeding','rolled_back'))",
    [],
  );
}

/** NULL/seeding/rolled_back(未迁移)→ migrating。进入切换栅栏(停容器→最后 delta)。 */
export function markMigrating(userId: bigint | number | string): Promise<TransitionResult> {
  return transition(
    normUid(userId),
    "migrating",
    false,
    false,
    "v5_migrated_at IS NULL AND (v5_migration_status IS NULL OR v5_migration_status IN ('seeding','migrating','rolled_back'))",
    [],
  );
}

/** migrating → migrated(置 v5_migrated_at=NOW(),权威翻转到 v5)。栅栏最后一步。 */
export function markMigrated(userId: bigint | number | string): Promise<TransitionResult> {
  return transition(
    normUid(userId),
    "migrated",
    true,
    false,
    "v5_migration_status = 'migrating' AND v5_migrated_at IS NULL",
    [],
  );
}

/** migrated → rolled_back(清 v5_migrated_at=NULL,路由回 v3)。秒级回退。 */
export function rollbackToV3(userId: bigint | number | string): Promise<TransitionResult> {
  return transition(
    normUid(userId),
    "rolled_back",
    false,
    true,
    "v5_migration_status = 'migrated' AND v5_migrated_at IS NOT NULL",
    [],
  );
}

/** seeding/migrating(未翻转)→ NULL:中止未完成的迁移,复位如未触碰(区别于 rollback)。 */
export function abortInflight(userId: bigint | number | string): Promise<TransitionResult> {
  return transition(
    normUid(userId),
    null,
    false,
    false,
    "v5_migrated_at IS NULL AND v5_migration_status IN ('seeding','migrating')",
    [],
  );
}

// ── 路由 / 门控判定(纯读;v3 与 v5 两树都 import —— 编排器 cutover.ts 的重依赖不放这里)──

/** 该用户当前应由哪个 channel 服务(路由决策单一入口)。 */
export async function routeChannelForUser(
  userId: bigint | number | string,
): Promise<"v3" | "v5"> {
  return (await isMigratedToV5(userId)) ? "v5" : "v3";
}

export interface V3ServeGate {
  ok: boolean;
  reason?: string;
}

/**
 * v3 是否应为该用户提供服务/新建容器。已迁移(migrated)→ 否(路由应已把他导向 v5);
 * 迁移进行中(migrating)→ 否(栅栏窗口内拒新 turn 防 v3 重建容器与迁移竞态)。
 * 其余(NULL/seeding/rolled_back)→ 是。v3 provisioning/getOrCreate + idleSweep 调用它门控。
 */
export async function v3MayServe(userId: bigint | number | string): Promise<V3ServeGate> {
  const st = await getChannelState(userId);
  if (!st) return { ok: true };
  if (st.onV5) return { ok: false, reason: "user migrated to v5" };
  if (st.status === "migrating") return { ok: false, reason: "migration in progress" };
  return { ok: true };
}
