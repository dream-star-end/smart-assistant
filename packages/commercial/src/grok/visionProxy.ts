// Master-side image understanding on Grok 4.7 (grok-build).
//
// This is the backend of the container's understand_image / oc-vision /
// oc-figcheck tools. The Grok engine itself only takes a text prompt, so the
// image never reaches Grok through an engine turn; here the container hands the
// image and the question to the master, and the master calls the official CLI
// chat proxy's Responses API with one borrowed Grok account. Same shape as
// webSearchProxy.ts: the subscription token stays on the master, the container
// only presents its identity token, and no grok-build slot is taken.
//
// Unlike the search fallback this call is billed. It is the user's own model
// usage, at the grok-build catalog price:
//   admit   catalog + per-user model authorization + frozen price, credit
//           reservation, inflight journal row — all before the upstream call
//   settle  usage reported by the upstream response -> usage_records +
//           credit_ledger + journal committed (settleDurableCodexBilling, the
//           same routine every other Grok settle uses)
//   abandon any failure before a usable answer: journal aborted, reservation
//           released, nothing charged
// The container never gets a relay route or a request id it could settle
// itself, so usage is metered by the master from the upstream's own numbers.

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { GROK_VISION_PATH } from "@openclaude/protocol";
import type { Pool } from "pg";
import type { Dispatcher } from "undici";
import { request as undiciRequest } from "undici";
import { z } from "zod";

import { directEgressDispatcher } from "../account-pool/egressDispatcher.js";
import { getFreshGrokAccessToken } from "../account-pool/grokOAuth.js";
import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from "../auth/containerIdentity.js";
import { scopeFromAuthz, type UserModelAuthzLoader } from "../auth/userModelAuthz.js";
import { deriveEngineSessionId } from "../billing/codexFinalizer.js";
import { settleDurableCodexBilling } from "../billing/durableCodexBilling.js";
import type { ModelCatalogSnapshot } from "../billing/modelCatalog.js";
import { serializeBillingPricing } from "../billing/persistedBillingPricing.js";
import type { PricingCache } from "../billing/pricing.js";
import {
  InsufficientCreditsError,
  estimateMaxCost,
  preCheckWithCost,
  releasePreCheck,
  type PreCheckRedis,
} from "../billing/preCheck.js";
import { abortInflightJournal, startInflightJournal } from "../billing/proxyBilling.js";
import { query } from "../db/queries.js";
import { classifyGrokRelayStatus } from "../http/internalGrokRelay.js";
import {
  ensureRequestId,
  HttpError,
  readJsonBody,
  REQUEST_ID_HEADER,
  sendError,
  sendJson,
  setSecurityHeaders,
} from "../http/util.js";
import { rootLogger, type Logger } from "../logging/logger.js";

export { GROK_VISION_PATH };
export const GROK_VISION_UPSTREAM = "https://cli-chat-proxy.grok.com/v1/responses";
/** Product model the vision backend runs on and is billed as. */
export const GROK_VISION_MODEL = "grok-build";
export const GROK_VISION_JOURNAL_SOURCE = "vision_grok";

// Raw image cap matches the gateway side (5MB default, 6MB hard cap). Base64
// grows it by 4/3, plus the prompt and JSON framing.
export const GROK_VISION_MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_BODY_BYTES = 9 * 1024 * 1024;
const MAX_PROMPT_CHARS = 8_000;
const UPSTREAM_TIMEOUT_MS = 90_000;
// Reasoning tokens count against the output cap, so leave room above the
// 1024-token answer the previous backend allowed.
const MAX_OUTPUT_TOKENS = 2_048;
// One image is roughly 1.5k input tokens; reserve for the image, the prompt
// and the full output cap at the output price (estimateMaxCost is output-priced).
const PRECHECK_TOKEN_ESTIMATE = 8_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_CONTAINER = 30;
const rateState = new Map<string, { count: number; windowStart: number }>();

const MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
type VisionMediaType = (typeof MEDIA_TYPES)[number];

const VisionRequestSchema = z
  .object({
    image: z
      .object({
        mediaType: z.enum(MEDIA_TYPES),
        data: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/),
      })
      .strict(),
    prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
  })
  .strict();

type HandlerCtx = { hostUuid: string; boundIp: string };

type UpstreamResponse = {
  statusCode: number;
  body: { text: () => Promise<string> };
};

export interface GrokVisionCatalog {
  assertFresh(): Promise<ModelCatalogSnapshot>;
}

export interface GrokVisionHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  getPool: () => Pool;
  preCheckRedis: PreCheckRedis;
  /** Settle compatibility only; the charged price is the one frozen at admit. */
  pricing: PricingCache;
  catalog: GrokVisionCatalog;
  loadUserModelAuthz: UserModelAuthzLoader;
  logger?: Logger;
  pickAccountId?: () => Promise<bigint | null>;
  freshToken?: (accountId: bigint) => Promise<Buffer>;
  requestFn?: (
    url: string,
    init: {
      method: "POST";
      headers: Record<string, string>;
      body: string;
      dispatcher?: Dispatcher;
      headersTimeout: number;
      bodyTimeout: number;
    },
  ) => Promise<UpstreamResponse>;
  recordStatus?: (accountId: bigint, statusCode: number) => Promise<void>;
  newRequestId?: () => string;
  now?: () => number;
  preCheckWithCostFn?: typeof preCheckWithCost;
  startInflightJournalFn?: typeof startInflightJournal;
  settleDurableCodexBillingFn?: typeof settleDurableCodexBilling;
  abortInflightJournalFn?: typeof abortInflightJournal;
  releasePreCheckFn?: typeof releasePreCheck;
}

export type GrokVisionHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx,
) => Promise<void>;

function allowVision(containerKey: string, now: number): boolean {
  if (rateState.size > 4096) {
    for (const [k, s] of rateState) if (now - s.windowStart >= RATE_WINDOW_MS) rateState.delete(k);
  }
  const s = rateState.get(containerKey);
  if (!s || now - s.windowStart >= RATE_WINDOW_MS) {
    rateState.set(containerKey, { count: 1, windowStart: now });
    return true;
  }
  if (s.count >= RATE_MAX_PER_CONTAINER) return false;
  s.count += 1;
  return true;
}

export function __resetGrokVisionRateState(): void {
  rateState.clear();
}

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

/** The declared media type must be what the bytes are; the master does not
 * forward a mislabeled or non-image payload under a user's identity. */
function sniffMediaType(buf: Buffer): VisionMediaType | null {
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6) {
    const sig = buf.subarray(0, 6).toString("ascii");
    if (sig === "GIF87a" || sig === "GIF89a") return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** Selfhost runs grok-build on a single fixed upstream (the grok adapter maps it to the same id). */
function grokExecutionUpstream(canonicalModel: string, upstream: unknown): string {
  if (canonicalModel === GROK_VISION_MODEL && upstream === "grok-4.7") return upstream;
  throw new Error("GROK_VISION_UPSTREAM_INVALID: canonical/upstream mismatch");
}

export function grokVisionBody(input: {
  upstreamModel: string;
  mediaType: string;
  data: string;
  prompt: string;
}): string {
  return JSON.stringify({
    model: input.upstreamModel,
    input: [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: `data:${input.mediaType};base64,${input.data}` },
          { type: "input_text", text: input.prompt },
        ],
      },
    ],
    reasoning: { effort: "low" },
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
  });
}

/** Text of the assistant message items of a Responses API result. */
export function textFromGrokVisionResponse(json: unknown): string {
  const output = isObj(json) && Array.isArray(json.output) ? json.output : [];
  let text = "";
  for (const item of output) {
    if (!isObj(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (isObj(block) && block.type === "output_text" && typeof block.text === "string") {
        text += block.text;
      }
    }
  }
  return text.trim();
}

export interface GrokVisionUsage {
  input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/**
 * Responses API usage -> the disjoint counters the billing frame carries.
 * Upstream `input_tokens` includes cached tokens and `output_tokens` includes
 * reasoning tokens; the settle routine prices input / cache-read separately
 * and adds reasoning back onto output, so both are split here. Returns null
 * when the response carries no usable usage object: a call the master cannot
 * meter is not charged from a guess.
 */
export function usageFromGrokVisionResponse(json: unknown): GrokVisionUsage | null {
  if (!isObj(json) || !isObj(json.usage)) return null;
  const usage = json.usage;
  const count = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  if (input === null || output === null) return null;
  const cached = isObj(usage.input_tokens_details)
    ? (count(usage.input_tokens_details.cached_tokens) ?? 0)
    : 0;
  const reasoning = isObj(usage.output_tokens_details)
    ? (count(usage.output_tokens_details.reasoning_tokens) ?? 0)
    : 0;
  const cacheRead = Math.min(cached, input);
  const reasoningOut = Math.min(reasoning, output);
  return {
    input_tokens: input - cacheRead,
    output_tokens: output - reasoningOut,
    reasoning_output_tokens: reasoningOut,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: 0,
  };
}

async function defaultPickAccountId(): Promise<bigint | null> {
  const result = await query<{ id: string }>(
    `SELECT id::text AS id
       FROM claude_accounts
      WHERE provider = 'grok' AND status = 'active'
      ORDER BY last_used_at ASC NULLS FIRST
      LIMIT 1`,
  );
  const id = result.rows[0]?.id;
  return id ? BigInt(id) : null;
}

async function defaultRecordStatus(accountId: bigint, statusCode: number): Promise<void> {
  const outcome = classifyGrokRelayStatus(statusCode);
  // 5xx is the provider, not this account. Do not bump fail_count for it.
  if (outcome === "client_error" || outcome === "upstream") return;
  if (outcome === "success") {
    await query(
      `UPDATE claude_accounts
          SET success_count = success_count + 1, last_used_at = NOW(), last_error = NULL, updated_at = NOW()
        WHERE id = $1 AND provider = 'grok'`,
      [String(accountId)],
    );
    return;
  }
  await query(
    `UPDATE claude_accounts
        SET fail_count = fail_count + 1, last_used_at = NOW(), last_error = $2, updated_at = NOW()
      WHERE id = $1 AND provider = 'grok'`,
    [String(accountId), `grok_vision_http_${statusCode}`],
  );
}

export function makeGrokVisionHandler(deps: GrokVisionHandlerDeps): GrokVisionHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "grokVisionProxy" });
  const pickAccountId = deps.pickAccountId ?? defaultPickAccountId;
  const freshToken = deps.freshToken ?? ((id: bigint) => getFreshGrokAccessToken(id));
  const requestFn = deps.requestFn ?? ((url, init) => undiciRequest(url, init));
  const recordStatus = deps.recordStatus ?? defaultRecordStatus;
  const newRequestId = deps.newRequestId ?? (() => randomBytes(16).toString("hex"));
  const now = deps.now ?? Date.now;
  const runPreCheck = deps.preCheckWithCostFn ?? preCheckWithCost;
  const runStartJournal = deps.startInflightJournalFn ?? startInflightJournal;
  const runSettle = deps.settleDurableCodexBillingFn ?? settleDurableCodexBilling;
  const runAbort = deps.abortInflightJournalFn ?? abortInflightJournal;
  const runReleasePreCheck = deps.releasePreCheckFn ?? releasePreCheck;

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const reqLog = log.child({ requestId, hostUuid: ctx.hostUuid, boundIp: ctx.boundIp });

    if (req.method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "POST required", requestId);
      return;
    }

    let verified;
    try {
      verified = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization);
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        reqLog.warn("identity_failed", { errcode: err.code });
        sendError(res, 401, "UNAUTHORIZED", "container identity verification failed", requestId);
        return;
      }
      throw err;
    }
    const userId = BigInt(verified.userId);
    const containerId = BigInt(verified.containerId);

    if (!allowVision(String(verified.containerId), now())) {
      reqLog.warn("rate_limited", { containerId: String(verified.containerId) });
      sendError(res, 429, "RATE_LIMITED", "grok vision rate limit exceeded", requestId);
      return;
    }

    let image: { mediaType: VisionMediaType; data: string };
    let prompt: string;
    try {
      const raw = await readJsonBody(req, MAX_BODY_BYTES);
      const parsed = VisionRequestSchema.safeParse(raw);
      if (!parsed.success) {
        sendError(res, 400, "BAD_BODY", "invalid request body (expected {image:{mediaType,data},prompt})", requestId);
        return;
      }
      image = parsed.data.image;
      prompt = parsed.data.prompt;
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message, requestId);
        return;
      }
      throw err;
    }
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.length === 0 || bytes.length > GROK_VISION_MAX_IMAGE_BYTES) {
      sendError(res, 413, "IMAGE_TOO_LARGE", "image exceeds the vision size limit", requestId);
      return;
    }
    if (sniffMediaType(bytes) !== image.mediaType) {
      sendError(res, 400, "BAD_IMAGE", "image bytes do not match the declared media type", requestId);
      return;
    }

    // ── admit: nothing is sent upstream before the price is frozen, the user
    // is authorized for the model, credits are reserved and the journal row exists.
    let snapshot: ModelCatalogSnapshot;
    try {
      snapshot = await deps.catalog.assertFresh();
    } catch {
      sendError(res, 503, "GROK_VISION_CATALOG_UNAVAILABLE", "model catalog unavailable", requestId);
      return;
    }
    let scope;
    try {
      scope = scopeFromAuthz(userId, await deps.loadUserModelAuthz(userId, snapshot.securityEpoch));
    } catch {
      sendError(res, 503, "GROK_VISION_AUTHZ_UNAVAILABLE", "model authorization unavailable", requestId);
      return;
    }
    const canonical = snapshot.aliasToCanonical(GROK_VISION_MODEL);
    let upstreamModel: string;
    try {
      const descriptor = snapshot.resolve(canonical);
      if (!descriptor || descriptor.engine !== "grok") throw new Error("not a grok model");
      upstreamModel = grokExecutionUpstream(canonical, descriptor.upstreamModelId);
    } catch {
      sendError(res, 503, "GROK_VISION_MODEL_UNAVAILABLE", "vision model is not available", requestId);
      return;
    }
    if (!snapshot.canUseModel(scope, canonical)) {
      sendError(res, 403, "GROK_VISION_NOT_AUTHORIZED", "vision model is not available to this user", requestId);
      return;
    }
    const pricing = snapshot.billingPricingFor(canonical);
    if (!pricing) {
      sendError(res, 503, "GROK_VISION_PRICING_UNAVAILABLE", "vision model pricing unavailable", requestId);
      return;
    }

    const billingRequestId = newRequestId();
    const reservation = { userId: userId.toString(), requestId: billingRequestId };
    let precheck: Awaited<ReturnType<typeof preCheckWithCost>>;
    try {
      precheck = await runPreCheck(deps.preCheckRedis, {
        userId,
        requestId: billingRequestId,
        maxCost: estimateMaxCost(PRECHECK_TOKEN_ESTIMATE, pricing),
      });
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        sendError(res, 402, "INSUFFICIENT_CREDITS", "insufficient credits for image understanding", requestId);
        return;
      }
      throw err;
    }
    const engineSessionId = deriveEngineSessionId(`vision:${userId}:${containerId}`);
    let admitted = false;
    try {
      admitted = await runStartJournal(deps.getPool(), {
        requestId: billingRequestId,
        userId,
        containerId,
        model: canonical,
        precheckCredits: precheck.maxCost,
        ctxJson: {
          agentId: "vision",
          source: GROK_VISION_JOURNAL_SOURCE,
          billingPricing: serializeBillingPricing(pricing),
          // Nested so settle does not treat these as a bridge_signed stamp.
          catalogGeneration: {
            billingRevision: snapshot.billingRevision,
            executionRevision: snapshot.executionRevision,
            securityEpoch: snapshot.securityEpoch.toString(),
          },
          upstreamModelId: upstreamModel,
          engineSessionId,
        },
      });
    } finally {
      if (!admitted) await runReleasePreCheck(deps.preCheckRedis, reservation).catch(() => {});
    }
    if (!admitted) {
      sendError(res, 409, "GROK_VISION_JOURNAL_CONFLICT", "billing journal conflict", requestId);
      return;
    }

    const abandon = async (reason: string): Promise<void> => {
      await runAbort(deps.getPool(), billingRequestId, reason, "INTERNAL_ERROR").catch((err) => {
        // The row stays inflight; the journal reconciler times it out and
        // releases the reservation. Nothing has been charged.
        reqLog.error("grok_vision_abandon_failed", {
          billingRequestId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
      await runReleasePreCheck(deps.preCheckRedis, reservation).catch(() => {});
    };

    const startedAt = now();
    let answer: string;
    let usage: GrokVisionUsage;
    let accessToken: Buffer | null = null;
    try {
      const accountId = await pickAccountId().catch(() => null);
      if (accountId === null) {
        throw new HttpError(503, "GROK_VISION_NOT_CONFIGURED", "no active grok account");
      }
      accessToken = await freshToken(accountId);
      const upstream = await requestFn(GROK_VISION_UPSTREAM, {
        method: "POST",
        dispatcher: directEgressDispatcher(),
        headersTimeout: UPSTREAM_TIMEOUT_MS,
        bodyTimeout: UPSTREAM_TIMEOUT_MS,
        headers: {
          authorization: `Bearer ${accessToken.toString("utf8")}`,
          "content-type": "application/json",
          accept: "application/json",
          "x-xai-token-auth": "xai-grok-cli",
          "x-authenticateresponse": "authenticate-response",
          "x-grok-model-override": canonical,
          "x-grok-client-mode": "headless",
          "x-grok-client-version": "1.0.13",
          "x-grok-client-identifier": "openclaude-vision",
        },
        body: grokVisionBody({ upstreamModel, mediaType: image.mediaType, data: image.data, prompt }),
      });
      const text = await upstream.body.text();
      void recordStatus(accountId, upstream.statusCode).catch(() => {});
      if (upstream.statusCode >= 400) {
        reqLog.warn("grok_vision_upstream_status", { status: upstream.statusCode });
        throw new HttpError(502, "GROK_UPSTREAM_ERROR", "grok vision upstream rejected the request");
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new HttpError(502, "GROK_BAD_RESPONSE", "grok vision returned invalid JSON");
      }
      answer = textFromGrokVisionResponse(json);
      if (!answer) throw new HttpError(502, "GROK_BAD_RESPONSE", "grok vision returned no text");
      const metered = usageFromGrokVisionResponse(json);
      if (!metered) throw new HttpError(502, "GROK_BAD_RESPONSE", "grok vision returned no usage");
      usage = metered;
    } catch (err) {
      await abandon("grok_vision_upstream_failed");
      if (err instanceof HttpError) {
        reqLog.warn("grok_vision_failed", { code: err.code, status: err.status });
        sendError(res, err.status, err.code, err.message, requestId);
        return;
      }
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "HeadersTimeoutError" || name === "BodyTimeoutError") {
        reqLog.warn("grok_vision_timeout");
        sendError(res, 504, "GROK_UPSTREAM_TIMEOUT", "grok vision timed out", requestId);
        return;
      }
      reqLog.warn("grok_vision_upstream_error", {
        err: err instanceof Error ? err.message : String(err),
      });
      sendError(res, 502, "GROK_UPSTREAM_ERROR", "grok vision upstream unreachable", requestId);
      return;
    } finally {
      accessToken?.fill(0);
    }

    // ── settle. The answer is only returned once the charge is durably
    // recorded; an unsettled call leaves the journal inflight for the
    // reconciler (reservation released, no usage row) and returns an error.
    try {
      const outcome = await runSettle(
        { pgPool: deps.getPool(), preCheckRedis: deps.preCheckRedis, pricing: deps.pricing, logger: reqLog },
        userId,
        {
          requestId: billingRequestId,
          engineSessionId,
          status: "success",
          durationMs: Math.max(0, now() - startedAt),
          usage,
        },
      );
      if (outcome === "waived") throw new Error("settlement waived");
    } catch (err) {
      reqLog.error("grok_vision_settle_failed", {
        billingRequestId,
        err: err instanceof Error ? err.message : String(err),
      });
      sendError(res, 502, "GROK_VISION_BILLING_FAILED", "image understanding could not be billed", requestId);
      return;
    }
    sendJson(res, 200, { text: answer, model: canonical });
  };
}
