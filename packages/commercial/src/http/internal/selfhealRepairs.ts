/**
 * v5 自愈体系切片② 块A — codex 回调端点(个人版 codex → v5 master)。
 *
 * 全部 /internal/ 路由(**非** /api/admin/,不套 admin gate;鉴权自理)。经 SSH 正向隧道
 * `-L 127.0.0.1:<callback>:127.0.0.1:<master_cb>` 到达,handler 首行校验 remoteAddress=loopback
 * (纵深防御,真正的信任根是 capability / webhook HMAC)。
 *
 *   POST /internal/v5/repairs/:id/{ack,progress,verify,done,failed}
 *        — Authorization: Bearer <capability>(逐 repair 短期 token,verifyCapability 绑 id)。
 *        — zod:message ≤4000 + detail 对象(长度上限);写库前 redactSensitive(codex 可能回传日志/凭据)。
 *        — 状态机 CAS:ack→acked / progress→running(追加 event)/ verify→记 verify_after /
 *          done→verifying(**不直接 succeeded**,等 sweeper 探测 fence)/ failed→failed+fail_reason。
 *   POST /internal/v5/repairs/:id/claim-capability
 *        — webhook HMAC 鉴权(**非** capability):个人版 gateway 用自己凭证换该 repair 的短期 capability。
 *   GET  /internal/v5/repairs/:id/context
 *        — capability 鉴权 → getRepairContext(结构化只读脱敏,防注入)。
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PoolClient } from "pg";
import { z } from "zod";

import { query, tx } from "../../db/queries.js";
import { rootLogger } from "../../logging/logger.js";
import { redactSensitive } from "../../admin/auditRedact.js";
import { issueCapability, verifyCapability } from "../../selfheal/capability.js";
import { getRepairContext } from "../../selfheal/repairContext.js";
import {
  ensureRequestId,
  readJsonBody,
  sendError,
  sendJson,
  setSecurityHeaders,
  HttpError,
  REQUEST_ID_HEADER,
} from "../util.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";

export const SELFHEAL_REPAIRS_PREFIX = "/internal/v5/repairs/";

const log = rootLogger.child({ subsys: "selfheal", module: "repairCallbacks" });

const ROUTE_RE =
  /^\/internal\/v5\/repairs\/([1-9][0-9]{0,19})\/(ack|progress|verify|done|failed|claim-capability|context)$/;

/** done/verify 后的探测确认预算:6min(env 覆盖)。sweeper verify fence 用 verify_deadline。 */
function verifyBudgetMs(): number {
  const raw = Number(process.env.OC_SELFHEAL_VERIFY_BUDGET_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 6 * 60 * 1000;
}

const WEBHOOK_TS_WINDOW_MS = 120_000;
const DETAIL_MAX_BYTES = 16 * 1024;

/** 活跃(非终态)状态:回调只在活跃态有效。 */
const ACTIVE = ["dispatched", "acked", "running", "verifying"];

// ─── 鉴权 helpers ──────────────────────────────────────────────────────

function isLoopback(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? "";
  return /^(127\.|::1$|::ffff:127\.)/.test(ip);
}

/** 提取 Bearer capability token。 */
function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** 一次性 nonce 缓存(webhook 防重放)。in-memory,单 master;窗口外靠 ts 兜底。 */
const seenNonces = new Map<string, number>();
const NONCE_MAX = 8192;
function nonceFresh(nonce: string, now: number): boolean {
  const prev = seenNonces.get(nonce);
  if (prev !== undefined && now - prev < WEBHOOK_TS_WINDOW_MS) return false;
  if (seenNonces.size >= NONCE_MAX) {
    for (const [k, t] of seenNonces) {
      if (now - t >= WEBHOOK_TS_WINDOW_MS) seenNonces.delete(k);
    }
  }
  seenNonces.set(nonce, now);
  return true;
}

/** webhook HMAC 校验(claim-capability 用)。校验 ts 窗口 + nonce 未见 + sig。 */
function verifyWebhookSig(
  req: IncomingMessage,
  repairId: string,
  rawBody: string,
  now: number,
): boolean {
  const secret = process.env.OC_SELFHEAL_WEBHOOK_HMAC;
  if (!secret) return false;
  const ts = req.headers["x-selfheal-ts"];
  const nonce = req.headers["x-selfheal-nonce"];
  const sig = req.headers["x-selfheal-sig"];
  if (typeof ts !== "string" || typeof nonce !== "string" || typeof sig !== "string") return false;
  const tsn = Number(ts);
  if (!Number.isFinite(tsn) || Math.abs(now - tsn) > WEBHOOK_TS_WINDOW_MS) return false;
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const bodySha = createHash("sha256").update(rawBody).digest("hex");
  const expected = createHmac("sha256", secret)
    .update(`${ts}.${nonce}.${repairId}.${bodySha}`)
    .digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  // sig 验过才写 nonce(RFC M-HMAC-route:验签成功才写 nonce)。
  return nonceFresh(nonce, now);
}

// ─── body 校验 + 脱敏 ──────────────────────────────────────────────────

const CallbackBody = z
  .object({
    message: z.string().min(1).max(4000),
    detail: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** 脱敏 + 体积上限:超限则整体替换为 marker(codex 回传可能极大/夹带凭据)。 */
function safeDetail(detail: unknown): Record<string, unknown> {
  if (detail === undefined || detail === null) return {};
  const redacted = redactSensitive(detail);
  const s = JSON.stringify(redacted);
  if (s.length > DETAIL_MAX_BYTES) return { __truncated: true, len: s.length };
  return (redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : { value: redacted }) as Record<string, unknown>;
}

// ─── 状态机 CAS ────────────────────────────────────────────────────────

interface RepairState {
  status: string;
  attempt: number;
}
async function loadRepair(id: string): Promise<RepairState | null> {
  const r = await query<{ status: string; attempt: number }>(
    `SELECT status, attempt FROM codex_repairs WHERE id = $1::bigint`,
    [id],
  );
  return r.rows[0] ?? null;
}

type ActionResult =
  | { code: "ok"; body: Record<string, unknown> }
  | { code: "not_found" }
  | { code: "conflict"; message: string };

/** 追加 append-only 进度事件(同 client 事务)。 */
async function appendEvent(
  client: PoolClient,
  repairId: string,
  kind: string,
  message: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO codex_repair_events (repair_id, kind, message, detail)
     VALUES ($1::bigint, $2, $3, $4::jsonb)`,
    [repairId, kind, message.slice(0, 4000), JSON.stringify(detail)],
  );
}

async function handleAck(id: string, message: string, detail: Record<string, unknown>): Promise<ActionResult> {
  return tx(async (client) => {
    const cas = await client.query(
      `UPDATE codex_repairs SET status='acked', acked_at=NOW(), updated_at=NOW()
        WHERE id=$1::bigint AND status='dispatched'`,
      [id],
    );
    if ((cas.rowCount ?? 0) === 0) {
      const cur = await client.query<{ status: string }>(`SELECT status FROM codex_repairs WHERE id=$1::bigint`, [id]);
      const st = cur.rows[0]?.status;
      if (!st) return { code: "not_found" };
      if (st === "acked" || ACTIVE.includes(st)) {
        await appendEvent(client, id, "ack", message, detail);
        return { code: "ok", body: { status: st } };
      }
      return { code: "conflict", message: `repair is ${st}` };
    }
    await appendEvent(client, id, "ack", message, detail);
    return { code: "ok", body: { status: "acked" } };
  });
}

async function handleProgress(id: string, message: string, detail: Record<string, unknown>): Promise<ActionResult> {
  return tx(async (client) => {
    const cas = await client.query(
      `UPDATE codex_repairs SET status='running', updated_at=NOW()
        WHERE id=$1::bigint AND status IN ('acked','running')`,
      [id],
    );
    if ((cas.rowCount ?? 0) === 0) {
      const cur = await client.query<{ status: string }>(`SELECT status FROM codex_repairs WHERE id=$1::bigint`, [id]);
      const st = cur.rows[0]?.status;
      if (!st) return { code: "not_found" };
      if (!ACTIVE.includes(st)) return { code: "conflict", message: `repair is ${st}` };
      // dispatched/verifying:允许记录进度,不改状态
    }
    await appendEvent(client, id, "progress", message, detail);
    return { code: "ok", body: { status: "running" } };
  });
}

async function handleVerify(id: string, message: string, detail: Record<string, unknown>): Promise<ActionResult> {
  const budget = verifyBudgetMs();
  return tx(async (client) => {
    const cas = await client.query(
      `UPDATE codex_repairs
          SET verify_after=NOW(),
              verify_deadline=NOW() + ($2::bigint * INTERVAL '1 millisecond'),
              updated_at=NOW()
        WHERE id=$1::bigint AND status IN ('acked','running','verifying')`,
      [id, budget],
    );
    if ((cas.rowCount ?? 0) === 0) {
      const cur = await client.query<{ status: string }>(`SELECT status FROM codex_repairs WHERE id=$1::bigint`, [id]);
      const st = cur.rows[0]?.status;
      if (!st) return { code: "not_found" };
      return { code: "conflict", message: `repair is ${st}` };
    }
    await appendEvent(client, id, "verify", message, detail);
    return { code: "ok", body: { status: "verifying_pending" } };
  });
}

async function handleDone(id: string, message: string, detail: Record<string, unknown>): Promise<ActionResult> {
  const budget = verifyBudgetMs();
  return tx(async (client) => {
    // done → verifying(不直接 succeeded);verify_after=done_at(freshness fence 锚点)。
    const cas = await client.query(
      `UPDATE codex_repairs
          SET status='verifying',
              summary=$3,
              verify_after=COALESCE(verify_after, NOW()),
              verify_deadline=COALESCE(verify_deadline, NOW() + ($2::bigint * INTERVAL '1 millisecond')),
              updated_at=NOW()
        WHERE id=$1::bigint AND status IN ('acked','running','verifying')`,
      [id, budget, message.slice(0, 1000)],
    );
    if ((cas.rowCount ?? 0) === 0) {
      const cur = await client.query<{ status: string }>(`SELECT status FROM codex_repairs WHERE id=$1::bigint`, [id]);
      const st = cur.rows[0]?.status;
      if (!st) return { code: "not_found" };
      if (st === "verifying") {
        await appendEvent(client, id, "done", message, detail);
        return { code: "ok", body: { status: "verifying" } };
      }
      return { code: "conflict", message: `repair is ${st}` };
    }
    await appendEvent(client, id, "done", message, detail);
    return { code: "ok", body: { status: "verifying" } };
  });
}

async function handleFailed(id: string, message: string, detail: Record<string, unknown>): Promise<ActionResult> {
  return tx(async (client) => {
    const cas = await client.query(
      `UPDATE codex_repairs
          SET status='failed', fail_reason=$2, finished_at=NOW(), updated_at=NOW()
        WHERE id=$1::bigint AND status IN ('dispatched','acked','running','verifying')`,
      [id, message.slice(0, 2000)],
    );
    if ((cas.rowCount ?? 0) === 0) {
      const cur = await client.query<{ status: string }>(`SELECT status FROM codex_repairs WHERE id=$1::bigint`, [id]);
      const st = cur.rows[0]?.status;
      if (!st) return { code: "not_found" };
      if (st === "failed") return { code: "ok", body: { status: "failed" } };
      return { code: "conflict", message: `repair is ${st}` };
    }
    await appendEvent(client, id, "failed", message, detail);
    return { code: "ok", body: { status: "failed" } };
  });
}

// ─── 端点分发 ──────────────────────────────────────────────────────────

const CAPABILITY_ACTIONS = new Set(["ack", "progress", "verify", "done", "failed"]);

/** router ANY_METHOD prefix handler:按 method + action 分发。鉴权自理(capability / webhook HMAC)。 */
export async function dispatchSelfhealRepairsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
): Promise<void> {
  setSecurityHeaders(res);
  const requestId = ensureRequestId(req);
  res.setHeader(REQUEST_ID_HEADER, requestId);
  const now = Date.now();

  if (!isLoopback(req)) {
    sendError(res, 403, "FORBIDDEN", "loopback only", requestId);
    return;
  }

  const path = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`).pathname;
  const m = ROUTE_RE.exec(path);
  if (!m) {
    sendError(res, 404, "NOT_FOUND", "endpoint not found", requestId);
    return;
  }
  const repairId = m[1];
  const action = m[2];
  const method = req.method ?? "GET";

  // ── GET context(capability)──
  if (action === "context") {
    if (method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "GET required", requestId, undefined, { Allow: "GET" });
      return;
    }
    const cap = verifyCapability(bearer(req) ?? "", repairId, now);
    if (!cap.ok) {
      sendError(res, 401, "UNAUTHORIZED", "invalid capability", requestId);
      return;
    }
    try {
      const ctx = await getRepairContext(repairId, { query });
      if (!ctx) {
        sendError(res, 404, "NOT_FOUND", "repair not found", requestId);
        return;
      }
      sendJson(res, 200, ctx, { [REQUEST_ID_HEADER]: requestId });
    } catch (err) {
      if (err instanceof RangeError) {
        sendError(res, 400, "VALIDATION", "invalid repair id", requestId);
        return;
      }
      log.error("selfheal_context_failed", { repairId, err: (err as Error)?.message });
      sendError(res, 500, "INTERNAL", "context lookup failed", requestId);
    }
    return;
  }

  // ── POST claim-capability(webhook HMAC)──
  if (action === "claim-capability") {
    if (method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "POST required", requestId, undefined, { Allow: "POST" });
      return;
    }
    let rawBody = "";
    try {
      rawBody = await readRawText(req);
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message, requestId);
        return;
      }
      throw err;
    }
    if (!verifyWebhookSig(req, repairId, rawBody, now)) {
      sendError(res, 401, "UNAUTHORIZED", "invalid webhook signature", requestId);
      return;
    }
    const st = await loadRepair(repairId);
    if (!st) {
      sendError(res, 404, "NOT_FOUND", "repair not found", requestId);
      return;
    }
    // 仅活跃修复可换 capability(终态修复不需要回调面)。
    if (!ACTIVE.includes(st.status) && st.status !== "pending") {
      sendError(res, 409, "CONFLICT", `repair is ${st.status}`, requestId);
      return;
    }
    const cap = issueCapability(repairId, st.attempt, now);
    sendJson(res, 200, { token: cap.token, exp: cap.exp, attempt: st.attempt }, {
      [REQUEST_ID_HEADER]: requestId,
    });
    return;
  }

  // ── POST ack/progress/verify/done/failed(capability)──
  if (!CAPABILITY_ACTIONS.has(action)) {
    sendError(res, 404, "NOT_FOUND", "endpoint not found", requestId);
    return;
  }
  if (method !== "POST") {
    sendError(res, 405, "METHOD_NOT_ALLOWED", "POST required", requestId, undefined, { Allow: "POST" });
    return;
  }
  const cap = verifyCapability(bearer(req) ?? "", repairId, now);
  if (!cap.ok) {
    sendError(res, 401, "UNAUTHORIZED", "invalid capability", requestId);
    return;
  }

  let parsed: z.infer<typeof CallbackBody>;
  try {
    const raw = await readJsonBody(req);
    const r = CallbackBody.safeParse(raw);
    if (!r.success) {
      sendError(res, 400, "INVALID_BODY", "body schema rejected", requestId);
      return;
    }
    parsed = r.data;
  } catch (err) {
    if (err instanceof HttpError) {
      sendError(res, err.status, err.code, err.message, requestId);
      return;
    }
    throw err;
  }

  const detail = safeDetail(parsed.detail);
  const message = parsed.message;

  try {
    let result: ActionResult;
    switch (action) {
      case "ack":
        result = await handleAck(repairId, message, detail);
        break;
      case "progress":
        result = await handleProgress(repairId, message, detail);
        break;
      case "verify":
        result = await handleVerify(repairId, message, detail);
        break;
      case "done":
        result = await handleDone(repairId, message, detail);
        break;
      case "failed":
        result = await handleFailed(repairId, message, detail);
        break;
      default:
        result = { code: "not_found" };
    }
    if (result.code === "not_found") {
      sendError(res, 404, "NOT_FOUND", "repair not found", requestId);
      return;
    }
    if (result.code === "conflict") {
      sendError(res, 409, "CONFLICT", result.message, requestId);
      return;
    }
    sendJson(res, 200, { ok: true, ...result.body }, { [REQUEST_ID_HEADER]: requestId });
  } catch (err) {
    log.error("selfheal_callback_failed", { repairId, action, err: (err as Error)?.message });
    sendError(res, 500, "INTERNAL", "callback processing failed", requestId);
  }
}

/** 读 raw 文本 body(claim-capability 需原文算 bodySha256)。复用 util 大小上限语义。 */
async function readRawText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX = 64 * 1024;
  for await (const chunk of req) {
    const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "request body too large");
    chunks.push(buf);
  }
  return total === 0 ? "" : Buffer.concat(chunks).toString("utf8");
}
