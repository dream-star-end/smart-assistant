/** Internal, container-authenticated Box login endpoints for the interactive session route:
 *   POST /internal/box/login          {account_id}                      -> {profile}
 *   POST /internal/box/login-signals  {account_id, profile, lines, unsafe?} -> {recorded}
 * The uid always comes from the container identity, never from the body. Not part of the public
 * Anthropic Messages API. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { IdentityError, type IdentityStrategy } from "../../auth/proxyIdentity.js";
import type { BoxInteractiveLogins } from "./boxInteractiveLogins.js";

export const BOX_LOGIN_PATH = "/internal/box/login";
export const BOX_LOGIN_SIGNALS_PATH = "/internal/box/login-signals";
const ACCOUNT = /^[1-9][0-9]{0,18}$/;
const PROFILE = /^(default|[a-z0-9][a-z0-9-]{0,31})$/;
const MAX_LINES = 16;
const MAX_LINE_BYTES = 65_536;
const MAX_BODY_BYTES = 300 * 1024;

function reply(res: ServerResponse, code: number, body: Record<string, unknown>): void {
  if (res.headersSent || res.destroyed) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

class BodyTimeout extends Error {}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > limit) throw new Error("BOX_LOGIN_BODY_TOO_LARGE");
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown; }
  catch { throw new Error("BOX_LOGIN_BODY_INVALID"); }
}

async function bounded<T>(pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BodyTimeout()), ms);
  })]); }
  finally { if (timer) clearTimeout(timer); }
}

function validSignals(body: Record<string, unknown>): { lines: string[]; unsafe: boolean } | null {
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "account_id,lines,profile" && keys !== "account_id,lines,profile,unsafe") return null;
  if (!Array.isArray(body.lines) || body.lines.length > MAX_LINES) return null;
  if (!body.lines.every((line) => typeof line === "string" && Buffer.byteLength(line) <= MAX_LINE_BYTES
    && !line.includes("\n"))) return null;
  if (body.unsafe !== undefined && body.unsafe !== true) return null;
  return { lines: body.lines as string[], unsafe: body.unsafe === true };
}

export function makeBoxLoginHandler(deps: { identity: IdentityStrategy;
  logins: Pick<BoxInteractiveLogins, "choose" | "observe"> }) {
  return async (req: IncomingMessage, res: ServerResponse,
    ctx: { hostUuid: string; boundIp: string }): Promise<void> => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "POST" || (path !== BOX_LOGIN_PATH && path !== BOX_LOGIN_SIGNALS_PATH)) {
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
    try { parsed = await bounded(readBody(req, path === BOX_LOGIN_PATH ? 1024 : MAX_BODY_BYTES), 5_000); }
    catch (error) {
      if (error instanceof BodyTimeout) { reply(res, 408, { error: "REQUEST_TIMEOUT" }); req.destroy(); return; }
      reply(res, error instanceof Error && error.message === "BOX_LOGIN_BODY_TOO_LARGE" ? 413 : 400,
        { error: "INVALID_REQUEST" });
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      reply(res, 400, { error: "INVALID_REQUEST" }); return;
    }
    const body = parsed as Record<string, unknown>;
    if (typeof body.account_id !== "string" || !ACCOUNT.test(body.account_id)) {
      reply(res, 400, { error: "INVALID_REQUEST" }); return;
    }
    const accountId = BigInt(body.account_id);
    if (path === BOX_LOGIN_PATH) {
      if (Object.keys(body).length !== 1) { reply(res, 400, { error: "INVALID_REQUEST" }); return; }
      let choice: Awaited<ReturnType<BoxInteractiveLogins["choose"]>>;
      try { choice = await deps.logins.choose(identity.uid, accountId); }
      catch {
        // The selection could not be read (and no read from the last 60s is cached). The
        // container then launches its default login, as every Box session did before logins.
        reply(res, 503, { error: "BOX_LOGIN_STORE_UNAVAILABLE" }); return;
      }
      if (choice.kind === "unknown_account") { reply(res, 404, { error: "NOT_FOUND" }); return; }
      if (choice.kind === "unavailable") { reply(res, 503, { error: "BOX_LOGIN_UNAVAILABLE" }); return; }
      reply(res, 200, { profile: choice.profile });
      return;
    }
    if (typeof body.profile !== "string" || !PROFILE.test(body.profile)) {
      reply(res, 400, { error: "INVALID_REQUEST" }); return;
    }
    const report = validSignals(body);
    if (!report) { reply(res, 400, { error: "INVALID_REQUEST" }); return; }
    reply(res, 200, { recorded: deps.logins.observe(identity.uid, accountId, body.profile, report) });
  };
}
