/**
 * /api/admin/sessions — admin 侧只读查看用户会话内容。
 *
 * 入口:
 *   - GET  /api/admin/sessions/:id[?user_id=:userId&offset&limit] 旧诊断分页
 *   - GET  /api/admin/sessions/:id?user_id=:userId&view=chat      对话 UI 热尾快照
 *   - GET  /api/admin/sessions/:id/archive?user_id=:userId&before&limit
 *   - POST /api/admin/sessions/:id/media-sign?user_id=:userId     目标用户媒体短签
 *
 * 鉴权:
 *   - requireAdminVerifyDb(每次 DB 复核 admin 角色)
 *   - 比普通 list 接口更严: 这个接口暴露用户完整对话内容,
 *     不能仅靠 JWT TTL 内还有效就放行 —— 万一 admin 已被降权,
 *     必须靠 DB 反查拦截
 *
 * 审计语义:
 *   - 读取完整用户会话也写低敏 admin_audit,但只记录谁看了哪个 session /
 *     分页范围 / requestId,不记录 message 内容。
 *
 * user_id scope:
 *   - 不带 ?user_id= → admin override,任何 session 都能拿
 *   - 带 ?user_id=N → cross-check sessionUserId === `c:N`,不匹配返回 404
 *     (避免前端从用户详情页点 row 却显示别人的会话,混淆)
 *   注意:URL 上 user_id 是裸 bigint(例如 ?user_id=1),内部转 `c:1` 再喂
 *   storage 层 —— commercial namespace 在 master SQLite 里始终带 c: 前缀
 *   (见 handlers.ts:1592 / internalServerAuthored.ts:400 的同款 inline 约定)。
 *   忘加前缀会让 session_id 即便对了 user_id 也永远 0 行 → 404。
 *
 * 返回 messages 含 tool_use / tool_result blocks:
 *   - admin = boss 本人(single-admin personal platform),诊断需要完整对话脉络
 *   - storage 层 MAX_SESSION_BYTES=4MB 已经兜底体积上限,无需后端再做 sanitize
 *   - 如果未来 admin 角色扩散到多人,再加 ?include_tools=0 默认开关
 *
 * Response-level 分页(?offset & ?limit):
 *   - 目的:大会话(数百条消息 + tool_result blob)一次性塞进前端会拖死浏览器
 *     渲染。前端在 modal 内分批拉,首屏 50 条 + "加载更多" 累加。
 *   - **这不是 storage-level pagination** —— SQLite client_sessions.messages 是
 *     单 JSON TEXT,DB 必然全行读;切片只发生在 handler return 前。省的是网络
 *     和前端 JSON parse + DOM,不是磁盘 IO。如果未来要真增量,需另立 message-level
 *     schema(本次不做)。
 *   - offset 默认 0,limit 默认 50。**越界直接 400**(不 silent clamp):
 *     offset ∉ [0, 100000] / limit ∉ [1, 200] 都按 VALIDATION 报错,
 *     避免 boss 调试时非法参数被悄悄替换成默认值反而难定位。
 *   - 返回里附 total_messages / offset / limit / has_more 供前端推 nextOffset。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve as resolvePath } from "node:path";
import { HttpError, readJsonBody, sendJson } from "../util.js";
import { requireAdminVerifyDb } from "../../admin/requireAdmin.js";
import type { CommercialHttpDeps, RequestContext } from "../handlers.js";
import { getClientSession, readArchivedMessages } from "@openclaude/storage";
import { parseBigintIdParam } from "./_shared.js";
import { getPool } from "../../db/index.js";
import { writeAdminAudit } from "../../admin/audit.js";
import {
  DEFAULT_SIGN_TTL_MS,
  buildOpaqueMediaFileUrl,
  buildOpaqueSignedUrl,
  extractApiMediaFilename,
  isContainerPathAllowed,
  normalizeSignBatchInput,
} from "../mediaSign.js";

// session id 在 client_sessions 表是 TEXT PRIMARY KEY,
// 实际格式有 UUID / web-... / nanoid 等,统一收口为字母数字 + '-_',
// 1..128 字符。bigint extractTailId 不适用。
const SESSION_PATH_RE = /^([A-Za-z0-9_-]{1,128})(?:\/(archive|media-sign))?$/;
const COMMERCIAL_SESSION_USER_RE = /^c:[1-9][0-9]{0,18}$/;

export type AdminSessionRoute = {
  sessionId: string;
  kind: "detail" | "archive" | "media-sign";
};

export function parseAdminSessionRoute(url: URL): AdminSessionRoute {
  const tail = url.pathname.slice("/api/admin/sessions/".length);
  const match = SESSION_PATH_RE.exec(tail);
  if (!match) {
    throw new HttpError(400, "VALIDATION", "invalid session id in URL", {
      issues: [{ path: "id", message: tail }],
    });
  }
  return {
    sessionId: match[1]!,
    kind:
      match[2] === "archive"
        ? "archive"
        : match[2] === "media-sign"
          ? "media-sign"
          : "detail",
  };
}

/** offset / limit 解析,失败抛 400 VALIDATION。 */
function parsePagingParams(url: URL): { offset: number; limit: number } {
  const offRaw = url.searchParams.get("offset");
  const limRaw = url.searchParams.get("limit");
  let offset = 0;
  let limit = 50;
  if (offRaw != null) {
    const n = Number(offRaw);
    if (!Number.isInteger(n) || n < 0 || n > 100_000) {
      throw new HttpError(400, "VALIDATION", "offset must be integer in [0, 100000]", {
        issues: [{ path: "offset", message: offRaw }],
      });
    }
    offset = n;
  }
  if (limRaw != null) {
    const n = Number(limRaw);
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      throw new HttpError(400, "VALIDATION", "limit must be integer in [1, 200]", {
        issues: [{ path: "limit", message: limRaw }],
      });
    }
    limit = n;
  }
  return { offset, limit };
}

export function parseArchivePagingParams(url: URL): { before: number; limit: number } {
  const beforeRaw = url.searchParams.get("before");
  const limitRaw = url.searchParams.get("limit");
  let before = 0;
  let limit = 100;
  if (beforeRaw != null && beforeRaw !== "") {
    const n = Number(beforeRaw);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new HttpError(400, "VALIDATION", "before must be a non-negative safe integer", {
        issues: [{ path: "before", message: beforeRaw }],
      });
    }
    before = n;
  }
  if (limitRaw != null && limitRaw !== "") {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      throw new HttpError(400, "VALIDATION", "limit must be integer in [1, 200]", {
        issues: [{ path: "limit", message: limitRaw }],
      });
    }
    limit = n;
  }
  return { before, limit };
}

function scopedSessionUserId(url: URL): { rawUserId?: string; scopedUserId?: string } {
  const rawUserId = parseBigintIdParam(url.searchParams.get("user_id"), "user_id");
  return { rawUserId, scopedUserId: rawUserId ? `c:${rawUserId}` : undefined };
}

export async function handleAdminGetSession(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const route = parseAdminSessionRoute(url);
  if (route.kind === "media-sign") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "media-sign requires POST");
  }
  const sessionId = route.sessionId;
  // 可选 user_id scope —— 带就走 cross-check 路径(避免点 A 用户行看到 B 用户 session)。
  // 注意 namespace:URL 接收裸 bigint,内部拼 `c:${id}` 喂 storage(避免 `c:undefined`,
  // 不带 user_id 仍走 admin override = getClientSession 的 userId 形参 undefined 分支)。
  const { scopedUserId } = scopedSessionUserId(url);

  if (route.kind === "archive") {
    const { before, limit } = parseArchivePagingParams(url);
    // owner 必须经 storage backend 从权威会话行派生，不能信任前端 user_id；同时避免
    // HTTP 层直连 client_sessions，保持 SQLite/PG backend 的单一抽象边界。
    const session = await getClientSession(sessionId, scopedUserId);
    if (!session) throw new HttpError(404, "NOT_FOUND", "session not found");
    const page = await readArchivedMessages(sessionId, session.userId, before, limit);
    await writeAdminAudit(getPool(), {
      adminId: admin.id,
      action: "sessions.read",
      target: `session:${sessionId}`,
      before: null,
      after: {
        mode: "archive",
        session_id: sessionId,
        target_user_id: session.userId,
        scoped_user_id: scopedUserId ?? null,
        before_seq: before,
        limit,
        returned_messages: page.messages.length,
        oldest_seq: page.oldestSeq,
        has_more: page.hasMore,
        request_id: ctx.requestId,
      },
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, {
      session_id: sessionId,
      messages: page.messages,
      oldest_seq: page.oldestSeq,
      has_more: page.hasMore,
    });
    return;
  }

  const view = url.searchParams.get("view");
  if (view !== null && view !== "chat") {
    throw new HttpError(400, "VALIDATION", "view must be chat", {
      issues: [{ path: "view", message: view }],
    });
  }
  const { offset, limit } = parsePagingParams(url);
  const s = await getClientSession(sessionId, scopedUserId);
  if (!s) throw new HttpError(404, "NOT_FOUND", "session not found");

  // chat 模式与用户端 GET /api/sessions/:id 同源：一次返回完整热尾（含 lossless tape
  // hydration），更早历史只走 /archive 的 _seq 游标。禁止再按 response offset 切 tape。
  if (view === "chat") {
    const messages = Array.isArray(s.messages) ? s.messages : [];
    await writeAdminAudit(getPool(), {
      adminId: admin.id,
      action: "sessions.read",
      target: `session:${sessionId}`,
      before: null,
      after: {
        mode: "chat",
        session_id: sessionId,
        target_user_id: s.userId,
        scoped_user_id: scopedUserId ?? null,
        returned_messages: messages.length,
        archived_count: s.archivedCount ?? 0,
        request_id: ctx.requestId,
      },
      ip: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    sendJson(res, 200, {
      session: {
        id: s.id,
        user_id: s.userId,
        agent_id: s.agentId,
        title: s.title,
        pinned: s.pinned,
        created_at: s.createdAt,
        last_at: s.lastAt,
        updated_at: s.updatedAt,
        messages,
        archived_count: s.archivedCount ?? 0,
        archived_through_seq: s.archivedThroughSeq ?? 0,
      },
    });
    return;
  }
  // 长会话热尾巴+归档:getClientSession 返回的 s.messages 只是**尾巴**(spill 后老消息
  // 搬去归档表),完整会话 = 归档(更老)+ 尾巴。admin 诊断需要看到全部。
  //   - 虚拟全量数组 = [尾巴(时序 old→new)] ++ [归档(newest-first)],offset 越过
  //     尾巴范围就用 readArchivedMessages 补齐(§2.4,"不重构现有分页":尾巴切片逻辑不动,
  //     仅在窗口越界时追加归档)。
  //   - 归档用真实 owner(s.userId)分租读:admin override(scopedUserId=undefined)也能读,
  //     且 scoped 时 getClientSession 已校验 s.userId===scopedUserId,一致。
  const tail = Array.isArray(s.messages) ? s.messages : [];
  const tailLen = tail.length;
  const archivedCount = s.archivedCount ?? 0;
  const total = tailLen + archivedCount;
  // 尾巴切片(维持原有 offset/limit 语义):窗口落在 [0, tailLen) 的部分。
  const tailSlice =
    offset < tailLen ? tail.slice(offset, Math.min(offset + limit, tailLen)) : [];
  // 归档切片:窗口越过尾巴的部分。虚拟索引 tailLen+j = 第 j 新的归档消息。
  const aStart = Math.max(offset, tailLen);
  const aEnd = Math.min(offset + limit, total);
  let archivedSlice: unknown[] = [];
  if (aStart < aEnd) {
    archivedSlice = await readAdminArchivedWindow(
      sessionId,
      s.userId,
      aStart - tailLen, // skip:跳过多少条最新归档
      aEnd - aStart, // need:取多少条
    );
  }
  const slice = [...tailSlice, ...archivedSlice];
  const has_more = offset + slice.length < total;
  await writeAdminAudit(getPool(), {
    adminId: admin.id,
    action: "sessions.read",
    target: `session:${sessionId}`,
    before: null,
    after: {
      session_id: sessionId,
      target_user_id: s.userId,
      scoped_user_id: scopedUserId ?? null,
      offset,
      limit,
      returned_messages: slice.length,
      total_messages: total,
      request_id: ctx.requestId,
    },
    ip: ctx.clientIp,
    userAgent: ctx.userAgent,
  });
  sendJson(res, 200, {
    session: {
      id: s.id,
      user_id: s.userId,
      agent_id: s.agentId,
      title: s.title,
      pinned: s.pinned,
      created_at: s.createdAt,
      last_at: s.lastAt,
      updated_at: s.updatedAt,
      messages: slice,
      total_messages: total,
      // 热尾巴+归档诊断字段:归档条数 + 水位,便于 admin 知道尾巴之外还有多少历史。
      archived_count: archivedCount,
      archived_through_seq: s.archivedThroughSeq ?? 0,
      offset,
      limit,
      has_more,
    },
  });
}

export async function handleAdminSignSessionMedia(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const admin = await requireAdminVerifyDb(req, deps.jwtSecret);
  if (!deps.mediaSignKey) {
    throw new HttpError(503, "SIGN_DISABLED", "media signed URL not configured");
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const route = parseAdminSessionRoute(url);
  if (route.kind !== "media-sign") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "admin session detail and archive require GET");
  }
  const { scopedUserId } = scopedSessionUserId(url);
  // 与 archive 相同：签名主体只取权威 session owner，URL user_id 仅用于 fail-closed scope。
  const session = await getClientSession(route.sessionId, scopedUserId);
  if (!session || !COMMERCIAL_SESSION_USER_RE.test(session.userId)) {
    throw new HttpError(404, "NOT_FOUND", "session not found");
  }

  const body = (await readJsonBody(req)) as { paths?: unknown } | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "body must be a JSON object");
  }
  const norm = normalizeSignBatchInput(body.paths);
  if (!norm.ok) throw new HttpError(400, "VALIDATION", norm.message);

  const urls: Record<string, string> = {};
  let expMs = Date.now() + DEFAULT_SIGN_TTL_MS;
  for (const path of norm.paths) {
    const mediaFile = extractApiMediaFilename(path);
    if (mediaFile) {
      const signed = buildOpaqueMediaFileUrl(deps.mediaSignKey, mediaFile, session.userId);
      urls[path] = signed.url;
      expMs = Math.min(expMs, signed.expMs);
      continue;
    }
    let resolved: string;
    try {
      resolved = resolvePath(path);
    } catch {
      continue;
    }
    if (!isContainerPathAllowed(resolved)) continue;
    const signed = buildOpaqueSignedUrl(deps.mediaSignKey, path, session.userId);
    urls[path] = signed.url;
    expMs = Math.min(expMs, signed.expMs);
  }

  await writeAdminAudit(getPool(), {
    adminId: admin.id,
    action: "sessions.read",
    target: `session:${route.sessionId}`,
    before: null,
    after: {
      mode: "media-sign",
      session_id: route.sessionId,
      target_user_id: session.userId,
      scoped_user_id: scopedUserId ?? null,
      requested_paths: norm.paths.length,
      signed_paths: Object.keys(urls).length,
      request_id: ctx.requestId,
    },
    ip: ctx.clientIp,
    userAgent: ctx.userAgent,
  });
  sendJson(res, 200, { urls, expMs });
}

/**
 * admin 归档窗口读取(§2.4)。虚拟全量数组把归档区排在尾巴之后、以 newest-first 呈现;
 * readArchivedMessages 游标只能 newest→older 翻页,故按需从最新归档页 walk:跳过
 * `skip` 条最新归档,再取 `need` 条。admin 低频诊断,O(skip/pageSize) 次读可接受。
 *
 * 注:offset 分页与 storage 的 cursor 语义存在阻抗失配(offset 深翻会重走前缀页);
 * 未来 admin 前端可改用与用户面 /api/sessions/:id/archive 一致的 cursor 翻页消除重走。
 */
async function readAdminArchivedWindow(
  sessionId: string,
  ownerUserId: string,
  skip: number,
  need: number,
): Promise<unknown[]> {
  const out: unknown[] = [];
  let before = 0; // 0 = 最新归档页(archived_through_seq+1 起)
  let toSkip = Math.max(0, skip);
  let remaining = Math.max(0, need);
  // 防御:归档条数有界,但仍加硬上限防 storage 返回异常时死循环。
  for (let guard = 0; guard < 10_000 && remaining > 0; guard++) {
    const page = await readArchivedMessages(sessionId, ownerUserId, before, 200);
    const msgs = Array.isArray(page.messages) ? page.messages : [];
    if (msgs.length === 0) break;
    // 本页升序(old→new)→ reverse 成 newest→oldest 拼进虚拟顺序。
    const newestFirst = msgs.slice().reverse();
    if (toSkip >= newestFirst.length) {
      toSkip -= newestFirst.length;
    } else {
      for (let i = toSkip; i < newestFirst.length && remaining > 0; i++) {
        out.push(newestFirst[i]);
        remaining--;
      }
      toSkip = 0;
    }
    if (!page.hasMore) break;
    // 游标向更老翻:下一页读 _seq < 本页 oldestSeq。oldestSeq 应严格递减;
    // 非正 / 未递减(before>0 且未变小)则停,防 storage 异常时死循环。
    const next = page.oldestSeq ?? 0;
    if (next <= 0 || (before > 0 && next >= before)) break;
    before = next;
  }
  return out;
}
