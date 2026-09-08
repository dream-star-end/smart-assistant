/**
 * 0279 — 外接 API-key(/api/anthropic)请求的用户消息审计。
 *
 * 管理员裁定(2026-09-08):每条经 `oc-cc.*` key 进来的 `/v1/messages` 请求落一行
 * `api_key_message_audit`,记录**用户本轮实际输入的最后一条消息**(≤4096 字节)、请求体
 * 指纹/形状、解析后的模型+档位、账号与结果。不存 system prompt / 工具 schema / 历史 /
 * 模型回复。仅 admin 可读(GET /api/me/api-keys/messages);90 天 TTL(auditRetention)。
 *
 * 写入是 fire-and-forget:在 cursorExternal 结算之后调用,任何失败只打日志,**绝不影响
 * 请求响应或计费**。本模块只做纯函数 + 一条 INSERT,便于单测。
 */

import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { ProxyBody } from "../http/proxy/shared.js";

/** `last_user_message` 的 UTF-8 字节上限(与迁移注释一致)。 */
export const LAST_USER_MESSAGE_MAX_BYTES = 4096;
/** `error_message` 上限。 */
export const AUDIT_ERROR_MESSAGE_MAX_CHARS = 512;

export interface LastUserMessage {
  text: string | null;
  truncated: boolean;
}

/**
 * 最后一条 `role: "user"` 消息里的文本块拼接(`text` 类型;`tool_result` / 图片 / 文档
 * 不算)。纯 tool_result 续轮(Claude Code 执行完工具回传结果)→ `text: null`。
 * 字符串 content 视作单个文本块。按 UTF-8 字节截断,不切开多字节字符。
 */
export function extractLastUserMessage(
  messages: unknown,
  maxBytes: number = LAST_USER_MESSAGE_MAX_BYTES,
): LastUserMessage {
  if (!Array.isArray(messages)) return { text: null, truncated: false };
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") continue;
    const rec = m as { role?: unknown; content?: unknown };
    if (rec.role !== "user") continue;
    let text: string;
    if (typeof rec.content === "string") {
      text = rec.content;
    } else if (Array.isArray(rec.content)) {
      const parts: string[] = [];
      for (const block of rec.content) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: unknown; text?: unknown };
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
      if (parts.length === 0) return { text: null, truncated: false };
      text = parts.join("\n");
    } else {
      return { text: null, truncated: false };
    }
    return truncateUtf8(text, maxBytes);
  }
  return { text: null, truncated: false };
}

/** UTF-8 字节截断,保证不产生半个字符。 */
export function truncateUtf8(text: string, maxBytes: number): LastUserMessage {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // 回退到字符边界:UTF-8 续字节形如 10xxxxxx。
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

export interface RequestShape {
  bodySha256: string;
  bodyBytes: number;
  messageCount: number;
  toolCount: number;
  stream: boolean;
}

/**
 * 请求体指纹与形状。指纹取 **canonical JSON(键排序)** 的 SHA-256:proxy 入口已把
 * 原始字节 parse 掉,重新序列化后键序可能与客户端不同,排序后同一逻辑请求得到同一指纹,
 * 便于与客户端侧日志对账(客户端可用同样的 canonical 规则复算)。
 */
export function describeRequestShape(body: ProxyBody): RequestShape {
  const canonical = canonicalJson(body);
  return {
    bodySha256: createHash("sha256").update(canonical).digest("hex"),
    bodyBytes: Buffer.byteLength(canonical, "utf8"),
    messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    stream: body.stream === true,
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export interface ApiKeyMessageAuditRow {
  requestId: string;
  userId: bigint;
  apiKeyId: bigint | null;
  requestedModel: string;
  model: string;
  effort: string | null;
  effortSource: string | null;
  accountId: bigint | null;
  shape: RequestShape;
  lastUserMessage: LastUserMessage;
  status: "success" | "error";
  terminalCode: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  usage: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
  };
  clientUserAgent: string | null;
}

/** 从 relay 的 Anthropic 形 usage 对象(snake_case)抽四个计数;缺省 null。 */
export function usageCounts(usage: unknown): ApiKeyMessageAuditRow["usage"] {
  if (!usage || typeof usage !== "object") return {};
  const u = usage as Record<string, unknown>;
  const num = (k: string): number | null => (typeof u[k] === "number" && Number.isFinite(u[k]) ? (u[k] as number) : null);
  return {
    inputTokens: num("input_tokens"),
    outputTokens: num("output_tokens"),
    cacheReadTokens: num("cache_read_input_tokens"),
    cacheWriteTokens: num("cache_creation_input_tokens"),
  };
}

const INSERT_SQL = `
INSERT INTO api_key_message_audit (
  request_id, user_id, api_key_id, requested_model, model, effort, effort_source, account_id,
  body_sha256, body_bytes, message_count, tool_count, stream,
  last_user_message, last_user_message_truncated,
  status, terminal_code, error_message, duration_ms,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, client_user_agent
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8,
  $9, $10, $11, $12, $13,
  $14, $15,
  $16, $17, $18, $19,
  $20, $21, $22, $23, $24
)`;

export interface AuditQueryRunner {
  query(sql: string, params: unknown[]): Promise<unknown>;
}

/**
 * 单条 INSERT。调用方负责 catch(fail-soft);本函数不吞错,便于测试断言。
 */
export async function recordApiKeyMessageAudit(
  pool: Pool | AuditQueryRunner,
  row: ApiKeyMessageAuditRow,
): Promise<void> {
  const err = row.errorMessage;
  await (pool as AuditQueryRunner).query(INSERT_SQL, [
    row.requestId,
    row.userId.toString(),
    row.apiKeyId === null ? null : row.apiKeyId.toString(),
    row.requestedModel,
    row.model,
    row.effort,
    row.effortSource,
    row.accountId === null ? null : row.accountId.toString(),
    row.shape.bodySha256,
    row.shape.bodyBytes,
    row.shape.messageCount,
    row.shape.toolCount,
    row.shape.stream,
    row.lastUserMessage.text,
    row.lastUserMessage.truncated,
    row.status,
    row.terminalCode,
    err === null ? null : err.length > AUDIT_ERROR_MESSAGE_MAX_CHARS ? `${err.slice(0, AUDIT_ERROR_MESSAGE_MAX_CHARS - 1)}…` : err,
    row.durationMs,
    row.usage.inputTokens ?? null,
    row.usage.outputTokens ?? null,
    row.usage.cacheReadTokens ?? null,
    row.usage.cacheWriteTokens ?? null,
    row.clientUserAgent,
  ]);
}

// ─── admin read ─────────────────────────────────────────────────────────────

export interface ApiKeyMessageAuditEntry {
  id: string;
  created_at: string;
  request_id: string;
  api_key_id: string | null;
  requested_model: string;
  model: string;
  effort: string | null;
  effort_source: string | null;
  account_id: string | null;
  body_sha256: string;
  body_bytes: number;
  message_count: number;
  tool_count: number;
  stream: boolean;
  last_user_message: string | null;
  last_user_message_truncated: boolean;
  status: string;
  terminal_code: string | null;
  error_message: string | null;
  duration_ms: number | null;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  cache_write_tokens: string | null;
  client_user_agent: string | null;
}

export interface ListApiKeyMessageAuditOptions {
  /** 只看这把 key(十进制字符串,已由 parseApiKeyIdQuery 校验);null = 该用户全部 key。 */
  apiKeyId: string | null;
  /** 分页游标:只取 id < before(十进制字符串)。 */
  beforeId: string | null;
  /** 1..200。 */
  limit: number;
  /** 只看失败。 */
  errorsOnly: boolean;
}

export const AUDIT_LIST_MAX_LIMIT = 200;
export const AUDIT_LIST_DEFAULT_LIMIT = 50;

/**
 * 管理员读取:按 user_id 双重限定(与 usage 报表同策略,别人的 key_id 得到空集,不泄漏
 * 存在性)。倒序,游标分页。
 */
export async function listApiKeyMessageAudit(
  pool: Pool | AuditQueryRunner,
  userId: string | bigint,
  opts: ListApiKeyMessageAuditOptions,
): Promise<{ entries: ApiKeyMessageAuditEntry[]; next_before: string | null }> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit)), AUDIT_LIST_MAX_LIMIT);
  const params: unknown[] = [userId.toString()];
  const where: string[] = ["a.user_id = $1"];
  if (opts.apiKeyId !== null) {
    params.push(opts.apiKeyId);
    where.push(`a.api_key_id = $${params.length} AND EXISTS (SELECT 1 FROM user_api_keys k WHERE k.id = a.api_key_id AND k.user_id = $1)`);
  }
  if (opts.beforeId !== null) {
    params.push(opts.beforeId);
    where.push(`a.id < $${params.length}`);
  }
  if (opts.errorsOnly) where.push(`a.status = 'error'`);
  params.push(limit + 1);
  const sql = `
SELECT a.id, a.created_at, a.request_id, a.api_key_id, a.requested_model, a.model, a.effort, a.effort_source,
       a.account_id, a.body_sha256, a.body_bytes, a.message_count, a.tool_count, a.stream,
       a.last_user_message, a.last_user_message_truncated, a.status, a.terminal_code, a.error_message,
       a.duration_ms, a.input_tokens, a.output_tokens, a.cache_read_tokens, a.cache_write_tokens, a.client_user_agent
  FROM api_key_message_audit a
 WHERE ${where.join(" AND ")}
 ORDER BY a.id DESC
 LIMIT $${params.length}`;
  const result = (await (pool as AuditQueryRunner).query(sql, params)) as { rows: Record<string, unknown>[] };
  const rows = result.rows ?? [];
  const page = rows.slice(0, limit);
  const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  const entries: ApiKeyMessageAuditEntry[] = page.map((r) => ({
    id: String(r.id),
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    request_id: String(r.request_id),
    api_key_id: str(r.api_key_id),
    requested_model: String(r.requested_model),
    model: String(r.model),
    effort: str(r.effort),
    effort_source: str(r.effort_source),
    account_id: str(r.account_id),
    body_sha256: String(r.body_sha256),
    body_bytes: Number(r.body_bytes),
    message_count: Number(r.message_count),
    tool_count: Number(r.tool_count),
    stream: Boolean(r.stream),
    last_user_message: str(r.last_user_message),
    last_user_message_truncated: Boolean(r.last_user_message_truncated),
    status: String(r.status),
    terminal_code: str(r.terminal_code),
    error_message: str(r.error_message),
    duration_ms: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
    input_tokens: str(r.input_tokens),
    output_tokens: str(r.output_tokens),
    cache_read_tokens: str(r.cache_read_tokens),
    cache_write_tokens: str(r.cache_write_tokens),
    client_user_agent: str(r.client_user_agent),
  }));
  const next_before = rows.length > limit ? entries[entries.length - 1]!.id : null;
  return { entries, next_before };
}
