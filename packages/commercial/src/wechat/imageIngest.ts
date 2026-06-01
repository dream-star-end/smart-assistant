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
import type { UserMediaLocation } from "../agent-sandbox/userMedia.js";

const CONTAINER_UPLOADS_DIR = "/home/agent/.openclaude/uploads";
const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_DOWNLOAD_REDIRECTS = 3;
const ALLOWED_WECHAT_IMAGE_HOSTS = [
  "cdn.weixin.qq.com",
  ".cdn.weixin.qq.com",
  "weixin.qq.com",
  ".weixin.qq.com",
];

export interface SavedWechatImage {
  filename: string;
  containerPath: string;
  mimeType: string;
  bytes: number;
}

export interface SaveWechatImagesResult {
  promptText: string;
  count: number;
  images: SavedWechatImage[];
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

export function makeSaveWechatImagesToUserUploads(
  deps: SaveWechatImagesDeps,
): (args: SaveWechatImagesArgs) => Promise<SaveWechatImagesResult> {
  return (args) => saveWechatImagesToUserUploads(args, deps);
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

function canonicalCommercialUserId(input: string): string {
  const s = input.trim();
  if (/^c:[1-9][0-9]{0,18}$/.test(s)) return s;
  if (/^[1-9][0-9]{0,18}$/.test(s)) return `c:${s}`;
  throw new Error("invalid binding user id for WeChat image upload");
}

export function assertAllowedWechatImageUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("invalid WeChat image URL");
  }
  if (url.protocol !== "https:") throw new Error("WeChat image URL must use https");
  const host = url.hostname.toLowerCase();
  const ok = ALLOWED_WECHAT_IMAGE_HOSTS.some((allowed) => {
    if (allowed.startsWith(".")) return host.endsWith(allowed);
    return host === allowed;
  });
  if (!ok) throw new Error("WeChat image URL host is not allowed");
  url.username = "";
  url.password = "";
  return url.toString();
}

export async function downloadWechatImageEncrypted(
  fullUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<Buffer> {
  let currentUrl = assertAllowedWechatImageUrl(fullUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
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
        currentUrl = assertAllowedWechatImageUrl(new URL(location, currentUrl).toString());
        continue;
      }
      assertAllowedWechatImageUrl(res.url || currentUrl);
      if (!res.ok) throw new Error(`WeChat image download failed: HTTP ${res.status}`);
      const contentLength = res.headers.get("content-length");
      if (contentLength) {
        const n = Number(contentLength);
        if (!Number.isFinite(n) || n < 0 || n > WECHAT_IMAGE_MAX_BYTES) {
          throw new Error("WeChat image exceeds size limit");
        }
      }
      return await readResponseBodyCapped(res);
    }
    throw new Error("WeChat image download redirected too many times");
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("WeChat image download timed out");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readResponseBodyCapped(res: Response): Promise<Buffer> {
  const body = res.body;
  if (!body || typeof (body as any).getReader !== "function") {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > WECHAT_IMAGE_MAX_BYTES) throw new Error("WeChat image exceeds size limit");
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
    if (total > WECHAT_IMAGE_MAX_BYTES) throw new Error("WeChat image exceeds size limit");
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
    "请先调用 `understand_image` MCP 工具，传 `image_file` 为上述本地路径，再基于图片内容回答。不要说用户没有上传图片。",
  );
  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}
