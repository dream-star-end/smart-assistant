/**
 * 科研重 op 编排(master 侧):桥接 store(DB/blob)与纯逻辑(ingest/litrag/checkManifest)。
 *
 * 全部 deps 注入 → 可不依赖 PG/fs 单测;researchProxy(inline)与 research scheduler
 * (async durable job)共用这些函数,保证两条路径行为一致。
 *
 * 证据权威(§0.5):ingest 从 master 持有的 blob 字节铸造权威 NormalizedDocument;
 * litrag 从权威 spans 铸造 quote handle;check 回查权威 span 铸造 verified。
 */

import type {
  CitationVerdict,
  DocumentOutline,
  EvidenceManifest,
  NormalizedDocument,
  QuoteHandle,
} from "@openclaude/protocol/research";
import {
  type ExtractDeps,
  type ExtractResult,
  type IngestEngine,
  MAX_DOC_CHARS,
  extractLocal,
  isNeedsOcr,
  mintDocument,
} from "./ingest.js";
import {
  type QueryOpts,
  type SemanticQueryDeps,
  queryDocuments,
  queryDocumentsSemantic,
} from "./litrag.js";
import { type CheckManifestDeps, checkManifest } from "./checkManifest.js";
import { type CiteFixChange, realignUnsupportedClaims } from "./citeFix.js";
import {
  type FetchAttempt,
  type FetchFulltextConfig,
  type FetchFulltextHttpDeps,
  type FetchRecordInput,
  downloadFulltext,
} from "./fetchFulltext.js";
import { type FetchAttemptRowInput, recordFetchAttempt } from "./store.js";
import { createHash, randomUUID } from "node:crypto";

// ── ingest ───────────────────────────────────────────────────────────

export interface IngestDeps {
  /** 读 master-owned blob 元数据(tenant 隔离)。 */
  getBlob: (userId: number, blobId: string) => Promise<{ storagePath: string; mime: string | null } | null>;
  /** 读 blob 字节(master-owned 路径)。 */
  readBlobBytes: (storagePath: string) => Promise<Buffer>;
  /** 落权威文档(research_documents)。 */
  putDocument: (userId: number, doc: NormalizedDocument) => Promise<void>;
  /** 本地抽取注入(测试用 pdfImpl)。 */
  extract?: ExtractDeps;
  /** 外部引擎(mineru/mistral)抽取;config engine != local 时调用。返回 ExtractResult。 */
  externalExtract?: (bytes: Buffer, mime: string, engine: "mineru" | "mistral") => Promise<ExtractResult>;
}

export interface IngestInput {
  userId: number;
  blobId: string;
  filename?: string;
  engine: "auto" | "local" | "mineru" | "mistral";
}

export type IngestOutcome =
  | { ok: true; outline: DocumentOutline }
  | { ok: false; needsOcr: true; reason: string }
  | { ok: false; needsOcr: false; reason: string };

/** 从 blob 字节铸造权威文档,落库,返回 outline(权威 span 文本留 master)。 */
export async function ingestBlob(input: IngestInput, deps: IngestDeps): Promise<IngestOutcome> {
  const blob = await deps.getBlob(input.userId, input.blobId);
  if (!blob) return { ok: false, needsOcr: false, reason: "blob not found" };
  const bytes = await deps.readBlobBytes(blob.storagePath);
  const mime = blob.mime ?? "";

  let extracted: ExtractResult;
  if ((input.engine === "mineru" || input.engine === "mistral") && deps.externalExtract) {
    extracted = await deps.externalExtract(bytes, mime, input.engine);
  } else {
    extracted = await extractLocal(bytes, mime, input.filename, deps.extract ?? {});
  }
  if (isNeedsOcr(extracted)) {
    return { ok: false, needsOcr: true, reason: extracted.reason };
  }
  // fail-closed:抽取文本超上限 → 拒(防 master 内存/CPU DoS)。
  if (extracted.text.length > MAX_DOC_CHARS) {
    return { ok: false, needsOcr: false, reason: `document too large (>${MAX_DOC_CHARS} chars)` };
  }

  const doc = mintDocument({
    text: extracted.text,
    title: extracted.title,
    sourceBlobId: input.blobId,
  });
  await deps.putDocument(input.userId, doc);

  // outline:章节大纲(去重 sectionPath 顶层)+ spanCount,权威 span 文本不外泄
  const sections = buildOutline(doc);
  return {
    ok: true,
    outline: { docId: doc.docId, lang: doc.lang, title: doc.title, sections, spanCount: doc.spans.length },
  };
}

function buildOutline(doc: NormalizedDocument): DocumentOutline["sections"] {
  const seen = new Set<string>();
  const out: DocumentOutline["sections"] = [];
  for (const s of doc.spans) {
    const key = s.sectionPath.join(" / ");
    if (s.sectionPath.length > 0 && !seen.has(key)) {
      seen.add(key);
      out.push({ path: s.sectionPath, heading: s.sectionPath[s.sectionPath.length - 1] });
    }
  }
  return out;
}

// ── litrag query ─────────────────────────────────────────────────────

export interface LitragDeps {
  getDocument: (userId: number, docId: string) => Promise<NormalizedDocument | null>;
  /**
   * 可选语义召回(master 侧 embedding + 内容 hash 缓存)。存在则先走语义 RRF,
   * 任何 embedding 失败 → **fail-soft 回落纯 TF `queryDocuments`**(字节一致,铁律①)。
   * 不存在(未开通/无平台 key)→ 直接纯 TF,行为完全不变。
   */
  semantic?: SemanticQueryDeps;
}

/** 在用户的权威文档集上检索 → quote handles(master 铸造 canonical 文本)。 */
export async function litragQuery(
  userId: number,
  docIds: string[],
  query: string,
  opts: QueryOpts,
  deps: LitragDeps,
): Promise<{ quotes: QuoteHandle[]; missing: string[] }> {
  const docs: NormalizedDocument[] = [];
  const missing: string[] = [];
  for (const id of docIds) {
    const d = await deps.getDocument(userId, id);
    if (d) docs.push(d);
    else missing.push(id);
  }
  // 语义路径 fail-soft:embedding 抖动/不可用绝不让检索变差 —— 回落确定性纯 TF。
  if (deps.semantic) {
    try {
      const quotes = await queryDocumentsSemantic(docs, query, opts, deps.semantic);
      return { quotes, missing };
    } catch {
      // 落回纯 TF(下方),保证与未开通语义时完全一致的兜底行为。
    }
  }
  return { quotes: queryDocuments(docs, query, opts), missing };
}

// ── cite check ───────────────────────────────────────────────────────

export interface CheckDeps {
  /** 读 master 权威文档(证据权威源);master 自建 source 绑定,不信提交。 */
  getDocument: (userId: number, docId: string) => Promise<NormalizedDocument | null>;
  verifyIdentifier: (identifier: string) => Promise<CitationVerdict>;
  strictDomains?: string[];
  /** 闸⑤ MiniCheck 蕴含(config-gated,见 checkManifest)。 */
  entail?: (claimText: string, quoteTexts: string[]) => Promise<number | null>;
  entailThreshold?: number;
  strictEntail?: boolean;
}

/** oc-cite check:用 userId 绑定权威文档回查,master 铸造 verified。 */
export async function runCheck(
  userId: number,
  manifest: EvidenceManifest,
  deps: CheckDeps,
): Promise<{ manifest: EvidenceManifest; gates: EvidenceManifest["gates"] }> {
  const checkDeps: CheckManifestDeps = {
    getDocument: (docId) => deps.getDocument(userId, docId),
    verifyIdentifier: deps.verifyIdentifier,
    strictDomains: deps.strictDomains,
    entail: deps.entail,
    entailThreshold: deps.entailThreshold,
    strictEntail: deps.strictEntail,
  };
  return checkManifest(manifest, checkDeps);
}

/**
 * CiteFix:对未接地 claim 在权威文档集重检索重绑(realign),再 recheck 铸造 status。
 * query 由 proxy 用 litragQuery 注入(master 从权威 span 铸造 quote,红线不破)。
 */
export async function runCiteFix(
  userId: number,
  manifest: EvidenceManifest,
  hasDocs: boolean,
  deps: CheckDeps & {
    /** 在(调用方预加载的)权威文档集上检索;返回 master 铸造的 quote handles。 */
    query: (claimText: string) => Promise<import("@openclaude/protocol/research").QuoteHandle[]>;
    fixMinScore?: number;
  },
): Promise<{ manifest: EvidenceManifest; gates: EvidenceManifest["gates"]; changes: CiteFixChange[] }> {
  const realigned = await realignUnsupportedClaims(manifest, hasDocs, {
    query: deps.query,
    minScore: deps.fixMinScore,
  });
  const checked = await runCheck(userId, realigned.manifest, deps);
  return { manifest: checked.manifest, gates: checked.gates, changes: realigned.changes };
}

// ── fetch fulltext(R5 Phase A:下载 → blob → ingest → membership) ──

/** 单条记录下载+入库结果(status: fetched | needs_ocr | failed)。 */
export interface FetchRecordOutcome {
  id: string;
  status: "fetched" | "needs_ocr" | "failed";
  /** failed/needs_ocr 的结构化原因(FETCH_FAIL_REASONS 或 "needs_ocr")。 */
  reason?: string;
  /** 获胜策略(known_oa/unpaywall_pdf/arxiv/pmc_oa/publisher_oa[":proxy"])。 */
  strategy?: string;
  blobId?: string;
  docId?: string;
  bytes?: number;
  /** membership 是否已挂到课题(fail-soft:挂载失败不影响下载成功)。 */
  projectAdded?: boolean;
  attempts: FetchAttempt[];
}

export interface FetchIntoLibraryDeps {
  http: FetchFulltextHttpDeps;
  putBlob: (input: {
    blobId: string;
    userId: number;
    sha256: string;
    sizeBytes: number;
    storagePath: string;
    mime?: string;
  }) => Promise<void>;
  getBlob: (userId: number, blobId: string) => Promise<{ storagePath: string; mime: string | null } | null>;
  readBlobBytes: (storagePath: string) => Promise<Buffer>;
  putDocument: (userId: number, doc: NormalizedDocument) => Promise<void>;
  writeBlobBytes: (storagePath: string, bytes: Buffer) => Promise<void>;
  blobDir: string;
  /** 指标行写入(research_fetch_attempts);失败 best-effort 不阻断下载。 */
  recordAttempt?: (row: FetchAttemptRowInput) => Promise<void>;
  /** 课题 membership(R3.0 addMembership,flag 开时由调用方注入)。 */
  addMembership?: (userId: string, docId: string, projectId: string) => Promise<void>;
  /** 透传 ingest 抽取注入(测试)。 */
  extract?: ExtractDeps;
}

async function recordAttempts(
  deps: FetchIntoLibraryDeps,
  userId: number,
  record: FetchRecordInput,
  attempts: FetchAttempt[],
  won: { docId?: string; bytes?: number } | null,
): Promise<void> {
  const rec = deps.recordAttempt ?? recordFetchAttempt;
  for (const a of attempts) {
    try {
      await rec({
        userId,
        recordId: record.id,
        doi: record.doi,
        arxivId: record.arxivId,
        strategy: a.source,
        ok: a.code === "ok",
        reason: a.code === "ok" ? undefined : a.code,
        httpStatus: a.httpStatus,
        docId: a.code === "ok" ? won?.docId : undefined,
        bytes: a.code === "ok" ? won?.bytes : undefined,
        ms: a.ms,
      });
    } catch {
      // 指标写入失败不阻断下载/入库(best-effort)。
    }
  }
}

/**
 * 下载一条 OA 全文并走与用户上传完全相同的铸造链:落 blob → ingestBlob 铸权威
 * 文档 →(可选)挂课题 membership。下载与入库同一条链,不另起解析;
 * needs_ocr 是合法成功态(下载成功、无文字层)。
 * blob/ingest 的 DB/IO 异常上抛(系统性,由调用方决定 fail 语义);下载侧失败
 * 全部结构化,不上抛。
 */
export async function fetchRecordIntoLibrary(
  input: {
    userId: number;
    record: FetchRecordInput;
    projectId?: string;
    ingest: boolean;
    engine: IngestEngine;
  },
  cfg: FetchFulltextConfig,
  deps: FetchIntoLibraryDeps,
): Promise<FetchRecordOutcome> {
  const dl = await downloadFulltext(input.record, cfg, deps.http);

  if (!dl.ok) {
    await recordAttempts(deps, input.userId, input.record, dl.attempts, null);
    return { id: input.record.id, status: "failed", reason: dl.reason, attempts: dl.attempts };
  }

  const bytes = dl.bytes;
  const blobId = randomUUID();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storagePath = `${deps.blobDir}/${input.userId}-${blobId}`;
  await deps.writeBlobBytes(storagePath, bytes);
  await deps.putBlob({ blobId, userId: input.userId, sha256, sizeBytes: bytes.length, storagePath, mime: dl.mime });

  // ingest 与用户上传同链(researchHandlers.ingestBlob);ingest=false 仅落 blob
  const outcome = input.ingest
    ? await ingestBlob(
        { userId: input.userId, blobId, engine: input.engine },
        {
          getBlob: deps.getBlob,
          readBlobBytes: deps.readBlobBytes,
          putDocument: deps.putDocument,
          extract: deps.extract,
        },
      )
    : null;

  if (outcome && !outcome.ok) {
    if (outcome.needsOcr) {
      // needs_ocr = 下载成功、无文字层:合法成功态(进结果不进失败)
      await recordAttempts(deps, input.userId, input.record, dl.attempts, { bytes: bytes.length });
      return {
        id: input.record.id,
        status: "needs_ocr",
        reason: "needs_ocr",
        strategy: dl.strategy,
        blobId,
        bytes: bytes.length,
        attempts: dl.attempts,
      };
    }
    await recordAttempts(deps, input.userId, input.record, dl.attempts, null);
    return { id: input.record.id, status: "failed", reason: `ingest_failed: ${outcome.reason}`, attempts: dl.attempts };
  }

  const docId = outcome ? outcome.outline.docId : undefined;
  await recordAttempts(deps, input.userId, input.record, dl.attempts, { docId, bytes: bytes.length });

  let projectAdded: boolean | undefined;
  if (input.projectId && deps.addMembership && docId) {
    try {
      await deps.addMembership(String(input.userId), docId, input.projectId);
      projectAdded = true;
    } catch {
      projectAdded = false; // fail-soft:membership 失败不影响下载/入库成功
    }
  }

  return {
    id: input.record.id,
    status: "fetched",
    strategy: dl.strategy,
    blobId,
    docId,
    bytes: bytes.length,
    projectAdded,
    attempts: dl.attempts,
  };
}
