/**
 * Office 零轮次缓存预览独立 HTTP 路由处理器(.pptx / .docx / .xlsx)(B2 + B5 闭环)。
 *
 * 正式路由合约(对齐工单 OCV5-828):
 *   - GET / POST `/api/file/office-preview`
 *       → 经 `requireAuth` 校验 uid，按 uid 隔离私有缓存子目录与页面句柄注册表；
 *       → 返回结构化预览结果，页图不暴露服务器原始路径作为凭证，而是下发绑定 uid 的
 *         不透明句柄 `previewHandle` 与 `pageUrl: /api/file/office-preview/page?handle=...&page=...`。
 *   - GET `/api/file/office-preview/page?handle=<handle>&page=<index>`
 *     或 GET `/api/file/office-preview/page/:handle/:page`
 *       → 强校验 `requireAuth` 的 `user.id === entry.userId`，跨租户请求统一 403/404，
 *         绝不接受客户端传入的绝对文件路径作为访问凭证！
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { requireAuth } from "./auth.js";
import { HttpError, readJsonBody, sendJson, setSecurityHeaders } from "./util.js";

export const OFFICE_PREVIEW_PATH = "/api/file/office-preview";
export const OFFICE_PREVIEW_PAGE_PATH = "/api/file/office-preview/page";
export const OFFICE_PREVIEW_PAGE_PATH_RE = /^\/api\/file\/office-preview\/page\/([A-Za-z0-9_-]{16,96})\/(\d+)\/?$/;
export const OFFICE_PREVIEW_MAX_XLSX_ROWS = 500;
export const MAX_PREVIEW_PAGE_IMAGE_BYTES = 16 * 1024 * 1024; // 16 MiB
const SUPPORTED_OFFICE_EXTS = new Set([".pptx", ".docx", ".xlsx"]);
const DEFAULT_HANDLE_TTL_MS = 30 * 60_000;
const DEFAULT_HANDLE_MAX_ENTRIES = 2_000;

export interface OfficePreviewQaIssueDto {
  severity: "error" | "warning";
  code: string;
  message: string;
  page?: number;
  sheet?: string;
  cell?: string;
}

export interface OfficePreviewPageDto {
  index: number;
  imgPath: string;
  notes?: string;
  /** 绑定认证 uid 的安全页图访问 URL(不含裸磁盘路径凭证)。 */
  pageUrl?: string;
}

export interface OfficePreviewXlsxSheetDto {
  name: string;
  totalRows: number;
  totalCols: number;
  truncated: boolean;
  rows: Array<Array<{ cell: string; value: string | number | boolean | null; formula?: string; error?: string }>>;
  formulas: Array<{ cell: string; formula: string; value: string | number | boolean | null }>;
  errorCells: Array<{ sheet: string; cell: string; error: string; formula?: string }>;
}

export type OfficePreviewPayload =
  | {
      kind: "pptx" | "docx";
      filePath: string;
      sha256: string;
      mtimeMs: number;
      cacheKey: string;
      cached: boolean;
      previewHandle?: string;
      pages: OfficePreviewPageDto[];
      qaIssues: OfficePreviewQaIssueDto[];
    }
  | {
      kind: "xlsx";
      filePath: string;
      sha256: string;
      mtimeMs: number;
      cacheKey: string;
      cached: boolean;
      maxRowsPerSheet: number;
      sheets: OfficePreviewXlsxSheetDto[];
      errorCells: Array<{ sheet: string; cell: string; error: string; formula?: string }>;
      qaIssues: OfficePreviewQaIssueDto[];
    };

export interface OfficePreviewHandleEntry {
  handle: string;
  userId: string;
  cacheRoot: string;
  pagesByIndex: Map<number, string>;
  expiresAt: number;
}

/**
 * 每租户页图句柄注册表(B2):句柄严格绑定签发时的认证 `userId` 与该用户私有 `cacheRoot`。
 */
export class OfficePreviewHandleRegistry {
  private readonly entries = new Map<string, OfficePreviewHandleEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts?: { ttlMs?: number; maxEntries?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_HANDLE_TTL_MS;
    this.maxEntries = opts?.maxEntries ?? DEFAULT_HANDLE_MAX_ENTRIES;
  }

  register(input: {
    userId: string;
    cacheRoot: string;
    pages: ReadonlyArray<{ index: number; imgPath: string }>;
    now?: number;
  }): string {
    const now = input.now ?? Date.now();
    this.prune(now);
    const handle = randomBytes(18).toString("base64url");
    const pagesByIndex = new Map<number, string>();
    for (const p of input.pages) {
      pagesByIndex.set(p.index, p.imgPath);
    }
    this.entries.set(handle, {
      handle,
      userId: input.userId,
      cacheRoot: input.cacheRoot,
      pagesByIndex,
      expiresAt: now + this.ttlMs,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
      else break;
    }
    return handle;
  }

  /**
   * 强校验归属 uid:不存在或已过期返 `not_found`,归属其他用户返 `forbidden`。
   */
  resolveForUser(
    userId: string,
    handle: string,
    pageIndex: number,
    now = Date.now(),
  ):
    | { ok: true; imgPath: string; cacheRoot: string }
    | { ok: false; reason: "not_found" | "forbidden" } {
    const entry = this.entries.get(handle);
    if (!entry || entry.expiresAt <= now) {
      if (entry) this.entries.delete(handle);
      return { ok: false, reason: "not_found" };
    }
    if (entry.userId !== userId) {
      return { ok: false, reason: "forbidden" };
    }
    const imgPath = entry.pagesByIndex.get(pageIndex);
    if (!imgPath) return { ok: false, reason: "not_found" };
    return { ok: true, imgPath, cacheRoot: entry.cacheRoot };
  }

  private prune(now: number): void {
    for (const [k, v] of this.entries) {
      if (v.expiresAt <= now) this.entries.delete(k);
    }
  }
}

const defaultHandleRegistry = new OfficePreviewHandleRegistry();

export interface OfficePreviewRouteDeps {
  jwtSecret: string | Uint8Array;
  /** 基础缓存目录(运行时自动按认证 uid 隔离到 `<cacheDir>/u-<uid>`)。 */
  cacheDir?: string;
  /** 可选自定义句柄注册表(测试隔离用)。 */
  handleRegistry?: OfficePreviewHandleRegistry;
  /**
   * Office 预览执行器(注入容器代理或本地 `previewOfficeFile`)。
   * 接收按认证 `userId` 隔离好的 `userCacheDir`。
   */
  previewImpl?: (
    userId: string,
    filePath: string,
    opts: { maxRowsPerSheet?: number; userCacheDir?: string },
  ) => Promise<OfficePreviewPayload>;
  /** 可选远端容器页图读取回调(当渲染页图位于用户容器私有文件系统而非 master 本地盘时)。 */
  readPageImageImpl?: (
    userId: string,
    imgPath: string,
  ) => Promise<{ bytes: Buffer; contentType: "image/png" | "image/jpeg" } | null>;
}

/** 构造按 uid 严格隔离的私有缓存子目录(绝不共用无 uid 隔离的缓存根)。 */
export function resolveUserOfficeCacheDir(baseCacheDir: string, userId: string): string {
  const safeUid = userId.replace(/[^A-Za-z0-9_-]/g, "");
  if (!safeUid) throw new HttpError(401, "UNAUTHORIZED", "invalid user identity");
  const baseSt = lstatSync(baseCacheDir);
  if (baseSt.isSymbolicLink() || !baseSt.isDirectory()) {
    throw new HttpError(500, "OFFICE_PREVIEW_UNAVAILABLE", "invalid preview cache root");
  }
  const realBase = realpathSync(baseCacheDir);
  const userDir = path.join(realBase, `u-${safeUid}`);
  mkdirSync(userDir, { recursive: true, mode: 0o700 });
  const uSt = lstatSync(userDir);
  if (uSt.isSymbolicLink() || !uSt.isDirectory()) {
    throw new HttpError(403, "SYMLINK_REJECTED", "user cache directory symlink rejected");
  }
  return realpathSync(userDir);
}

interface OfficeErrorLike {
  code?: unknown;
  httpStatus?: unknown;
  message?: unknown;
}

function mapOfficeError(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err && typeof err === "object") {
    const e = err as OfficeErrorLike;
    if (
      typeof e.httpStatus === "number" &&
      e.httpStatus >= 400 &&
      e.httpStatus < 600 &&
      typeof e.code === "string" &&
      e.code.length > 0
    ) {
      throw new HttpError(
        e.httpStatus,
        e.code,
        typeof e.message === "string" ? e.message : "office preview failed",
      );
    }
  }
  throw err;
}

function validateRequestedOfficePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0") || !path.isAbsolute(trimmed)) {
    throw new HttpError(400, "INVALID_PATH", "valid absolute file path is required");
  }
  const ext = path.extname(trimmed).toLowerCase();
  if (!SUPPORTED_OFFICE_EXTS.has(ext)) {
    throw new HttpError(415, "UNSUPPORTED_TYPE", "only .pptx, .docx, and .xlsx files are supported");
  }
  return trimmed;
}

async function extractPreviewParams(
  req: IncomingMessage,
): Promise<{ filePath: string; maxRowsPerSheet?: number }> {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET") {
    const rawPath = url.searchParams.get("path") ?? "";
    const filePath = validateRequestedOfficePath(rawPath);
    const rawRows = url.searchParams.get("maxRows") ?? url.searchParams.get("maxRowsPerSheet");
    const maxRowsPerSheet = rawRows !== null && rawRows !== "" ? Number(rawRows) : undefined;
    if (
      maxRowsPerSheet !== undefined &&
      (!Number.isFinite(maxRowsPerSheet) ||
        maxRowsPerSheet < 1 ||
        maxRowsPerSheet > OFFICE_PREVIEW_MAX_XLSX_ROWS)
    ) {
      throw new HttpError(
        400,
        "INVALID_PARAM",
        `maxRowsPerSheet must be between 1 and ${OFFICE_PREVIEW_MAX_XLSX_ROWS}`,
      );
    }
    return {
      filePath,
      maxRowsPerSheet: maxRowsPerSheet !== undefined ? Math.floor(maxRowsPerSheet) : undefined,
    };
  }

  if (req.method === "POST") {
    const raw = await readJsonBody(req);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new HttpError(400, "INVALID_BODY", "JSON object body is required");
    }
    const body = raw as Record<string, unknown>;
    if (typeof body.path !== "string") {
      throw new HttpError(400, "INVALID_PATH", "path is required");
    }
    const filePath = validateRequestedOfficePath(body.path);
    const rawRows = body.maxRowsPerSheet ?? body.maxRows;
    let maxRowsPerSheet: number | undefined;
    if (rawRows !== undefined && rawRows !== null) {
      if (
        typeof rawRows !== "number" ||
        !Number.isFinite(rawRows) ||
        rawRows < 1 ||
        rawRows > OFFICE_PREVIEW_MAX_XLSX_ROWS
      ) {
        throw new HttpError(
          400,
          "INVALID_PARAM",
          `maxRowsPerSheet must be between 1 and ${OFFICE_PREVIEW_MAX_XLSX_ROWS}`,
        );
      }
      maxRowsPerSheet = Math.floor(rawRows);
    }
    return { filePath, maxRowsPerSheet };
  }

  throw new HttpError(405, "METHOD_NOT_ALLOWED", "GET or POST required");
}

/**
 * GET / POST `/api/file/office-preview`
 * 返回缓存型只读 Office 预览结果,并为页图签发绑定认证 uid 的句柄与安全 `pageUrl`。
 */
export async function handleOfficePreview(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: unknown,
  deps: OfficePreviewRouteDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret);
  if (!deps.previewImpl) {
    throw new HttpError(503, "OFFICE_PREVIEW_UNAVAILABLE", "office preview service unavailable");
  }
  const { filePath, maxRowsPerSheet } = await extractPreviewParams(req);
  const userCacheDir = deps.cacheDir ? resolveUserOfficeCacheDir(deps.cacheDir, user.id) : undefined;
  const registry = deps.handleRegistry ?? defaultHandleRegistry;

  try {
    const preview = await deps.previewImpl(user.id, filePath, { maxRowsPerSheet, userCacheDir });
    if (preview.kind === "pptx" || preview.kind === "docx") {
      const handle = registry.register({
        userId: user.id,
        cacheRoot: userCacheDir ?? "",
        pages: preview.pages,
      });
      const decorated: OfficePreviewPayload = {
        ...preview,
        previewHandle: handle,
        pages: preview.pages.map((p) => ({
          ...p,
          pageUrl: `${OFFICE_PREVIEW_PAGE_PATH}?handle=${encodeURIComponent(handle)}&page=${p.index}`,
        })),
      };
      sendJson(res, 200, { preview: decorated });
      return;
    }
    sendJson(res, 200, { preview });
  } catch (err) {
    mapOfficeError(err);
  }
}

function parsePageRequest(reqUrl: string | undefined): { handle: string; pageIndex: number } {
  const url = new URL(reqUrl ?? "/", "http://x");
  // B2 安全硬约束:绝不接受客户端传入的绝对磁盘路径作为凭证
  if (url.searchParams.has("path")) {
    throw new HttpError(400, "RAW_PATH_FORBIDDEN", "raw filesystem path is not accepted; use preview handle");
  }
  const pathMatch = OFFICE_PREVIEW_PAGE_PATH_RE.exec(url.pathname);
  const handle = pathMatch ? pathMatch[1]! : (url.searchParams.get("handle") ?? "").trim();
  const rawPage = pathMatch ? pathMatch[2]! : (url.searchParams.get("page") ?? "").trim();
  if (!handle || !/^[A-Za-z0-9_-]{16,96}$/.test(handle)) {
    throw new HttpError(400, "INVALID_HANDLE", "valid preview handle is required");
  }
  const pageIndex = Number(rawPage);
  if (!Number.isInteger(pageIndex) || pageIndex < 1 || pageIndex > 2000) {
    throw new HttpError(400, "INVALID_PAGE", "valid positive page index is required");
  }
  return { handle, pageIndex };
}

function readLocalCachedImageSafe(
  imgPath: string,
  userCacheRoot: string,
): { bytes: Buffer; contentType: "image/png" | "image/jpeg" } {
  if (!userCacheRoot) {
    throw new HttpError(503, "OFFICE_PREVIEW_UNAVAILABLE", "office preview cacheDir not configured");
  }
  const ext = path.extname(imgPath).toLowerCase();
  const contentType =
    ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : null;
  if (!contentType) {
    throw new HttpError(415, "UNSUPPORTED_TYPE", "only PNG/JPEG preview images are allowed");
  }

  let realUserRoot: string;
  try {
    realUserRoot = realpathSync(userCacheRoot);
  } catch {
    throw new HttpError(404, "NOT_FOUND", "preview image not found");
  }

  let st;
  try {
    st = lstatSync(imgPath);
  } catch {
    throw new HttpError(404, "NOT_FOUND", "preview image not found");
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new HttpError(403, "SYMLINK_REJECTED", "symbolic links are not allowed");
  }

  let realImg: string;
  try {
    realImg = realpathSync(imgPath);
  } catch {
    throw new HttpError(404, "NOT_FOUND", "preview image not found");
  }
  const cachePrefix = realUserRoot.endsWith(path.sep) ? realUserRoot : `${realUserRoot}${path.sep}`;
  if (!realImg.startsWith(cachePrefix)) {
    throw new HttpError(403, "PATH_ESCAPE", "image path escapes user preview cache directory");
  }

  let fd: number | null = null;
  try {
    const flags =
      fsConstants.O_RDONLY |
      (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
    fd = openSync(realImg, flags);
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino) {
      throw new HttpError(403, "SYMLINK_REJECTED", "preview image changed during read");
    }
    if (fst.size > MAX_PREVIEW_PAGE_IMAGE_BYTES) {
      throw new HttpError(413, "IMAGE_TOO_LARGE", "preview page image exceeds size limit");
    }
    return { bytes: readFileSync(fd), contentType };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(404, "NOT_FOUND", "preview image unreadable");
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * GET `/api/file/office-preview/page?handle=<handle>&page=<index>`
 * 或 GET `/api/file/office-preview/page/:handle/:page`
 * 按认证 uid 强校验页图句柄归属,仅允许所有者读取其私有缓存页图(B2)。
 */
export async function handleOfficePreviewPageImage(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: unknown,
  deps: OfficePreviewRouteDeps,
): Promise<void> {
  if (req.method && req.method !== "GET") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "GET required");
  }
  const user = await requireAuth(req, deps.jwtSecret);
  const { handle, pageIndex } = parsePageRequest(req.url);
  const registry = deps.handleRegistry ?? defaultHandleRegistry;
  const resolved = registry.resolveForUser(user.id, handle, pageIndex);
  if (!resolved.ok) {
    if (resolved.reason === "forbidden") {
      throw new HttpError(403, "FORBIDDEN", "preview handle belongs to another user");
    }
    throw new HttpError(404, "NOT_FOUND", "preview page not found");
  }

  let image: { bytes: Buffer; contentType: "image/png" | "image/jpeg" } | null;
  if (deps.readPageImageImpl) {
    image = await deps.readPageImageImpl(user.id, resolved.imgPath);
    if (!image) throw new HttpError(404, "NOT_FOUND", "preview image not found");
  } else {
    image = readLocalCachedImageSafe(resolved.imgPath, resolved.cacheRoot);
  }

  setSecurityHeaders(res);
  res.statusCode = 200;
  res.setHeader("Content-Type", image.contentType);
  res.setHeader("Content-Length", image.bytes.length);
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.end(image.bytes);
}

/** 独立路由器入口(匹配 `/api/file/office-preview` 及 `/api/file/office-preview/page*`)。 */
export async function dispatchOfficePreviewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: OfficePreviewRouteDeps,
): Promise<void> {
  const pathname = new URL(req.url ?? "/", "http://x").pathname;
  if (pathname === OFFICE_PREVIEW_PATH || pathname === `${OFFICE_PREVIEW_PATH}/`) {
    await handleOfficePreview(req, res, undefined, deps);
    return;
  }
  if (pathname === OFFICE_PREVIEW_PAGE_PATH || OFFICE_PREVIEW_PAGE_PATH_RE.test(pathname)) {
    await handleOfficePreviewPageImage(req, res, undefined, deps);
    return;
  }
  throw new HttpError(404, "NOT_FOUND", "office preview route not found");
}
