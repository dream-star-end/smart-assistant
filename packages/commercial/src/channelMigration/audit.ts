// channelMigration/audit.ts
//
// v5_migration_audit 表(迁移 0101)的写入封装。每个迁移子步骤 begin→end 各一行,
// 便于看板统计、幂等重试、失败定位。纯 v5 侧写入(v3 不引用)。

import { query } from "../db/queries.js";
import { normUid } from "./channelState.js";

export type MigrationPhase = "preseed" | "sessions" | "volumes" | "cutover" | "rollback";

export interface AuditHandle {
  id: string;
  phase: MigrationPhase;
}

/** 记一条 started 行,返回句柄用于稍后 finish。 */
export async function auditStart(
  userId: bigint | number | string,
  phase: MigrationPhase,
  detail?: Record<string, unknown>,
): Promise<AuditHandle> {
  const uid = normUid(userId);
  const r = await query<{ id: string }>(
    `INSERT INTO v5_migration_audit (user_id, phase, status, detail)
     VALUES ($1, $2, 'started', $3::jsonb)
     RETURNING id::text AS id`,
    [uid, phase, detail ? JSON.stringify(detail) : null],
  );
  return { id: r.rows[0].id, phase };
}

/** 收尾一条(ok/error),合并明细(会覆盖 started 时的同名键)。 */
export async function auditFinish(
  handle: AuditHandle,
  status: "ok" | "error",
  detail?: Record<string, unknown>,
): Promise<void> {
  await query(
    `UPDATE v5_migration_audit
        SET status = $2,
            finished_at = NOW(),
            detail = COALESCE(detail, '{}'::jsonb) || COALESCE($3::jsonb, '{}'::jsonb)
      WHERE id = $1`,
    [handle.id, status, detail ? JSON.stringify(detail) : null],
  );
}

/**
 * 包裹一个迁移子步骤:自动 start / ok / error 审计,透传返回值与异常。
 * error 时把 err.message 写入 detail.error 后重抛(不吞异常)。
 */
export async function withAudit<T>(
  userId: bigint | number | string,
  phase: MigrationPhase,
  startDetail: Record<string, unknown>,
  fn: (audit: AuditHandle) => Promise<{ result: T; detail?: Record<string, unknown> }>,
): Promise<T> {
  const handle = await auditStart(userId, phase, startDetail);
  try {
    const { result, detail } = await fn(handle);
    await auditFinish(handle, "ok", detail);
    return result;
  } catch (err) {
    await auditFinish(handle, "error", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
