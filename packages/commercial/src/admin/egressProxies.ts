/**
 * V3 — Egress proxy pool admin module(决策 P/Q/R)。
 *
 * 数据模型见 migrations/0052_egress_proxies.sql:
 *   - id BIGSERIAL,label TEXT UNIQUE,url_enc/url_nonce(AES-256-GCM),
 *     status('active'|'disabled'),notes TEXT,created_at,updated_at
 *
 * 责任范围:
 *   - admin CRUD(list/get/create/patch/delete);AEAD 加密 URL;
 *     每次 UPDATE url 重新 randomBytes(12) nonce(决策 Q,nonce 不复用)
 *   - 读路径返还 masked URL(`maskEgressProxy`),**永远不返明文/密文/nonce**
 *   - 删除路径 ON DELETE SET NULL(0053 FK 决定),已绑账号自动 NULL,落 audit
 *   - 所有 mutate 写 admin_audit;失败 best-effort 不冒泡
 */

import { getPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { encrypt, decrypt } from "../crypto/aead.js";
import { loadKmsKey, zeroBuffer } from "../crypto/keys.js";
import { writeAdminAudit } from "./audit.js";
import { incrAdminAuditWriteFailure } from "./metrics.js";
import { maskEgressProxy } from "./accounts.js";

export type EgressProxyStatus = "active" | "disabled";
const STATUSES: readonly EgressProxyStatus[] = ["active", "disabled"];

export interface EgressProxyRow {
  id: bigint;
  label: string;
  status: EgressProxyStatus;
  notes: string | null;
  /** 给 UI 显示用 — `http://user:****@host:port`,绝不返明文。 */
  url_masked: string | null;
  created_at: Date;
  updated_at: Date;
}

interface RawRow {
  id: string;
  label: string;
  status: EgressProxyStatus;
  notes: string | null;
  url_enc: Buffer;
  url_nonce: Buffer;
  created_at: Date;
  updated_at: Date;
}

function rowToView(r: RawRow, keyFn: () => Buffer): EgressProxyRow {
  let masked: string | null = null;
  const key = keyFn();
  try {
    const url = decrypt(r.url_enc, r.url_nonce, key);
    masked = maskEgressProxy(url);
  } finally {
    zeroBuffer(key);
  }
  return {
    id: BigInt(r.id),
    label: r.label,
    status: r.status,
    notes: r.notes,
    url_masked: masked,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ─── audit helper ───────────────────────────────────────────────────

export interface EgressProxyAuditCtx {
  adminId: bigint | number | string;
  ip?: string | null;
  userAgent?: string | null;
}

async function audit(
  ctx: EgressProxyAuditCtx,
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
    incrAdminAuditWriteFailure(action);
    // eslint-disable-next-line no-console
    console.error("[admin/egressProxies] admin_audit write failed:", err);
  }
}

function snapshotForAudit(r: EgressProxyRow): Record<string, unknown> {
  return {
    id: r.id.toString(),
    label: r.label,
    status: r.status,
    notes: r.notes,
    // url_masked 已脱敏过,可入 audit;明文/密文 绝不入 audit。
    url_masked: r.url_masked,
  };
}

// ─── 校验 ───────────────────────────────────────────────────────────

function validateLabel(label: unknown): asserts label is string {
  if (typeof label !== "string" || label.trim().length === 0 || label.length > 120) {
    throw new RangeError("invalid_label");
  }
}

function validateUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) {
    throw new RangeError("invalid_url");
  }
  let u: URL;
  try { u = new URL(url); } catch { throw new RangeError("invalid_url"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new RangeError("invalid_url");
  if (!u.hostname) throw new RangeError("invalid_url");
}

function validateStatus(s: unknown): asserts s is EgressProxyStatus {
  if (!STATUSES.includes(s as EgressProxyStatus)) throw new RangeError("invalid_status");
}

function validateNotes(n: unknown): asserts n is string | null {
  if (n === null) return;
  if (typeof n !== "string" || n.length > 1000) throw new RangeError("invalid_notes");
}

// ─── 查询 ──────────────────────────────────────────────────────────

export interface ListEgressProxiesOptions {
  status?: EgressProxyStatus;
  /** UI dropdown 默认只取 active(决策 R);admin tab 列表传 'all' 看全部。 */
  limit?: number;
  offset?: number;
}

export async function listEgressProxies(
  opts: ListEgressProxiesOptions = {},
): Promise<EgressProxyRow[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
  const offset = Math.max(0, opts.offset ?? 0);
  const params: unknown[] = [];
  let where = "";
  if (opts.status !== undefined) {
    validateStatus(opts.status);
    params.push(opts.status);
    where = `WHERE status = $${params.length}`;
  }
  params.push(limit, offset);
  const r = await query<RawRow>(
    `SELECT id::text AS id, label, status, notes, url_enc, url_nonce,
            created_at, updated_at
     FROM egress_proxies
     ${where}
     ORDER BY id ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return r.rows.map((row) => rowToView(row, loadKmsKey));
}

export async function getEgressProxy(id: bigint | string): Promise<EgressProxyRow | null> {
  const r = await query<RawRow>(
    `SELECT id::text AS id, label, status, notes, url_enc, url_nonce,
            created_at, updated_at
     FROM egress_proxies WHERE id = $1`,
    [String(id)],
  );
  return r.rows[0] ? rowToView(r.rows[0], loadKmsKey) : null;
}

/**
 * 内部用 — 解密拿明文 URL。仅 store/scheduler JOIN 走该路径,**绝不**返
 * 给 admin HTTP 层。给 admin 看用 url_masked。
 */
export async function getEgressProxyUrlPlaintext(
  id: bigint | string,
): Promise<string | null> {
  const r = await query<{ url_enc: Buffer; url_nonce: Buffer; status: EgressProxyStatus }>(
    `SELECT url_enc, url_nonce, status FROM egress_proxies WHERE id = $1`,
    [String(id)],
  );
  if (!r.rows[0]) return null;
  if (r.rows[0].status !== "active") return null; // disabled entry 视作不可用
  const key = loadKmsKey();
  try {
    return decrypt(r.rows[0].url_enc, r.rows[0].url_nonce, key);
  } finally {
    zeroBuffer(key);
  }
}

// ─── Create ────────────────────────────────────────────────────────

export interface CreateEgressProxyInput {
  label: string;
  url: string;
  status?: EgressProxyStatus;
  notes?: string | null;
}

export class EgressProxyLabelTakenError extends Error {
  readonly code = "EGRESS_PROXY_LABEL_TAKEN";
  constructor(label: string) {
    super(`egress proxy label already in use: ${label}`);
    this.name = "EgressProxyLabelTakenError";
  }
}

export async function createEgressProxy(
  input: CreateEgressProxyInput,
  ctx: EgressProxyAuditCtx,
): Promise<EgressProxyRow> {
  validateLabel(input.label);
  validateUrl(input.url);
  if (input.status !== undefined) validateStatus(input.status);
  if (input.notes !== undefined) validateNotes(input.notes);

  const status: EgressProxyStatus = input.status ?? "active";
  const notes = input.notes ?? null;

  const key = loadKmsKey();
  let enc;
  try { enc = encrypt(input.url, key); } finally { zeroBuffer(key); }

  let row: RawRow;
  try {
    const r = await query<RawRow>(
      `INSERT INTO egress_proxies (label, url_enc, url_nonce, status, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id::text AS id, label, status, notes, url_enc, url_nonce,
                 created_at, updated_at`,
      [input.label.trim(), enc.ciphertext, enc.nonce, status, notes],
    );
    row = r.rows[0]!;
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
      throw new EgressProxyLabelTakenError(input.label);
    }
    throw err;
  }

  const view = rowToView(row, loadKmsKey);
  await audit(ctx, "egress_proxy.create", `egress_proxy:${view.id.toString()}`, null, snapshotForAudit(view));
  return view;
}

// ─── Patch ─────────────────────────────────────────────────────────

export interface PatchEgressProxyInput {
  label?: string;
  /** 改 URL 必须 regen nonce(0052/aead.ts 不允许 nonce 复用)。 */
  url?: string;
  status?: EgressProxyStatus;
  notes?: string | null;
}

export class EgressProxyNotFoundError extends Error {
  readonly code = "EGRESS_PROXY_NOT_FOUND";
  constructor(id: string) {
    super(`egress proxy not found: ${id}`);
    this.name = "EgressProxyNotFoundError";
  }
}

export async function patchEgressProxy(
  id: bigint | string,
  patch: PatchEgressProxyInput,
  ctx: EgressProxyAuditCtx,
): Promise<EgressProxyRow> {
  if (patch.label !== undefined) validateLabel(patch.label);
  if (patch.url !== undefined) validateUrl(patch.url);
  if (patch.status !== undefined) validateStatus(patch.status);
  if (patch.notes !== undefined) validateNotes(patch.notes);

  const before = await getEgressProxy(id);
  if (!before) throw new EgressProxyNotFoundError(String(id));

  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.label !== undefined) {
    params.push(patch.label.trim());
    sets.push(`label = $${params.length}`);
  }
  if (patch.url !== undefined) {
    const key = loadKmsKey();
    let enc;
    try { enc = encrypt(patch.url, key); } finally { zeroBuffer(key); }
    params.push(enc.ciphertext);
    sets.push(`url_enc = $${params.length}`);
    params.push(enc.nonce);
    sets.push(`url_nonce = $${params.length}`);
  }
  if (patch.status !== undefined) {
    params.push(patch.status);
    sets.push(`status = $${params.length}`);
  }
  if (patch.notes !== undefined) {
    params.push(patch.notes);
    sets.push(`notes = $${params.length}`);
  }

  if (sets.length === 0) return before; // no-op patch
  sets.push(`updated_at = NOW()`);
  params.push(String(id));

  let row: RawRow;
  try {
    const r = await query<RawRow>(
      `UPDATE egress_proxies SET ${sets.join(", ")}
       WHERE id = $${params.length}
       RETURNING id::text AS id, label, status, notes, url_enc, url_nonce,
                 created_at, updated_at`,
      params,
    );
    if (!r.rows[0]) throw new EgressProxyNotFoundError(String(id));
    row = r.rows[0];
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "23505") {
      throw new EgressProxyLabelTakenError(patch.label ?? "<unknown>");
    }
    throw err;
  }

  const after = rowToView(row, loadKmsKey);
  await audit(
    ctx,
    "egress_proxy.patch",
    `egress_proxy:${after.id.toString()}`,
    snapshotForAudit(before),
    snapshotForAudit(after),
  );
  return after;
}

// ─── Delete ────────────────────────────────────────────────────────

export interface DeleteEgressProxyResult {
  deleted: boolean;
  /** 0053 ON DELETE SET NULL — 这次 DELETE 顺手把多少 claude_accounts 行的 egress_proxy_id 置 NULL。 */
  unbound_account_count: number;
}

export async function deleteEgressProxy(
  id: bigint | string,
  ctx: EgressProxyAuditCtx,
): Promise<DeleteEgressProxyResult> {
  const before = await getEgressProxy(id);
  if (!before) return { deleted: false, unbound_account_count: 0 };

  // 先看会影响多少 claude_accounts 行 — 0053 FK ON DELETE SET NULL 自动 unbind,
  // 这里只是为了 audit 记录。注意 claude_accounts 数量很可控(admin 池规模),
  // 简单 COUNT 不会有性能问题。
  const cnt = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM claude_accounts WHERE egress_proxy_id = $1`,
    [String(id)],
  );
  const unbound = Number(cnt.rows[0]?.c ?? "0");

  const r = await query<{ id: string }>(
    `DELETE FROM egress_proxies WHERE id = $1 RETURNING id::text AS id`,
    [String(id)],
  );
  const deleted = (r.rows[0]?.id ?? null) !== null;
  if (!deleted) return { deleted: false, unbound_account_count: 0 };

  await audit(
    ctx,
    "egress_proxy.delete",
    `egress_proxy:${before.id.toString()}`,
    { ...snapshotForAudit(before), unbound_account_count: unbound },
    null,
  );
  return { deleted: true, unbound_account_count: unbound };
}
