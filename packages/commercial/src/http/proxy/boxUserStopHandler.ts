/** Internal, container-authenticated stop endpoint. The request supplies only
 * turn identity; account/nonce/epoch/request ID come from the durable journal.
 * This route is not part of the public Anthropic Messages model API. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { IdentityError, type IdentityStrategy } from "../../auth/proxyIdentity.js";
import { BoxDurableJournalError, type BoxDurableJournal } from "./boxDurableJournal.js";
import type { BoxUserStopCoordinator } from "./boxUserStopCoordinator.js";

type Journal = Pick<BoxDurableJournal, "findCancelableRun">;
type Coordinator = Pick<BoxUserStopCoordinator, "requestStop">;
const MAX_CONCURRENT_STOPS = 4;

class BoxStopRequestTimeout extends Error {}
async function bounded<T>(pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BoxStopRequestTimeout()), ms);
  })]); }
  finally { if (timer) clearTimeout(timer); }
}

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
  const inFlight = new Map<string, Promise<Awaited<ReturnType<Coordinator["requestStop"]>>>>();
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
    try { parsed = await bounded(readBody(req), 5_000); }
    catch (error) {
      if (error instanceof BoxStopRequestTimeout) {
        reply(res, 408, { error: "REQUEST_TIMEOUT" });
        req.destroy(); return;
      }
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
    const key = `${identity.uid}:${identity.containerId}:${body.session_id}:${body.oc_turn_key}`;
    let execution = inFlight.get(key);
    if (!execution) {
      if (inFlight.size >= MAX_CONCURRENT_STOPS) {
        reply(res, 429, { error: "STOP_BUSY" }); return;
      }
      execution = (async () => {
        const run = await bounded(deps.journal.findCancelableRun({ uid: identity.uid,
          containerId: identity.containerId!, sessionId: body.session_id as string,
          turnKey: body.oc_turn_key as string }), 5_000);
        return deps.coordinator.requestStop(run);
      })();
      inFlight.set(key, execution);
    }
    try {
      const outcome = await execution;
      reply(res, 200, { status: outcome === "stopped_proven" ? "stopped" : "pending" });
    } catch (error) {
      if (error instanceof BoxDurableJournalError
        && ["BOX_CANCEL_RUN_UNKNOWN", "BOX_CANCEL_IDENTITY_INVALID"].includes(error.code)) {
        reply(res, 404, { error: "NOT_FOUND" }); return;
      }
      // A journal/remote error is not permission to retry a paid model call.
      reply(res, 503, { status: "pending" });
    } finally {
      if (inFlight.get(key) === execution) inFlight.delete(key);
    }
  };
}
