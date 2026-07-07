import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, chown, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  decryptIlinkImageBuffer,
  WECHAT_IMAGE_MAX_ATTACHMENTS,
  WECHAT_IMAGE_MAX_BYTES,
  type DecryptedWechatImage,
  type WechatImageAttachment,
} from "../../../channels/wechat/src/iLinkImage.js";
import {
  decryptIlinkMediaBuffer,
  WECHAT_MEDIA_MAX_ATTACHMENTS,
  WECHAT_MEDIA_MAX_BYTES,
  sanitizeWechatFilename,
  type DecryptedWechatMedia,
  type WechatMediaAttachment,
} from "../../../channels/wechat/src/iLinkMedia.js";
import type { UserMediaLocation } from "../agent-sandbox/userMedia.js";

const CONTAINER_UPLOADS_DIR = "/home/agent/.openclaude/uploads";
export const WECHAT_MEDIA_DOWNLOAD_MIN_TIMEOUT_MS = 60_000;
export const WECHAT_MEDIA_DOWNLOAD_MAX_TIMEOUT_MS = 10 * 60_000;
const WECHAT_MEDIA_DOWNLOAD_BASELINE_MS = 60_000;
const WECHAT_MEDIA_DOWNLOAD_FLOOR_BYTES_PER_SECOND = 192 * 1024;
const MAX_DOWNLOAD_REDIRECTS = 3;
const ALLOWED_WECHAT_MEDIA_HOSTS = [
  "cdn.weixin.qq.com",
  ".cdn.weixin.qq.com",
  "novac2c.cdn.weixin.qq.com",
  ".novac2c.cdn.weixin.qq.com",
  "weixin.qq.com",
  ".weixin.qq.com",
  "ilinkai.weixin.qq.com",
  ".ilinkai.weixin.qq.com",
];

export interface SavedWechatImage {
  filename: string;
  containerPath: string;
  mimeType: string;
  bytes: number;
}

export interface SavedWechatMedia extends SavedWechatImage {
  kind: WechatMediaAttachment["kind"];
  originalName: string;
  voiceText?: string;
}

export interface SaveWechatImagesResult {
  promptText: string;
  count: number;
  images: SavedWechatImage[];
}

export interface SaveWechatMediaResult {
  promptText: string;
  count: number;
  media: SavedWechatMedia[];
}

export interface SaveWechatImagesDeps {
  resolveUserMediaDirs: (userId: string) => Promise<UserMediaLocation>;
  pushRemoteHostUpload?: (args: {
    hostUuid: string;
    remotePath: string;
    content: Buffer;
  }) => Promise<void>;
  fetchFn?: typeof fetch;
}

export interface SaveWechatImagesArgs {
  bindingUserId: string;
  images: WechatImageAttachment[];
  text?: string;
}

export interface SaveWechatMediaArgs {
  bindingUserId: string;
  media: WechatMediaAttachment[];
  text?: string;
}

export function makeSaveWechatImagesToUserUploads(
  deps: SaveWechatImagesDeps,
): (args: SaveWechatImagesArgs) => Promise<SaveWechatImagesResult> {
  return (args) => saveWechatImagesToUserUploads(args, deps);
}

export function makeSaveWechatMediaToUserUploads(
  deps: SaveWechatImagesDeps,
): (args: SaveWechatMediaArgs) => Promise<SaveWechatMediaResult> {
  return (args) => saveWechatMediaToUserUploads(args, deps);
}

export async function saveWechatImagesToUserUploads(
  args: SaveWechatImagesArgs,
  deps: SaveWechatImagesDeps,
): Promise<SaveWechatImagesResult> {
  const userId = canonicalCommercialUserId(args.bindingUserId);
  const resolved = await deps.resolveUserMediaDirs(userId);
  if (resolved.kind === "fail" && resolved.reason !== "remote-host") {
    throw new Error(`user media uploads unavailable: ${resolved.reason}`);
  }
  const loc = resolved as
    | Extract<UserMediaLocation, { kind: "ok" }>
    | Extract<UserMediaLocation, { reason: "remote-host" }>;
  if (loc.kind === "fail" && !deps.pushRemoteHostUpload) {
    throw new Error("remote host media push is unavailable");
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const images = args.images.slice(0, WECHAT_IMAGE_MAX_ATTACHMENTS);
  const saved: SavedWechatImage[] = [];
  for (const image of images) {
    const encrypted = await downloadWechatImageEncrypted(image.fullUrl, fetchFn);
    const decrypted = decryptIlinkImageBuffer(encrypted, image.aesKeyHex);
    saved.push(await writeWechatImage(loc, decrypted, deps.pushRemoteHostUpload));
  }
  if (saved.length === 0) throw new Error("no valid WeChat image attachments to save");
  return { promptText: buildWechatImagePrompt(args.text, saved), count: saved.length, images: saved };
}

export async function saveWechatMediaToUserUploads(
  args: SaveWechatMediaArgs,
  deps: SaveWechatImagesDeps,
): Promise<SaveWechatMediaResult> {
  const userId = canonicalCommercialUserId(args.bindingUserId);
  const resolved = await deps.resolveUserMediaDirs(userId);
  if (resolved.kind === "fail" && resolved.reason !== "remote-host") {
    throw new Error(`user media uploads unavailable: ${resolved.reason}`);
  }
  const loc = resolved as
    | Extract<UserMediaLocation, { kind: "ok" }>
    | Extract<UserMediaLocation, { reason: "remote-host" }>;
  if (loc.kind === "fail" && !deps.pushRemoteHostUpload) {
    throw new Error("remote host media push is unavailable");
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const media = args.media.slice(0, WECHAT_MEDIA_MAX_ATTACHMENTS);
  const saved: SavedWechatMedia[] = [];
  for (const item of media) {
    const encrypted = await downloadWechatMediaEncrypted(
      item.fullUrl,
      fetchFn,
      WECHAT_MEDIA_MAX_BYTES,
      "media",
      computeWechatMediaDownloadTimeoutMs(item.size, WECHAT_MEDIA_MAX_BYTES),
    );
    const decrypted = decryptIlinkMediaBuffer(encrypted, item.aesKeyHex, item);
    saved.push(await writeWechatMedia(loc, decrypted, item, deps.pushRemoteHostUpload));
  }
  if (saved.length === 0) throw new Error("no valid WeChat media attachments to save");
  return { promptText: buildWechatMediaPrompt(args.text, saved), count: saved.length, media: saved };
}

function canonicalCommercialUserId(input: string): string {
  const s = input.trim();
  if (/^c:[1-9][0-9]{0,18}$/.test(s)) return s;
  if (/^[1-9][0-9]{0,18}$/.test(s)) return `c:${s}`;
  throw new Error("invalid binding user id for WeChat image upload");
}

export function assertAllowedWechatImageUrl(input: string): string {
  return assertAllowedWechatMediaUrl(input);
}

export function assertAllowedWechatMediaUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("invalid WeChat media URL");
  }
  if (url.protocol !== "https:") throw new Error("WeChat media URL must use https");
  const host = url.hostname.toLowerCase();
  const ok = ALLOWED_WECHAT_MEDIA_HOSTS.some((allowed) => {
    if (allowed.startsWith(".")) return host.endsWith(allowed);
    return host === allowed;
  });
  if (!ok) throw new Error("WeChat media URL host is not allowed");
  url.username = "";
  url.password = "";
  return url.toString();
}

export async function downloadWechatImageEncrypted(
  fullUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<Buffer> {
  return downloadWechatMediaEncrypted(fullUrl, fetchFn, WECHAT_IMAGE_MAX_BYTES, "image");
}

export async function downloadWechatMediaEncrypted(
  fullUrl: string,
  fetchFn: typeof fetch = fetch,
  maxBytes = WECHAT_MEDIA_MAX_BYTES,
  label = "media",
  timeoutMs = computeWechatMediaDownloadTimeoutMs(undefined, maxBytes),
): Promise<Buffer> {
  let currentUrl = assertAllowedWechatMediaUrl(fullUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirects = 0; redirects <= MAX_DOWNLOAD_REDIRECTS; redirects++) {
      const res = await fetchFn(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
      if (isRedirectStatus(res.status)) {
        if (redirects >= MAX_DOWNLOAD_REDIRECTS) {
          throw new Error("WeChat image download redirected too many times");
        }
        const location = res.headers.get("location");
        if (!location) throw new Error("WeChat image redirect missing Location");
        currentUrl = assertAllowedWechatMediaUrl(new URL(location, currentUrl).toString());
        continue;
      }
      assertAllowedWechatMediaUrl(res.url || currentUrl);
      if (!res.ok) throw new Error(`WeChat ${label} download failed: HTTP ${res.status}`);
      const contentLength = res.headers.get("content-length");
      if (contentLength) {
        const n = Number(contentLength);
        if (!Number.isFinite(n) || n < 0 || n > maxBytes) {
          throw new Error(`WeChat ${label} exceeds size limit`);
        }
      }
      return await readResponseBodyCapped(res, maxBytes, label);
    }
    throw new Error(`WeChat ${label} download redirected too many times`);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`WeChat ${label} download timed out`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function computeWechatMediaDownloadTimeoutMs(
  expectedBytes: number | undefined,
  maxBytes = WECHAT_MEDIA_MAX_BYTES,
): number {
  const boundedMaxBytes =
    Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : WECHAT_MEDIA_MAX_BYTES;
  const bytes =
    expectedBytes !== undefined && Number.isFinite(expectedBytes) && expectedBytes > 0
      ? Math.min(expectedBytes, boundedMaxBytes)
      : boundedMaxBytes;
  const transferMs = Math.ceil((bytes / WECHAT_MEDIA_DOWNLOAD_FLOOR_BYTES_PER_SECOND) * 1000);
  return Math.max(
    WECHAT_MEDIA_DOWNLOAD_MIN_TIMEOUT_MS,
    Math.min(WECHAT_MEDIA_DOWNLOAD_MAX_TIMEOUT_MS, WECHAT_MEDIA_DOWNLOAD_BASELINE_MS + transferMs),
  );
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readResponseBodyCapped(res: Response, maxBytes = WECHAT_IMAGE_MAX_BYTES, label = "image"): Promise<Buffer> {
  const body = res.body;
  if (!body || typeof (body as any).getReader !== "function") {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`WeChat ${label} exceeds size limit`);
    return buf;
  }

  const reader = (body as any).getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) throw new Error(`WeChat ${label} exceeds size limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function writeWechatImage(
  loc: Extract<UserMediaLocation, { kind: "ok" }> | Extract<UserMediaLocation, { reason: "remote-host" }>,
  image: DecryptedWechatImage,
  pushRemoteHostUpload: SaveWechatImagesDeps["pushRemoteHostUpload"],
): Promise<SavedWechatImage> {
  const digest = createHash("sha256").update(image.buffer).digest("hex").slice(0, 32);
  const filename = `wechat-${digest}.${image.ext}`;
  const containerPath = `${CONTAINER_UPLOADS_DIR}/${filename}`;
  const hostPath = join(loc.uploads, filename);

  if (loc.kind === "fail") {
    await pushRemoteHostUpload!({
      hostUuid: loc.hostUuid,
      remotePath: hostPath,
      content: image.buffer,
    });
  } else if (!existsSync(hostPath)) {
    await mkdir(loc.uploads, { recursive: true, mode: 0o755 });
    const tmp = join(loc.uploads, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    await writeFile(tmp, image.buffer, { mode: 0o644 });
    await chmod(tmp, 0o644).catch(() => {});
    await chown(tmp, 1000, 1000).catch(() => {});
    try {
      await rename(tmp, hostPath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  return { filename, containerPath, mimeType: image.mimeType, bytes: image.buffer.length };
}

async function writeWechatMedia(
  loc: Extract<UserMediaLocation, { kind: "ok" }> | Extract<UserMediaLocation, { reason: "remote-host" }>,
  media: DecryptedWechatMedia,
  source: WechatMediaAttachment,
  pushRemoteHostUpload: SaveWechatImagesDeps["pushRemoteHostUpload"],
): Promise<SavedWechatMedia> {
  const digest = createHash("sha256").update(media.buffer).digest("hex").slice(0, 32);
  const original = sanitizeWechatFilename(source.fileName ?? media.filename);
  const originalExt = original.includes(".") ? original.split(".").pop()!.toLowerCase() : "";
  const ext = originalExt || media.ext || "bin";
  const filename = `wechat-${media.kind}-${digest}.${ext}`;
  const containerPath = `${CONTAINER_UPLOADS_DIR}/${filename}`;
  const hostPath = join(loc.uploads, filename);

  if (loc.kind === "fail") {
    await pushRemoteHostUpload!({
      hostUuid: loc.hostUuid,
      remotePath: hostPath,
      content: media.buffer,
    });
  } else if (!existsSync(hostPath)) {
    await mkdir(loc.uploads, { recursive: true, mode: 0o755 });
    const tmp = join(loc.uploads, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    await writeFile(tmp, media.buffer, { mode: 0o644 });
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
    kind: media.kind,
    filename,
    originalName: original,
    containerPath,
    mimeType: media.mimeType,
    bytes: media.buffer.length,
    voiceText: source.voiceText,
  };
}

function buildWechatImagePrompt(text: string | undefined, images: SavedWechatImage[]): string {
  const userText = text?.trim() || "请识别并说明我刚发送的图片。";
  const lines = [userText, "", "---", "用户通过微信发送了以下图片(已保存到当前容器本地):"];
  for (const image of images) {
    lines.push(
      `- \`${image.containerPath}\` (${image.mimeType}, ${formatBytes(image.bytes)}, 原名: 微信图片)`,
    );
  }
  lines.push(
    "",
    '如果你看不到图片内容，先用 Bash 调 `oc-vision understand <上述本地路径> --prompt "<问题>"` 命令识图，再基于返回内容回答。不要说用户没有上传图片。',
  );
  return lines.join("\n");
}

function buildWechatMediaPrompt(text: string | undefined, media: SavedWechatMedia[]): string {
  const userText = text?.trim() || defaultMediaUserText(media);
  const lines = [userText, "", "---", "用户通过微信发送了以下附件(已保存到当前容器本地):"];
  for (const item of media) {
    const label = mediaKindLabel(item.kind);
    lines.push(
      `- ${label}: \`${item.containerPath}\` (${item.mimeType}, ${formatBytes(item.bytes)}, 原名: ${item.originalName})`,
    );
    if (item.kind === "voice" && item.voiceText) {
      lines.push(`  - 微信语音转写: ${item.voiceText}`);
    }
  }
  if (media.some((m) => m.kind === "image")) {
    lines.push("", '图片如果你看不到内容，先用 Bash 调 `oc-vision understand <图片本地路径> --prompt "<问题>"` 命令识图，再基于返回内容回答。不要说用户没有上传图片。');
  }
  if (media.some((m) => m.kind !== "image")) {
    lines.push("", "对于文件、视频或音频/语音，请优先基于上述本地路径进行读取、检查或转写；如果当前模型/工具无法直接解析某种媒体，请明确告诉用户已收到该附件并说明可行的下一步，而不是说没有收到附件。");
  }
  return lines.join("\n");
}

function defaultMediaUserText(media: SavedWechatMedia[]): string {
  const labels = Array.from(new Set(media.map((m) => mediaKindLabel(m.kind)))).join("/");
  return `请处理我刚通过微信发送的${labels || "附件"}。`;
}

function mediaKindLabel(kind: WechatMediaAttachment["kind"]): string {
  if (kind === "image") return "图片";
  if (kind === "voice") return "语音";
  if (kind === "video") return "视频";
  return "文件";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}
