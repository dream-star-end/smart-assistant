/**
 * oc-cite check — 引用接地门禁核心(master 铸造 verified,fail-closed)。
 *
 * 证据权威链终点(§0.5 #5 + Codex Phase2 终审):
 *   闸① quote-first:每条 quote 回查 master 权威 span,**整数 range 校验**(NaN/越界 → 丢弃),
 *      取权威子串作 canonical 文本覆盖(不信容器/LLM 提交的 text)。
 *   闸② claim 绑定:claim 必须有 ≥1 条命中权威 span 的 support 才可能 verified。
 *   闸③ identifier:**source 由 master 从权威文档自建,绝不信提交的 manifest.sources /
 *      quote.sourceId**。只有 master 文档带 verifiedSource(master 确立的出版身份)时才做
 *      DOI/arXiv 回查;用户上传文档无出版身份 → quote-bound 但不冒充已发表文献
 *      (杜绝"上传任意文本 + 挂真 DOI"伪造)。
 *   闸④ 撤稿:有出版身份且撤稿的支撑文献 → 该 claim 不得 verified。
 *
 * status 只由本函数(master)铸造;LLM/容器提交的 status / sourceId / sources 一律忽略。
 * fail-closed:不整篇拒答 —— 未过闸的 claim 标 unsupported(红标)/无 support 标 unchecked。
 */

import type {
  CitationVerdict,
  Claim,
  EvidenceManifest,
  GateResult,
  NormalizedDocument,
  QuoteHandle,
  SourceRecord,
} from "@openclaude/protocol/research";

export interface CheckManifestDeps {
  /** 回查 master 权威文档(调用方已绑定 userId,tenant 隔离)。证据权威源。 */
  getDocument: (docId: string) => Promise<NormalizedDocument | null>;
  /** identifier 回查 + 撤稿(oc-cite verify)。 */
  verifyIdentifier: (identifier: string) => Promise<CitationVerdict>;
  /** 高风险域(生医/临床/政策)强制撤稿过滤;预留。 */
  strictDomains?: string[];
}

function sourceIdentifier(s: SourceRecord): string | null {
  if (s.doi) return s.doi;
  if (s.arxivId) return `arxiv:${s.arxivId}`;
  if (s.openalexId) return `openalex:${s.openalexId}`;
  return null;
}

interface DocSourceMeta {
  published: boolean;
  resolved: boolean;
  retracted: boolean | null;
}

export async function checkManifest(
  input: EvidenceManifest,
  deps: CheckManifestDeps,
): Promise<{ manifest: EvidenceManifest; gates: EvidenceManifest["gates"] }> {
  const docCache = new Map<string, NormalizedDocument | null>();
  const loadDoc = async (docId: string): Promise<NormalizedDocument | null> => {
    if (docCache.has(docId)) return docCache.get(docId) ?? null;
    const d = await deps.getDocument(docId);
    docCache.set(docId, d);
    return d;
  };

  // ── 闸①:quote 回查权威 span + 整数 range 校验 + canonical 化 ──────────
  const canonicalQuotes: QuoteHandle[] = [];
  const validQuoteIds = new Set<string>();
  const quoteById = new Map<string, QuoteHandle>();
  let quoteChecked = 0;
  let quoteFailed = 0;

  const quotes = Array.isArray(input.quotes) ? input.quotes : [];
  for (const q of quotes) {
    quoteChecked++;
    if (
      !q ||
      typeof q.id !== "string" ||
      typeof q.docId !== "string" ||
      typeof q.spanId !== "string" ||
      !Number.isSafeInteger(q.charStart) ||
      !Number.isSafeInteger(q.charEnd)
    ) {
      quoteFailed++;
      continue;
    }
    const doc = await loadDoc(q.docId);
    if (!doc) {
      quoteFailed++;
      continue;
    }
    const span = doc.spans.find((s) => s.spanId === q.spanId);
    if (!span) {
      quoteFailed++;
      continue;
    }
    const relStart = q.charStart - span.charStart;
    const relEnd = q.charEnd - span.charStart;
    if (!Number.isSafeInteger(relStart) || relStart < 0 || relEnd > span.text.length || relStart >= relEnd) {
      quoteFailed++;
      continue;
    }
    // 取权威子串 + **override sourceId = docId**(master-owned 绑定,忽略提交 sourceId)
    const cq: QuoteHandle = {
      id: q.id,
      sourceId: q.docId,
      docId: q.docId,
      spanId: q.spanId,
      charStart: q.charStart,
      charEnd: q.charEnd,
      text: span.text.slice(relStart, relEnd),
      score: typeof q.score === "number" ? q.score : undefined,
    };
    canonicalQuotes.push(cq);
    validQuoteIds.add(cq.id);
    quoteById.set(cq.id, cq);
  }

  // ── 闸③④:从 master 文档自建 source(忽略提交 sources)+ 出版身份回查 ──
  const backingDocIds = new Set(canonicalQuotes.map((q) => q.docId));
  const sources: SourceRecord[] = [];
  const docMeta = new Map<string, DocSourceMeta>();
  let idChecked = 0;
  let idFailed = 0;
  let retractChecked = 0;
  let retractFailed = 0;

  for (const docId of backingDocIds) {
    const doc = await loadDoc(docId);
    const vs = doc?.verifiedSource;
    if (vs) {
      const ident = sourceIdentifier(vs);
      let resolved = false;
      let retracted: boolean | null = null;
      let rec: SourceRecord = vs;
      if (ident) {
        idChecked++;
        try {
          const verdict = await deps.verifyIdentifier(ident);
          resolved = verdict.resolved;
          retracted = verdict.retracted;
          if (verdict.record) rec = verdict.record;
        } catch {
          resolved = false;
        }
        if (!resolved) idFailed++;
        if (retracted === true) {
          retractChecked++;
          retractFailed++;
        } else if (retracted === false) {
          retractChecked++;
        }
      }
      sources.push({ ...rec, id: docId, identifiersVerified: resolved, retracted });
      docMeta.set(docId, { published: true, resolved, retracted });
    } else {
      // 上传文档:无出版身份 —— quote-bound 但不冒充已发表文献(source 标为上传)
      sources.push({
        id: docId,
        title: doc?.title ?? "Uploaded document",
        authors: [],
        lang: doc?.lang,
        identifiersVerified: false,
        retracted: null,
      });
      docMeta.set(docId, { published: false, resolved: false, retracted: null });
    }
  }

  // ── 闸②:逐 claim 铸造 status ────────────────────────────────────
  let claimBoundChecked = 0;
  let claimBoundFailed = 0;
  const inputClaims = Array.isArray(input.claims) ? input.claims : [];

  const checkedClaims: Claim[] = inputClaims.map((c) => {
    const supports = Array.isArray(c?.supports) ? c.supports : [];
    const validSupports = supports.filter(
      (ref) => ref && typeof ref.quoteId === "string" && validQuoteIds.has(ref.quoteId),
    );
    const hadSupports = supports.length > 0;
    if (hadSupports) {
      claimBoundChecked++;
      if (validSupports.length === 0) claimBoundFailed++;
    }

    const claimDocIds = new Set<string>();
    for (const ref of validSupports) {
      const q = quoteById.get(ref.quoteId);
      if (q) claimDocIds.add(q.docId);
    }
    let hasPublished = false;
    let publishedFail = false;
    let anyRetracted = false;
    for (const did of claimDocIds) {
      const meta = docMeta.get(did);
      if (meta?.published) {
        hasPublished = true;
        if (!meta.resolved) publishedFail = true;
        if (meta.retracted === true) {
          anyRetracted = true;
          publishedFail = true;
        }
      }
    }

    let status: Claim["status"];
    if (!hadSupports) status = "unchecked";
    else if (validSupports.length === 0 || publishedFail) status = "unsupported";
    else status = "verified"; // quote-bound + (上传 OR 出版身份 resolved & 未撤稿)

    return {
      id: typeof c?.id === "string" ? c.id : "",
      text: typeof c?.text === "string" ? c.text : "",
      supports: validSupports,
      status,
      verdict: {
        verifier: "oc-cite",
        quoteBound: validSupports.length > 0,
        // identifierVerified:仅当有出版身份且全 resolved/未撤稿;上传文档为 false(诚实)
        identifierVerified: hasPublished && !publishedFail,
        retracted: anyRetracted,
      },
    };
  });

  const verifiedClaims = checkedClaims.filter((c) => c.status === "verified").length;

  const gates: EvidenceManifest["gates"] = {
    quoteFirst: gate(quoteChecked, quoteFailed, "quote 回查权威 span + range 校验"),
    claimBound: gate(claimBoundChecked, claimBoundFailed, "claim 句级 quote 绑定"),
    identifier: gate(idChecked, idFailed, "出版身份 DOI/arXiv/OpenAlex 回查"),
    retraction: gate(retractChecked, retractFailed, "撤稿/关注过滤"),
  };

  return {
    manifest: {
      sources,
      quotes: canonicalQuotes,
      claims: checkedClaims,
      coverage: { verifiedClaims, totalClaims: checkedClaims.length },
      gates,
    },
    gates,
  };
}

function gate(checked: number, failed: number, detail: string): GateResult {
  return { passed: failed === 0, checked, failed, detail };
}
