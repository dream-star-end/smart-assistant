/**
 * Container → master live project context (bind + pinned assets).
 *
 * Instructions in this payload are the PG/sqlite chat_projects copy:
 *   - unbound chat sessions inject them directly
 *   - bound projects use them only as a one-time PROJECT.md seed
 * Pinned assets are always live (B1). No assets.json cache.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";

import {
  assetsRevision,
  getChatProjectBindByBoardProjectId,
  getChatProjectBindBySessionId,
  listPinnedProjectAssetsForChatProject,
  parseBoardProjectId,
  type ChatProjectRuntimeBind,
  type PinnedAssetsPage,
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

export const PROJECT_CONTEXT_PATH = "/internal/v3/project-context";

export interface InternalProjectContextBody {
  userId: string;
  chatProjectId: string | null;
  boardProjectId: string | null;
  name: string | null;
  /** PG/sqlite instructions. Bound runtime must not treat this as SoT. */
  instructions: string | null;
  pinnedAssets: ProjectAsset[];
  assetsRevision: number;
}

export interface InternalProjectContextHandlerCtx {
  hostUuid: string;
  boundIp: string;
}

export interface InternalProjectContextHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  logger?: Logger;
  getBindBySessionId?: typeof getChatProjectBindBySessionId;
  getBindByBoardProjectId?: typeof getChatProjectBindByBoardProjectId;
  listPinned?: typeof listPinnedProjectAssetsForChatProject;
}

export type InternalProjectContextHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: InternalProjectContextHandlerCtx,
) => Promise<void>;

function tenantUserId(uid: number): string {
  return `c:${uid}`;
}

function emptyBody(userId: string): InternalProjectContextBody {
  return {
    userId,
    chatProjectId: null,
    boardProjectId: null,
    name: null,
    instructions: null,
    pinnedAssets: [],
    assetsRevision: 0,
  };
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  requestId: string,
): void {
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

export function makeInternalProjectContextHandler(
  deps: InternalProjectContextHandlerDeps,
): InternalProjectContextHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "internalProjectContext" });
  const getBySession = deps.getBindBySessionId ?? getChatProjectBindBySessionId;
  const getByBoard = deps.getBindByBoardProjectId ?? getChatProjectBindByBoardProjectId;
  const listPinned = deps.listPinned ?? listPinnedProjectAssetsForChatProject;

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    if (req.method !== "GET") {
      sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "GET required" }, request_id: requestId }, requestId);
      return;
    }
    let identity;
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization);
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        log.warn("identity_failed", { errcode: err.code, requestId });
        sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "container identity verification failed" }, request_id: requestId }, requestId);
        return;
      }
      throw err;
    }
    const userId = tenantUserId(identity.userId);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const sessionId = (url.searchParams.get("sessionId") ?? "").trim();
    const boardRaw = url.searchParams.get("boardProjectId");
    let bind: ChatProjectRuntimeBind | null = null;
    if (sessionId) {
      bind = await getBySession(sessionId);
      if (bind && bind.userId !== userId) bind = null;
    } else if (boardRaw != null && boardRaw !== "") {
      const parsed = parseBoardProjectId(boardRaw);
      if ("invalid" in parsed) {
        sendJson(res, 400, { error: { code: "INVALID_BOARD_PROJECT_ID", message: "boardProjectId must be a uuid" }, request_id: requestId }, requestId);
        return;
      }
      if (parsed.present && parsed.value) {
        bind = await getByBoard(userId, parsed.value);
      }
    } else {
      sendJson(res, 400, { error: { code: "MISSING_QUERY", message: "sessionId or boardProjectId required" }, request_id: requestId }, requestId);
      return;
    }

    const pinned: PinnedAssetsPage = bind
      ? await listPinned(userId, bind.chatProjectId)
      : { assets: [], revision: 0 };

    const body: InternalProjectContextBody = bind
      ? {
          userId,
          chatProjectId: bind.chatProjectId,
          boardProjectId: bind.boardProjectId,
          name: bind.name,
          instructions: bind.instructions,
          pinnedAssets: pinned.assets,
          assetsRevision: pinned.revision || assetsRevision(pinned.assets),
        }
      : {
          ...emptyBody(userId),
          boardProjectId:
            boardRaw && parseBoardProjectId(boardRaw).present
              ? (parseBoardProjectId(boardRaw) as { present: true; value: string | null }).value
              : null,
        };
    sendJson(res, 200, body, requestId);
  };
}
