/**
 * T-60 — 超管账号池 CRUD 包装层。
 *
 * ### 与 account-pool/store 的分工
 * - store.ts 是底层 CRUD + AEAD 加解密
 * - 本文件只负责 "admin 上下文下触发 store + 落 admin_audit"
 *
 * ### 审计策略(非事务,best-effort)
 * store.ts 的 API 不是 tx-aware(内部用 `query()` 直连 pool),我们不想改它。
 * 因此超管 API 的流程是:
 *   1. 调 store.createAccount / updateAccount / deleteAccount
 *   2. 成功后调 writeAdminAudit(pool)
 *
 * 若 (2) 失败(极少见 — 审计表写入报错),admin 已完成的账号变更不会回滚:
 *   - 主要数据变更不能因为审计表抖动而回退(admin 期望行为已完成)
 *   - 审计失败会走两路上报:
 *     (a) `admin_audit_write_failures_total{action=...}` counter → Prometheus 告警
 *     (b) `ctx.onAuditError`(HTTP 未传 → stderr 兜底)→ 详细错误内容
 *
 * ### 审计内容
 * before/after 只保留 "admin 显式提交的字段"。原因:
 *   - 不把 oauth_expires_at / last_used_at / health_score 等 scheduler 写的字段混入
 *   - 避免密文/nonce Buffer 出现在 audit JSON —— 触发 JSON.stringify 乱码 + 泄密
 *
 * token / refresh 的明文 **永远不进 audit**;只记 `"token": "<redacted>"` 之类占位。
 */

import { getPool } from "../db/index.js";
import {
  ACCOUNT_PLANS,
  ACCOUNT_STATUSES,
  AccountNotFoundError,
  createAccount as storeCreate,
  deleteAccount as storeDelete,
  getAccount as storeGet,
  listAccounts as storeList,
  updateAccount as storeUpdate,
  type AccountPlan,
  type AccountRow,
  type AccountStatus,
  type CreateAccountInput,
  type ListAccountsOptions,
  type UpdateAccountPatch,
} from "../account-pool/store.js";
import { writeAdminAudit } from "./audit.js";
import { incrAdminAuditWriteFailure } from "./metrics.js";

export interface AdminAuditCtx {
  adminId: bigint | number | string;
  ip?: string | null;
  userAgent?: string | null;
  /** 可选:审计写失败回调(生产应挂监控)。默认 stderr。 */
  onAuditError?: (err: unknown) => void;
}

function defaultAuditErrorLog(err: unknown): void {
  // eslint-disable-next-line no-console
  console.error("[admin/accounts] admin_audit write failed:", err);
}

/**
 * 在主操作成功后写审计;审计失败不冒泡。
 */
async function bestEffortAudit(
  ctx: AdminAuditCtx,
  action: string,
  target: string | null,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  try {
    await writeAdminAudit(getPool(), {
      adminId: ctx.adminId,
      action,
      target,
      before,
      after,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  } catch (err) {
    // 两路上报,保证不管 HTTP 层有没有传 onAuditError,运维都能看到:
    //   1) Prometheus counter(admin_audit_write_failures_total{action=...})→ 告警
    //   2) ctx.onAuditError(或 stderr)→ 详细错误
    incrAdminAuditWriteFailure(action);
    (ctx.onAuditError ?? defaultAuditErrorLog)(err);
  }
}

/** AccountRow 序列化到 audit 安全子集:固定字段,永远不含密文/nonce。 */
function snapshotForAudit(r: AccountRow): Record<string, unknown> {
  return {
    id: r.id.toString(),
    label: r.label,
    plan: r.plan,
    status: r.status,
    health_score: r.health_score,
  };
}

// ─── 查询 ──────────────────────────────────────────────────────────

export async function adminListAccounts(opts: ListAccountsOptions = {}): Promise<AccountRow[]> {
  return storeList(opts);
}

export async function adminGetAccount(id: bigint | string): Promise<AccountRow | null> {
  return storeGet(id);
}

// ─── Create ────────────────────────────────────────────────────────

export interface AdminCreateAccountInput {
  label: string;
  plan: AccountPlan;
  oauth_token: string;
  oauth_refresh_token?: string | null;
  oauth_expires_at?: Date | string | null;
}

export async function adminCreateAccount(
  input: AdminCreateAccountInput,
  ctx: AdminAuditCtx,
): Promise<AccountRow> {
  if (!ACCOUNT_PLANS.includes(input.plan)) throw new RangeError("invalid_plan");
  if (typeof input.label !== "string" || input.label.trim().length === 0 || input.label.length > 120) {
    throw new RangeError("invalid_label");
  }
  if (typeof input.oauth_token !== "string" || input.oauth_token.length === 0) {
    throw new RangeError("invalid_oauth_token");
  }
  let expiresAt: Date | null = null;
  if (input.oauth_expires_at !== undefined && input.oauth_expires_at !== null) {
    const d = typeof input.oauth_expires_at === "string"
      ? new Date(input.oauth_expires_at)
      : input.oauth_expires_at;
    if (Number.isNaN(d.getTime())) throw new RangeError("invalid_oauth_expires_at");
    expiresAt = d;
  }
  const refresh =
    input.oauth_refresh_token === null || input.oauth_refresh_token === undefined
      ? null
      : input.oauth_refresh_token;
  if (refresh !== null && (typeof refresh !== "string" || refresh.length === 0)) {
    throw new RangeError("invalid_oauth_refresh_token");
  }

  const createInput: CreateAccountInput = {
    label: input.label.trim(),
    plan: input.plan,
    token: input.oauth_token,
    refresh,
    expires_at: expiresAt,
  };
  const row = await storeCreate(createInput);

  await bestEffortAudit(
    ctx,
    "account.create",
    `account:${row.id}`,
    null,
    {
      ...snapshotForAudit(row),
      has_refresh_token: refresh !== null,
      // 不记明文 token
    },
  );
  return row;
}

// ─── Patch ────────────────────────────────────────────────────────

export interface AdminPatchAccountInput {
  label?: string;
  plan?: AccountPlan;
  status?: AccountStatus;
  health_score?: number;
  oauth_token?: string;
  oauth_refresh_token?: string | null;
  oauth_expires_at?: Date | string | null;
}

export async function adminPatchAccount(
  id: bigint | string,
  patch: AdminPatchAccountInput,
  ctx: AdminAuditCtx,
): Promise<AccountRow> {
  // 前置校验
  if (patch.plan !== undefined && !ACCOUNT_PLANS.includes(patch.plan)) {
    throw new RangeError("invalid_plan");
  }
  if (patch.status !== undefined && !ACCOUNT_STATUSES.includes(patch.status)) {
    throw new RangeError("invalid_status");
  }
  if (patch.health_score !== undefined) {
    if (!Number.isInteger(patch.health_score) || patch.health_score < 0 || patch.health_score > 100) {
      throw new RangeError("invalid_health_score");
    }
  }
  if (patch.label !== undefined) {
    if (typeof patch.label !== "string" || patch.label.trim().length === 0 || patch.label.length > 120) {
      throw new RangeError("invalid_label");
    }
  }
  if (patch.oauth_token !== undefined) {
    if (typeof patch.oauth_token !== "string" || patch.oauth_token.length === 0) {
      throw new RangeError("invalid_oauth_token");
    }
  }
  if (patch.oauth_refresh_token !== undefined && patch.oauth_refresh_token !== null) {
    if (typeof patch.oauth_refresh_token !== "string" || patch.oauth_refresh_token.length === 0) {
      throw new RangeError("invalid_oauth_refresh_token");
    }
  }
  let expiresAt: Date | null | undefined = undefined;
  if (patch.oauth_expires_at !== undefined) {
    if (patch.oauth_expires_at === null) {
      expiresAt = null;
    } else {
      const d = typeof patch.oauth_expires_at === "string"
        ? new Date(patch.oauth_expires_at)
        : patch.oauth_expires_at;
      if (Number.isNaN(d.getTime())) throw new RangeError("invalid_oauth_expires_at");
      expiresAt = d;
    }
  }

  const touched =
    patch.label !== undefined ||
    patch.plan !== undefined ||
    patch.status !== undefined ||
    patch.health_score !== undefined ||
    patch.oauth_token !== undefined ||
    patch.oauth_refresh_token !== undefined ||
    expiresAt !== undefined;
  if (!touched) {
    const cur = await storeGet(id);
    if (!cur) throw new AccountNotFoundError(id);
    return cur;
  }

  const before = await storeGet(id);
  if (!before) throw new AccountNotFoundError(id);

  const storePatch: UpdateAccountPatch = {};
  if (patch.label !== undefined) storePatch.label = patch.label.trim();
  if (patch.plan !== undefined) storePatch.plan = patch.plan;
  if (patch.status !== undefined) storePatch.status = patch.status;
  if (patch.health_score !== undefined) storePatch.health_score = patch.health_score;
  if (patch.oauth_token !== undefined) storePatch.token = patch.oauth_token;
  if (patch.oauth_refresh_token !== undefined) storePatch.refresh = patch.oauth_refresh_token;
  if (expiresAt !== undefined) storePatch.oauth_expires_at = expiresAt;

  const after = await storeUpdate(id, storePatch);
  if (!after) throw new AccountNotFoundError(id);

  // audit: 只记 admin 显式改的字段,密文字段只记 "*_changed" 布尔
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};
  if (patch.label !== undefined) { changedBefore.label = before.label; changedAfter.label = after.label; }
  if (patch.plan !== undefined) { changedBefore.plan = before.plan; changedAfter.plan = after.plan; }
  if (patch.status !== undefined) { changedBefore.status = before.status; changedAfter.status = after.status; }
  if (patch.health_score !== undefined) {
    changedBefore.health_score = before.health_score;
    changedAfter.health_score = after.health_score;
  }
  if (patch.oauth_token !== undefined) {
    changedBefore.oauth_token_changed = true;
    changedAfter.oauth_token_changed = true;
  }
  if (patch.oauth_refresh_token !== undefined) {
    changedBefore.oauth_refresh_token_changed = true;
    changedAfter.oauth_refresh_token = patch.oauth_refresh_token === null ? "<cleared>" : "<rotated>";
  }
  if (expiresAt !== undefined) {
    changedBefore.oauth_expires_at = before.oauth_expires_at?.toISOString() ?? null;
    changedAfter.oauth_expires_at = after.oauth_expires_at?.toISOString() ?? null;
  }

  await bestEffortAudit(ctx, "account.patch", `account:${String(id)}`, changedBefore, changedAfter);
  return after;
}

// ─── Delete ──────────────────────────────────────────────────────

export async function adminDeleteAccount(
  id: bigint | string,
  ctx: AdminAuditCtx,
): Promise<boolean> {
  const before = await storeGet(id);
  if (!before) return false;

  const deleted = await storeDelete(id);
  if (!deleted) return false;

  await bestEffortAudit(
    ctx,
    "account.delete",
    `account:${String(id)}`,
    snapshotForAudit(before),
    null,
  );
  return true;
}
