/**
 * compute_host_audit 写入封装(0042)。
 *
 * 设计原则:
 *   - 所有写入都要求传 PoolClient(由调用方在事务内提供)→ 状态切换 + audit
 *     写入要么一起成功要么一起回滚,杜绝"状态变了但 audit 缺"或反之的不一致。
 *   - operation 串约定使用 dotted 命名空间(`bootstrap.image_pull` /
 *     `health.uplink_probe` 等),便于按前缀过滤聚合。
 *   - operation_id 是同一次"运维行为"的关联键(例如一次 admin distribute 触发
 *     bootstrap.image_pull / image_load / loaded_image_set 多条 row 都共享 id)。
 *   - actor 串约定:`admin:<id>` / `system:<module>` / `agent:<host_uuid>`。
 *
 * 不做:
 *   - 不写 console.log(audit 表本身就是日志)。
 *   - 不做异步排队(同步事务内 INSERT,host audit 量级不大,< 几千 row/天)。
 *   - 不去重 — 同一 operation 重复触发也照写,reason_code/detail 体现差异。
 */

import type { PoolClient } from "pg";

export interface AuditWrite {
  hostId: string | null;
  operation: string;
  operationId?: string | null;
  reasonCode?: string | null;
  /** 任意 JSON-serializable detail。null/undefined → '{}'。 */
  detail?: Record<string, unknown> | null;
  actor: string;
}

/**
 * 在事务内追加一条审计行。仅接受 PoolClient,**不接受裸 pool**,避免业务调用绕过事务。
 *
 * 所有传入字符串 detail 走 JSON.stringify;detail 内含 BigInt 等非标准 JSON 值时
 * 调用方需自己转。
 */
export async function writeAuditInTx(client: PoolClient, w: AuditWrite): Promise<void> {
  await client.query(
    `INSERT INTO compute_host_audit
       (host_id, operation, operation_id, reason_code, detail, actor)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      w.hostId,
      w.operation,
      w.operationId ?? null,
      w.reasonCode ?? null,
      JSON.stringify(w.detail ?? {}),
      w.actor,
    ],
  );
}

/**
 * 非事务场景下方便地写一条审计:内部自己 BEGIN/COMMIT,不串到现有事务。
 * 仅供"独立 audit 行"使用(例如 admin 操作的纯审计,无伴随业务状态变化)。
 */
export async function writeAuditStandalone(
  pool: { connect: () => Promise<PoolClient> },
  w: AuditWrite,
): Promise<void> {
  const client = await pool.connect();
  try {
    await writeAuditInTx(client, w);
  } finally {
    client.release();
  }
}

/** ListAuditEvents — for diagnostic API。按 host + ts DESC 倒序。 */
export interface AuditEvent {
  id: number;
  hostId: string | null;
  operation: string;
  operationId: string | null;
  reasonCode: string | null;
  detail: Record<string, unknown>;
  actor: string;
  ts: string;
}

export async function listAuditEventsForHost(
  pool: {
    query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
  },
  hostId: string,
  limit = 100,
): Promise<AuditEvent[]> {
  const r = (await pool.query(
    `SELECT id, host_id, operation, operation_id, reason_code, detail, actor, ts
       FROM compute_host_audit
      WHERE host_id = $1
      ORDER BY ts DESC, id DESC
      LIMIT $2`,
    [hostId, limit],
  )) as { rows: Array<{
    id: string;
    host_id: string | null;
    operation: string;
    operation_id: string | null;
    reason_code: string | null;
    detail: Record<string, unknown>;
    actor: string;
    ts: Date;
  }>; };
  return r.rows.map((row) => ({
    id: Number(row.id),
    hostId: row.host_id,
    operation: row.operation,
    operationId: row.operation_id,
    reasonCode: row.reason_code,
    detail: row.detail ?? {},
    actor: row.actor,
    ts: row.ts.toISOString(),
  }));
}
