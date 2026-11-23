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

// ── PDF 标题启发式过滤与前部正文抽取 ────────────────────────────────────

const PDF_TITLE_TEMPLATE_OR_BOILERPLATE_RE =
  /(?:\btemplate\s+for\s+manuscripts?\b|\b(?:latex|word|manuscript|article|paper|journal|author)\s+template\b|\bmanuscript\s+template\b|^(?:preprint(?:\b|$)|under\s+review\b|manuscript\s+submitted\s+to\b|submitted\s+to\b|published\s+(?:as|in)\b|accepted\s+(?:for|at|in|by)\b|working\s+paper\b|review\s+copy\b|author\s+manuscript\b|draft(?:\s+(?:only|version|copy|manuscript|v\d+))?\s*$|confidential(?:\s+(?:draft|only|report|manuscript|do\s+not\s+distribute))?\s*$|in\s+press\b|for\s+peer\s+review\b|to\s+appear\s+in\b)|^(?:untitled|document\d*|microsoft\s+word\s*-|powerpoint\s+presentation|latex|tex\s+output|dvips|pdftex|overleaf)\b)/i;

const PDF_FILENAME_RE = /^[^\s]+\.(?:pdf|tex|docx?|rtf|dvi|ps|md|txt)$/i;
const PDF_URL_OR_DOI_RE = /^(?:https?:\/\/|www\.|doi\s*:|10\.\d{4,}\/)/i;
const PDF_ARXIV_STAMP_RE = /\barxiv\s*:\s*(?:\d{4}\.\d{4,5}|[a-z-]+\/\d{7})(?:v\d+)?\b/i;
const PDF_PAGE_NUM_RE = /^(?:-\s*\d+\s*-|\d{1,4}|\d+\s*\/\s*\d+|(?:page|p\.?)\s*\d+(?:\s*(?:of|\/)\s*\d+)?)$/i;
const PDF_DATE_LINE_RE =
  /^(?:(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:,?\s+\d{4})?|\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{4}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{4}|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)$/i;
const PDF_COPYRIGHT_OR_LICENSE_RE =
  /^(?:©|\(c\)|copyright\b|the\s+creative\s+commons\b|creative\s+commons\b|this\s+work\s+is\s+distributed\s+under\b|licensed\s+under\b|all\s+rights\s+reserved\b)/i;
const PDF_JOURNAL_CITATION_HEADER_RE =
  /(?:,\s*(?:vol\.?\s*)?\d+\s*,\s*(?:pp?\.?\s*)?[a-z]?\d+(?:\s*[-–—]\s*[a-z]?\d+)?\s*,\s*(?:19|20)\d{2}\b|\bvol\.?\s*\d+\s*,?\s*no\.?\s*\d+|\bissn\s*[:\s]|\bisbn\s*[:\s]|第\s*\d+\s*卷\s*第\s*\d+\s*期)/i;
const PDF_PUBLISHER_BANNER_RE =
  /^(?:open\s+access|original\s+(?:research|article|paper)|research\s+article|review\s+article|brief\s+communication|short\s+communication|letter|commentary|corrigendum|erratum|model\s+description\s+paper|development\s+and\s+technical\s+paper|methods\s+for\s+assessment\s+of\s+models|geoscientific\s+instrumentation|full\s+length\s+article|regular\s+paper|special\s+issue)\s*$/i;
const PDF_METADATA_FIELD_RE =
  /^(?:correspondence\s*:|corresponding\s+author|e-?mail\s*:|keywords?\s*:|key\s+words?\s*:|index\s+terms|received\s*:|revised\s*:|accepted\s*:|published\s*:|edited\s+by\s*:|reviewed\s+by\s*:|discussion\s+started\s*:|doi\s*:|收稿日期|修回日期|基金项目|作者简介|通讯作者|关键词)/i;
const PDF_STOP_BEFORE_BODY_RE =
  /^(?:abstract|summary|摘要|1\.?\s+introduction|i\.?\s+introduction|1\.?\s*引言)\b/i;
const PDF_AFFILIATION_RE =
  /^(?:\d+\s*)?(?:department\s+of|school\s+of|institute\s+(?:of|for)|faculty\s+of|college\s+of|university\s+of|laboratory\s+(?:of|for)|center\s+for|centre\s+for|key\s+laboratory\s+of|state\s+key\s+laboratory)\b/i;

function normalizeInlineSpace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 判断 PDF 元数据 /Title 或页眉行是否为模板、运行页眉、页码、日期、DOI、版权等无效标题。 */
export function isUselessPdfTitle(raw: string | undefined): boolean {
  if (!raw) return true;
  const s = normalizeInlineSpace(raw);
  if (s.length < 4 || s.length > 300) return true;
  if (!/\p{L}/u.test(s)) return true;
  if (PDF_TITLE_TEMPLATE_OR_BOILERPLATE_RE.test(s)) return true;
  if (PDF_FILENAME_RE.test(s)) return true;
  if (PDF_URL_OR_DOI_RE.test(s)) return true;
  if (PDF_ARXIV_STAMP_RE.test(s)) return true;
  if (PDF_PAGE_NUM_RE.test(s)) return true;
  if (PDF_DATE_LINE_RE.test(s)) return true;
  if (PDF_COPYRIGHT_OR_LICENSE_RE.test(s)) return true;
  if (PDF_JOURNAL_CITATION_HEADER_RE.test(s)) return true;
  if (PDF_PUBLISHER_BANNER_RE.test(s)) return true;
  if (PDF_METADATA_FIELD_RE.test(s)) return true;
  return false;
}

function looksLikeAuthorOrMetaLine(line: string): boolean {
  if (line.includes("@")) return true;
  if (PDF_METADATA_FIELD_RE.test(line) || PDF_AFFILIATION_RE.test(line)) return true;
  // 带上标数字/字母/星号标记的作者行, 如 "Alice Smith1, Bob Jones2" 或 "Jane Doe a , John Smith b" 或 "张三1,2 李四1"
  if (
    /[A-Za-z\u3400-\u9fff][*†‡§]?(?:\d+(?:,\d+)*)\s*(?:,|$|\s+[A-Z\u3400-\u9fff])/.test(line) &&
    !/\b(?:v\d+|\d+\.\d+)\b/i.test(line)
  ) {
    return true;
  }
  if (/\b[A-Z][a-z]+\s+[A-Z][a-z]+\s+[a-d](?:\s*,|\s*$)/.test(line)) return true;
  // 逗号分隔的多名西文作者 (如 "Alice Smith, Bob Jones, and Carol Lee" 或 "A. Smith, B. Jones")
  const commaParts = line.split(/,\s*(?:and\s+)?|\s+and\s+/).map((p) => p.trim()).filter(Boolean);
  if (
    commaParts.length >= 2 &&
    commaParts.every((p) => /^(?:[A-Z]\.?\s+){0,2}[A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+){0,2}[*†‡\d,\s]*$/.test(p))
  ) {
    return true;
  }
  // 空白或逗号分隔的中文作者行 (如 "张三, 李四, 王五" 或 "张三1 李四2")
  const cjkParts = line.split(/[，,\s]+/).map((p) => p.trim()).filter(Boolean);
  if (cjkParts.length >= 2 && cjkParts.every((p) => /^[\u3400-\u9fff]{2,4}[*†\d,]*$/.test(p))) {
    return true;
  }
  return false;
}

function isShortMastheadCandidate(lines: string[]): boolean {
  const joined = normalizeInlineSpace(lines.join(" "));
  const words = joined.split(/\s+/).filter(Boolean);
  return joined.length <= 45 && words.length <= 5 && !/[:：]/.test(joined);
}

/** 从 PDF 前部真实正文行推断高置信度标题(过滤模板页眉/运行页眉/版权/DOI/日期/期刊徽标)。 */
function inferTitleFromPdfText(text: string): string | undefined {
  const rawLines = text.split(/\r?\n/).slice(0, 80);
  const collected: string[] = [];
  let seenNonEmpty = 0;

  for (let i = 0; i < rawLines.length && seenNonEmpty < 40; i++) {
    const line = normalizeInlineSpace(rawLines[i] ?? "");
    if (!line) {
      // 已经收集到合理长度标题时,空行通常标志标题块结束
      if (collected.length > 0 && normalizeInlineSpace(collected.join(" ")).length >= 12) {
        break;
      }
      continue;
    }
    seenNonEmpty++;

    if (PDF_STOP_BEFORE_BODY_RE.test(line)) break;

    // 遇到期刊文章类型徽标(如 Copernicus 的 "Open Access" / "Model description paper"):
    // 若此前仅收集到极短期刊徽标碎片(如 "Geoscientific" / "Model Development"),清空重来。
    if (PDF_PUBLISHER_BANNER_RE.test(line)) {
      if (collected.length > 0 && isShortMastheadCandidate(collected)) {
        collected.length = 0;
      }
      continue;
    }

    if (isUselessPdfTitle(line)) {
      if (collected.length > 0 && normalizeInlineSpace(collected.join(" ")).length >= 12) {
        break;
      }
      continue;
    }

    if (looksLikeAuthorOrMetaLine(line)) {
      if (collected.length > 0) break;
      continue;
    }

    // 纯长无空格串(如测试桩 "AAAA...")或明显正文多句段落不作标题
    if (line.length > 220) {
      if (collected.length > 0) break;
      continue;
    }
    if (!CJK_RE.test(line) && !/\s/.test(line) && line.length >= 40) {
      continue;
    }

    if (collected.length === 0) {
      collected.push(line);
      // 中文标题通常单行居多;西文长标题常跨 2-3 行
      if (CJK_RE.test(line) && line.length >= 10) {
        const nextRaw = normalizeInlineSpace(rawLines[i + 1] ?? "");
        if (!nextRaw || looksLikeAuthorOrMetaLine(nextRaw) || PDF_STOP_BEFORE_BODY_RE.test(nextRaw)) {
          break;
        }
      }
      continue;
    }

    const currentLen = normalizeInlineSpace(collected.join(" ")).length;
    if (collected.length >= 3 || currentLen + line.length + 1 > 240) break;
    // 若前一行已以句号/问号/感叹号结束且长度足够,通常是正文而非续行标题
    if (/[.!?。！？]$/.test(collected[collected.length - 1]!) && currentLen >= 25) break;
    collected.push(line);
  }

  if (collected.length === 0) return undefined;
  const candidate = normalizeInlineSpace(collected.join(" ").replace(/-\s+/g, "-"));
  return isUselessPdfTitle(candidate) ? undefined : candidate;
}

/** 综合 PDF 元数据 /Title 与前部正文启发式提取标题(拒模板/页眉垃圾,补齐缺 /Title 的论文)。 */
export function extractPdfTitle(text: string, metadataTitle?: string): string | undefined {
  const cleanedMeta = metadataTitle ? normalizeInlineSpace(metadataTitle) : "";
  if (cleanedMeta && !isUselessPdfTitle(cleanedMeta)) {
    return cleanedMeta;
  }
  return inferTitleFromPdfText(text);
}

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
      return { text, title: extractPdfTitle(text, data.info?.Title) };
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
      return { text, title: extractPdfTitle(text, infoRes?.info?.Title) };
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
      return { text, title: extractPdfTitle(text, data.info?.Title) };
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

const STANDALONE_ACADEMIC_SECTION_RE =
  /^(?:abstract|summary|introduction|background|related\s+work|methods?|methodology|materials?\s+and\s+methods?|experimental(?:\s+setup|\s+design)?|model\s+description|results?(?:\s+and\s+discussion)?|discussion|conclusions?|acknowledg(?:e)?ments?|code\s+and\s+data\s+availability|code\s+availability|data\s+availability|author\s+contributions?|competing\s+interests?|funding|references|bibliography|supplementary\s+(?:information|materials?)|appendix(?:\s+[A-Z0-9]+(?:\s*[:.\-–—]\s*[^\n]{1,70})?)?|摘要|引言|绪论|相关工作|研究方法|方法|实验(?:设置|设计|结果)?|结果(?:与讨论|分析)?|讨论|结论|致谢|参考文献|附录(?:\s*[A-Z0-9一二三四五六七八九十]+)?)\s*[:：]?$/i;
const INLINE_ABSTRACT_RE = /^(abstract|摘要)\s*[.:：]\s+\S/i;
const NUMBERED_ACADEMIC_HEADING_RE = /^(\d{1,2}(?:\.\d{1,2}){0,2})\.?\s+(.+)$/;
const ROMAN_ACADEMIC_HEADING_RE = /^([IVX]{1,4})\.\s+([A-Z][A-Za-z0-9\s\-–—:&/()]{2,80})$/;
const NON_HEADING_CAPTION_RE = /^(?:fig\.?|figure|table|eq\.?|equation|algorithm|listing|box)\b/i;
const MONTH_PREFIX_RE =
  /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{4}$/i;
const REFERENCES_SECTION_RE = /^(?:references|bibliography|参考文献)\b/i;
const APPENDIX_SECTION_RE = /^(?:appendix|附录)\b/i;

function matchSectionHeading(
  line: string,
  inReferences: boolean,
): { level: number; heading: string; entersReferences?: boolean; exitsReferences?: boolean } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // 1) Markdown 标题
  const md = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (md) {
    const heading = md[2].trim();
    return {
      level: md[1].length,
      heading,
      entersReferences: REFERENCES_SECTION_RE.test(heading),
      exitsReferences: APPENDIX_SECTION_RE.test(heading),
    };
  }

  // 2) 标准学术无编号节标题(如 Abstract / Methods / Code and data availability / References / 摘要 / 参考文献)
  if (STANDALONE_ACADEMIC_SECTION_RE.test(trimmed)) {
    const heading = trimmed.replace(/[:：]$/, "").trim();
    return {
      level: 1,
      heading,
      entersReferences: REFERENCES_SECTION_RE.test(heading),
      exitsReferences: APPENDIX_SECTION_RE.test(heading),
    };
  }

  if (inReferences) return null;

  // 3) 编号学术节标题(如 "1 Introduction", "2.1 Model description", "3.2.1 Sensitivity", "1 引言")
  const num = trimmed.match(NUMBERED_ACADEMIC_HEADING_RE);
  if (num) {
    const numStr = num[1]!;
    const titlePart = num[2]!.trim();
    const topNum = Number(numStr.split(".")[0]);
    const wordCount = CJK_RE.test(titlePart) ? 0 : titlePart.split(/\s+/).length;
    const digitGroups = (titlePart.match(/\d+/g) ?? []).length;
    if (
      topNum >= 1 &&
      topNum <= 30 &&
      titlePart.length >= 2 &&
      titlePart.length <= 90 &&
      /^[A-Z\u3400-\u9fff]/.test(titlePart) &&
      !/[.,;!?，。；！？]$/.test(titlePart) &&
      !/https?:\/\/|doi:|@|±/i.test(titlePart) &&
      !NON_HEADING_CAPTION_RE.test(titlePart) &&
      !MONTH_PREFIX_RE.test(titlePart) &&
      wordCount <= 12 &&
      digitGroups < 3
    ) {
      return {
        level: numStr.split(".").length,
        heading: trimmed,
        entersReferences: REFERENCES_SECTION_RE.test(titlePart),
        exitsReferences: APPENDIX_SECTION_RE.test(titlePart),
      };
    }
  }

  // 4) 罗马数字节标题(IEEE 风格: "I. INTRODUCTION", "II. RELATED WORK")
  const roman = trimmed.match(ROMAN_ACADEMIC_HEADING_RE);
  if (roman) {
    const titlePart = roman[2]!.trim();
    if (!/[.,;]$/.test(titlePart) && titlePart.split(/\s+/).length <= 10) {
      return { level: 1, heading: trimmed };
    }
  }

  return null;
}

/**
 * 把无空行的 PDF 页文本在独立学术节标题处切成子块,同时保持原始字符序列与精确 offset。
 */
function splitParagraphOnHeadings(
  para: string,
  paraStart: number,
  initialInReferences: boolean,
): Array<{ text: string; start: number; end: number }> {
  if (!para.includes("\n")) {
    return [{ text: para, start: paraStart, end: paraStart + para.length }];
  }
  const chunks: Array<{ text: string; start: number; end: number }> = [];
  const lineRe = /[^\r\n]*(?:\r?\n|$)/g;
  let chunkStart = 0;
  let hasContent = false;
  let inRef = initialInReferences;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(para)) !== null) {
    const rawLine = m[0];
    if (rawLine.length === 0) break;
    const lineStart = m.index;
    const lineText = rawLine.replace(/\r?\n$/, "");
    const heading =
      matchSectionHeading(lineText, inRef) ??
      (INLINE_ABSTRACT_RE.test(lineText.trim()) ? { level: 1, heading: "Abstract" } : null);
    if (heading && hasContent) {
      const slice = para.slice(chunkStart, lineStart).replace(/(?:\r?\n)+$/, "");
      if (slice.trim()) {
        chunks.push({ text: slice, start: paraStart + chunkStart, end: paraStart + chunkStart + slice.length });
      }
      chunkStart = lineStart;
    }
    if (heading) {
      if (heading.entersReferences) inRef = true;
      else if (heading.exitsReferences) inRef = false;
    }
    if (lineText.trim()) hasContent = true;
  }
  const tail = para.slice(chunkStart).replace(/(?:\r?\n)+$/, "");
  if (tail.trim()) {
    chunks.push({ text: tail, start: paraStart + chunkStart, end: paraStart + chunkStart + tail.length });
  }
  return chunks.length > 0 ? chunks : [{ text: para, start: paraStart, end: paraStart + para.length }];
}

/** 把抽出的文本切成 span(段落级:空行分段;追踪 markdown 与学术 PDF 章节标题作 sectionPath)。 */
export function splitSpans(text: string): Span[] {
  const spans: Span[] = [];
  let section: string[] = [];
  let inReferences = false;
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
    if (!para.trim()) {
      offset = realEnd;
      continue;
    }
    const subChunks = splitParagraphOnHeadings(para, realStart, inReferences);
    for (const chunk of subChunks) {
      if (spans.length >= MAX_SPANS) break;
      const trimmed = chunk.text.trim();
      if (!trimmed) continue;
      const firstLine = trimmed.split(/\r?\n/, 1)[0]!.trim();
      const head = matchSectionHeading(firstLine, inReferences);
      if (head) {
        section = section.slice(0, head.level - 1);
        section[head.level - 1] = head.heading;
        section = section.filter((s) => s !== undefined);
        if (head.entersReferences) inReferences = true;
        else if (head.exitsReferences) inReferences = false;
      } else {
        const inlineAbs = firstLine.match(INLINE_ABSTRACT_RE);
        if (inlineAbs) {
          section = [inlineAbs[1] === "摘要" ? "摘要" : "Abstract"];
        }
      }
      spans.push({
        spanId: `s${idx}`,
        sectionPath: [...section],
        charStart: chunk.start,
        charEnd: chunk.end,
        text: chunk.text,
      });
      idx++;
    }
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
