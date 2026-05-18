/**
 * V3 CC 外接 plan Phase 4(2026-05-18)— Management API `/api/me/api-keys`。
 *
 * 见 docs/V3_CC_EXTERNAL_ENDPOINT_PLAN_2026-05-18.md §3.3 + §7 Phase 4。
 *
 * 三个 JWT-authed endpoints,用户自管自己的 CC 外接 API key:
 *
 *   GET    /api/me/api-keys       → list 未撤销 key(无 secret / 无 keyHash)
 *   POST   /api/me/api-keys       → 创建新 key,**返完整明文一次**
 *   DELETE /api/me/api-keys/:id   → 软撤销(set revoked_at)
 *
 * 关键不变量(plan §4 invariant #1):**list 响应严禁含 secret / keyHash**。
 *   - repo 层用 `ApiKeySummary`(没有 keyHash 字段)从 TS 类型上锁;
 *   - HTTP 层显式 `map → key_prefix only`,与 `ApiKeyRow.keyHash` 物理隔离。
 *
 * 路由职责:本文件只暴露 handler。注册放在 router.ts 的 `/api/me/*` 块:
 *   { method: 'GET',    path: '/api/me/api-keys',           handler: handleListMyApiKeys },
 *   { method: 'POST',   path: '/api/me/api-keys',           handler: handleCreateMyApiKey },
 *   { method: 'DELETE', pathPrefix: '/api/me/api-keys/',    handler: handleRevokeMyApiKey },
 *
 * Repo 工厂在每个 handler 内即时构造(`makePgApiKeyRepo(getPool())`),与 inbox /
 * preferences 等同型 handler 风格一致 —— 避免 `CommercialHttpDeps` 越长越像
 * service locator(Codex Phase 4 plan-review NIT 采纳)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HttpError,
  readJsonBody,
  sendJson,
} from "./util.js";
import type { CommercialHttpDeps, RequestContext } from "./handlers.js";
import { requireAuth } from "./auth.js";
import {
  makePgApiKeyRepo,
  ApiKeyRepoError,
  type CreatedApiKey,
} from "../auth/apiKeyRepo.js";
import { getPool } from "../db/index.js";

/**
 * PostgreSQL `BIGINT` 上限(2^63 - 1)。
 *
 * Path regex `[1-9][0-9]{0,19}` 接受 1..20 位数字,理论最大值 99999999999999999999
 * 远超 BIGINT。若直接交给 DB 会触发 numeric range error → 500。这里在 handler
 * 边界把超界 id 显式归一到 404,既阻断错误传播,也避免暴露 "id 是 BIGINT" 的内部
 * 实现细节(Codex Phase 4 plan-review MINOR 2 采纳)。
 */
const PG_BIGINT_MAX = 9223372036854775807n;

/** ────────────────────────────────────────────────────────────────────────
 * GET /api/me/api-keys
 *
 * 返当前 JWT user 所有未撤销 key 的元信息;字段限定为 prefix/label/timestamp。
 * **没有任何**与 secret 或 keyHash 相关的字段 —— invariant #1 的 HTTP 层落锁。
 * ──────────────────────────────────────────────────────────────────────── */
export async function handleListMyApiKeys(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const repo = makePgApiKeyRepo(getPool());
  const rows = await repo.list(BigInt(user.id));
  // 注意 BigInt 不能直接 JSON.stringify;统一 → string。
  // ApiKeySummary 类型本身没有 keyHash,这里映射出的对象天然不可能漏掉 secret。
  sendJson(res, 200, {
    keys: rows.map((r) => ({
      id: r.id.toString(),
      label: r.label,
      key_prefix: r.keyPrefix,
      created_at: r.createdAt.toISOString(),
      last_used_at: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    })),
  });
}

/** ────────────────────────────────────────────────────────────────────────
 * POST /api/me/api-keys { label }
 *
 * 创建新 key,**返完整明文 `oc-cc.<prefix>.<secret>` 一次**(后续无法再查)。
 * label trim 后须满足 1..80 字符(repo 层 CHECK);超长/空白由 repo 抛 LABEL_INVALID。
 * ──────────────────────────────────────────────────────────────────────── */
export async function handleCreateMyApiKey(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const body = await readJsonBody(req);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_BODY", "body must be a JSON object");
  }
  const label = (body as { label?: unknown }).label;
  if (typeof label !== "string") {
    throw new HttpError(400, "INVALID_LABEL", "label must be a string");
  }

  const repo = makePgApiKeyRepo(getPool());
  let created: CreatedApiKey;
  try {
    created = await repo.create(BigInt(user.id), label);
  } catch (err) {
    if (err instanceof ApiKeyRepoError) {
      if (err.code === "LABEL_INVALID") {
        throw new HttpError(400, "INVALID_LABEL", err.message);
      }
      // PREFIX_COLLISION_RETRIES_EXHAUSTED:36^8 ≈ 2.82T 空间,3 次都中是天体级
      // 巧合,实际几乎不会发生。映成 500 INTERNAL 让客户端有可观察响应;不再
      // 单独写告警链路(router 已统一 warn(http_error) — 与 Codex Phase 4
      // plan-review MINOR 1 收口,删除 "触发告警" 表述)。
      if (err.code === "PREFIX_COLLISION_RETRIES_EXHAUSTED") {
        throw new HttpError(500, "INTERNAL", "key generation failed; please retry");
      }
    }
    throw err;
  }

  sendJson(res, 201, {
    id: created.id.toString(),
    label: created.label,
    key_prefix: created.keyPrefix,
    /**
     * 完整明文 `oc-cc.<prefix>.<secret>`。**仅此一次**。
     *
     * 用户面板必须立即引导用户复制保存;后端永远无法重新生成该字符串
     * (keyHash = SHA-256(secret_raw) 不可逆,findByPrefix 也只返 keyHash)。
     * 服务端**不**做 "已展示" 状态机 — 没有能力知道用户是否真的保存了,
     * 加 display flag 只是 UI 自欺(Codex Phase 4 plan-review 同意,NIT 5)。
     */
    plaintext: created.plaintext,
    created_at: created.createdAt.toISOString(),
  });
}

/** ────────────────────────────────────────────────────────────────────────
 * DELETE /api/me/api-keys/:id
 *
 * 软撤销 — repo SQL `WHERE user_id=$1 AND id=$2 AND revoked_at IS NULL`。
 * 不存在 / 已撤销 / 不属于该 user 一律返 false → 404,**不暴露存在性**
 * (Codex Phase 4 plan-review §4 同意)。
 *
 * 与 Phase 2 strategy.findByPrefix 闭环:revoke 之后下次该 token 走 strategy
 * 直接 API_KEY_INVALID 401(SQL 已过滤 revoked_at IS NULL)。
 * ──────────────────────────────────────────────────────────────────────── */
export async function handleRevokeMyApiKey(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  // 严格 path:`/api/me/api-keys/:id`(id 纯数字,长度 ≤ 20 位上限同 BIGINT 文本长度)
  const m = url.pathname.match(/^\/api\/me\/api-keys\/([1-9][0-9]{0,19})$/);
  if (!m) {
    throw new HttpError(404, "NOT_FOUND", "expected /api/me/api-keys/:id");
  }
  const id = BigInt(m[1]!);
  // BIGINT 边缘锁:正则允许 20 位数字 → 可能超 PG BIGINT 上限;若交给 DB 会触发
  // numeric range error 500,这里截到 404 与 "不存在" 同一返回路径,避免泄漏
  // 内部存储类型(Codex Phase 4 plan-review MINOR 2 采纳)。
  if (id > PG_BIGINT_MAX) {
    throw new HttpError(404, "NOT_FOUND", "api key not found");
  }

  const repo = makePgApiKeyRepo(getPool());
  const ok = await repo.revoke(BigInt(user.id), id);
  if (!ok) {
    throw new HttpError(404, "NOT_FOUND", "api key not found");
  }
  sendJson(res, 200, { ok: true });
}
