import { type Static, Type } from '@sinclair/typebox'

// ════════════════════════════════════════════════════════════════════════
// v5 商业版 · 科研 Agent 子系统 — 共享数据契约(前后端 + master + CLI 共用)
//
// 设计权威:docs/research-agent/IMPLEMENTATION_PLAN.md(经 3 轮 Codex 终审)。
//
// 核心不变量(引用接地红线):
//   - 证据权威 100% 由 master 从源字节铸造(NormalizedDocument / Span),
//     权威 span 文本存 master `research_documents`。
//   - QuoteHandle 由 master 服务端切片铸造(text = 权威 span 子串),容器/LLM
//     无法发明或篡改 quote 文本。
//   - Claim.status='verified' 只能由 master 的 oc-cite check 铸造;LLM/容器
//     提交的 status 一律忽略(见 ClaimStatus 注释)。
//   - fail-closed:未接地 claim 标 unsupported / unchecked(红标 / 移入未核查),
//     **不整篇拒答**。
// ════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────
// 0) 基础别名
// ───────────────────────────────────────────────

/** 文献语言。中文文献走"标题+作者+期刊+年"模糊匹配,不靠纯 DOI。 */
export const DocLang = Type.Union([
  Type.Literal('zh'),
  Type.Literal('en'),
  Type.Literal('other'),
])
export type DocLang = Static<typeof DocLang>

/** 引用格式样式。GB/T 7714-2015 是中文国标(走 citeproc + zotero-chinese CSL)。 */
export const CitationStyle = Type.Union([
  Type.Literal('gb-t-7714-2015'),
  Type.Literal('apa'),
  Type.Literal('bibtex'),
])
export type CitationStyle = Static<typeof CitationStyle>

// ───────────────────────────────────────────────
// 1) 文献元数据(oc-lit 多源检索产出)
// ───────────────────────────────────────────────

export const Author = Type.Object({
  name: Type.String(),
  /** OpenAlex / ORCID 作者 id,缺失常见(中文文献尤甚)。 */
  id: Type.Optional(Type.String()),
})
export type Author = Static<typeof Author>

/** 开放获取信息。OA 全文走 OA 源 + 用户自带文件,绝不代爬付费墙。 */
export const OpenAccess = Type.Object({
  isOA: Type.Boolean(),
  url: Type.Optional(Type.String()),
  license: Type.Optional(Type.String()),
  /** 'unpaywall' | 'openalex' | 'doaj' | 'ncpssd' | 'publisher' 等。 */
  source: Type.Optional(Type.String()),
})
export type OpenAccess = Static<typeof OpenAccess>

/**
 * 文献元数据记录。多源(OpenAlex/Crossref/S2/Unpaywall/arXiv/ncpssd)去重后的
 * 归一记录。`identifiersVerified` 仅在经 oc-cite verify 回查命中可信记录后为 true。
 */
export const SourceRecord = Type.Object({
  /** 稳定内部 id(DOI 优先;缺 DOI 用 标题+作者+年 归一 key 的 hash)。 */
  id: Type.String(),
  title: Type.String(),
  authors: Type.Array(Author),
  year: Type.Optional(Type.Integer()),
  venue: Type.Optional(Type.String()),
  doi: Type.Optional(Type.String()),
  arxivId: Type.Optional(Type.String()),
  openalexId: Type.Optional(Type.String()),
  crossrefType: Type.Optional(Type.String()),
  citationCount: Type.Optional(Type.Integer()),
  oa: Type.Optional(OpenAccess),
  lang: Type.Optional(DocLang),
  /** 是否被撤稿 / 关注(Retraction Watch via Crossref)。null=未查。 */
  retracted: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  /** 经 oc-cite identifier 闸命中可信记录(DOI/arXiv/OpenAlex/Crossref ≥1)。 */
  identifiersVerified: Type.Optional(Type.Boolean()),
})
export type SourceRecord = Static<typeof SourceRecord>

// ───────────────────────────────────────────────
// 2) 不可变解析文档(oc-ingest,master 从字节铸造 — 证据权威源)
// ───────────────────────────────────────────────

/**
 * 可寻址 span。`text` 是 master 从源字节解析出的**权威副本**;quote 校验靠
 * 回查本 span + [charStart,charEnd] range 子串(非 hash 相等)。
 */
export const Span = Type.Object({
  spanId: Type.String(),
  /** 章节路径,如 ["3", "3.2"];用于交叉引用与定位。 */
  sectionPath: Type.Array(Type.String()),
  charStart: Type.Integer(),
  charEnd: Type.Integer(),
  text: Type.String(),
})
export type Span = Static<typeof Span>

/** GROBID 抽出的参考文献题录。 */
export const ReferenceEntry = Type.Object({
  raw: Type.String(),
  title: Type.Optional(Type.String()),
  doi: Type.Optional(Type.String()),
  year: Type.Optional(Type.Integer()),
})
export type ReferenceEntry = Static<typeof ReferenceEntry>

/**
 * 归一文档。**只由 master 从源字节铸造**,存 `research_documents`。
 * `docId` 由内容派生(sha256 over 规范化 span 序列),容器无法冒名替换。
 */
export const NormalizedDocument = Type.Object({
  docId: Type.String(),
  contentSha256: Type.String(),
  sourceBlobId: Type.Optional(Type.String()),
  lang: DocLang,
  title: Type.Optional(Type.String()),
  spans: Type.Array(Span),
  references: Type.Array(ReferenceEntry),
})
export type NormalizedDocument = Static<typeof NormalizedDocument>

/** 容器侧拿到的文档摘要(权威 span 文本留 master,这里只给大纲)。 */
export const DocumentOutline = Type.Object({
  docId: Type.String(),
  lang: DocLang,
  title: Type.Optional(Type.String()),
  /** 章节标题大纲(path + heading)。 */
  sections: Type.Array(
    Type.Object({
      path: Type.Array(Type.String()),
      heading: Type.String(),
    }),
  ),
  spanCount: Type.Integer(),
  /** 扫描件无文字层且未开 OCR 时,master 回 needs_ocr=true,不静默产空。 */
  needsOcr: Type.Optional(Type.Boolean()),
})
export type DocumentOutline = Static<typeof DocumentOutline>

// ───────────────────────────────────────────────
// 3) Quote handle — 唯一可写素材(master 服务端铸造)
// ───────────────────────────────────────────────

/**
 * verbatim quote 句柄。**master 铸造**:text = 权威 span.text[charStart:charEnd]。
 * 这是写作时**唯一可引用素材** —— LLM 只能引用既有 handle,无法发明 quote 文本。
 */
export const QuoteHandle = Type.Object({
  id: Type.String(),
  /** 关联的 SourceRecord.id(用于角标 → 文献映射)。 */
  sourceId: Type.String(),
  docId: Type.String(),
  spanId: Type.String(),
  charStart: Type.Integer(),
  charEnd: Type.Integer(),
  /** canonical quote 文本(master 取);渲染/展示直接用这个。 */
  text: Type.String(),
  /** 检索得分(召回排序用,非权威信号)。 */
  score: Type.Optional(Type.Number()),
})
export type QuoteHandle = Static<typeof QuoteHandle>

// ───────────────────────────────────────────────
// 4) Claim 与证据 manifest
// ───────────────────────────────────────────────

/**
 * claim 接地状态。**只能由 master oc-cite check 铸造**:
 *   - verified:quote-bound(quote ref 命中权威 span 且 range 合法)+ identifier-verified
 *               + 未撤稿。注意:MVP 下 verified ≠ 语义蕴含(真 quote 也可能被过度
 *               解读);P1.5 接 MiniCheck 后增 'supported'(蕴含)层。
 *   - unsupported:有 support 但校验未过(quote ref 不命中 / range 越界 / 撤稿 /
 *                  identifier 未命中)→ 红标。
 *   - unchecked:尚未经 oc-cite(或无 support)→ 移入"未核查"。
 * LLM/容器在 manifest 里提交的任何 status 一律被 master 忽略/覆盖。
 */
export const ClaimStatus = Type.Union([
  Type.Literal('verified'),
  Type.Literal('unsupported'),
  Type.Literal('unchecked'),
])
export type ClaimStatus = Static<typeof ClaimStatus>

/** claim 对 quote 的引用(可带句内偏移,供 UI 高亮)。 */
export const QuoteRef = Type.Object({
  quoteId: Type.String(),
  /** 正文中角标落点的字符偏移(可选,UI 用)。 */
  offset: Type.Optional(Type.Integer()),
})
export type QuoteRef = Static<typeof QuoteRef>

/** master oc-cite check 对单条 claim 的判定明细。 */
export const ClaimVerdict = Type.Object({
  /** 'oc-cite' | 'minicheck'(P1.5)。 */
  verifier: Type.String(),
  /** quote-bound 是否成立(全部 quote ref 命中权威 span 且 range 合法)。 */
  quoteBound: Type.Boolean(),
  /** 引用文献 identifier 是否经回查命中可信记录。 */
  identifierVerified: Type.Boolean(),
  /** 是否命中撤稿/关注。 */
  retracted: Type.Boolean(),
  /** P1.5 MiniCheck 蕴含分(0~1),MVP 缺省。 */
  entailmentScore: Type.Optional(Type.Number()),
  note: Type.Optional(Type.String()),
})
export type ClaimVerdict = Static<typeof ClaimVerdict>

/** 正文论断。claim 文本由 LLM 自由产出,但 support 必须指向真实 QuoteHandle。 */
export const Claim = Type.Object({
  id: Type.String(),
  text: Type.String(),
  supports: Type.Array(QuoteRef),
  status: ClaimStatus,
  verdict: Type.Optional(ClaimVerdict),
})
export type Claim = Static<typeof Claim>

/** 五道闸单项结果(方案 §5)。 */
export const GateResult = Type.Object({
  passed: Type.Boolean(),
  /** 命中/未过的条目数,用于 UI 与验收统计。 */
  checked: Type.Integer(),
  failed: Type.Integer(),
  detail: Type.Optional(Type.String()),
})
export type GateResult = Static<typeof GateResult>

/**
 * 证据 manifest — researcher 产出 + master oc-cite check 回填。前后端引用接地的
 * 权威数据契约;UI 的角标、EvidencePopover、未核查段全部从这里渲染(非裸 markdown)。
 */
export const EvidenceManifest = Type.Object({
  sources: Type.Array(SourceRecord),
  quotes: Type.Array(QuoteHandle),
  claims: Type.Array(Claim),
  /** 接地覆盖率(验收硬指标:无"看起来合理的假引用"漏出)。 */
  coverage: Type.Object({
    verifiedClaims: Type.Integer(),
    totalClaims: Type.Integer(),
  }),
  /** 四道闸(MVP)/ 五~六道(P1.5+)结果。 */
  gates: Type.Object({
    quoteFirst: GateResult,
    claimBound: GateResult,
    identifier: GateResult,
    retraction: GateResult,
    /** P1.5 MiniCheck 支持判定。 */
    minicheck: Type.Optional(GateResult),
  }),
})
export type EvidenceManifest = Static<typeof EvidenceManifest>

// ───────────────────────────────────────────────
// 5) 报告结构(章节/编号/交叉引用由引擎保证,非 LLM 即兴)
// ───────────────────────────────────────────────

export const Figure = Type.Object({
  id: Type.String(),
  /** 产物相对路径(SciencePlots 出图;禁生成式插画)。 */
  path: Type.String(),
  caption: Type.String(),
  /** 'plot' | 'diagram'(Mermaid/TikZ);禁 'generated-illustration'。 */
  kind: Type.Union([Type.Literal('plot'), Type.Literal('diagram')]),
})
export type Figure = Static<typeof Figure>

export const ReportSection = Type.Object({
  id: Type.String(),
  heading: Type.String(),
  level: Type.Integer(),
  /** 正文 markdown;引用角标以 [[claim:<id>]] 占位,渲染时由引擎按 manifest 解析。 */
  bodyMd: Type.String(),
  claimRefs: Type.Array(Type.String()),
})
export type ReportSection = Static<typeof ReportSection>

/**
 * 报告 schema(确定性产物层输入)。Quarto/Typst 引擎据此管章节/编号/交叉引用/CSL,
 * LLM 不碰排版。
 */
export const ReportSchema = Type.Object({
  title: Type.String(),
  abstract: Type.Optional(Type.String()),
  sections: Type.Array(ReportSection),
  figures: Type.Array(Figure),
  /** 参考文献(SourceRecord.id 列表,按出现顺序)。 */
  bibliography: Type.Array(Type.String()),
  csl: CitationStyle,
})
export type ReportSchema = Static<typeof ReportSchema>

// ───────────────────────────────────────────────
// 6) oc-cite 输出
// ───────────────────────────────────────────────

/** 单个 identifier 的回查 + 撤稿 + 格式化结果。 */
export const CitationVerdict = Type.Object({
  /** 输入 identifier(doi:/arxiv:/openalex: 前缀)。 */
  identifier: Type.String(),
  /** 是否命中可信记录(闸③)。 */
  resolved: Type.Boolean(),
  record: Type.Optional(SourceRecord),
  /** 是否撤稿/关注(闸④);null=未查。 */
  retracted: Type.Union([Type.Boolean(), Type.Null()]),
  bibtex: Type.Optional(Type.String()),
  gbt7714: Type.Optional(Type.String()),
  apa: Type.Optional(Type.String()),
})
export type CitationVerdict = Static<typeof CitationVerdict>

// ───────────────────────────────────────────────
// 7) 产物交付
// ───────────────────────────────────────────────

export const ResearchArtifactKind = Type.Union([
  Type.Literal('report'),
  Type.Literal('slides'),
  Type.Literal('poster'),
  Type.Literal('bib'),
  Type.Literal('code'),
  Type.Literal('data'),
  Type.Literal('figure'),
])
export type ResearchArtifactKind = Static<typeof ResearchArtifactKind>

/** 产物索引项。容器路径经 /api/media-sign 签名交付(单一 artifact 权威)。 */
export const ResearchArtifact = Type.Object({
  kind: ResearchArtifactKind,
  path: Type.String(),
  mime: Type.Optional(Type.String()),
  sizeBytes: Type.Optional(Type.Integer()),
  sha256: Type.Optional(Type.String()),
  /** 临时签名 URL(5min TTL),由前端在展示时获取。 */
  signedUrl: Type.Optional(Type.String()),
})
export type ResearchArtifact = Static<typeof ResearchArtifact>

// ───────────────────────────────────────────────
// 8) durable job / phase checkpoint(状态镜像;权威在 master PG)
// ───────────────────────────────────────────────

/**
 * 相位级 checkpoint 粒度(方案 §8)。多小时科研任务可按相位恢复,中断不丢
 * 已完成相位。
 */
export const ResearchPhase = Type.Union([
  Type.Literal('search_plan'),
  Type.Literal('metadata_results'),
  Type.Literal('pdf_ingested'),
  Type.Literal('quote_indexed'),
  Type.Literal('claims_extracted'),
  Type.Literal('citations_verified'),
  Type.Literal('report_rendered'),
])
export type ResearchPhase = Static<typeof ResearchPhase>

export const ResearchJobKind = Type.Union([
  Type.Literal('ingest'),
  Type.Literal('index'),
  Type.Literal('cite_check'),
  Type.Literal('lit_search'),
  Type.Literal('render'),
  Type.Literal('research_task'),
])
export type ResearchJobKind = Static<typeof ResearchJobKind>

export const ResearchJobStatus = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('interrupted'),
])
export type ResearchJobStatus = Static<typeof ResearchJobStatus>

/** 容器轮询 /v3/research/job/poll 拿到的 job 状态视图。 */
export const ResearchJobView = Type.Object({
  requestId: Type.String(),
  kind: ResearchJobKind,
  status: ResearchJobStatus,
  phase: Type.Optional(ResearchPhase),
  /** 已完成相位(供 resume / 进度展示)。 */
  completedPhases: Type.Array(ResearchPhase),
  result: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.String()),
})
export type ResearchJobView = Static<typeof ResearchJobView>

// ───────────────────────────────────────────────
// 9) 纯结构不变量(master oc-cite check + 测试共用)
// ───────────────────────────────────────────────

/**
 * manifest 的**纯结构**不变量(不碰证据权威,只查引用闭合性)。master oc-cite
 * check 在做权威校验前先跑这一层快筛;前端也可用它判断是否可安全渲染角标。
 *
 * 不变量:
 *   I1. 每条 claim.supports 引用的 quoteId 必须存在于 manifest.quotes。
 *   I2. status='verified' 的 claim 必须有 ≥1 个 support(verified 不能凭空)。
 *   I3. 每个 quote.sourceId 必须存在于 manifest.sources。
 *   I4. coverage.verifiedClaims 必须 == 实际 status='verified' 的 claim 数。
 *
 * 注意:这些只保证"引用闭合"。"quote 文本是否真为权威 span 子串""identifier
 * 是否真命中"由 master oc-cite 用 research_documents + 外部回查铸造,**不在此层**。
 */
export function checkManifestStructuralInvariants(m: EvidenceManifest): {
  ok: boolean
  violations: string[]
} {
  const violations: string[] = []
  const quoteIds = new Set(m.quotes.map((q) => q.id))
  const sourceIds = new Set(m.sources.map((s) => s.id))

  for (const q of m.quotes) {
    if (!sourceIds.has(q.sourceId)) {
      violations.push(`I3: quote ${q.id} references missing source ${q.sourceId}`)
    }
  }

  let verifiedCount = 0
  for (const c of m.claims) {
    if (c.status === 'verified') {
      verifiedCount++
      if (c.supports.length === 0) {
        violations.push(`I2: verified claim ${c.id} has no supporting quotes`)
      }
    }
    for (const ref of c.supports) {
      if (!quoteIds.has(ref.quoteId)) {
        violations.push(
          `I1: claim ${c.id} references missing quote ${ref.quoteId}`,
        )
      }
    }
  }

  if (m.coverage.verifiedClaims !== verifiedCount) {
    violations.push(
      `I4: coverage.verifiedClaims=${m.coverage.verifiedClaims} but actual verified=${verifiedCount}`,
    )
  }

  return { ok: violations.length === 0, violations }
}
