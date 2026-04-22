/**
 * T-63 — admin 告警通道 CRUD(目前只有 ilink_wechat,预留多 channel_type)。
 *
 * iLink bot_token 使用 AES-256-GCM 加密后存 DB:
 *   - encrypt() 返 {ciphertext, nonce},nonce 每次 random → 同 token 多次加密密文不同
 *   - 明文永不落库,也不返回给前端;只有 ilinkAlertWorker 在 long-poll / send 时解密
 *   - 审计写 admin_audit,不记录明文或密文,只记 id + label + account_id
 *
 * Activation 状态机:
 *   pending (扫码成功,bot_token 已存) →
 *     收到 admin 给 bot 的第一条入站消息(context_token 被 worker 持久化) → active
 *     session expired / long-poll 连错 → error
 *     admin 禁用 → disabled
 */

import type { PoolClient } from "pg";
import { query, tx, type QueryRunner } from "../db/queries.js";
import { encrypt, decrypt, AeadError } from "../crypto/aead.js";
import { loadKmsKey } from "../crypto/keys.js";
import { writeAdminAudit } from "./audit.js";

export type ChannelType = "ilink_wechat";
export type Severity = "info" | "warning" | "critical";
export type ActivationStatus = "pending" | "active" | "disabled" | "error";

export interface AlertChannelRow {
  id: string;
  admin_id: string;
  channel_type: ChannelType;
  label: string;
  enabled: boolean;
  severity_min: Severity;
  event_types: string[];
  /** iLink bot 身份 */
  ilink_account_id: string | null;
  /** 扫码者的 wechat ilink_user_id */
  ilink_login_user_id: string | null;
  /** 告警接收端(一般等于 ilink_login_user_id) */
  target_sender_id: string | null;
  activation_status: ActivationStatus;
  last_inbound_at: string | null;
  last_send_at: string | null;
  last_error: string | null;
  /** 是否已捕获 context_token(用于 UI 显示"可发送") */
  has_context_token: boolean;
  created_at: string;
  updated_at: string;
}

export class ChannelNotFoundError extends Error {
  constructor(id: string | number | bigint) {
    super(`alert channel not found: ${id}`);
    this.name = "ChannelNotFoundError";
  }
}

/** 解密后给 worker 用的完整 secrets;调用后 token.fill(0) 风险由调用方自理。 */
export interface ChannelSecrets {
  botToken: string;
  contextToken: string | null;
  getUpdatesBuf: string;
  targetSenderId: string | null;
  ilinkAccountId: string | null;
}

const LABEL_RE = /^[\p{L}\p{N} _./:()\-]{1,64}$/u;
const EVENT_TYPE_RE = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;

function normalizeEventTypes(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new RangeError("event_types must be array");
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string") throw new RangeError("event_types item must be string");
    if (!EVENT_TYPE_RE.test(x)) throw new RangeError(`invalid event_type: ${x}`);
    out.push(x);
  }
  // 去重保持顺序
  return Array.from(new Set(out));
}

function validateSeverity(s: unknown): Severity {
  if (s !== "info" && s !== "warning" && s !== "critical") {
    throw new RangeError("severity_min must be info|warning|critical");
  }
  return s;
}

function validateLabel(s: unknown): string {
  if (typeof s !== "string") throw new RangeError("label must be string");
  const t = s.trim();
  if (!LABEL_RE.test(t)) throw new RangeError("label must be 1-64 unicode chars");
  return t;
}

function rowToView(r: Record<string, unknown>): AlertChannelRow {
  let events: string[] = [];
  if (Array.isArray(r.event_types)) events = r.event_types as string[];
  return {
    id: String(r.id),
    admin_id: String(r.admin_id),
    channel_type: r.channel_type as ChannelType,
    label: r.label as string,
    enabled: r.enabled as boolean,
    severity_min: r.severity_min as Severity,
    event_types: events,
    ilink_account_id: (r.ilink_account_id as string | null) ?? null,
    ilink_login_user_id: (r.ilink_login_user_id as string | null) ?? null,
    target_sender_id: (r.target_sender_id as string | null) ?? null,
    activation_status: r.activation_status as ActivationStatus,
    last_inbound_at: r.last_inbound_at ? (r.last_inbound_at as Date).toISOString() : null,
    last_send_at: r.last_send_at ? (r.last_send_at as Date).toISOString() : null,
    last_error: (r.last_error as string | null) ?? null,
    has_context_token: Boolean(r.has_context_token),
    created_at: (r.created_at as Date).toISOString(),
    updated_at: (r.updated_at as Date).toISOString(),
  };
}

const SELECT_COLUMNS = `
  id::text AS id,
  admin_id::text AS admin_id,
  channel_type,
  label,
  enabled,
  severity_min,
  COALESCE(event_types, '[]'::jsonb) AS event_types,
  ilink_account_id,
  ilink_login_user_id,
  target_sender_id,
  activation_status,
  last_inbound_at,
  last_send_at,
  last_error,
  (context_token IS NOT NULL AND length(context_token) > 0) AS has_context_token,
  created_at,
  updated_at
`;

// ─── CRUD ─────────────────────────────────────────────────────────────

/** 列出所有通道(admin UI 用;不分 admin,超管能看全部以便运维协作)。 */
export async function listAlertChannels(): Promise<AlertChannelRow[]> {
  const r = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM admin_alert_channels ORDER BY id DESC`,
  );
  return r.rows.map(rowToView);
}

export async function getAlertChannel(id: string | number | bigint): Promise<AlertChannelRow | null> {
  const r = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM admin_alert_channels WHERE id = $1`,
    [String(id)],
  );
  return r.rows.length === 0 ? null : rowToView(r.rows[0]);
}

export interface CreateIlinkChannelInput {
  adminId: bigint | number | string;
  label: string;
  botToken: string;
  ilinkAccountId: string;
  ilinkLoginUserId: string;
  /** 默认 = ilinkLoginUserId(告警发回给扫码者自己) */
  targetSenderId?: string;
  severityMin?: Severity;
  eventTypes?: string[];
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * 扫码成功后落库:AEAD 加密 bot_token,通道先进 pending 态,
 * 等 ilinkAlertWorker 第一次收到入站消息再转 active。
 */
export async function createIlinkChannel(input: CreateIlinkChannelInput): Promise<AlertChannelRow> {
  const label = validateLabel(input.label);
  const severity = validateSeverity(input.severityMin ?? "warning");
  const events = normalizeEventTypes(input.eventTypes ?? []);
  if (!input.botToken || input.botToken.length < 8) {
    throw new RangeError("botToken invalid");
  }
  if (!input.ilinkAccountId || !input.ilinkLoginUserId) {
    throw new RangeError("ilink ids missing");
  }
  const target = input.targetSenderId ?? input.ilinkLoginUserId;

  const kmsKey = loadKmsKey();
  const enc = encrypt(input.botToken, kmsKey);
  kmsKey.fill(0);

  return tx(async (client: PoolClient) => {
    // 2026-04-23 Codex FAIL finding #2:前端 /ilink/poll 在多 tab / 重复点击
    // 场景下会并发走到这里,同一 (admin, bot account, wechat user) 被多插几份
    // 通道。依靠 idx_aac_ilink_identity partial unique 去重,拿到 0 行说明已
    // 存在 → 回读返回(不额外再写 audit,避免每次重复扫码都刷一条 audit)。
    const ins = await client.query<Record<string, unknown>>(
      `INSERT INTO admin_alert_channels(
         admin_id, channel_type, label, enabled, severity_min, event_types,
         bot_token_enc, bot_token_nonce,
         ilink_account_id, ilink_login_user_id, target_sender_id,
         activation_status,
         updated_by
       ) VALUES (
         $1::bigint, 'ilink_wechat', $2, TRUE, $3, $4::jsonb,
         $5, $6,
         $7, $8, $9,
         'pending',
         $1::bigint
       )
       ON CONFLICT (admin_id, ilink_account_id, ilink_login_user_id)
         WHERE channel_type = 'ilink_wechat'
           AND ilink_account_id IS NOT NULL
           AND ilink_login_user_id IS NOT NULL
         DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [
        String(input.adminId),
        label,
        severity,
        JSON.stringify(events),
        enc.ciphertext,
        enc.nonce,
        input.ilinkAccountId,
        input.ilinkLoginUserId,
        target,
      ],
    );

    if (ins.rows.length === 0) {
      // 并发重复扫码 → 返回已存在的那条
      const existing = await client.query<Record<string, unknown>>(
        `SELECT ${SELECT_COLUMNS} FROM admin_alert_channels
          WHERE admin_id = $1::bigint
            AND channel_type = 'ilink_wechat'
            AND ilink_account_id = $2
            AND ilink_login_user_id = $3`,
        [String(input.adminId), input.ilinkAccountId, input.ilinkLoginUserId],
      );
      if (existing.rows.length === 0) {
        // 概率极低,但要打回可追溯错误
        throw new Error("alert channel upsert conflicted but cannot find existing row");
      }
      return rowToView(existing.rows[0]);
    }

    const row = rowToView(ins.rows[0]);
    await writeAdminAudit(client, {
      adminId: input.adminId,
      action: "alert_channel.create",
      target: `channel:${row.id}`,
      after: {
        channel_type: row.channel_type,
        label: row.label,
        severity_min: row.severity_min,
        event_types: row.event_types,
        ilink_account_id: row.ilink_account_id,
      },
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
    return row;
  });
}

export interface PatchAlertChannelInput {
  adminId: bigint | number | string;
  id: string | number | bigint;
  label?: string;
  enabled?: boolean;
  severityMin?: Severity;
  eventTypes?: string[];
  ip?: string | null;
  userAgent?: string | null;
}

/** PATCH 可改字段:label / enabled / severity_min / event_types。不能改 iLink 身份字段。 */
export async function patchAlertChannel(input: PatchAlertChannelInput): Promise<AlertChannelRow> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const after: Record<string, unknown> = {};

  if (input.label !== undefined) {
    const v = validateLabel(input.label);
    params.push(v);
    sets.push(`label = $${params.length}`);
    after.label = v;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new RangeError("enabled must be boolean");
    params.push(input.enabled);
    sets.push(`enabled = $${params.length}`);
    after.enabled = input.enabled;
  }
  if (input.severityMin !== undefined) {
    const v = validateSeverity(input.severityMin);
    params.push(v);
    sets.push(`severity_min = $${params.length}`);
    after.severity_min = v;
  }
  if (input.eventTypes !== undefined) {
    const v = normalizeEventTypes(input.eventTypes);
    params.push(JSON.stringify(v));
    sets.push(`event_types = $${params.length}::jsonb`);
    after.event_types = v;
  }
  if (sets.length === 0) {
    const existing = await getAlertChannel(input.id);
    if (!existing) throw new ChannelNotFoundError(input.id);
    return existing;
  }

  return tx(async (client: PoolClient) => {
    const before = await client.query<Record<string, unknown>>(
      `SELECT ${SELECT_COLUMNS} FROM admin_alert_channels WHERE id = $1 FOR UPDATE`,
      [String(input.id)],
    );
    if (before.rows.length === 0) throw new ChannelNotFoundError(input.id);
    const beforeView = rowToView(before.rows[0]);

    params.push(String(input.adminId));
    sets.push(`updated_by = $${params.length}::bigint`);
    sets.push(`updated_at = NOW()`);
    params.push(String(input.id));
    const upd = await client.query<Record<string, unknown>>(
      `UPDATE admin_alert_channels SET ${sets.join(", ")} WHERE id = $${params.length}
       RETURNING ${SELECT_COLUMNS}`,
      params,
    );
    const row = rowToView(upd.rows[0]);

    await writeAdminAudit(client, {
      adminId: input.adminId,
      action: "alert_channel.patch",
      target: `channel:${row.id}`,
      before: {
        label: beforeView.label,
        enabled: beforeView.enabled,
        severity_min: beforeView.severity_min,
        event_types: beforeView.event_types,
      },
      after,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
    return row;
  });
}

export async function deleteAlertChannel(
  adminId: bigint | number | string,
  id: string | number | bigint,
  ip?: string | null,
  userAgent?: string | null,
): Promise<void> {
  await tx(async (client: PoolClient) => {
    const before = await client.query<Record<string, unknown>>(
      `SELECT ${SELECT_COLUMNS} FROM admin_alert_channels WHERE id = $1 FOR UPDATE`,
      [String(id)],
    );
    if (before.rows.length === 0) throw new ChannelNotFoundError(id);
    const beforeView = rowToView(before.rows[0]);
    await client.query(`DELETE FROM admin_alert_channels WHERE id = $1`, [String(id)]);
    await writeAdminAudit(client, {
      adminId,
      action: "alert_channel.delete",
      target: `channel:${id}`,
      before: {
        label: beforeView.label,
        channel_type: beforeView.channel_type,
        ilink_account_id: beforeView.ilink_account_id,
      },
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  });
}

// ─── worker-facing helpers(不对外暴露) ──────────────────────────────

/**
 * 取解密后的完整 secrets。**仅 ilinkAlertWorker / adminAlerts(test send)调用。**
 * 返回的 botToken 用完应由调用方 fill(0)(或至少不传出边界)。
 */
export async function loadChannelSecrets(
  id: string | number | bigint,
  runner: QueryRunner = (undefined as unknown) as QueryRunner,
): Promise<ChannelSecrets | null> {
  const r = await (runner ?? { query: query as any }).query<{
    bot_token_enc: Buffer | null;
    bot_token_nonce: Buffer | null;
    context_token: string | null;
    get_updates_buf: string | null;
    target_sender_id: string | null;
    ilink_account_id: string | null;
  }>(
    `SELECT bot_token_enc, bot_token_nonce,
            context_token, get_updates_buf, target_sender_id, ilink_account_id
       FROM admin_alert_channels WHERE id = $1`,
    [String(id)],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  if (!row.bot_token_enc || !row.bot_token_nonce) return null;

  const kmsKey = loadKmsKey();
  let botToken: string;
  try {
    botToken = decrypt(row.bot_token_enc, row.bot_token_nonce, kmsKey);
  } catch (err) {
    kmsKey.fill(0);
    if (err instanceof AeadError) return null; // key 换了或被 tamper,worker 会降级
    throw err;
  }
  kmsKey.fill(0);
  return {
    botToken,
    contextToken: row.context_token ?? null,
    getUpdatesBuf: row.get_updates_buf ?? "",
    targetSenderId: row.target_sender_id ?? null,
    ilinkAccountId: row.ilink_account_id ?? null,
  };
}

/** worker 收到新入站:更新 context_token + get_updates_buf + last_inbound_at + 激活。 */
export async function updateChannelInbound(
  id: string | number | bigint,
  input: { contextToken: string; getUpdatesBuf: string; senderId?: string | null },
): Promise<void> {
  await query(
    `UPDATE admin_alert_channels SET
       context_token = $2,
       get_updates_buf = $3,
       target_sender_id = COALESCE($4, target_sender_id),
       last_inbound_at = NOW(),
       activation_status = CASE
         WHEN activation_status IN ('pending', 'error') THEN 'active'
         ELSE activation_status
       END,
       last_error = NULL,
       updated_at = NOW()
     WHERE id = $1`,
    [String(id), input.contextToken, input.getUpdatesBuf, input.senderId ?? null],
  );
}

/** worker 只刷 get_updates_buf(没 inbound 时,长轮询超时也要持久化 buf)。 */
export async function updateChannelBuf(
  id: string | number | bigint,
  getUpdatesBuf: string,
): Promise<void> {
  await query(
    `UPDATE admin_alert_channels SET get_updates_buf = $2, updated_at = NOW() WHERE id = $1`,
    [String(id), getUpdatesBuf],
  );
}

/** worker 发送成功:更新 last_send_at,清 last_error。 */
export async function markChannelSendSuccess(id: string | number | bigint): Promise<void> {
  await query(
    `UPDATE admin_alert_channels SET
       last_send_at = NOW(),
       last_error = NULL,
       activation_status = CASE
         WHEN activation_status IN ('pending', 'error') THEN 'active'
         ELSE activation_status
       END,
       updated_at = NOW()
     WHERE id = $1`,
    [String(id)],
  );
}

/** worker 发送失败 / session expired:标记 last_error,必要时降级状态。 */
export async function markChannelError(
  id: string | number | bigint,
  err: string,
  sessionExpired = false,
): Promise<void> {
  if (sessionExpired) {
    await query(
      `UPDATE admin_alert_channels SET
         last_error = $2,
         activation_status = 'error',
         context_token = NULL,
         updated_at = NOW()
       WHERE id = $1`,
      [String(id), err.slice(0, 500)],
    );
  } else {
    await query(
      `UPDATE admin_alert_channels SET
         last_error = $2,
         updated_at = NOW()
       WHERE id = $1`,
      [String(id), err.slice(0, 500)],
    );
  }
}

/** dispatcher / worker 扫:enabled + activation_status=active 的通道。 */
export async function listDispatchableChannels(): Promise<AlertChannelRow[]> {
  const r = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM admin_alert_channels
      WHERE enabled = TRUE AND activation_status IN ('active', 'pending')
      ORDER BY id`,
  );
  return r.rows.map(rowToView);
}
