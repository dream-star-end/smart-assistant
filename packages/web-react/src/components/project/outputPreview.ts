import type { ResolveSignedSrc } from "../../lib/chat/imageBytes";
import type { ProjectAsset } from "../../lib/types";
import { extOf, outputKind } from "./projectHomeModel";

/**
 * 产出查看器的纯逻辑：按扩展名 / mime 决定怎么预览、读多少字节、首几行摘要。
 * 不碰 React，单测直接打。取字节一律经签名 URL（get = useFreshSignedUrl 的点击时签名），
 * 403/410 强制重签一次 —— 与 useSignedDownload / fetchProgressiveBlob 同一条约定。
 */

/** 查看器的形态。file = 不预览，只给详情与下载（压缩包 / Office / 未知二进制）。 */
export type PreviewKind = "image" | "pdf" | "markdown" | "code" | "text" | "file";

/** 文本类预览最多读 1 MiB：再大的日志 / 数据在手机上也读不完，给下载。 */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
/** 代码高亮上限：highlight.js 在几百 KB 的单块上会卡住主线程，超过就纯文本显示。 */
export const CODE_HIGHLIGHT_MAX_CHARS = 200_000;
/** PDF 预览上限（整块进内存做 object URL）。 */
export const PDF_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
/** 卡片首几行：只对已知不大的文本文件取头部，且只读这么多字节。 */
export const SNIPPET_FETCH_MAX_FILE_BYTES = 256 * 1024;
export const SNIPPET_HEAD_BYTES = 4096;

const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);
const TEXT_EXT = new Set(["txt", "text", "log", "csv", "tsv", "tex", "rst", "ini", "conf", "env", "srt", "vtt"]);

export function previewKindOf(a: Pick<ProjectAsset, "name" | "mime">): PreviewKind {
  const ext = extOf(a.name);
  const mime = (a.mime ?? "").toLowerCase();
  if (outputKind(a) === "image") return "image";
  if (ext === "pdf" || mime === "application/pdf") return "pdf";
  if (MARKDOWN_EXT.has(ext) || mime === "text/markdown") return "markdown";
  if (TEXT_EXT.has(ext)) return "text";
  if (outputKind(a) === "code") return "code";
  // 扩展名不认识时才看 mime：服务端 mime 常是 octet-stream。
  if (!ext || !KNOWN_BINARY_EXT.has(ext)) {
    if (mime.startsWith("text/")) return "text";
    if (mime === "application/json") return "code";
  }
  return "file";
}

const KNOWN_BINARY_EXT = new Set([
  "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar",
  "doc", "docx", "xls", "xlsx", "xlsm", "ppt", "pptx", "odt", "ods", "odp", "key", "pages", "numbers", "epub", "rtf",
  "mp3", "mp4", "mov", "wav", "m4a", "webm", "ogg",
  "bin", "exe", "dmg", "iso", "deb", "rpm", "apk", "whl", "jar",
]);

/** 是否值得在卡片上取首几行（文本类且大小已知不大）。 */
export function isTextual(kind: PreviewKind): boolean {
  return kind === "markdown" || kind === "code" || kind === "text";
}

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  cs: "csharp",
  cc: "cpp",
  hpp: "cpp",
  h: "c",
  sh: "bash",
  zsh: "bash",
  yml: "yaml",
  htm: "html",
  ipynb: "json",
  vue: "xml",
  svelte: "xml",
};

/** 代码块语言名（highlight.js 别名）；未知扩展名原样给，ignoreMissing 兜底。 */
export function codeLanguageOf(name: string): string {
  const ext = extOf(name);
  return LANG_BY_EXT[ext] ?? ext;
}

/** 把源码包成围栏代码块：围栏比正文里最长的反引号串多一个，正文无法提前闭合围栏。 */
export function fenceCode(code: string, language: string): string {
  let longest = 0;
  for (const m of code.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  const lang = /^[\w+-]+$/.test(language) ? language : "";
  return `${fence}${lang}\n${code.replace(/\n$/, "")}\n${fence}`;
}

/**
 * 字节 → 文本。UTF-8 宽松解码（BOM 去掉）；含 NUL 或替换字符过多 → 不是文本（null），
 * 调用方回落到下载。
 */
export function decodeText(bytes: Uint8Array): string | null {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^﻿/, "");
  if (text.includes("\u0000")) return null;
  let bad = 0;
  for (const ch of text) if (ch === "�") bad += 1;
  if (text.length > 0 && bad / text.length > 0.02) return null;
  return text;
}

/** PDF 魔数（规范允许 %PDF- 出现在前 1024 字节内）。不是 PDF 就不交给浏览器 PDF 查看器。 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 1024);
  for (let i = 0; i + 5 <= head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) {
      return true;
    }
  }
  return false;
}

/**
 * 卡片上的首几行：去掉空行，Markdown 去掉行首的 # / > / 列表记号，每行截断。
 * 结果只当纯文本渲染（React 转义），不解析。
 */
export function snippetOf(text: string, kind: PreviewKind, maxLines = 3, maxChars = 120): string {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/\t/g, "  ").trimEnd();
    if (kind === "markdown") line = line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/, "").trim();
    if (kind !== "code") line = line.trim();
    if (!line || /^(?:-{3,}|`{3,}.*|={3,})$/.test(line.trim())) continue;
    lines.push(line.length > maxChars ? `${line.slice(0, maxChars)}…` : line);
    if (lines.length >= maxLines) break;
  }
  return lines.join("\n");
}

export type CappedResult =
  | { kind: "ok"; bytes: Uint8Array; type: string; truncated: boolean }
  | { kind: "too-large"; total: number | null };

/**
 * 经签名 URL 取字节，最多 cap 字节。
 * - truncate=false：超过 cap（Content-Length 或边读边数）→ 中止，返回 too-large；
 * - truncate=true：读满 cap 就停（卡片首几行用；顺带发 Range 头，服务端支持就只回这么多）。
 * 403/410 → 强制重签一次再取（签名 URL 5 分钟过期，以服务端裁决为准）。
 */
export async function fetchSignedCapped(
  get: ResolveSignedSrc,
  cap: number,
  opts: { signal?: AbortSignal; truncate?: boolean } = {},
): Promise<CappedResult> {
  const { signal, truncate = false } = opts;
  const init: RequestInit = { signal };
  if (truncate) init.headers = { Range: `bytes=0-${cap - 1}` };
  let url = await get();
  if (!url) throw new Error("签名失败");
  let res = await fetch(url, init);
  if (res.status === 403 || res.status === 410) {
    const resigned = await get({ forceResign: true });
    if (resigned) {
      url = resigned;
      res = await fetch(url, init);
    }
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "application/octet-stream";
  const declared = Number(res.headers.get("content-length")) || null;
  if (!truncate && res.status !== 206 && declared !== null && declared > cap) {
    void res.body?.cancel().catch(() => {});
    return { kind: "too-large", total: declared };
  }
  if (!res.body || typeof res.body.getReader !== "function") {
    const all = new Uint8Array(await res.arrayBuffer());
    if (all.byteLength > cap) {
      return truncate
        ? { kind: "ok", bytes: all.subarray(0, cap), type, truncated: true }
        : { kind: "too-large", total: all.byteLength };
    }
    return { kind: "ok", bytes: all, type, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loaded += value.byteLength;
    if (loaded > cap) {
      void reader.cancel().catch(() => {});
      if (!truncate) return { kind: "too-large", total: declared };
      break;
    }
  }
  const merged = new Uint8Array(Math.min(loaded, cap));
  let offset = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, merged.byteLength - offset);
    if (take <= 0) break;
    merged.set(c.subarray(0, take), offset);
    offset += take;
  }
  return { kind: "ok", bytes: merged, type, truncated: loaded > cap };
}

/** 文件大小已知且超过上限 → 不必发请求，直接给下载。 */
export function knownTooLarge(sizeBytes: number | null | undefined, cap: number): boolean {
  return typeof sizeBytes === "number" && Number.isFinite(sizeBytes) && sizeBytes > cap;
}

/** 缩略图格子里的扩展名标记（最多 4 个字符，大写）。 */
export function extBadgeOf(name: string): string {
  const ext = extOf(name);
  return ext ? ext.slice(0, 4).toUpperCase() : "FILE";
}
