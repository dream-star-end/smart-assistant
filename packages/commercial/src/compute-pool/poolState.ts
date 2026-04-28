/**
 * compute_pool_state 单例(0042)CRUD。
 *
 * 单例 row 由 migration 0042 INSERT,key='singleton'。任何写入都按 key 兜底,
 * 保证业务上看不见 multi-row 异常。
 *
 * 为什么单独建这个文件而不是塞进 queries.ts:
 *   - queries.ts 已 600+ 行,集中度过高;
 *   - pool state 语义独立于 host row(全局期望 vs 单 host 实际);
 *   - imagePromote / placement gate / backfill 多处直接读它,放共享文件清晰。
 */

import type { PoolClient } from "pg";
import { getPool } from "../db/index.js";

export interface PoolState {
  desiredImageId: string | null;
  desiredImageTag: string | null;
  masterEpoch: bigint;
  updatedAt: Date;
}

export async function getPoolState(client?: PoolClient): Promise<PoolState> {
  const q = client ?? getPool();
  const r = await q.query<{
    desired_image_id: string | null;
    desired_image_tag: string | null;
    master_epoch: string;
    updated_at: Date;
  }>(
    `SELECT desired_image_id, desired_image_tag, master_epoch, updated_at
       FROM compute_pool_state
      WHERE singleton = 'singleton'
      LIMIT 1`,
  );
  if (r.rowCount === 0) {
    throw new Error(
      "compute_pool_state singleton row missing — migration 0042 not applied?",
    );
  }
  const row = r.rows[0]!;
  return {
    desiredImageId: row.desired_image_id,
    desiredImageTag: row.desired_image_tag,
    masterEpoch: BigInt(row.master_epoch),
    updatedAt: row.updated_at,
  };
}

/**
 * 设置 desired image。master_epoch 自增 1,代表"换了一代镜像目标"。
 * 若 image_id + image_tag 都未变,return false 不递增 epoch;否则 return true。
 *
 * 不在事务内做 audit — 调用方(imagePromote)自己决定是否对应写一条 system 行。
 */
export async function setDesiredImage(
  imageId: string,
  imageTag: string,
  client?: PoolClient,
): Promise<{ changed: boolean; previousEpoch: bigint; newEpoch: bigint; previous: PoolState }> {
  const q = client ?? getPool();
  // 取当前 + 是否变化在一行 SQL 内做(WITH+CASE),避免 read-modify-write race。
  const r = await q.query<{
    prev_image_id: string | null;
    prev_image_tag: string | null;
    prev_epoch: string;
    new_epoch: string;
    changed: boolean;
    updated_at: Date;
  }>(
    `WITH prev AS (
       SELECT desired_image_id, desired_image_tag, master_epoch, updated_at
         FROM compute_pool_state WHERE singleton='singleton'
       FOR UPDATE
     ),
     upd AS (
       UPDATE compute_pool_state
          SET desired_image_id = $1,
              desired_image_tag = $2,
              master_epoch =
                CASE
                  WHEN compute_pool_state.desired_image_id IS DISTINCT FROM $1
                    OR compute_pool_state.desired_image_tag IS DISTINCT FROM $2
                  THEN compute_pool_state.master_epoch + 1
                  ELSE compute_pool_state.master_epoch
                END,
              updated_at = NOW()
        WHERE singleton = 'singleton'
        RETURNING master_epoch AS new_epoch
     )
     SELECT prev.desired_image_id AS prev_image_id,
            prev.desired_image_tag AS prev_image_tag,
            prev.master_epoch AS prev_epoch,
            upd.new_epoch,
            (prev.desired_image_id IS DISTINCT FROM $1
             OR prev.desired_image_tag IS DISTINCT FROM $2) AS changed,
            prev.updated_at
       FROM prev, upd`,
    [imageId, imageTag],
  );
  if (r.rowCount === 0) {
    throw new Error("compute_pool_state singleton missing during setDesiredImage");
  }
  const row = r.rows[0]!;
  return {
    changed: row.changed,
    previousEpoch: BigInt(row.prev_epoch),
    newEpoch: BigInt(row.new_epoch),
    previous: {
      desiredImageId: row.prev_image_id,
      desiredImageTag: row.prev_image_tag,
      masterEpoch: BigInt(row.prev_epoch),
      updatedAt: row.updated_at,
    },
  };
}
