/**
 * 媒体引用解析（纯逻辑）。判定一个 MediaRef / 文本里的 src 该怎么取源：
 *  - base64 → data: URL，直接渲染（无需网络）。
 *  - http(s)/data/blob URL → 直接渲染。
 *  - 容器内绝对路径（/workspace/... 等，非 /api/）→ 必须经 /api/media-sign 换签名 URL，
 *    否则浏览器拿不到容器盘上的文件，图片/视频/音频永停在占位（本期要根治的点）。
 *  - 其余 → 无可渲染源。
 */
import type { MediaRef } from "./frames";

export type MediaKind = MediaRef["kind"];

export type ResolvedMedia =
  | { mode: "direct"; kind: MediaKind; src: string; filename?: string; mimeType?: string }
  | { mode: "sign"; kind: MediaKind; path: string; filename?: string; mimeType?: string }
  | { mode: "none"; kind: MediaKind; filename?: string };

/** 是否为需签名的容器内绝对路径（以 / 开头、非 // 协议相对、非 /api 端点）。 */
export function isContainerPath(s: string): boolean {
  if (typeof s !== "string" || !s) return false;
  if (!s.startsWith("/")) return false;
  if (s.startsWith("//")) return false; // 协议相对 URL
  if (s.startsWith("/api/")) return false; // 已是同源后端端点
  return true;
}

/** 已可直接用于 <img src> 的 URL（http/https/data/blob）。 */
export function isDirectUrl(s: string): boolean {
  return /^(https?:|data:|blob:)/i.test(s);
}

export function classifyMediaRef(m: MediaRef): ResolvedMedia {
  const base = { kind: m.kind, filename: m.filename, mimeType: m.mimeType };
  if (m.base64) {
    const mt = m.mimeType || guessMime(m.kind);
    return { mode: "direct", src: `data:${mt};base64,${m.base64}`, ...base };
  }
  const url = (m.url || "").trim();
  if (!url) return { mode: "none", kind: m.kind, filename: m.filename };
  if (url.startsWith("/api/media/")) return { mode: "direct", src: url, ...base };
  if (isDirectUrl(url)) return { mode: "direct", src: url, ...base };
  if (isContainerPath(url)) return { mode: "sign", path: url, ...base };
  return { mode: "none", kind: m.kind, filename: m.filename };
}

function guessMime(kind: MediaKind): string {
  switch (kind) {
    case "image":
      return "image/png";
    case "audio":
      return "audio/mpeg";
    case "video":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}
