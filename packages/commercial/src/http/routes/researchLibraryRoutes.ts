import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson } from "../util.js";
import type { AuthenticatedHttpUser } from "./shared.js";

export async function serveListResearchLibrary(
  req: IncomingMessage,
  res: ServerResponse,
  user: AuthenticatedHttpUser,
): Promise<void> {
  const {
    listLibraryDocuments,
    ensureDefaultResearchProject,
    libraryListProjectIdFromUrl,
    isResearchWorkspaceEnabled,
  } = await import("../../research/library.js");
  const workspaceOn = isResearchWorkspaceEnabled();
  const projectId = libraryListProjectIdFromUrl(req.url, workspaceOn);
  if (workspaceOn) {
    await ensureDefaultResearchProject(user.id);
  }
  const docs = await listLibraryDocuments(user.id, projectId);
  sendJson(res, 200, { documents: docs });
}

export async function serveDeleteResearchLibraryDoc(
  req: IncomingMessage,
  res: ServerResponse,
  user: AuthenticatedHttpUser,
): Promise<void> {
  const m = (req.url ?? "").match(/^\/api\/me\/research\/library\/([A-Za-z0-9_-]+)(?:\?|$)/);
  const docId = m?.[1] ?? "";
  if (!docId) throw new HttpError(400, "INVALID_DOC_ID", "docId required");
  const { deleteLibraryDocument } = await import("../../research/library.js");
  const deleted = await deleteLibraryDocument(user.id, docId);
  if (!deleted) throw new HttpError(404, "NOT_FOUND", "document not found");
  sendJson(res, 200, { ok: true });
}

export async function serveUploadResearchLibraryDoc(
  req: IncomingMessage,
  res: ServerResponse,
  user: AuthenticatedHttpUser,
): Promise<void> {
  const { MAX_LIBRARY_UPLOAD_BYTES, uploadAndIngestDocument } = await import(
    "../../research/library.js"
  );

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_LIBRARY_UPLOAD_BYTES) {
      throw new HttpError(413, "UPLOAD_TOO_LARGE", "document exceeds 25MiB limit");
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length === 0) throw new HttpError(400, "EMPTY_UPLOAD", "empty body");

  const mime = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0]!.trim();
  const rawName = new URL(req.url ?? "/", "http://x").searchParams.get("filename") ?? "";
  const filename = rawName ? rawName.replace(/[/\\]/g, "").slice(0, 200) : undefined;

  const outcome = await uploadAndIngestDocument(Number(user.id), bytes, mime, filename);
  if ("disabled" in outcome) {
    throw new HttpError(503, "RESEARCH_DISABLED", "research subsystem is disabled");
  }
  if (!outcome.ok) {
    if (outcome.needsOcr) {
      sendJson(res, 200, { needsOcr: true, reason: outcome.reason });
      return;
    }
    throw new HttpError(400, "INGEST_FAILED", outcome.reason);
  }
  sendJson(res, 200, outcome.outline);
}
