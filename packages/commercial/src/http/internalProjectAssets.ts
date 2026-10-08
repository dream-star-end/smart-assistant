/**
 * Container → master: register turn outputs as project assets.
 *
 * The output collector runs in the user container, whose own sessions
 * backend is a local SQLite file the web UI never reads. Assets registered
 * there had no project and were invisible. This route writes them into the
 * master sessions backend (PG), the one /api/project-assets reads.
 *
 * Tenant comes only from the verified container identity, never from the
 * body. The session must be an active session of that tenant. `projectId`,
 * when present, is the chat project the turn resolved when it started; it is
 * honoured only if the tenant still owns that project, otherwise the asset is
 * registered ungrouped rather than dropped. Absent `projectId` keeps the old
 * rule (the session's project at registration time).
 *
 * Repeats are harmless: createProjectAsset dedups by digest/container path.
 *
 * Versions: a current container copies each output into the content-addressed
 * store first and sends `digest` + `url` of that copy. Both or neither; the
 * digest must be 64 lowercase hex and the url must be the media URL of that
 * same digest, otherwise the whole batch is rejected (a row must never point
 * at bytes other than the ones it claims). Older containers send neither and
 * are registered by source path exactly as before. `capturedAt` (optional,
 * finite ms) is the source mtime of the copied bytes; the backend uses it to
 * recognise a resent old registration instead of minting a fake new version.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  classifyClientSessions,
  createProjectAsset,
  digestFromProjectAssetUrl,
  parseProjectAssetContainerPath,
  PROJECT_ASSET_URL_RE,
} from "@openclaude/storage";
import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from "../auth/containerIdentity.js";
import { rootLogger, type Logger } from "../logging/logger.js";
import { REQUEST_ID_HEADER, ensureRequestId, setSecurityHeaders } from "./util.js";

export { PROJECT_ASSETS_REGISTER_PATH } from "@openclaude/protocol";

export const PROJECT_ASSETS_REGISTER_MAX_ITEMS = 20;
const BODY_MAX_BYTES = 64 * 1024;

export interface InternalProjectAssetItemResult {
  containerPath: string;
  ok: boolean;
  created?: boolean;
  assetId?: string;
  projectId?: string | null;
  error?: string;
}

export interface InternalProjectAssetsHandlerCtx {
  hostUuid: string;
  boundIp: string;
}

export interface InternalProjectAssetsHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  logger?: Logger;
  classify?: typeof classifyClientSessions;
  create?: typeof createProjectAsset;
}

export type InternalProjectAssetsHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: InternalProjectAssetsHandlerCtx,
) => Promise<void>;

function sendJson(res: ServerResponse, status: number, payload: unknown, requestId: string): void {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store",
    [REQUEST_ID_HEADER]: requestId,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, code: string, message: string, requestId: string): void {
  sendJson(res, status, { error: { code, message }, request_id: requestId }, requestId);
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > BODY_MAX_BYTES) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface ParsedItem {
  containerPath: string;
  name: string;
  mime?: string;
  size?: number;
  digest?: string;
  url?: string;
  capturedAt?: number;
}

const DIGEST_RE = /^[0-9a-f]{64}$/;

/** undefined = neither sent (old container); null = invalid; else the checked pair. */
function parseVersionCopy(e: Record<string, unknown>): { digest: string; url: string } | undefined | null {
  const hasDigest = e.digest !== undefined && e.digest !== null;
  const hasUrl = e.url !== undefined && e.url !== null;
  if (!hasDigest && !hasUrl) return undefined;
  if (typeof e.digest !== "string" || typeof e.url !== "string") return null;
  if (!DIGEST_RE.test(e.digest) || !PROJECT_ASSET_URL_RE.test(e.url)) return null;
  if (digestFromProjectAssetUrl(e.url) !== e.digest) return null;
  return { digest: e.digest, url: e.url };
}

function parseItems(raw: unknown): ParsedItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PROJECT_ASSETS_REGISTER_MAX_ITEMS) return null;
  const out: ParsedItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    const containerPath = parseProjectAssetContainerPath(e.containerPath);
    // Only agent outputs come through here; uploads have their own route.
    if (!containerPath || !containerPath.startsWith("/home/agent/.openclaude/generated/")) return null;
    if (typeof e.name !== "string" || !e.name.trim()) return null;
    const copy = parseVersionCopy(e);
    if (copy === null) return null;
    // Source mtime (ms) of the copied bytes; tells a spool replay from a real rewrite.
    if (e.capturedAt !== undefined && e.capturedAt !== null
      && (typeof e.capturedAt !== "number" || !Number.isFinite(e.capturedAt) || e.capturedAt < 0)) return null;
    out.push({
      containerPath,
      name: e.name,
      ...(typeof e.mime === "string" ? { mime: e.mime } : {}),
      ...(typeof e.size === "number" && Number.isFinite(e.size) ? { size: e.size } : {}),
      ...(copy ?? {}),
      ...(typeof e.capturedAt === "number" ? { capturedAt: e.capturedAt } : {}),
    });
  }
  return out;
}

export function makeInternalProjectAssetsHandler(
  deps: InternalProjectAssetsHandlerDeps,
): InternalProjectAssetsHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "internalProjectAssets" });
  const classify = deps.classify ?? classifyClientSessions;
  const create = deps.create ?? createProjectAsset;

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    if (req.method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "POST required", requestId);
      return;
    }
    let identity;
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization);
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        log.warn("identity_failed", { errcode: err.code, requestId });
        sendError(res, 401, "UNAUTHORIZED", "container identity verification failed", requestId);
        return;
      }
      throw err;
    }
    const userId = `c:${identity.userId}`;
    const text = await readBody(req);
    if (text == null) {
      sendError(res, 413, "BODY_TOO_LARGE", "body too large", requestId);
      return;
    }
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      sendError(res, 400, "BAD_JSON", "body must be a JSON object", requestId);
      return;
    }
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) {
      sendError(res, 400, "MISSING_SESSION", "sessionId required", requestId);
      return;
    }
    const items = parseItems(body.items);
    if (!items) {
      sendError(res, 400, "INVALID_ITEMS", `items must be 1-${PROJECT_ASSETS_REGISTER_MAX_ITEMS} generated outputs`, requestId);
      return;
    }
    const projectIdPresent = Object.hasOwn(body, "projectId");
    const frozenProjectId =
      body.projectId === null ? null : typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : undefined;
    if (projectIdPresent && frozenProjectId === undefined) {
      sendError(res, 400, "INVALID_PROJECT", "projectId must be a string or null", requestId);
      return;
    }

    const [lifecycle] = await classify([{ sessionId, userId }]);
    if (lifecycle?.state !== "active") {
      // A deleted or foreign session gets nothing; the container drops these.
      sendJson(res, 200, { sessionState: lifecycle?.state ?? "missing", results: [] }, requestId);
      return;
    }

    const results: InternalProjectAssetItemResult[] = [];
    for (const item of items) {
      const input = {
        source: "output" as const,
        sessionId,
        name: item.name,
        containerPath: item.containerPath,
        ...(item.mime ? { mime: item.mime } : {}),
        ...(item.size !== undefined ? { size: item.size } : {}),
        ...(item.digest && item.url ? { digest: item.digest, url: item.url } : {}),
        ...(item.capturedAt !== undefined ? { capturedAt: item.capturedAt } : {}),
      };
      let result = await create(userId, projectIdPresent ? { ...input, projectId: frozenProjectId } : input);
      if (!result.ok && result.error === "project_not_found" && projectIdPresent && frozenProjectId) {
        // The project was deleted after the turn started: keep the output, ungrouped.
        result = await create(userId, { ...input, projectId: null });
      }
      if (result.ok) {
        results.push({
          containerPath: item.containerPath,
          ok: true,
          created: result.created,
          assetId: result.asset.id,
          projectId: result.asset.projectId,
        });
      } else {
        results.push({ containerPath: item.containerPath, ok: false, error: result.error });
      }
    }
    sendJson(res, 200, { sessionState: "active", results }, requestId);
  };
}
