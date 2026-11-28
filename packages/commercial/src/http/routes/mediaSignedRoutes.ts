import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import {
  verifyCommercialJwtSyncDetailed,
  type CommercialJwtClaims,
} from "../../auth/jwtSync.js";
import { getHostById as computePoolGetHostById } from "../../compute-pool/queries.js";
import { dialTunnelSocket as defaultTunnelDial } from "../../compute-pool/nodeAgentClient.js";
import {
  canAccessInboxAsset,
  inboxAssetIdFromPath,
  readInboxAssetForViewer,
} from "../../inbox/assets.js";
import { getBearerToken, getSessionCookieToken } from "../authHelpers.js";
import type { CapturedResponse } from "../bufferingResponseSink.js";
import { containerFileProxy } from "../containerFileProxy.js";
import {
  buildOpaqueInboxAssetUrl,
  buildOpaqueMediaFileUrl,
  buildOpaqueSignedUrl,
  DEFAULT_SIGN_TTL_MS,
  extractApiMediaFilename,
  isContainerPathAllowed,
  isMediaFilenameAllowed,
  normalizeSignBatchInput,
  signTtlMsForPath,
  verifySignedUrl,
} from "../mediaSign.js";
import {
  parseThumbnailWidth,
  renderThumbnail,
  resizeToWebpThumbnail,
  THUMBNAIL_MAX_SOURCE_BYTES,
  thumbnailCacheKey,
} from "../mediaThumbnail.js";
import { requireActiveAccountVerifyDb } from "../requireUser.js";
import { defaultTunnelFetchHealthz } from "../tunnelHealthzProbe.js";
import { HttpError, readJsonBody, sendJson } from "../util.js";
import type { CommercialHttpDeps, RequestContext } from "./shared.js";

const MEDIA_SIGN_LOG_USER_RE = /^[1-9]\d{0,18}$/;

export function extractRawQueryParam(requestUrl: string, name: string): string | null {
  const qi = requestUrl.indexOf("?");
  if (qi < 0) return null;
  const hi = requestUrl.indexOf("#", qi);
  const rawQuery = hi < 0 ? requestUrl.slice(qi + 1) : requestUrl.slice(qi + 1, hi);
  if (rawQuery.length === 0) return null;
  const prefix = `${name}=`;
  let found: string | null = null;
  for (const kv of rawQuery.split("&")) {
    if (kv.startsWith(prefix)) {
      if (found !== null) return null;
      found = kv.slice(prefix.length);
    } else if (kv === name) {
      if (found !== null) return null;
      found = "";
    }
  }
  return found === "" ? null : found;
}

function sanitizeClaimScalar(v: unknown): string | number | boolean | null {
  if (v === null) return null;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") {
    return v as string | number | boolean;
  }
  return "[non-scalar]";
}

function sanitizeClaimNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function firstHeader(v: string | string[] | undefined): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return null;
}

function sanitizeDiagId(raw: string | null): string | null {
  if (!raw || raw.length > 64 || !/^[0-9a-zA-Z-]+$/.test(raw)) return null;
  return raw;
}

function sanitizeSecChUaMobile(raw: string | null): "?0" | "?1" | null {
  return raw === "?0" || raw === "?1" ? raw : null;
}

function logMediaSignAuthFail(
  ctx: RequestContext,
  req: IncomingMessage,
  result: Extract<ReturnType<typeof verifyCommercialJwtSyncDetailed>, { ok: false }>,
  jwtSecret: string | Uint8Array,
  source: "bearer" | "cookie",
): void {
  const parsed = result.parsedClaims;
  const tokenExp = sanitizeClaimNumber(parsed?.exp);
  const tokenIat = sanitizeClaimNumber(parsed?.iat);
  const now = Math.floor(Date.now() / 1000);
  const secretFp = createHash("sha256")
    .update(jwtSecret as Buffer | string)
    .digest("hex")
    .slice(0, 8);
  const retryHeader = req.headers["x-oc-debug-retry"];
  const isRetry = (Array.isArray(retryHeader) ? retryHeader[0] : retryHeader) === "1";
  const acceptLangRaw = firstHeader(req.headers["accept-language"]);
  ctx.log.warn("media_sign_auth_fail", {
    reason: result.reason,
    source,
    token_sub: sanitizeClaimScalar(parsed?.sub),
    token_role: sanitizeClaimScalar(parsed?.role),
    token_iat: tokenIat,
    token_exp: tokenExp,
    server_now: now,
    clock_skew_sec: tokenExp !== null ? tokenExp - now : null,
    is_client_retry: isRetry,
    secret_fp: secretFp,
    instance_pid: process.pid,
    diag_id: sanitizeDiagId(firstHeader(req.headers["x-oc-diag-id"])),
    user_agent: ctx.userAgent,
    accept_language: acceptLangRaw === null ? null : acceptLangRaw.slice(0, 128),
    sec_ch_ua_mobile: sanitizeSecChUaMobile(firstHeader(req.headers["sec-ch-ua-mobile"])),
  });
}

function logMediaSignSubjectMismatch(
  ctx: RequestContext,
  req: IncomingMessage,
  cookieSub: string,
  bearerSub: string,
): void {
  ctx.log.warn("media_sign_subject_mismatch", {
    chosen: "cookie",
    cookie_sub: cookieSub,
    bearer_sub: bearerSub,
    diag_id: sanitizeDiagId(firstHeader(req.headers["x-oc-diag-id"])),
    user_agent: ctx.userAgent,
    instance_pid: process.pid,
  });
}

function resolveMediaSignClaims(
  req: IncomingMessage,
  ctx: RequestContext,
  jwtSecret: string | Uint8Array,
): CommercialJwtClaims {
  const cookieToken = getSessionCookieToken(req);
  const bearerToken = getBearerToken(req);
  let claims: CommercialJwtClaims | null = null;
  let chosenSource: "cookie" | "bearer" | null = null;

  if (cookieToken) {
    const r = verifyCommercialJwtSyncDetailed(cookieToken, jwtSecret);
    if (r.ok) {
      claims = r.claims;
      chosenSource = "cookie";
    } else {
      logMediaSignAuthFail(ctx, req, r, jwtSecret, "cookie");
    }
  }
  if (!chosenSource && bearerToken && bearerToken !== cookieToken) {
    const r = verifyCommercialJwtSyncDetailed(bearerToken, jwtSecret);
    if (r.ok) {
      claims = r.claims;
      chosenSource = "bearer";
    } else {
      logMediaSignAuthFail(ctx, req, r, jwtSecret, "bearer");
    }
  }
  if (!claims || !chosenSource) {
    throw new HttpError(401, "UNAUTHORIZED", "invalid or expired token");
  }
  if (chosenSource === "cookie" && bearerToken && bearerToken !== cookieToken) {
    const br = verifyCommercialJwtSyncDetailed(bearerToken, jwtSecret);
    if (br.ok && br.claims.sub !== claims.sub) {
      logMediaSignSubjectMismatch(ctx, req, claims.sub, br.claims.sub);
    }
  }
  return claims;
}

async function signMediaPathItem(
  mediaSignKey: Buffer,
  verified: { id: string; role: "user" | "admin" },
  userId: string,
  p: string,
): Promise<{ url: string; expMs: number } | null> {
  const inboxAssetId = inboxAssetIdFromPath(p);
  if (inboxAssetId) {
    if (await canAccessInboxAsset(verified.id, verified.role, inboxAssetId)) {
      return buildOpaqueInboxAssetUrl(mediaSignKey, inboxAssetId, userId, DEFAULT_SIGN_TTL_MS);
    }
    return null;
  }
  const mediaFile = extractApiMediaFilename(p);
  if (mediaFile) {
    return buildOpaqueMediaFileUrl(mediaSignKey, mediaFile, userId, signTtlMsForPath(mediaFile));
  }
  let resolved: string;
  try {
    resolved = resolvePath(p);
  } catch {
    return null;
  }
  if (!isContainerPathAllowed(resolved)) return null;
  return buildOpaqueSignedUrl(mediaSignKey, p, userId, signTtlMsForPath(resolved));
}

export async function handleMediaSign(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  if (!deps.mediaSignKey || !deps.v3Supervisor) {
    throw new HttpError(503, "SIGN_DISABLED", "media signed URL not configured");
  }
  const claims = resolveMediaSignClaims(req, ctx, deps.jwtSecret);
  const verified = await requireActiveAccountVerifyDb(
    claims.sub,
    ["user", "admin"],
    deps.v3Supervisor.pool,
  );
  if (!verified) {
    throw new HttpError(403, "FORBIDDEN", "account not active");
  }
  const body = (await readJsonBody(req)) as { paths?: unknown } | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION", "body must be a JSON object");
  }
  const norm = normalizeSignBatchInput(body.paths);
  if (!norm.ok) {
    throw new HttpError(400, "VALIDATION", norm.message);
  }

  const userId = `c:${claims.sub}`;
  const fallbackExpMs = Date.now() + DEFAULT_SIGN_TTL_MS;
  let minExpMs = Number.POSITIVE_INFINITY;
  const urls: Record<string, string> = {};
  for (const p of norm.paths) {
    const signed = await signMediaPathItem(deps.mediaSignKey, verified, userId, p);
    if (signed) {
      urls[p] = signed.url;
      minExpMs = Math.min(minExpMs, signed.expMs);
    }
  }
  sendJson(res, 200, { urls, expMs: Number.isFinite(minExpMs) ? minExpMs : fallbackExpMs });
}

function sendMediaBytes(
  res: ServerResponse,
  body: Buffer,
  contentType: string,
  cacheControl?: string,
): void {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Content-Disposition": "inline",
    Vary: "Authorization, Cookie",
    "Cache-Control": cacheControl ?? "no-store",
  });
  res.end(body);
}

function computePrivateCacheControl(expMs: number): string | undefined {
  const remainSec = Math.max(0, Math.floor((expMs - Date.now()) / 1000));
  const ageSec = Math.min(240, remainSec);
  return ageSec > 0 ? `private, max-age=${ageSec}` : undefined;
}

async function serveInboxSignedMedia(
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
  args: {
    verified: { id: string; role: "user" | "admin" };
    userId: string;
    decodedPath: string;
    expMs: number;
    rawWidth: string | null;
  },
): Promise<void> {
  const parsedWidth = parseThumbnailWidth(args.rawWidth);
  if (parsedWidth.kind === "invalid") {
    throw new HttpError(400, "BAD_REQUEST", "signed URL: bad-w");
  }
  const asset = await readInboxAssetForViewer(args.verified.id, args.verified.role, args.decodedPath);
  if (!asset) {
    throw new HttpError(403, "FORBIDDEN", "inbox asset is no longer visible");
  }
  const cacheControl = computePrivateCacheControl(args.expMs);
  if (parsedWidth.kind === "width" && deps.thumbnailCache) {
    const cacheKey = thumbnailCacheKey({
      userId: args.userId,
      mediaKind: "inbox",
      decodedPath: args.decodedPath,
      width: parsedWidth.width,
    });
    const cached = await deps.thumbnailCache.get(cacheKey);
    if (cached) {
      sendMediaBytes(res, cached.buffer, "image/webp", cacheControl);
      return;
    }
    try {
      const thumbnail = await resizeToWebpThumbnail(asset.data, parsedWidth.width);
      await deps.thumbnailCache.put(cacheKey, thumbnail);
      sendMediaBytes(res, thumbnail, "image/webp", cacheControl);
      return;
    } catch (err) {
      ctx.log.warn("inbox_thumbnail_resize_failed", {
        assetId: args.decodedPath,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  sendMediaBytes(res, asset.data, asset.mimeType, cacheControl);
}

function resolveContainerForwardPath(mediaKind: "media" | "file", decodedPath: string): string {
  if (mediaKind === "media") {
    if (!isMediaFilenameAllowed(decodedPath)) {
      throw new HttpError(403, "FORBIDDEN", "signed URL media filename not authorized");
    }
    return `/api/media/${encodeURIComponent(decodedPath)}`;
  }
  let resolved: string;
  try {
    resolved = resolvePath(decodedPath);
  } catch {
    throw new HttpError(400, "BAD_REQUEST", "signed URL: bad-path");
  }
  if (!isContainerPathAllowed(resolved)) {
    throw new HttpError(403, "FORBIDDEN", "signed URL path not authorized");
  }
  return `/api/file?path=${encodeURIComponent(decodedPath)}`;
}

export interface MediaSignedHelpers {
  extractContainerUnready: (err: unknown) => { retryAfterSec: number; reason: string } | null;
  captureProxyToSink: (
    runProxy: (resLike: ServerResponse) => Promise<void>,
    maxBytes: number,
  ) => Promise<CapturedResponse>;
}

async function ensureContainerReadyForMedia(
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
  sub: string,
  extractContainerUnready: MediaSignedHelpers["extractContainerUnready"],
): Promise<boolean> {
  if (!deps.ensureContainerReady) return true;
  try {
    await deps.ensureContainerReady(BigInt(sub));
    return true;
  } catch (err) {
    const unready = extractContainerUnready(err);
    if (unready) {
      sendJson(
        res,
        503,
        {
          error: {
            code: "CONTAINER_UNREADY",
            message: `container not ready: ${unready.reason}`,
            retry_after_sec: unready.retryAfterSec,
            request_id: ctx.requestId,
          },
        },
        { "Retry-After": unready.retryAfterSec },
      );
      return false;
    }
    ctx.log.warn("handle_media_signed_ensure_container_failed", {
      uid: sub,
      err: (err as Error)?.message ?? String(err),
    });
    throw new HttpError(503, "CONTAINER_NOT_RUNNING", "container ensure failed");
  }
}

function makeContainerMediaProxyRunner(
  req: IncomingMessage,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
  forwardPath: string,
  sub: string,
) {
  const v3Supervisor = deps.v3Supervisor!;
  const bridgeSecret = deps.bridgeSecret!;
  return async (
    resLike: ServerResponse,
    cacheOverride?: (upstreamStatus: number) => string | null,
  ): Promise<void> => {
    const originalUrl = req.url;
    req.url = forwardPath;
    try {
      const selfHostIdForProxy = v3Supervisor.selfHostId;
      await containerFileProxy(
        req,
        resLike,
        ctx,
        {
          v3: v3Supervisor,
          bridgeSecret,
          selfHostId: selfHostIdForProxy,
          getHostById: computePoolGetHostById,
          tunnelDial: defaultTunnelDial,
          capabilityProbe: {
            selfHostId: selfHostIdForProxy,
            tunnelFetchHealthz: (hostId, cid, timeoutMs) =>
              defaultTunnelFetchHealthz(hostId, cid, timeoutMs, {
                getHostById: computePoolGetHostById,
              }),
          },
          responseCacheControlOverride: cacheOverride,
        },
        BigInt(sub),
      );
    } finally {
      req.url = originalUrl;
    }
  };
}

async function renderAndSendThumbnailMiss(
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
  args: {
    userId: string;
    sub: string;
    mediaKind: "media" | "file";
    decodedPath: string;
    thumbWidth: number;
    expMs: number;
    runProxy: (resLike: ServerResponse, cacheOverride?: (status: number) => string | null) => Promise<void>;
    cacheControlOverride: (status: number) => string | null;
    captureProxyToSink: MediaSignedHelpers["captureProxyToSink"];
  },
): Promise<void> {
  const cap = await args.captureProxyToSink(
    (sinkRes) => args.runProxy(sinkRes),
    THUMBNAIL_MAX_SOURCE_BYTES,
  );
  const rendered = await renderThumbnail(cap, {
    cache: deps.thumbnailCache!,
    cacheKey: thumbnailCacheKey({
      userId: args.userId,
      mediaKind: args.mediaKind,
      decodedPath: args.decodedPath,
      width: args.thumbWidth,
    }),
    width: args.thumbWidth,
  });
  switch (rendered.kind) {
    case "bytes":
      sendMediaBytes(res, rendered.body, rendered.contentType, computePrivateCacheControl(args.expMs));
      return;
    case "passthrough-error":
      res.writeHead(rendered.statusCode, rendered.headers);
      res.end(rendered.body);
      return;
    case "stream-original":
      await args.runProxy(res, args.cacheControlOverride);
      return;
    case "upstream-error":
      ctx.log.warn("handle_media_signed_thumbnail_upstream_error", { uid: args.sub });
      throw new HttpError(502, "BAD_GATEWAY", "thumbnail upstream error");
  }
}

async function verifyAndAuthorizeSignedMedia(
  req: IncomingMessage,
  url: URL,
  deps: CommercialHttpDeps,
) {
  const result = verifySignedUrl(deps.mediaSignKey!, {
    t: url.searchParams.get("t"),
    pRaw: extractRawQueryParam(req.url ?? "", "p"),
    u: url.searchParams.get("u"),
    e: url.searchParams.get("e"),
    s: url.searchParams.get("s"),
  });
  if (result.kind === "bad-request") throw new HttpError(400, "BAD_REQUEST", `signed URL: ${result.reason}`);
  if (result.kind === "forbidden") throw new HttpError(403, "FORBIDDEN", "signed URL signature invalid");
  if (result.kind === "gone") throw new HttpError(410, "GONE", "signed URL expired");

  const sub = result.userId.slice(2);
  if (!MEDIA_SIGN_LOG_USER_RE.test(sub)) {
    throw new HttpError(400, "BAD_REQUEST", "signed URL: bad-user-id");
  }
  const verified = await requireActiveAccountVerifyDb(sub, ["user", "admin"], deps.v3Supervisor!.pool);
  if (!verified) {
    throw new HttpError(403, "FORBIDDEN", "account not active");
  }
  return { ...result, sub, verified };
}

export async function serveMediaSigned(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
  helpers: MediaSignedHelpers,
): Promise<void> {
  if (!deps.mediaSignKey || !deps.v3Supervisor || !deps.bridgeSecret) {
    throw new HttpError(503, "SIGN_DISABLED", "media signed URL not configured");
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x.invalid"}`);
  const { userId, expMs, decodedPath, mediaKind, sub, verified } =
    await verifyAndAuthorizeSignedMedia(req, url, deps);

  if (mediaKind === "inbox") {
    await serveInboxSignedMedia(res, ctx, deps, {
      verified,
      userId,
      decodedPath,
      expMs,
      rawWidth: url.searchParams.get("w"),
    });
    return;
  }

  const forwardPath = resolveContainerForwardPath(mediaKind, decodedPath);
  const parsedWidth = parseThumbnailWidth(url.searchParams.get("w"));
  if (parsedWidth.kind === "invalid") {
    throw new HttpError(400, "BAD_REQUEST", "signed URL: bad-w");
  }
  const thumbWidth = parsedWidth.kind === "width" && deps.thumbnailCache ? parsedWidth.width : null;

  if (thumbWidth != null && deps.thumbnailCache) {
    const key = thumbnailCacheKey({ userId, mediaKind, decodedPath, width: thumbWidth });
    const cached = await deps.thumbnailCache.get(key);
    if (cached) {
      sendMediaBytes(res, cached.buffer, "image/webp", computePrivateCacheControl(expMs));
      return;
    }
  }

  const ready = await ensureContainerReadyForMedia(res, ctx, deps, sub, helpers.extractContainerUnready);
  if (!ready) return;

  const runProxy = makeContainerMediaProxyRunner(req, ctx, deps, forwardPath, sub);
  const cacheControlOverride = (upstreamStatus: number): string | null =>
    upstreamStatus === 200 || upstreamStatus === 206 ? (computePrivateCacheControl(expMs) ?? null) : null;

  if (thumbWidth != null && deps.thumbnailCache) {
    await renderAndSendThumbnailMiss(res, ctx, deps, {
      userId,
      sub,
      mediaKind,
      decodedPath,
      thumbWidth,
      expMs,
      runProxy,
      cacheControlOverride,
      captureProxyToSink: helpers.captureProxyToSink,
    });
    return;
  }
  await runProxy(res, cacheControlOverride);
}
