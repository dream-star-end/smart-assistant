import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

import type { UserMediaLocation } from "../agent-sandbox/userMedia.js";
import type { IlinkMediaPart } from "./types.js";

export const WECHAT_OUTBOUND_MEDIA_MAX_ATTACHMENTS = 5;
export const WECHAT_OUTBOUND_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

const CONTAINER_MEDIA_RE =
  /(?:`)?(\/home\/agent\/\.openclaude\/(uploads|generated)\/[A-Za-z0-9._@+=,-]{1,180})(?:`)?/g;
const SAFE_BASENAME_RE = /^[A-Za-z0-9._@+=,-]{1,180}$/;

export interface ResolvedWechatOutboundMedia {
  kind: IlinkMediaPart["type"];
  filename: string;
  mimeType?: string;
  content: Buffer;
}

export interface OutboundMediaResolverDeps {
  resolveUserMediaDirs: (userId: string) => Promise<UserMediaLocation>;
  pullRemoteHostMedia?: (args: {
    hostUuid: string;
    remotePath: string;
  }) => Promise<Buffer | null>;
}

export type ResolveOutboundMediaPartFn = (args: {
  bindingUserId: string;
  part: IlinkMediaPart;
}) => Promise<ResolvedWechatOutboundMedia>;

interface HostMediaPath {
  hostPath: string;
  baseDir: string;
}

export function expandTextWithWechatMediaParts(
  text: string,
  maxAttachments = WECHAT_OUTBOUND_MEDIA_MAX_ATTACHMENTS,
): { text: string; media: IlinkMediaPart[] } {
  const media: IlinkMediaPart[] = [];
  let out = "";
  let last = 0;
  for (const match of text.matchAll(CONTAINER_MEDIA_RE)) {
    const raw = match[0] ?? "";
    const containerPath = match[1] ?? "";
    const dir = match[2] as "uploads" | "generated" | undefined;
    const start = match.index ?? 0;
    out += text.slice(last, start);
    last = start + raw.length;
    if (!dir || media.length >= maxAttachments) {
      out += raw;
      continue;
    }
    const file = basename(containerPath);
    if (!SAFE_BASENAME_RE.test(file) || file === "." || file === "..") {
      out += raw;
      continue;
    }
    const classified = classifyWechatMediaFilename(file);
    if (!classified) {
      out += raw;
      continue;
    }
    media.push({
      type: classified.kind,
      containerPath,
      filename: file,
      mimeType: classified.mimeType,
    });
  }
  out += text.slice(last);
  return { text: compactTextAfterMediaRemoval(out), media };
}

export function classifyWechatMediaFilename(
  filename: string,
): { kind: IlinkMediaPart["type"]; mimeType: string } | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const image: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  if (image[ext]) return { kind: "image", mimeType: image[ext]! };
  const video: Record<string, string> = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    m4v: "video/mp4",
    webm: "video/webm",
  };
  if (video[ext]) return { kind: "video", mimeType: video[ext]! };
  const voice: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    silk: "audio/silk",
    amr: "audio/amr",
  };
  if (voice[ext]) return { kind: "voice", mimeType: voice[ext]! };
  const file: Record<string, string> = {
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
    tar: "application/x-tar",
    gz: "application/gzip",
  };
  if (file[ext]) return { kind: "file", mimeType: file[ext]! };
  return null;
}

export function makeWechatOutboundMediaResolver(
  deps: OutboundMediaResolverDeps,
): ResolveOutboundMediaPartFn {
  return async ({ bindingUserId, part }) => {
    const userId = canonicalCommercialUserId(bindingUserId);
    const loc = await deps.resolveUserMediaDirs(userId);
    if (loc.kind === "fail" && loc.reason !== "remote-host") {
      throw new Error(`outbound media unavailable: ${loc.reason}`);
    }
    const hostPath = hostPathForContainerPath(loc, part.containerPath);
    const content = await readMediaBytes(loc, hostPath, deps.pullRemoteHostMedia);
    assertMediaSize(content.length);
    const sniffed = sniffWechatMedia(content, part.filename);
    const kind = saferKind(part.type, sniffed.kind);
    return {
      kind,
      filename: part.filename,
      mimeType: sniffed.mimeType ?? part.mimeType,
      content,
    };
  };
}

function hostPathForContainerPath(
  loc: Extract<UserMediaLocation, { kind: "ok" }> | Extract<UserMediaLocation, { reason: "remote-host" }>,
  containerPath: string,
): HostMediaPath {
  const m = /^\/home\/agent\/\.openclaude\/(uploads|generated)\/([^/]+)$/.exec(containerPath);
  if (!m) throw new Error("invalid outbound media container path");
  const dir = m[1]!;
  const file = m[2]!;
  if (!SAFE_BASENAME_RE.test(file) || file === "." || file === "..") {
    throw new Error("invalid outbound media filename");
  }
  const baseDir = dir === "uploads" ? loc.uploads : loc.generated;
  return { hostPath: join(baseDir, file), baseDir };
}

async function readMediaBytes(
  loc: Extract<UserMediaLocation, { kind: "ok" }> | Extract<UserMediaLocation, { reason: "remote-host" }>,
  path: HostMediaPath,
  pullRemoteHostMedia: OutboundMediaResolverDeps["pullRemoteHostMedia"],
): Promise<Buffer> {
  if (loc.kind === "fail") {
    if (!pullRemoteHostMedia) throw new Error("remote host media pull is unavailable");
    const buf = await pullRemoteHostMedia({ hostUuid: loc.hostUuid, remotePath: path.hostPath });
    if (!buf) throw new Error("remote host media not found");
    return buf;
  }

  const baseStat = await lstat(path.baseDir);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
    throw new Error("outbound media directory is not a safe directory");
  }
  const baseReal = await realpath(path.baseDir);
  const fh = await open(path.hostPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error("outbound media is not a file");
    assertMediaSize(st.size);
    const fdReal = await realpath(`/proc/self/fd/${fh.fd}`);
    assertRealPathWithinBase(fdReal, baseReal);
    return await fh.readFile();
  } finally {
    await fh.close().catch(() => {});
  }
}

function assertRealPathWithinBase(fileRealPath: string, baseRealPath: string): void {
  const file = resolve(fileRealPath);
  const base = resolve(baseRealPath);
  if (file !== base && !file.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)) {
    throw new Error("outbound media resolved outside user media directory");
  }
}

function sniffWechatMedia(
  buf: Buffer,
  filename: string,
): { kind: IlinkMediaPart["type"]; mimeType?: string } {
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { kind: "image", mimeType: "image/png" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { kind: "image", mimeType: "image/jpeg" };
  }
  if (buf.length >= 12 && buf.subarray(4, 8).toString("ascii") === "ftyp") {
    return { kind: "video", mimeType: "video/mp4" };
  }
  if (buf.length >= 3 && buf.subarray(0, 3).toString("ascii") === "ID3") {
    return { kind: "voice", mimeType: "audio/mpeg" };
  }
  return classifyWechatMediaFilename(filename) ?? { kind: "file", mimeType: "application/octet-stream" };
}

function saferKind(
  declared: IlinkMediaPart["type"],
  sniffed: IlinkMediaPart["type"],
): IlinkMediaPart["type"] {
  if (declared === sniffed) return declared;
  if (sniffed === "image" || sniffed === "video" || sniffed === "voice") return sniffed;
  return "file";
}

function canonicalCommercialUserId(input: string): string {
  const s = input.trim();
  if (/^c:[1-9][0-9]{0,18}$/.test(s)) return s;
  if (/^[1-9][0-9]{0,18}$/.test(s)) return `c:${s}`;
  throw new Error("invalid binding user id for WeChat outbound media");
}

function assertMediaSize(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) throw new Error("empty outbound media");
  if (bytes > WECHAT_OUTBOUND_MEDIA_MAX_BYTES) throw new Error("outbound media exceeds size limit");
}

function compactTextAfterMediaRemoval(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
