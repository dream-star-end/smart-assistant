/**
 * 科研文献批量导入核心逻辑(DOI / arXiv ID / BibTeX 解析、去重、限流与课题挂载)。
 *
 * 设计红线(B1 + N1 + N2):
 *   - 严格 DAG 依赖:本模块依赖 library.ts 基础原语,library.ts 绝不反向导入本模块,
 *     保证任何入口单独 import batchImport.ts 零 ESM 循环初始化异常。
 *   - 出版身份与正文权威分离(protocol/src/research.ts §2):
 *     * 书目解析(`bibliographicResolved`)仅证明标识符存在;
 *     * 严禁将用户提交的 BibTeX abstract/字段混入带 `verifiedSource` 的文档;
 *     * 仅当正文完全来自可信上游(如 master 从 Crossref/arXiv 拉取的官方摘要或 OA 全文,
 *       零用户文本混入)时,才为 `NormalizedDocument` 挂 `verifiedSource`。
 *   - 单遍预算扫描:解析 BibTeX / rawText 超过 `maxItems` 立即提前终止,防 DoS。
 */

import type { NormalizedDocument, SourceRecord } from "@openclaude/protocol/research";
import { getResearchConfigPublic, type ResearchConfigPublic } from "../admin/researchConfig.js";
import { type CiteDeps, parseIdentifier, resolveArxiv, resolveDoi } from "./cite.js";
import { mintDocument } from "./ingest.js";
import {
  addMembership,
  resolveWorkspaceProjectId,
} from "./library.js";
import { normalizeArxivId, normalizeDoi } from "./sources.js";
import { getDocument as storeGetDocument, putDocument as storePutDocument } from "./store.js";
import { isResearchWorkspaceEnabled } from "./workspaceFlag.js";

export const MAX_BATCH_IMPORT_ITEMS = 50;
export const MAX_IMPORT_BODY_BYTES = 256 * 1024;
export const DEFAULT_USER_IMPORT_WINDOW_MS = 60_000;
export const DEFAULT_USER_IMPORT_MAX_BATCHES = 10;
export const DEFAULT_USER_IMPORT_MAX_ITEMS = 100;
const LIMITER_LRU_SIZE = 10_000;
const IMPORT_CONCURRENCY = 4;

export class BatchImportValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BatchImportValidationError";
    this.code = code;
  }
}

export interface ParsedBibtexEntry {
  entryType: string;
  citationKey: string;
  title?: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  abstract?: string;
  raw: string;
}

export interface BatchImportCandidate {
  /** 去重归一键(如 doi:10.xxx / arxiv:2301.00001 / bib:key)。 */
  dedupeKey: string;
  /** 原始输入表示(用于向调用方回显)。 */
  raw: string;
  scheme: "doi" | "arxiv" | "bibtex";
  doi?: string;
  arxivId?: string;
  bibtex?: ParsedBibtexEntry;
}

export interface BatchImportInput {
  identifiers?: string[];
  bibtex?: string;
  rawText?: string;
  projectId?: string;
}

export interface BatchImportItemResult {
  dedupeKey: string;
  raw: string;
  docId: string;
  title: string | null;
  spanCount: number;
  source: "crossref" | "arxiv" | "bibtex";
  /** 上游书目标识符是否已解析命中(独立于正文是否权威验证)。 */
  bibliographicResolved: boolean;
  /** 权威正文是否 100% 来自可信上游且已挂 `verifiedSource`。 */
  fulltextVerified: boolean;
  /** 与 `fulltextVerified` 等价:是否可作为已发表文献被 `oc-cite check` 铸造 `identifierVerified=true`。 */
  verified: boolean;
  /** 上游解析到的书目元数据(分离存储,不冒充未验证正文的出版背书)。 */
  resolvedSource?: SourceRecord;
  /** 混合来源(含用户自填 BibTeX 文本)时显式标注,提醒调用方正文未获出版背书。 */
  userSuppliedTextUnverified?: boolean;
  projectId?: string;
}

export interface BatchImportDuplicate {
  dedupeKey: string;
  raw: string;
  reason: "duplicate_in_batch" | "already_in_library";
  existingDocId?: string;
}

export interface BatchImportFailure {
  dedupeKey: string;
  raw: string;
  reason: string;
}

export interface BatchImportOutcome {
  ok: true;
  totalSubmitted: number;
  imported: BatchImportItemResult[];
  duplicates: BatchImportDuplicate[];
  failed: BatchImportFailure[];
  projectId?: string;
}

export interface UserImportLimiter {
  check(userId: string, itemCount: number, now?: number): { allowed: boolean; retryAfterMs?: number };
}

interface UserImportBucket {
  entries: Array<{ ts: number; items: number }>;
  lastSeen: number;
}

/** 每用户滑窗限流器(LRU 封顶防内存泄漏,同 researchProxy makePerContainerLimiter)。 */
export function makeUserImportLimiter(
  windowMs = DEFAULT_USER_IMPORT_WINDOW_MS,
  maxBatches = DEFAULT_USER_IMPORT_MAX_BATCHES,
  maxItems = DEFAULT_USER_IMPORT_MAX_ITEMS,
): UserImportLimiter {
  const buckets = new Map<string, UserImportBucket>();
  return {
    check(userId, itemCount, now = Date.now()) {
      const count = Math.max(1, Math.floor(itemCount));
      let b = buckets.get(userId);
      if (!b) {
        b = { entries: [], lastSeen: now };
        buckets.set(userId, b);
        if (buckets.size > LIMITER_LRU_SIZE) {
          let oldestK: string | null = null;
          let oldestT = Number.POSITIVE_INFINITY;
          for (const [k, v] of buckets) {
            if (v.lastSeen < oldestT) {
              oldestT = v.lastSeen;
              oldestK = k;
            }
          }
          if (oldestK !== null) buckets.delete(oldestK);
        }
      }
      b.lastSeen = now;
      const cutoff = now - windowMs;
      b.entries = b.entries.filter((e) => e.ts > cutoff);
      const usedItems = b.entries.reduce((acc, e) => acc + e.items, 0);
      if (b.entries.length >= maxBatches || usedItems + count > maxItems) {
        const oldestTs = b.entries[0]?.ts ?? now;
        const retryAfterMs = Math.max(1000, oldestTs + windowMs - now);
        return { allowed: false, retryAfterMs };
      }
      b.entries.push({ ts: now, items: count });
      return { allowed: true };
    },
  };
}

// ── BibTeX 解析器(单遍有界预算扫描,支持嵌套花括号与引号字段) ─────────────────

function cleanBibValue(raw: string): string {
  return raw
    .replace(/\\&/g, "&")
    .replace(/\\%/g, "%")
    .replace(/\\_/g, "_")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseBibFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;
  const len = body.length;
  while (i < len) {
    while (i < len && /[\s,]/.test(body[i]!)) i++;
    if (i >= len) break;
    const keyStart = i;
    while (i < len && /[A-Za-z0-9_-]/.test(body[i]!)) i++;
    const key = body.slice(keyStart, i).toLowerCase();
    while (i < len && /\s/.test(body[i]!)) i++;
    if (!key || body[i] !== "=") {
      while (i < len && body[i] !== ",") i++;
      continue;
    }
    i++; // consume '='
    while (i < len && /\s/.test(body[i]!)) i++;
    if (i >= len) break;

    let val = "";
    const ch = body[i]!;
    if (ch === "{") {
      let depth = 0;
      const start = i + 1;
      while (i < len) {
        if (body[i] === "\\" && i + 1 < len) {
          i += 2;
          continue;
        }
        if (body[i] === "{") depth++;
        else if (body[i] === "}") {
          depth--;
          if (depth === 0) {
            val = body.slice(start, i);
            i++;
            break;
          }
        }
        i++;
      }
    } else if (ch === '"') {
      i++;
      const start = i;
      let depth = 0;
      while (i < len) {
        if (body[i] === "\\" && i + 1 < len) {
          i += 2;
          continue;
        }
        if (body[i] === "{") depth++;
        else if (body[i] === "}" && depth > 0) depth--;
        else if (body[i] === '"' && depth === 0) {
          val = body.slice(start, i);
          i++;
          break;
        }
        i++;
      }
    } else {
      const start = i;
      while (i < len && body[i] !== "," && body[i] !== "\n" && body[i] !== "\r") i++;
      val = body.slice(start, i).trim();
    }
    fields[key] = cleanBibValue(val);
  }
  return fields;
}

const SKIP_BIB_TYPES = new Set(["comment", "preamble", "string"]);

function parseSingleBibBlock(
  text: string,
  atIdx: number,
): { entry: ParsedBibtexEntry | null; nextPos: number; consumed: boolean } {
  const len = text.length;
  let i = atIdx + 1;
  while (i < len && /[A-Za-z]/.test(text[i]!)) i++;
  const entryType = text.slice(atIdx + 1, i).toLowerCase();
  while (i < len && /\s/.test(text[i]!)) i++;
  const openCh = text[i];
  if (!entryType || (openCh !== "{" && openCh !== "(")) {
    return { entry: null, nextPos: atIdx + 1, consumed: false };
  }
  const closeCh = openCh === "{" ? "}" : ")";
  let depth = 0;
  const blockStart = i + 1;
  let blockEnd = -1;
  let inQuotes = false;
  while (i < len) {
    const c = text[i]!;
    if (c === "\\" && i + 1 < len) {
      i += 2;
      continue;
    }
    if (c === '"' && depth === 1) inQuotes = !inQuotes;
    if (!inQuotes) {
      if (c === openCh) depth++;
      else if (c === closeCh) {
        depth--;
        if (depth === 0) {
          blockEnd = i;
          i++;
          break;
        }
      }
    }
    i++;
  }
  if (blockEnd < 0) return { entry: null, nextPos: len, consumed: true };
  if (SKIP_BIB_TYPES.has(entryType)) return { entry: null, nextPos: i, consumed: true };

  const inner = text.slice(blockStart, blockEnd);
  const commaIdx = inner.indexOf(",");
  if (commaIdx < 0) return { entry: null, nextPos: i, consumed: true };

  const citationKey = inner.slice(0, commaIdx).trim();
  const fields = parseBibFields(inner.slice(commaIdx + 1));

  const doiRaw = fields.doi || (fields.url?.toLowerCase().includes("doi.org/") ? fields.url : undefined);
  const doi = doiRaw ? normalizeDoi(doiRaw) : undefined;
  const arxivRaw =
    fields.arxiv ||
    fields.arxivid ||
    (fields.eprint && (!fields.archiveprefix || fields.archiveprefix.toLowerCase().includes("arxiv"))
      ? fields.eprint
      : undefined) ||
    (fields.url?.toLowerCase().includes("arxiv.org/") ? fields.url : undefined);
  const arxivId = arxivRaw ? normalizeArxivId(arxivRaw) : undefined;

  const yearMatch = fields.year?.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? Number(yearMatch[0]) : undefined;
  const authors = fields.author
    ? fields.author
        .split(/\s+and\s+/i)
        .map((a) => a.trim())
        .filter(Boolean)
    : [];
  const venue = fields.journal || fields.booktitle || fields.publisher || undefined;

  return {
    entry: {
      entryType,
      citationKey,
      title: fields.title || undefined,
      authors,
      year,
      venue,
      doi,
      arxivId,
      url: fields.url || undefined,
      abstract: fields.abstract || undefined,
      raw: text.slice(atIdx, blockEnd + 1),
    },
    nextPos: i,
    consumed: true,
  };
}

/** 解析原始 BibTeX 文本为结构化条目数组(单遍扫描,带可选 maxEntries 提前退出预算)。 */
export function parseBibtexEntries(raw: string, maxEntries = Number.POSITIVE_INFINITY): ParsedBibtexEntry[] {
  const entries: ParsedBibtexEntry[] = [];
  const text = raw.replace(/\r\n/g, "\n");
  let pos = 0;
  const len = text.length;

  while (pos < len && entries.length < maxEntries) {
    const atIdx = text.indexOf("@", pos);
    if (atIdx < 0) break;
    const { entry, nextPos } = parseSingleBibBlock(text, atIdx);
    pos = nextPos;
    if (entry) entries.push(entry);
  }
  return entries;
}

// ── 输入归一化与批内去重(单遍预算扫描,超上限立刻退出) ─────────────────────────

export interface ParsedBatchCandidates {
  totalSubmitted: number;
  unique: BatchImportCandidate[];
  duplicates: BatchImportDuplicate[];
  invalid: BatchImportFailure[];
}

function candidateFromIdentifier(raw: string): BatchImportCandidate | null {
  const parsed = parseIdentifier(raw);
  if (!parsed) return null;
  if (parsed.scheme === "doi") {
    return { dedupeKey: `doi:${parsed.id}`, raw, scheme: "doi", doi: parsed.id };
  }
  if (parsed.scheme === "arxiv") {
    return { dedupeKey: `arxiv:${parsed.id}`, raw, scheme: "arxiv", arxivId: parsed.id };
  }
  return null;
}

function candidateFromBibtex(entry: ParsedBibtexEntry): BatchImportCandidate | null {
  if (entry.doi) {
    return {
      dedupeKey: `doi:${entry.doi}`,
      raw: entry.citationKey || entry.doi,
      scheme: "doi",
      doi: entry.doi,
      arxivId: entry.arxivId,
      bibtex: entry,
    };
  }
  if (entry.arxivId) {
    return {
      dedupeKey: `arxiv:${entry.arxivId}`,
      raw: entry.citationKey || entry.arxivId,
      scheme: "arxiv",
      arxivId: entry.arxivId,
      bibtex: entry,
    };
  }
  if (entry.title) {
    const normTitle = entry.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
    const key = normTitle ? `title:${normTitle.slice(0, 80)}` : `bib:${entry.citationKey.toLowerCase()}`;
    return {
      dedupeKey: key,
      raw: entry.citationKey || entry.title,
      scheme: "bibtex",
      bibtex: entry,
    };
  }
  return null;
}

/**
 * 解析 identifiers / bibtex / rawText 混合输入并执行批内去重。
 * 单遍扫描:一旦累计条目数超过 `maxItems` 立即抛出 `BATCH_TOO_LARGE`,避免超大输入 CPU/内存浪费。
 */
export function parseBatchImportInput(
  input: BatchImportInput,
  maxItems = MAX_BATCH_IMPORT_ITEMS,
): ParsedBatchCandidates {
  const rawCandidates: Array<{ cand: BatchImportCandidate | null; raw: string }> = [];

  const pushRaw = (cand: BatchImportCandidate | null, raw: string): void => {
    rawCandidates.push({ cand, raw });
    if (rawCandidates.length > maxItems) {
      throw new BatchImportValidationError(
        "BATCH_TOO_LARGE",
        `batch exceeds limit of ${maxItems} items`,
      );
    }
  };

  const pushTokensFromSlice = (slice: string): void => {
    for (const token of slice.split(/[\r\n,;]+/)) {
      const t = token.trim();
      if (!t || t.startsWith("%")) continue;
      pushRaw(candidateFromIdentifier(t), t);
    }
  };

  if (Array.isArray(input.identifiers)) {
    for (const item of input.identifiers) {
      if (typeof item !== "string") continue;
      const trimmed = item.trim();
      if (!trimmed) continue;
      pushRaw(candidateFromIdentifier(trimmed), trimmed);
    }
  }

  if (typeof input.rawText === "string" && input.rawText.trim()) {
    const text = input.rawText.replace(/\r\n/g, "\n");
    let pos = 0;
    const len = text.length;
    while (pos < len) {
      const atIdx = text.indexOf("@", pos);
      if (atIdx < 0) {
        pushTokensFromSlice(text.slice(pos));
        break;
      }
      // 仅当 @ 处于行首或空白/分隔符后才视为 BibTeX 入口(避免误拆 email)
      const prevCh = atIdx > 0 ? text[atIdx - 1]! : "\n";
      const looksBibStart = /[\s,;]/.test(prevCh);
      if (looksBibStart) {
        const probe = parseSingleBibBlock(text, atIdx);
        if (probe.consumed) {
          if (atIdx > pos) pushTokensFromSlice(text.slice(pos, atIdx));
          if (probe.entry) {
            pushRaw(
              candidateFromBibtex(probe.entry),
              probe.entry.citationKey || probe.entry.raw.slice(0, 60),
            );
          }
          pos = probe.nextPos;
          continue;
        }
      }
      const nextStop = text.indexOf("\n", atIdx);
      const end = nextStop >= 0 ? nextStop + 1 : len;
      pushTokensFromSlice(text.slice(pos, end));
      pos = end;
    }
  }

  if (typeof input.bibtex === "string" && input.bibtex.trim()) {
    const remainingBudget = maxItems - rawCandidates.length + 1;
    const bibEntries = parseBibtexEntries(input.bibtex, remainingBudget);
    if (bibEntries.length === 0) {
      pushRaw(null, input.bibtex.trim().slice(0, 80));
    } else {
      for (const entry of bibEntries) {
        pushRaw(candidateFromBibtex(entry), entry.citationKey || entry.raw.slice(0, 60));
      }
    }
  }

  if (rawCandidates.length === 0) {
    throw new BatchImportValidationError(
      "EMPTY_IMPORT",
      "at least one DOI, arXiv ID, or BibTeX entry is required",
    );
  }

  const seen = new Set<string>();
  const unique: BatchImportCandidate[] = [];
  const duplicates: BatchImportDuplicate[] = [];
  const invalid: BatchImportFailure[] = [];

  for (const row of rawCandidates) {
    if (!row.cand) {
      invalid.push({
        dedupeKey: `invalid:${row.raw}`,
        raw: row.raw,
        reason: "unsupported or malformed identifier/bibtex",
      });
      continue;
    }
    if (seen.has(row.cand.dedupeKey)) {
      duplicates.push({ dedupeKey: row.cand.dedupeKey, raw: row.raw, reason: "duplicate_in_batch" });
      continue;
    }
    seen.add(row.cand.dedupeKey);
    unique.push(row.cand);
  }

  return {
    totalSubmitted: rawCandidates.length,
    unique,
    duplicates,
    invalid,
  };
}

// ── 文档铸造与批量导入编排(B1:严格分离书目元数据与可信原文) ──────────────────────

function renderSourceDocumentText(
  title: string,
  authors: string[],
  meta: { year?: number; venue?: string; doi?: string; arxivId?: string; abstract?: string },
): string {
  const lines: string[] = [`# ${title}`];
  const metaParts: string[] = [];
  if (authors.length > 0) metaParts.push(`Authors: ${authors.join(", ")}`);
  if (meta.year) metaParts.push(`Year: ${meta.year}`);
  if (meta.venue) metaParts.push(`Venue: ${meta.venue}`);
  if (meta.doi) metaParts.push(`DOI: ${meta.doi}`);
  if (meta.arxivId) metaParts.push(`arXiv: ${meta.arxivId}`);
  if (metaParts.length > 0) lines.push("", metaParts.join("\n"));
  if (meta.abstract?.trim()) {
    lines.push("", "## Abstract", "", meta.abstract.trim());
  }
  return lines.join("\n");
}

/**
 * 铸造权威已验证文档:100% 源自可信上游 `SourceRecord` + 可信上游官方摘要/全文(`trustedText`),
 * 绝不混入任何用户自填 BibTeX 字段或摘要。
 */
function buildVerifiedDocumentFromTrustedUpstream(
  record: SourceRecord,
  trustedText: string,
): NormalizedDocument {
  const title = record.title || record.doi || record.arxivId || record.id;
  const authors = record.authors.map((a) => a.name);
  const text = renderSourceDocumentText(title, authors, {
    year: record.year,
    venue: record.venue,
    doi: record.doi,
    arxivId: record.arxivId,
    abstract: trustedText,
  });
  const minted = mintDocument({ text, title });
  return {
    ...minted,
    verifiedSource: record,
  };
}

/**
 * 铸造仅书目解析或混合用户 BibTeX 的文档:
 *   - 绝不设置 `verifiedSource`!(防止用户自填 BibTeX abstract/字段借上游 DOI 获得出版背书)
 *   - 上游书目元数据仅通过 `BatchImportItemResult.resolvedSource` 分离返回。
 */
function buildUnverifiedDocument(opts: {
  record?: SourceRecord | null;
  bibtex?: ParsedBibtexEntry;
}): NormalizedDocument {
  const rec = opts.record;
  const bib = opts.bibtex;
  const title = rec?.title || bib?.title || bib?.citationKey || rec?.doi || rec?.arxivId || "Untitled Entry";
  const authors =
    rec && rec.authors.length > 0 ? rec.authors.map((a) => a.name) : (bib?.authors ?? []);
  const text = renderSourceDocumentText(title, authors, {
    year: rec?.year ?? bib?.year,
    venue: rec?.venue ?? bib?.venue,
    doi: rec?.doi ?? bib?.doi,
    arxivId: rec?.arxivId ?? bib?.arxivId,
    abstract: bib?.abstract,
  });
  // 关键不变量(B1):不挂 verifiedSource
  return mintDocument({ text, title });
}

export interface BatchImportDeps {
  readConfig?: () => Promise<ResearchConfigPublic>;
  isWorkspaceEnabled?: () => boolean;
  resolveProjectId?: (userId: string, projectId?: string) => Promise<string>;
  addMembership?: (userId: string, docId: string, projectId: string) => Promise<void>;
  /** 按精确可信标识符(doi/arxivId)查找用户既有文档(避免标题碰撞误去重)。 */
  findExistingDocByIdentifier?: (
    userId: string | number,
    ident: { doi?: string; arxivId?: string },
  ) => Promise<string | null>;
  getDocument?: (userId: number | string, docId: string) => Promise<NormalizedDocument | null>;
  putDocument?: (userId: number | string, doc: NormalizedDocument) => Promise<void>;
  resolveDoiImpl?: (doi: string, deps: CiteDeps) => Promise<SourceRecord | null>;
  resolveArxivImpl?: (arxivId: string, deps: CiteDeps) => Promise<SourceRecord | null>;
  /**
   * 可选可信上游正文/官方摘要获取器(master 侧从 Crossref/arXiv/OA 全文源拉取)。
   * 只有此函数返回非空可信文本且无用户文本混入时,才为文档挂 `verifiedSource`(B1)。
   */
  resolveTrustedTextImpl?: (record: SourceRecord, deps: CiteDeps) => Promise<string | null>;
  maxItems?: number;
  concurrency?: number;
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function loop(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]!);
    }
  }
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => loop());
  await Promise.all(workers);
  return results;
}

/**
 * 批量导入 DOI / arXiv / BibTeX 到用户文献库(支持精确去重、限流前校验、课题挂载)。
 */
export async function importResearchBatch(
  userId: string | number,
  input: BatchImportInput,
  deps: BatchImportDeps = {},
): Promise<BatchImportOutcome | { disabled: true }> {
  const readConfig = deps.readConfig ?? getResearchConfigPublic;
  const cfg = await readConfig();
  if (!cfg.enabled) return { disabled: true };

  const parsed = parseBatchImportInput(input, deps.maxItems ?? MAX_BATCH_IMPORT_ITEMS);

  const uidStr = String(userId);
  // 与 library.ts uploadAndIngestDocument 对齐:仅当 workspace flag 开启时解析并挂载 projectId
  const workspaceEnabled = (deps.isWorkspaceEnabled ?? isResearchWorkspaceEnabled)();
  let membershipProjectId: string | undefined;
  if (workspaceEnabled) {
    const resolveProj = deps.resolveProjectId ?? resolveWorkspaceProjectId;
    membershipProjectId = await resolveProj(uidStr, input.projectId);
  }

  const citeDeps: CiteDeps = {
    mailto: cfg.config.litSources?.crossrefMailto || cfg.config.litSources?.openalexMailto || undefined,
  };
  const doiResolver = deps.resolveDoiImpl ?? resolveDoi;
  const arxivResolver = deps.resolveArxivImpl ?? resolveArxiv;
  const getDoc = deps.getDocument ?? ((uid, docId) => storeGetDocument(uid, docId));
  const putDoc = deps.putDocument ?? ((uid, doc) => storePutDocument({ userId: uid, doc }));
  const attachMembership = deps.addMembership ?? addMembership;

  const seenDocIds = new Set<string>();
  const imported: BatchImportItemResult[] = [];
  const duplicates: BatchImportDuplicate[] = [...parsed.duplicates];
  const failed: BatchImportFailure[] = [...parsed.invalid];

  type ItemOutcome =
    | { kind: "imported"; item: BatchImportItemResult }
    | { kind: "duplicate"; item: BatchImportDuplicate }
    | { kind: "failed"; item: BatchImportFailure };

  const outcomes = await runWithConcurrency<BatchImportCandidate, ItemOutcome>(
    parsed.unique,
    deps.concurrency ?? IMPORT_CONCURRENCY,
    async (cand) => {
      let resolved: SourceRecord | null = null;
      let sourceKind: "crossref" | "arxiv" | "bibtex" = "bibtex";

      if (cand.doi) {
        resolved = await doiResolver(cand.doi, citeDeps);
        if (resolved) sourceKind = "crossref";
      }
      if (!resolved && cand.arxivId) {
        resolved = await arxivResolver(cand.arxivId, citeDeps);
        if (resolved) sourceKind = "arxiv";
      }

      if (!resolved && !cand.bibtex) {
        return {
          kind: "failed",
          item: {
            dedupeKey: cand.dedupeKey,
            raw: cand.raw,
            reason: cand.doi ? "doi_not_found" : "arxiv_not_found",
          },
        };
      }

      // B1 核心规则:
      // 1) 若用户通过 BibTeX 提交了自定义 abstract,绝不把该文本与 verifiedSource 绑定;
      // 2) 只有无用户自定义正文混入且上游返回可信正文/官方摘要(`trustedText`)时,才挂 verifiedSource。
      const hasUserBibtexAbstract = Boolean(cand.bibtex?.abstract?.trim());
      let trustedText: string | null = null;
      if (resolved && !hasUserBibtexAbstract && deps.resolveTrustedTextImpl) {
        const fetchedText = await deps.resolveTrustedTextImpl(resolved, citeDeps);
        if (typeof fetchedText === "string" && fetchedText.trim().length > 0) {
          trustedText = fetchedText.trim();
        }
      }

      const doc: NormalizedDocument =
        resolved && trustedText
          ? buildVerifiedDocumentFromTrustedUpstream(resolved, trustedText)
          : buildUnverifiedDocument({ record: resolved, bibtex: cand.bibtex });

      // 精确查重:按可信标识符或精确内容派生 docId(绝不用标题模糊碰撞)
      let existingDocId: string | undefined;
      if (deps.findExistingDocByIdentifier && (cand.doi || cand.arxivId)) {
        const byIdent = await deps.findExistingDocByIdentifier(userId, {
          doi: cand.doi,
          arxivId: cand.arxivId,
        });
        if (byIdent) existingDocId = byIdent;
      }
      if (!existingDocId) {
        if (seenDocIds.has(doc.docId)) {
          existingDocId = doc.docId;
        } else {
          const existingDoc = await getDoc(userId, doc.docId);
          if (existingDoc) existingDocId = existingDoc.docId;
        }
      }

      if (existingDocId) {
        if (membershipProjectId) {
          // 不吞掉 DB/membership 异常(N2)
          await attachMembership(uidStr, existingDocId, membershipProjectId);
        }
        return {
          kind: "duplicate",
          item: {
            dedupeKey: cand.dedupeKey,
            raw: cand.raw,
            reason: "already_in_library",
            existingDocId,
          },
        };
      }

      await putDoc(userId, doc);
      seenDocIds.add(doc.docId);
      if (membershipProjectId) {
        await attachMembership(uidStr, doc.docId, membershipProjectId);
      }

      const fulltextVerified = Boolean(doc.verifiedSource);
      return {
        kind: "imported",
        item: {
          dedupeKey: cand.dedupeKey,
          raw: cand.raw,
          docId: doc.docId,
          title: doc.title ?? null,
          spanCount: doc.spans.length,
          source: resolved ? sourceKind : "bibtex",
          bibliographicResolved: Boolean(resolved),
          fulltextVerified,
          verified: fulltextVerified,
          ...(resolved ? { resolvedSource: resolved } : {}),
          ...(hasUserBibtexAbstract ? { userSuppliedTextUnverified: true } : {}),
          ...(membershipProjectId ? { projectId: membershipProjectId } : {}),
        },
      };
    },
  );

  for (const out of outcomes) {
    if (out.kind === "imported") imported.push(out.item);
    else if (out.kind === "duplicate") duplicates.push(out.item);
    else failed.push(out.item);
  }

  return {
    ok: true,
    totalSubmitted: parsed.totalSubmitted,
    imported,
    duplicates,
    failed,
    ...(membershipProjectId ? { projectId: membershipProjectId } : {}),
  };
}
