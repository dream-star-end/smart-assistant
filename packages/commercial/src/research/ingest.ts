/**
 * oc-ingest 文档解析(master 从源字节铸造不可变 NormalizedDocument)。
 *
 * 证据权威源(§0.5):**master** 从上传字节解析,docId 内容派生(容器无法冒名),
 * 权威 span 文本存 research_documents;quote 校验回查这里。
 *
 * 引擎路由(config.ingest.engine):
 *   - local(缺省):进程内文字层抽取(txt/md/html 直取;pdf 经动态 import pdf-parse,
 *     缺失/扫描件无文字层 → needs_ocr,不静默产空)。
 *   - mineru / mistral:config-gated 外部引擎(master 调 endpoint;Phase 2 留接口)。
 *
 * 降级哲学:无 GPU/MinerU 也能跑(纯文本/有文字层 PDF);扫描件明确报 needs_ocr。
 */

import { createHash } from "node:crypto";
import type { DocLang, NormalizedDocument, ReferenceEntry, Span } from "@openclaude/protocol/research";

/** 抽取输出上限(防 master 内存/CPU DoS:25MB PDF 可膨胀成超大文本)。 */
export const MAX_DOC_CHARS = 3_000_000;
export const MAX_SPANS = 10_000;

const CJK_RE = /[一-鿿]/;
function guessLang(text: string): DocLang {
  const sample = text.slice(0, 4000);
  if (CJK_RE.test(sample)) return "zh";
  return /[a-z]/i.test(sample) ? "en" : "other";
}

function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

// ── 文字抽取 ─────────────────────────────────────────────────────────

export interface ExtractedText {
  text: string;
  title?: string;
}
export interface NeedsOcr {
  needsOcr: true;
  reason: string;
}
export type ExtractResult = ExtractedText | NeedsOcr;

export function isNeedsOcr(r: ExtractResult): r is NeedsOcr {
  return (r as NeedsOcr).needsOcr === true;
}

/** 纯文本/markdown:直接 UTF-8 解码;markdown 首个 # 标题作 title。 */
export function extractPlainText(bytes: Buffer): ExtractedText {
  const text = bytes.toString("utf8");
  const h = text.match(/^#\s+(.+)$/m);
  return { text, title: h?.[1]?.trim() };
}

/** HTML:极简去标签(够 MVP;复杂解析交 oc-web,见方案分流)。 */
export function extractHtml(bytes: Buffer): ExtractedText {
  const raw = bytes.toString("utf8");
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, title };
}

/** pdf-parse v2 会在每页之间插入 `-- 1 of N --` 分隔符,校验文字层长度时须剥离以防扫描件误判。 */
const PDF_PARSE_V2_PAGE_MARKER_RE = /^--\s*\d+\s+of\s+\d+\s*--$/gm;

/**
 * 进程缺少原生 `@napi-rs/canvas` 绑定时,`pdf-parse` v2 内部的 `pdfjs-dist` 在模块加载阶段会执行
 * `new DOMMatrix()`。纯文本抽取路径不依赖画布光栅化,补齐最小 2D DOMMatrix 兜底以保证文字 PDF
 * 本地回落真实可用。
 */
function ensurePdfJsDomMatrix(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.DOMMatrix !== "undefined") return;
  class MinimalDOMMatrix {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
    m11: number;
    m12: number;
    m21: number;
    m22: number;
    m41: number;
    m42: number;
    is2D = true;
    constructor(init?: number[]) {
      const m = Array.isArray(init) && init.length >= 6 ? init : [1, 0, 0, 1, 0, 0];
      [this.a, this.b, this.c, this.d, this.e, this.f] = m as [number, number, number, number, number, number];
      this.m11 = this.a;
      this.m12 = this.b;
      this.m21 = this.c;
      this.m22 = this.d;
      this.m41 = this.e;
      this.m42 = this.f;
    }
    multiply(other: MinimalDOMMatrix): MinimalDOMMatrix {
      return new MinimalDOMMatrix([
        this.a * other.a + this.c * other.b,
        this.b * other.a + this.d * other.b,
        this.a * other.c + this.c * other.d,
        this.b * other.c + this.d * other.d,
        this.a * other.e + this.c * other.f + this.e,
        this.b * other.e + this.d * other.f + this.f,
      ]);
    }
    scale(sx: number, sy = sx): MinimalDOMMatrix {
      return this.multiply(new MinimalDOMMatrix([sx, 0, 0, sy, 0, 0]));
    }
    translate(tx: number, ty = 0): MinimalDOMMatrix {
      return this.multiply(new MinimalDOMMatrix([1, 0, 0, 1, tx, ty]));
    }
    inverse(): MinimalDOMMatrix {
      const det = this.a * this.d - this.b * this.c || 1;
      return new MinimalDOMMatrix([
        this.d / det,
        -this.b / det,
        -this.c / det,
        this.a / det,
        (this.c * this.f - this.d * this.e) / det,
        (this.b * this.e - this.a * this.f) / det,
      ]);
    }
    transformPoint(pt: { x?: number; y?: number } = {}): { x: number; y: number; z: number; w: number } {
      const x = pt.x ?? 0;
      const y = pt.y ?? 0;
      return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 };
    }
  }
  g.DOMMatrix = MinimalDOMMatrix;
}

type PdfParseV2Instance = {
  getText: () => Promise<{ text?: string }>;
  getInfo?: () => Promise<{ info?: { Title?: string } }>;
  destroy: () => Promise<void> | void;
};

/**
 * PDF:动态 import pdf-parse(锁定 v2.4.5 `PDFParse` 类,并兼容 v1 default 工厂)。
 * 解析后必须 `destroy()` 释放 worker;缺失/解析失败/无文字层(文本极短)→ needs_ocr。
 */
export async function extractPdf(
  bytes: Buffer,
  pdfImpl?: (b: Buffer) => Promise<{ text: string; info?: { Title?: string } }>,
): Promise<ExtractResult> {
  if (pdfImpl) {
    try {
      const data = await pdfImpl(bytes);
      const text = (data.text ?? "").replace(PDF_PARSE_V2_PAGE_MARKER_RE, "").trim();
      if (text.replace(/\s/g, "").length < 40) {
        return { needsOcr: true, reason: "no extractable text layer (likely scanned)" };
      }
      return { text, title: data.info?.Title?.trim() || undefined };
    } catch {
      return { needsOcr: true, reason: "pdf parse failed; OCR engine required" };
    }
  }

  let mod: {
    PDFParse?: new (opts: { data: Uint8Array }) => PdfParseV2Instance;
    default?: (b: Buffer) => Promise<{ text: string; info?: { Title?: string } }>;
  };
  try {
    ensurePdfJsDomMatrix();
    mod = (await import("pdf-parse")) as unknown as typeof mod;
  } catch {
    return { needsOcr: true, reason: "pdf parser unavailable; OCR engine required" };
  }

  if (typeof mod.PDFParse === "function") {
    let parser: PdfParseV2Instance | null = null;
    try {
      parser = new mod.PDFParse({ data: new Uint8Array(bytes) });
      const textRes = await parser.getText();
      const infoRes = typeof parser.getInfo === "function" ? await parser.getInfo().catch(() => null) : null;
      const text = (textRes?.text ?? "").replace(PDF_PARSE_V2_PAGE_MARKER_RE, "").trim();
      if (text.replace(/\s/g, "").length < 40) {
        return { needsOcr: true, reason: "no extractable text layer (likely scanned)" };
      }
      return { text, title: infoRes?.info?.Title?.trim() || undefined };
    } catch {
      return { needsOcr: true, reason: "pdf parse failed; OCR engine required" };
    } finally {
      if (parser) {
        try {
          await parser.destroy();
        } catch {
          // ignore cleanup failure
        }
      }
    }
  }

  if (typeof mod.default === "function") {
    try {
      const data = await mod.default(bytes);
      const text = (data.text ?? "").replace(PDF_PARSE_V2_PAGE_MARKER_RE, "").trim();
      if (text.replace(/\s/g, "").length < 40) {
        return { needsOcr: true, reason: "no extractable text layer (likely scanned)" };
      }
      return { text, title: data.info?.Title?.trim() || undefined };
    } catch {
      return { needsOcr: true, reason: "pdf parse failed; OCR engine required" };
    }
  }

  return { needsOcr: true, reason: "pdf parser unavailable; OCR engine required" };
}

export type IngestEngine = "auto" | "local" | "mineru" | "mistral";

export interface ExtractDeps {
  /** 测试注入 pdf 抽取(避免真依赖 pdf-parse)。 */
  pdfImpl?: (b: Buffer) => Promise<{ text: string; info?: { Title?: string } }>;
}

/** 按 mime/扩展名路由到 local 抽取器。外部引擎(mineru/mistral)由 proxy 层处理。 */
export async function extractLocal(
  bytes: Buffer,
  mime: string,
  filename: string | undefined,
  deps: ExtractDeps = {},
): Promise<ExtractResult> {
  const ext = (filename ?? "").toLowerCase().split(".").pop() ?? "";
  const m = mime.toLowerCase();
  if (m.includes("pdf") || ext === "pdf") return extractPdf(bytes, deps.pdfImpl);
  if (m.includes("html") || ext === "html" || ext === "htm") return extractHtml(bytes);
  if (
    m.startsWith("text/") ||
    m.includes("markdown") ||
    ext === "txt" ||
    ext === "md" ||
    ext === "markdown" ||
    ext === ""
  ) {
    return extractPlainText(bytes);
  }
  // caj/扫描类 / 未知二进制 → 需 OCR 引擎(local 处理不了)
  if (ext === "caj" || ext === "kdh") {
    return { needsOcr: true, reason: "CAJ/KDH requires caj2pdf + OCR engine" };
  }
  return { needsOcr: true, reason: `unsupported type ${mime || ext}; OCR/specialized engine required` };
}

// ── span 切分 + 文档铸造 ──────────────────────────────────────────────

/** 把抽出的文本切成 span(段落级:空行分段;追踪 markdown 标题作 sectionPath)。 */
export function splitSpans(text: string): Span[] {
  const spans: Span[] = [];
  let section: string[] = [];
  let idx = 0;
  let offset = 0;
  // 以原始文本的换行边界切段,保留精确 charStart/charEnd(便于回查子串)
  // CRLF 归一,使 \r\n\r\n 也能按空行分段(否则 Windows 文本不切段)
  const paras = text.split(/(?:\r?\n){2,}/);
  let cursor = 0;
  for (const para of paras) {
    if (spans.length >= MAX_SPANS) break; // 上限:防超多小段刷爆
    const start = text.indexOf(para, cursor);
    const realStart = start >= 0 ? start : cursor;
    const realEnd = realStart + para.length;
    cursor = realEnd;
    const trimmed = para.trim();
    if (!trimmed) {
      offset = realEnd;
      continue;
    }
    // markdown 标题 → 更新 section 路径
    const head = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (head) {
      const level = head[1].length;
      section = section.slice(0, level - 1);
      section[level - 1] = head[2].trim();
      section = section.filter((s) => s !== undefined);
    }
    spans.push({
      spanId: `s${idx}`,
      sectionPath: [...section],
      charStart: realStart,
      charEnd: realEnd,
      text: para,
    });
    idx++;
    offset = realEnd;
  }
  void offset;
  return spans;
}

export interface MintDocInput {
  text: string;
  title?: string;
  sourceBlobId?: string;
  references?: ReferenceEntry[];
  langOverride?: DocLang;
}

/** 从抽出的文本铸造不可变 NormalizedDocument(docId 内容派生)。 */
export function mintDocument(input: MintDocInput): NormalizedDocument {
  const text = input.text;
  const spans = splitSpans(text);
  const lang = input.langOverride ?? guessLang(text);
  const contentSha256 = sha256(text);
  // docId 内容派生:span 文本序列的 hash(同内容 → 同 docId,容器无法冒名换 id)
  const docId = `doc:${sha256(spans.map((s) => `${s.spanId} ${s.text}`).join("")).slice(0, 32)}`;
  return {
    docId,
    contentSha256,
    sourceBlobId: input.sourceBlobId,
    lang,
    title: input.title,
    spans,
    references: input.references ?? [],
  };
}
