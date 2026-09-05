/**
 * 大文件下载的纯策略与进度计算（无 React / 无 DOM 依赖，便于单测）。
 *
 * 背景：SignedFileCard 原来只有一条 `<a download>` 原生路径 —— 移动端 WebView 上大文件
 * 下载「点了没反应」（无进度、无失败反馈）。本模块把「按尺寸选下载路径」和「进度百分比」
 * 抽成纯函数，UI 层（media.tsx）只负责接线 fetch/流读/存盘。
 *
 * 尺寸带（阈值即权威，改这里一处即可）：
 *  - < 3MB           → 原生 `<a download>`：小文件原生更可靠（尤其 iOS Safari 的 blob 下载
 *                       行为异常），也无需进度。
 *  - 3MB ~ <100MB    → fetch + 流读 + 进度环/条 + Blob 存盘。
 *  - ≥ 100MB / 未知  → 原生 `<a download>`：Blob 全量驻内存，超大文件会撑爆内存；
 *                       Content-Length 未知则无法算百分比，也交原生（浏览器边下边写盘）。
 */

/** 低于此值走原生 `<a download>`（小文件原生更可靠，无需进度）。 */
export const DOWNLOAD_STREAM_MIN_BYTES = 3 * 1024 * 1024; // 3MB
/** 达到/超过此值走原生 `<a download>`（Blob 全量驻内存，超大文件防 OOM）。 */
export const DOWNLOAD_STREAM_MAX_BYTES = 100 * 1024 * 1024; // 100MB
/** office/pdf 存盘前最小字节：挡住 410 JSON / 空 stub 冒充 .docx。 */
export const OFFICE_PDF_MIN_BYTES = 2048;

const OFFICE_EXTS = new Set(["docx", "pptx", "xlsx", "dotx", "xltx", "potx"]);
const PDF_EXTS = new Set(["pdf"]);

export type MagicSniffReason = "too-small" | "bad-magic";
export type MagicSniffResult = { ok: true } | { ok: false; reason: MagicSniffReason };

function filenameExt(filename: string): string {
  const base = filename.split(/[\\/]/).pop() || filename;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function asciiHead(bytes: Uint8Array, max = 32): string {
  const n = Math.min(bytes.byteLength, max);
  let out = "";
  for (let i = 0; i < n; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

function looksLikeJsonOrHtml(bytes: Uint8Array): boolean {
  let i = 0;
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.byteLength && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) {
    i += 1;
  }
  const head = asciiHead(bytes.subarray(i), 16).toLowerCase();
  return head.startsWith("{") || head.startsWith("[") || head.startsWith("<");
}

/**
 * office/pdf 魔数表（纯函数）：PK / %PDF- 合法；`{` / `<!DOC` / 过短一律拒。
 * 其它扩展名不嗅探（txt/csv 可以很小）。
 */
export function sniffOfficeOrPdfMagic(bytes: Uint8Array, filename: string): MagicSniffResult {
  const ext = filenameExt(filename);
  const isOffice = OFFICE_EXTS.has(ext);
  const isPdf = PDF_EXTS.has(ext);
  if (!isOffice && !isPdf) return { ok: true };
  if (bytes.byteLength < OFFICE_PDF_MIN_BYTES) return { ok: false, reason: "too-small" };
  if (looksLikeJsonOrHtml(bytes)) return { ok: false, reason: "bad-magic" };
  if (isPdf) {
    const h = asciiHead(bytes, 5);
    if (h !== "%PDF-") return { ok: false, reason: "bad-magic" };
  }
  if (isOffice) {
    if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
      return { ok: false, reason: "bad-magic" };
    }
  }
  return { ok: true };
}

/**
 * VITE_OC_FILECARD_SNIFF bake 默认关。关则 SignedFileCard 走现网 nativeDownload 路径。
 * 测试可设 `globalThis.__OC_FILECARD_SNIFF = "1"`。
 */
export function fileCardSniffEnabled(): boolean {
  const g = globalThis as typeof globalThis & {
    __OC_FILECARD_SNIFF?: string;
    process?: { env?: Record<string, string | undefined> };
  };
  const raw =
    typeof g.__OC_FILECARD_SNIFF === "string"
      ? g.__OC_FILECARD_SNIFF
      : typeof g.process?.env?.VITE_OC_FILECARD_SNIFF === "string"
        ? g.process.env.VITE_OC_FILECARD_SNIFF
        : (() => {
            try {
              const vite = (import.meta as { env?: Record<string, string | undefined> }).env;
              return typeof vite?.VITE_OC_FILECARD_SNIFF === "string" ? vite.VITE_OC_FILECARD_SNIFF : "";
            } catch {
              return "";
            }
          })();
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

export type DownloadStrategy = "native" | "stream";

/**
 * 依据 Content-Length（字节）选下载路径。仅 [3MB, 100MB) 区间走流式进度；
 * 其余（小 / 超大 / 未知 / 非法）一律回落原生 `<a download>`。
 */
export function pickDownloadStrategy(totalBytes: number | null | undefined): DownloadStrategy {
  if (totalBytes == null || !Number.isFinite(totalBytes) || totalBytes <= 0) return "native";
  if (totalBytes < DOWNLOAD_STREAM_MIN_BYTES) return "native";
  if (totalBytes >= DOWNLOAD_STREAM_MAX_BYTES) return "native";
  return "stream";
}

/**
 * 流读进度百分比（0~100 的整数）。total 未知/非法时返回 null —— 调用方据此
 * 渲染「不确定态」（转圈而非百分比）。loaded 会被夹在 [0, total] 防止越界抖动。
 */
export function downloadPercent(loaded: number, total: number | null | undefined): number | null {
  if (total == null || !Number.isFinite(total) || total <= 0) return null;
  const clamped = Math.max(0, Math.min(loaded, total));
  return Math.round((clamped / total) * 100);
}

/** 人类可读字节数（进度文案 "3.4 MB / 12.0 MB" 用）。 */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 触发原生 `<a download>` 下载给定（同源）URL：小 / 超大 / 未知尺寸文件的路径，
 * 以及流式失败后的「直接下载」兜底走它 —— 浏览器边下边写盘，不入 JS 内存。
 * 触碰 DOM，SSR/无 document 时安全 no-op。
 */
export function nativeDownload(url: string, filename: string): void {
  if (typeof document === "undefined") return;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "download";
  a.target = "_blank";
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * 程序化新标签打开(签名 URL 点击时重签的慢路径用)：临时 `<a target=_blank>` click。
 * 必须紧跟在用户手势的激活窗口内调用,否则可能被弹窗拦截 —— 调用方保证。
 * 触碰 DOM,SSR/无 document 时安全 no-op。
 */
export function openInNewTab(url: string): void {
  if (typeof document === "undefined") return;
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * 把已下载完成的 Blob 触发浏览器「另存为」：objectURL → 临时 `<a download>` click → revoke。
 * 触碰 DOM，非纯函数（放这里与下载逻辑同源）；SSR/无 document 时安全 no-op。
 */
export function saveBlob(blob: Blob, filename: string): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "download";
    a.rel = "noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // 交给下一帧再回收，避免个别 WebView 在 click 未真正触发下载前就失效 objectURL。
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
