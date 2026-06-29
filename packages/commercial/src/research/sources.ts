/**
 * oc-lit 多源文献检索 — 各源 adapter(OpenAlex / Crossref / arXiv)。
 *
 * 设计:
 *   - 元数据走开放 API(OpenAlex/Crossref 免费,arXiv Atom);**绝不代爬付费墙**。
 *   - 每个源:fetch(注入 fetchImpl 便于测试)+ 纯 parse(JSON/XML → SourceRecord)。
 *   - 中文文献:OpenAlex 中文覆盖低且 DOI 缺失率高 → 去重靠 标题+作者+年(见 litSearch.ts),
 *     本层只负责把各源记录归一成 SourceRecord。
 *   - polite pool:OpenAlex/Crossref 带 mailto(admin 配)提升配额、降被限风险。
 *   - 失败/超时 → 抛错,由 litSearch 收敛进 warnings(单源失败不拖垮整体)。
 */

import type { SourceRecord, Author, DocLang } from "@openclaude/protocol/research";

export type FetchLike = typeof fetch;

export interface SourceSearchOpts {
  size: number;
  yearMin?: number;
  /** OpenAlex/Crossref polite pool mailto。 */
  mailto?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

const DEFAULT_TIMEOUT_MS = 12_000;

async function fetchJson(
  url: string,
  opts: { timeoutMs?: number; fetchImpl?: FetchLike; headers?: Record<string, string> },
): Promise<unknown> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json", ...(opts.headers ?? {}) },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`upstream_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(to);
  }
}

async function fetchText(
  url: string,
  opts: { timeoutMs?: number; fetchImpl?: FetchLike },
): Promise<string> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { method: "GET", signal: ctrl.signal });
    if (!res.ok) throw new Error(`upstream_${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(to);
  }
}

// 粗判语言:含 CJK 统一表意文字 → zh,否则 en。仅用于 SourceRecord.lang 标注。
const CJK_RE = /[一-鿿]/;
export function guessLang(title: string): DocLang {
  return CJK_RE.test(title) ? "zh" : "en";
}

/** 归一 DOI:小写、去 URL 前缀、去空白。 */
export function normalizeDoi(doi: string | null | undefined): string | undefined {
  if (!doi) return undefined;
  const s = doi.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  return s.length > 0 ? s : undefined;
}

/** 归一 arXiv id:去 URL/版本号(1234.5678v2 → 1234.5678)。 */
export function normalizeArxivId(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim().toLowerCase();
  s = s.replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/^arxiv:/, "");
  s = s.replace(/v\d+$/, "");
  return s.length > 0 ? s : undefined;
}

function dedupKeyHash(s: string): string {
  // 短稳定 hash(djb2),仅用于无 DOI 时的内部 id 生成(非安全用途)。
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 给 SourceRecord 生成稳定内部 id:DOI 优先;否则 标题+首作者+年 的 hash。 */
export function makeSourceId(rec: {
  doi?: string;
  arxivId?: string;
  title: string;
  authors: Author[];
  year?: number;
}): string {
  if (rec.doi) return `doi:${rec.doi}`;
  if (rec.arxivId) return `arxiv:${rec.arxivId}`;
  const a = rec.authors[0]?.name ?? "";
  const norm = normalizeTitleForKey(rec.title);
  return `t:${dedupKeyHash(`${norm}|${normalizeAuthorSurname(a)}|${rec.year ?? ""}`)}`;
}

/** 标题归一(去空白/标点/大小写;CJK 保留字符)用于模糊去重 key。 */
export function normalizeTitleForKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, "")
    // 去常见标点(ASCII + 中文),保留 CJK 与字母数字
    .replace(/[!-/:-@[-`{-~]/g, "")
    .replace(/[，。、；：「」『』（）【】《》！？·…—]/g, "");
}

/** 取作者姓(英文取末单词;中文取整名)用于模糊 key。 */
export function normalizeAuthorSurname(name: string): string {
  const n = name.trim();
  if (CJK_RE.test(n)) return n.replace(/\s+/g, ""); // CJK:整名
  const parts = n.split(/\s+/);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

// ───────────────────────────────────────────────
// OpenAlex(免费,polite via mailto)
// ───────────────────────────────────────────────

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  cited_by_count?: number | null;
  type?: string | null;
  authorships?: Array<{ author?: { id?: string; display_name?: string } }>;
  primary_location?: { source?: { display_name?: string } | null } | null;
  open_access?: { is_oa?: boolean; oa_url?: string | null } | null;
  ids?: { openalex?: string; doi?: string; arxiv?: string } | null;
  is_retracted?: boolean | null;
}

export function parseOpenAlexWork(w: OpenAlexWork): SourceRecord {
  const title = (w.title ?? w.display_name ?? "").trim();
  const doi = normalizeDoi(w.doi ?? w.ids?.doi ?? undefined);
  const arxivId = normalizeArxivId(w.ids?.arxiv ?? undefined);
  const authors: Author[] = (w.authorships ?? [])
    .map((a) => ({
      name: (a.author?.display_name ?? "").trim(),
      id: a.author?.id,
    }))
    .filter((a) => a.name.length > 0);
  const openalexId = w.id ?? w.ids?.openalex ?? undefined;
  const oaUrl = w.open_access?.oa_url ?? undefined;
  const rec: SourceRecord = {
    id: makeSourceId({ doi, arxivId, title, authors, year: w.publication_year ?? undefined }),
    title,
    authors,
    year: w.publication_year ?? undefined,
    venue: w.primary_location?.source?.display_name ?? undefined,
    doi,
    arxivId,
    openalexId,
    crossrefType: w.type ?? undefined,
    citationCount: w.cited_by_count ?? undefined,
    lang: guessLang(title),
    oa: { isOA: w.open_access?.is_oa === true, url: oaUrl ?? undefined, source: oaUrl ? "openalex" : undefined },
    retracted: w.is_retracted === true ? true : null,
  };
  return rec;
}

export async function searchOpenAlex(query: string, opts: SourceSearchOpts): Promise<SourceRecord[]> {
  const params = new URLSearchParams();
  params.set("search", query);
  params.set("per-page", String(Math.min(Math.max(opts.size, 1), 100)));
  if (opts.yearMin) params.set("filter", `publication_year:>${opts.yearMin - 1}`);
  if (opts.mailto) params.set("mailto", opts.mailto);
  const url = `https://api.openalex.org/works?${params.toString()}`;
  const json = (await fetchJson(url, opts)) as { results?: OpenAlexWork[] };
  return (json.results ?? []).map(parseOpenAlexWork).filter((r) => r.title.length > 0);
}

// ───────────────────────────────────────────────
// Crossref(免费,polite via mailto)
// ───────────────────────────────────────────────

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
  "container-title"?: string[];
  issued?: { "date-parts"?: number[][] };
  type?: string;
  "is-referenced-by-count"?: number;
  URL?: string;
  /** 撤稿:Crossref update-to 关系 type=retraction。 */
  "update-to"?: Array<{ type?: string }>;
}

export function parseCrossrefItem(it: CrossrefItem): SourceRecord {
  const title = (it.title?.[0] ?? "").trim();
  const doi = normalizeDoi(it.DOI);
  const authors: Author[] = (it.author ?? [])
    .map((a) => ({
      name: a.name?.trim() ?? `${a.given ?? ""} ${a.family ?? ""}`.trim(),
    }))
    .filter((a) => a.name.length > 0);
  const year = it.issued?.["date-parts"]?.[0]?.[0];
  const retracted = Array.isArray(it["update-to"])
    ? it["update-to"].some((u) => (u.type ?? "").toLowerCase().includes("retract"))
    : null;
  return {
    id: makeSourceId({ doi, title, authors, year }),
    title,
    authors,
    year: typeof year === "number" ? year : undefined,
    venue: it["container-title"]?.[0],
    doi,
    crossrefType: it.type,
    citationCount: it["is-referenced-by-count"],
    lang: guessLang(title),
    oa: undefined,
    retracted,
  };
}

export async function searchCrossref(query: string, opts: SourceSearchOpts): Promise<SourceRecord[]> {
  const params = new URLSearchParams();
  params.set("query", query);
  params.set("rows", String(Math.min(Math.max(opts.size, 1), 100)));
  if (opts.yearMin) params.set("filter", `from-pub-date:${opts.yearMin}-01-01`);
  if (opts.mailto) params.set("mailto", opts.mailto);
  const url = `https://api.crossref.org/works?${params.toString()}`;
  const headers = opts.mailto
    ? { "User-Agent": `OpenClaude-research/1.0 (mailto:${opts.mailto})` }
    : undefined;
  const json = (await fetchJson(url, { ...opts, headers })) as {
    message?: { items?: CrossrefItem[] };
  };
  return (json.message?.items ?? []).map(parseCrossrefItem).filter((r) => r.title.length > 0);
}

// ───────────────────────────────────────────────
// arXiv(免费 Atom XML;最小容错解析)
// ───────────────────────────────────────────────

/** 从 Atom <entry> 抽一个标签的文本(首个匹配)。 */
function xmlTag(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? decodeXml(m[1].trim()) : undefined;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseArxivAtom(xml: string): SourceRecord[] {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  const out: SourceRecord[] = [];
  for (const e of entries) {
    const title = xmlTag(e, "title");
    if (!title) continue;
    const idRaw = xmlTag(e, "id");
    const arxivId = normalizeArxivId(idRaw);
    const published = xmlTag(e, "published");
    const year = published ? Number(published.slice(0, 4)) : undefined;
    const doi = normalizeDoi(xmlTag(e, "arxiv:doi"));
    const authors: Author[] = [];
    const authorBlocks = e.match(/<author>[\s\S]*?<\/author>/g) ?? [];
    for (const ab of authorBlocks) {
      const name = xmlTag(ab, "name");
      if (name) authors.push({ name });
    }
    out.push({
      id: makeSourceId({ doi, arxivId, title, authors, year }),
      title,
      authors,
      year: Number.isFinite(year) ? year : undefined,
      venue: "arXiv",
      doi,
      arxivId,
      lang: guessLang(title),
      oa: arxivId ? { isOA: true, url: `https://arxiv.org/abs/${arxivId}`, source: "arxiv" } : undefined,
      retracted: null,
    });
  }
  return out;
}

export async function searchArxiv(query: string, opts: SourceSearchOpts): Promise<SourceRecord[]> {
  const params = new URLSearchParams();
  params.set("search_query", `all:${query}`);
  params.set("start", "0");
  params.set("max_results", String(Math.min(Math.max(opts.size, 1), 100)));
  const url = `https://export.arxiv.org/api/query?${params.toString()}`;
  const xml = await fetchText(url, opts);
  return parseArxivAtom(xml);
}
