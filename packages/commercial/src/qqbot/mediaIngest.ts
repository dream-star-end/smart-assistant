import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, chown, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import {
  getMaxUploadSize,
  MediaFileType,
  sanitizeFileName,
  type InboundMessage,
} from "@tencent-connect/qqbot-nodejs";
import { isVoiceAttachment } from "@tencent-connect/qqbot-nodejs/protocol";
import { fetch as undiciFetch, type Dispatcher } from "undici";

import type { UserMediaLocation } from "../agent-sandbox/userMedia.js";
import {
  makePinnedDispatcher,
  resolvePinnedAddress,
  type DnsResolver,
} from "../connectors/outboundPolicy.js";

const CONTAINER_UPLOADS_DIR = "/home/agent/.openclaude/uploads";
const MAX_DOWNLOAD_REDIRECTS = 3;
export const QQ_MEDIA_SMALL_DOWNLOAD_TIMEOUT_MS = 120_000;
export const QQ_MEDIA_LARGE_DOWNLOAD_TIMEOUT_MS = 300_000;

export type QqInboundAttachment = NonNullable<InboundMessage["attachments"]>[number];
export type QqMediaKind = "image" | "voice" | "video" | "file";

export interface SavedQqMedia {
  kind: QqMediaKind;
  filename: string;
  originalName: string;
  containerPath: string;
  mimeType: string;
  bytes: number;
  voiceText?: string;
}

export interface SaveQqMediaResult {
  promptText: string;
  count: number;
  media: SavedQqMedia[];
}

export interface SaveQqMediaArgs {
  bindingUserId: string;
  attachments: QqInboundAttachment[];
  text?: string;
}

export interface SaveQqMediaDeps {
  ensureContainerReady: (userId: bigint) => Promise<void>;
  resolveUserMediaDirs: (userId: string) => Promise<UserMediaLocation>;
  pushRemoteHostUpload?: (args: {
    hostUuid: string;
    remotePath: string;
    content: Buffer;
  }) => Promise<void>;
  resolver?: DnsResolver;
  fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<Response>;
  makeDispatcher?: (pin: Awaited<ReturnType<typeof resolvePinnedAddress>>) => Dispatcher;
  timeoutMs?: number;
}

export function makeSaveQqMediaToUserUploads(
  deps: SaveQqMediaDeps,
): (args: SaveQqMediaArgs) => Promise<SaveQqMediaResult> {
  return (args) => saveQqMediaToUserUploads(args, deps);
}

export async function saveQqMediaToUserUploads(
  args: SaveQqMediaArgs,
  deps: SaveQqMediaDeps,
): Promise<SaveQqMediaResult> {
  const identity = canonicalCommercialUserId(args.bindingUserId);
  await deps.ensureContainerReady(identity.uid);

  const resolved = await deps.resolveUserMediaDirs(identity.mediaUserId);
  if (resolved.kind === "fail" && resolved.reason !== "remote-host") {
    throw new Error(`user media uploads unavailable: ${resolved.reason}`);
  }
  const loc = resolved as
    | Extract<UserMediaLocation, { kind: "ok" }>
    | Extract<UserMediaLocation, { reason: "remote-host" }>;
  if (loc.kind === "fail" && !deps.pushRemoteHostUpload) {
    throw new Error("remote host media push is unavailable");
  }

  const saved: SavedQqMedia[] = [];
  for (const attachment of args.attachments) {
    const source = normalizeAttachment(attachment);
    if (attachment.size !== undefined && attachment.size > source.maxBytes) {
      throw new Error(`QQ ${source.kind} exceeds size limit`);
    }
    const buffer = await downloadQqMedia(source.url, {
      maxBytes: source.maxBytes,
      label: source.kind,
      timeoutMs:
        deps.timeoutMs ??
        (source.kind === "image" || source.kind === "voice"
          ? QQ_MEDIA_SMALL_DOWNLOAD_TIMEOUT_MS
          : QQ_MEDIA_LARGE_DOWNLOAD_TIMEOUT_MS),
      resolver: deps.resolver,
      fetchImpl: deps.fetchImpl,
      makeDispatcher: deps.makeDispatcher,
    });
    saved.push(
      await writeQqMedia(
        loc,
        buffer,
        source,
        deps.pushRemoteHostUpload,
      ),
    );
  }

  if (saved.length === 0) throw new Error("no valid QQ media attachments to save");
  return {
    promptText: buildQqMediaPrompt(args.text, saved),
    count: saved.length,
    media: saved,
  };
}

interface NormalizedAttachment {
  kind: QqMediaKind;
  url: string;
  originalName: string;
  extension: string;
  mimeType: string;
  maxBytes: number;
  voiceText?: string;
}

function normalizeAttachment(attachment: QqInboundAttachment): NormalizedAttachment {
  const kind = classifyAttachment(attachment);
  const usesWav = kind === "voice" && Boolean(attachment.voice_wav_url);
  const originalName = sanitizeFileName(
    attachment.filename || defaultOriginalName(kind, usesWav),
  );
  return {
    kind,
    url: usesWav ? attachment.voice_wav_url! : attachment.url,
    originalName,
    extension: usesWav ? "wav" : safeExtension(originalName, kind, attachment.content_type),
    mimeType: usesWav ? "audio/wav" : normalizeMimeType(attachment.content_type, kind),
    maxBytes: getMaxUploadSize(mediaFileType(kind)),
    voiceText: kind === "voice" ? attachment.asr_refer_text?.trim() || undefined : undefined,
  };
}

function classifyAttachment(attachment: QqInboundAttachment): QqMediaKind {
  if (isVoiceAttachment(attachment)) return "voice";
  const mime = attachment.content_type.toLowerCase();
  if (mime.startsWith("image/") || mime === "image") return "image";
  if (mime.startsWith("video/") || mime === "video") return "video";
  return "file";
}

function mediaFileType(kind: QqMediaKind): MediaFileType {
  if (kind === "image") return MediaFileType.IMAGE;
  if (kind === "voice") return MediaFileType.VOICE;
  if (kind === "video") return MediaFileType.VIDEO;
  return MediaFileType.FILE;
}

function defaultOriginalName(kind: QqMediaKind, usesWav: boolean): string {
  if (usesWav) return "QQ语音.wav";
  if (kind === "image") return "QQ图片";
  if (kind === "voice") return "QQ语音.silk";
  if (kind === "video") return "QQ视频";
  return "QQ附件";
}

function safeExtension(name: string, kind: QqMediaKind, contentType: string): string {
  const raw = extname(name).slice(1).toLowerCase();
  if (/^[a-z0-9]{1,10}$/.test(raw)) return raw;
  const mime = contentType.toLowerCase();
  const known = MIME_EXTENSIONS[mime];
  if (known) return known;
  if (kind === "image") return "jpg";
  if (kind === "voice") return "silk";
  if (kind === "video") return "mp4";
  return "bin";
}

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/zip": "zip",
};

function normalizeMimeType(contentType: string, kind: QqMediaKind): string {
  const mime = contentType.trim().toLowerCase();
  if (mime.includes("/")) return mime;
  if (kind === "image") return "image/jpeg";
  if (kind === "voice") return "audio/silk";
  if (kind === "video") return "video/mp4";
  return "application/octet-stream";
}

interface DownloadQqMediaArgs {
  maxBytes: number;
  label: QqMediaKind;
  timeoutMs: number;
  resolver?: DnsResolver;
  fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<Response>;
  makeDispatcher?: SaveQqMediaDeps["makeDispatcher"];
}

export async function downloadQqMedia(
  input: string,
  args: DownloadQqMediaArgs,
): Promise<Buffer> {
  let current = assertAllowedQqMediaUrl(input);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`QQ ${args.label} download timed out`)),
    args.timeoutMs,
  );
  const cancelResolver = () => {
    try {
      args.resolver?.cancel?.();
    } catch {
      // Cancellation must not replace the original timeout.
    }
  };
  controller.signal.addEventListener("abort", cancelResolver);

  try {
    for (let redirects = 0; redirects <= MAX_DOWNLOAD_REDIRECTS; redirects++) {
      const pin = await raceAbort(
        resolvePinnedAddress(current.hostname, args.resolver),
        controller.signal,
      );
      const dispatcher = (args.makeDispatcher ?? makePinnedDispatcher)(pin);
      try {
        const fetchImpl =
          args.fetchImpl ??
          ((url: string, init: Record<string, unknown>) =>
            undiciFetch(url, init as never) as unknown as Promise<Response>);
        const response = await raceAbort(
          fetchImpl(current.toString(), {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            dispatcher,
          }),
          controller.signal,
        );
        if (isRedirectStatus(response.status)) {
          await response.body?.cancel().catch(() => {});
          if (redirects >= MAX_DOWNLOAD_REDIRECTS) {
            throw new Error("QQ media download redirected too many times");
          }
          const location = response.headers.get("location");
          if (!location) throw new Error("QQ media redirect missing Location");
          current = assertAllowedQqMediaUrl(new URL(location, current).toString());
          continue;
        }
        if (!response.ok) {
          throw new Error(`QQ ${args.label} download failed: HTTP ${response.status}`);
        }
        const contentLength = response.headers.get("content-length");
        if (contentLength) {
          const bytes = Number(contentLength);
          if (!Number.isFinite(bytes) || bytes < 0 || bytes > args.maxBytes) {
            throw new Error(`QQ ${args.label} exceeds size limit`);
          }
        }
        return await readResponseBodyCapped(
          response,
          args.maxBytes,
          args.label,
          controller.signal,
        );
      } finally {
        await closeDispatcher(dispatcher, controller.signal.aborted);
      }
    }
    throw new Error("QQ media download redirected too many times");
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`QQ ${args.label} download timed out`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", cancelResolver);
  }
}

export function assertAllowedQqMediaUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.startsWith("//") ? `https:${input}` : input);
  } catch {
    throw new Error("invalid QQ media URL");
  }
  if (url.protocol !== "https:") throw new Error("QQ media URL must use https");
  if (url.username || url.password) throw new Error("QQ media URL must not contain userinfo");
  if (url.hash) throw new Error("QQ media URL must not contain a fragment");
  return url;
}

async function readResponseBodyCapped(
  response: Response,
  maxBytes: number,
  label: QqMediaKind,
  signal: AbortSignal,
): Promise<Buffer> {
  const body = response.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`QQ ${label} exceeds size limit`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } catch (err) {
    void reader.cancel(err).catch(() => {});
    throw err;
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function closeDispatcher(dispatcher: Dispatcher, aborted: boolean): Promise<void> {
  if (aborted && typeof dispatcher.destroy === "function") {
    await dispatcher.destroy().catch(() => {});
    return;
  }
  await dispatcher.close().catch(() => {});
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function writeQqMedia(
  loc:
    | Extract<UserMediaLocation, { kind: "ok" }>
    | Extract<UserMediaLocation, { reason: "remote-host" }>,
  buffer: Buffer,
  source: NormalizedAttachment,
  pushRemoteHostUpload: SaveQqMediaDeps["pushRemoteHostUpload"],
): Promise<SavedQqMedia> {
  const digest = createHash("sha256").update(buffer).digest("hex").slice(0, 32);
  const filename = `qq-${source.kind}-${digest}.${source.extension}`;
  const containerPath = `${CONTAINER_UPLOADS_DIR}/${filename}`;
  const hostPath = join(loc.uploads, filename);

  if (loc.kind === "fail") {
    await pushRemoteHostUpload!({
      hostUuid: loc.hostUuid,
      remotePath: hostPath,
      content: buffer,
    });
  } else if (!existsSync(hostPath)) {
    await mkdir(loc.uploads, { recursive: true, mode: 0o755 });
    const tmp = join(loc.uploads, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    await writeFile(tmp, buffer, { mode: 0o644 });
    await chmod(tmp, 0o644).catch(() => {});
    await chown(tmp, 1000, 1000).catch(() => {});
    try {
      await rename(tmp, hostPath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  return {
    kind: source.kind,
    filename,
    originalName: source.originalName,
    containerPath,
    mimeType: source.mimeType,
    bytes: buffer.length,
    voiceText: source.voiceText,
  };
}

function buildQqMediaPrompt(text: string | undefined, media: SavedQqMedia[]): string {
  const userText = text?.trim() || defaultMediaUserText(media);
  const lines = [userText, "", "---", "用户通过 QQ 发送了以下附件（已保存到当前容器本地）:"];
  for (const item of media) {
    lines.push(
      `- ${mediaKindLabel(item.kind)}: \`${item.containerPath}\` (${item.mimeType}, ${formatBytes(item.bytes)}, 原名: ${promptSafeName(item.originalName)})`,
    );
    if (item.kind === "voice" && item.voiceText) {
      lines.push(`  - QQ 语音转写: ${item.voiceText}`);
    }
  }
  if (media.some((item) => item.kind === "image")) {
    lines.push(
      "",
      '图片如果你看不到内容，先用 Bash 调 `oc-vision understand <图片本地路径> --prompt "<问题>"` 命令识图，再基于返回内容回答。不要说用户没有上传图片。',
    );
  }
  if (media.some((item) => item.kind !== "image")) {
    lines.push(
      "",
      "对于文件、视频或音频/语音，请优先基于上述本地路径进行读取、检查或转写；如果当前模型/工具无法直接解析某种媒体，请明确告诉用户已收到该附件并说明可行的下一步，而不是说没有收到附件。",
    );
  }
  return lines.join("\n");
}

function defaultMediaUserText(media: SavedQqMedia[]): string {
  const labels = Array.from(new Set(media.map((item) => mediaKindLabel(item.kind)))).join("/");
  return `请处理我刚通过 QQ 发送的${labels || "附件"}。`;
}

function mediaKindLabel(kind: QqMediaKind): string {
  if (kind === "image") return "图片";
  if (kind === "voice") return "语音";
  if (kind === "video") return "视频";
  return "文件";
}

function promptSafeName(name: string): string {
  return name.replaceAll("`", "'");
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function canonicalCommercialUserId(input: string): { uid: bigint; mediaUserId: string } {
  const raw = input.trim().replace(/^c:/, "");
  if (!/^[1-9][0-9]{0,18}$/.test(raw)) {
    throw new Error("invalid binding user id for QQ media upload");
  }
  return { uid: BigInt(raw), mediaUserId: `c:${raw}` };
}
