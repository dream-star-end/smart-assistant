/**
 * 媒体引用解析（纯逻辑）。判定一个 MediaRef / 文本里的 src 该怎么取源：
 *  - base64 → data: URL，直接渲染（无需网络）。
 *  - http(s)/data/blob URL → 直接渲染。
 *  - 容器内绝对路径（/workspace/... 等，非 /api/）→ 必须经 /api/media-sign 换签名 URL，
 *    否则浏览器拿不到容器盘上的文件，图片/视频/音频永停在占位（本期要根治的点）。
 *  - 其余 → 无可渲染源。
 */
import type { MediaRef } from "./frames";
import { fetchProgressiveBlob, type ProgressFn } from "./fetchImageProgressive";
import type { ResolveSignedSrc } from "./imageBytes";

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

/**
 * 需要经 /api/media-sign 换成带 token 的签名 URL 才能可靠渲染的来源。**单一权威**判定,
 * 供渲染器(classifyMediaRef)与签名 hook(useSignedSrc/useFreshSignedUrl)共用,避免漂移。
 *
 * 覆盖三类:
 *   1. 容器内绝对路径(/home/agent/... 等)—— 浏览器直接取不到容器盘。
 *   2. `/api/media/<digest>` —— 内容寻址的用户上传/生成媒体。裸 `<img src>` 直取要靠
 *      HttpOnly `oc_session` SameSite=Strict cookie,iOS Safari + Cloudflare 下该 cookie
 *      在媒体子资源请求里被 drop → master 收不到凭证 → 持久 401 裂图(现网实锤,de16e2be
 *      同类)。收口到签名管线后凭证进 URL,不再依赖 cookie。
 *   3. `/api/inbox-assets/<uuid>` —— 站内信 PG 图片；签名与每次读取都复核消息可见性。
 */
export function needsSignedSrc(s: string): boolean {
  if (typeof s !== "string" || !s) return false;
  return isContainerPath(s) || s.startsWith("/api/media/") || s.startsWith("/api/inbox-assets/");
}

/** 已可直接用于 <img src> 的 URL（http/https/data/blob）。 */
export function isDirectUrl(s: string): boolean {
  return /^(https?:|data:|blob:)/i.test(s);
}

export function classifyMediaRef(m: MediaRef): ResolvedMedia {
  const base = { kind: m.kind, filename: m.filename, mimeType: m.mimeType };
  // 乐观气泡:刚上传的媒体带本地 blob URL(上传时字节在手),先本地直渲,消除"上传成功→
  // 服务端回显/签名前"的短暂裂图窗口。localSrc 仅本机 UI、不持久化、不进出站帧(socket/
  // toStored 显式剥离)→ 刷新/换设备后自然回落 url 走签名管线。
  if (m.localSrc) {
    return { mode: "direct", src: m.localSrc, ...base };
  }
  if (m.base64) {
    const mt = m.mimeType || guessMime(m.kind);
    return { mode: "direct", src: `data:${mt};base64,${m.base64}`, ...base };
  }
  const url = (m.url || "").trim();
  if (!url) return { mode: "none", kind: m.kind, filename: m.filename };
  if (isDirectUrl(url)) return { mode: "direct", src: url, ...base };
  // /api/media(内容寻址上传/生成媒体)与容器路径统一走签名管线(凭证进 URL,不靠 cookie)。
  if (needsSignedSrc(url)) return { mode: "sign", path: url, ...base };
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

/** 点击时签名权威:交互那一刻解析/重签签名 URL(过期自动重签;forceResign 强制)。
 * 权威定义在 imageBytes.ts,此处再导出给编辑器/查看器(既有 import 路径不变)。 */
export type { ResolveSignedSrc } from "./imageBytes";

/**
 * 取图字节 + 过期自愈 + **字节复用** —— 图片编辑三入口(编辑/评论/调整大小)共用的取字节收口。
 *
 * 经 **fetchProgressiveBlob**(与 useProgressiveImage 同一 fetch+缓存收口,不做第二套):
 *   - 先查共享 LRU(imageByteCache):命中即**零请求复用**(查看器已载原图 → 进编辑器直接用,
 *     根治 boss「为什么不能复用已渲染出来的图片」的重下载)。
 *   - miss → 流式 fetch(可选 onProgress 汇报百分比,给编辑器进度条用),完成后写回缓存。
 *   - 403/410 → resolveSrc 强制重签一次;429/503 → 退避重试(服务端裁决优先本地钟)。
 * 任一失败 → 抛错,调用方转**显式错误态**,永不把过期/失败静默吞成留白画布。
 *
 * cacheIdentity 传 signPath(容器路径 / `/api/media/<digest>`)才能跨入口复用同一字节;
 * 缺省(本地 objectURL / composer 附件)→ 不缓存,行为等同过去。
 */
export async function fetchImageBlobWithResign(
  url: string,
  resolveSrc?: ResolveSignedSrc,
  opts?: { cacheIdentity?: string | null; onProgress?: ProgressFn; signal?: AbortSignal },
): Promise<Blob> {
  return fetchProgressiveBlob({
    url,
    width: null, // 编辑/评论/调整大小恒取**原图**(缩略不可用于合成/上传)
    cacheIdentity: opts?.cacheIdentity ?? null,
    resolveSrc,
    signal: opts?.signal,
    onProgress: opts?.onProgress,
  });
}
