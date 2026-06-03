import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { z } from "zod";

import { rootLogger, type Logger } from "../logging/logger.js";
import {
  REQUEST_ID_HEADER,
  ensureRequestId,
  setSecurityHeaders,
  readJsonBody,
  sendError,
  sendJson,
  HttpError,
} from "../http/util.js";
import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from "../auth/containerIdentity.js";
import {
  calculateMiniMaxImageCost,
  calculateMiniMaxLyricsCost,
  calculateMiniMaxMusicCost,
  calculateMiniMaxSpeechCost,
  calculateMiniMaxVideoCost,
  type MiniMaxMediaCostResult,
} from "./mediaPricing.js";
import { settleMiniMaxMediaSuccess } from "./mediaBilling.js";

export const MINIMAX_MEDIA_PATH = "/internal/v3/minimax";

const API_BASE = "https://api.minimaxi.com";
const UPSTREAM_TIMEOUT_MS = 300_000;
const DOWNLOAD_TIMEOUT_MS = 600_000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

const allowedDownloadHostSuffixes = [
  "minimax.chat",
  "minimaxi.com",
  "minimax.io",
  "hailuoai.com",
  // MiniMax Hailuo video files currently come back from a public Alibaba OSS
  // bucket, e.g. public-cdn-video-data-algeng.oss-cn-wulanchabu.aliyuncs.com.
  // Keep this scoped to the observed OSS region instead of allowing all
  // aliyuncs.com hosts.
  "oss-cn-wulanchabu.aliyuncs.com",
];

const OutputFormatSchema = z.enum(["mp3", "wav", "flac", "pcm"]).default("mp3");

const ImagePayloadSchema = z.object({
  model: z.enum(["image-01", "image-01-live"]).default("image-01"),
  prompt: z.string().min(1).max(4000),
  aspect_ratio: z.string().min(1).max(32).optional(),
  n: z.number().int().min(1).max(8).optional(),
  subject_reference: z.unknown().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
}).strict();

const SpeechPayloadSchema = z.object({
  model: z.enum(["speech-2.8-turbo", "speech-2.8-hd"]).default("speech-2.8-turbo"),
  text: z.string().min(1).max(10_000),
  voice_id: z.string().min(1).max(128).default("male-qn-qingse"),
  format: OutputFormatSchema,
  extra: z.record(z.string(), z.unknown()).optional(),
}).strict();

const MusicPayloadSchema = z.object({
  model: z.enum(["music-2.6", "music-cover"]).default("music-2.6"),
  prompt: z.string().max(2000).optional(),
  lyrics: z.string().max(3500).optional(),
  is_instrumental: z.boolean().optional(),
  lyrics_optimizer: z.boolean().optional(),
  format: OutputFormatSchema.default("mp3"),
  extra: z.record(z.string(), z.unknown()).optional(),
}).strict();

const LyricsPayloadSchema = z.object({
  mode: z.string().min(1).max(64).default("write_full_song"),
  prompt: z.string().min(1).max(2000),
  extra: z.record(z.string(), z.unknown()).optional(),
}).strict();

const VideoGeneratePayloadSchema = z.object({
  model: z.enum(["MiniMax-Hailuo-2.3", "MiniMax-Hailuo-2.3-Fast", "MiniMax-Hailuo-02"]).default("MiniMax-Hailuo-2.3"),
  prompt: z.string().min(1).max(2000),
  duration: z.union([z.literal(6), z.literal(10)]).default(6),
  resolution: z.enum(["512P", "768P", "1080P"]).default("768P"),
  first_frame_image: z.string().url().max(2048).optional(),
  last_frame_image: z.string().url().max(2048).optional(),
  subject_reference: z.unknown().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
}).strict();

const VideoQueryPayloadSchema = z.object({
  task_id: z.string().min(1).max(128),
}).strict();

const VideoDownloadPayloadSchema = z.object({
  file_id: z.union([z.string().min(1).max(128), z.number().int().positive()]),
}).strict();

const RequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("image"), payload: ImagePayloadSchema }).strict(),
  z.object({ kind: z.literal("speech"), payload: SpeechPayloadSchema }).strict(),
  z.object({ kind: z.literal("music"), payload: MusicPayloadSchema }).strict(),
  z.object({ kind: z.literal("lyrics"), payload: LyricsPayloadSchema }).strict(),
  z.object({ kind: z.literal("video_generate"), payload: VideoGeneratePayloadSchema }).strict(),
  z.object({ kind: z.literal("video_query"), payload: VideoQueryPayloadSchema }).strict(),
  z.object({ kind: z.literal("video_download"), payload: VideoDownloadPayloadSchema }).strict(),
]);

type MiniMaxRequest = z.infer<typeof RequestSchema>;

type HandlerCtx = { hostUuid: string; boundIp: string };

export interface MiniMaxMediaHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  pgPool: Pool;
  tokenPlanKey?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export type MiniMaxMediaHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandlerCtx,
) => Promise<void>;

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function baseRespOk(json: unknown): boolean {
  if (!isObj(json)) return true;
  const br = json.base_resp;
  if (!isObj(br)) return true;
  const code = br.status_code;
  return code === undefined || code === 0;
}

function baseRespMessage(json: unknown): string {
  if (!isObj(json)) return "upstream error";
  const br = json.base_resp;
  if (isObj(br) && typeof br.status_msg === "string") return br.status_msg.slice(0, 200);
  return "upstream error";
}

function traceId(json: unknown): string | null {
  return isObj(json) && typeof json.trace_id === "string" ? json.trace_id : null;
}

async function readUpstreamJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, "MINIMAX_BAD_RESPONSE", "minimax returned invalid JSON");
  }
}

async function postJson(fetchFn: typeof fetch, token: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetchFn(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const json = await readUpstreamJson(res);
  if (!res.ok || !baseRespOk(json)) {
    throw new HttpError(502, "MINIMAX_UPSTREAM_ERROR", baseRespMessage(json));
  }
  return json;
}

async function getJson(fetchFn: typeof fetch, token: string, path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetchFn(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const json = await readUpstreamJson(res);
  if (!res.ok || !baseRespOk(json)) {
    throw new HttpError(502, "MINIMAX_UPSTREAM_ERROR", baseRespMessage(json));
  }
  return json;
}

function hexToBase64(hex: string): string {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new HttpError(502, "MINIMAX_BAD_RESPONSE", "minimax returned invalid hex audio");
  }
  return Buffer.from(hex, "hex").toString("base64");
}

class MiniMaxDownloadUrlError extends HttpError {
  readonly downloadHost?: string;

  constructor(message: string, downloadHost?: string) {
    super(502, "MINIMAX_BAD_DOWNLOAD_URL", message);
    this.name = "MiniMaxDownloadUrlError";
    this.downloadHost = downloadHost;
  }
}

function normalizeDownloadHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

export function isAllowedMiniMaxDownloadHost(hostname: string): boolean {
  const host = normalizeDownloadHost(hostname);
  if (!host) return false;
  return allowedDownloadHostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function ensureAllowedDownloadUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new MiniMaxDownloadUrlError("minimax returned non-HTTPS download URL", normalizeDownloadHost(url.hostname));
  }
  const host = normalizeDownloadHost(url.hostname);
  if (!isAllowedMiniMaxDownloadHost(host)) {
    throw new MiniMaxDownloadUrlError("minimax returned unexpected download host", host);
  }
  return url;
}

export const __internal_minimaxDownloadUrl = { ensureAllowedDownloadUrl };

async function downloadFile(fetchFn: typeof fetch, rawUrl: string): Promise<{ base64: string; contentType: string; bytes: number }> {
  const url = ensureAllowedDownloadUrl(rawUrl);
  const res = await fetchFn(url, { method: "GET", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) {
    throw new HttpError(502, "MINIMAX_DOWNLOAD_FAILED", "failed to download minimax file");
  }
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) {
        throw new HttpError(413, "MINIMAX_FILE_TOO_LARGE", "minimax file exceeds download limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { base64: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("base64"), contentType, bytes: total };
}

async function settle(
  deps: MiniMaxMediaHandlerDeps,
  args: {
    identity: { userId: bigint; containerId: bigint | null };
    requestId: string;
    cost: MiniMaxMediaCostResult;
    upstream: { traceId?: string | null; taskId?: string | null; fileId?: string | null };
    outputMeta?: Record<string, unknown>;
  },
) {
  return await settleMiniMaxMediaSuccess(deps.pgPool, {
    userId: args.identity.userId,
    containerId: args.identity.containerId,
    requestId: args.requestId,
    cost: args.cost,
    upstreamTraceId: args.upstream.traceId ?? null,
    upstreamTaskId: args.upstream.taskId ?? null,
    upstreamFileId: args.upstream.fileId ?? null,
    outputMeta: args.outputMeta ?? {},
  });
}

function costPayload(settled: Awaited<ReturnType<typeof settleMiniMaxMediaSuccess>>) {
  return {
    cost_credits: settled.costCredits.toString(),
    debited_credits: settled.debitedCredits === null ? null : settled.debitedCredits.toString(),
    balance_after: settled.balanceAfter === null ? null : settled.balanceAfter.toString(),
    clamped: settled.clamped,
    replayed: settled.replayed,
    ledger_id: settled.ledgerId === null ? null : settled.ledgerId.toString(),
    usage_id: settled.usageId.toString(),
  };
}

async function ensureSufficientBalance(
  deps: MiniMaxMediaHandlerDeps,
  identity: { userId: bigint },
  cost: MiniMaxMediaCostResult,
): Promise<void> {
  if (cost.costCredits <= 0n) return;
  const out = await deps.pgPool.query<{ credits: string }>(
    "SELECT credits::text AS credits FROM users WHERE id=$1",
    [identity.userId.toString()],
  );
  const balance = out.rowCount === 0 ? 0n : BigInt(out.rows[0]!.credits);
  // Media calls have a known planned cost before the upstream request, unlike
  // streaming LLM calls whose final cost is only known after SSE completes. Hard
  // reject insufficient balance here so a 1-credit account cannot submit a
  // high-priced video/music job and rely on settle() clamping after delivery.
  if (balance < cost.costCredits) {
    throw new HttpError(
      402,
      "INSUFFICIENT_CREDITS",
      `insufficient credits: balance=${balance} required=${cost.costCredits}`,
    );
  }
}

export function makeMiniMaxMediaHandler(deps: MiniMaxMediaHandlerDeps): MiniMaxMediaHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "minimaxMediaProxy" });
  const fetchFn = deps.fetchImpl ?? fetch;

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const reqLog = log.child({ requestId, hostUuid: ctx.hostUuid, boundIp: ctx.boundIp });

    if (req.method !== "POST") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "POST required", requestId);
      return;
    }
    if (!deps.tokenPlanKey) {
      reqLog.warn("minimax_not_configured");
      sendError(res, 503, "MINIMAX_NOT_CONFIGURED", "minimax upstream not configured", requestId);
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
    const identity = {
      userId: BigInt(verified.userId),
      containerId: BigInt(verified.containerId),
    };

    let parsed: MiniMaxRequest;
    try {
      const raw = await readJsonBody(req);
      const r = RequestSchema.safeParse(raw);
      if (!r.success) {
        sendError(
          res,
          400,
          "BAD_BODY",
          "invalid request body",
          requestId,
          r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        );
        return;
      }
      parsed = r.data;
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message, requestId);
        return;
      }
      throw err;
    }

    try {
      switch (parsed.kind) {
        case "image": {
          const p = parsed.payload;
          const plannedCost = calculateMiniMaxImageCost({ model: p.model, imageCount: p.n ?? 1 });
          await ensureSufficientBalance(deps, identity, plannedCost);
          const upstreamPayload = {
            model: p.model,
            prompt: p.prompt,
            response_format: "base64",
            ...(p.aspect_ratio ? { aspect_ratio: p.aspect_ratio } : {}),
            ...(p.n ? { n: p.n } : {}),
            ...(p.subject_reference ? { subject_reference: p.subject_reference } : {}),
            ...(p.extra ?? {}),
          };
          const json = await postJson(fetchFn, deps.tokenPlanKey, "/v1/image_generation", upstreamPayload);
          const images = isObj(json) && isObj(json.data) && Array.isArray(json.data.image_base64)
            ? json.data.image_base64.filter((x): x is string => typeof x === "string")
            : [];
          if (images.length === 0) throw new HttpError(502, "MINIMAX_BAD_RESPONSE", "minimax returned no image");
          const cost = calculateMiniMaxImageCost({ model: p.model, imageCount: images.length });
          const settled = await settle(deps, {
            identity,
            requestId,
            cost,
            upstream: { traceId: traceId(json) },
            outputMeta: { image_count: images.length },
          });
          sendJson(res, 200, {
            kind: "image",
            files: images.map((base64, i) => ({ filename: `minimax-image-${i + 1}.jpeg`, mime: "image/jpeg", base64 })),
            billing: costPayload(settled),
          });
          return;
        }
        case "speech": {
          const p = parsed.payload;
          const plannedCost = calculateMiniMaxSpeechCost({ model: p.model, text: p.text });
          await ensureSufficientBalance(deps, identity, plannedCost);
          const upstreamPayload = {
            model: p.model,
            text: p.text,
            stream: false,
            voice_setting: { voice_id: p.voice_id, speed: 1, vol: 1, pitch: 0 },
            audio_setting: { sample_rate: 32000, bitrate: 128000, format: p.format, channel: 1 },
            subtitle_enable: false,
            ...(p.extra ?? {}),
          };
          const json = await postJson(fetchFn, deps.tokenPlanKey, "/v1/t2a_v2", upstreamPayload);
          const audioHex = isObj(json) && isObj(json.data) && typeof json.data.audio === "string" ? json.data.audio : null;
          if (!audioHex) throw new HttpError(502, "MINIMAX_BAD_RESPONSE", "minimax returned no audio");
          const usageCharacters = isObj(json) && isObj(json.extra_info) && typeof json.extra_info.usage_characters === "number"
            ? json.extra_info.usage_characters
            : undefined;
          const cost = calculateMiniMaxSpeechCost({ model: p.model, text: p.text, usageCharacters });
          const base64 = hexToBase64(audioHex);
          const settled = await settle(deps, {
            identity,
            requestId,
            cost,
            upstream: { traceId: traceId(json) },
            outputMeta: { format: p.format, usage_characters: usageCharacters ?? null },
          });
          sendJson(res, 200, {
            kind: "speech",
            files: [{ filename: `minimax-speech.${p.format}`, mime: `audio/${p.format}`, base64 }],
            billing: costPayload(settled),
          });
          return;
        }
        case "music": {
          const p = parsed.payload;
          const cost = calculateMiniMaxMusicCost({ model: p.model });
          await ensureSufficientBalance(deps, identity, cost);
          const upstreamPayload = {
            model: p.model,
            ...(p.prompt ? { prompt: p.prompt } : {}),
            ...(p.lyrics ? { lyrics: p.lyrics } : {}),
            ...(p.is_instrumental !== undefined ? { is_instrumental: p.is_instrumental } : {}),
            ...(p.lyrics_optimizer !== undefined ? { lyrics_optimizer: p.lyrics_optimizer } : {}),
            audio_setting: { sample_rate: 44100, bitrate: 256000, format: p.format },
            ...(p.extra ?? {}),
          };
          const json = await postJson(fetchFn, deps.tokenPlanKey, "/v1/music_generation", upstreamPayload);
          const audioHex = isObj(json) && isObj(json.data) && typeof json.data.audio === "string" ? json.data.audio : null;
          if (!audioHex) throw new HttpError(502, "MINIMAX_BAD_RESPONSE", "minimax returned no music audio");
          const settled = await settle(deps, {
            identity,
            requestId,
            cost,
            upstream: { traceId: traceId(json) },
            outputMeta: { format: p.format },
          });
          sendJson(res, 200, {
            kind: "music",
            files: [{ filename: `minimax-music.${p.format}`, mime: `audio/${p.format}`, base64: hexToBase64(audioHex) }],
            billing: costPayload(settled),
          });
          return;
        }
        case "lyrics": {
          const p = parsed.payload;
          const cost = calculateMiniMaxLyricsCost();
          await ensureSufficientBalance(deps, identity, cost);
          const json = await postJson(fetchFn, deps.tokenPlanKey, "/v1/lyrics_generation", {
            mode: p.mode,
            prompt: p.prompt,
            ...(p.extra ?? {}),
          });
          const text = isObj(json) && typeof json.lyrics === "string" ? json.lyrics : JSON.stringify(json, null, 2);
          const settled = await settle(deps, {
            identity,
            requestId,
            cost,
            upstream: { traceId: traceId(json) },
            outputMeta: { bytes: Buffer.byteLength(text, "utf8") },
          });
          sendJson(res, 200, {
            kind: "lyrics",
            text,
            raw: json,
            files: [{ filename: "minimax-lyrics.txt", mime: "text/plain; charset=utf-8", base64: Buffer.from(text, "utf8").toString("base64") }],
            billing: costPayload(settled),
          });
          return;
        }
        case "video_generate": {
          const p = parsed.payload;
          const isImageMode = Boolean(p.first_frame_image || p.last_frame_image || p.subject_reference);
          const cost = calculateMiniMaxVideoCost({
            model: p.model,
            mode: isImageMode ? "image" : "text",
            resolution: p.resolution,
            duration: p.duration,
          });
          await ensureSufficientBalance(deps, identity, cost);
          const upstreamPayload = {
            model: p.model,
            prompt: p.prompt,
            duration: p.duration,
            resolution: p.resolution,
            ...(p.first_frame_image ? { first_frame_image: p.first_frame_image } : {}),
            ...(p.last_frame_image ? { last_frame_image: p.last_frame_image } : {}),
            ...(p.subject_reference ? { subject_reference: p.subject_reference } : {}),
            ...(p.extra ?? {}),
          };
          const json = await postJson(fetchFn, deps.tokenPlanKey, "/v1/video_generation", upstreamPayload);
          const taskId = isObj(json) && typeof json.task_id === "string" ? json.task_id : null;
          if (!taskId) throw new HttpError(502, "MINIMAX_BAD_RESPONSE", "minimax returned no task_id");
          const settled = await settle(deps, {
            identity,
            requestId,
            cost,
            upstream: { traceId: traceId(json), taskId },
            outputMeta: { resolution: p.resolution, duration: p.duration, image_mode: isImageMode },
          });
          sendJson(res, 200, { kind: "video_generate", task_id: taskId, raw: json, billing: costPayload(settled) });
          return;
        }
        case "video_query": {
          const json = await getJson(fetchFn, deps.tokenPlanKey, "/v1/query/video_generation", { task_id: parsed.payload.task_id });
          sendJson(res, 200, { kind: "video_query", raw: json });
          return;
        }
        case "video_download": {
          const fileId = String(parsed.payload.file_id);
          const meta = await getJson(fetchFn, deps.tokenPlanKey, "/v1/files/retrieve", { file_id: fileId });
          const downloadUrl = isObj(meta) && isObj(meta.file) && typeof meta.file.download_url === "string"
            ? meta.file.download_url
            : null;
          if (!downloadUrl) throw new HttpError(502, "MINIMAX_BAD_RESPONSE", "minimax returned no download_url");
          const file = await downloadFile(fetchFn, downloadUrl);
          sendJson(res, 200, {
            kind: "video_download",
            file: { filename: "minimax-video.mp4", mime: file.contentType, base64: file.base64, bytes: file.bytes },
            raw: meta,
          });
          return;
        }
      }
    } catch (err) {
      if (err instanceof HttpError) {
        reqLog.warn("minimax_request_failed", {
          code: err.code,
          status: err.status,
          ...(err instanceof MiniMaxDownloadUrlError && err.downloadHost ? { downloadHost: err.downloadHost } : {}),
        });
        sendError(res, err.status, err.code, err.message, requestId);
        return;
      }
      reqLog.error("minimax_request_threw", { err: err instanceof Error ? err.message : String(err) });
      sendError(res, 500, "INTERNAL", "internal error", requestId);
      return;
    }
  };
}
