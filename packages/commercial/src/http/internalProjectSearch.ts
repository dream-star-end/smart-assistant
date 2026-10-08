/**
 * Container → master project_search (P5a).
 *
 * The agent's `project_search` tool asks its container gateway, which asks
 * here with the container token. The tenant comes only from the verified
 * container identity; the board project id from the query is resolved to that
 * tenant's live chat project, and only that project's non-deleted assets are
 * searched. A board id the tenant does not own (or that does not exist) is a
 * 404, never another tenant's files.
 *
 * GET ?boardProjectId=<uuid>&q=<text>[&source=upload|output][&limit=1..20]
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";

import {
  getChatProjectBindByBoardProjectId,
  isProjectSearchEnabled,
  parseBoardProjectId,
  searchChatProjectAssets,
  PROJECT_ASSET_PROJECT_SEARCH_QUERY_MAX,
  type ProjectAsset,
} from "@openclaude/storage";
import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from "../auth/containerIdentity.js";
import { rootLogger, type Logger } from "../logging/logger.js";
import {
  REQUEST_ID_HEADER,
  ensureRequestId,
  setSecurityHeaders,
} from "./util.js";

export { PROJECT_SEARCH_PATH } from "@openclaude/protocol";

export interface InternalProjectSearchBody {
  chatProjectId: string;
  assets: ProjectAsset[];
}

export interface InternalProjectSearchHandlerCtx {
  hostUuid: string;
  boundIp: string;
}

export interface InternalProjectSearchHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  logger?: Logger;
  /** Defaults to the master env flag (OC_PROJECT_CONTEXT + OC_P5_PROJECT_SEARCH). */
  enabled?: () => boolean;
  getBindByBoardProjectId?: typeof getChatProjectBindByBoardProjectId;
  search?: typeof searchChatProjectAssets;
}

export type InternalProjectSearchHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: InternalProjectSearchHandlerCtx,
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

export function makeInternalProjectSearchHandler(
  deps: InternalProjectSearchHandlerDeps,
): InternalProjectSearchHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "internalProjectSearch" });
  const enabled = deps.enabled ?? (() => isProjectSearchEnabled(process.env));
  const getByBoard = deps.getBindByBoardProjectId ?? getChatProjectBindByBoardProjectId;
  const search = deps.search ?? searchChatProjectAssets;

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    if (!enabled()) {
      sendError(res, 404, "NOT_FOUND", "project search is not enabled", requestId);
      return;
    }
    if (req.method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "GET required", requestId);
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
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parsed = parseBoardProjectId(url.searchParams.get("boardProjectId") ?? "");
    if (!("present" in parsed) || !parsed.present || !parsed.value) {
      sendError(res, 400, "INVALID_BOARD_PROJECT_ID", "boardProjectId must be a uuid", requestId);
      return;
    }
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q || q.length > PROJECT_ASSET_PROJECT_SEARCH_QUERY_MAX) {
      sendError(res, 400, "INVALID_QUERY", `q must be 1..${PROJECT_ASSET_PROJECT_SEARCH_QUERY_MAX} chars`, requestId);
      return;
    }
    const sourceRaw = url.searchParams.get("source");
    if (sourceRaw !== null && sourceRaw !== "" && sourceRaw !== "upload" && sourceRaw !== "output") {
      sendError(res, 400, "INVALID_SOURCE", "source must be upload or output", requestId);
      return;
    }
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null || limitRaw === "" ? undefined : Number(limitRaw);

    const bind = await getByBoard(userId, parsed.value);
    if (!bind || bind.userId !== userId) {
      sendError(res, 404, "PROJECT_NOT_FOUND", "no project for this board id", requestId);
      return;
    }
    const assets = await search(userId, bind.chatProjectId, {
      q,
      ...(sourceRaw === "upload" || sourceRaw === "output" ? { source: sourceRaw } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    const body: InternalProjectSearchBody = { chatProjectId: bind.chatProjectId, assets };
    sendJson(res, 200, body, requestId);
  };
}
