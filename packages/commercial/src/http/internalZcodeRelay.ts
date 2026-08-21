/**
 * Master-side Anthropic relay for hosted ZCode CLI.
 * Opaque route token + container identity; Coding Plan key is injected here only.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { request } from "undici";
import type { Dispatcher } from "undici";
import { directEgressDispatcher } from "../account-pool/egressDispatcher.js";
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
export const ZCODE_ANTHROPIC_VERSION = "2023-06-01";
const TOKEN_RE = /^[0-9a-f]{64}$/;
const ZCODE_RELAY_STREAM_MAX_EVENTS = 8_192;
const ZCODE_RELAY_STREAM_MAX_CHARS = 4 * 1024 * 1024;
const ZCODE_RELAY_STREAM_TTL_MS = 60_000;
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

export type ZcodeRelayStreamEvent = {
  seq: number;
  kind: "thinking" | "text";
  text: string;
};

type ZcodeRelayStreamJournal = {
  seq: number;
  chars: number;
  events: ZcodeRelayStreamEvent[];
  done: boolean;
  cleanupTimer: NodeJS.Timeout | null;
  boundIp: string;
  authorizationHash: Buffer;
};

const streamJournals = new Map<string, ZcodeRelayStreamJournal>();

function hashAuthorization(value: string | undefined): Buffer {
  return createHash("sha256").update(value ?? "", "utf8").digest();
}

function journalFor(
  token: string,
  boundIp: string,
  authorization: string | undefined,
): ZcodeRelayStreamJournal {
  let journal = streamJournals.get(token);
  if (!journal) {
    journal = {
      seq: 0,
      chars: 0,
      events: [],
      done: false,
      cleanupTimer: null,
      boundIp,
      authorizationHash: hashAuthorization(authorization),
    };
    streamJournals.set(token, journal);
  }
  if (journal.cleanupTimer) {
    clearTimeout(journal.cleanupTimer);
    journal.cleanupTimer = null;
  }
  journal.done = false;
  return journal;
}

function appendStreamEvent(
  journal: ZcodeRelayStreamJournal,
  kind: ZcodeRelayStreamEvent["kind"],
  text: unknown,
): void {
  if (typeof text !== "string" || text.length === 0) return;
  if (
    journal.events.length >= ZCODE_RELAY_STREAM_MAX_EVENTS ||
    journal.chars + text.length > ZCODE_RELAY_STREAM_MAX_CHARS
  ) return;
  journal.chars += text.length;
  journal.events.push({ seq: ++journal.seq, kind, text });
}

function acceptSseData(journal: ZcodeRelayStreamJournal, raw: string): void {
  if (!raw || raw === "[DONE]") return;
  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    event = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  const delta = event.delta && typeof event.delta === "object" && !Array.isArray(event.delta)
    ? event.delta as Record<string, unknown>
    : null;
  if (delta?.type === "thinking_delta") {
    appendStreamEvent(journal, "thinking", delta.thinking);
    return;
  }
  if (delta?.type === "text_delta") {
    appendStreamEvent(journal, "text", delta.text);
    return;
  }
  const block = event.content_block && typeof event.content_block === "object" && !Array.isArray(event.content_block)
    ? event.content_block as Record<string, unknown>
    : null;
  if (block?.type === "thinking") appendStreamEvent(journal, "thinking", block.thinking);
  else if (block?.type === "text") appendStreamEvent(journal, "text", block.text);
}

class ZcodeRelaySseTap extends Transform {
  private carry = "";
  private readonly decoder = new StringDecoder("utf8");

  constructor(private readonly journal: ZcodeRelayStreamJournal) {
    super();
  }

  private consume(final: boolean): void {
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.carry);
      if (!boundary) break;
      const frame = this.carry.slice(0, boundary.index);
      this.carry = this.carry.slice(boundary.index + boundary[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      acceptSseData(this.journal, data);
    }
    if (final && this.carry.trim()) {
      const data = this.carry
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      acceptSseData(this.journal, data);
      this.carry = "";
    }
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.carry += this.decoder.write(chunk);
    this.consume(false);
    this.push(chunk);
    callback();
  }

  override _flush(callback: (error?: Error | null) => void): void {
    this.carry += this.decoder.end();
    this.consume(true);
    callback();
  }
}

function finishJournal(token: string, journal: ZcodeRelayStreamJournal): void {
  journal.done = true;
  journal.cleanupTimer = setTimeout(() => {
    if (streamJournals.get(token) === journal) streamJournals.delete(token);
  }, ZCODE_RELAY_STREAM_TTL_MS);
  journal.cleanupTimer.unref();
}

export function _resetZcodeRelayStreamJournalsForTests(): void {
  for (const journal of streamJournals.values()) {
    if (journal.cleanupTimer) clearTimeout(journal.cleanupTimer);
  }
  streamJournals.clear();
}

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

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) return value[0].trim();
  return undefined;
}

export function makeZcodeRelayHandler(deps: {
  identityRepo: ContainerIdentityRepo;
  codingPlanKey: string;
  requestFn?: typeof request;
  /** Test override. Production uses the same singleton as STATIC_PROVIDER_META.zai. */
  dispatcher?: Dispatcher;
}): ZcodeRelayHandler {
  return async (req, res, ctx) => {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const parsed = new URL(req.url ?? "/", "http://local");
    const match = new RegExp(`^${ZCODE_RELAY_PREFIX}/route/([0-9a-f]{64})/(v1/messages|events)$`).exec(
      parsed.pathname,
    );
    if (!match || !TOKEN_RE.test(match[1]!)) {
      error(res, 404, "NOT_FOUND", requestId);
      return;
    }
    const method = (req.method ?? "GET").toUpperCase();
    if (match[2] === "events") {
      if (method !== "GET") {
        error(res, 405, "METHOD_NOT_ALLOWED", requestId);
        return;
      }
      const rawAfter = parsed.searchParams.get("after") ?? "0";
      if (!/^\d{1,16}$/.test(rawAfter)) {
        error(res, 400, "INVALID_CURSOR", requestId);
        return;
      }
      const after = Number(rawAfter);
      if (!Number.isSafeInteger(after) || after < 0) {
        error(res, 400, "INVALID_CURSOR", requestId);
        return;
      }
      const journal = streamJournals.get(match[1]!);
      if (journal) {
        const candidate = hashAuthorization(req.headers.authorization);
        if (
          journal.boundIp !== ctx.boundIp ||
          candidate.length !== journal.authorizationHash.length ||
          !timingSafeEqual(candidate, journal.authorizationHash)
        ) {
          error(res, 401, "UNAUTHORIZED", requestId);
          return;
        }
      }
      const events = journal?.events.slice(after, after + 1_024) ?? [];
      const next = events.at(-1)?.seq ?? after;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({ events, next, done: journal?.done === true }));
      return;
    }
    if (method !== "POST") {
      error(res, 405, "METHOD_NOT_ALLOWED", requestId);
      return;
    }
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
    const route = await resolveZcodeRelayRoute({
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
    const journal = journalFor(match[1]!, ctx.boundIp, req.headers.authorization);
    try {
      const rawBody = await readLimited(req, 2 * 1024 * 1024);
      const body = forceUpstreamModel(rawBody);
      const anthropicVersion = headerValue(req.headers["anthropic-version"]) ?? ZCODE_ANTHROPIC_VERSION;
      // Match STATIC_PROVIDER_META.zai.egress="direct": do not inherit the
      // process-global EnvHttpProxyAgent (Japanese sing-box). api.z.ai via
      // that proxy ECONNRESETs; empty catch mapped it to 503.
      const dispatcher = deps.dispatcher ?? directEgressDispatcher();
      const upstream = await (deps.requestFn ?? request)(ZCODE_OFFICIAL_UPSTREAM, {
        method: "POST",
        headers: {
          "x-api-key": key,
          authorization: `Bearer ${key}`,
          "anthropic-version": anthropicVersion,
          "content-type": "application/json",
          accept: typeof req.headers.accept === "string" ? req.headers.accept : "application/json",
        },
        body,
        dispatcher,
      });
      res.statusCode = upstream.statusCode;
      for (const [rawKey, rawValue] of Object.entries(upstream.headers)) {
        const headerKey = rawKey.toLowerCase();
        if (!HOP.has(headerKey) && headerKey !== "content-length" && rawValue !== undefined) {
          res.setHeader(rawKey, Array.isArray(rawValue) ? rawValue : String(rawValue));
        }
      }
      await pipeline(upstream.body, new ZcodeRelaySseTap(journal), res);
    } catch {
      if (res.headersSent) {
        res.destroy();
      } else {
        error(res, 503, "ZCODE_UPSTREAM_UNAVAILABLE", requestId);
      }
    } finally {
      finishJournal(match[1]!, journal);
      keyBuf?.fill(0);
      keyBuf = null;
    }
  };
}
