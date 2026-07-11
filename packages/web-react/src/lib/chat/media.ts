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

/** 点击时签名权威:交互那一刻解析/重签签名 URL(过期自动重签;forceResign 强制)。 */
export type ResolveSignedSrc = (opts?: { forceResign?: boolean }) => Promise<string | null>;

/**
 * 取图字节 + 过期自愈 —— 图片编辑三入口(编辑/评论/调整大小)共用的取字节收口。
 *
 * 先 fetch 传入 url;若服务端裁决 403/410(签名失效/过期,本地缓存钟可能还认为没过期)
 * 且有 resolveSrc,则**强制重签一次**再 fetch —— 服务端裁决优先于本地钟(对齐仓内
 * 「点击手势取媒体入口禁冻结挂载态 URL」+ SignedImg/useSignedDownload 的 410/403 重签铁律)。
 * 任一 fetch 非 2xx(且无可重签路径或重签后仍失败)→ 抛错,调用方转**显式错误态**(danger
 * 文案 + 重试),永不把过期/失败静默吞成留白画布。
 *
 * credentials:'include' —— /api/media-signed 是同源端点,带 cookie 兜底(signed token
 * 已自证身份,cookie 只是 CDN drop token 场景的第二保险)。
 */
export async function fetchImageBlobWithResign(
  url: string,
  resolveSrc?: ResolveSignedSrc,
): Promise<Blob> {
  let target = url;
  let res = await fetch(target, { credentials: "include" });
  if ((res.status === 403 || res.status === 410) && resolveSrc) {
    const resigned = await resolveSrc({ forceResign: true });
    if (resigned) {
      target = resigned;
      res = await fetch(target, { credentials: "include" });
    }
  }
  if (!res.ok) throw new Error(`读取图片失败 (${res.status})`);
  return res.blob();
}
