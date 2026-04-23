/**
 * T-63 — /api/admin/alerts/* HTTP handlers。
 *
 * 路由分组(与 admin.ts 同一套鉴权约定):
 *
 *   读:requireAdmin(JWT only)
 *     GET /api/admin/alerts/events                        事件目录(EVENT_META)
 *     GET /api/admin/alerts/channels                      列通道
 *     GET /api/admin/alerts/outbox                        投递历史(分页)
 *     GET /api/admin/alerts/silences                      静默列表
 *     GET /api/admin/alerts/rule-states                   规则状态快照(诊断)
 *
 *   写:requireAdminVerifyDb(JWT + DB,撤权立即生效)
 *     POST   /api/admin/alerts/ilink/qrcode               申请新 QR(proxy iLink)
 *     POST   /api/admin/alerts/ilink/poll                 轮询 QR 状态 + 落库成 channel
 *     PATCH  /api/admin/alerts/channels/:id               改 label/enabled/severity_min/event_types
 *     DELETE /api/admin/alerts/channels/:id               删
 *     POST   /api/admin/alerts/channels/:id/test          往该通道发测试告警(enqueueAlert path)
 *     POST   /api/admin/alerts/channels/:id/rebind        activation_status=error → pending(worker 重新 long-poll,不重扫码)
 *     POST   /api/admin/alerts/silences                   建静默
 *     DELETE /api/admin/alerts/silences/:id               撤静默
 *
 * 设计要点:
 *   - QR 绑定流程两步:先拿 qrcode(/ilink/qrcode),admin 扫码后前端轮询 /ilink/poll。
 *     poll 命中 confirmed 时直接 createIlinkChannel(AEAD 加密 bot_token 落库)。
 *   - /test 不直接 iLink 发 —— 走 enqueueAlert + outbox,确保测试路径与真实告警
 *     路径一致(dispatcher 5s 内吃掉发出)。前端 UI 提示"2~3 秒后检查微信/outbox"。
 *   - 所有写路由审计由下层 ops 写 admin_audit,HTTP 层不重复写。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson, readJsonBody } from "./util.js";
import { requireAdmin, requireAdminVerifyDb } from "../admin/requireAdmin.js";
import {
  listAlertChannels,
  createIlinkChannel,
  patchAlertChannel,
  deleteAlertChannel,
  getAlertChannel,
  reactivateChannel,
  ChannelNotFoundError,
  type AlertChannelRow,
  type Severity,
} from "../admin/alertChannels.js";
import {
  enqueueAlertToChannel,
  createSilence,
  deleteSilence,
  listSilences,
  listOutbox,
  listRuleStates,
  OUTBOX_DEFAULT_LIMIT,
  OUTBOX_MAX_LIMIT,
  type AlertStatus,
  type RuleStateRow,
  type SilenceRowView,
  type OutboxRowView,
} from "../admin/alertOutbox.js";
import { EVENT_META } from "../admin/alertEvents.js";
import {
  fetchIlinkQrcode,
  pollIlinkQrcodeStatus,
  extractConfirmed,
} from "../admin/ilinkAlertWorker.js";
import type { CommercialHttpDeps, RequestContext } from "./handlers.js";

// ─── 共用辅助 ─────────────────────────────────────────────────────────

const ID_RE = /^[1-9][0-9]{0,19}$/;
const EVENT_TYPE_RE = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;
const SEVERITIES: ReadonlySet<Severity> = new Set(["info", "warning", "critical"]);
const STATUSES: ReadonlySet<AlertStatus> = new Set([
  "pending",
  "sent",
  "failed",
  "suppressed",
  "skipped",
]);

function urlOf(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
}

/** 抽 `/api/admin/alerts/channels/:id` → :id。 */
function extractChannelId(url: URL, prefix: string, suffix = ""): string {
  if (!url.pathname.startsWith(prefix)) {
    throw new HttpError(404, "NOT_FOUND", "route not found");
  }
  let tail = url.pathname.slice(prefix.length);
  if (suffix) {
    if (!tail.endsWith(suffix)) {
      throw new HttpError(404, "NOT_FOUND", "route not found");
    }
    tail = tail.slice(0, tail.length - suffix.length);
  }
  if (!ID_RE.test(tail)) {
    throw new HttpError(400, "VALIDATION", "invalid channel id", {
      issues: [{ path: "id", message: tail }],
    });
  }
  return tail;
}

function assertObjectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "request body must be JSON object");
  }
  return body as Record<string, unknown>;
}

function parsePositiveInt(raw: string | null, name: string, max: number): number | undefined {
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new HttpError(400, "VALIDATION", `${name} must be 1..${max}`, {
      issues: [{ path: name, message: raw }],
    });
  }
  return n;
}

function translateRangeError(err: unknown): never {
  if (!(err instanceof RangeError)) throw err;
  throw new HttpError(400, "VALIDATION", err.message, {
    issues: [{ path: "body", message: err.message }],
  });
}

// ─── serializers ─────────────────────────────────────────────────────

function serializeChannel(c: AlertChannelRow): Record<string, unknown> {
  return {
    id: c.id,
    admin_id: c.admin_id,
    channel_type: c.channel_type,
    label: c.label,
    enabled: c.enabled,
    severity_min: c.severity_min,
    event_types: c.event_types,
    ilink_account_id: c.ilink_account_id,
    ilink_login_user_id: c.ilink_login_user_id,
    target_sender_id: c.target_sender_id,
    activation_status: c.activation_status,
    last_inbound_at: c.last_inbound_at,
    last_send_at: c.last_send_at,
    last_error: c.last_error,
    has_context_token: c.has_context_token,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

function serializeOutbox(r: OutboxRowView): Record<string, unknown> {
  return { ...r }; // 已是纯可序列化对象
}

function serializeSilence(s: SilenceRowView): Record<string, unknown> {
  return { ...s };
}

function serializeRuleState(r: RuleStateRow): Record<string, unknown> {
  return { ...r };
}

// ─── GET /api/admin/alerts/events ─────────────────────────────────────

export async function handleAdminAlertsListEvents(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  sendJson(res, 200, { rows: EVENT_META });
}

// ─── GET /api/admin/alerts/channels ──────────────────────────────────

export async function handleAdminAlertsListChannels(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const rows = await listAlertChannels();
  sendJson(res, 200, { rows: rows.map(serializeChannel) });
}

// ─── POST /api/admin/alerts/ilink/qrcode ─────────────────────────────
//
// 申请新 QR。不落库,只返 {qrcode, qrcode_img_content} 给前端渲染。
// 前端在 modal 里显示 QR,同时启动轮询 /api/admin/alerts/ilink/poll。
export async function handleAdminAlertsIlinkQrcode(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdminVerifyDb(req, deps.jwtSecret);
  try {
    const qr = await fetchIlinkQrcode();
    sendJson(res, 200, {
      qrcode: qr.qrcode,
      qrcode_img_content: qr.qrcode_img_content,
    });
  } catch (err) {
    throw new HttpError(502, "ILINK_UPSTREAM", (err as Error)?.message ?? "iLink fetchQrcode failed");
  }
}

// ─── POST /api/admin/alerts/ilink/poll ───────────────────────────────
//
// body: { qrcode: string, label?: string, severity_min?: Severity, event_types?: string[] }
//
// 阻塞最长 ~35s(iLink long-poll)。返回:
//   - 200 { status: "pending" }                 (尚未扫 / 尚未确认)
//   - 200 { status: "confirmed", channel: {...}}  (扫码+确认成功,已落库)
//   - 502 ILINK_UPSTREAM                         (iLink 自己挂)
export async function handleAdminAlertsIlinkPoll(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const body = assertObjectBody(await readJsonBody(req) ?? {});
  const qrcode = body.qrcode;
  if (typeof qrcode !== "string" || qrcode.length < 8 || qrcode.length > 512) {
    throw new HttpError(400, "VALIDATION", "qrcode required (8..512 chars)", {
      issues: [{ path: "qrcode", message: typeof qrcode }],
    });
  }

  let pollResp: unknown;
  try {
    pollResp = await pollIlinkQrcodeStatus(qrcode);
  } catch (err) {
    throw new HttpError(502, "ILINK_UPSTREAM", (err as Error)?.message ?? "iLink poll failed");
  }

  const confirmed = extractConfirmed(pollResp);
  if (!confirmed) {
    sendJson(res, 200, { status: "pending" });
    return;
  }

  // confirmed → 直接落库成 channel
  const label =
    typeof body.label === "string" && body.label.trim().length > 0
      ? body.label.trim()
      : `iLink-${confirmed.account_id.slice(-6)}`;
  const severityMin =
    typeof body.severity_min === "string" && SEVERITIES.has(body.severity_min as Severity)
      ? (body.severity_min as Severity)
      : "warning";
  const eventTypes = Array.isArray(body.event_types)
    ? body.event_types.filter((x): x is string => typeof x === "string")
    : [];

  try {
    const ch = await createIlinkChannel({
      adminId: admin.id,
      label,
      botToken: confirmed.bot_token,
      ilinkAccountId: confirmed.account_id,
      ilinkLoginUserId: confirmed.login_user_id,
      severityMin,
      eventTypes,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { status: "confirmed", channel: serializeChannel(ch) });
  } catch (err) {
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}

// ─── PATCH /api/admin/alerts/channels/:id ────────────────────────────

export async function handleAdminAlertsPatchChannel(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = urlOf(req);
  const id = extractChannelId(url, "/api/admin/alerts/channels/");

  const body = assertObjectBody(await readJsonBody(req) ?? {});
  const input: {
    label?: string;
    enabled?: boolean;
    severityMin?: Severity;
    eventTypes?: string[];
  } = {};
  if (body.label !== undefined) {
    if (typeof body.label !== "string") {
      throw new HttpError(400, "VALIDATION", "label must be string");
    }
    input.label = body.label;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      throw new HttpError(400, "VALIDATION", "enabled must be boolean");
    }
    input.enabled = body.enabled;
  }
  if (body.severity_min !== undefined) {
    if (typeof body.severity_min !== "string" || !SEVERITIES.has(body.severity_min as Severity)) {
      throw new HttpError(400, "VALIDATION", "severity_min must be info|warning|critical");
    }
    input.severityMin = body.severity_min as Severity;
  }
  if (body.event_types !== undefined) {
    if (!Array.isArray(body.event_types)) {
      throw new HttpError(400, "VALIDATION", "event_types must be array");
    }
    const types: string[] = [];
    for (const t of body.event_types) {
      if (typeof t !== "string" || !EVENT_TYPE_RE.test(t)) {
        throw new HttpError(400, "VALIDATION", `invalid event_type: ${String(t)}`);
      }
      types.push(t);
    }
    input.eventTypes = types;
  }

  try {
    const ch = await patchAlertChannel({
      adminId: admin.id,
      id,
      ...input,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, { channel: serializeChannel(ch) });
  } catch (err) {
    if (err instanceof ChannelNotFoundError) throw new HttpError(404, "NOT_FOUND", err.message);
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}

// ─── DELETE /api/admin/alerts/channels/:id ────────────────────────────

export async function handleAdminAlertsDeleteChannel(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = urlOf(req);
  const id = extractChannelId(url, "/api/admin/alerts/channels/");
  try {
    await deleteAlertChannel(admin.id, id, ctx.clientIp, ctx.userAgent);
  } catch (err) {
    if (err instanceof ChannelNotFoundError) throw new HttpError(404, "NOT_FOUND", err.message);
    throw err;
  }
  sendJson(res, 200, { deleted: true });
}

// ─── POST /api/admin/alerts/channels/:id/{test,rebind} ────────────────
//
// router 层所有 POST /api/admin/alerts/channels/ 都进这个 dispatcher,根据
// 后缀分派:
//   - /test   → 测试告警(enqueueAlert path)
//   - /rebind → 重新激活(error → pending,让 worker 重新 long-poll)
//
// 为什么在 handler 层分派:router 的 path-prefix 匹配是"同 method 取第一条",
// 不支持多个 POST 共享同一 prefix。集中在这里做后缀分派避免改 router 框架。
export async function handleAdminAlertsTestChannel(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const url = urlOf(req);
  if (url.pathname.endsWith("/rebind")) {
    return _handleRebindChannel(req, res, ctx, deps);
  }
  // default: /test
  await requireAdminVerifyDb(req, deps.jwtSecret);
  const id = extractChannelId(url, "/api/admin/alerts/channels/", "/test");
  const ch = await getAlertChannel(id);
  if (!ch) throw new HttpError(404, "NOT_FOUND", "channel not found");
  if (!ch.enabled) throw new HttpError(409, "CONFLICT", "channel disabled");
  if (ch.activation_status !== "active") {
    throw new HttpError(409, "CONFLICT", `channel not active: ${ch.activation_status}`, {
      issues: [
        {
          path: "activation",
          message:
            ch.activation_status === "pending"
              ? "awaiting first inbound message — please send any message to the bot from 微信 first"
              : ch.activation_status,
        },
      ],
    });
  }
  if (!ch.has_context_token) {
    throw new HttpError(409, "CONFLICT", "channel missing context_token — send any message to bot first");
  }

  // 直接插 outbox 行(绕过 subscription / silence),保证无条件到达指定通道。
  // dedupe_key 带 nonce,每次测试都发一次。
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await enqueueAlertToChannel(ch.id, {
    event_type: "system.test_alert",
    severity: "info",
    title: "[TEST] 测试告警",
    body: `这是一条测试消息(channel=${ch.label})。如果微信收到,说明通道正常。`,
    payload: { channel_id: ch.id, nonce },
    dedupe_key: `system.test_alert:${ch.id}:${nonce}`,
  });
  sendJson(res, 202, {
    enqueued: result.enqueued,
    note: "dispatcher will send within ~5s; check outbox row status or your WeChat",
  });
}

// ─── POST /api/admin/alerts/channels/:id/rebind ───────────────────────
//
// 把 activation_status='error' 的通道推回 'pending',让 ilinkAlertWorker
// 下轮 tick 重新 long-poll。不重新扫码、不换 bot_token 。
//
// **幂等**:无论当前状态是 error / active / pending 都返 200,携 outcome 让
// 前端自己决定 toast 文案。这样多 tab 同时点、或 UI 看到 stale error 实际
// worker 已自愈都不会误报失败。
//
// 请求无 body。响应:
//   - 200 { outcome: 'reactivated', channel, next_step }
//     真正做了 error→pending 转换,next_step 告诉 admin 要发条微信消息触发升级。
//   - 200 { outcome: 'already_active' | 'already_pending', channel }
//     no-op:通道已处于目标状态,幂等返回,caller 看 outcome 决定是否 toast。
//   - 409 CHANNEL_DISABLED — 通道 enabled=false,需先启用
//   - 404 NOT_FOUND — 通道不存在
async function _handleRebindChannel(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = urlOf(req);
  const id = extractChannelId(url, "/api/admin/alerts/channels/", "/rebind");
  const result = await reactivateChannel({
    id,
    adminId: admin.id,
    ip: ctx.clientIp,
    userAgent: ctx.userAgent,
  });
  if (result.outcome === "not_found") {
    throw new HttpError(404, "NOT_FOUND", `channel ${id} not found`);
  }
  if (result.outcome === "disabled") {
    throw new HttpError(409, "CHANNEL_DISABLED", `channel ${id} is disabled`, {
      issues: [
        {
          path: "enabled",
          message: "通道已停用,请先启用再重新激活",
        },
      ],
    });
  }
  // reactivated / already_active / already_pending — 全部 200,前端按 outcome 分支
  const body: Record<string, unknown> = {
    outcome: result.outcome,
    channel: result.channel,
  };
  if (result.outcome === "reactivated") {
    body.next_step =
      "通道已重置为 pending。请用已绑定的微信号向机器人发一条消息,worker 会抓新 context_token 自动升级 active。" +
      "若重试仍回落 error,说明 bot_token 已失效,需删除通道后重新扫码绑定。";
  }
  sendJson(res, 200, body);
}

// ─── GET /api/admin/alerts/outbox ────────────────────────────────────
//
// query: before?=id, limit?=1..200, event_type?, status?
export async function handleAdminAlertsListOutbox(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const url = urlOf(req);
  const sp = url.searchParams;
  const beforeRaw = sp.get("before");
  const eventRaw = sp.get("event_type");
  const statusRaw = sp.get("status");
  const limit = parsePositiveInt(sp.get("limit"), "limit", OUTBOX_MAX_LIMIT) ?? OUTBOX_DEFAULT_LIMIT;

  let before: string | undefined;
  if (beforeRaw !== null && beforeRaw !== "") {
    if (!ID_RE.test(beforeRaw)) {
      throw new HttpError(400, "VALIDATION", "invalid before");
    }
    before = beforeRaw;
  }
  let event_type: string | undefined;
  if (eventRaw !== null && eventRaw !== "") {
    if (!EVENT_TYPE_RE.test(eventRaw)) {
      throw new HttpError(400, "VALIDATION", "invalid event_type");
    }
    event_type = eventRaw;
  }
  let status: AlertStatus | undefined;
  if (statusRaw !== null && statusRaw !== "") {
    if (!STATUSES.has(statusRaw as AlertStatus)) {
      throw new HttpError(400, "VALIDATION", "invalid status");
    }
    status = statusRaw as AlertStatus;
  }

  try {
    const r = await listOutbox({ before, event_type, status, limit });
    sendJson(res, 200, {
      rows: r.rows.map(serializeOutbox),
      next_before: r.next_before,
    });
  } catch (err) {
    translateRangeError(err);
  }
}

// ─── GET /api/admin/alerts/silences ──────────────────────────────────

export async function handleAdminAlertsListSilences(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const rows = await listSilences();
  sendJson(res, 200, { rows: rows.map(serializeSilence) });
}

// ─── POST /api/admin/alerts/silences ─────────────────────────────────
//
// body: {
//   matcher: { event_type?: string, severity?: Severity, rule_id?: string },
//   ends_at: ISO string,
//   starts_at?: ISO string (default now),
//   reason: string (1..200 chars)
// }
export async function handleAdminAlertsCreateSilence(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const body = assertObjectBody(await readJsonBody(req) ?? {});

  if (!body.matcher || typeof body.matcher !== "object" || Array.isArray(body.matcher)) {
    throw new HttpError(400, "VALIDATION", "matcher must be object", {
      issues: [{ path: "matcher", message: "missing_or_invalid" }],
    });
  }
  const m = body.matcher as Record<string, unknown>;
  const matcher: { event_type?: string; severity?: Severity; rule_id?: string } = {};
  if (m.event_type !== undefined) {
    if (typeof m.event_type !== "string") {
      throw new HttpError(400, "VALIDATION", "matcher.event_type must be string");
    }
    matcher.event_type = m.event_type;
  }
  if (m.severity !== undefined) {
    if (typeof m.severity !== "string" || !SEVERITIES.has(m.severity as Severity)) {
      throw new HttpError(400, "VALIDATION", "matcher.severity must be info|warning|critical");
    }
    matcher.severity = m.severity as Severity;
  }
  if (m.rule_id !== undefined) {
    if (typeof m.rule_id !== "string") {
      throw new HttpError(400, "VALIDATION", "matcher.rule_id must be string");
    }
    matcher.rule_id = m.rule_id;
  }

  if (typeof body.reason !== "string" || body.reason.length === 0) {
    throw new HttpError(400, "VALIDATION", "reason is required");
  }
  if (typeof body.ends_at !== "string") {
    throw new HttpError(400, "VALIDATION", "ends_at is required (ISO string)");
  }
  const endsAt = new Date(body.ends_at);
  if (Number.isNaN(endsAt.getTime())) {
    throw new HttpError(400, "VALIDATION", "ends_at not a valid ISO timestamp");
  }
  let startsAt: Date | undefined;
  if (body.starts_at !== undefined) {
    if (typeof body.starts_at !== "string") {
      throw new HttpError(400, "VALIDATION", "starts_at must be ISO string");
    }
    const d = new Date(body.starts_at);
    if (Number.isNaN(d.getTime())) {
      throw new HttpError(400, "VALIDATION", "starts_at not a valid ISO timestamp");
    }
    startsAt = d;
  }
  // 硬 cap:静默窗口不能超过 7d(防误操作长时间压掉真实事件)
  const horizon = (startsAt?.getTime() ?? Date.now()) + 7 * 24 * 60 * 60 * 1000;
  if (endsAt.getTime() > horizon) {
    throw new HttpError(400, "VALIDATION", "silence window exceeds 7d cap");
  }

  try {
    const s = await createSilence({
      createdBy: admin.id,
      matcher,
      startsAt,
      endsAt,
      reason: body.reason,
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 201, { silence: serializeSilence(s) });
  } catch (err) {
    if (err instanceof RangeError) translateRangeError(err);
    throw err;
  }
}

// ─── DELETE /api/admin/alerts/silences/:id ───────────────────────────

export async function handleAdminAlertsDeleteSilence(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = urlOf(req);
  const prefix = "/api/admin/alerts/silences/";
  if (!url.pathname.startsWith(prefix)) {
    throw new HttpError(404, "NOT_FOUND", "route not found");
  }
  const id = url.pathname.slice(prefix.length);
  if (!ID_RE.test(id)) {
    throw new HttpError(400, "VALIDATION", "invalid silence id");
  }
  await deleteSilence(admin.id, id, ctx.clientIp, ctx.userAgent);
  sendJson(res, 200, { deleted: true });
}

// ─── GET /api/admin/alerts/rule-states ───────────────────────────────
//
// 返当前所有 polled rule 的 firing 状态快照,诊断用。
export async function handleAdminAlertsListRuleStates(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  await requireAdmin(req, deps.jwtSecret);
  const rows = await listRuleStates();
  sendJson(res, 200, { rows: rows.map(serializeRuleState) });
}
