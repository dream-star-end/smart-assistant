/**
 * Master-side Anthropic relay for hosted ZCode CLI.
 * Opaque route token + container identity; Coding Plan key is injected here only.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { request } from "undici";
import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from "../auth/containerIdentity.js";
import { ensureRequestId, REQUEST_ID_HEADER, setSecurityHeaders } from "./util.js";
import {
  resolveZcodeRelayRoute,
  ZCODE_RELAY_PREFIX,
  ZCODE_UPSTREAM_API_MODEL,
} from "../billing/zcodeRouteContext.js";

export { ZCODE_RELAY_PREFIX };
export const ZCODE_OFFICIAL_UPSTREAM = "https://api.z.ai/api/anthropic/v1/messages";
const TOKEN_RE = /^[0-9a-f]{64}$/;
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type ZcodeRelayHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { hostUuid: string; boundIp: string },
) => Promise<void>;

function error(res: ServerResponse, status: number, code: string, requestId: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: { code, message: "zcode relay unavailable" }, requestId }));
}

function readLimited(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function forceUpstreamModel(raw: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("invalid json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid json");
  }
  const body = parsed as Record<string, unknown>;
  body.model = ZCODE_UPSTREAM_API_MODEL;
  return Buffer.from(JSON.stringify(body), "utf8");
}

export function makeZcodeRelayHandler(deps: {
  identityRepo: ContainerIdentityRepo;
  codingPlanKey: string;
  requestFn?: typeof request;
}): ZcodeRelayHandler {
  return async (req, res, ctx) => {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    let identity;
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization);
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        error(res, 401, "UNAUTHORIZED", requestId);
        return;
      }
      throw err;
    }
    const parsed = new URL(req.url ?? "/", "http://local");
    const match = new RegExp(`^${ZCODE_RELAY_PREFIX}/route/([0-9a-f]{64})/v1/messages$`).exec(
      parsed.pathname,
    );
    if (!match || !TOKEN_RE.test(match[1]!)) {
      error(res, 404, "NOT_FOUND", requestId);
      return;
    }
    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      error(res, 405, "METHOD_NOT_ALLOWED", requestId);
      return;
    }
    const route = resolveZcodeRelayRoute({
      token: match[1]!,
      containerId: identity.containerId,
      userId: BigInt(identity.userId),
    });
    if (!route) {
      error(res, 404, "ZCODE_ROUTE_EXPIRED", requestId);
      return;
    }
    const key = deps.codingPlanKey.trim();
    if (!key) {
      error(res, 503, "ZCODE_UPSTREAM_UNAVAILABLE", requestId);
      return;
    }
    let keyBuf: Buffer | null = Buffer.from(key, "utf8");
    try {
      const rawBody = await readLimited(req, 2 * 1024 * 1024);
      const body = forceUpstreamModel(rawBody);
      const upstream = await (deps.requestFn ?? request)(ZCODE_OFFICIAL_UPSTREAM, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: typeof req.headers.accept === "string" ? req.headers.accept : "application/json",
        },
        body,
      });
      res.statusCode = upstream.statusCode;
      for (const [rawKey, rawValue] of Object.entries(upstream.headers)) {
        const headerKey = rawKey.toLowerCase();
        if (!HOP.has(headerKey) && headerKey !== "content-length" && rawValue !== undefined) {
          res.setHeader(rawKey, Array.isArray(rawValue) ? rawValue : String(rawValue));
        }
      }
      await pipeline(upstream.body, res);
    } catch {
      if (res.headersSent) {
        res.destroy();
      } else {
        error(res, 503, "ZCODE_UPSTREAM_UNAVAILABLE", requestId);
      }
    } finally {
      keyBuf?.fill(0);
      keyBuf = null;
    }
  };
}
