/**
 * 原文权威 Span 定位查询(uid + docId + spanId 租户归属校验)。
 *
 * 证据权威红线:
 *   - 严格按 `(userId, docId)` 回查 master 权威 `research_documents`,跨用户或不存在
 *     统一返回 null(不泄漏他人文档存在性)。
 *   - 返回权威 `quote` 正文(verbatim `span.text`)、页码推断(显式 page / section /
 *     PDF form-feed `\f` / 字符偏移估算)及前后文邻接 span 片段,供 UI 引用溯源弹窗展示。
 */

import type { DocLang, NormalizedDocument, SourceRecord, Span } from "@openclaude/protocol/research";
import { getDocument as storeGetDocument } from "./store.js";

const DEFAULT_CONTEXT_WINDOW = 2;
const MAX_CONTEXT_WINDOW = 5;
const DEFAULT_MAX_CONTEXT_CHARS = 600;
const MAX_CONTEXT_CHARS = 2000;
const ESTIMATED_CHARS_PER_PAGE = 3000;

export type SpanPageSource = "explicit" | "section" | "formfeed" | "estimated";

export interface ContextSpanSnippet {
  spanId: string;
  text: string;
  charStart: number;
  charEnd: number;
}

export interface LocatedSpan {
  docId: string;
  title: string | null;
  lang: DocLang;
  spanId: string;
  spanIndex: number;
  totalSpans: number;
  sectionPath: string[];
  charStart: number;
  charEnd: number;
  page: number;
  pageSource: SpanPageSource;
  /** 权威原文 quote(verbatim span.text,不改写)。 */
  quote: string;
  contextBefore: string;
  contextAfter: string;
  beforeSpans: ContextSpanSnippet[];
  afterSpans: ContextSpanSnippet[];
  verifiedSource?: SourceRecord;
}

export interface LocateSpanOptions {
  /** 前后各取多少个邻接 span(默认 2,上限 5)。 */
  contextWindow?: number;
  /** 前/后文拼接文本各自最大字符数(默认 600,上限 2000)。 */
  maxContextChars?: number;
}

export interface SpanLocatorDeps {
  getDocument?: (userId: bigint | number | string, docId: string) => Promise<NormalizedDocument | null>;
}

const SAFE_DOC_ID_RE = /^[A-Za-z0-9:_-]{1,128}$/;
const SAFE_SPAN_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function isValidDocId(docId: string): boolean {
  return SAFE_DOC_ID_RE.test(docId);
}

export function isValidSpanId(spanId: string): boolean {
  return SAFE_SPAN_ID_RE.test(spanId);
}

function inferSpanPage(doc: NormalizedDocument, spanIndex: number): { page: number; pageSource: SpanPageSource } {
  const target = doc.spans[spanIndex]!;
  // 1) 显式扩展字段(若上游解析器如 MinerU/Mistral 写入了 page)
  const explicit = (target as Span & { page?: unknown }).page;
  if (typeof explicit === "number" && Number.isInteger(explicit) && explicit >= 1) {
    return { page: explicit, pageSource: "explicit" };
  }
  // 2) sectionPath 中带页码标记(如 "page:3" / "Page 3" / "p.3")
  for (const seg of target.sectionPath) {
    const m = /^(?:page[:\s]+|p\.\s*)(\d{1,5})$/i.exec(seg.trim());
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n >= 1) return { page: n, pageSource: "section" };
    }
  }
  // 3) PDF 文字层分页符(\f):pdf-parse 在每页之间插入 \f
  let hasFormFeed = false;
  let pageBreaksBefore = 0;
  for (let i = 0; i < doc.spans.length; i++) {
    const t = doc.spans[i]!.text;
    if (t.includes("\f")) {
      hasFormFeed = true;
      if (i < spanIndex) {
        pageBreaksBefore += t.split("\f").length - 1;
      }
    }
  }
  if (hasFormFeed) {
    return { page: pageBreaksBefore + 1, pageSource: "formfeed" };
  }
  // 4) 纯文本/Markdown 兜底:按 charStart 确定性估算 1-based 页码
  const page = Math.max(1, Math.floor(Math.max(0, target.charStart) / ESTIMATED_CHARS_PER_PAGE) + 1);
  return { page, pageSource: "estimated" };
}

function clipTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `…${text.slice(text.length - Math.max(1, maxChars - 1))}`;
}

function clipHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

/** 纯函数:在已校验归属的权威文档内定位指定 span 并构建前后文窗口。 */
export function locateDocumentSpan(
  doc: NormalizedDocument,
  spanId: string,
  opts: LocateSpanOptions = {},
): LocatedSpan | null {
  const idx = doc.spans.findIndex((s) => s.spanId === spanId);
  if (idx < 0) return null;

  const span = doc.spans[idx]!;
  const win = Math.min(Math.max(Math.floor(opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW), 0), MAX_CONTEXT_WINDOW);
  const maxChars = Math.min(
    Math.max(Math.floor(opts.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS), 50),
    MAX_CONTEXT_CHARS,
  );

  const beforeStart = Math.max(0, idx - win);
  const afterEnd = Math.min(doc.spans.length, idx + 1 + win);

  const beforeSpans: ContextSpanSnippet[] = doc.spans.slice(beforeStart, idx).map((s) => ({
    spanId: s.spanId,
    text: s.text,
    charStart: s.charStart,
    charEnd: s.charEnd,
  }));
  const afterSpans: ContextSpanSnippet[] = doc.spans.slice(idx + 1, afterEnd).map((s) => ({
    spanId: s.spanId,
    text: s.text,
    charStart: s.charStart,
    charEnd: s.charEnd,
  }));

  const contextBefore = clipTail(beforeSpans.map((s) => s.text).join("\n\n"), maxChars);
  const contextAfter = clipHead(afterSpans.map((s) => s.text).join("\n\n"), maxChars);
  const { page, pageSource } = inferSpanPage(doc, idx);

  return {
    docId: doc.docId,
    title: doc.title ?? null,
    lang: doc.lang,
    spanId: span.spanId,
    spanIndex: idx,
    totalSpans: doc.spans.length,
    sectionPath: [...span.sectionPath],
    charStart: span.charStart,
    charEnd: span.charEnd,
    page,
    pageSource,
    quote: span.text,
    contextBefore,
    contextAfter,
    beforeSpans,
    afterSpans,
    ...(doc.verifiedSource ? { verifiedSource: doc.verifiedSource } : {}),
  };
}

/** 按 (userId, docId, spanId) 校验租户归属并定位原文权威 span。 */
export async function getResearchSpanForUser(
  userId: bigint | number | string,
  docId: string,
  spanId: string,
  opts: LocateSpanOptions = {},
  deps: SpanLocatorDeps = {},
): Promise<LocatedSpan | null> {
  if (!isValidDocId(docId) || !isValidSpanId(spanId)) return null;
  const getDoc = deps.getDocument ?? storeGetDocument;
  const doc = await getDoc(userId, docId);
  if (!doc) return null;
  return locateDocumentSpan(doc, spanId, opts);
}
