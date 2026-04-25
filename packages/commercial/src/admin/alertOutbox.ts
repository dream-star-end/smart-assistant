/**
 * T-63 — 告警 outbox:durable fan-out 队列。
 *
 * 核心 API:
 *   - enqueueAlert(event)  fan-out 到所有订阅的 channels(过滤 severity + event_types + 静默)
 *   - claimReadyAlerts()   dispatcher 捞 status IN(pending, failed) 且 next_attempt_at <= now 的
 *   - markSent / markFailed
 *
 * 去重:
 *   - dedupe_key 非空时:PG 唯一约束 idx_aao_dedupe_pending 保证同 (channel, dedupe_key)
 *     只有一条 pending/failed 行。ON CONFLICT DO NOTHING 忽略重复 enqueue。
 *   - 已 sent / suppressed 的行不参与冲突判定,即"5 分钟前发过一次,现在再发一次"不会被误挡。
 *     业务层自己控制 dedupe_key 的时间窗口编码(例如 'account_pool.all_down:2026-04-23T09:00').
 *
 * 静默:
 *   - enqueueAlert 时一次性查 admin_alert_silences 判定 → 命中则 status='suppressed',
 *     attempts=0,next_attempt_at=NOW(),不再重试。
 *
 * 重试:
 *   - dispatcher markFailed 时用指数退避:min(60s * 2^attempts, 30min),上限重试 10 次后放弃(status=failed, 不再 claim)
 */

import type { PoolClient } from "pg";
import { query, tx } from "../db/queries.js";
import {
  listDispatchableChannels,
  type AlertChannelRow,
  type Severity,
} from "./alertChannels.js";

const SEVERITY_ORDER: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export type AlertStatus = "pending" | "sent" | "failed" | "suppressed" | "skipped";

/** 最大重试次数,超过 status=failed 不再 claim(人工介入或 UI 可手动 retry)。 */
export const MAX_ATTEMPTS = 10;

export interface AlertEventInput {
  event_type: string; // e.g. "payment.first_topup"
  severity: Severity;
  title: string;
  body: string; // Markdown
  payload?: Record<string, unknown>;
  /**
   * 去重 key;null = 不去重(每次都 enqueue)。
   * 建议形式:`${event_type}:${target_id}:${bucket}` 例如
   *   'account_pool.all_down:all:2026-04-23T09:00'   (每 15min 桶)
   *   'payment.first_topup:user:123'                (一人一次)
   */
  dedupe_key?: string | null;
}

export interface OutboxRowView {
  id: string;
  event_type: string;
  severity: Severity;
  status: AlertStatus;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  channel_id: string | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
  sent_at: string | null;
}

export interface OutboxDispatchRow extends OutboxRowView {
  /** 关联 channel 的部分字段(单表 JOIN,省 dispatcher 再查一次) */
  channel: {
    id: string;
    channel_type: string;
    label: string;
    enabled: boolean;
    activation_status: string;
    has_context_token: boolean;
  } | null;
}

function parsePayload(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

// ─── silence 判定 ─────────────────────────────────────────────────────

interface SilenceMatcher {
  event_type?: string;
  severity?: Severity;
  rule_id?: string;
}

function matcherMatches(m: SilenceMatcher, e: AlertEventInput, rule_id?: string): boolean {
  if (m.event_type !== undefined && m.event_type !== e.event_type) return false;
  if (m.severity !== undefined && m.severity !== e.severity) return false;
  if (m.rule_id !== undefined && m.rule_id !== rule_id) return false;
  return true;
}

/**
 * 返回命中的 silence reason(首条),或 null。读当前活跃静默窗口(ends_at > now)。
 */
export async function findActiveSilence(
  event: AlertEventInput,
  rule_id?: string,
): Promise<{ id: string; reason: string } | null> {
  const r = await query<{ id: string; matcher: unknown; reason: string }>(
    `SELECT id::text AS id, matcher, reason FROM admin_alert_silences
      WHERE starts_at <= NOW() AND ends_at > NOW()
      ORDER BY id`,
  );
  for (const row of r.rows) {
    if (!row.matcher || typeof row.matcher !== "object") continue;
    if (matcherMatches(row.matcher as SilenceMatcher, event, rule_id)) {
      return { id: row.id, reason: row.reason };
    }
  }
  return null;
}

// ─── channel 过滤:订阅 + 等级 + 启用 ──────────────────────────────────

function channelSubscribes(channel: AlertChannelRow, event: AlertEventInput): boolean {
  if (!channel.enabled) return false;
  if (SEVERITY_ORDER[event.severity] < SEVERITY_ORDER[channel.severity_min]) return false;
  if (channel.event_types.length === 0) return true; // 空 = 订阅全部
  return channel.event_types.includes(event.event_type);
}

// ─── enqueue ─────────────────────────────────────────────────────────

export interface EnqueueResult {
  enqueued: number; // 新建的 pending 行数
  suppressed: number; // 因静默被建成 suppressed 的行数
  deduped: number; // ON CONFLICT 跳过的行数
  skipped_no_channels: boolean; // 没任何可投递通道(也没建行)
  silenceReason: string | null;
}

/**
 * 把一个事件 fan-out 到所有订阅的通道。幂等(dedupe_key 同 → ON CONFLICT DO NOTHING)。
 * 失败 / 无通道时不抛:观察者模式下调用方不应被告警拖垮。
 *
 * @param rule_id 若来自规则 scheduler,传进来给静默匹配用;被动事件可留空。
 */
export async function enqueueAlert(
  event: AlertEventInput,
  rule_id?: string,
): Promise<EnqueueResult> {
  const channels = await listDispatchableChannels();
  const subscribed = channels.filter((c) => channelSubscribes(c, event));
  if (subscribed.length === 0) {
    return { enqueued: 0, suppressed: 0, deduped: 0, skipped_no_channels: true, silenceReason: null };
  }

  const silence = await findActiveSilence(event, rule_id);
  const payload = event.payload ?? {};
  let enqueued = 0;
  let suppressed = 0;
  let deduped = 0;

  // 2026-04-23 Codex FAIL finding #3:原实现把所有 channel INSERT 包在单个 tx 里,
  // 任何一个 channel 出错(比如 FK race —— admin 刚把该 channel 删了)会回滚全部,
  // 其它健康 channel 也收不到告警。outbox 是本来就设计为最终一致的(per-row
  // retry + indempotency),逐 channel 独立 INSERT 才是正确的解耦。每条 INSERT
  // 自己就是一个隐式 tx(pool.query 走 autocommit),失败只影响那一行。
  for (const ch of subscribed) {
    const status = silence ? "suppressed" : "pending";
    try {
      const r = await query<{ id: string }>(
        `INSERT INTO admin_alert_outbox(
           event_type, severity, dedupe_key, title, body, payload,
           channel_id, status, next_attempt_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6::jsonb,
           $7::bigint, $8, NOW()
         )
         ON CONFLICT (channel_id, dedupe_key)
           WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'failed')
           DO NOTHING
         RETURNING id::text AS id`,
        [
          event.event_type,
          event.severity,
          event.dedupe_key ?? null,
          event.title,
          event.body,
          JSON.stringify(payload),
          ch.id,
          status,
        ],
      );
      if (r.rowCount === 0) {
        deduped++;
        continue;
      }
      if (status === "suppressed") suppressed++;
      else enqueued++;
    } catch (err) {
      // 单 channel 失败(FK race / 23503 / 23514)不拖累兄弟 channel。记一条 warn。
      // eslint-disable-next-line no-console
      console.warn(
        `[admin/alerts] enqueue per-channel failed channel_id=${ch.id} event=${event.event_type}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return {
    enqueued,
    suppressed,
    deduped,
    skipped_no_channels: false,
    silenceReason: silence?.reason ?? null,
  };
}

// ─── dispatcher API ──────────────────────────────────────────────────

/**
 * 捞 ready 的 outbox 行,按 next_attempt_at 顺序。
 * LIMIT 避免一口气吃太多行。调用方在 worker loop 里反复调。
 */
export async function claimReadyAlerts(limit = 20): Promise<OutboxDispatchRow[]> {
  const r = await query<Record<string, unknown>>(
    `SELECT o.id::text AS id,
            o.event_type, o.severity, o.status,
            o.title, o.body, o.payload,
            o.channel_id::text AS channel_id,
            o.attempts, o.last_error,
            o.next_attempt_at, o.created_at, o.sent_at,
            c.id::text AS c_id,
            c.channel_type AS c_type,
            c.label AS c_label,
            c.enabled AS c_enabled,
            c.activation_status AS c_status,
            (c.context_token IS NOT NULL AND length(c.context_token) > 0) AS c_has_ctx
       FROM admin_alert_outbox o
       LEFT JOIN admin_alert_channels c ON c.id = o.channel_id
      WHERE o.status IN ('pending', 'failed')
        AND o.next_attempt_at <= NOW()
        AND o.attempts < $1
      ORDER BY o.next_attempt_at ASC, o.id ASC
      LIMIT $2`,
    [MAX_ATTEMPTS, limit],
  );
  return r.rows.map(toDispatchRow);
}

function toDispatchRow(r: Record<string, unknown>): OutboxDispatchRow {
  const base: OutboxRowView = {
    id: String(r.id),
    event_type: r.event_type as string,
    severity: r.severity as Severity,
    status: r.status as AlertStatus,
    title: r.title as string,
    body: r.body as string,
    payload: parsePayload(r.payload),
    channel_id: (r.channel_id as string | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    last_error: (r.last_error as string | null) ?? null,
    next_attempt_at: (r.next_attempt_at as Date).toISOString(),
    created_at: (r.created_at as Date).toISOString(),
    sent_at: r.sent_at ? (r.sent_at as Date).toISOString() : null,
  };
  const channel =
    r.c_id === null || r.c_id === undefined
      ? null
      : {
          id: String(r.c_id),
          channel_type: r.c_type as string,
          label: r.c_label as string,
          enabled: r.c_enabled as boolean,
          activation_status: r.c_status as string,
          has_context_token: Boolean(r.c_has_ctx),
        };
  return { ...base, channel };
}

export async function markSent(id: string | number | bigint): Promise<void> {
  await query(
    `UPDATE admin_alert_outbox SET status = 'sent', sent_at = NOW(), last_error = NULL
      WHERE id = $1 AND status IN ('pending', 'failed')`,
    [String(id)],
  );
}

/**
 * 指数退避 + jitter:attempts+1 后,
 *   next = now + min(60s * 2^attempts, 30min) * (0.8 + random()*0.4)
 *
 * jitter(±20%)用来打散"同一时刻一批告警同时 fail → 同秒重试"的 thundering herd:
 * iLink 侧 5xx 恢复后 N 条 failed 一起到期会瞬间打回去一次,再失败再同步。
 * 乘一个 [0.8, 1.2) 区间的随机因子,让到期时间在目标值 ±20% 内散开。
 *
 * `random()` 每行求值一次(PG 的 VOLATILE 函数语义);不同行会拿到不同随机值,
 * 即使 attempts 相同也不会撞。上限仍是硬 30min * 1.2 = 36min,实际很少触及
 * 因为 attempts ≥ 6 时 60s*2^6=64min 已超过 30min,会被 LEAST 钳住。
 */
export async function markFailed(id: string | number | bigint, err: string): Promise<void> {
  await query(
    `UPDATE admin_alert_outbox
        SET status = 'failed',
            attempts = attempts + 1,
            last_error = $2,
            next_attempt_at = NOW() + LEAST(
              INTERVAL '60 seconds' * POWER(2, attempts),
              INTERVAL '30 minutes'
            ) * (0.8 + random() * 0.4)
      WHERE id = $1 AND status IN ('pending', 'failed')`,
    [String(id), err.slice(0, 1000)],
  );
}

/**
 * 直接往指定 channel 插一条 outbox 行,**绕过订阅 / silence 过滤**。
 *
 * 用途:`/api/admin/alerts/channels/:id/test` —— admin 点"测试"要无条件发到该 channel,
 * 不受 event_types 订阅 / severity_min / silence 窗口影响。enqueueAlert 的 fan-out
 * 语义在这里不合适。
 *
 * 仍受 PG unique partial index idx_aao_dedupe_pending 保护:传 dedupe_key 重复会 DO NOTHING。
 * 测试路径通常用 nonce 保证每次都能落行。
 */
export async function enqueueAlertToChannel(
  channelId: string | number | bigint,
  event: AlertEventInput,
): Promise<{ enqueued: boolean }> {
  const payload = event.payload ?? {};
  const r = await query<{ id: string }>(
    `INSERT INTO admin_alert_outbox(
       event_type, severity, dedupe_key, title, body, payload,
       channel_id, status, next_attempt_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6::jsonb,
       $7::bigint, 'pending', NOW()
     )
     ON CONFLICT (channel_id, dedupe_key)
       WHERE dedupe_key IS NOT NULL AND status IN ('pending', 'failed')
       DO NOTHING
     RETURNING id::text AS id`,
    [
      event.event_type,
      event.severity,
      event.dedupe_key ?? null,
      event.title,
      event.body,
      JSON.stringify(payload),
      String(channelId),
    ],
  );
  return { enqueued: (r.rowCount ?? 0) > 0 };
}

/**
 * 非阻塞被动事件分发:fire-and-forget,吞所有异常。
 *
 * 被动告警(支付回调、容器失败、管理员改 pricing 等)绝不能因为 DB/alert 子系统
 * 问题把主路径拖挂。此 wrapper 只负责 log warn,不抛。
 *
 * 用法:
 *   import { safeEnqueueAlert } from "../admin/alertOutbox.js";
 *   safeEnqueueAlert({ event_type: EVENTS.PAYMENT_FIRST_TOPUP, ... });
 */
export function safeEnqueueAlert(event: AlertEventInput): void {
  // 故意不 await — 调用方不等待 outbox 写入完成。
  void (async () => {
    try {
      await enqueueAlert(event);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[admin/alerts] safeEnqueueAlert failed event=${event.event_type}:`,
        err instanceof Error ? err.message : err,
      );
    }
  })();
}

/** 通道 inactive / 删除:把属于它的 pending/failed 行标 skipped。 */
export async function skipPendingForChannel(channelId: string | number | bigint): Promise<number> {
  const r = await query(
    `UPDATE admin_alert_outbox
        SET status = 'skipped', last_error = 'channel disabled or removed', sent_at = NOW()
      WHERE channel_id = $1 AND status IN ('pending', 'failed')`,
    [String(channelId)],
  );
  return r.rowCount ?? 0;
}

// ─── 前端展示 API ─────────────────────────────────────────────────────

export interface ListOutboxInput {
  before?: string | number | bigint;
  limit?: number;
  event_type?: string;
  status?: AlertStatus;
}

export interface ListOutboxResult {
  rows: OutboxRowView[];
  next_before: string | null;
}

export const OUTBOX_DEFAULT_LIMIT = 50;
export const OUTBOX_MAX_LIMIT = 200;
const ID_RE = /^[1-9][0-9]{0,19}$/;
const EVENT_RE = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;

export async function listOutbox(input: ListOutboxInput): Promise<ListOutboxResult> {
  let limit = input.limit ?? OUTBOX_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) limit = OUTBOX_DEFAULT_LIMIT;
  if (limit > OUTBOX_MAX_LIMIT) limit = OUTBOX_MAX_LIMIT;

  const where: string[] = [];
  const params: unknown[] = [];
  if (input.before !== undefined) {
    const s = String(input.before);
    if (!ID_RE.test(s)) throw new RangeError("invalid before");
    params.push(s);
    where.push(`id < $${params.length}`);
  }
  if (input.event_type !== undefined) {
    if (!EVENT_RE.test(input.event_type)) throw new RangeError("invalid event_type");
    params.push(input.event_type);
    where.push(`event_type = $${params.length}`);
  }
  if (input.status !== undefined) {
    const allowed: AlertStatus[] = ["pending", "sent", "failed", "suppressed", "skipped"];
    if (!allowed.includes(input.status)) throw new RangeError("invalid status");
    params.push(input.status);
    where.push(`status = $${params.length}`);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.push(limit);

  const r = await query<Record<string, unknown>>(
    `SELECT id::text AS id, event_type, severity, status, title, body, payload,
            channel_id::text AS channel_id, attempts, last_error,
            next_attempt_at, created_at, sent_at
       FROM admin_alert_outbox
       ${whereClause}
      ORDER BY id DESC
      LIMIT $${params.length}`,
    params,
  );
  const rows = r.rows.map((row) => ({
    id: String(row.id),
    event_type: row.event_type as string,
    severity: row.severity as Severity,
    status: row.status as AlertStatus,
    title: row.title as string,
    body: row.body as string,
    payload: parsePayload(row.payload),
    channel_id: (row.channel_id as string | null) ?? null,
    attempts: Number(row.attempts ?? 0),
    last_error: (row.last_error as string | null) ?? null,
    next_attempt_at: (row.next_attempt_at as Date).toISOString(),
    created_at: (row.created_at as Date).toISOString(),
    sent_at: row.sent_at ? (row.sent_at as Date).toISOString() : null,
  }));
  const next = rows.length === limit ? rows[rows.length - 1].id : null;
  return { rows, next_before: next };
}

// ─── silences CRUD ──────────────────────────────────────────────────

export interface SilenceRowView {
  id: string;
  matcher: SilenceMatcher;
  starts_at: string;
  ends_at: string;
  reason: string;
  created_by: string | null;
  created_at: string;
  active: boolean;
}

export interface CreateSilenceInput {
  createdBy: bigint | number | string;
  matcher: SilenceMatcher;
  startsAt?: Date;
  endsAt: Date;
  reason: string;
  ip?: string | null;
  userAgent?: string | null;
}

const REASON_RE = /^[^\n\r]{1,200}$/;

export async function createSilence(input: CreateSilenceInput): Promise<SilenceRowView> {
  const starts = input.startsAt ?? new Date();
  if (!(input.endsAt instanceof Date) || input.endsAt.getTime() <= starts.getTime()) {
    throw new RangeError("ends_at must be after starts_at");
  }
  if (!REASON_RE.test(input.reason)) throw new RangeError("reason must be 1-200 chars, single line");
  // matcher 字段白名单 + 类型
  const m = input.matcher ?? {};
  const cleaned: SilenceMatcher = {};
  if (m.event_type !== undefined) {
    if (typeof m.event_type !== "string" || !/^[a-z][a-z0-9_]*\.[a-z0-9_]+$/.test(m.event_type)) {
      throw new RangeError("invalid matcher.event_type");
    }
    cleaned.event_type = m.event_type;
  }
  if (m.severity !== undefined) {
    if (!["info", "warning", "critical"].includes(m.severity)) {
      throw new RangeError("invalid matcher.severity");
    }
    cleaned.severity = m.severity;
  }
  if (m.rule_id !== undefined) {
    if (typeof m.rule_id !== "string" || !/^[a-z][a-z0-9_.]{0,63}$/.test(m.rule_id)) {
      throw new RangeError("invalid matcher.rule_id");
    }
    cleaned.rule_id = m.rule_id;
  }
  if (Object.keys(cleaned).length === 0) {
    throw new RangeError("matcher must have at least one field");
  }

  return tx(async (client: PoolClient) => {
    const r = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO admin_alert_silences(matcher, starts_at, ends_at, reason, created_by)
       VALUES ($1::jsonb, $2, $3, $4, $5::bigint)
       RETURNING id::text AS id, created_at`,
      [JSON.stringify(cleaned), starts, input.endsAt, input.reason, String(input.createdBy)],
    );
    const row = r.rows[0];

    // 写审计
    const { writeAdminAudit } = await import("./audit.js");
    await writeAdminAudit(client, {
      adminId: input.createdBy,
      action: "alert_silence.create",
      target: `silence:${row.id}`,
      after: { matcher: cleaned, starts_at: starts.toISOString(), ends_at: input.endsAt.toISOString(), reason: input.reason },
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
    return {
      id: row.id,
      matcher: cleaned,
      starts_at: starts.toISOString(),
      ends_at: input.endsAt.toISOString(),
      reason: input.reason,
      created_by: String(input.createdBy),
      created_at: row.created_at.toISOString(),
      active: starts.getTime() <= Date.now() && input.endsAt.getTime() > Date.now(),
    };
  });
}

export async function deleteSilence(
  adminId: bigint | number | string,
  id: string | number | bigint,
  ip?: string | null,
  userAgent?: string | null,
): Promise<void> {
  await tx(async (client: PoolClient) => {
    const before = await client.query<{ reason: string }>(
      `SELECT reason FROM admin_alert_silences WHERE id = $1 FOR UPDATE`,
      [String(id)],
    );
    if (before.rows.length === 0) return; // 幂等
    await client.query(`DELETE FROM admin_alert_silences WHERE id = $1`, [String(id)]);
    const { writeAdminAudit } = await import("./audit.js");
    await writeAdminAudit(client, {
      adminId,
      action: "alert_silence.delete",
      target: `silence:${id}`,
      before: { reason: before.rows[0].reason },
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  });
}

export async function listSilences(): Promise<SilenceRowView[]> {
  const r = await query<{
    id: string;
    matcher: SilenceMatcher;
    starts_at: Date;
    ends_at: Date;
    reason: string;
    created_by: string | null;
    created_at: Date;
  }>(
    `SELECT id::text AS id, matcher, starts_at, ends_at, reason,
            created_by::text AS created_by, created_at
       FROM admin_alert_silences
       ORDER BY id DESC LIMIT 200`,
  );
  const now = Date.now();
  return r.rows.map((r) => ({
    id: r.id,
    matcher: r.matcher,
    starts_at: r.starts_at.toISOString(),
    ends_at: r.ends_at.toISOString(),
    reason: r.reason,
    created_by: r.created_by,
    created_at: r.created_at.toISOString(),
    active: r.starts_at.getTime() <= now && r.ends_at.getTime() > now,
  }));
}

// ─── rule_state helpers(给 rules scheduler 用)──────────────────────

export interface RuleStateRow {
  rule_id: string;
  firing: boolean;
  /** M8.3/P2-21:ack 三态. firing=true,acked=false → 'open'; firing=true,acked=true → 'acked'; firing=false → 'resolved'(acked 无意义). */
  acked: boolean;
  acked_at: string | null;
  /** admin user id(BIGINT serialized as string),不做 FK,保留删账号不挂. */
  acked_by: string | null;
  dedupe_key: string | null;
  last_transition_at: string | null;
  last_evaluated_at: string | null;
  last_payload: Record<string, unknown>;
}

/** 原子翻转 rule state;返回 true 表示"发生了 false→true 或 true→false 翻转"。 */
export async function transitionRuleState(
  rule_id: string,
  firing: boolean,
  dedupe_key: string | null,
  payload: Record<string, unknown>,
): Promise<{ transitioned: boolean; previous: boolean }> {
  return tx(async (client: PoolClient) => {
    const cur = await client.query<{ firing: boolean }>(
      `SELECT firing FROM admin_alert_rule_state WHERE rule_id = $1 FOR UPDATE`,
      [rule_id],
    );
    const prev = cur.rows.length === 0 ? false : cur.rows[0].firing;
    if (prev === firing) {
      // 即使没翻转也刷新 last_evaluated_at,便于诊断
      await client.query(
        `INSERT INTO admin_alert_rule_state(rule_id, firing, dedupe_key, last_evaluated_at, last_payload)
         VALUES ($1, $2, $3, NOW(), $4::jsonb)
         ON CONFLICT (rule_id) DO UPDATE SET
           last_evaluated_at = NOW(),
           last_payload = EXCLUDED.last_payload`,
        [rule_id, firing, dedupe_key, JSON.stringify(payload)],
      );
      return { transitioned: false, previous: prev };
    }
    // 翻转(任意方向)清掉 ack 三态. M8.3/P2-21:
    //   false→true 必须清, 否则新一轮告警继承旧 ack.
    //   true→false 也清, 因为 acked 字段在 resolved 状态下没意义.
    await client.query(
      `INSERT INTO admin_alert_rule_state(rule_id, firing, dedupe_key, last_transition_at, last_evaluated_at, last_payload)
       VALUES ($1, $2, $3, NOW(), NOW(), $4::jsonb)
       ON CONFLICT (rule_id) DO UPDATE SET
         firing = EXCLUDED.firing,
         dedupe_key = EXCLUDED.dedupe_key,
         last_transition_at = NOW(),
         last_evaluated_at = NOW(),
         last_payload = EXCLUDED.last_payload,
         acked = FALSE,
         acked_at = NULL,
         acked_by = NULL`,
      [rule_id, firing, dedupe_key, JSON.stringify(payload)],
    );
    return { transitioned: true, previous: prev };
  });
}

export async function listRuleStates(): Promise<RuleStateRow[]> {
  const r = await query<{
    rule_id: string;
    firing: boolean;
    acked: boolean;
    acked_at: Date | null;
    acked_by: string | null;
    dedupe_key: string | null;
    last_transition_at: Date | null;
    last_evaluated_at: Date | null;
    last_payload: unknown;
  }>(
    `SELECT rule_id, firing,
            acked, acked_at, acked_by::text AS acked_by,
            dedupe_key, last_transition_at, last_evaluated_at, last_payload
       FROM admin_alert_rule_state ORDER BY rule_id`,
  );
  return r.rows.map((row) => ({
    rule_id: row.rule_id,
    firing: row.firing,
    acked: row.acked,
    acked_at: row.acked_at ? row.acked_at.toISOString() : null,
    acked_by: row.acked_by,
    dedupe_key: row.dedupe_key,
    last_transition_at: row.last_transition_at ? row.last_transition_at.toISOString() : null,
    last_evaluated_at: row.last_evaluated_at ? row.last_evaluated_at.toISOString() : null,
    last_payload: parsePayload(row.last_payload),
  }));
}

// ─── M8.3/P2-21:retry + ack ─────────────────────────────────────────

/**
 * 手动 retry 一条 outbox 行:把 status=failed && attempts<MAX_ATTEMPTS 的行
 * next_attempt_at 拉到 NOW(),让 dispatcher 下个 tick 立刻重试。
 *
 * 返回 retried=true 当且仅当真有一行被更新。其他场景(不存在 / 非 failed /
 * 已超 MAX_ATTEMPTS)返回 retried=false,HTTP 层翻 409。
 *
 * 不重置 attempts:重试预算靠 MAX_ATTEMPTS 控制,人工 retry 也耗预算。
 */
export async function retryOutbox(
  id: string | number | bigint,
): Promise<{ retried: boolean }> {
  const r = await query(
    `UPDATE admin_alert_outbox
        SET next_attempt_at = NOW()
      WHERE id = $1
        AND status = 'failed'
        AND attempts < $2`,
    [String(id), MAX_ATTEMPTS],
  );
  return { retried: (r.rowCount ?? 0) > 0 };
}

/**
 * Ack 一条 firing rule:`acked=true, acked_at=NOW(), acked_by=adminId`。
 * 已 ack 的 idempotent(不抛、不写 audit、不改 acked_at/acked_by)。
 *
 * 抛 RangeError(code='NOT_FIRING')当:
 *   - rule_state 行不存在(从未 firing 过)
 *   - 行存在但 firing=false(已 resolved,ack 无意义)
 * HTTP 层翻 409。
 *
 * audit 仅在首次 ack(acked=false→true)时写,target='rule:${rule_id}',
 * after.previous_acked=false。
 */
export async function ackRule(
  rule_id: string,
  adminId: bigint | number | string,
  ip?: string | null,
  userAgent?: string | null,
): Promise<{ acked: boolean; alreadyAcked: boolean }> {
  return tx(async (client: PoolClient) => {
    const cur = await client.query<{ firing: boolean; acked: boolean }>(
      `SELECT firing, acked FROM admin_alert_rule_state WHERE rule_id = $1 FOR UPDATE`,
      [rule_id],
    );
    if (cur.rows.length === 0 || !cur.rows[0].firing) {
      const e = new RangeError("rule is not firing");
      (e as { code?: string }).code = "NOT_FIRING";
      throw e;
    }
    if (cur.rows[0].acked) {
      // 已 ack — 幂等,不写 audit。
      return { acked: true, alreadyAcked: true };
    }
    await client.query(
      `UPDATE admin_alert_rule_state
          SET acked = TRUE, acked_at = NOW(), acked_by = $2::bigint
        WHERE rule_id = $1`,
      [rule_id, String(adminId)],
    );
    const { writeAdminAudit } = await import("./audit.js");
    await writeAdminAudit(client, {
      adminId,
      action: "alert_rule.ack",
      target: `rule:${rule_id}`,
      after: { previous_acked: false },
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
    return { acked: true, alreadyAcked: false };
  });
}
