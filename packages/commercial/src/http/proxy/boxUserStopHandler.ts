/** Internal, container-authenticated stop endpoint. The request supplies only
 * turn identity; account/nonce/epoch/request ID come from the durable journal.
 * This route is not part of the public Anthropic Messages model API. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { IdentityError, type IdentityStrategy } from "../../auth/proxyIdentity.js";
import { BoxDurableJournalError, type BoxDurableJournal } from "./boxDurableJournal.js";
import type { BoxUserStopCoordinator } from "./boxUserStopCoordinator.js";

type Journal = Pick<BoxDurableJournal, "findCancelableRun">;
type Coordinator = Pick<BoxUserStopCoordinator, "requestStop">;

function reply(res: ServerResponse, code: number, body: Record<string, unknown>): void {
  if (res.headersSent || res.destroyed) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > 2048) throw new Error("BOX_STOP_BODY_TOO_LARGE");
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown; }
  catch { throw new Error("BOX_STOP_BODY_INVALID"); }
}

export function makeBoxUserStopHandler(deps: { identity: IdentityStrategy;
  journal: Journal; coordinator: Coordinator }) {
  return async (req: IncomingMessage, res: ServerResponse,
    ctx: { hostUuid: string; boundIp: string }): Promise<void> => {
    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/internal/box/stop") {
      reply(res, 404, { error: "NOT_FOUND" }); return;
    }
    let identity: Awaited<ReturnType<IdentityStrategy["resolve"]>>;
    try { identity = await deps.identity.resolve(req, ctx); }
    catch (error) {
      if (error instanceof IdentityError) {
        reply(res, 401, { error: "UNAUTHORIZED" }); return;
      }
      throw error;
    }
    if (identity.containerId === null || identity.apiKey) {
      reply(res, 403, { error: "CONTAINER_REQUIRED" }); return;
    }
    let parsed: unknown;
    try { parsed = await readBody(req); }
    catch (error) {
      reply(res, error instanceof Error && error.message === "BOX_STOP_BODY_TOO_LARGE"
        ? 413 : 400, { error: "INVALID_REQUEST" }); return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      reply(res, 400, { error: "INVALID_REQUEST" }); return;
    }
    const body = parsed as Record<string, unknown>;
    if (Object.keys(body).sort().join(",") !== "oc_turn_key,session_id"
      || typeof body.session_id !== "string"
      || !/^[A-Za-z0-9._:-]{1,256}$/.test(body.session_id)
      || typeof body.oc_turn_key !== "string"
      || !/^[a-f0-9]{64}$/.test(body.oc_turn_key)) {
      reply(res, 400, { error: "INVALID_REQUEST" }); return;
    }
    let run: Awaited<ReturnType<Journal["findCancelableRun"]>>;
    try {
      run = await deps.journal.findCancelableRun({ uid: identity.uid,
        containerId: identity.containerId, sessionId: body.session_id,
        turnKey: body.oc_turn_key });
    } catch (error) {
      if (error instanceof BoxDurableJournalError
        && ["BOX_CANCEL_RUN_UNKNOWN", "BOX_CANCEL_IDENTITY_INVALID"].includes(error.code)) {
        reply(res, 404, { error: "NOT_FOUND" }); return;
      }
      throw error;
    }
    try {
      const outcome = await deps.coordinator.requestStop(run);
      reply(res, 200, { status: outcome === "stopped_proven" ? "stopped" : "pending" });
    } catch {
      // A journal/remote error is not permission to retry a paid model call.
      reply(res, 503, { status: "pending" });
    }
  };
}
