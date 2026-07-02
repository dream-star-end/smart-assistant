/**
 * 引用接地证据视图组件(claim↔证据/闸门/覆盖率/文献库)。
 *
 * 产品差异化核心:让"引用接地"成为第一类公民 —— 每条结论一键查出处,未接地论断
 * 红标。数据来自 master oc-cite check 的已检 EvidenceManifest(status 由平台铸造,
 * 前端只呈现,不改判定)。
 *
 * 消费方:researchCards.tsx 的 oc-report 产物卡(经签名 URL 拉 manifest sidecar 后渲染)。
 * 历史:曾按 role="research-report" 消息驱动(ResearchReportCard),但 WS 引擎从不产出
 * 该角色帧,死代码已删;现改为工具产物驱动,这才是真实会话里走得到的路径。
 */
import { BookOpen, Check, Copy, Download, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { Claim, EvidenceManifest, QuoteHandle, SourceRecord } from "@openclaude/protocol/research";
import { exportLibrary } from "../../lib/research/cite";
import { cn } from "../../lib/utils";
import { Badge, Button } from "../ui";

export function CoverageBadge({ coverage }: { coverage: EvidenceManifest["coverage"] }) {
  const { verifiedClaims, totalClaims } = coverage;
  const allOk = totalClaims > 0 && verifiedClaims === totalClaims;
  return (
    <Badge tone={totalClaims === 0 ? "neutral" : allOk ? "success" : "warning"}>
      接地 {verifiedClaims}/{totalClaims}
    </Badge>
  );
}

export function GatesRow({ manifest }: { manifest: EvidenceManifest }) {
  // gates 是 oc-cite check 回填的;手工/旧 manifest 可能缺 —— 缺则不渲染闸门行(不崩)。
  const g = manifest.gates;
  if (!g?.quoteFirst || !g.claimBound || !g.identifier || !g.retraction) return null;
  const items: { label: string; passed: boolean }[] = [
    { label: "quote 接地", passed: g.quoteFirst.passed },
    { label: "claim 绑定", passed: g.claimBound.passed },
    { label: "identifier", passed: g.identifier.passed },
    { label: "撤稿过滤", passed: g.retraction.passed },
  ];
  if (g.minicheck) items.push({ label: "语义蕴含", passed: g.minicheck.passed });
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

export function ClaimList({ manifest }: { manifest: EvidenceManifest }) {
  // 每渲染重算(不 useMemo):调用方可能就地 mutate,useMemo 会 stale。
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

export function LiteratureLibraryPanel({ sources }: { sources: SourceRecord[] }) {
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
