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
  AppWindow,
  Archive,
  BookOpen,
  Bot,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  ExternalLink,
  Eye,
  FileSpreadsheet,
  FileText,
  FileOutput,
  Globe,
  Image as ImageIcon,
  Keyboard,
  Mic,
  MousePointer2,
  Music,
  Package,
  Quote,
  Search,
  ShieldCheck,
  Trophy,
  Video,
  XCircle,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import type { EvidenceManifest } from "@openclaude/protocol/research";
import { cn } from "../../lib/utils";
import { SignedAudio, SignedFileCard, SignedImg, SignedVideo, useSignedSrc } from "../chat/media";
import { ClaimList, CoverageBadge, GatesRow, LiteratureLibraryPanel } from "../chat/researchEvidence";
import { connectorToolCard } from "./connectorCards";
import { ExpandControls, useExpandableSlice } from "./expandable";
import { asArr, asStr, detectShellFileWrites, isSafeHttpUrl, type ToolLike } from "./format";
import { detectOcCli, type OcCli } from "./meta";

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
 * 从一段**可能被截断**的 JSON 文本里,恢复出第一个"对象数组"(形如 `"<key>":[{…},{…},…`)
 * 中**已完整到达**的元素。渐进披露的核心:工具输出经 preview/bashTail 截断后(尾部可能是半截
 * 对象),仍能把前面已加载完整的若干条渲染出来,而非整张卡白屏。绝不抛异常。
 *
 * 返回命中的 key 与已恢复的对象数组;没有可恢复的对象数组 → null。字符串/转义感知地数花括号
 * 深度,只收 depth 归零(完整闭合)的顶层对象;遇到截断的半截对象即停止。
 */
function recoverArrayPrefix(text: string): { key: string; items: Record<string, unknown>[] } | null {
  // 第一个"值是对象数组"的键(跳过 `"warnings":[]` / 字符串数组等)。
  const m = text.match(/"(\w+)"\s*:\s*\[\s*\{/);
  if (!m || m.index == null) return null;
  const key = m[1] ?? "";
  const n = text.length;
  // 定位到该数组首个 '{'。
  let i = text.indexOf("{", m.index + m[0].length - 1);
  if (i < 0) return null;
  const items: Record<string, unknown>[] = [];
  while (i < n) {
    while (i < n && (text[i] === " " || text[i] === "\n" || text[i] === "\t" || text[i] === "\r" || text[i] === ",")) i++;
    if (i >= n || text[i] === "]") break;
    if (text[i] !== "{") break;
    const start = i;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let complete = false;
    for (; i < n; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          i++;
          complete = true;
          break;
        }
      }
    }
    if (!complete) break; // 半截对象(被截断)→ 停止收集
    try {
      const o = JSON.parse(text.slice(start, i));
      if (o && typeof o === "object" && !Array.isArray(o)) items.push(o as Record<string, unknown>);
      else break;
    } catch {
      break;
    }
  }
  return items.length > 0 ? { key, items } : null;
}

/**
 * 工具结构化输出解析(渐进披露):先尝试整段解析(未截断的常见情形);失败(被截断)则从
 * 截断文本里恢复第一个对象数组的已加载完整条目,标记 partial=true 让卡片提示"部分加载"。
 */
function parseToolData(text: string | null): { data: Record<string, unknown>; partial: boolean } | null {
  const full = looseJson(text);
  if (full) return { data: full, partial: false };
  const rec = recoverArrayPrefix(text ?? "");
  if (rec) return { data: { [rec.key]: rec.items }, partial: true };
  return null;
}

// ── 共用 UI 原语(与 bodies.tsx 同审美) ──────────────────────────────────────

// M5:专属卡恒在 ToolCard 内部渲染,外层表头已有图标 + 标签 —— 此处不再重复图标+大标题
// (双层表头视觉过重)。保留一行轻量状态行:标题弱化为 faint 小字,subtitle(数量/状态)照旧。
// icon 参数保留在签名里(各卡传参不动),仅不渲染。
function CardShell({ title, subtitle, children }: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-[11.5px] font-medium text-faint">{title}</span>
        {subtitle && (
          <span className="ml-auto shrink-0 rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-faint">
            {subtitle}
          </span>
        )}
      </div>
      <div>{children}</div>
    </section>
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

/** 渐进披露提示:结果被截断、卡片只展示已加载的前若干条时给用户的一行说明。 */
function PartialNote({ shown }: { shown: number }) {
  return (
    <div className="mt-2 text-[11px] text-faint">
      结果较多,卡片仅展示已加载的前 {shown} 条;完整结果见上方回答。
    </div>
  );
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

function LiteratureCard({ data, partial }: { data: Record<string, unknown>; partial?: boolean }) {
  const sources = recArr<LitSource>(data.sources);
  const warnings = asArr(data.warnings).map((w) => asStr(w)).filter(Boolean);
  if (sources.length === 0 && warnings.length === 0) return null;
  return (
    <CardShell
      icon={<BookOpen className="size-4" />}
      title="文献检索"
      subtitle={partial ? `已加载 ${sources.length} 篇` : `${sources.length} 篇`}
    >
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
      {partial && <PartialNote shown={sources.length} />}
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
  bibtex?: string;
  record?: { title?: string; authors?: LitAuthor[]; year?: number; venue?: string; doi?: string };
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

function CitationCard({ data, partial }: { data: Record<string, unknown>; partial?: boolean }) {
  const verdicts = recArr<Verdict>(data.verdicts);
  // format:单条 verdict + 格式化引用(bibtex/apa/gbt7714)。
  const single = isRecord(data.verdict) ? (data.verdict as Verdict) : null;
  // check/fix:claims/quotes 嵌在 manifest 下(兼容旧的 top-level)。
  const manifest = isRecord(data.manifest) ? data.manifest : data;
  const claims = recArr<Claim>(manifest.claims);
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
        {partial && <PartialNote shown={verdicts.length} />}
      </CardShell>
    );
  }
  // format:单条引用格式化(GB-T 7714 / APA / BibTeX),给可复制的引用串。
  if (single) {
    const rec = isRecord(single.record) ? (single.record as Verdict["record"]) : undefined;
    const cite = asStr(single.gbt7714) || asStr(single.apa) || asStr(single.bibtex);
    const ok = single.resolved === true && single.retracted !== true;
    const meta = [authorsLine(rec?.authors), rec?.year ? String(rec.year) : "", asStr(rec?.venue)]
      .filter(Boolean)
      .join(" · ");
    return (
      <CardShell
        icon={<Quote className="size-4" />}
        title="引用格式化"
        subtitle={asStr(rec?.doi) || asStr(single.identifier)}
      >
        <div className="text-[13px] leading-snug text-fg">{asStr(rec?.title) || asStr(single.identifier)}</div>
        {meta && <div className="mt-0.5 text-xs text-faint">{meta}</div>}
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Chip tone={ok ? "ok" : "danger"}>{single.resolved ? "已接地" : "未命中可信记录"}</Chip>
          {single.retracted === true && <Chip tone="danger">已撤稿</Chip>}
        </div>
        {cite && (
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded bg-code px-2.5 py-2 font-mono text-[12px] text-muted">
            {cite}
          </pre>
        )}
      </CardShell>
    );
  }
  // check / fix:已检 manifest——claim 接地状态(verified 绿 / unsupported 红)+ 其引用原文。
  if (claims.length > 0) {
    const quotes = recArr<QuoteRow>(manifest.quotes);
    const quoteById = new Map(quotes.map((q) => [asStr(q.id), q] as const));
    const cov = isRecord(manifest.coverage) ? manifest.coverage : null;
    const verified =
      cov && typeof cov.verifiedClaims === "number"
        ? cov.verifiedClaims
        : claims.filter((c) => c.status === "verified").length;
    const unsupported = claims.filter((c) => c.status === "unsupported").length;
    const subtitle =
      unsupported > 0 ? `${claims.length} 条 · ${verified} 已接地 · ${unsupported} 未支撑` : `${claims.length} 条 · ${verified} 已接地`;
    return (
      <CardShell icon={<Quote className="size-4" />} title="引用接地校验" subtitle={subtitle}>
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
        {partial && <PartialNote shown={claims.length} />}
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

function LitragCard({ data, partial }: { data: Record<string, unknown>; partial?: boolean }) {
  const quotes = recArr<QuoteRow>(data.quotes);
  const missing = asArr(data.missing).map((m) => asStr(m)).filter(Boolean);
  if (quotes.length === 0 && missing.length === 0) return null;
  return (
    <CardShell
      icon={<Search className="size-4" />}
      title="原文片段定位"
      subtitle={partial ? `已加载 ${quotes.length} 处` : `${quotes.length} 处`}
    >
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
      {partial && <PartialNote shown={quotes.length} />}
    </CardShell>
  );
}

// ── 产物卡(oc-report 报告 / oc-slides 幻灯 / oc-poster 海报) ──────────────────

/** 浏览器可直接预览的产物类型(其余只给下载)。 */
const PREVIEWABLE_EXT = new Set(["html", "htm", "pdf", "png", "jpg", "jpeg", "gif", "webp", "svg"]);

/** 产物 src 安全白名单:只允许**容器绝对路径**(/… 非 //,useSignedSrc 会签名)或 **http(s)**。
 *  拒绝 javascript:/data:/blob:/协议相对/相对路径 —— 防工具输出里的恶意串拼成可点 href(XSS)。
 *  导出供 bodies.tsx 复用(codex imageView 缩略图);依赖方向 bodies → researchCards,无环。 */
export function safeArtifactSrc(s: unknown): string | null {
  const v = asStr(s).trim();
  if (!v) return null;
  // 内联 http(s) 判定:不用 isSafeHttpUrl 类型守卫,避免它把 string 在 else 分支窄成 never。
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("/") && !v.startsWith("//")) return v;
  return null;
}

/** 从路径取小写扩展名(先去 query/hash,再取末段 . 后)。 */
function fileExt(s: string): string {
  const path = s.split(/[?#]/)[0] ?? "";
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** 产物「预览」链接:容器路径经 /api/media-sign 签名后用新标签打开(html/pdf/图浏览器原生渲染)。
 *  独立组件:研究卡是纯函数不能用 hook,预览需 useSignedSrc → 在此组件内调用。src 必须已过白名单。 */
function ArtifactPreviewLink({ src }: { src: string }) {
  const previewable = PREVIEWABLE_EXT.has(fileExt(src));
  const { url: signed } = useSignedSrc(previewable ? src : null);
  if (!previewable || !signed) return null;
  return (
    <a
      href={signed}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 rounded bg-accent-soft px-2 py-1 text-[12px] text-accent hover:underline"
    >
      预览
      <ExternalLink className="size-3" />
    </a>
  );
}

/** 引用接地详情区:懒加载 manifest sidecar(经 /api/media-sign 签名取数),渲染闸门 +
 *  claim↔证据(角标[N]可点查出处)+ 文献库(GB/T7714/BibTeX 导出)。独立组件:需 hook。 */
function EvidenceSection({ src, coverage }: {
  src: string;
  coverage: { verifiedClaims: number; totalClaims: number } | null;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"evidence" | "library">("evidence");
  const [manifest, setManifest] = useState<EvidenceManifest | null>(null);
  const [error, setError] = useState(false);
  const { url: signed } = useSignedSrc(open ? src : null);

  useEffect(() => {
    if (!open || !signed || manifest || error) return;
    let cancelled = false;
    fetch(signed)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((m: unknown) => {
        if (cancelled) return;
        // 轻校验:三个数组 + coverage 对象在(渲染组件按此假设写),畸形则走错误态不崩。
        if (
          isRecord(m) && Array.isArray(m.claims) && Array.isArray(m.quotes) &&
          Array.isArray(m.sources) && isRecord(m.coverage)
        ) {
          setManifest(m as unknown as EvidenceManifest);
        } else setError(true);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, signed, manifest, error]);

  const sources = manifest?.sources ?? [];
  return (
    <div className="mt-2 rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[12.5px] text-fg hover:bg-hover"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        引用接地详情
        {coverage && <CoverageBadge coverage={coverage} />}
      </button>
      {open && (
        <div className="border-t border-border">
          {error && <div className="px-2.5 py-2 text-xs text-faint">证据清单不可用(可能已过期或被清理)。</div>}
          {!error && !manifest && <div className="px-2.5 py-2 text-xs text-faint">加载证据清单…</div>}
          {manifest && (
            <>
              <div className="flex items-center gap-1 px-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setTab("evidence")}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-[12px]",
                    tab === "evidence" ? "bg-accent-soft text-accent" : "text-muted hover:text-fg",
                  )}
                >
                  证据
                </button>
                <button
                  type="button"
                  onClick={() => setTab("library")}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-[12px]",
                    tab === "library" ? "bg-accent-soft text-accent" : "text-muted hover:text-fg",
                  )}
                >
                  文献库 {sources.length}
                </button>
              </div>
              {tab === "evidence" && (
                <div className="px-2.5 pb-2 pt-1.5">
                  <GatesRow manifest={manifest} />
                  <ClaimList manifest={manifest} />
                </div>
              )}
              {tab === "library" && <LiteratureLibraryPanel sources={sources} />}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ArtifactCard({ data }: { data: Record<string, unknown> }) {
  const output = asStr(data.output);
  if (!output) return null;
  const fileName = output.split("/").pop() || output;
  const safeOut = safeArtifactSrc(output); // 白名单后才做 href(防恶意 scheme)
  const qmd = asStr(data.qmd); // 中间产物(Quarto 源)
  const safeQmd = qmd && qmd !== output ? safeArtifactSrc(qmd) : null;
  const manifestSrc = safeArtifactSrc(data.manifestPath); // 引用接地 manifest sidecar
  const cov = isRecord(data.coverage) ? data.coverage : null;
  const coverage =
    cov && typeof cov.verifiedClaims === "number" && typeof cov.totalClaims === "number"
      ? { verifiedClaims: cov.verifiedClaims, totalClaims: cov.totalClaims }
      : null;
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
      {/* 引用接地详情(claim↔证据/闸门/文献库):manifest sidecar 懒加载 */}
      {manifestSrc && <EvidenceSection src={manifestSrc} coverage={coverage} />}
      {/* 结果产物:下载 + 预览(仅白名单安全 src) */}
      {safeOut && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <SignedFileCard src={safeOut} filename={fileName} />
          <ArtifactPreviewLink src={safeOut} />
        </div>
      )}
      {/* 中间产物(.qmd 源):下载 */}
      {safeQmd && (
        <div className="mt-1">
          <SignedFileCard src={safeQmd} filename={qmd.split("/").pop() || "source.qmd"} />
        </div>
      )}
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

function RankCard({ data, partial }: { data: Record<string, unknown>; partial?: boolean }) {
  const ranked = recArr<Ranked>(data.ranked);
  if (ranked.length === 0) return null;
  return (
    <CardShell
      icon={<Trophy className="size-4" />}
      title="候选排名"
      subtitle={partial ? `已加载 ${ranked.length} 项` : `${ranked.length} 项`}
    >
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
      {partial && <PartialNote shown={ranked.length} />}
    </CardShell>
  );
}

// ── 办公文档产物卡(oc-docx / oc-pdf / oc-xlsx) ──────────────────────────────

/**
 * 从命令行解析输出文件路径:这三个 CLI 的输出是 pandoc/Quarto/Typst 日志(非 JSON),
 * 只能从命令本身取输出名。优先 `-o/--output <path>`(含 `--output=path` 形式),
 * 回落"首个以 .<ext> 结尾的词"。去掉包裹引号;解析不出 → null。
 */
function parseOutputPath(command: string, ext: string): string | null {
  const m =
    command.match(/(?:^|\s)(?:-o|--output)(?:=|\s+)(\S+)/) ??
    command.match(new RegExp(`(\\S+\\.${ext})\\b`, "i"));
  const out = (m?.[1] ?? "").replace(/^['"]|['"]$/g, "");
  return out || null;
}

/**
 * 通用办公产物卡(oc-docx/oc-pdf/oc-xlsx 参数化标题/图标/提示文案)。
 * 若能从命令解析出**安全产物路径**(容器绝对路径,复用 safeArtifactSrc 白名单)→ 渲染
 * 签名下载卡 + 预览链接(pdf 等浏览器可原生渲染的类型),与 oc-report 产物卡体验对齐;
 * 解析不出安全绝对路径 → 退回提示文案(旧 DocxCard 行为)。
 */
function OfficeArtifactCard({ command, ext, title, icon, note }: {
  command: string;
  ext: string;
  title: string;
  icon: ReactNode;
  note: string;
}) {
  const out = parseOutputPath(command, ext);
  const fileName = out ? out.split("/").pop() || out : undefined;
  const safeOut = out ? safeArtifactSrc(out) : null; // 白名单后才做 href(防恶意 scheme)
  return (
    <CardShell icon={icon} title={title} subtitle={fileName}>
      {safeOut ? (
        <div className="flex flex-wrap items-center gap-2">
          <SignedFileCard src={safeOut} filename={fileName} />
          <ArtifactPreviewLink src={safeOut} />
        </div>
      ) : (
        <div className="text-xs text-faint">{note}</div>
      )}
    </CardShell>
  );
}

function DocxArtifactCard({ command }: { command: string }) {
  const operation = command.match(/(?:^|\s)(?:\S*\/)?oc-docx\s+(convert|build|render|inspect|scrub)\b/)?.[1];
  if (operation === "render") {
    return (
      <CardShell icon={<FileText className="size-4" />} title="Word 页面已渲染">
        <div className="text-xs text-faint">已生成逐页原图和视觉质检副本，请继续逐页检查。</div>
      </CardShell>
    );
  }
  if (operation === "inspect") {
    return (
      <CardShell icon={<FileText className="size-4" />} title="Word 结构检查完成">
        <div className="text-xs text-faint">已检查文档结构、元数据和逐页质检副本配对。</div>
      </CardShell>
    );
  }
  return (
    <OfficeArtifactCard
      command={command}
      ext="docx"
      title={operation === "scrub" ? "Word 文档已清理" : "Word 文档已生成"}
      icon={<FileText className="size-4" />}
      note="可在文件区下载；文档仍需按流程完成逐页质检后再交付。"
    />
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

function MarketItems({ items }: { items: MarketItem[] }) {
  const [visible, setVisible] = useState(8);
  const shown = Math.min(visible, items.length);
  return (
    <>
      <ul className="flex flex-col divide-y divide-border/80">
        {items.slice(0, shown).map((it, i) => (
          <li key={it.slug || `${i}`} className="py-2.5 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium text-fg">{asStr(it.name) || asStr(it.slug)}</span>
              {it.kind && <Chip>{it.kind === "agent" ? "智能体" : it.kind === "plugin" ? "插件" : "技能"}</Chip>}
              {it.version && <Chip>v{asStr(it.version)}</Chip>}
            </div>
            {it.description && (
              <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-faint">{asStr(it.description)}</div>
            )}
          </li>
        ))}
      </ul>
      {shown < items.length && (
        <button
          type="button"
          onClick={() => setVisible((value) => value + 12)}
          className="mt-2.5 min-h-8 rounded-full bg-hover px-3 text-xs font-medium text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
        >
          查看更多（还有 {items.length - shown} 项）
        </button>
      )}
    </>
  );
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
      <MarketItems items={items} />
    </CardShell>
  );
}

function marketCommand(command: string): { action: string; target: string } {
  const match = /(?:^|[;&|]\s*)oc-market\s+([\w-]+)(?:\s+(?:--slug\s+)?("[^"]+"|'[^']+'|[^\s;&|]+))?/i.exec(command);
  return {
    action: (match?.[1] ?? "").toLowerCase(),
    target: (match?.[2] ?? "").replace(/^["']|["']$/g, ""),
  };
}

function MarketToolCard({ command, tool }: { command: string; tool: ToolLike }): ReactNode | null {
  const { action, target } = marketCommand(command);
  if (action === "search" || action === "installed") return MarketCard({ tool });
  if (action === "detail") {
    const detail = looseJson(outputText(tool));
    if (detail) {
      return (
        <CardShell icon={<Package className="size-4" />} title="市场能力详情">
          <MarketItems items={[detail as MarketItem]} />
        </CardShell>
      );
    }
  }
  const title: Record<string, string> = {
    install: "安装市场能力",
    uninstall: "卸载市场能力",
    "publish-skill": "发布技能",
    "publish-agent": "发布智能体",
  };
  if (!title[action]) return null;
  return (
    <CardShell icon={<Package className="size-4" />} title={title[action]} subtitle={target || undefined}>
      <div className={cn(
        "rounded-lg px-3 py-2.5 text-[13px] leading-relaxed",
        tool._completed ? "bg-success-soft text-success" : "bg-accent-soft text-accent",
      )}>
        {tool._completed
          ? target
            ? `已完成对「${target}」的操作。`
            : "市场操作已完成。"
          : "正在处理市场操作…"}
      </div>
    </CardShell>
  );
}

// ── WebSearch 来源列表富卡(内置工具,非 oc-* CLI) ──────────────────────────

/** 从 url 取展示域名(去 www. 前缀);非法 url → undefined。 */
function domainOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet?: string;
}

// 后端 WebSearchTool 把结果拼成 `  - [title](url): snippet` 行(见 minimaxAdapter/
// WebSearchTool.mapToolResultToToolResultBlockParam)。逐行解析,非结果行(标题/REMINDER)
// 自然不匹配。纯函数:解析失败/空/畸形 → [](卡片据此回落通用文本块,UX 铁律)。
const WEB_SEARCH_LINE = /^\s*-\s+\[(.+?)\]\(([^)]+)\)(?::\s*(.*))?$/;

export function parseWebSearchResults(text: string | null | undefined): WebSearchHit[] {
  if (!text) return [];
  const hits: WebSearchHit[] = [];
  for (const line of text.split("\n")) {
    const m = WEB_SEARCH_LINE.exec(line);
    if (!m) continue;
    const url = (m[2] ?? "").trim();
    if (!url) continue;
    hits.push({ title: (m[1] ?? "").trim(), url, snippet: m[3]?.trim() || undefined });
  }
  return hits;
}

/** WebSearch 结果 → 来源列表富卡;解析不出结果 → null(调用方回落通用 OutputBlock)。 */
export function WebSearchResultsCard({ tool }: { tool: ToolLike }): ReactNode | null {
  const hits = parseWebSearchResults(outputText(tool));
  if (hits.length === 0) return null;
  return (
    <CardShell icon={<Search className="size-4" />} title="网页搜索" subtitle={`${hits.length} 条来源`}>
      <ul className="flex flex-col divide-y divide-border">
        {hits.slice(0, 20).map((h, i) => {
          const domain = domainOf(h.url);
          return (
            <li key={`${i}-${h.url}`} className="py-2 first:pt-0 last:pb-0">
              {isSafeHttpUrl(h.url) ? (
                <a
                  className="text-[13px] leading-snug text-accent hover:underline break-words"
                  href={h.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {h.title || h.url}
                </a>
              ) : (
                <div className="text-[13px] leading-snug text-fg break-words">{h.title || h.url}</div>
              )}
              {domain && <div className="mt-0.5 text-xs text-faint">{domain}</div>}
              {h.snippet && <div className="mt-1 text-xs text-faint line-clamp-2">{h.snippet}</div>}
            </li>
          );
        })}
      </ul>
    </CardShell>
  );
}

// ── oc-web 抽取富卡(摘要 + 折叠全文) ──────────────────────────────────────

interface OcWebContent {
  body: string;
  url?: string;
  truncated?: boolean;
}

/** oc-web 输出:默认是抽取的 markdown 正文;`--json` 模式是 {ok,markdown,final_url,truncated,…}。 */
function ocWebContent(tool: ToolLike): OcWebContent | null {
  const text = outputText(tool);
  if (!text) return null;
  const t = text.trim();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t);
      if (isRecord(j) && (typeof j.markdown === "string" || typeof j.text === "string")) {
        const body = (asStr(j.markdown) || asStr(j.text)).trim();
        if (!body) return null;
        return { body, url: asStr(j.final_url) || asStr(j.url), truncated: j.truncated === true };
      }
    } catch {
      /* 非 JSON → 当作 markdown 正文处理 */
    }
  }
  return t ? { body: t } : null;
}

/** 取首个非空段落作摘要(至多 240 字);标题行也可作首段。 */
function firstParagraph(md: string): string {
  const para = md.trim().split(/\n\s*\n/)[0] ?? md.trim();
  return para.length > 240 ? `${para.slice(0, 240)}…` : para;
}

/** oc-web 抽取 → 摘要富卡 + 折叠全文;无正文 → null(回落通用 BashBody)。 */
function OcWebExtractCard({ tool }: { tool: ToolLike }): ReactNode | null {
  const raw = outputText(tool);
  const blocked = raw?.match(/(?:^|\n)oc-web:\s*blocked:\s*([^\n]+)/i);
  if (blocked) {
    const reason = blocked[1]?.replace(/^blocked_phrase:/i, "").trim();
    return (
      <CardShell icon={<AlertTriangle className="size-4" />} title="网页提取受阻">
        <div className="rounded-lg bg-warning-soft px-3 py-2.5">
          <div className="text-[13px] font-medium text-warning">站点阻止了自动内容提取</div>
          <div className="mt-1 text-xs leading-relaxed text-muted">
            {reason?.toLowerCase().includes("cloudflare")
              ? "该页面启用了 Cloudflare 访问保护，可改用浏览器方式打开并读取页面。"
              : "页面拒绝了自动抓取，可尝试使用浏览器访问。"}
          </div>
        </div>
      </CardShell>
    );
  }
  const content = ocWebContent(tool);
  if (!content) return null;
  const { body, url, truncated } = content;
  const summary = firstParagraph(body);
  const domain = url ? domainOf(url) : undefined;
  return (
    <CardShell icon={<Globe className="size-4" />} title="网页/文档提取" subtitle={domain}>
      <div className="whitespace-pre-wrap break-words text-[13px] leading-snug text-fg">{summary}</div>
      {(url || truncated) && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {url && <Chip href={url}>{domain ?? "来源"}</Chip>}
          {truncated && <Chip tone="muted">已截断</Chip>}
        </div>
      )}
      {body.length > summary.length && (
        <details className="mt-2">
          <summary className="cursor-pointer rounded text-[11.5px] text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">查看抽取全文</summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg">
            {body}
          </pre>
        </details>
      )}
    </CardShell>
  );
}

// ── oc-* 通用工具原语 + 4 个新专属卡(oc-vision / oc-memory / oc-minimax / oc-browser)──
// 复用 CardShell + tone + lucide + 媒体签名组件,不发明新视觉语言;一律**不渲染原始
// `$ command` / stdout dump / 参数 dump**,只呈现语义结果(boss 硬需求)。

/** 从命令行解析某个 flag 的值(`--flag "v"` / `--flag=v` / `--flag v` / 短横 `-p v`);无则 ""。
 *  只取值,绝不回显整条命令。多个候选名按序尝试(如 prompt / p / text)。 */
function parseCommandFlag(command: string, ...flags: string[]): string {
  for (const f of flags) {
    const dashed = f.length === 1 ? `-${f}` : `--${f}`;
    const re = new RegExp(`(?:^|\\s)${dashed}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|(\\S+))`);
    const m = re.exec(command);
    if (m) return m[1] ?? m[2] ?? m[3] ?? "";
  }
  return "";
}

/** 命令里首个带引号的参数(≥2 字符),用于 mmx image 的位置型 prompt 兜底。 */
function firstQuotedArg(command: string): string {
  const m = /["']([^"']{2,})["']/.exec(command);
  return m ? m[1] : "";
}

/** 防御:即便工具输出里混入了 `$ command` 回显行,也剥掉首行——卡片内绝不暴露命令本身。 */
function stripCommandEcho(text: string): string {
  return text.replace(/^\s*\$ .*(?:\r?\n|$)/, "").replace(/^\s+/, "");
}

function stripExternalEnvelope(text: string): string {
  return text
    .replace(/^\[外部内容开始[^\n]*\]\s*/u, "")
    .replace(/\s*\[外部内容结束\]\s*$/u, "")
    .trim();
}

function normalizePreviewKey(key: string): string {
  return key.toLowerCase().replaceAll("_", "").replaceAll(" ", "");
}

/** 严格 Cursor 信封：`{ success: <object>, isBackground?: boolean }`，顶层不得有其它键。 */
function isCursorShellEnvelope(value: Record<string, unknown>): boolean {
  if (!isRecord(value.success)) return false;
  const keys = Object.keys(value);
  if (keys.some((k) => k !== "success" && k !== "isBackground")) return false;
  if ("isBackground" in value && typeof value.isBackground !== "boolean") return false;
  return true;
}

/** Cursor CLI 把 Bash 结果包成 `{ success: <shell>, isBackground?: boolean }`。渲染前剥掉信封。 */
function unwrapCursorShellEnvelope(value: Record<string, unknown>): Record<string, unknown> {
  if (!isCursorShellEnvelope(value)) return value;
  return value.success as Record<string, unknown>;
}

/** Cursor Shell 失败结果：{command, exitCode, stderr, stdout, workingDirectory, signal}。 */
function isShellResultObject(value: Record<string, unknown>): boolean {
  const keys = new Set(Object.keys(value).map(normalizePreviewKey));
  return keys.has("command") && (keys.has("exitcode") || keys.has("stderr") || keys.has("stdout"));
}

function shellResultString(value: Record<string, unknown>, field: "stdout" | "stderr"): string {
  for (const key of Object.keys(value)) {
    if (normalizePreviewKey(key) === field && typeof value[key] === "string" && value[key].trim()) {
      return value[key] as string;
    }
  }
  return "";
}

function shellResultMessage(value: Record<string, unknown>): string {
  const stderr = shellResultString(value, "stderr");
  if (stderr) return stderr;
  const err = value.error;
  return typeof err === "string" ? err : "";
}

/** 从 stdout / Cursor 信封 / 裸 shell JSON 取出可展示的 CLI 流。
 *  只有严格信封或 `isShellResultObject` 才解包；带 `stdout` 的普通 JSON 当不透明正文。 */
function cursorCliStreams(raw: string | null): { stdout: string; stderr: string } {
  if (!raw) return { stdout: "", stderr: "" };
  const clean = stripExternalEnvelope(stripCommandEcho(raw)).trim();
  if (!clean) return { stdout: "", stderr: "" };
  if (clean.startsWith("{")) {
    try {
      const parsed = JSON.parse(clean);
      if (isRecord(parsed)) {
        const inner = unwrapCursorShellEnvelope(parsed);
        if (isCursorShellEnvelope(parsed) || isShellResultObject(inner)) {
          return {
            stdout: typeof inner.stdout === "string" ? inner.stdout : "",
            stderr: typeof inner.stderr === "string" ? inner.stderr : "",
          };
        }
      }
    } catch {
      /* 文本预览兜底 */
    }
  }
  return { stdout: clean, stderr: "" };
}

function friendlyOcFailureText(raw: string): string {
  const text = raw.trim();
  if (/delegate client timeout/i.test(text)) {
    return "委派还在等待子任务完成，这一轮等待超时了。子任务可能仍在运行。";
  }
  if (/active turn policy is missing or expired/i.test(text)) {
    return "这一轮还不能检索记忆（会话策略未就绪或已过期）。";
  }
  return firstParagraph(text);
}

function FriendlyObjectPreview({ value }: { value: Record<string, unknown> }) {
  // L3:默认只展示前 6 个字段,余下给「还有 N 个字段」入口可展开全部。
  const [showAllFields, setShowAllFields] = useState(false);
  const unwrapped = unwrapCursorShellEnvelope(value);
  if (isShellResultObject(unwrapped)) {
    const stderr = shellResultMessage(unwrapped);
    if (stderr) {
      return (
        <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg">
          {friendlyOcFailureText(stderr)}
        </div>
      );
    }
    const stdout = shellResultString(unwrapped, "stdout");
    if (stdout) {
      return (
        <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg">
          {stdout}
        </div>
      );
    }
    return (
      <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg">
        工具执行失败。
      </div>
    );
  }
  const entries = Object.entries(unwrapped);
  if (entries.length === 0) return <div className="text-xs text-faint">没有返回内容。</div>;
  const rows = showAllFields ? entries : entries.slice(0, 6);
  return (
    <>
      <dl className="grid gap-2 sm:grid-cols-2">
        {rows.map(([key, item]) => (
          <div key={key} className="min-w-0 rounded-lg bg-hover/70 px-3 py-2">
            <dt className="text-[11px] font-medium text-faint">{key.replaceAll("_", " ")}</dt>
            <dd className="mt-0.5 break-words text-[12.5px] leading-relaxed text-fg">
              {typeof item === "string"
                ? firstParagraph(item)
                : typeof item === "number" || typeof item === "boolean"
                  ? String(item)
                  : Array.isArray(item)
                    ? `${item.length} 项`
                    : item && typeof item === "object"
                      ? `${Object.keys(item).length} 个字段`
                      : "—"}
            </dd>
          </div>
        ))}
      </dl>
      {!showAllFields && entries.length > 6 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setShowAllFields(true);
          }}
          className="mt-1.5 rounded text-xs text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          还有 {entries.length - 6} 个字段，展开全部
        </button>
      )}
    </>
  );
}

/** 折叠的"详细输出/错误详情"(默认收起;展开也只显示 stdout 正文,已剥离命令回显)。
 *  超过 4000 字不再硬截:接 F4 展开原语,可「展开全部/继续显示」。 */
function OutputDetails({ text, label }: { text: string | null; label: string }) {
  const clean = text ? stripCommandEcho(text).trim() : "";
  const slice = useExpandableSlice(clean, 4000);
  if (!clean) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer rounded text-[11.5px] text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
        {label}
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg">
        {slice.shown}
        {slice.truncated ? "\n…" : null}
      </pre>
      <ExpandControls slice={slice} />
    </details>
  );
}

/** 干净的语义结果正文(whitespace 保留、可换行),供识图/歌词/检索等纯文本 stdout 用。
 *  超过 4000 字接 F4 展开原语,不再"只截不展"。 */
function ResultText({ text }: { text: string }) {
  const slice = useExpandableSlice(text, 4000);
  return (
    <>
      <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg">
        {slice.shown}
        {slice.truncated ? "…" : null}
      </div>
      <ExpandControls slice={slice} />
    </>
  );
}

/** 提示/查询回显块(不是命令,是用户的问题/查询词)。 */
function PromptChip({ text }: { text: string }) {
  return <div className="rounded-md bg-hover px-3 py-2 text-[13px] leading-snug text-fg">{text}</div>;
}

/**
 * 通用 oc-* 卡:任何 oc-* CLI 无专属卡 / 解析失败 / 出错时的**兜底**,保证永不回落裸终端块
 * (不泄漏 `$ command`)。用该工具 OC_TOOLS 的图标/标签 + 干净状态行 + 可选折叠详细输出。
 */
function GenericOcCard({ cli, tool, error }: { cli: OcCli; tool: ToolLike; error?: boolean }) {
  const out = outputText(tool);
  const clean = out ? stripExternalEnvelope(stripCommandEcho(out)).trim() : "";
  let object: Record<string, unknown> | null = null;
  if (clean.startsWith("{")) {
    try {
      const parsed = JSON.parse(clean);
      if (isRecord(parsed)) object = parsed;
    } catch {
      /* 文本预览兜底 */
    }
  }
  return (
    <div className={cn("rounded-lg px-3 py-2.5", error ? "bg-danger-soft" : "bg-hover/70") }>
      {object ? (
        <FriendlyObjectPreview value={object} />
      ) : clean ? (
        <div className={cn("whitespace-pre-wrap break-words text-[13px] leading-relaxed", error ? "text-danger" : "text-fg") }>
          {error ? friendlyOcFailureText(clean) : firstParagraph(clean)}
        </div>
      ) : (
        <div className="text-xs text-faint">{error ? "工具执行失败。" : "操作已完成。"}</div>
      )}
    </div>
  );
}

/** 生成媒体预览:安全绝对/http 路径 → 缩略图/播放器;相对路径(签名不可用)→ 文件名提示。 */
function MediaPreview({ path, kind }: { path: string; kind: "image" | "audio" | "video" }) {
  const safe = safeArtifactSrc(path);
  const name = path.split("/").pop() || path;
  if (!safe) return <div className="mt-1 text-xs text-faint">已生成:{name}(可在文件区查看)</div>;
  if (kind === "image")
    return (
      <div className="mt-2">
        <SignedImg src={safe} alt={name} className="max-h-56 rounded-md border border-border" />
      </div>
    );
  if (kind === "video")
    return (
      <div className="mt-2">
        <SignedVideo src={safe} />
      </div>
    );
  return (
    <div className="mt-2">
      <SignedAudio src={safe} />
    </div>
  );
}

// ── oc-vision(图片理解)──────────────────────────────────────────────────────

/** oc-vision understand <image> [--prompt "问题"] → 缩略图 + 问题 + 识图结论(纯文本 stdout)。 */
function VisionCliCard({ command, tool }: { command: string; tool: ToolLike }): ReactNode | null {
  const prompt = parseCommandFlag(command, "prompt");
  const result = outputText(tool);
  // understand 之后的首个位置参数 = 被识别的图片路径。
  const imgMatch = /understand\s+(?:"([^"]+)"|'([^']+)'|([^\s"'-][^\s]*))/.exec(command);
  const imagePath = imgMatch ? (imgMatch[1] ?? imgMatch[2] ?? imgMatch[3] ?? "") : "";
  const safeImg = imagePath ? safeArtifactSrc(imagePath) : null;
  if (!prompt && !result && !safeImg) return null;
  return (
    <CardShell icon={<Eye className="size-4" />} title="图片理解">
      {safeImg && (
        <div className="mb-2">
          <SignedImg src={safeImg} alt="识别的图片" className="max-h-40 rounded-md border border-border" />
        </div>
      )}
      {prompt && <PromptChip text={prompt} />}
      {result && (
        <div className="mt-2">
          <ResultText text={result} />
        </div>
      )}
    </CardShell>
  );
}

// ── oc-memory(记忆读写/检索)──────────────────────────────────────────────────

/** oc-memory 的子命令(session-search / archival-*):取 CLI token 之后第一个词。
 *  注:`memory` 子命令已退役(核心记忆改 memdir 文件范式,后端提示 + exit2),此处只认深层召回类。 */
function memorySubcommand(command: string): string {
  const m = /oc-memory\s+([a-z-]+)/i.exec(command);
  return m ? m[1].toLowerCase() : "";
}

/** 子命令后的首个位置参数(session-search / archival-search 的查询词、archival-delete 的 id)。 */
function memoryPositional(command: string, sub: string): string {
  const re = new RegExp(`${sub}\\s+(?:"([^"]+)"|'([^']+)'|([^\\s"'-][^\\s]*))`);
  const m = re.exec(command);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
}

const MEMORY_SEARCH_SPEC: Record<string, { icon: ReactNode; title: string }> = {
  "session-search": { icon: <Search className="size-4" />, title: "历史检索" },
  "archival-search": { icon: <Archive className="size-4" />, title: "归档检索" },
  "archival-add": { icon: <Archive className="size-4" />, title: "归档写入" },
  "archival-delete": { icon: <Archive className="size-4" />, title: "归档删除" },
};

const MEMORY_DELEGATE_SPEC: Record<string, { icon: ReactNode; title: string }> = {
  delegate: { icon: <Bot className="size-4" />, title: "委派子任务" },
  "request-review": { icon: <ShieldCheck className="size-4" />, title: "质量审查" },
  "delegate-wait": { icon: <Clock className="size-4" />, title: "等待委派" },
};

/** oc-memory CLI(深层召回:session-search / archival-*)→ 干净检索结果卡;不裸露命令。
 *  `memory` 子命令已退役(→ null,由 researchToolCard 兜底 GenericOcCard,历史会话不泄漏命令)。
 *  Cursor 引擎走 `oc-memory delegate` Bash 路径：stdout 当 markdown 渲染，失败显示 stderr 首段。 */
function MemoryCliCard({ command, tool }: { command: string; tool: ToolLike }): ReactNode | null {
  const sub = memorySubcommand(command);
  const delegateSpec = MEMORY_DELEGATE_SPEC[sub];
  if (delegateSpec) {
    const streams = cursorCliStreams(outputText(tool));
    const stdout = streams.stdout.trim();
    const stderr = streams.stderr.trim();
    const body = stdout || (stderr ? firstParagraph(stderr) : "");
    if (!body) return null;
    return (
      <CardShell icon={delegateSpec.icon} title={delegateSpec.title}>
        <ResultText text={body} />
      </CardShell>
    );
  }
  const output = tool.output ?? null;
  const spec = MEMORY_SEARCH_SPEC[sub];
  if (!spec) return null;
  const query = sub === "archival-delete" ? "" : memoryPositional(command, sub);
  const clean = output ? stripCommandEcho(output).trim() : "";
  if (!clean && !query) return null;
  return (
    <CardShell icon={spec.icon} title={spec.title}>
      {query && (
        <div className="mb-1.5">
          <PromptChip text={query} />
        </div>
      )}
      {clean && <ResultText text={clean} />}
    </CardShell>
  );
}

// ── oc-minimax / mmx(媒体生成:图/视频/音频/歌词)──────────────────────────────

interface MinimaxParsed {
  paths: string[];
  taskId: string | null;
  text: string | null;
}

/** mmx 输出:媒体文件路径逐行 + 可选 `billing:`/`task_id:`/`status:` 行;lyrics 无 --out 时是歌词正文。 */
function parseMinimaxOutput(raw: string | null): MinimaxParsed {
  if (!raw) return { paths: [], taskId: null, text: null };
  const paths: string[] = [];
  let taskId: string | null = null;
  const rest: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^billing:/i.test(t) || /^status:/i.test(t)) continue;
    const tm = /^task_id:\s*(.+)$/i.exec(t);
    if (tm) {
      taskId = tm[1].trim();
      continue;
    }
    if (/\.(png|jpe?g|webp|gif|mp3|wav|m4a|flac|mp4|mov|webm)$/i.test(t)) {
      paths.push(t);
      continue;
    }
    rest.push(t);
  }
  return { paths, taskId, text: rest.length ? rest.join("\n") : null };
}

const MINIMAX_KINDS: Record<
  string,
  { icon: ReactNode; title: string; media: "image" | "audio" | "video" | "text" }
> = {
  image: { icon: <ImageIcon className="size-4" />, title: "图片生成", media: "image" },
  speech: { icon: <Mic className="size-4" />, title: "语音合成", media: "audio" },
  music: { icon: <Music className="size-4" />, title: "音乐生成", media: "audio" },
  lyrics: { icon: <FileText className="size-4" />, title: "歌词生成", media: "text" },
  video: { icon: <Video className="size-4" />, title: "视频生成", media: "video" },
};

/** mmx / oc-minimax 子命令(image/speech/music/lyrics/video)。 */
function minimaxSubcommand(command: string): string {
  const m = /(?:oc-minimax|mmx)\s+([a-z]+)/i.exec(command);
  const sub = m ? m[1].toLowerCase() : "";
  return sub === "lyric" ? "lyrics" : sub;
}

function MinimaxCliCard({ command, tool }: { command: string; tool: ToolLike }): ReactNode | null {
  const spec = MINIMAX_KINDS[minimaxSubcommand(command)];
  if (!spec) return null;
  const prompt = parseCommandFlag(command, "prompt", "p", "text", "lyrics") || firstQuotedArg(command);
  const { paths, taskId, text } = parseMinimaxOutput(outputText(tool));
  if (spec.media === "text") {
    if (!text && !prompt) return null;
    return (
      <CardShell icon={spec.icon} title={spec.title}>
        {prompt && (
          <div className="mb-1.5">
            <PromptChip text={prompt} />
          </div>
        )}
        {text && <ResultText text={text} />}
      </CardShell>
    );
  }
  // text 已在上面早返回,余下必为可预览媒体(narrowing 在 .map 闭包内会丢失,显式收窄)。
  const media = spec.media as "image" | "audio" | "video";
  return (
    <CardShell icon={spec.icon} title={spec.title}>
      {prompt && (
        <div className="mb-1">
          <PromptChip text={prompt} />
        </div>
      )}
      {paths.map((p) => (
        <MediaPreview key={p} path={p} kind={media} />
      ))}
      {paths.length === 0 && taskId && (
        <div className="mt-1 text-xs text-faint">生成任务已提交(任务号 {taskId}),完成后可在文件区查看。</div>
      )}
      {paths.length === 0 && !taskId && <div className="mt-1 text-xs text-success">已完成</div>}
    </CardShell>
  );
}

// ── oc-browser(浏览器操作)──────────────────────────────────────────────────────

const BROWSER_ACTIONS: Record<string, { icon: ReactNode; title: string }> = {
  open: { icon: <Globe className="size-4" />, title: "打开网页" },
  goto: { icon: <Globe className="size-4" />, title: "打开网页" },
  snapshot: { icon: <AppWindow className="size-4" />, title: "页面快照" },
  find: { icon: <Search className="size-4" />, title: "查找页面" },
  click: { icon: <MousePointer2 className="size-4" />, title: "点击" },
  dblclick: { icon: <MousePointer2 className="size-4" />, title: "双击" },
  fill: { icon: <Keyboard className="size-4" />, title: "输入文本" },
  type: { icon: <Keyboard className="size-4" />, title: "输入文本" },
  press: { icon: <Keyboard className="size-4" />, title: "按键" },
  screenshot: { icon: <Camera className="size-4" />, title: "截图" },
  "go-back": { icon: <Globe className="size-4" />, title: "返回上一页" },
  reload: { icon: <Globe className="size-4" />, title: "刷新网页" },
  close: { icon: <XCircle className="size-4" />, title: "关闭浏览器" },
};

/** 命令里全部 oc-browser <verb>(复合命令 `open … && oc-browser snapshot` 按出现顺序全识别;
 *  只收已登记动作,一个都不认 → 空数组,调用方回落)。 */
function browserSubcommands(command: string): string[] {
  const verbs: string[] = [];
  for (const m of command.matchAll(/oc-browser\s+([a-z-]+)/gi)) {
    const verb = (m[1] ?? "").toLowerCase();
    if (BROWSER_ACTIONS[verb]) verbs.push(verb);
  }
  return verbs;
}

function browserArgs(command: string, verb: string): string[] {
  const match = new RegExp(`oc-browser\\s+${verb.replace("-", "\\-")}\\b([^\\n;&|]*)`, "i").exec(command);
  if (!match) return [];
  return [...(match[1] ?? "").matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (token) => token[1] ?? token[2] ?? token[3] ?? "",
  );
}

/** 从文本里找容器绝对图片路径(截图落盘路径),用于截图预览。 */
function findImagePath(text: string | null): string | null {
  if (!text) return null;
  const m = /\/[^\s"'<>]+\.(?:png|jpe?g|webp)/i.exec(text);
  return m ? m[0] : null;
}

/** Playwright CLI 成功输出里的页面标题(`- Page Title: …` 行);无 → ""。 */
function pageTitleOf(text: string | null): string {
  if (!text) return "";
  const m = /^\s*-?\s*Page Title:\s*(.+)$/im.exec(text);
  return m ? m[1].trim() : "";
}

/** 失败输出的首个 Error 行(剥掉 "### Error" 这类 markdown 标头);全无 → 首个非空非标头行。 */
function firstErrorLine(text: string | null): string {
  if (!text) return "";
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const hit = lines.find((l) => l && !/^#{1,6}\s/.test(l) && /\berror\b/i.test(l));
  return hit ?? lines.find((l) => l && !/^#{1,6}\s/.test(l)) ?? "";
}

/** oc-browser <verb…> → 动作序列 + URL/元素/文本 + 结果状态;截图产物缩略图;失败给出首个
 *  Error 行(danger)+ 完整输出折叠。成功的 open/goto 从输出提取 Page Title。 */
function BrowserCliCard({ command, tool }: { command: string; tool: ToolLike }): ReactNode | null {
  const subs = browserSubcommands(command);
  if (subs.length === 0) return null;
  const out = outputText(tool);
  const error = !!tool.error || /^(?:#{1,6}\s*)?Error\b/im.test(out ?? "");
  const reason = error ? firstErrorLine(out) : "";
  const navigationVerb = subs.find((sub) => sub === "open" || sub === "goto" || sub === "tab-new");
  const url = navigationVerb ? (browserArgs(command, navigationVerb)[0] ?? "") : "";
  const elementVerb = subs.find((sub) => sub === "click" || sub === "dblclick" || sub === "fill");
  const elementRef = elementVerb ? (browserArgs(command, elementVerb)[0] ?? "") : "";
  const fillArgs = subs.includes("fill") ? browserArgs(command, "fill") : [];
  const typeArgs = subs.includes("type") ? browserArgs(command, "type") : [];
  const text = fillArgs[1] ?? typeArgs[0] ?? "";
  const key = subs.includes("press") ? (browserArgs(command, "press")[0] ?? "") : "";
  const shot =
    !error && subs.includes("screenshot")
      ? safeArtifactSrc(parseCommandFlag(command, "filename")) || findImagePath(out)
      : null;
  const pageTitle = !error && navigationVerb ? pageTitleOf(out) : "";
  const domain = url ? domainOf(url) : undefined;
  return (
    <CardShell
      icon={BROWSER_ACTIONS[subs[0]].icon}
      title={subs.map((s) => BROWSER_ACTIONS[s].title).join(" · ")}
    >
      {reason && <div className="mt-1 break-words text-xs text-danger">{reason.slice(0, 200)}</div>}
      {pageTitle && <div className="mt-1.5 text-[13px] leading-snug text-fg">{pageTitle}</div>}
      {url && (
        <div className="mt-1.5">
          <Chip href={url}>{domain ?? url}</Chip>
        </div>
      )}
      {elementRef && <div className="mt-1.5 text-[13px] leading-snug text-fg">元素 {elementRef}</div>}
      {text && <div className="mt-1 text-[13px] leading-snug text-fg">输入:{text}</div>}
      {key && <div className="mt-1 text-[13px] leading-snug text-fg">按键:{key}</div>}
      {shot && (
        <div className="mt-2">
          <SignedImg src={shot} alt="页面截图" className="max-h-56 rounded-md border border-border" />
        </div>
      )}
      {error ? (
        <OutputDetails text={out} label="错误详情" />
      ) : (
        subs.includes("snapshot") && <OutputDetails text={out} label="查看页面快照" />
      )}
    </CardShell>
  );
}

// ── 注册表 + 分派入口(单一权威:键 = OcCli,与 meta.OC_TOOLS 对齐)──────────────

/** 解析对象型输出,交给对象卡片函数(解析失败/卡片判空 → null,由 researchToolCard 兜底为
 *  GenericOcCard 而非回落裸终端)。渐进披露:输出截断时仍恢复已加载的完整条目。 */
function obj(
  tool: ToolLike,
  card: (p: { data: Record<string, unknown>; partial: boolean }) => ReactNode | null,
): ReactNode | null {
  const parsed = parseToolData(outputText(tool));
  return parsed ? card({ data: parsed.data, partial: parsed.partial }) : null;
}

/**
 * oc-* CLI → body 专属卡的分派表。**键受 OcCli 约束**(= meta.OC_TOOLS 的键):不可能给
 * 未登记的 CLI 注册卡片,从类型层面消除"header 加了 body 忘了"的双注册表漂移。未登记 body
 * 的 oc-*(如 oc-web-context)或本卡返回 null → researchToolCard 兜底 GenericOcCard,绝不泄漏命令。
 */
const OC_BODY_CARDS: Partial<Record<OcCli, (command: string, tool: ToolLike) => ReactNode | null>> = {
  // 研究工具(对象型 JSON 输出)。
  "oc-lit": (_c, t) => obj(t, LiteratureCard),
  "oc-cite": (_c, t) => obj(t, CitationCard),
  "oc-ingest": (_c, t) => obj(t, IngestCard),
  "oc-litrag": (_c, t) => obj(t, LitragCard),
  "oc-report": (_c, t) => obj(t, ArtifactCard),
  "oc-slides": (_c, t) => obj(t, ArtifactCard),
  "oc-poster": (_c, t) => obj(t, ArtifactCard),
  "oc-rank": (_c, t) => obj(t, RankCard),
  // 办公文档 CLI(输出是 pandoc/Quarto/Typst 日志而非 JSON,从命令行解析输出路径)。
  "oc-docx": (c) => <DocxArtifactCard command={c} />,
  "oc-pdf": (c) =>
    OfficeArtifactCard({
      command: c,
      ext: "pdf",
      title: "PDF 文档已生成",
      icon: <FileText className="size-4" />,
      note: "可在文件区下载;已按 Quarto/Typst 模板高质量排版。",
    }),
  "oc-xlsx": (c) =>
    OfficeArtifactCard({
      command: c,
      ext: "xlsx",
      title: "Excel 表格已生成",
      icon: <FileSpreadsheet className="size-4" />,
      note: "可在文件区下载;数据/图表已按模板写入工作簿。",
    }),
  // 网页/文档提取(输出是抽取的 markdown 正文,非 JSON)。
  "oc-web": (_c, t) => OcWebExtractCard({ tool: t }),
  // 技能市场。
  "oc-market": (c, t) => MarketToolCard({ command: c, tool: t }),
  // 本批新增的 4 个专属卡。
  "oc-vision": (c, t) => VisionCliCard({ command: c, tool: t }),
  "oc-memory": (c, t) => MemoryCliCard({ command: c, tool: t }),
  "oc-minimax": (c, t) => MinimaxCliCard({ command: c, tool: t }),
  mmx: (c, t) => MinimaxCliCard({ command: c, tool: t }),
  "oc-browser": (c, t) => BrowserCliCard({ command: c, tool: t }),
  // 应用连接器:输出含 confirmation_required 触发对象 → 写操作确认卡(human-in-the-loop);
  // 其余输出(list/读操作)→ null 兜底 GenericOcCard。实现在 connectorCards.tsx。
  "oc-connect": (_c, t) => connectorToolCard(t, { embedded: true }),
  // 市场 Plugin 使用与应用连接器相同的确认账本输出契约。
  "oc-plugin": (_c, t) => connectorToolCard(t, { embedded: true }),
};

/**
 * Bash 命令若调用 oc-* CLI → 返回**保证非 null** 的专属/通用卡(绝不回落裸终端块泄漏
 * `$ command`);非 oc-* → null(调用方回落通用 BashBody 终端块)。检测走 meta.detectOcCli(唯一权威)。
 *
 * 三条历史泄漏路径一次覆盖:①未注册 body → GenericOcCard;②有 body 但解析失败(返回 null)
 * → GenericOcCard;③出错(tool.error)→ danger 版 GenericOcCard(折叠错误详情,不裸露命令)。
 *
 * 例外:纯 heredoc 写文件(`cat > f <<EOF ... oc-web ... EOF`)里 oc-* 是被写入的文件内容而非
 * 被执行的命令 —— 返回 null 交回 BashBody 的写文件卡(与 resolveToolMeta 同一判定,避免不一致)。
 */
/** 失败时仍走专属卡的 CLI(卡内自渲染失败状态 + 原因,如 oc-browser 提取首个 Error 行);
 *  其余 CLI 的专属卡不感知 error,失败一律 GenericOcCard 兜底,避免错误输出被当正常结果解析。
 *  oc-connect/oc-plugin:即便 CLI 以非零退出码提示"需要确认",输出里的确认触发对象也必须渲染成
 *  确认卡(解析不出才落 GenericOcCard error)。 */
const ERROR_AWARE_OC_CARDS: ReadonlySet<OcCli> = new Set<OcCli>([
  "oc-browser",
  "oc-connect",
  "oc-plugin",
]);

export function researchToolCard(command: string, tool: ToolLike): ReactNode | null {
  if (!command) return null;
  const cli = detectOcCli(command);
  if (!cli) return null;
  if (detectShellFileWrites(command)) return null;
  const key = cli as OcCli;
  if (tool.error && !ERROR_AWARE_OC_CARDS.has(key)) return <GenericOcCard cli={key} tool={tool} error />;
  const body = OC_BODY_CARDS[key];
  const card = body ? body(command, tool) : null;
  return card ?? <GenericOcCard cli={key} tool={tool} error={!!tool.error} />;
}
