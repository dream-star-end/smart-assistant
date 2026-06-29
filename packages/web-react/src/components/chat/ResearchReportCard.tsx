/**
 * ResearchReportCard —— 引用接地结构化产物卡(artifact 驱动,非裸 markdown)。
 *
 * 产品差异化核心:让"引用接地"成为第一类公民 —— 每条结论一键查出处,未接地论断
 * 红标。数据来自 master oc-cite check 的已检 EvidenceManifest(status 由平台铸造,
 * 前端只呈现,不改判定)。
 *
 * 三件套:
 *   - 证据视图:claim 列表 + 状态(verified/未核查红标)+ 角标 [N] → EvidencePopover。
 *   - EvidencePopover:点角标内联展开支撑 quote(verbatim)+ 来源(标题/作者/DOI/OA)。
 *   - LiteratureLibraryPanel:检索结果表(标题/作者/年/引用/OA)+ BibTeX/GB-T7714 导出。
 */
import { BookOpen, Check, Copy, Download, FileText, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { Claim, EvidenceManifest, QuoteHandle, SourceRecord } from "@openclaude/protocol/research";
import type { ChatMessage } from "../../lib/chat/model";
import { exportLibrary } from "../../lib/research/cite";
import { cn } from "../../lib/utils";
import { Badge, Button } from "../ui";
import { Media } from "./media";

type Tab = "evidence" | "library";

// 注:不外包 memo —— 同 PlanCard/DelegateProgressCard,reducer 就地 mutate + {msg}
// 同引用会让 memo 永不重渲;父 MessageRenderer 已按 sig memo,内容变即重渲本卡。
export function ResearchReportCard({ msg }: { msg: ChatMessage }) {
  const manifest = msg._researchManifest;
  const library = msg._researchLibrary;
  const [tab, setTab] = useState<Tab>("evidence");

  const hasEvidence = !!manifest;
  const hasLibrary = !!library && library.length > 0;
  if (!hasEvidence && !hasLibrary) {
    return null;
  }
  // 派生有效 tab:只有一类数据时强制用它(防数据后到导致 tab 滞留到不可用页 → 空白)。
  const effectiveTab: Tab = !hasEvidence ? "library" : !hasLibrary ? "evidence" : tab;

  return (
    <div className="rounded-lg border border-border bg-surface animate-in">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <span className="flex size-6 items-center justify-center rounded-md bg-accent-soft text-accent">
          <FileText size={14} />
        </span>
        <span className="text-[13px] font-medium text-fg">{msg.text || "科研报告"}</span>
        {manifest && <CoverageBadge coverage={manifest.coverage} />}
        {hasEvidence && hasLibrary && (
          <div className="ml-auto flex gap-1">
            <TabButton active={effectiveTab === "evidence"} onClick={() => setTab("evidence")}>
              证据
            </TabButton>
            <TabButton active={effectiveTab === "library"} onClick={() => setTab("library")}>
              文献库 {library?.length}
            </TabButton>
          </div>
        )}
      </div>

      {effectiveTab === "evidence" && manifest && (
        <div className="px-3.5 py-3">
          <GatesRow manifest={manifest} />
          {/* artifact 驱动:始终从 manifest 渲染 claim↔证据(非裸 markdown);完整报告
              全文走可下载产物(_researchArtifacts 的 PDF/docx)。 */}
          <ClaimList manifest={manifest} />
        </div>
      )}

      {effectiveTab === "library" && hasLibrary && <LiteratureLibraryPanel sources={library} />}

      {msg._researchArtifacts && msg._researchArtifacts.length > 0 && (
        <div className="border-t border-border px-3.5 py-2.5">
          <div className="mb-1.5 text-[12px] font-medium text-muted">产物</div>
          <Media
            media={msg._researchArtifacts.map((a) => ({
              kind: "file" as const,
              url: a.signedUrl ?? a.path,
              filename: a.path.split("/").pop(),
              mimeType: a.mime,
            }))}
          />
        </div>
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md px-2 py-0.5 text-[12px]",
        active ? "bg-accent-soft text-accent" : "text-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function CoverageBadge({ coverage }: { coverage: EvidenceManifest["coverage"] }) {
  const { verifiedClaims, totalClaims } = coverage;
  const allOk = totalClaims > 0 && verifiedClaims === totalClaims;
  return (
    <Badge tone={totalClaims === 0 ? "neutral" : allOk ? "success" : "warning"}>
      接地 {verifiedClaims}/{totalClaims}
    </Badge>
  );
}

function GatesRow({ manifest }: { manifest: EvidenceManifest }) {
  const g = manifest.gates;
  const items: { label: string; passed: boolean }[] = [
    { label: "quote 接地", passed: g.quoteFirst.passed },
    { label: "claim 绑定", passed: g.claimBound.passed },
    { label: "identifier", passed: g.identifier.passed },
    { label: "撤稿过滤", passed: g.retraction.passed },
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((it) => (
        <span
          key={it.label}
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
            it.passed ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
          )}
        >
          {it.passed ? <Check size={11} /> : <TriangleAlert size={11} />}
          {it.label}
        </span>
      ))}
    </div>
  );
}

// ── claim 列表 + EvidencePopover(内联展开) ─────────────────────────

function ClaimList({ manifest }: { manifest: EvidenceManifest }) {
  // 每渲染重算(不 useMemo):reducer 就地 mutate 下 manifest 引用稳定,useMemo 会 stale。
  // 引用顺序编号:sourceId → [N](仅 verified claim 的支撑来源参与)。
  const sourceById = new Map(manifest.sources.map((s) => [s.id, s]));
  const quoteById = new Map(manifest.quotes.map((q) => [q.id, q]));
  const refNum = new Map<string, number>();
  for (const c of manifest.claims) {
    if (c.status !== "verified") continue;
    for (const ref of c.supports) {
      const sid = quoteById.get(ref.quoteId)?.sourceId;
      if (sid && sourceById.has(sid) && !refNum.has(sid)) refNum.set(sid, refNum.size + 1);
    }
  }

  return (
    <ul className="mt-2 space-y-2">
      {manifest.claims.map((c) => (
        <ClaimRow key={c.id} claim={c} refNum={refNum} sourceById={sourceById} quoteById={quoteById} />
      ))}
    </ul>
  );
}

function ClaimRow({
  claim,
  refNum,
  sourceById,
  quoteById,
}: {
  claim: Claim;
  refNum: Map<string, number>;
  sourceById: Map<string, SourceRecord>;
  quoteById: Map<string, QuoteHandle>;
}) {
  const [open, setOpen] = useState(false);
  const verified = claim.status === "verified";
  const cited = verified
    ? [...new Set(claim.supports.map((r) => quoteById.get(r.quoteId)?.sourceId).filter(Boolean) as string[])]
    : [];
  const nums = cited.map((sid) => refNum.get(sid)).filter((n): n is number => !!n).sort((a, b) => a - b);

  return (
    <li className="text-[13.5px] leading-relaxed text-fg">
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-[6px] size-2 shrink-0 rounded-full",
            verified ? "bg-success" : claim.status === "unsupported" ? "bg-danger" : "bg-warning",
          )}
        />
        <div className="min-w-0">
          <span>{claim.text}</span>{" "}
          {verified && nums.length > 0 && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="align-baseline text-[12px] text-accent hover:underline"
              title="查看出处"
            >
              [{nums.join(",")}]
            </button>
          )}
          {!verified && (
            <Badge tone="danger" className="ml-1 align-baseline">
              {claim.status === "unsupported" ? "未核查·无可信引用" : "未核查"}
            </Badge>
          )}
          {open && verified && (
            <div className="mt-1.5 space-y-1.5 rounded-md border border-border bg-bg px-2.5 py-2">
              {claim.supports.map((ref) => {
                const q = quoteById.get(ref.quoteId);
                if (!q) return null;
                const src = sourceById.get(q.sourceId);
                return <EvidenceItem key={ref.quoteId} quote={q} source={src} />;
              })}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function EvidenceItem({ quote, source }: { quote: QuoteHandle; source?: SourceRecord }) {
  return (
    <div className="text-[12.5px]">
      <blockquote className="border-l-2 border-accent/40 pl-2 italic text-muted">“{quote.text}”</blockquote>
      {source && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
          <span className="text-muted">{source.title}</span>
          {source.authors.length > 0 && <span>· {source.authors.map((a) => a.name).slice(0, 3).join(", ")}</span>}
          {source.year && <span>· {source.year}</span>}
          {source.doi ? (
            <a
              href={`https://doi.org/${source.doi}`}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              DOI:{source.doi}
            </a>
          ) : source.identifiersVerified === false ? (
            <Badge tone="neutral">上传文档</Badge>
          ) : null}
          {source.oa?.isOA && source.oa.url && (
            <a href={source.oa.url} target="_blank" rel="noreferrer" className="text-success hover:underline">
              开放获取
            </a>
          )}
          {source.retracted === true && <Badge tone="danger">已撤稿</Badge>}
        </div>
      )}
    </div>
  );
}

// ── 文献库面板 ────────────────────────────────────────────────────────

function LiteratureLibraryPanel({ sources }: { sources: SourceRecord[] }) {
  const [copied, setCopied] = useState<string>("");
  const copy = async (style: "gb-t-7714-2015" | "bibtex") => {
    try {
      await navigator.clipboard.writeText(exportLibrary(sources, style));
      setCopied(style);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      /* clipboard 不可用时静默 */
    }
  };
  return (
    <div className="px-3.5 py-3">
      <div className="mb-2 flex items-center gap-2">
        <BookOpen size={13} className="text-muted" />
        <span className="text-[12px] text-muted">{sources.length} 篇文献</span>
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => copy("gb-t-7714-2015")}>
            {copied === "gb-t-7714-2015" ? <Check size={13} /> : <Copy size={13} />} GB/T7714
          </Button>
          <Button size="sm" variant="ghost" onClick={() => copy("bibtex")}>
            {copied === "bibtex" ? <Check size={13} /> : <Download size={13} />} BibTeX
          </Button>
        </div>
      </div>
      <ul className="divide-y divide-border">
        {sources.map((s) => (
          <li key={s.id} className="py-1.5 text-[12.5px]">
            <div className="flex items-start gap-2">
              <span className="min-w-0 flex-1">
                <span className="text-fg">{s.title}</span>
                <span className="text-faint">
                  {" "}
                  {s.authors.map((a) => a.name).slice(0, 3).join(", ")}
                  {s.authors.length > 3 ? " 等" : ""}
                  {s.year ? ` · ${s.year}` : ""}
                  {s.venue ? ` · ${s.venue}` : ""}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {typeof s.citationCount === "number" && (
                  <span className="text-[11px] text-faint">被引 {s.citationCount}</span>
                )}
                {s.oa?.isOA && <Badge tone="success">OA</Badge>}
                {s.retracted === true && <Badge tone="danger">撤稿</Badge>}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
