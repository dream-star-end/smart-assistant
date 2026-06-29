/**
 * 研究/通用 oc-* CLI 工具的**专门卡片**渲染。
 *
 * v5 的工具是 CLI + skill 机制:agent 只 `oc-lit search "词"` 传参,CLI 封装 HTTP/token/proxy。
 * 这里做"前端专门适配":识别 Bash 命令是某个 oc-* 工具 + 解析其结构化 JSON 输出 → 渲染
 * 对应的漂亮卡片(而非原始命令+JSON 文本)。不认/解析失败 → 返回 null,调用方回落通用 BashBody。
 *
 * 扩展:新工具只需在 RESEARCH_CARD_REGISTRY 里加一条 {match, render}。
 */
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Database,
  ExternalLink,
  FileText,
  FileOutput,
  Package,
  Quote,
  Search,
  Trophy,
  XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { asArr, asStr, isSafeHttpUrl, type ToolLike } from "./format";

// ── 解析助手 ────────────────────────────────────────────────────────────────

/** 是否为非空对象(过滤数组里的 null / 基本类型 / 嵌套数组,防 agent 产出畸形 JSON 渲染崩)。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** 取对象数组:仅保留 record 元素(畸形元素丢弃,绝不让渲染崩);按调用方接口形状断言。 */
function recArr<T>(v: unknown): T[] {
  return asArr(v).filter(isRecord) as unknown as T[];
}

/** tool 的真实输出文本(优先 output,回落 bashTail)。 */
function outputText(tool: ToolLike): string | null {
  if (typeof tool.output === "string" && tool.output.trim()) return tool.output;
  const tail = tool.bashTail?.tail;
  if (typeof tail === "string" && tail.trim()) return tail;
  return null;
}

/** 宽松解析 JSON:整段 parse;失败则尝试截取第一个 {…} 块(命令回显/前导日志容错)。 */
function looseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(text.trim());
  if (direct) return direct;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(text.slice(start, end + 1));
  return null;
}

/**
 * 命令的"可执行名"是否就是某个 oc-* 工具(而非只是命令里提到它)。
 * 命中 `oc-lit ...`、`FOO=bar oc-lit ...`、`/usr/local/bin/oc-lit ...`;
 * 不命中 `echo oc-lit`、`cat oc-lit.sh`(首词是 echo/cat)。
 */
function matchOcTool(command: string, tool: string): boolean {
  let c = command.trim();
  // 去掉前导 env 赋值(VAR=val ...)。
  while (/^\w+=\S*\s+/.test(c)) c = c.replace(/^\w+=\S*\s+/, "");
  const first = c.split(/\s+/)[0] ?? "";
  const base = first.split("/").pop() ?? first;
  return base === tool;
}

// ── 共用 UI 原语(与 bodies.tsx 同审美) ──────────────────────────────────────

function CardShell({ icon, title, subtitle, children }: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-1.5 rounded-md border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-accent">{icon}</span>
        <span className="font-medium text-sm text-fg">{title}</span>
        {subtitle && <span className="text-xs text-faint">{subtitle}</span>}
      </div>
      <div className="px-3 py-2">{children}</div>
    </div>
  );
}

function Chip({ children, href, tone }: { children: ReactNode; href?: string; tone?: "danger" | "ok" | "muted" }) {
  const cls = cn(
    "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]",
    tone === "danger"
      ? "bg-danger/10 text-danger"
      : tone === "ok"
        ? "bg-success/10 text-success"
        : "bg-hover text-faint",
  );
  if (href && isSafeHttpUrl(href)) {
    return (
      <a className={cn(cls, "hover:underline")} href={href} target="_blank" rel="noreferrer noopener">
        {children}
        <ExternalLink className="size-2.5" />
      </a>
    );
  }
  return <span className={cls}>{children}</span>;
}

// ── 文献检索卡(oc-lit search / snowball) ────────────────────────────────────

interface LitAuthor {
  name?: string;
}
interface LitSource {
  id?: string;
  title?: string;
  authors?: LitAuthor[];
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  citationCount?: number;
  oa?: { isOA?: boolean; url?: string };
  retracted?: boolean | null;
}

function authorsLine(authors: unknown): string {
  // authors 可能非数组 / 元素是 record{name} 或裸字符串 / null —— 全部容错(防 agent 畸形 JSON)。
  const names = asArr(authors)
    .map((a) => (isRecord(a) ? asStr(a.name) : asStr(a)))
    .filter(Boolean);
  if (names.length === 0) return "";
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} 等`;
}

function LiteratureCard({ data }: { data: Record<string, unknown> }) {
  const sources = recArr<LitSource>(data.sources);
  const warnings = asArr(data.warnings).map((w) => asStr(w)).filter(Boolean);
  if (sources.length === 0 && warnings.length === 0) return null;
  return (
    <CardShell icon={<BookOpen className="size-4" />} title="文献检索" subtitle={`${sources.length} 篇`}>
      {sources.length > 0 && (
        <ul className="flex flex-col divide-y divide-border">
          {sources.slice(0, 50).map((s, i) => {
            const meta = [authorsLine(s.authors), s.year ? String(s.year) : "", asStr(s.venue)]
              .filter(Boolean)
              .join(" · ");
            const doi = asStr(s.doi);
            const arxiv = asStr(s.arxivId);
            const oaUrl = asStr(s.oa?.url);
            return (
              <li key={s.id || `${i}`} className="py-2 first:pt-0 last:pb-0">
                <div className="text-[13px] leading-snug text-fg">{asStr(s.title) || "(无标题)"}</div>
                {meta && <div className="mt-0.5 text-xs text-faint">{meta}</div>}
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {s.retracted === true && (
                    <Chip tone="danger">
                      <AlertTriangle className="size-2.5" />
                      已撤稿
                    </Chip>
                  )}
                  {s.oa?.isOA && oaUrl && (
                    <Chip href={oaUrl} tone="ok">
                      开放获取
                    </Chip>
                  )}
                  {doi && <Chip href={`https://doi.org/${encodeURIComponent(doi)}`}>DOI</Chip>}
                  {arxiv && <Chip href={`https://arxiv.org/abs/${encodeURIComponent(arxiv)}`}>arXiv</Chip>}
                  {typeof s.citationCount === "number" && <Chip>被引 {s.citationCount}</Chip>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {warnings.length > 0 && (
        <div className="mt-2 flex items-start gap-1.5 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>部分来源暂不可用:{warnings.join(";")}</span>
        </div>
      )}
    </CardShell>
  );
}

// ── 引用核验卡(oc-cite verify / check / fix) ────────────────────────────────

interface Verdict {
  identifier?: string;
  resolved?: boolean;
  retracted?: boolean | null;
  apa?: string;
  gbt7714?: string;
}
interface QuoteRow {
  id?: string;
  text?: string;
  sourceId?: string;
}
interface Claim {
  id?: string;
  text?: string;
  status?: string;
  supports?: { quoteId?: string }[];
}

function CitationCard({ data }: { data: Record<string, unknown> }) {
  const verdicts = recArr<Verdict>(data.verdicts);
  const claims = recArr<Claim>(data.claims);
  // verify:逐条 identifier 的接地/撤稿。
  if (verdicts.length > 0) {
    return (
      <CardShell icon={<Quote className="size-4" />} title="引用核验" subtitle={`${verdicts.length} 条`}>
        <ul className="flex flex-col divide-y divide-border">
          {verdicts.slice(0, 50).map((v, i) => {
            const cite = asStr(v.gbt7714) || asStr(v.apa);
            const ok = v.resolved === true && v.retracted !== true;
            return (
              <li key={v.identifier || `${i}`} className="flex items-start gap-2 py-2 first:pt-0 last:pb-0">
                {ok ? (
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
                ) : (
                  <XCircle className="mt-0.5 size-3.5 shrink-0 text-danger" />
                )}
                <div className="min-w-0">
                  <div className="text-[13px] leading-snug text-fg">{cite || asStr(v.identifier)}</div>
                  <div className="mt-0.5 flex flex-wrap gap-1.5">
                    <Chip tone={v.resolved ? "ok" : "danger"}>{v.resolved ? "已接地" : "未命中可信记录"}</Chip>
                    {v.retracted === true && <Chip tone="danger">已撤稿</Chip>}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </CardShell>
    );
  }
  // check / fix:已检 manifest——claim 接地状态(verified 绿 / unsupported 红)+ 其引用原文。
  if (claims.length > 0) {
    const quotes = recArr<QuoteRow>(data.quotes);
    const quoteById = new Map(quotes.map((q) => [asStr(q.id), q] as const));
    const verified = claims.filter((c) => c.status === "verified").length;
    const unsupported = claims.filter((c) => c.status === "unsupported").length;
    return (
      <CardShell
        icon={<Quote className="size-4" />}
        title="引用接地校验"
        subtitle={`${verified} 已接地 · ${unsupported} 未支撑`}
      >
        <ul className="flex flex-col divide-y divide-border">
          {claims.slice(0, 50).map((c, i) => {
            const q = quoteById.get(asStr(c.supports?.[0]?.quoteId));
            const tone = c.status === "verified" ? "ok" : c.status === "unsupported" ? "danger" : "muted";
            const label = c.status === "verified" ? "已接地" : c.status === "unsupported" ? "未支撑" : "未校验";
            return (
              <li key={c.id || `${i}`} className="py-2 first:pt-0 last:pb-0">
                <div className="flex items-start gap-2">
                  <Chip tone={tone}>{label}</Chip>
                  <div className="min-w-0 text-[13px] leading-snug text-fg">{asStr(c.text)}</div>
                </div>
                {q?.text && (
                  <div className="mt-1 border-l-2 border-border pl-2 text-xs text-faint italic">
                    “{asStr(q.text).slice(0, 240)}”
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </CardShell>
    );
  }
  return null;
}

// ── 入库卡(oc-ingest) ──────────────────────────────────────────────────────

function IngestCard({ data }: { data: Record<string, unknown> }) {
  if (data.needsOcr === true) {
    return (
      <CardShell icon={<Database className="size-4" />} title="文档入库">
        <div className="flex items-start gap-1.5 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>需要 OCR(扫描件无文本层):{asStr(data.reason) || "未提供原因"}</span>
        </div>
      </CardShell>
    );
  }
  const docId = asStr(data.docId);
  if (!docId) return null;
  const meta = [asStr(data.lang), data.spanCount != null ? `${String(data.spanCount)} 片段` : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <CardShell icon={<Database className="size-4" />} title="文档已入库" subtitle={meta}>
      <div className="text-[13px] text-fg">{asStr(data.title) || "(无标题)"}</div>
      <div className="mt-0.5 font-mono text-[11px] text-faint">{docId}</div>
    </CardShell>
  );
}

// ── 检索片段卡(oc-litrag) ───────────────────────────────────────────────────

function LitragCard({ data }: { data: Record<string, unknown> }) {
  const quotes = recArr<QuoteRow>(data.quotes);
  const missing = asArr(data.missing).map((m) => asStr(m)).filter(Boolean);
  if (quotes.length === 0 && missing.length === 0) return null;
  return (
    <CardShell icon={<Search className="size-4" />} title="原文片段定位" subtitle={`${quotes.length} 处`}>
      {quotes.length > 0 && (
        <ul className="flex flex-col gap-2">
          {quotes.slice(0, 30).map((q, i) => (
            <li key={q.id || `${i}`} className="border-l-2 border-accent/40 pl-2">
              <div className="text-[13px] leading-snug text-fg">“{asStr(q.text).slice(0, 300)}”</div>
              {q.sourceId && <div className="mt-0.5 font-mono text-[11px] text-faint">{asStr(q.sourceId)}</div>}
            </li>
          ))}
        </ul>
      )}
      {missing.length > 0 && (
        <div className="mt-2 text-xs text-faint">未在已入库文档中找到:{missing.join(", ")}</div>
      )}
    </CardShell>
  );
}

// ── 产物卡(oc-report 报告 / oc-slides 幻灯 / oc-poster 海报) ──────────────────

function ArtifactCard({ data }: { data: Record<string, unknown> }) {
  const output = asStr(data.output);
  if (!output) return null;
  const fileName = output.split("/").pop() || output;
  const warnings = asArr(data.warnings).map((w) => asStr(w)).filter(Boolean);
  const refs = typeof data.references === "number" ? data.references : null;
  const slides = typeof data.slideCount === "number" ? data.slideCount : null;
  const title = slides != null ? "幻灯/海报已生成" : "报告已生成";
  return (
    <CardShell icon={<FileOutput className="size-4" />} title={title} subtitle={fileName}>
      <div className="flex flex-wrap gap-1.5">
        {refs != null && <Chip>{refs} 条参考文献</Chip>}
        {slides != null && <Chip>{slides} 页</Chip>}
        {refs != null &&
          (warnings.length === 0 ? (
            <Chip tone="ok">引用接地无红标</Chip>
          ) : (
            <Chip tone="danger">{warnings.length} 处未接地/红标</Chip>
          ))}
      </div>
      {warnings.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5 text-xs text-danger">
          {warnings.slice(0, 10).map((w, i) => (
            <li key={`${i}-${w.slice(0, 16)}`} className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}

// ── 排名卡(oc-rank) ────────────────────────────────────────────────────────

interface Ranked {
  id?: string;
  rating?: number;
  wins?: number;
  losses?: number;
  draws?: number;
}

function RankCard({ data }: { data: Record<string, unknown> }) {
  const ranked = recArr<Ranked>(data.ranked);
  if (ranked.length === 0) return null;
  return (
    <CardShell icon={<Trophy className="size-4" />} title="候选排名" subtitle={`${ranked.length} 项`}>
      <ol className="flex flex-col divide-y divide-border">
        {ranked.slice(0, 30).map((r, i) => (
          <li key={r.id || `${i}`} className="flex items-center gap-2 py-1.5 first:pt-0 last:pb-0">
            <span className={cn("w-5 text-center text-xs", i === 0 ? "text-accent font-semibold" : "text-faint")}>
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{asStr(r.id)}</span>
            {typeof r.rating === "number" && <Chip>Elo {Math.round(r.rating)}</Chip>}
            {(r.wins != null || r.losses != null) && (
              <span className="text-[11px] text-faint">
                {r.wins ?? 0}胜 {r.losses ?? 0}负 {r.draws ?? 0}平
              </span>
            )}
          </li>
        ))}
      </ol>
    </CardShell>
  );
}

// ── 文档产物卡(oc-docx) ─────────────────────────────────────────────────────

function DocxCard({ command }: { command: string }) {
  // oc-docx 输出是 pandoc/quarto(非 JSON),从命令解析输出文件名。
  const m = command.match(/(?:-o|--output)\s+(\S+)/) ?? command.match(/(\S+\.docx)\b/);
  const out = m?.[1] ?? "";
  const fileName = out ? out.replace(/^['"]|['"]$/g, "").split("/").pop() : "文档.docx";
  return (
    <CardShell icon={<FileText className="size-4" />} title="Word 文档已生成" subtitle={fileName || undefined}>
      <div className="text-xs text-faint">可在文件区下载;数学公式/排版已按高质量 Word 模板渲染。</div>
    </CardShell>
  );
}

// ── 技能市场卡(oc-market search / installed) ────────────────────────────────

interface MarketItem {
  slug?: string;
  name?: string;
  description?: string;
  kind?: string;
  version?: string;
}

function MarketCard({ tool }: { tool: ToolLike }) {
  const text = outputText(tool);
  let items: MarketItem[] = [];
  if (text) {
    try {
      const v = JSON.parse(text.trim());
      if (Array.isArray(v)) items = v.filter(isRecord) as unknown as MarketItem[];
      else if (isRecord(v) && Array.isArray(v.results))
        items = (v.results as unknown[]).filter(isRecord) as unknown as MarketItem[];
    } catch {
      // 非 list 输出(install/uninstall 等)→ 不渲染,回落通用。
    }
  }
  if (items.length === 0) return null;
  return (
    <CardShell icon={<Package className="size-4" />} title="技能市场" subtitle={`${items.length} 项`}>
      <ul className="flex flex-col divide-y divide-border">
        {items.slice(0, 30).map((it, i) => (
          <li key={it.slug || `${i}`} className="py-2 first:pt-0 last:pb-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-fg">{asStr(it.name) || asStr(it.slug)}</span>
              {it.kind && <Chip>{it.kind === "agent" ? "智能体" : "技能"}</Chip>}
              {it.version && <Chip>v{asStr(it.version)}</Chip>}
            </div>
            {it.description && (
              <div className="mt-0.5 line-clamp-2 text-xs text-faint">{asStr(it.description)}</div>
            )}
          </li>
        ))}
      </ul>
    </CardShell>
  );
}

// ── 注册表 + 分派入口 ────────────────────────────────────────────────────────

interface CardEntry {
  /** 命令命中判定(可执行名 == 工具名)。 */
  match: (command: string) => boolean;
  /**
   * 渲染。**直接调用卡片函数**(而非 `<Card/>` JSX 实例化),使卡片返回的 null 能正确透传:
   * 否则 `<Card/>` 元素恒为真值,即便卡片渲染 null,BashBody 也会 early-return 空卡、不回落通用。
   */
  render: (command: string, tool: ToolLike) => ReactNode | null;
}

/** 解析对象型输出,交给对象卡片函数(解析失败/卡片判空 → null 回落)。 */
function obj(tool: ToolLike, card: (p: { data: Record<string, unknown> }) => ReactNode | null): ReactNode | null {
  const data = looseJson(outputText(tool));
  return data ? card({ data }) : null;
}

const TOOL_CARD_REGISTRY: CardEntry[] = [
  // 研究工具(对象型 JSON 输出)。
  { match: (c) => matchOcTool(c, "oc-lit"), render: (_c, t) => obj(t, LiteratureCard) },
  { match: (c) => matchOcTool(c, "oc-cite"), render: (_c, t) => obj(t, CitationCard) },
  { match: (c) => matchOcTool(c, "oc-ingest"), render: (_c, t) => obj(t, IngestCard) },
  { match: (c) => matchOcTool(c, "oc-litrag"), render: (_c, t) => obj(t, LitragCard) },
  { match: (c) => matchOcTool(c, "oc-report"), render: (_c, t) => obj(t, ArtifactCard) },
  { match: (c) => matchOcTool(c, "oc-slides"), render: (_c, t) => obj(t, ArtifactCard) },
  { match: (c) => matchOcTool(c, "oc-poster"), render: (_c, t) => obj(t, ArtifactCard) },
  { match: (c) => matchOcTool(c, "oc-rank"), render: (_c, t) => obj(t, RankCard) },
  // 其它通用工具。
  { match: (c) => matchOcTool(c, "oc-docx"), render: (c) => DocxCard({ command: c }) },
  { match: (c) => matchOcTool(c, "oc-market"), render: (_c, t) => MarketCard({ tool: t }) },
];

/**
 * 若 Bash 命令是某个 oc-* 工具 → 返回其专门卡片;不认/出错/输出不可解析 → null(回落通用 BashBody)。
 * 由 BashBody 在渲染通用终端块前调用。
 */
export function researchToolCard(command: string, tool: ToolLike): ReactNode | null {
  if (!command) return null;
  const entry = TOOL_CARD_REGISTRY.find((e) => e.match(command));
  if (!entry) return null;
  // 出错的调用回落通用(让用户看到错误输出)。
  if (tool.error) return null;
  return entry.render(command, tool);
}
