/**
 * 科研文献批量导入与原文 Span 定位 HTTP 路由处理器(B5 路径合约对齐)。
 *
 * 正式路由合约(与工单 OCV5-828 100% 一致):
 *   - POST /api/me/research/library/import-ids
 *       body: { identifiers?: string[], bibtex?: string, rawText?: string, projectId?: string }
 *       → handleImportResearchIds
 *   - GET  /api/me/research/library/:docId/span/:spanId
 *     (亦兼容 query 形态 `?docId=...&spanId=...`)
 *       → handleGetResearchSpan
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { requireAuth } from "../http/auth.js";
import { HttpError, readJsonBody, sendJson } from "../http/util.js";
import {
  type BatchImportDeps,
  BatchImportValidationError,
  importResearchBatch,
  makeUserImportLimiter,
  MAX_IMPORT_BODY_BYTES,
  type UserImportLimiter,
} from "./batchImport.js";
import { WorkspaceProjectError } from "./library.js";
import {
  getResearchSpanForUser,
  isValidDocId,
  isValidSpanId,
  type SpanLocatorDeps,
} from "./spanLocator.js";

export const RESEARCH_IMPORT_IDS_PATH = "/api/me/research/library/import-ids";
export const RESEARCH_SPAN_PATH_RE = /^\/api\/me\/research\/library\/([^/]+)\/span\/([^/]+)\/?$/;

export interface ResearchLibraryRouteDeps {
  jwtSecret: string | Uint8Array;
  importDeps?: BatchImportDeps;
  spanDeps?: SpanLocatorDeps;
  limiter?: UserImportLimiter;
}

const defaultImportLimiter = makeUserImportLimiter();

function estimateSubmittedCount(body: Record<string, unknown>): number {
  let n = 0;
  if (Array.isArray(body.identifiers)) n += body.identifiers.length;
  if (typeof body.bibtex === "string" && body.bibtex.trim()) {
    const matches = body.bibtex.match(/@[A-Za-z]+\s*[{(]/g);
    n += Math.max(1, matches?.length ?? 1);
  }
  if (typeof body.rawText === "string" && body.rawText.trim()) {
    const lines = body.rawText.split(/[\r\n,;]+/).filter((l) => l.trim().length > 0);
    n += Math.max(1, Math.min(lines.length, 50));
  }
  return Math.max(1, n);
}

/**
 * POST /api/me/research/library/import-ids
 * 批量解析并导入 DOI / arXiv ID / BibTeX(含精确去重、用户滑窗限流、挂入 projectId)。
 */
export async function handleImportResearchIds(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: unknown,
  deps: ResearchLibraryRouteDeps,
): Promise<void> {
  if (req.method && req.method !== "POST") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "POST required");
  }
  const user = await requireAuth(req, deps.jwtSecret);
  const raw = await readJsonBody(req, MAX_IMPORT_BODY_BYTES);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "INVALID_IMPORT_INPUT", "JSON object body required");
  }
  const body = raw as Record<string, unknown>;

  if (body.identifiers !== undefined && !Array.isArray(body.identifiers)) {
    throw new HttpError(400, "INVALID_IMPORT_INPUT", "identifiers must be a string array");
  }
  if (body.bibtex !== undefined && typeof body.bibtex !== "string") {
    throw new HttpError(400, "INVALID_IMPORT_INPUT", "bibtex must be a string");
  }
  if (body.rawText !== undefined && typeof body.rawText !== "string") {
    throw new HttpError(400, "INVALID_IMPORT_INPUT", "rawText must be a string");
  }
  let projectId: string | undefined;
  if (body.projectId !== undefined && body.projectId !== null) {
    if (typeof body.projectId !== "string" || !body.projectId.trim() || body.projectId.length > 128) {
      throw new HttpError(400, "INVALID_PROJECT", "projectId must be a non-empty string");
    }
    projectId = body.projectId.trim();
  }

  const limiter = deps.limiter ?? defaultImportLimiter;
  const limitRes = limiter.check(user.id, estimateSubmittedCount(body));
  if (!limitRes.allowed) {
    const retrySec = Math.max(1, Math.ceil((limitRes.retryAfterMs ?? 60_000) / 1000));
    throw new HttpError(429, "RATE_LIMITED", "too many research import requests; please retry later", {
      extraHeaders: { "Retry-After": retrySec },
    });
  }

  try {
    const outcome = await importResearchBatch(
      user.id,
      {
        identifiers: body.identifiers as string[] | undefined,
        bibtex: body.bibtex as string | undefined,
        rawText: body.rawText as string | undefined,
        projectId,
      },
      deps.importDeps,
    );
    if ("disabled" in outcome) {
      throw new HttpError(503, "RESEARCH_DISABLED", "research subsystem is disabled");
    }
    sendJson(res, 200, outcome);
  } catch (err) {
    if (err instanceof BatchImportValidationError) {
      throw new HttpError(400, err.code, err.message);
    }
    if (err instanceof WorkspaceProjectError) {
      throw new HttpError(400, "INVALID_PROJECT", err.message);
    }
    throw err;
  }
}

function parseSpanParams(reqUrl: string | undefined): {
  docId: string;
  spanId: string;
  contextWindow?: number;
  maxContextChars?: number;
} {
  const url = new URL(reqUrl ?? "/", "http://x");
  let docId = "";
  let spanId = "";

  const m = RESEARCH_SPAN_PATH_RE.exec(url.pathname);
  if (m) {
    try {
      docId = decodeURIComponent(m[1]!);
      spanId = decodeURIComponent(m[2]!);
    } catch {
      throw new HttpError(400, "INVALID_SPAN_PARAMS", "invalid URL encoding for docId or spanId");
    }
  } else {
    docId = url.searchParams.get("docId") ?? "";
    spanId = url.searchParams.get("spanId") ?? "";
  }

  const rawWin = url.searchParams.get("contextWindow");
  const rawMaxChars = url.searchParams.get("maxContextChars");
  const contextWindow = rawWin !== null && rawWin !== "" ? Number(rawWin) : undefined;
  const maxContextChars = rawMaxChars !== null && rawMaxChars !== "" ? Number(rawMaxChars) : undefined;

  if (contextWindow !== undefined && (!Number.isFinite(contextWindow) || contextWindow < 0)) {
    throw new HttpError(400, "INVALID_SPAN_PARAMS", "contextWindow must be a non-negative number");
  }
  if (maxContextChars !== undefined && (!Number.isFinite(maxContextChars) || maxContextChars < 50)) {
    throw new HttpError(400, "INVALID_SPAN_PARAMS", "maxContextChars must be >= 50");
  }

  return { docId, spanId, contextWindow, maxContextChars };
}

/**
 * GET /api/me/research/library/:docId/span/:spanId
 * 按 uid + docId + spanId 严格校验归属,返回页码、权威 quote 正文与前后文片段。
 */
export async function handleGetResearchSpan(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: unknown,
  deps: ResearchLibraryRouteDeps,
): Promise<void> {
  if (req.method && req.method !== "GET") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "GET required");
  }
  const user = await requireAuth(req, deps.jwtSecret);
  const { docId, spanId, contextWindow, maxContextChars } = parseSpanParams(req.url);

  if (!docId || !isValidDocId(docId)) {
    throw new HttpError(400, "INVALID_DOC_ID", "valid docId is required");
  }
  if (!spanId || !isValidSpanId(spanId)) {
    throw new HttpError(400, "INVALID_SPAN_ID", "valid spanId is required");
  }

  const located = await getResearchSpanForUser(
    user.id,
    docId,
    spanId,
    { contextWindow, maxContextChars },
    deps.spanDeps,
  );
  if (!located) {
    throw new HttpError(404, "SPAN_NOT_FOUND", "document or span not found");
  }
  sendJson(res, 200, located);
}

/** 独立分发器(供 Wave 3B 主 router 挂载)。 */
export async function dispatchResearchLibraryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ResearchLibraryRouteDeps,
): Promise<void> {
  const pathname = new URL(req.url ?? "/", "http://x").pathname;
  if (pathname === RESEARCH_IMPORT_IDS_PATH) {
    await handleImportResearchIds(req, res, undefined, deps);
    return;
  }
  if (RESEARCH_SPAN_PATH_RE.test(pathname)) {
    await handleGetResearchSpan(req, res, undefined, deps);
    return;
  }
  throw new HttpError(404, "NOT_FOUND", "research library route not found");
}
