/**
 * 0049 model_visibility_grants admin CRUD —— per-user 模型授权(plan v3 §F2)。
 *
 * 用途:在 model_pricing.visibility='admin' / 'hidden' 时,显式给特定用户开放某个
 * 模型(如 'gpt-5.5' 灰度发布给 boss 指定的几个 user)。grants 表语义见 0049 migration
 * 与 pricing.ts §listForUser:visibility OR grants(union semantics)。
 *
 * 三个写操作必须在事务内同时写 admin_audit:
 *   - listGrantsForUser:只读,**不**写审计(只读路径不污染 audit)
 *   - addGrant:写一行 grants + 写一条 'model_grant.add' audit
 *   - removeGrant:删一行 grants + 写一条 'model_grant.remove' audit
 *
 * Idempotency:
 *   - addGrant 用 INSERT ... ON CONFLICT DO NOTHING。用 SELECT 探活判断"实际新增 vs 重复授权",
 *     重复授权也写 audit(grant 操作幂等,但审计仍记录"管理员尝试授权")?
 *     **决定:重复不写 audit** —— 否则 admin 多次提交同样授权刷一堆相同 audit。返回值带
 *     `inserted: boolean`,前端据此显示 "已授权" / "已存在,无变化"。
 *   - removeGrant 用 DELETE ... WHERE。用 affected rows 判断,删不存在的也返回 200(idempotent),
 *     但仅在实际有删除时写 audit(同上)。
 *
 * 不做 grant 时间窗 / 自动过期:plan v3 §F2 没要求。如未来需要,加 `expires_at` + 后台
 * sweeper(NOTIFY pricing_changed-style)清理 + canUseModel 加 expires_at 比较。
 */

import type { PoolClient } from 'pg'
import { query, tx } from '../db/queries.js'
import { writeAdminAudit } from './audit.js'

const ID_RE = /^[1-9][0-9]{0,19}$/
const MODEL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/

export interface ModelGrantRowView {
  user_id: string
  model_id: string
  granted_at: Date
  granted_by: string | null
}

export class GrantInvalidInputError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'GrantInvalidInputError'
  }
}

export class GrantUserNotFoundError extends Error {
  constructor(userId: string) {
    super(`user not found: ${userId}`)
    this.name = 'GrantUserNotFoundError'
  }
}

export class GrantModelNotFoundError extends Error {
  constructor(modelId: string) {
    super(`model not found: ${modelId}`)
    this.name = 'GrantModelNotFoundError'
  }
}

function normalizeUserId(v: string | number | bigint): string {
  if (typeof v === 'bigint') {
    if (v <= 0n) throw new GrantInvalidInputError('invalid_user_id')
    return v.toString()
  }
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v <= 0) throw new GrantInvalidInputError('invalid_user_id')
    return v.toString()
  }
  if (!ID_RE.test(v)) throw new GrantInvalidInputError('invalid_user_id')
  return v
}

function normalizeModelId(v: string): string {
  if (typeof v !== 'string' || !MODEL_ID_RE.test(v)) {
    throw new GrantInvalidInputError('invalid_model_id')
  }
  return v
}

/**
 * 列出指定用户的所有授权,按 model_id 字典序。
 *
 * 仅查 grants 表,不 join model_pricing —— 即便对应 model 未来被删,grants 行
 * 也会因 ON DELETE CASCADE 自动清理;此时这里 trivially 返回缩短后的列表。
 */
export async function listGrantsForUser(
  userId: string | number | bigint,
): Promise<ModelGrantRowView[]> {
  const uid = normalizeUserId(userId)
  const r = await query<ModelGrantRowView>(
    `SELECT user_id::text       AS user_id,
            model_id,
            granted_at,
            granted_by::text    AS granted_by
       FROM model_visibility_grants
      WHERE user_id = $1::bigint
      ORDER BY model_id`,
    [uid],
  )
  return r.rows
}

/**
 * 给指定用户授权某个模型。事务内同时写 admin_audit(仅在实际新增时)。
 *
 * 失败模式:
 *   - GrantUserNotFoundError:user_id 在 users 表里不存在
 *   - GrantModelNotFoundError:model_id 在 model_pricing 表里不存在
 *   - 唯一约束 (user_id, model_id) 已存在:返 inserted=false,**不写** audit
 *
 * 不校验 visibility —— admin 可以给 visibility=public 的模型也加 grant,虽然没
 * 实际效果(public 已对所有人可见),但保留 grant 表的"授权台帐"语义。listForUser
 * 见到 public 直接 true,grants 集合不影响判定。
 */
export async function addGrant(
  userId: string | number | bigint,
  modelId: string,
  ctx: {
    adminId: bigint | number | string
    ip?: string | null
    userAgent?: string | null
  },
): Promise<{ inserted: boolean; row: ModelGrantRowView }> {
  const uid = normalizeUserId(userId)
  const mid = normalizeModelId(modelId)
  return tx(async (client: PoolClient) => {
    // 用户存在性 —— FK 会兜底,但提前抛清晰错误码,前端 UX 友好
    const userR = await client.query<{ id: string }>(
      'SELECT id::text AS id FROM users WHERE id = $1::bigint',
      [uid],
    )
    if (userR.rows.length === 0) throw new GrantUserNotFoundError(uid)

    const modelR = await client.query<{ model_id: string }>(
      'SELECT model_id FROM model_pricing WHERE model_id = $1',
      [mid],
    )
    if (modelR.rows.length === 0) throw new GrantModelNotFoundError(mid)

    const ins = await client.query<ModelGrantRowView>(
      `INSERT INTO model_visibility_grants(user_id, model_id, granted_by)
       VALUES ($1::bigint, $2, $3::bigint)
       ON CONFLICT (user_id, model_id) DO NOTHING
       RETURNING user_id::text     AS user_id,
                 model_id,
                 granted_at,
                 granted_by::text  AS granted_by`,
      [uid, mid, String(ctx.adminId)],
    )
    if (ins.rows.length === 0) {
      // 已存在 —— 取出现行行返回,**不写**审计(避免重复点击刷脏审计)
      const existing = await client.query<ModelGrantRowView>(
        `SELECT user_id::text       AS user_id,
                model_id,
                granted_at,
                granted_by::text    AS granted_by
           FROM model_visibility_grants
          WHERE user_id = $1::bigint AND model_id = $2`,
        [uid, mid],
      )
      return { inserted: false, row: existing.rows[0] }
    }

    const row = ins.rows[0]
    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: 'model_grant.add',
      target: `user:${uid}/model:${mid}`,
      before: null,
      after: { user_id: uid, model_id: mid, granted_by: String(ctx.adminId) },
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    })
    return { inserted: true, row }
  })
}

/**
 * 撤销授权。事务内同时写 admin_audit(仅在实际删除时)。
 *
 * 删不存在的 grant 返回 deleted=false,**不抛**(idempotent)。前端拿到 deleted=false
 * 可显示 "授权已不存在"。
 */
export async function removeGrant(
  userId: string | number | bigint,
  modelId: string,
  ctx: {
    adminId: bigint | number | string
    ip?: string | null
    userAgent?: string | null
  },
): Promise<{ deleted: boolean }> {
  const uid = normalizeUserId(userId)
  const mid = normalizeModelId(modelId)
  return tx(async (client: PoolClient) => {
    const before = await client.query<ModelGrantRowView>(
      `SELECT user_id::text       AS user_id,
              model_id,
              granted_at,
              granted_by::text    AS granted_by
         FROM model_visibility_grants
        WHERE user_id = $1::bigint AND model_id = $2
        FOR UPDATE`,
      [uid, mid],
    )
    if (before.rows.length === 0) return { deleted: false }

    await client.query(
      `DELETE FROM model_visibility_grants
        WHERE user_id = $1::bigint AND model_id = $2`,
      [uid, mid],
    )

    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: 'model_grant.remove',
      target: `user:${uid}/model:${mid}`,
      before: before.rows[0],
      after: null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    })
    return { deleted: true }
  })
}
