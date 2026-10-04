/** Read-only idle proof. Identity comes from the container token.
 * The body may only name the outer runner session and turn key. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { IdentityError, type IdentityStrategy } from "../../auth/proxyIdentity.js";
import { BoxDurableJournalError, type BoxDurableJournal } from "./boxDurableJournal.js";
import type { BoxIdleProof } from "./boxIdleChain.js";
import type { BoxReplayMessagePointer } from "./boxReplayMessageFile.js";

type Journal = Pick<BoxDurableJournal, "readIdleProof">;
type CapsuleReader = (pointer: BoxReplayMessagePointer) => Promise<unknown>;

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
    if (size > 2048) throw new Error("BOX_IDLE_BODY_TOO_LARGE");
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown; }
  catch { throw new Error("BOX_IDLE_BODY_INVALID"); }
}

export function makeBoxIdleProofHandler(deps: {
  identity: IdentityStrategy; journal: Journal; readCapsule?: CapsuleReader }) {
  return async (req: IncomingMessage, res: ServerResponse,
    ctx: { hostUuid: string; boundIp: string }): Promise<void> => {
    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/internal/box/idle-proof") {
      reply(res, 404, { error: "NOT_FOUND" }); return;
    }
    let identity: Awaited<ReturnType<IdentityStrategy["resolve"]>>;
    try { identity = await deps.identity.resolve(req, ctx); }
    catch (error) {
      if (error instanceof IdentityError) { reply(res, 401, { error: "UNAUTHORIZED" }); return; }
      throw error;
    }
    if (identity.containerId === null || identity.apiKey) {
      reply(res, 403, { error: "CONTAINER_REQUIRED" }); return;
    }
    let parsed: unknown;
    try { parsed = await readBody(req); }
    catch (error) {
      reply(res, error instanceof Error && error.message === "BOX_IDLE_BODY_TOO_LARGE" ? 413 : 400,
        { error: "INVALID_REQUEST" }); return;
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
    let proof: BoxIdleProof;
    try {
      proof = await deps.journal.readIdleProof({
        uid: identity.uid,
        containerId: identity.containerId,
        sessionId: body.session_id,
        turnKey: body.oc_turn_key,
      }, deps.readCapsule);
    } catch (error) {
      if (error instanceof BoxDurableJournalError && error.code === "BOX_CANCEL_IDENTITY_INVALID") {
        reply(res, 400, { error: "INVALID_REQUEST" }); return;
      }
      reply(res, 503, { status: "pending", reason: "unavailable" }); return;
    }
    if (proof.status === "not_found") { reply(res, 404, { error: "NOT_FOUND" }); return; }
    reply(res, 200, proof);
  };
}
