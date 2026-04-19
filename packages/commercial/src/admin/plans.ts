/**
 * T-60 — 超管 topup_plans 管理。
 *
 * ### 允许改哪些字段
 * - `label`        TEXT(长度 1..120)
 * - `amount_cents` BIGINT ≥ 0(0 表示免费送,比较少见但合法)
 * - `credits`      BIGINT ≥ 0
 * - `sort_order`   INTEGER(越大越靠前,与 model_pricing 一致)
 * - `enabled`      boolean
 *
 * `code` 不允许改 —— 它是稳定的业务键,订单/对账都引用它,重命名会拉出一堆引用断链。
 * 需要换 code 走新增 + 禁用旧的。
 *
 * ### 同事务审计
 * 所有 PATCH 原子:UPDATE topup_plans + INSERT admin_audit。target 写 `plan:<code>`。
 *
 * ### 为什么不发 NOTIFY
 * topup_plans 每次请求直接读,没有进程内缓存,不需要通知。
 */

import type { PoolClient } from "pg";
import { query, tx } from "../db/queries.js";
import { writeAdminAudit } from "./audit.js";

export interface TopupPlanRowView {
  id: string;
  code: string;
  label: string;
  amount_cents: string;
  credits: string;
  sort_order: number;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

const PLAN_COLS = `
  id::text          AS id,
  code,
  label,
  amount_cents::text AS amount_cents,
  credits::text      AS credits,
  sort_order,
  enabled,
  created_at,
  updated_at
`;

/** code 白名单:字母数字 + _ + -,1..64。 */
const PLAN_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function listPlans(): Promise<TopupPlanRowView[]> {
  const r = await query<TopupPlanRowView>(
    `SELECT ${PLAN_COLS} FROM topup_plans ORDER BY sort_order DESC, code`,
  );
  return r.rows;
}

// ─── PATCH ─────────────────────────────────────────────────────────

export interface PatchPlanInput {
  label?: string;
  amount_cents?: string | number | bigint;
  credits?: string | number | bigint;
  sort_order?: number;
  enabled?: boolean;
}

export interface PatchPlanCtx {
  adminId: bigint | number | string;
  ip?: string | null;
  userAgent?: string | null;
}

export class PlanNotFoundError extends Error {
  constructor(code: string) { super(`topup_plan not found: ${code}`); this.name = "PlanNotFoundError"; }
}

/** BIGINT ≥ 0 校验 → 返清洁十进制字符串。 */
function normalizeNonNegBigint(v: unknown, field: string): string {
  let s: string;
  if (typeof v === "bigint") {
    s = v.toString();
  } else if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new RangeError(`invalid_${field}`);
    s = String(v);
  } else if (typeof v === "string") {
    s = v.trim();
  } else {
    throw new RangeError(`invalid_${field}`);
  }
  if (!/^[0-9]{1,20}$/.test(s)) throw new RangeError(`invalid_${field}`);
  // PG BIGINT max = 9223372036854775807(19 位);20 位必须 ≤ 此值,但简单点就不细算了 —— 业务上不可能发生
  return s;
}

/**
 * 修改单个套餐(以 code 定位)。空 patch → 直接返当前行。
 */
export async function patchPlan(
  code: string,
  patch: PatchPlanInput,
  ctx: PatchPlanCtx,
): Promise<TopupPlanRowView> {
  if (!PLAN_CODE_RE.test(code)) throw new RangeError("invalid_plan_code");

  const touched =
    patch.label !== undefined ||
    patch.amount_cents !== undefined ||
    patch.credits !== undefined ||
    patch.sort_order !== undefined ||
    patch.enabled !== undefined;
  if (!touched) {
    const cur = await query<TopupPlanRowView>(
      `SELECT ${PLAN_COLS} FROM topup_plans WHERE code = $1`, [code],
    );
    if (cur.rows.length === 0) throw new PlanNotFoundError(code);
    return cur.rows[0];
  }

  // 预校验(在事务外失败省一次连接)
  let labelNorm: string | undefined;
  if (patch.label !== undefined) {
    if (typeof patch.label !== "string") throw new RangeError("invalid_label");
    const l = patch.label.trim();
    if (l.length === 0 || l.length > 120) throw new RangeError("invalid_label");
    labelNorm = l;
  }
  let amountNorm: string | undefined;
  if (patch.amount_cents !== undefined) amountNorm = normalizeNonNegBigint(patch.amount_cents, "amount_cents");
  let creditsNorm: string | undefined;
  if (patch.credits !== undefined) creditsNorm = normalizeNonNegBigint(patch.credits, "credits");
  if (patch.sort_order !== undefined) {
    if (!Number.isInteger(patch.sort_order) || patch.sort_order < 0 || patch.sort_order > 10000) {
      throw new RangeError("invalid_sort_order");
    }
  }

  return tx(async (client: PoolClient) => {
    const before = await client.query<TopupPlanRowView>(
      `SELECT ${PLAN_COLS} FROM topup_plans WHERE code = $1 FOR UPDATE`,
      [code],
    );
    if (before.rows.length === 0) throw new PlanNotFoundError(code);

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown): void => {
      params.push(val); sets.push(`${col} = $${params.length}`);
    };
    if (labelNorm !== undefined) push("label", labelNorm);
    if (amountNorm !== undefined) push("amount_cents", amountNorm);
    if (creditsNorm !== undefined) push("credits", creditsNorm);
    if (patch.sort_order !== undefined) push("sort_order", patch.sort_order);
    if (patch.enabled !== undefined) push("enabled", patch.enabled);
    sets.push("updated_at = NOW()");

    params.push(code);
    const after = await client.query<TopupPlanRowView>(
      `UPDATE topup_plans SET ${sets.join(", ")} WHERE code = $${params.length}
       RETURNING ${PLAN_COLS}`,
      params,
    );

    const b = before.rows[0], a = after.rows[0];
    const changedBefore: Record<string, unknown> = {};
    const changedAfter: Record<string, unknown> = {};
    if (labelNorm !== undefined)         { changedBefore.label = b.label;               changedAfter.label = a.label; }
    if (amountNorm !== undefined)        { changedBefore.amount_cents = b.amount_cents; changedAfter.amount_cents = a.amount_cents; }
    if (creditsNorm !== undefined)       { changedBefore.credits = b.credits;           changedAfter.credits = a.credits; }
    if (patch.sort_order !== undefined)  { changedBefore.sort_order = b.sort_order;     changedAfter.sort_order = a.sort_order; }
    if (patch.enabled !== undefined)     { changedBefore.enabled = b.enabled;           changedAfter.enabled = a.enabled; }

    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: "plan.patch",
      target: `plan:${code}`,
      before: changedBefore,
      after: changedAfter,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    return a;
  });
}
